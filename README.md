# FAQ Chatbot

Small businesses answer the same questions every day; this turns your own FAQ, price list or PDFs into a chatbot that answers from them, cites the exact passage, and runs in your browser with your own AI key.

**Use it online:** [hmsk.life/tools/faq-chatbot](https://hmsk.life/tools/faq-chatbot/) (documents stay in your browser; questions go straight to the AI provider you pick, never to hmsk.life).

![FAQ Chatbot](https://hmsk.life/assets/images/tools/faq-chatbot.png)

## What it does

- Reads PDF (pdf.js), TXT, Markdown, CSV, HTML or pasted text. Chunks it by headings and paragraphs, keeps each question with its answer, splits long text at sentence ends with overlap. PDF passages keep their page number.
- Stores documents and passages in IndexedDB in the browser. Nothing is uploaded.
- Retrieval: BM25 keyword search (English and German stopwords, light plural folding), plus optional "smart search": `all-MiniLM-L6-v2` embeddings computed in a Web Worker with transformers.js. Both rankings are merged with reciprocal rank fusion. Library, WebAssembly runtime and model are served from this folder (`vendor/`, `models/`), so no CDN or Hugging Face request.
- Answers stream from Anthropic (default `claude-haiku-5-5`, or `claude-sonnet-5-5`) or any OpenAI-compatible endpoint (OpenAI, OpenRouter, LM Studio, Ollama). The prompt numbers the passages, the model cites them as `[1]`, and each citation opens the passage, file and page.
- Without a key it still shows the best matching passages.
- The key lives in `sessionStorage` (gone when the tab closes) unless you tick "remember", then `localStorage`.
- **Export:** a zip with `faq-widget.js` (one file, ~15 KB, shadow DOM), `faq-index.json`, `demo.html`, a README and two proxies:
  - search mode: two static files, no server, no AI, no key
  - AI mode: `proxy/proxy.php` or `proxy/cloudflare-worker.js` keeps the key server side, searches the index itself (visitors cannot inject their own "sources"), checks the origin, limits question and answer length and rate.
- English and German UI.

## Quick start

No build step. Serve `public/` with any static web server (ES modules and workers do not load from `file://`):

```sh
python3 -m http.server 8080 --directory public
# open http://localhost:8080/
```

Tests (Node.js 20+; the PHP proxy test runs if `php` is installed):

```sh
node --test tests/*.test.js
```

The 32 tests cover chunking (Q&A pairs, headings, long text, PDF pages), BM25 on English and German questions, cosine/RRF/hybrid retrieval, prompt building, the SSE reader, the zip writer (checked with `unzip -t`), the widget in a fake DOM, the Cloudflare Worker against a mocked provider, and the PHP proxy end to end against a mock server (including JS/PHP tokenizer parity).

## Local models

- **LM Studio:** start the server, turn on "Enable CORS", pick "LM Studio" in the app (default `http://localhost:1234/v1`), press "Load models".
- **Ollama:** start with `OLLAMA_ORIGINS=https://hmsk.life ollama serve` (or your own origin), pick "Ollama" (`http://localhost:11434/v1`).

## Files

| File | What |
|---|---|
| `public/core/chunk.js` | text normalisation and chunking (pure) |
| `public/core/search.js` | tokenizer, BM25, cosine, RRF (pure; inlined into the widget and the worker on export) |
| `public/core/llm.js` | prompt, providers, streaming |
| `public/core/extract.js` | PDF / text / HTML extraction |
| `public/core/store.js` | IndexedDB |
| `public/core/export.js`, `zip.js` | the export bundle |
| `public/embed-worker.js` | embeddings in a Web Worker |
| `public/widget/` | widget, Cloudflare Worker and PHP proxy sources (`proxy.php.txt` so a PHP host never executes it here) |
| `public/vendor/`, `public/models/` | third-party runtime files, see `vendor/VERSIONS.md` |

## Limits

- The embedding model is English-first; German works through the keyword side of the search.
- Scanned PDFs without a text layer need OCR first. No DOCX yet.
- The exported widget searches by keywords only (no embeddings in the browser of your visitors).

License: MIT.
