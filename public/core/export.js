// Builds the self-hosting bundle: widget, prebuilt index, demo page, two proxy options and a README.
// Pure: the caller passes in the source files' text, so this runs in the browser and in the tests.
import { makeZip } from './zip.js';

// Inlines search.js into a template: strips `export` so the functions become locals of the widget/worker.
export function inlineSearch(template, searchSrc) {
  const body = searchSrc.replace(/^export\s+/gm, '');
  return template.replace('/*@@SEARCH@@*/', body.trim());
}

// The exported index: only what the widget and proxies need. No embeddings (keeps it small; widget and
// proxies search by keywords), no file contents beyond the chunk texts.
export function buildIndex({ name, lang, docs, chunks }, now = new Date()) {
  const docName = Object.fromEntries(docs.map(d => [d.id, d.name]));
  return {
    format: 'hmsk-faq-index', version: 1,
    name: name || '', lang: lang || 'en', created: now.toISOString().slice(0, 10),
    docs: docs.map(d => d.name),
    chunks: chunks.map((c, i) => ({ id: i + 1, doc: docName[c.docId] || '', page: c.page || null, heading: c.heading || '', text: c.text })),
  };
}

export function slugify(s) {
  return String(s || 'faq').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'faq';
}

function demoHtml(name, lang) {
  const de = lang === 'de';
  return `<!doctype html>
<html lang="${de ? 'de' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${de ? 'FAQ-Widget Test' : 'FAQ widget test'}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#222}code{background:#f2f2f2;padding:2px 4px;border-radius:4px}</style>
</head>
<body>
<h1>${de ? 'Test-Seite für Ihr FAQ-Widget' : 'Test page for your FAQ widget'}</h1>
<p>${de ? 'Unten rechts sitzt das Widget. Ohne <code>data-endpoint</code> läuft es im Suchmodus: Es zeigt die passendsten Stellen aus Ihren Dokumenten, ganz ohne KI und API-Schlüssel.'
    : 'The widget sits in the bottom right corner. Without <code>data-endpoint</code> it runs in search mode: it shows the best matching passages from your documents, no AI and no API key needed.'}</p>
<p>${de ? 'Öffnen Sie diese Seite über einen Webserver (nicht per Doppelklick), z. B.' : 'Open this page through a web server (not by double-clicking it), e.g.'} <code>python3 -m http.server 8080</code> ${de ? 'im entpackten Ordner, dann' : 'in the unzipped folder, then'} <code>http://localhost:8080/demo.html</code>.</p>

<!-- ${de ? 'Diese eine Zeile kommt auf Ihre Website' : 'This one line goes on your website'} -->
<script src="faq-widget.js" data-index="faq-index.json" data-lang="${de ? 'de' : 'en'}"${name ? ` data-title="${String(name).replace(/"/g, '&quot;')}"` : ''} defer></script>
<!-- ${de ? 'Mit KI-Antworten über Ihren Proxy' : 'With AI answers through your proxy'}:
<script src="faq-widget.js" data-index="faq-index.json" data-endpoint="https://your-site.example/faq/proxy.php" defer></script>
-->
</body>
</html>
`;
}

function readme(name, lang, nChunks, docs) {
  if (lang === 'de') return `# FAQ-Chatbot für ${name || 'Ihre Website'}

Erstellt mit https://hmsk.life/tools/faq-chatbot/ am ${new Date().toISOString().slice(0, 10)}.
Index: ${nChunks} Abschnitte aus ${docs.length} Dokument(en): ${docs.join(', ')}.

## Inhalt

| Datei | Wofür |
|---|---|
| \`faq-widget.js\` | Das Chat-Widget (eine Datei, keine Abhängigkeiten, ca. 15 KB) |
| \`faq-index.json\` | Ihre Dokumente, in Abschnitte zerlegt. **Öffentlich lesbar**, also nur Inhalte, die öffentlich sein dürfen |
| \`demo.html\` | Test-Seite |
| \`proxy/proxy.php\` | Proxy für normales PHP-Hosting |
| \`proxy/cloudflare-worker.js\` | Proxy für Cloudflare Workers |

## 1. Suchmodus (ohne KI, ohne Schlüssel)

\`faq-widget.js\` und \`faq-index.json\` in einen Ordner Ihrer Website laden, z. B. \`/faq/\`, und vor \`</body>\` einfügen:

\`\`\`html
<script src="/faq/faq-widget.js" data-index="/faq/faq-index.json" data-lang="de" defer></script>
\`\`\`

Das Widget zeigt dann die drei passendsten Stellen aus Ihren Dokumenten. Kein Server, keine Kosten.

## 2. KI-Antworten mit Quellen (über einen Proxy)

**Legen Sie Ihren API-Schlüssel nie in das Widget oder in eine öffentliche Datei.** Jeder Besucher könnte ihn
auslesen und auf Ihre Kosten nutzen. Deshalb gibt es einen kleinen Proxy, der den Schlüssel auf Ihrem Server hält,
selbst in \`faq-index.json\` sucht und nur die passenden Stellen und die Frage an den KI-Anbieter schickt.

**PHP-Hosting:** \`proxy/proxy.php\` und \`faq-index.json\` in denselben Ordner legen. Oben in \`proxy.php\` den
Schlüssel (oder die Umgebungsvariable \`FAQ_API_KEY\`) und \`allowed_origins\` (Ihre Domain) eintragen. Dann:

\`\`\`html
<script src="/faq/faq-widget.js" data-index="/faq/faq-index.json" data-endpoint="/faq/proxy.php" data-lang="de" defer></script>
\`\`\`

**Cloudflare Workers:** \`proxy/cloudflare-worker.js\` als Worker anlegen, \`API_KEY\` als Secret setzen und
\`INDEX_URL\`, \`ALLOWED_ORIGINS\`, \`MODEL\` als Variablen (siehe Kommentar oben in der Datei).

Schutz im Proxy: nur Ihre Domain, Fragen bis 500 Zeichen, Antworten bis 500 Token, 10 Anfragen pro Minute und
Besucher (PHP zusätzlich 500 pro Tag). Setzen Sie trotzdem ein monatliches Ausgabenlimit beim KI-Anbieter.

Anbieter: Anthropic (Standard, Modell \`claude-haiku-5-5\`) oder jede OpenAI-kompatible API
(\`provider\` = \`openai\`, \`base_url\` anpassen).

## Optionen des Widgets

\`data-title\`, \`data-greeting\`, \`data-lang\` (\`de\`/\`en\`), \`data-color\` (\`#0f766e\`),
\`data-position\` (\`right\`/\`left\`), \`data-credit="off"\` blendet den kleinen Hinweis "erstellt mit hmsk.life" aus.

## Datenschutz

Im Suchmodus verlassen Fragen den Browser nicht. Mit Proxy gehen Frage und passende Abschnitte an Ihren
Proxy und von dort an den KI-Anbieter. Nennen Sie das in Ihrer Datenschutzerklärung (Anbieter, Zweck,
Drittlandübermittlung bei US-Anbietern).

Lizenz: MIT. Aktualisieren: Dokumente in der App ändern und neu exportieren, dann \`faq-index.json\` ersetzen.
`;
  return `# FAQ chatbot for ${name || 'your website'}

Made with https://hmsk.life/tools/faq-chatbot/ on ${new Date().toISOString().slice(0, 10)}.
Index: ${nChunks} passages from ${docs.length} document(s): ${docs.join(', ')}.

## What is in here

| File | What for |
|---|---|
| \`faq-widget.js\` | The chat widget (one file, no dependencies, about 15 KB) |
| \`faq-index.json\` | Your documents split into passages. **Anyone can read it**, so only include public content |
| \`demo.html\` | Test page |
| \`proxy/proxy.php\` | Proxy for ordinary PHP hosting |
| \`proxy/cloudflare-worker.js\` | Proxy for Cloudflare Workers |

## 1. Search mode (no AI, no key)

Upload \`faq-widget.js\` and \`faq-index.json\` to a folder on your site, e.g. \`/faq/\`, and add this before \`</body>\`:

\`\`\`html
<script src="/faq/faq-widget.js" data-index="/faq/faq-index.json" defer></script>
\`\`\`

The widget then shows the three best matching passages from your documents. No server, no cost.

## 2. AI answers with sources (through a proxy)

**Never put your API key into the widget or any public file.** Every visitor could read it and spend your money.
That is why there is a small proxy: it keeps the key on your server, searches \`faq-index.json\` itself and sends
only the matching passages and the question to the AI provider.

**PHP hosting:** put \`proxy/proxy.php\` and \`faq-index.json\` in the same folder. At the top of \`proxy.php\`, set the
key (or the environment variable \`FAQ_API_KEY\`) and \`allowed_origins\` (your domain). Then:

\`\`\`html
<script src="/faq/faq-widget.js" data-index="/faq/faq-index.json" data-endpoint="/faq/proxy.php" defer></script>
\`\`\`

**Cloudflare Workers:** create a Worker from \`proxy/cloudflare-worker.js\`, set \`API_KEY\` as a secret and
\`INDEX_URL\`, \`ALLOWED_ORIGINS\`, \`MODEL\` as variables (see the comment at the top of the file).

Built-in limits: your domain only, questions up to 500 characters, answers up to 500 tokens, 10 requests per minute
per visitor (PHP also 500 per day in total). Still set a monthly spending limit with your AI provider.

Providers: Anthropic (default, model \`claude-haiku-5-5\`) or any OpenAI-compatible API
(\`provider\` = \`openai\`, set \`base_url\`).

## Widget options

\`data-title\`, \`data-greeting\`, \`data-lang\` (\`en\`/\`de\`), \`data-color\` (\`#0f766e\`),
\`data-position\` (\`right\`/\`left\`), \`data-credit="off"\` hides the small "made with hmsk.life" link.

## Privacy

In search mode questions never leave the visitor's browser. With a proxy, the question and the matching passages go
to your proxy and from there to the AI provider. Mention that in your privacy policy.

License: MIT. To update: change the documents in the app, export again and replace \`faq-index.json\`.
`;
}

const LICENSE = `MIT License

Copyright (c) 2026 Hafiz Muhammad Sharoz Khalid (widget and proxies)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// src: { search, widget, worker, php } source texts. Returns { files, zip, folder }.
export function buildBundle(project, src, now = new Date()) {
  const index = buildIndex(project, now);
  const folder = slugify(project.name) + '-faq-widget';
  const files = [
    { name: 'faq-widget.js', data: inlineSearch(src.widget, src.search) },
    { name: 'faq-index.json', data: JSON.stringify(index) },
    { name: 'demo.html', data: demoHtml(project.name, project.lang) },
    { name: 'README.md', data: readme(project.name, project.lang, index.chunks.length, index.docs) },
    { name: 'LICENSE', data: LICENSE },
    { name: 'proxy/proxy.php', data: src.php },
    { name: 'proxy/cloudflare-worker.js', data: inlineSearch(src.worker, src.search) },
  ].map(f => ({ ...f, name: folder + '/' + f.name }));
  return { files, folder, zip: makeZip(files, now) };
}
