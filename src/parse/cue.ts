/* Cue sheet text parsing.
   Plain text: `FILE "x.flac" WAVE`, then per track `TRACK NN AUDIO`,
   `TITLE`, `PERFORMER`, `INDEX 00` (pregap), `INDEX 01` (start).
   Times are MM:SS:FF where FF is frames at 75 per second — not hundredths,
   not milliseconds. Track end is the next INDEX 01; the last track's end is
   the file duration, filled in by the caller when it attaches the sheet. */

import type { CueSheet, CueTrack } from '../types';

const FRAMES_PER_SEC = 75;

/** MM:SS:FF → seconds. Returns -1 for anything malformed. Lenient about
    out-of-range fields: real rippers write frames like `06:03:75`, meaning
    the next whole second — carry instead of rejecting, or real tracks
    silently vanish from real rips. */
export function cueTimeToSec(text: string): number {
  const m = String(text).trim().match(/^(\d+):(\d{1,2}):(\d{1,3})$/);
  if (!m) return -1;
  const mm = parseInt(m[1], 10);
  const ss = parseInt(m[2], 10);
  const ff = parseInt(m[3], 10);
  return mm * 60 + ss + ff / FRAMES_PER_SEC;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') return t.slice(1, -1);
  return t;
}

/** Parses cue text into a sheet. Returns null when no usable TRACK/INDEX 01
    entries exist. endSec of each track is the next track's INDEX 01; the
    final track's endSec is left as 0 for the caller to fill with the file
    duration. */
export function parseCueText(text: string, source: CueSheet['source']): CueSheet | null {
  const lines = String(text).split(/\r?\n/);
  const sheet: CueSheet = { file: '', tracks: [], source: source };
  let cur: CueTrack | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();

    if (cmd === 'FILE') {
      /* FILE "name" WAVE — the trailing type word is outside the quotes */
      const q = rest.match(/^"([^"]*)"/);
      if (q) sheet.file = q[1];
      else sheet.file = rest.split(/\s+/)[0] || '';
    } else if (cmd === 'TRACK') {
      const m = rest.match(/^(\d+)\s+AUDIO\b/i);
      if (m) {
        cur = { index: parseInt(m[1], 10), title: '', performer: '', startSec: -1, endSec: 0 };
        sheet.tracks.push(cur);
      } else {
        cur = null; /* data tracks are not audio */
      }
    } else if (cmd === 'TITLE') {
      if (cur) cur.title = unquote(rest);
      else sheet.title = unquote(rest);
    } else if (cmd === 'PERFORMER') {
      if (cur) cur.performer = unquote(rest);
      else sheet.performer = unquote(rest);
    } else if (cmd === 'INDEX') {
      const m = rest.match(/^(\d+)\s+(\S+)/);
      if (m && cur) {
        const idx = parseInt(m[1], 10);
        const sec = cueTimeToSec(m[2]);
        if (sec >= 0) {
          if (idx === 1) cur.startSec = sec;
          else if (idx === 0) cur.pregapSec = sec;
        }
      }
    }
    /* REM, CATALOG, ISRC, FLAGS, PREGAP, POSTGAP: ignored */
  }

  /* Only tracks with a real INDEX 01 exist; ends chain to the next start. */
  sheet.tracks = sheet.tracks.filter((t) => t.startSec >= 0);
  sheet.tracks.sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i < sheet.tracks.length - 1; i++) sheet.tracks[i].endSec = sheet.tracks[i + 1].startSec;
  if (!sheet.tracks.length) return null;
  return sheet;
}

/** A sheet built from FLAC CUESHEET block boundaries (type 5). The block
    carries no titles — tracks are named by number, and a later source can
    look better; this is still the highest-priority source per spec. */
export function sheetFromFlacCue(starts: number[], leadout: number | undefined, source: CueSheet['source']): CueSheet | null {
  const sorted = starts.slice().sort((a, b) => a - b);
  const tracks: CueTrack[] = sorted.map((s, i) => ({
    index: i + 1,
    title: '',
    performer: '',
    startSec: s,
    endSec: i + 1 < sorted.length ? sorted[i + 1] : leadout || 0,
  }));
  if (!tracks.length) return null;
  return { file: '', tracks: tracks, source: source };
}

/** Serializes a sheet back to standard cue text — what the auto-split
    editor writes into the sidecar's cues/ directory. */
export function buildCueText(audioFileName: string, tracks: Array<{ title: string; performer?: string; startSec: number }>): string {
  const lines: string[] = [];
  lines.push('REM COMMENT "written by AMC auto-split"');
  lines.push('FILE "' + audioFileName.replace(/"/g, "'") + '" WAVE');
  tracks.forEach((t, i) => {
    const n = String(i + 1).padStart(2, '0');
    lines.push('  TRACK ' + n + ' AUDIO');
    lines.push('    TITLE "' + (t.title || 'Track ' + n).replace(/"/g, "'") + '"');
    if (t.performer) lines.push('    PERFORMER "' + t.performer.replace(/"/g, "'") + '"');
    const total = Math.max(0, t.startSec);
    const mm = Math.floor(total / 60);
    const ss = Math.floor(total % 60);
    const ff = Math.min(FRAMES_PER_SEC - 1, Math.round((total - Math.floor(total)) * FRAMES_PER_SEC));
    lines.push('    INDEX 01 ' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + ':' + String(ff).padStart(2, '0'));
  });
  return lines.join('\n') + '\n';
}
