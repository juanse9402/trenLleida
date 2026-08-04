/**
 * db.js — IndexedDB wrapper for local audio file storage.
 * Clean promise-based API, isolated from business logic.
 */

const DB_NAME    = 'RouteMakerAudioDB_v1';
const STORE_NAME = 'audios';
const DB_VERSION = 1;

let _db = null;

/**
 * Open (or reuse) the IndexedDB connection.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      // Handle unexpected DB close
      _db.onclose = () => { _db = null; };
      resolve(_db);
    };

    req.onerror = () => reject(new Error(`IndexedDB open failed: ${req.error?.message}`));
    req.onblocked = () => reject(new Error('IndexedDB blocked by another tab.'));
  });
}

/**
 * Save a Blob to IndexedDB under the given key.
 * @param {string} key
 * @param {Blob} blob
 */
export async function saveAudio(key, blob) {
  if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(blob, key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(new Error(`saveAudio failed: ${req.error?.message}`));
  });
}

/**
 * Retrieve a Blob from IndexedDB. Returns null if not found.
 * @param {string} key
 * @returns {Promise<Blob|null>}
 */
export async function getAudio(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(new Error(`getAudio failed: ${req.error?.message}`));
  });
}

/**
 * Delete a specific audio entry.
 * @param {string} key
 */
export async function deleteAudio(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(new Error(`deleteAudio failed: ${req.error?.message}`));
  });
}

/**
 * List all stored audio keys.
 * @returns {Promise<string[]>}
 */
export async function listAudioKeys() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error(`listAudioKeys failed: ${req.error?.message}`));
  });
}
