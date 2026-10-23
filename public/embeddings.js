// Local embedding cache: vectors live in IndexedDB on this device, keyed by row id + text hash,
// so only new or edited rows are ever re-embedded.
const DB = 'quinn_vectors';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('v');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };

export async function loadCache() {
  try {
    const db = await open();
    const store = db.transaction('v').objectStore('v');
    const [keys, vals] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
    return new Map(keys.map((k, i) => [k, vals[i]]));
  } catch { return new Map(); }
}

export async function saveCache(entries, pruneIds) {
  try {
    const db = await open();
    const tx = db.transaction('v', 'readwrite');
    const s = tx.objectStore('v');
    for (const [id, val] of entries) s.put(val, id);
    for (const id of pruneIds) s.delete(id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch { /* cache is best-effort */ }
}

export async function clearCache() {
  try { const db = await open(); await req(db.transaction('v', 'readwrite').objectStore('v').clear()); } catch {}
}

export class Embedder {
  constructor() { this.worker = null; this.pending = new Map(); this.seq = 0; this.onProgress = () => {}; this.ready = null; }

  start() {
    if (this.ready) return this.ready;
    this.worker = new Worker('/embed-worker.js', { type: 'module' });
    this.ready = new Promise((res, rej) => {
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'progress') return this.onProgress(data.pct);
        if (data.type === 'ready') return res();
        const p = this.pending.get(data.id);
        if (!p) { if (data.type === 'error') rej(new Error(data.message)); return; }
        this.pending.delete(data.id);
        data.type === 'error' ? p.rej(new Error(data.message)) : p.res(data.vectors);
      };
      this.worker.onerror = (e) => rej(new Error(e.message || 'worker failed'));
      this.worker.postMessage({ type: 'init' });
    });
    return this.ready;
  }

  async embed(texts) {
    await this.start();
    const id = ++this.seq;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.worker.postMessage({ type: 'embed', id, texts }); });
  }
}
