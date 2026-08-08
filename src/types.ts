/* Shared types. Everything else follows from these. */

export type Capability = 'read' | 'readwrite';

export interface MusicFolder {
  folderId: string;        // generated once, stored in that folder's .AMC/settings.json
  label: string;
  order: number;           // priority for duplicate resolution
  capability: Capability;
}

export interface Track {
  uid: string;
  folderId: string;        // which folder this came from
  path: string;            // webkitRelativePath — stable identity WITHIN a folder
  cacheKey: string;        // `${name}|${size}|${lastModified}` — invalidation only
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  edition?: string;        // derived from folder name when it differs from the album tag
  track: number;
  disc: number;
  year: number;
  genre: string;
  duration: number;
  fmt: string;
  size: number;
  added: number;
  coverKey: string;
  hasArt: boolean;
  resumeSec?: number;
  file?: File;
  /** Set when parsing or playback failed; rendered as a warning on the row. */
  error?: string;
  /** Duplicate merge (Phase 2): a shadowed copy is hidden from the library
      views but stays fully reachable; the primary row carries the refs. */
  shadowed?: boolean;
  dupRefs?: string[];
}

/** A track carved out of a longer file by a cue sheet. */
export interface VirtualTrack extends Track {
  kind: 'virtual';
  sourcePath: string;
  startSec: number;
  endSec: number;
  cueIndex: number;
}

export type FileTrack = Track & { kind: 'file' };
export type AnyTrack = FileTrack | VirtualTrack;

/** A playlist row whose path is not in any loaded folder. Rendered dimmed,
    never removed on its own, and playback skips it. */
export interface MissingTrack {
  kind: 'missing';
  missing: true;
  uid: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  coverKey: string;
  error: string;
  /** Overrides the default "Not in this folder" row note — e.g. a
      cross-folder entry whose folder is not loaded. */
  note?: string;
}

/** Anything a song table can render. Playback accepts only AnyTrack. */
export type RowTrack = AnyTrack | MissingTrack;

export interface Album {
  key: string;
  album: string;
  artist: string;
  year: number;
  edition?: string;
  tracks: AnyTrack[];
  added: number;
}

export interface Artist {
  key: string;
  name: string;
  albums: Album[];
  tracks: AnyTrack[];
}

/** One playlist row: folderId + path, never cacheKey — re-tagging a file
    changes lastModified and would empty every playlist. An empty folderId
    marks a legacy (pre-multi-folder) entry not yet resolved to a folder. */
export interface PlaylistEntry {
  folderId: string;
  path: string;
}

export interface Playlist {
  id: string;
  name: string;
  /** The folder whose .AMC/playlists/ holds this list. Empty until a legacy
      playlist has been adopted by a real folder. */
  ownerFolderId: string;
  entries: PlaylistEntry[];
  created: number;
  updated: number;
  /** Set while the sidecar copy is behind IndexedDB (the write journal). */
  dirty?: boolean;
  /** Current file name inside .AMC/playlists/, tracked so renames replace
      the old file instead of orphaning it. */
  fileName?: string;
}

export interface CueTrack {
  index: number;           // TRACK NN
  title: string;
  performer: string;
  startSec: number;        // INDEX 01, MM:SS:FF at 75 frames/sec
  endSec: number;          // next INDEX 01, or file duration for the last track
  pregapSec?: number;      // INDEX 00
}

export interface CueSheet {
  file: string;            // the FILE line's audio file name
  title?: string;
  performer?: string;
  tracks: CueTrack[];
  source: 'flac-block' | 'sibling' | 'sidecar' | 'vorbis-tag';
}

export interface LrcWord {
  timeSec: number;
  text: string;
}

export interface LrcLine {
  timeSec: number;
  text: string;
  /** Present for Enhanced LRC; enables word-level fill. */
  words?: LrcWord[];
}

/** One result row from the iTunes Search API, trimmed to what AMC uses. */
export interface CatalogEntry {
  collectionId: number;
  trackId?: number;
  artistName: string;
  collectionName: string;
  trackName?: string;
  trackNumber?: number;
  trackCount?: number;
  discNumber?: number;
  releaseDate?: string;
  primaryGenreName?: string;
  artworkUrl100?: string;
}

/** An accepted metadata correction. Merged over parsed tags at display time;
    audio files are never modified. */
export interface Override {
  path: string;
  fields: Partial<
    Pick<Track, 'title' | 'artist' | 'albumArtist' | 'album' | 'track' | 'disc' | 'year' | 'genre' | 'edition'>
  >;
  source: 'catalog' | 'ai' | 'manual';
  appliedAt: number;
}

/** Downsampled waveform, ~1500 min/max pairs, stored in .AMC/peaks/. */
export interface PeakData {
  version: 1;
  duration: number;
  /** Interleaved [min, max, min, max, …], each in -1..1. */
  pairs: number[];
}

/** One interface over the two folder-access backends. Paths given to and
    returned from a backend are library paths: `<root name>/<relative>`. */
export interface FsBackend {
  kind: 'fsa' | 'webkitdir';
  capability: Capability;
  label: string;
  /** Every audio file under the root, sorted by path. */
  listAudioFiles(): Promise<{ path: string; file: File }[]>;
  /** Text of a file inside .AMC/, or null when absent or unreadable. */
  readSidecarText(relPath: string): Promise<string | null>;
  /** Names of files inside a .AMC/ subdirectory ('' for .AMC itself). */
  listSidecarDir(relPath: string): Promise<string[]>;
  /** Writes inside .AMC/ only; must throw on failure — a failed write is
      never treated as success. Read-only backends always throw. */
  writeSidecarText(relPath: string, text: string): Promise<void>;
  /** Removes a file inside .AMC/; missing files are not an error. */
  removeSidecarFile(relPath: string): Promise<void>;
  /** Creates .AMC/ and its subdirectories. No-op on read-only backends. */
  ensureSidecarLayout(): Promise<void>;
}

/** A music folder the app is (or was) connected to. */
export interface ConnectedFolder {
  folderId: string;
  label: string;
  order: number;
  capability: Capability;
  backend: FsBackend;
}

/* ---------- storage shapes (Phase 2) ---------- */

/** Persisted folder registration. FSA rows carry the directory handle
    (structured-cloneable); webkitdir rows carry metadata only, because that
    backend is session-scoped by design. */
export interface FolderRec {
  folderId: string;
  label: string;
  order: number;
  kind: 'fsa' | 'webkitdir';
  handle?: FileSystemDirectoryHandle;
  addedAt: number;
}

/** .AMC/settings.json. schemaVersion exists from the very first write so
    Phase 5's migration machinery has something to migrate from. */
export interface SidecarSettings {
  schemaVersion: number;
  folderId: string;
  label: string;
  createdAt: number;
  /** Convenience copy of the global app preferences, mirrored into the
      first folder's sidecar only. IndexedDB stays canonical. */
  appPrefs?: Prefs;
}

export interface SidecarLibrary {
  schemaVersion: number;
  folderId: string;
  generatedAt: number;
  tracks: Array<{
    path: string; // folder-relative, no root segment
    title: string;
    artist: string;
    albumArtist: string;
    album: string;
    track: number;
    disc: number;
    year: number;
    genre: string;
    duration: number;
    fmt: string;
    size: number;
    added: number;
    hasArt: boolean;
  }>;
}

/* ---------- storage shapes ---------- */

/** The parsed-tag row cached in IndexedDB, keyed by cacheKey. Shape matches
    what v1 wrote so an existing cache keeps working; year may be a string
    there. coverKey is stored but always recomputed on load. */
export interface TrackRec {
  key: string;
  path: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  track: number;
  disc: number;
  year: number | string;
  genre: string;
  duration: number;
  fmt: string;
  size: number;
  added: number;
  hasArt: boolean;
  coverKey: string;
}

/** IDB playlist row. Legacy rows (v1 / Phase 1) have `paths`; current rows
    have `ownerFolderId` + `entries`. loadPlaylists upgrades in place. */
export interface PlaylistRec {
  id: string;
  name: string;
  paths?: string[];
  ownerFolderId?: string;
  entries?: PlaylistEntry[];
  created: number;
  updated: number;
  dirty?: number;
  fileName?: string;
}

/** IDB meta row (key 'app'): global prefs + the stored-data schema version.
    schemaVersion 2 = real folderIds everywhere; nothing ever persists the
    Phase 1 'local' placeholder. */
export interface MetaRec {
  key: 'app';
  schemaVersion: number;
  prefs?: Prefs;
}

export interface CoverRec {
  key: string;
  thumb: Blob;
}

export interface Prefs {
  volume?: number;
  muted?: boolean;
  shuffle?: boolean;
  repeat?: string;
  view?: string;
  /** Legacy (Phase 1): bare path. Still honoured on restore. */
  lastPath?: string;
  /** Folder-qualified successor of lastPath. */
  lastRef?: { folderId: string; path: string };
  lastPos?: number;
  sort?: { col: string; dir: number };
}

/* ---------- parser output ---------- */

export interface ParsedTags {
  [key: string]: string | undefined;
}

/** A FLAC PICTURE block: an offset into the file, read only when that album
    still needs art. */
export interface FlacPicRef {
  off: number;
  len: number;
  type: number;
}

export interface ParsedMeta {
  tags: ParsedTags;
  duration: number;
  fmt: string;
  /** FLAC: PICTURE block locations, bytes not yet read. */
  pics?: FlacPicRef[];
  /** MP4/ID3: embedded picture, bytes already in hand. */
  pic?: { blob: Blob } | null;
  sampleRate?: number;
  channels?: number;
  bits?: number;
  foundMoov?: boolean;
}

export type SortCol = 'title' | 'artist' | 'album' | 'duration';
export type RepeatMode = 'off' | 'all' | 'one';
