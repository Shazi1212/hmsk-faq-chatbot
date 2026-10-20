/*! FAQ chat widget · MIT · made with https://hmsk.life/tools/faq-chatbot/
 *
 * Usage (see README.md):
 *   <script src="/faq/faq-widget.js" data-index="/faq/faq-index.json" defer></script>
 * Optional attributes:
 *   data-endpoint  URL of your proxy (proxy/proxy.php or proxy/cloudflare-worker.js). Without it the widget
 *                  works in search mode: it shows the best matching passages, no AI and no API key needed.
 *   data-title     panel title            data-lang   "en" | "de" (default: page language)
 *   data-color     accent colour (#hex)   data-position  "right" | "left"
 *   data-greeting  first message         data-credit  "off" hides the small "made with" link
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__hmskFaqWidget) return;
  window.__hmskFaqWidget = true;

  /*@@SEARCH@@*/

  var cfg = {
    index: script.getAttribute('data-index') || 'faq-index.json',
    endpoint: script.getAttribute('data-endpoint') || '',
    title: script.getAttribute('data-title') || '',
    lang: (script.getAttribute('data-lang') || document.documentElement.lang || 'en').slice(0, 2).toLowerCase() === 'de' ? 'de' : 'en',
    color: /^#[0-9a-f]{3,8}$/i.test(script.getAttribute('data-color') || '') ? script.getAttribute('data-color') : '#1E4C8A',
    position: script.getAttribute('data-position') === 'left' ? 'left' : 'right',
    greeting: script.getAttribute('data-greeting') || '',
    credit: script.getAttribute('data-credit') !== 'off',
  };
  var indexUrl = new URL(cfg.index, script.src || location.href).href;

  var T = {
    en: { open: 'Questions? Ask us', title: 'Ask a question', ph: 'Type your question…', send: 'Send', close: 'Close',
      hi: 'Hi! Ask me anything about our services, prices or opening hours.',
      searchNote: 'Best matches from our FAQ:', none: 'Sorry, I could not find that in our information. Please contact us directly.',
      err: 'Something went wrong. Please try again or contact us directly.', thinking: 'Looking it up…', sources: 'Sources', page: 'p.', made: 'made with hmsk.life' },
    de: { open: 'Fragen? Fragen Sie uns', title: 'Stellen Sie eine Frage', ph: 'Ihre Frage…', send: 'Senden', close: 'Schließen',
      hi: 'Hallo! Fragen Sie mich zu Leistungen, Preisen oder Öffnungszeiten.',
      searchNote: 'Passende Antworten aus unseren FAQ:', none: 'Dazu habe ich leider nichts gefunden. Bitte kontaktieren Sie uns direkt.',
      err: 'Da ist etwas schiefgelaufen. Bitte noch einmal versuchen oder uns direkt kontaktieren.', thinking: 'Ich schaue nach…', sources: 'Quellen', page: 'S.', made: 'erstellt mit hmsk.life' },
  }[cfg.lang];

  var data = null, bm25 = null, history = [];
  function loadIndex() {
    if (data) return Promise.resolve(data);
    return fetch(indexUrl).then(function (r) { if (!r.ok) throw new Error('index ' + r.status); return r.json(); }).then(function (j) {
      data = j;
      bm25 = buildBm25(j.chunks.map(function (c) { return (c.heading ? c.heading + '\n' : '') + c.text; }));
      return j;
    });
  }

  // ---------- UI (shadow DOM, so the site's CSS and ours never collide) ----------
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483000;bottom:16px;' + cfg.position + ':16px';
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.fab{display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px;background:' + cfg.color + ';color:#fff;font:600 15px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(21,27,36,.25)}' +
    '.fab:focus-visible,button:focus-visible,textarea:focus-visible{outline:3px solid ' + cfg.color + ';outline-offset:2px}' +
    '.panel{display:none;flex-direction:column;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));background:#fff;color:#151B24;border-radius:8px;box-shadow:0 16px 48px rgba(21,27,36,.3);overflow:hidden;margin-bottom:12px}' +
    '.open .panel{display:flex}.open .fab{display:none}' +
    '.hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:' + cfg.color + ';color:#fff;font:600 15px/1.2 system-ui,sans-serif}' +
    '.hd button{background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}' +
    '.log{position:relative;flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#EFF1F2}' +
    '.m{max-width:88%;padding:10px 12px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
    '.u{align-self:flex-end;background:' + cfg.color + ';color:#fff;border-bottom-right-radius:4px}' +
    '.a{align-self:flex-start;background:#fff;border:1px solid #CBD2D9;border-bottom-left-radius:4px}' +
    '.a.dim{color:#4A5562;font-style:italic}' +
    '.a sup{font-size:11px;color:' + cfg.color + ';font-weight:700;margin-left:1px}' +
    '.src{margin:8px 0 0;padding:8px 0 0;border-top:1px solid #CBD2D9;font-size:12px;color:#4A5562;list-style:none}' +
    '.src li{margin:2px 0}.hit{margin:0 0 8px;padding:8px;background:#EFF1F2;border-radius:8px}.hit b{display:block;font-size:12px;color:#4A5562;margin-bottom:2px}' +
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid #CBD2D9;background:#fff}' +
    'textarea{flex:1;resize:none;border:1px solid #7B8592;border-radius:10px;padding:9px 10px;font-size:14px;line-height:1.4;height:42px;max-height:120px;color:#151B24;background:#fff}' +
    'form button{border:0;border-radius:10px;padding:0 14px;background:' + cfg.color + ';color:#fff;font-weight:600;cursor:pointer}' +
    'form button:disabled{opacity:.5;cursor:default}' +
    '.cr{padding:0 10px 8px;text-align:right;font-size:11px;background:#fff}.cr a{color:#4A5562;text-decoration:none}' +
    '@media (prefers-reduced-motion:no-preference){.panel{animation:in .18s ease-out}@keyframes in{from{opacity:0;transform:translateY(8px)}}}' +
    '</style>' +
    '<div class="w"><div class="panel" role="dialog" aria-label=""><div class="hd"><span class="tt"></span><button type="button" class="x"></button></div>' +
    '<div class="log" aria-live="polite"></div>' +
    '<form><textarea rows="1" maxlength="500"></textarea><button type="submit"></button></form>' +
    (cfg.credit ? '<div class="cr"><a target="_blank" rel="noopener" href="https://hmsk.life/tools/faq-chatbot/?utm_source=faq-chatbot&utm_medium=widget&utm_campaign=faq-chatbot-made-with"></a></div>' : '') +
    '</div><button type="button" class="fab"></button></div>';
  var $ = function (s) { return root.querySelector(s); };
  var w = $('.w'), log = $('.log'), ta = $('textarea'), btn = $('form button');
  $('.fab').textContent = T.open;
  $('.tt').textContent = cfg.title || T.title;
  $('.panel').setAttribute('aria-label', cfg.title || T.title);
  $('.x').textContent = '×'; $('.x').setAttribute('aria-label', T.close);
  ta.placeholder = T.ph; ta.setAttribute('aria-label', T.ph);
  btn.textContent = T.send;
  if (cfg.credit) $('.cr a').textContent = T.made;

  function add(cls, text) {
    var d = document.createElement('div');
    d.className = 'm ' + cls;
    if (text) d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  // Renders an answer with [n] markers as superscripts and a source list.
  function renderAnswer(el, text, sources) {
    el.textContent = '';
    var re = /\[(\d{1,2})\]/g, last = 0, m, used = {};
    while ((m = re.exec(text)) !== null) {
      el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var s = sources[Number(m[1]) - 1];
      var sup = document.createElement('sup');
      sup.textContent = '[' + m[1] + ']';
      if (s) { sup.title = s.title + (s.page ? ' ' + T.page + ' ' + s.page : ''); used[m[1]] = s; }
      el.appendChild(sup);
      last = re.lastIndex;
    }
    el.appendChild(document.createTextNode(text.slice(last)));
    var keys = Object.keys(used);
    if (keys.length) {
      var ul = document.createElement('ul');
      ul.className = 'src';
      keys.forEach(function (k) {
        var li = document.createElement('li');
        li.textContent = '[' + k + '] ' + used[k].title + (used[k].page ? ', ' + T.page + ' ' + used[k].page : '');
        ul.appendChild(li);
      });
      el.appendChild(ul);
    }
  }

  function ask(q) {
    add('u', q);
    var a = add('a dim', T.thinking);
    btn.disabled = true;
    // Scroll to the start of the answer, so a long reply is read from the top.
    var done = function () { btn.disabled = false; log.scrollTop = Math.max(0, a.offsetTop - 8); ta.focus(); };
    if (cfg.endpoint) {
      fetch(cfg.endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history: history.slice(-4), lang: cfg.lang }),
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
        .then(function (j) {
          a.className = 'm a';
          renderAnswer(a, j.answer || T.none, j.sources || []);
          history.push({ role: 'user', content: q }, { role: 'assistant', content: j.answer || '' });
        })
        .catch(function () { a.className = 'm a'; a.textContent = T.err; })
        .then(done);
      return;
    }
    // Search mode: no AI, show the best matching passages.
    loadIndex().then(function () {
      var hits = bm25Search(bm25, q).slice(0, 3);
      a.className = 'm a';
      a.textContent = '';
      if (!hits.length) { a.textContent = T.none; return; }
      var p = document.createElement('div'); p.textContent = T.searchNote; p.style.marginBottom = '6px'; a.appendChild(p);
      hits.forEach(function (h) {
        var c = data.chunks[h.i];
        var box = document.createElement('div'); box.className = 'hit';
        var b = document.createElement('b'); b.textContent = (c.heading || c.doc) + (c.page ? ' · ' + T.page + ' ' + c.page : '');
        box.appendChild(b);
        box.appendChild(document.createTextNode(c.text.length > 600 ? c.text.slice(0, 600) + '…' : c.text));
        a.appendChild(box);
      });
    }).catch(function () { a.className = 'm a'; a.textContent = T.err; }).then(done);
  }

  $('.fab').addEventListener('click', function () {
    w.classList.add('open');
    if (!log.childNodes.length) add('a', cfg.greeting || T.hi);
    if (!cfg.endpoint) loadIndex().catch(function () {});
    ta.focus();
  });
  $('.x').addEventListener('click', function () { w.classList.remove('open'); $('.fab').focus(); });
  root.addEventListener('keydown', function (e) { if (e.key === 'Escape') { w.classList.remove('open'); $('.fab').focus(); } });
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var q = ta.value.trim();
    if (!q || btn.disabled) return;
    ta.value = '';
    ask(q);
  });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit ? $('form').requestSubmit() : $('form button').click(); }
  });

  if (document.body) document.body.appendChild(host);
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(host); });
})();
