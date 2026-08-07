/* IndexedDB — every call wrapped; a cache failure must never stop playback.
   Store names and DB name match v1 so an existing cache keeps working. */

import { logErr } from '../ui/log';

const DB_NAME = 'tsss_player',
  DB_VER = 1;
export const ST_TRACKS = 'tracks',
  ST_COVERS = 'covers',
  ST_PLAYLISTS = 'playlists';

let db: IDBDatabase | null = null;
let idbOK = true;

export function idbOpen(): Promise<boolean> {
  return new Promise((res) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VER);
    } catch (e) {
      idbOK = false;
      logErr('cache', 'IndexedDB is unavailable, running from memory only', (e as Error).message);
      return res(false);
    }
    req.onupgradeneeded = () => {
      try {
        const d = req.result;
        if (!d.objectStoreNames.contains(ST_TRACKS)) d.createObjectStore(ST_TRACKS, { keyPath: 'key' });
        if (!d.objectStoreNames.contains(ST_COVERS)) d.createObjectStore(ST_COVERS, { keyPath: 'key' });
        if (!d.objectStoreNames.contains(ST_PLAYLISTS)) d.createObjectStore(ST_PLAYLISTS, { keyPath: 'id' });
      } catch (e) {
        logErr('cache', 'Could not create the database stores', (e as Error).message);
      }
    };
    req.onsuccess = () => {
      db = req.result;
      db.onerror = (ev) => {
        const t = ev.target as IDBRequest | null;
        logErr('cache', 'Database error', t && t.error && t.error.message);
      };
      res(true);
    };
    req.onerror = () => {
      idbOK = false;
      logErr('cache', 'Could not open the cache, running from memory only', req.error && req.error.message);
      res(false);
    };
    req.onblocked = () => {
      idbOK = false;
      logErr('cache', 'The cache is locked by another tab, running from memory only', '');
      res(false);
    };
  });
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
