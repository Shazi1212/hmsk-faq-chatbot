// Web worker: computes sentence embeddings with transformers.js, fully in the browser.
// Library, WebAssembly runtime and model are served from this app's own folder (vendor/, models/),
// so no request goes to a CDN or to Hugging Face. The browser caches the model after the first load.
import { pipeline, env } from './vendor/transformers.min.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
env.allowRemoteModels = false;
env.allowLocalModels = true;
// A path, not a full URL: transformers.js only checks local files for paths without http(s):.
env.localModelPath = new URL('./models/', import.meta.url).pathname;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;

let extractor = null;

async function load() {
  if (extractor) return extractor;
  extractor = await pipeline('feature-extraction', MODEL, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: p => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx')) postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
    },
  });
  return extractor;
}

self.onmessage = async ({ data }) => {
  const { id, type, texts } = data;
  try {
    if (type === 'load') { await load(); postMessage({ id, type: 'ready' }); return; }
    if (type === 'embed') {
      const ex = await load();
      const out = [];
      for (let i = 0; i < texts.length; i += 16) {         // small batches keep memory flat
        const t = await ex(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
        const dim = t.dims[1];
        for (let r = 0; r < t.dims[0]; r++) out.push(Array.from(t.data.subarray(r * dim, (r + 1) * dim)));
        postMessage({ id, type: 'tick', done: Math.min(i + 16, texts.length), total: texts.length });
      }
      postMessage({ id, type: 'result', vectors: out });
    }
  } catch (e) {
    postMessage({ id, type: 'error', message: String(e?.message || e) });
  }
};
