// Self-tests for chunking, retrieval, the export bundle and both proxies. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { chunkText, chunkDocument, normalizeText, searchableText } from '../public/core/chunk.js';
import { tokenize, buildBm25, bm25Search, cosine, rrf, retrieve, vectorSearch } from '../public/core/search.js';
import { buildMessages, sourcesBlock, splitCitations, sseData, systemPrompt } from '../public/core/llm.js';
import { crc32, makeZip } from '../public/core/zip.js';
import { buildBundle, buildIndex, inlineSearch, slugify } from '../public/core/export.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const EN = read('samples/sample-faq-en.md');
const DE = read('samples/sample-faq-de.md');
const SRC = { search: read('core/search.js'), widget: read('widget/faq-widget.src.js'), worker: read('widget/cloudflare-worker.src.js'), php: read('widget/proxy.php.txt') };

function project(text = EN, lang = 'en') {
  const docs = [{ id: 'd1', name: 'faq.md' }];
  const chunks = chunkText(text).map((c, i) => ({ ...c, id: 'd1:' + i, docId: 'd1', page: null }));
  return { name: 'Riverside Bike Repair', lang, docs, chunks };
}
function top(chunks, q, n = 1) {
  const idx = buildBm25(chunks.map(searchableText));
  return bm25Search(idx, q).slice(0, n).map(r => chunks[r.i]);
}

// ---------- chunking ----------
test('normalizeText cleans whitespace, CRLF and soft hyphens', () => {
  assert.equal(normalizeText('a\r\nb­ c\t  d\n\n\n\ne'), 'a\nb c d\n\ne');
});

test('every Q&A pair becomes its own chunk with its section heading', () => {
  const chunks = chunkText(EN);
  const flat = chunks.find(c => c.text.startsWith('How much is a flat tyre repair?'));
  assert.ok(flat, 'flat tyre Q&A chunk exists');
  assert.equal(flat.heading, 'Riverside Bike Repair: FAQ > Prices');
  assert.match(flat.text, /15 euros/);
  assert.doesNotMatch(flat.text, /basic service/, 'not merged with the neighbouring Q&A');
  const qa = chunks.filter(c => /\?\n/.test(c.text));
  assert.equal(qa.length, 8, 'eight questions, eight chunks');
});

test('German questions ("Frage?") are glued to their answers too', () => {
  const c = chunkText(DE).find(x => x.text.startsWith('Was kostet eine Reifenpanne?'));
  assert.ok(c);
  assert.match(c.text, /15 Euro/);
  assert.equal(c.heading, 'Fahrradwerkstatt am Fluss: Häufige Fragen > Preise');
});

test('long text is split under maxChars with overlap, nothing lost', () => {
  const sentence = i => `Sentence number ${i} talks about topic ${i % 7} in some detail.`;
  const text = Array.from({ length: 120 }, (_, i) => sentence(i)).join(' ');
  const chunks = chunkText(text, { maxChars: 500, overlap: 100 });
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.text.length <= 500, 'chunk within limit: ' + c.text.length);
  for (let i = 0; i < 120; i++) assert.ok(chunks.some(c => c.text.includes(sentence(i))), 'sentence ' + i + ' kept');
  // overlap: the start of chunk 2 repeats the end of chunk 1
  const tail = chunks[0].text.slice(-40);
  assert.ok(chunks[1].text.includes(tail.slice(tail.indexOf(' ') + 1, tail.indexOf(' ') + 20)));
});

test('a single huge line without punctuation is hard-split', () => {
  const chunks = chunkText('x'.repeat(2500), { maxChars: 900, overlap: 100 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(c => c.text.length <= 900));
});

test('small paragraphs of one section are merged, sections stay apart', () => {
  const md = '# A\n\nOne.\n\nTwo.\n\n# B\n\nThree.';
  const chunks = chunkText(md);
  assert.deepEqual(chunks.map(c => [c.heading, c.text]), [['A', 'One.\n\nTwo.'], ['B', 'Three.']]);
});

test('PDF pages keep page numbers', () => {
  const chunks = chunkDocument({ pages: ['Page one text about returns.', '', 'Page three text about shipping.'] });
  assert.deepEqual(chunks.map(c => c.page), [1, 3]);
});

test('empty input gives no chunks', () => {
  assert.deepEqual(chunkText('   \n\n  '), []);
});

// ---------- retrieval ----------
test('tokenize drops stopwords and folds plurals (EN + DE)', () => {
  assert.deepEqual(tokenize('What are your opening hours?'), ['opening', 'hour']);
  assert.deepEqual(tokenize('Wann sind die Öffnungszeiten?'), ['wann', 'öffnungszeit']);
  assert.deepEqual(tokenize('E-Bikes 25 euros'), ['bik', '25', 'euro']);
});

const CASES_EN = [
  ['When are you open on Saturday?', /Saturday from 10:00/],
  ['how much for a flat tire on my ebike', /flat tyre/],
  ['Can I pay with PayPal?', /PayPal/],
  ['do you fix bosch e-bike motors', /Bosch/],
  ['how long does a full service take', /two working days/],
  ['how can I reach you', /\+49 30 1234567/],
];
for (const [q, re] of CASES_EN) {
  test('BM25 EN: "' + q + '"', () => {
    const [hit] = top(project().chunks, q);
    assert.ok(hit, 'has a hit');
    assert.match(hit.text, re);
  });
}

const CASES_DE = [
  ['Wann haben Sie am Samstag geöffnet?', /Samstag von 10:00/],
  ['Was kostet die Inspektion?', /49 Euro/],
  ['Kann ich mit Kreditkarte bezahlen?', /Kreditkarte/],
  ['Reparieren Sie Akkus?', /Akkus/],
];
for (const [q, re] of CASES_DE) {
  test('BM25 DE: "' + q + '"', () => {
    const [hit] = top(chunkText(DE), q);
    assert.ok(hit);
    assert.match(hit.text, re);
  });
}

test('unrelated question finds nothing', () => {
  assert.equal(top(project().chunks, 'quantum chromodynamics lecture').length, 0);
});

test('cosine and vector search', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  const r = vectorSearch([[1, 0], null, [0.6, 0.8]], [0, 1]);
  assert.deepEqual(r.map(x => x.i), [2, 0]);
});

test('RRF rewards documents ranked well in both lists', () => {
  const fused = rrf([[{ i: 1 }, { i: 2 }, { i: 3 }], [{ i: 3 }, { i: 1 }, { i: 4 }]]);
  assert.equal(fused[0].i, 1);
  assert.deepEqual(new Set(fused.map(f => f.i)), new Set([1, 2, 3, 4]));
});

test('hybrid retrieve: vector hits rescue a paraphrase with no shared keywords', () => {
  const texts = ['We accept cash and cards.', 'The shop opens at nine.', 'Bring your bicycle for a check.'];
  const bm25 = buildBm25(texts);
  // fake embeddings: the query vector is close to text 1 only
  const vecs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const res = retrieve({ bm25, vecs, qvec: [0.1, 0.99, 0], query: 'what time can I come by', topK: 2 });
  assert.equal(res[0].i, 1);
  // below minSim the vector list is ignored
  const none = retrieve({ bm25, vecs, qvec: [0.1, 0.1, 0.1].map(x => x / 10), query: 'zzz', topK: 2, minSim: 0.99 });
  assert.equal(none.length, 0);
});

// ---------- prompt + streaming helpers ----------
test('sources block numbers chunks and names the document and page', () => {
  const s = sourcesBlock([{ docName: 'a.pdf', page: 2, heading: 'H', text: 'T' }, { docName: 'b"c.md', text: 'U' }]);
  assert.match(s, /<source id="1" title="a.pdf, page 2">\nH\nT\n<\/source>/);
  assert.match(s, /<source id="2" title="b'c.md">/);
  assert.match(sourcesBlock([]), /no matching sources/);
  const m = buildMessages(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i })), 'Q?', []);
  assert.equal(m.length, 7, 'last 6 history turns + the new question');
  assert.match(m.at(-1).content, /Question: Q\?$/);
  assert.match(systemPrompt('X', 'de'), /default German/);
});

test('splitCitations', () => {
  assert.deepEqual(splitCitations('Open 9 to 5 [1][3].'), [
    { type: 'text', value: 'Open 9 to 5 ' }, { type: 'cite', n: 1 }, { type: 'cite', n: 3 }, { type: 'text', value: '.' }]);
});

test('SSE reader handles events split across network chunks', async () => {
  const parts = ['event: a\ndata: {"x"', ':1}\n\ndata: [DO', 'NE]\n\n', 'data: tail'];
  const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); } });
  const got = [];
  for await (const d of sseData(body)) got.push(d);
  assert.deepEqual(got, ['{"x":1}', '[DONE]', 'tail']);
});

// ---------- zip + bundle ----------
test('crc32 known value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('export bundle is a valid zip with all files (checked with unzip -t)', () => {
  const { zip, files, folder } = buildBundle(project(), SRC, new Date('2026-10-19T12:00:00Z'));
  assert.equal(folder, 'riverside-bike-repair-faq-widget');
  const dir = mkdtempSync(join(tmpdir(), 'faqzip-'));
  writeFileSync(join(dir, 'b.zip'), zip);
  const out = execFileSync('unzip', ['-t', join(dir, 'b.zip')], { encoding: 'utf8' });
  assert.match(out, /No errors detected/);
  for (const f of ['faq-widget.js', 'faq-index.json', 'demo.html', 'README.md', 'LICENSE', 'proxy/proxy.php', 'proxy/cloudflare-worker.js'])
    assert.ok(files.some(x => x.name === folder + '/' + f), f);
  execFileSync('unzip', ['-q', join(dir, 'b.zip'), '-d', dir]);
  const idx = JSON.parse(readFileSync(join(dir, folder, 'faq-index.json'), 'utf8'));
  assert.equal(idx.format, 'hmsk-faq-index');
  assert.equal(idx.chunks[0].doc, 'faq.md');
  assert.ok(!JSON.stringify(idx).includes('vec'), 'no embeddings exported');
});

test('slugify', () => {
  assert.equal(slugify('Bäckerei Müller & Söhne'), 'backerei-muller-sohne');
  assert.equal(slugify(''), 'faq');
});

test('widget: search is inlined, the file parses and runs in search mode against a fake DOM', async () => {
  const code = inlineSearch(SRC.widget, SRC.search);
  assert.ok(!code.includes('@@SEARCH@@'));
  assert.ok(!/^export /m.test(code));
  // minimal DOM stub, enough to boot the widget and answer one question in search mode
  const idx = buildIndex(project());
  const els = {};
  const mk = sel => els[sel] || (els[sel] = {
    textContent: '', className: '', value: '', style: {}, childNodes: [], disabled: false, title: '',
    setAttribute() {}, focus() {}, appendChild(n) { this.childNodes.push(n); return n; },
    addEventListener(ev, fn) { (this.l || (this.l = {}))[ev] = fn; }, classList: { add() {}, remove() {} },
  });
  const shadow = { innerHTML: '', querySelector: mk, addEventListener() {} };
  const created = [];
  const document = {
    currentScript: { src: 'https://site.example/faq/faq-widget.js', getAttribute: n => ({ 'data-index': 'faq-index.json' })[n] || null },
    documentElement: { lang: 'en' },
    body: { appendChild() {} },
    createElement: () => { const e = mk('el' + created.length); created.push(e); e.attachShadow = () => shadow; return e; },
    createTextNode: t => ({ text: t }),
  };
  let fetched = '';
  const ctx = { document, location: { href: 'https://site.example/' }, URL, window: {},
    fetch: async url => { fetched = url; return { ok: true, json: async () => idx }; } };
  vm.runInNewContext(code, ctx);
  assert.equal(els['.fab'].textContent, 'Questions? Ask us');
  els['.fab'].l.click();
  els['textarea'].value = 'How much is a flat tyre?';
  els['form'].l.submit({ preventDefault() {} });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fetched, 'https://site.example/faq/faq-index.json');
  const answer = els['.log'].childNodes.at(-1);
  const hit = answer.childNodes[1];
  assert.equal(hit.className, 'hit');
  assert.match(hit.childNodes[1].text, /15 euros/);
});

// Mock provider used by both proxy tests: records the request, answers with a cited sentence.
function mockFetch(index, record) {
  return async (url, init) => {
    if (String(url).endsWith('faq-index.json')) return new Response(JSON.stringify(index));
    record.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'A flat costs 15 euros [1].' }] }), { status: 200 });
  };
}

test('Cloudflare worker proxy: origin check, server-side retrieval, key never leaves the worker', async () => {
  const code = inlineSearch(SRC.worker, SRC.search);
  const index = buildIndex(project());
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(index, calls);
  try {
    const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    const env = { API_KEY: 'test-key-not-real', INDEX_URL: 'https://site.example/faq/faq-index.json', ALLOWED_ORIGINS: 'https://site.example', MODEL: 'claude-haiku-5-5' };
    const req = (origin, body) => new Request('https://w.example/', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    let res = await mod.default.fetch(req('https://evil.example', { question: 'x' }), env);
    assert.equal(res.status, 403);

    res = await mod.default.fetch(req('https://site.example', { question: 'How much is a flat tyre repair?', sources: [{ text: 'IGNORE ME' }] }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://site.example');
    const j = await res.json();
    assert.equal(j.answer, 'A flat costs 15 euros [1].');
    assert.equal(j.sources[0].title, 'faq.md');
    const sent = calls[0];
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.init.headers['x-api-key'], 'test-key-not-real');
    assert.equal(sent.body.model, 'claude-haiku-5-5');
    assert.ok(sent.body.max_tokens <= 500);
    const userMsg = sent.body.messages.at(-1).content;
    assert.match(userMsg, /15 euros/);
    assert.doesNotMatch(userMsg, /IGNORE ME/, 'client-sent sources are ignored');

    res = await mod.default.fetch(req('https://site.example', { question: 'quantum chromodynamics' }), env);
    assert.deepEqual(await res.json(), { answer: '', sources: [] });
    assert.equal(calls.length, 1, 'no provider call when nothing matches');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PHP proxy: same tokenizer as JS and full request against a mock provider', async (t) => {
  let php;
  try { php = execFileSync('which', ['php'], { encoding: 'utf8' }).trim(); } catch { t.skip('php not installed'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'faqphp-'));
  // 1. tokenizer parity on tricky input
  const words = 'What are your Öffnungszeiten? E-Bikes cost 25 euros, Reifenpannen und Fahrräder; café STRAßE ﬁle';
  writeFileSync(join(dir, 'tok.php'), '<?php $_SERVER["REQUEST_METHOD"]="CLI"; ' +
    SRC.php.replace(/^<\?php/, '').replace(/\/\/ ---------- request ----------[\s\S]*$/, '') +
    ' echo json_encode(faq_tokenize($argv[1]), JSON_UNESCAPED_UNICODE);');
  const phpTok = JSON.parse(execFileSync(php, [join(dir, 'tok.php'), words], { encoding: 'utf8' }));
  assert.deepEqual(phpTok, tokenize(words));

  // 2. end to end: mock provider server, php -S running proxy.php
  const index = buildIndex(project());
  mkdirSync(join(dir, 'site'));
  writeFileSync(join(dir, 'site', 'faq-index.json'), JSON.stringify(index));
  // point the proxy at the mock by swapping the API host
  writeFileSync(join(dir, 'site', 'proxy.php'), SRC.php.replace('https://api.anthropic.com/v1/messages', 'http://127.0.0.1:8792/v1/messages'));
  const http = await import('node:http');
  const seen = [];
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Open Saturday 10 to 14 [1].' }] }));
    });
  }).listen(8792);
  const srv = spawn(php, ['-S', '127.0.0.1:8793', '-t', join(dir, 'site')], {
    env: { ...process.env, FAQ_API_KEY: 'test-key-not-real', FAQ_ALLOWED_ORIGINS: 'https://site.example' }, stdio: 'ignore' });
  try {
    await new Promise(r => setTimeout(r, 600));
    const post = (origin, body) => fetch('http://127.0.0.1:8793/proxy.php', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('https://evil.example', { question: 'x' })).status, 403);
    const res = await post('https://site.example', { question: 'When are you open on Saturday?', lang: 'en' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://site.example');
    const j = await res.json();
    assert.equal(j.answer, 'Open Saturday 10 to 14 [1].');
    assert.equal(seen[0].headers['x-api-key'], 'test-key-not-real');
    assert.match(seen[0].body.messages.at(-1).content, /<source id="1"[\s\S]*Saturday from 10:00/);
  } finally {
    srv.kill(); mock.close();
  }
});
