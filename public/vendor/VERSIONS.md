# Vendored files (served from this folder, no CDN)

| File | Package | Version | License |
|---|---|---|---|
| `transformers.min.js` | `@huggingface/transformers` (dist) | 4.3.1 | Apache-2.0 (`LICENSE-transformers.txt`) |
| `ort-wasm-simd-threaded.asyncify.mjs` / `.wasm` | `onnxruntime-web` (dist) | 1.31.0-dev.20260914-8d85527a0 (the version transformers 4.3.1 pins) | MIT (`LICENSE-onnxruntime.txt`) |
| `pdf.min.mjs`, `pdf.worker.min.mjs` | `pdfjs-dist` (build) | 6.4.299 | Apache-2.0 (`LICENSE-pdfjs.txt`) |
| `../models/Xenova/all-MiniLM-L6-v2/` | Hugging Face `Xenova/all-MiniLM-L6-v2` (quantized ONNX + tokenizer) | main, fetched 2026-10-19 | Apache-2.0 |

transformers.js with `device: 'wasm'` only loads the asyncify build of the ONNX runtime; the other runtime
variants are not needed. To update, run `npm pack` on the packages above and copy the same files.
