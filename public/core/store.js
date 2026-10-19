// IndexedDB storage for documents and chunks (with their embeddings). Everything stays on this device.

const DB = 'hmsk-faq-chatbot';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}
const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async addDoc(doc, chunks) {
    return tx(['docs', 'chunks'], 'readwrite', t => {
      t.objectStore('docs').put(doc);
      const cs = t.objectStore('chunks');
      for (const c of chunks) cs.put(c);
    });
  },
  async docs() {
    return tx(['docs'], 'readonly', t => req2p(t.objectStore('docs').getAll()));
  },
  async chunks() {
    return tx(['chunks'], 'readonly', t => req2p(t.objectStore('chunks').getAll()));
  },
  async putChunks(chunks) {
    return tx(['chunks'], 'readwrite', t => { const s = t.objectStore('chunks'); for (const c of chunks) s.put(c); });
  },
  async deleteDoc(id) {
    return tx(['docs', 'chunks'], 'readwrite', async t => {
      t.objectStore('docs').delete(id);
      const idx = t.objectStore('chunks').index('docId');
      const keys = await req2p(idx.getAllKeys(id));
      for (const k of keys) t.objectStore('chunks').delete(k);
    });
  },
  async clear() {
    return tx(['docs', 'chunks'], 'readwrite', t => { t.objectStore('docs').clear(); t.objectStore('chunks').clear(); });
  },
  async get(key) { return tx(['kv'], 'readonly', t => req2p(t.objectStore('kv').get(key))); },
  async set(key, value) { return tx(['kv'], 'readwrite', t => { t.objectStore('kv').put(value, key); }); },
};
