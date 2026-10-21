// UI: documents in, chunks and embeddings in IndexedDB, hybrid retrieval, streamed answers with citations,
// widget export. Settings in localStorage; the API key in sessionStorage unless the user opts in.
import { TEXT } from './i18n.js';
import { store } from './core/store.js';
import { extractFile, ACCEPT } from './core/extract.js';
import { chunkDocument, searchableText } from './core/chunk.js';
import { buildBm25, bm25Search, vectorSearch, rrf } from './core/search.js';
import { PROVIDERS, chat, listModels, systemPrompt, buildMessages, splitCitations, ChatError } from './core/llm.js';
import { buildBundle } from './core/export.js';

// Links in the top strip. '' = same host (hosted on hmsk.life). Self-hosted copies may set 'https://hmsk.life'.
const LINK_BASE = '';
const SETTINGS = 'hmsk-faq-chatbot-settings';
const KEY = 'hmsk-faq-chatbot-key';
const TOP_K = 5;
const MIN_SIM = 0.22;    // all-MiniLM cosine: below this a passage is rarely related

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let lang = pickLang();
const t = () => TEXT[lang];
let docs = [];
let chunks = [];          // [{ id, docId, heading, text, page, vec? }]
let bm25 = null;
let history = [];         // [{ role, content }] for follow-up questions
let busy = null;          // AbortController of the running request
let sem = { state: 'off', worker: null, pending: new Map(), seq: 0 };
let settings = loadSettings();

function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'de' || q === 'en') return q;
  try { const s = localStorage.getItem(SETTINGS + '-lang'); if (s === 'de' || s === 'en') return s; } catch {}
  return (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
}

// ---------- settings + key ----------
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS) || '{}') || {}; } catch {}
  return {
    provider: PROVIDERS[s.provider] ? s.provider : 'anthropic',
    models: s.models && typeof s.models === 'object' ? s.models : {},
    bases: s.bases && typeof s.bases === 'object' ? s.bases : {},
    business: typeof s.business === 'string' ? s.business : '',
    exportLang: s.exportLang === 'de' || s.exportLang === 'en' ? s.exportLang : lang,
    remember: !!s.remember,
  };
}
function saveSettings() { try { localStorage.setItem(SETTINGS, JSON.stringify(settings)); } catch {} }
function getKey() {
  try { return (settings.remember ? localStorage.getItem(KEY) : sessionStorage.getItem(KEY)) || ''; } catch { return ''; }
}
function setKey(v) {
  try {
    if (settings.remember) { localStorage.setItem(KEY, v); sessionStorage.removeItem(KEY); }
    else { sessionStorage.setItem(KEY, v); localStorage.removeItem(KEY); }
  } catch {}
}
const cfg = () => {
  const p = settings.provider;
  return { provider: p, base: settings.bases[p] || PROVIDERS[p].base, model: settings.models[p] || PROVIDERS[p].models[0] || '', key: getKey().trim() };
};
const canChat = () => { const c = cfg(); return !!c.model && (!PROVIDERS[c.provider].needsKey || !!c.key); };

// ---------- texts ----------
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t().docTitle;
  $$('[data-t]').forEach(el => { const v = t()[el.dataset.t]; if (typeof v === 'string') el.textContent = v; });
  $$('[data-t-ph]').forEach(el => { el.placeholder = t()[el.dataset.tPh] || ''; });
  $('#pasteName').placeholder = t().pasteNamePh;
  $('#langBtn').setAttribute('aria-label', t().langSwitchLabel);
  const de = lang === 'de';
  $('#lnkHome').href = $('#lnkHome2').href = LINK_BASE + (de ? '/de/tools/faq-chatbot/' : '/tools/faq-chatbot/');
  $('#lnkImprint').href = LINK_BASE + (de ? '/impressum/' : '/imprint/');
  $('#lnkPrivacy').href = LINK_BASE + (de ? '/datenschutz/' : '/privacy/');
  $('#lnkUpdates').href = LINK_BASE + (de ? '/de/newsletter/' : '/subscribe/') + '?topic=faq-chatbot';
  renderProvider();
  renderDocs();
  renderSem();
  // The greeting is re-rendered in the new language as long as it is all the chat holds.
  const log = $('#log');
  if (!log.children.length || (log.children.length === 1 && log.firstElementChild.dataset.welcome)) { log.textContent = ''; welcome(); }
}

// ---------- documents ----------
function rebuildIndex() {
  bm25 = buildBm25(chunks.map(searchableText));
}
function status(el, msg, err) { el.textContent = msg || ''; el.classList.toggle('err', !!err); }

async function addDocument(name, extracted, size) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
  const parts = chunkDocument(extracted).map((c, i) => ({ ...c, id: id + ':' + i, docId: id }));
  if (!parts.length) throw new Error('no-text');
  const doc = { id, name, type: extracted.type, size, added: Date.now(), chunks: parts.length };
  await store.addDoc(doc, parts);
  docs.push(doc);
  chunks.push(...parts);
  rebuildIndex();
  renderDocs();
  if (sem.state === 'ready') embedMissing();
}

async function addFiles(files) {
  for (const f of files) {
    status($('#docStatus'), t().reading(f.name));
    try {
      const ex = await extractFile(f);
      await addDocument(f.name, ex, f.size);
      status($('#docStatus'), '');
    } catch (e) {
      const m = String(e.message);
      const msg = m === 'too-big' ? t().errTooBig(f.name) : m === 'no-text' ? t().errNoText(f.name) :
        m === 'unsupported' ? t().errType(f.name) : t().errRead(f.name);
      status($('#docStatus'), msg, true);
      console.warn('[faq-chatbot]', f.name, e);
    }
  }
}

function renderDocs() {
  const ul = $('#docList');
  ul.textContent = '';
  if (!docs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t().noDocs;
    ul.append(li);
  }
  for (const d of docs) {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.className = 'n'; name.textContent = d.name;
    const meta = document.createElement('span'); meta.className = 'm'; meta.textContent = t().docMeta(d.chunks, Math.max(1, Math.round(d.size / 1024)));
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'x'; rm.textContent = '×';
    rm.setAttribute('aria-label', t().remove + ' ' + d.name);
    rm.onclick = async () => {
      await store.deleteDoc(d.id);
      docs = docs.filter(x => x.id !== d.id);
      chunks = chunks.filter(c => c.docId !== d.id);
      rebuildIndex(); renderDocs(); renderSem();
    };
    li.append(name, meta, rm);
    ul.append(li);
  }
  $('#clearBtn').hidden = !docs.length;
}

// ---------- smart search (embeddings in a worker) ----------
function worker() {
  if (sem.worker) return sem.worker;
  sem.worker = new Worker(new URL('./embed-worker.js?v=2', import.meta.url), { type: 'module' });
  sem.worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { meter(data.total ? data.loaded / data.total : 0); return; }
    const p = sem.pending.get(data.id);
    if (!p) return;
    if (data.type === 'tick') { p.tick?.(data.done, data.total); return; }
    sem.pending.delete(data.id);
    if (data.type === 'error') p.reject(new Error(data.message)); else p.resolve(data);
  };
  sem.worker.onerror = e => { for (const p of sem.pending.values()) p.reject(new Error(e.message || 'worker')); sem.pending.clear(); };
  return sem.worker;
}
function call(msg, tick) {
  const id = ++sem.seq;
  return new Promise((resolve, reject) => { sem.pending.set(id, { resolve, reject, tick }); worker().postMessage({ id, ...msg }); });
}
function meter(f) {
  $('#semMeter').hidden = f == null;
  if (f != null) $('#semMeter span').style.width = Math.round(Math.min(1, f) * 100) + '%';
}
function renderSem() {
  const n = chunks.filter(c => c.vec).length;
  const msg = { off: t().semOff, loading: t().semLoading, ready: t().semOn(n) + ' ' + t().semEnglish, error: t().semErr }[sem.state];
  if (sem.state !== 'embedding') $('#semText').textContent = msg;
  $('#semBtn').hidden = sem.state !== 'off' && sem.state !== 'error';
}
async function enableSem() {
  sem.state = 'loading'; renderSem(); meter(0);
  try {
    await call({ type: 'load' });
    sem.state = 'ready';
    await store.set('semantic', true);
    meter(null); renderSem();
    await embedMissing();
  } catch (e) {
    console.warn('[faq-chatbot] smart search', e);
    sem.state = 'error'; meter(null); renderSem();
  }
}
let embedding = null;
async function embedMissing() {
  if (embedding) return embedding;
  embedding = (async () => {
    for (;;) {
      const todo = chunks.filter(c => !c.vec);
      if (!todo.length) break;
      sem.state = 'embedding';
      const res = await call({ type: 'embed', texts: todo.map(searchableText) }, (d, n) => {
        $('#semText').textContent = t().semEmbedding(d, n); meter(d / n);
      });
      todo.forEach((c, i) => { c.vec = res.vectors[i]; });
      await store.putChunks(todo.filter(c => chunks.includes(c)));
    }
    sem.state = 'ready'; meter(null); renderSem();
  })().catch(e => { console.warn('[faq-chatbot] embed', e); sem.state = 'error'; meter(null); renderSem(); })
    .finally(() => { embedding = null; });
  return embedding;
}

// ---------- retrieval ----------
async function find(question) {
  const kw = bm25Search(bm25, question).slice(0, 20);
  let vs = [];
  if (sem.state === 'ready' || sem.state === 'embedding') {
    try {
      const { vectors } = await call({ type: 'embed', texts: [question] });
      vs = vectorSearch(chunks.map(c => c.vec || null), vectors[0]).filter(r => r.score >= MIN_SIM).slice(0, 20);
    } catch (e) { console.warn('[faq-chatbot] query embed', e); }
  }
  const fused = vs.length ? rrf([kw, vs]) : kw;
  const kwRank = new Map(kw.map((r, n) => [r.i, n + 1]));
  const vsRank = new Map(vs.map((r, n) => [r.i, { n: n + 1, s: r.score }]));
  return fused.slice(0, TOP_K).map(r => {
    const c = chunks[r.i];
    const d = docs.find(x => x.id === c.docId);
    return { ...c, docName: d ? d.name : '', kw: kwRank.get(r.i) || null, sem: vsRank.get(r.i) || null };
  });
}

// ---------- chat ----------
function msg(cls) {
  const el = document.createElement('div');
  el.className = 'msg ' + cls;
  $('#log').append(el);
  el.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return el;
}
function sys(text) { const el = msg('sys'); el.textContent = text; return el; }
function welcome() { sys(t().welcome).dataset.welcome = '1'; }

function sourceLabel(s) { return s.docName + (s.page ? ', ' + t().page + ' ' + s.page : ''); }

function passageEl(s, n) {
  const box = document.createElement('div');
  box.className = 'passage';
  const h = document.createElement('p'); h.className = 'ph';
  h.textContent = (n ? '[' + n + '] ' : '') + sourceLabel(s) + (s.heading ? ' · ' + s.heading : '');
  const p = document.createElement('p'); p.textContent = s.text;
  box.append(h, p);
  return box;
}

// Final render of an answer: citation markers become buttons that reveal the passage.
function renderAnswer(el, text, srcs) {
  el.textContent = '';
  const body = document.createElement('div'); body.className = 'body';
  const reveal = document.createElement('div'); reveal.className = 'reveal';
  for (const part of splitCitations(text)) {
    if (part.type === 'text') { body.append(part.value); continue; }
    const s = srcs[part.n - 1];
    if (!s) { body.append('[' + part.n + ']'); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cite'; b.textContent = part.n; b.title = sourceLabel(s);
    b.setAttribute('aria-label', t().sources + ' ' + part.n + ': ' + sourceLabel(s));
    b.onclick = () => {
      const open = reveal.dataset.n === String(part.n);
      reveal.textContent = ''; reveal.dataset.n = open ? '' : part.n;
      if (!open) reveal.append(passageEl(s, part.n));
    };
    body.append(b);
  }
  el.append(body, reveal);
  const used = [...new Set(splitCitations(text).filter(p => p.type === 'cite' && srcs[p.n - 1]).map(p => p.n))];
  if (used.length) {
    const ul = document.createElement('ul'); ul.className = 'srcs';
    ul.setAttribute('aria-label', t().sources);
    for (const n of used.sort((a, b) => a - b)) { const li = document.createElement('li'); li.textContent = '[' + n + '] ' + sourceLabel(srcs[n - 1]); ul.append(li); }
    el.append(ul);
  }
  el.append(howFound(srcs));
}

function howFound(srcs) {
  const det = document.createElement('details'); det.className = 'how';
  const sum = document.createElement('summary'); sum.textContent = t().how;
  det.append(sum);
  srcs.forEach((s, i) => {
    const row = passageEl(s, i + 1);
    const r = document.createElement('p'); r.className = 'rank';
    r.textContent = [s.kw ? t().kw + ' #' + s.kw : '', s.sem ? t().sem + ' #' + s.sem.n + ' (' + s.sem.s.toFixed(2) + ')' : ''].filter(Boolean).join(' · ');
    row.firstChild.after(r);
    det.append(row);
  });
  return det;
}

async function ask(question) {
  if (!chunks.length) { sys(t().needDocs); return; }
  const u = msg('user'); u.textContent = question;
  const srcs = await find(question);
  const a = msg('bot');

  if (!canChat()) {                               // no key: show passages only
    if (!srcs.length) { a.textContent = t().noMatch; return; }
    const p = document.createElement('p'); p.className = 'note-in'; p.textContent = t().passagesOnly;
    a.append(p, ...srcs.slice(0, 3).map(s => passageEl(s)), howFound(srcs));
    a.scrollIntoView({ block: 'nearest' });
    return;
  }

  const c = cfg();
  const body = document.createElement('div'); body.className = 'body streaming';
  a.append(body);
  busy = new AbortController();
  setBusy(true);
  try {
    const { text, stop } = await chat(
      c, systemPrompt(settings.business, lang), buildMessages(history, question, srcs),
      d => { body.textContent += d; a.scrollIntoView({ block: 'end' }); }, busy.signal);
    if (stop === 'refusal') { a.textContent = t().refusal; return; }
    renderAnswer(a, text + (stop === 'max_tokens' || stop === 'length' ? '\n' + t().truncated : ''), srcs);
    history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
    $('#updates').hidden = false;
  } catch (e) {
    if (e.name === 'AbortError') { body.classList.remove('streaming'); return; }
    a.classList.add('err');
    const k = e instanceof ChatError ? e.kind : 'other';
    a.textContent = k === 'auth' ? t().errAuth : k === 'rate' ? t().errRate : k === 'model' ? t().errModel :
      k === 'network' ? t().errNetwork(c.provider) : k === 'server' ? t().errServer : t().errOther(e.message);
    console.warn('[faq-chatbot]', e);
  } finally {
    busy = null; setBusy(false);
  }
}
function setBusy(on) {
  const b = $('#askBtn');
  b.textContent = on ? t().stop : t().send;
  b.classList.toggle('btn--amber', !on); b.classList.toggle('btn--ghost', on);
}

// ---------- provider form ----------
function renderProvider() {
  const p = settings.provider;
  const c = cfg();
  $('#provider').value = p;
  document.body.dataset.provider = p;
  $('#base').value = settings.bases[p] || PROVIDERS[p].base;
  $('#model').value = c.model;
  const dl = $('#modelList'); dl.textContent = '';
  for (const m of PROVIDERS[p].models) { const o = document.createElement('option'); o.value = m; dl.append(o); }
  $('#modelsBtn').hidden = p === 'anthropic';
  $('#keyLbl').textContent = PROVIDERS[p].needsKey ? t().apiKey : t().apiKeyOptional;
  $('#key').value = getKey();
  $('#remember').checked = settings.remember;
  $('#provNote').textContent = p === 'lmstudio' || p === 'ollama' ? t().localNote : t().keyNote;
  $('#business').value = settings.business;
  $('#exportLang').value = settings.exportLang;
  $('#noKey').hidden = canChat();
}

async function loadModelList() {
  const c = cfg();
  const btn = $('#modelsBtn');
  btn.disabled = true;
  try {
    const ids = await listModels(c);
    const dl = $('#modelList'); dl.textContent = '';
    for (const m of ids) { const o = document.createElement('option'); o.value = m; dl.append(o); }
    if (ids.length && !ids.includes(c.model)) { settings.models[c.provider] = ids[0]; saveSettings(); $('#model').value = ids[0]; }
    $('#noKey').hidden = canChat();
    status($('#docStatus'), '');
  } catch (e) {
    const k = e instanceof ChatError ? e.kind : 'other';
    $('#provNote').textContent = k === 'network' ? t().errNetwork(c.provider) : k === 'auth' ? t().errAuth : t().errOther(e.message);
  } finally { btn.disabled = false; }
}

// ---------- export ----------
async function exportBundle() {
  const st = $('#exportStatus');
  if (!chunks.length) { status(st, t().exportNone, true); return; }
  try {
    const get = p => fetch(new URL(p, import.meta.url)).then(r => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.text(); });
    const [search, widget, worker, php] = await Promise.all([
      get('./core/search.js'), get('./widget/faq-widget.src.js'), get('./widget/cloudflare-worker.src.js'), get('./widget/proxy.php.txt')]);
    const { zip, folder } = buildBundle({ name: settings.business, lang: settings.exportLang, docs, chunks }, { search, widget, worker, php });
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = folder + '.zip';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status(st, t().exportDone(folder, chunks.length));
    $('#updates').hidden = false;
  } catch (e) {
    console.warn('[faq-chatbot] export', e);
    status(st, t().errOther(e.message), true);
  }
}

// ---------- wiring ----------
function bind() {
  $('#langBtn').onclick = () => {
    lang = lang === 'en' ? 'de' : 'en';
    try { localStorage.setItem(SETTINGS + '-lang', lang); } catch {}
    applyLang();
  };
  const file = $('#file');
  file.accept = ACCEPT;
  file.onchange = () => { addFiles([...file.files]); file.value = ''; };
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles([...e.dataTransfer.files]));

  $('#pasteBtn').onclick = async () => {
    const text = $('#paste').value.trim();
    if (!text) return;
    const name = $('#pasteName').value.trim() || (t().pasteNamePh.replace(/^(e\.g\.|z\. B\.)\s*/, '') + ' ' + (docs.length + 1));
    try { await addDocument(name, { type: 'text', text }, new Blob([text]).size); $('#paste').value = ''; $('#pasteName').value = ''; }
    catch { status($('#docStatus'), t().errNoText(name), true); }
  };
  $('#sampleBtn').onclick = async () => {
    const f = lang === 'de' ? 'sample-faq-de.md' : 'sample-faq-en.md';
    const text = await fetch(new URL('./samples/' + f, import.meta.url)).then(r => r.text());
    if (docs.some(d => d.name === f)) return;
    await addDocument(f, { type: 'md', text }, text.length);
    if (!settings.business) { settings.business = lang === 'de' ? 'Fahrradwerkstatt am Fluss' : 'Riverside Bike Repair'; saveSettings(); $('#business').value = settings.business; }
    $('#q').value = lang === 'de' ? 'Was kostet ein Plattfuß am E-Bike?' : 'How much is a flat tyre on an e-bike?';
    $('#q').focus();
  };
  $('#clearBtn').onclick = async () => {
    await store.clear(); docs = []; chunks = []; rebuildIndex(); renderDocs(); renderSem();
  };
  $('#semBtn').onclick = enableSem;

  $('#provider').onchange = e => { settings.provider = e.target.value; saveSettings(); renderProvider(); };
  $('#base').onchange = e => { settings.bases[settings.provider] = e.target.value.trim(); saveSettings(); };
  $('#model').onchange = e => { settings.models[settings.provider] = e.target.value.trim(); saveSettings(); $('#noKey').hidden = canChat(); };
  $('#modelsBtn').onclick = loadModelList;
  $('#key').oninput = e => { setKey(e.target.value.trim()); $('#noKey').hidden = canChat(); };
  $('#remember').onchange = e => { const k = getKey(); settings.remember = e.target.checked; saveSettings(); setKey(k); };
  $('#business').onchange = e => { settings.business = e.target.value.trim(); saveSettings(); };
  $('#exportLang').onchange = e => { settings.exportLang = e.target.value; saveSettings(); };
  $('#exportBtn').onclick = exportBundle;
  $('#clearChat').onclick = () => { $('#log').textContent = ''; history = []; welcome(); };

  const q = $('#q');
  $('#askForm').onsubmit = e => {
    e.preventDefault();
    if (busy) { busy.abort(); return; }
    const v = q.value.trim();
    if (!v) return;
    q.value = ''; q.style.height = '';
    ask(v);
  };
  q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#askForm').requestSubmit(); } });
  q.addEventListener('input', () => { q.style.height = ''; q.style.height = Math.min(q.scrollHeight, 160) + 'px'; });
}

async function init() {
  bind();
  try {
    docs = (await store.docs()).sort((a, b) => a.added - b.added);
    chunks = (await store.chunks()).sort((a, b) => docs.findIndex(d => d.id === a.docId) - docs.findIndex(d => d.id === b.docId) ||
      Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
  } catch (e) { console.warn('[faq-chatbot] storage', e); }
  rebuildIndex();
  applyLang();
  let semOn = false;
  try { semOn = !!(await store.get('semantic')); } catch {}
  if (semOn) enableSem();      // model comes from the browser cache after the first time
  // ?demo=1: load the sample and ask one question (used for the screenshot on the tool page)
  if (new URLSearchParams(location.search).has('demo')) {
    if (!docs.length) await $('#sampleBtn').onclick();
    $('#askForm').requestSubmit();
  }
}
init();
