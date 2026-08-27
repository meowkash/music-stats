/**
 * Minimal promise wrapper over IndexedDB — no dependency, no schema migrations
 * beyond creating the two stores.
 *
 * IndexedDB rather than localStorage because the payload is ~1.4 MB of JSON:
 * localStorage is synchronous (a main-thread parse on every boot), string-only,
 * and capped around 5 MB. IDB stores structured clones, so reads come back as
 * objects with no JSON.parse cost at all.
 */

const DB_NAME = 'music-stats';
const DB_VERSION = 1;

/** Content-addressed data files: key is the manifest hash, value is parsed JSON. */
export const FILE_STORE = 'files';
/** Pointers and manifests: 'active', 'staging'. */
export const META_STORE = 'meta';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // Private browsing and storage-disabled contexts land here. Every caller
    // treats a null db as "no persistence", falling back to network.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest | null,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) {
          resolve(undefined);
          return;
        }

        let request: IDBRequest | null;
        try {
          const tx = db.transaction(storeName, mode);
          request = work(tx.objectStore(storeName));
          tx.onabort = () => resolve(undefined);
          tx.onerror = () => resolve(undefined);
          if (!request) {
            tx.oncomplete = () => resolve(undefined);
            return;
          }
        } catch {
          resolve(undefined);
          return;
        }

        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => resolve(undefined);
      }),
  );
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return runTransaction<T>(store, 'readonly', (s) => s.get(key));
}

export function idbSet(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  return runTransaction(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined);
}

export function idbKeys(store: string): Promise<IDBValidKey[]> {
  return runTransaction<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then(
    (keys) => keys ?? [],
  );
}

/** One transaction for the whole batch — a put per file would be far slower. */
export function idbSetMany(
  store: string,
  entries: Array<[IDBValidKey, unknown]>,
): Promise<void> {
  if (entries.length === 0) return Promise.resolve();

  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) {
          resolve();
          return;
        }
        try {
          const tx = db.transaction(store, 'readwrite');
          const objectStore = tx.objectStore(store);
          for (const [key, value] of entries) objectStore.put(value, key);
          tx.oncomplete = () => resolve();
          tx.onabort = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}

export function idbDeleteMany(store: string, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();

  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) {
          resolve();
          return;
        }
        try {
          const tx = db.transaction(store, 'readwrite');
          const objectStore = tx.objectStore(store);
          for (const key of keys) objectStore.delete(key);
          tx.oncomplete = () => resolve();
          tx.onabort = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}
