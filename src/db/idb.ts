/* IndexedDB — every call wrapped; a cache failure must never stop playback.
   Store names and DB name match v1 so an existing cache keeps working. */

import { logErr } from '../ui/log';

/* v1 → v2 adds the 'folders' store (persisted directory handles and folder
   order) and the 'meta' store (global prefs + stored-data schemaVersion).
   The three v1 stores carry over untouched — the parse cache is keyed by
   content (name|size|lastModified), so it is folder-agnostic and stays valid.

   The open is self-healing: after opening, the store list is verified, and
   any missing store is created through a version bump. A database whose
   version ran ahead of its stores (a half-applied upgrade) repairs itself
   instead of failing every folder and meta write forever. */
const DB_NAME = 'tsss_player';
export const ST_TRACKS = 'tracks',
  ST_COVERS = 'covers',
  ST_PLAYLISTS = 'playlists',
  ST_FOLDERS = 'folders',
  ST_META = 'meta',
  ST_OVERRIDES = 'overrides';

const STORE_DEFS: Array<[string, string]> = [
  [ST_TRACKS, 'key'],
  [ST_COVERS, 'key'],
  [ST_PLAYLISTS, 'id'],
  [ST_FOLDERS, 'folderId'],
  [ST_META, 'key'],
  /* Phase 4: the overrides write journal, one row per folder. The sidecar
     overrides.json is the source of truth; this row is the browser cache
     that survives a read-only or disconnected folder. The self-healing
     open creates it on databases from before Phase 4. */
  [ST_OVERRIDES, 'folderId'],
];

let db: IDBDatabase | null = null;
let idbOK = true;

function ensureStores(d: IDBDatabase): void {
  for (const [name, keyPath] of STORE_DEFS) {
    if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: keyPath });
  }
}

function openDb(version?: number): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    let req: IDBOpenDBRequest;
    try {
      req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    } catch (e) {
      logErr('cache', 'IndexedDB is unavailable, running from memory only', (e as Error).message);
      return res(null);
    }
    req.onupgradeneeded = () => {
      try {
        ensureStores(req.result);
      } catch (e) {
        logErr('cache', 'Could not create the database stores', (e as Error).message);
      }
    };
    req.onsuccess = () => {
      res(req.result);
    };
    req.onerror = () => {
      logErr('cache', 'Could not open the cache, running from memory only', req.error && req.error.message);
      res(null);
    };
    req.onblocked = () => {
      logErr('cache', 'The cache is locked by another tab, running from memory only', '');
      res(null);
    };
  });
}

export async function idbOpen(): Promise<boolean> {
  /* No explicit version: a fresh profile creates everything at version 1;
     an existing database opens at whatever version it reached. */
  let d = await openDb();
  if (d) {
    const missing = STORE_DEFS.filter(([name]) => !d!.objectStoreNames.contains(name)).map(([name]) => name);
    if (missing.length) {
      const bumped = d.version + 1;
      d.close();
      logErr('cache', 'Repairing the database stores', 'missing: ' + missing.join(', '));
      d = await openDb(bumped);
    }
  }
  if (!d) {
    idbOK = false;
    return false;
  }
  db = d;
  db.onerror = (ev) => {
    const t = ev.target as IDBRequest | null;
    logErr('cache', 'Database error', t && t.error && t.error.message);
  };
  return true;
}

function idbRun(store: string, mode: IDBTransactionMode, fn: (o: IDBObjectStore) => IDBRequest | undefined): Promise<unknown> {
  return new Promise((res, rej) => {
    if (!db || !idbOK) return res(undefined);
    let tx: IDBTransaction, r: IDBRequest | undefined;
    try {
      tx = db.transaction(store, mode);
      r = fn(tx.objectStore(store));
    } catch (e) {
      return rej(e);
    }
    tx.onabort = () => {
      rej(tx.error || new Error('Transaction aborted'));
    };
    if (r) {
      const req = r;
      req.onsuccess = () => {
        res(req.result);
      };
      req.onerror = () => {
        rej(req.error);
      };
    } else {
      tx.oncomplete = () => {
        res(undefined);
      };
    }
  });
}

export function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return idbRun(store, 'readonly', (o) => o.get(key)).catch((e: Error | null) => {
    logErr('cache', 'Could not read from the cache', e && e.message);
    return undefined;
  }) as Promise<T | undefined>;
}
export function idbPut(store: string, val: unknown): Promise<unknown> {
  return idbRun(store, 'readwrite', (o) => o.put(val)).catch((e: Error | null) => {
    logErr('cache', 'Could not write to the cache', e && e.message);
    return undefined;
  });
}
export function idbDel(store: string, key: string): Promise<unknown> {
  return idbRun(store, 'readwrite', (o) => o.delete(key)).catch((e: Error | null) => {
    logErr('cache', 'Could not delete from the cache', e && e.message);
    return undefined;
  });
}
export function idbAll<T>(store: string): Promise<T[]> {
  return idbRun(store, 'readonly', (o) => o.getAll())
    .then((v) => (v as T[]) || [])
    .catch((e: Error | null) => {
      logErr('cache', 'Could not list the cache', e && e.message);
      return [];
    });
}
export function idbClear(store: string): Promise<unknown> {
  return idbRun(store, 'readwrite', (o) => o.clear()).catch((e: Error | null) => {
    logErr('cache', 'Could not clear the cache', e && e.message);
    return undefined;
  });
}
