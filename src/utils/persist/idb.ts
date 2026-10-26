const DB_NAME = 'music-stats';
export const FILE_STORE = 'files';
export const META_STORE = 'meta';
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) { db?.close(); return; }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), 3000);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        for (const name of [FILE_STORE, META_STORE]) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); dbPromise = null; };
        finish(request.result);
      };
      request.onerror = request.onblocked = () => finish(null);
    } catch { finish(null); }
  });
}

async function transaction<T>(name: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  if (!db) {
    if (mode === 'readwrite') throw new Error('Persistent storage unavailable');
    return undefined;
  }
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(name, mode);
      const request = work(tx.objectStore(name));
      const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error('Storage transaction timed out')); }, 10000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(request?.result); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error('Storage transaction failed')); };
    } catch (error) { reject(error); }
  });
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return transaction<T>(store, 'readonly', s => s.get(key)).catch(() => undefined);
}
export async function idbSet(store: string, key: IDBValidKey, value: unknown): Promise<void> {
  await transaction(store, 'readwrite', s => s.put(value, key));
}
export async function idbKeys(store: string): Promise<IDBValidKey[]> {
  return (await transaction<IDBValidKey[]>(store, 'readonly', s => s.getAllKeys()).catch(() => undefined)) ?? [];
}
export async function idbSetMany(store: string, entries: Array<[IDBValidKey, unknown]>): Promise<void> {
  if (!entries.length) return;
  await transaction(store, 'readwrite', s => { for (const [key, value] of entries) s.put(value, key); });
}
/** Read and conditionally replace related records in one serialized transaction. */
export async function idbUpdateMany(store: string, keys: IDBValidKey[], update: (values: unknown[]) => Array<[IDBValidKey, unknown]>): Promise<void> {
  if (!keys.length) return;
  await transaction(store, 'readwrite', s => {
    const values: unknown[] = new Array(keys.length);
    let remaining = keys.length;
    keys.forEach((key, index) => {
      const request = s.get(key);
      request.onsuccess = () => {
        values[index] = request.result;
        if (--remaining) return;
        try { for (const [key, value] of update(values)) s.put(value, key); }
        catch { s.transaction.abort(); }
      };
    });
  });
}
export async function idbDeleteMany(store: string, keys: IDBValidKey[]): Promise<void> {
  if (!keys.length) return;
  await transaction(store, 'readwrite', s => { for (const key of keys) s.delete(key); });
}
