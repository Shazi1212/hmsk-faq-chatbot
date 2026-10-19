// Reads text out of the files a user drops: PDF (via pdf.js, loaded only when needed), TXT, Markdown,
// CSV, HTML. Returns { name, type, text } or { name, type, pages: [text, ...] } for PDFs.

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ACCEPT = '.pdf,.txt,.md,.markdown,.csv,.html,.htm,text/plain,text/markdown,application/pdf';

let pdfjs = null;
async function loadPdf() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}

// Joins pdf.js text items into lines and paragraphs using their positions.
function pageText(content) {
  let out = '';
  let lastY = null;
  let lastH = 0;
  for (const it of content.items) {
    if (!('str' in it)) continue;
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || lastH || 10;
    if (lastY !== null && Math.abs(y - lastY) > 1) {
      // a gap of more than about two lines starts a new paragraph; a plain line wrap is one newline
      if (Math.abs(y - lastY) > h * 2.2) out = out.replace(/\n*$/, '\n\n');
      else if (!out.endsWith('\n')) out += '\n';
    }
    out += it.str;
    if (it.hasEOL && !out.endsWith('\n')) out += '\n';
    lastY = y; lastH = h;
  }
  // de-hyphenate words broken across lines
  return out.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2');
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,nav,footer').forEach(n => n.remove());
  doc.querySelectorAll('h1,h2,h3,h4').forEach(h => { h.textContent = '\n\n' + '#'.repeat(Number(h.tagName[1])) + ' ' + h.textContent.trim() + '\n\n'; });
  doc.querySelectorAll('p,li,dt,dd,tr,br,div,section').forEach(n => n.append('\n'));
  return doc.body.textContent || '';
}

export async function extractFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('too-big');
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') {
    const lib = await loadPdf();
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      pages.push(pageText(await page.getTextContent()));
    }
    await task.destroy();
    if (!pages.join('').trim()) throw new Error('no-text');   // scanned PDF without a text layer
    return { name, type: 'pdf', pages };
  }
  const text = await file.text();
  if (ext === 'html' || ext === 'htm') return { name, type: 'html', text: htmlToText(text) };
  if (['txt', 'md', 'markdown', 'csv'].includes(ext) || file.type.startsWith('text/')) return { name, type: ext || 'txt', text };
  throw new Error('unsupported');
}
