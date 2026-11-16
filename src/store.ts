/**
 * Keeps the added calendar on this device (IndexedDB, which can hold big
 * files) so it's still here next time. Every call fails softly: in a private
 * window or with storage blocked, the app still works, it just forgets.
 */

export interface SavedCalendar {
  files: { name: string; text: string }[];
  savedAt: number;
}

const DB = "squeezed-day";
const STORE = "calendar";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadSaved(): Promise<SavedCalendar | null> {
  try {
    const v = await run<SavedCalendar | undefined>("readonly", (s) => s.get(KEY));
    return v && Array.isArray(v.files) ? v : null;
  } catch {
    return null;
  }
}

/** Returns false if the browser wouldn't keep it. */
export async function save(cal: SavedCalendar): Promise<boolean> {
  try {
    await run("readwrite", (s) => s.put(cal, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function removeSaved(): Promise<boolean> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
    return true;
  } catch {
    return false;
  }
}

const SETTINGS = "squeezed-day:threshold";

export function loadThreshold(): string | null {
  try {
    return localStorage.getItem(SETTINGS);
  } catch {
    return null;
  }
}

export function saveThreshold(v: string): void {
  try {
    localStorage.setItem(SETTINGS, v);
  } catch {
    /* fine: it just won't be remembered */
  }
}
