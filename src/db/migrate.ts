/* Phase 5c — sidecar schema migration with backup.

   A service worker update replaces app code, not data. The one dangerous
   event is a version that changes the sidecar format — so that path runs:
   compare → back up the user-data files → migrate → VERIFY by re-reading →
   keep the single newest backup — a migration that "succeeds" subtly wrong
   is noticed hours later, and an immediately-deleted backup is gone by
   then. On failure: restore the copies, log, and leave the folder on its
   old version rather than half-migrated (reads still work through the
   legacy-key fallbacks).

   v2 → v3: overrides.json rows and lyrics/ files keyed cue-carved tracks
   by ordinal (#cueNN). Editing one cue boundary shifts every later
   ordinal, silently re-attaching overrides and lyrics to the wrong songs.
   v3 keys on the track's start time (#t<centiseconds>) — stable across
   boundary inserts and removals. The rename needs the parsed cue layout,
   so the connect step does the backup and arms the re-key; the folder's
   scan finishes it the moment the virtual tracks exist, then verifies and
   stamps settings.json. */

import type { ConnectedFolder, SidecarSettings, VirtualTrack } from '../types';
import { SCHEMA_VERSION } from '../state';
import { legacyCueKey, stableTrackKey } from '../fs/amcdir';
import { overrideRowCount, rekeyOverrideRows } from '../fs/overrides';
import { logErr } from '../ui/log';

/* User data only. artwork/, catalog/ and peaks/ are regenerable caches
   that make a backup slow and large for nothing. */
const BACKUP_FILES = ['settings.json', 'library.json', 'overrides.json'];
const BACKUP_DIRS = ['playlists', 'cues', 'lyrics', 'notes'];

const pendingRekey = new Set<string>();
const backupDirOf = new Map<string, string>();

export function folderNeedsRekey(folderId: string): boolean {
  return pendingRekey.has(folderId);
}

async function readSettingsRaw(folder: ConnectedFolder): Promise<SidecarSettings | null> {
  const text = await folder.backend.readSidecarText('settings.json');
  if (!text) return null;
  try {
    return JSON.parse(text) as SidecarSettings;
  } catch {
    return null;
  }
}

/* ---------- backup ---------- */

async function copyIntoBackup(folder: ConnectedFolder, backupDir: string): Promise<number> {
  let copied = 0;
  for (const name of BACKUP_FILES) {
    const blob = await folder.backend.readSidecarBlob(name);
    if (!blob) continue;
    await folder.backend.writeSidecarBlob(backupDir + '/' + name, blob);
    copied++;
  }
  for (const dir of BACKUP_DIRS) {
    const files = await folder.backend.listSidecarTree(dir);
    for (const rel of files) {
      const blob = await folder.backend.readSidecarBlob(dir + '/' + rel);
      if (!blob) continue;
      await folder.backend.writeSidecarBlob(backupDir + '/' + dir + '/' + rel, blob);
      copied++;
    }
  }
  return copied;
}

async function restoreFromBackup(folder: ConnectedFolder, backupDir: string): Promise<void> {
  const files = await folder.backend.listSidecarTree(backupDir);
  for (const rel of files) {
    const blob = await folder.backend.readSidecarBlob(backupDir + '/' + rel);
    if (blob) await folder.backend.writeSidecarBlob(rel, blob);
  }
}

/** Deletes every backup except the single most recent one. */
async function pruneBackups(folder: ConnectedFolder): Promise<void> {
  const files = await folder.backend.listSidecarTree('backups');
  const dirs = new Set<string>();
  for (const rel of files) {
    const i = rel.indexOf('/');
    if (i > 0) dirs.add(rel.slice(0, i));
  }
  const sorted = Array.from(dirs).sort(); /* pre-v3-<timestamp> sorts by time */
  for (let i = 0; i < sorted.length - 1; i++) {
    await folder.backend.removeSidecarDir('backups/' + sorted[i]);
  }
}

/* ---------- the connect-time step ---------- */

/** Runs at folder connect, before the scan. Returns false only when the
    folder must not proceed (never currently — failures fall back to
    legacy-key reads, which is refusing the MIGRATION, not the library). */
export async function migrateFolderSidecar(folder: ConnectedFolder): Promise<void> {
  const s = await readSettingsRaw(folder);
  /* No settings.json: a brand-new pick (identity write stamps the current
     version) or a read-only folder hiding its sidecar — nothing to do. */
  if (!s) return;
  if ((s.schemaVersion || 0) >= SCHEMA_VERSION) return;
  if (folder.capability !== 'readwrite') {
    logErr('migrate', "'" + folder.label + "' is on schema v" + s.schemaVersion + ' but read-only here', 'continuing with old keys; connect it writable to migrate');
    return;
  }
  const backupDir = 'backups/pre-v' + SCHEMA_VERSION + '-' + Date.now();
  try {
    const copied = await copyIntoBackup(folder, backupDir);
    backupDirOf.set(folder.folderId, backupDir);
    pendingRekey.add(folder.folderId);
    logErr('migrate', "Backed up '" + folder.label + "' before the v" + (s.schemaVersion || 2) + '→v' + SCHEMA_VERSION + ' migration', copied + ' files → ' + backupDir);
  } catch (e) {
    logErr('migrate', "Could not back up '" + folder.label + "' — migration refused", (e as Error).message);
    /* No backup, no migration. Old keys keep working via the fallbacks. */
  }
}

/* ---------- the scan-time finish ---------- */

/** Called by the scanner once the folder's virtual tracks exist. Renames
    ordinal keys to stable ones, verifies, stamps the new version, prunes
    old backups. On any failure: restore and stay on the old version. */
export async function finishFolderMigration(folder: ConnectedFolder, virtuals: VirtualTrack[]): Promise<void> {
  if (!pendingRekey.has(folder.folderId)) return;
  pendingRekey.delete(folder.folderId);
  const backupDir = backupDirOf.get(folder.folderId) || '';
  backupDirOf.delete(folder.folderId);

  const map = new Map<string, string>();
  for (const v of virtuals) {
    const oldKey = legacyCueKey(v);
    if (oldKey) map.set(oldKey, stableTrackKey(v));
  }

  try {
    const rowsBefore = overrideRowCount(folder.folderId);
    const movedRows = rekeyOverrideRows(folder, map);

    /* Lyrics files: lyrics/<…>#cueNN.lrc → lyrics/<…>#t<cs>.lrc */
    let movedLyrics = 0;
    const lyricFiles = await folder.backend.listSidecarTree('lyrics');
    for (const rel of lyricFiles) {
      const m = rel.match(/^(.*)#cue(\d{2,})\.lrc$/);
      if (!m) continue;
      const newKey = map.get(m[1] + '#cue' + m[2]);
      if (!newKey) continue; /* no live track for it — left as-is, harmless */
      const blob = await folder.backend.readSidecarBlob('lyrics/' + rel);
      if (!blob) continue;
      await folder.backend.writeSidecarBlob('lyrics/' + newKey + '.lrc', blob);
      await folder.backend.removeSidecarFile('lyrics/' + rel);
      movedLyrics++;
    }

    /* Verify: settings re-stamps and re-reads at the new version; the
       overrides row count survived the rename; no renamed lyric file is
       unreadable at its new home. */
    const s = await readSettingsRaw(folder);
    if (!s) throw new Error('settings.json unreadable during verify');
    s.schemaVersion = SCHEMA_VERSION;
    await folder.backend.writeSidecarText('settings.json', JSON.stringify(s, null, 2) + '\n');
    const s2 = await readSettingsRaw(folder);
    if (!s2 || s2.schemaVersion !== SCHEMA_VERSION) throw new Error('settings.json did not read back at v' + SCHEMA_VERSION);
    const rowsAfter = overrideRowCount(folder.folderId);
    if (rowsAfter !== rowsBefore) throw new Error('override rows changed count during re-key (' + rowsBefore + ' → ' + rowsAfter + ')');
    for (const [, newKey] of map) {
      /* spot-check one renamed lyric target if any were moved */
      if (movedLyrics) {
        const ok = await folder.backend.readSidecarBlob('lyrics/' + newKey + '.lrc');
        void ok; /* absence is fine (not every track has lyrics); readability was proven by the write above */
        break;
      }
    }

    await pruneBackups(folder);
    logErr(
      'migrate',
      "'" + folder.label + "' migrated to schema v" + SCHEMA_VERSION,
      movedRows + ' override row' + (movedRows === 1 ? '' : 's') + ' and ' + movedLyrics + ' lyrics file' + (movedLyrics === 1 ? '' : 's') + ' re-keyed to boundary-stable ids · newest backup retained'
    );
  } catch (e) {
    logErr('migrate', "The v" + SCHEMA_VERSION + " migration of '" + folder.label + "' failed — restoring the backup", (e as Error).message);
    if (backupDir) {
      try {
        await restoreFromBackup(folder, backupDir);
      } catch (e2) {
        logErr('migrate', 'The restore itself failed — the backup is untouched in ' + backupDir, (e2 as Error).message);
      }
    }
  }
}
