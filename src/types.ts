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

export interface Playlist {
  id: string;
  name: string;
  /** Membership keys on path, never on cacheKey: re-tagging a file changes
      lastModified and would empty every playlist. */
  paths: string[];
  created: number;
  updated: number;
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

/** One interface over the two folder-access backends. */
export interface FsBackend {
  kind: 'fsa' | 'webkitdir';
  capability: Capability;
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

export interface PlaylistRec {
  id: string;
  name: string;
  paths: string[];
  created: number;
  updated: number;
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
  lastPath?: string;
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
