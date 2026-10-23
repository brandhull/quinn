// Runs the sentence-embedding model off the main thread. Only model weights are downloaded;
// the text being embedded never leaves the browser.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;
let extractor = null;

async function load() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
      progress_callback: (p) => { if (p.status === 'progress') self.postMessage({ type: 'progress', pct: p.progress }); },
    });
  }
  return extractor;
}

self.onmessage = async ({ data }) => {
  try {
    const ex = await load();
    if (data.type === 'init') return self.postMessage({ type: 'ready' });
    const t = await ex(data.texts, { pooling: 'mean', normalize: true });
    const dim = t.dims[1];
    const vectors = data.texts.map((_, i) => Array.from(t.data.slice(i * dim, (i + 1) * dim)));
    self.postMessage({ type: 'embedded', id: data.id, vectors });
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err) });
  }
};
