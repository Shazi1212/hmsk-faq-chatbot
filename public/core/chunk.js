// Splits document text into chunks for retrieval. Pure functions, no DOM; also runs in Node for the tests.
//
// Rules:
// - Blocks are separated by blank lines. A Markdown heading starts a new section; its text is kept as the
//   chunk's `heading` so a chunk still makes sense on its own ("Opening hours > Sunday").
// - A question line ("...?" or "Q:") is kept together with the answer that follows it.
// - Blocks are merged up to `maxChars`. A block longer than that is split at sentence ends, with a short
//   overlap so a fact cut in half still appears whole in one chunk.

export const CHUNK_DEFAULTS = { maxChars: 900, minChars: 200, overlap: 150 };

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const QUESTION = /^\s*(?:q(?:uestion)?|f(?:rage)?)\s*[:.)]\s*|\?\s*$/i;

export function normalizeText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')                 // soft hyphens from PDFs
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Splits text into sentences. Keeps abbreviations like "z. B." or "e.g." mostly intact by requiring
// an uppercase letter or digit after the boundary.
export function sentences(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+(?=\s+[A-ZÄÖÜ0-9"'(\[]|\s*$)|\n|$)/g;
  let m;
  let buf = '';
  while ((m = re.exec(text)) !== null) {
    if (!m[0]) { re.lastIndex++; continue; }
    buf += m[0];
    if (/[.!?]\s*$/.test(m[0]) || m[0].endsWith('\n') || re.lastIndex >= text.length) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [text];
}

function splitLong(block, maxChars, overlap) {
  const parts = [];
  let cur = '';
  for (const s of sentences(block)) {
    if (s.length > maxChars) {                      // one huge "sentence" (tables, lists without dots)
      if (cur) { parts.push(cur); cur = ''; }
      for (let i = 0; i < s.length; i += maxChars - overlap) parts.push(s.slice(i, i + maxChars));
      continue;
    }
    if (cur && cur.length + 1 + s.length > maxChars) {
      parts.push(cur);
      const tail = cur.slice(-overlap);
      const cut = tail.search(/[.!?]\s|\s/);           // start the overlap at a word boundary
      cur = (cut >= 0 ? tail.slice(cut + 1) : tail).trim();
      cur = cur ? cur + ' ' + s : s;
    } else {
      cur = cur ? cur + ' ' + s : s;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Returns [{ heading, text }]. `text` never contains the heading; callers prepend it when embedding.
export function chunkText(raw, opts = {}) {
  const { maxChars, minChars, overlap } = { ...CHUNK_DEFAULTS, ...opts };
  const text = normalizeText(raw);
  if (!text) return [];

  // 1. blocks with their section path
  const blocks = [];
  const path = [];
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n');
    let body = [];
    const flush = () => {
      const t = body.join('\n').trim();
      if (t) blocks.push({ heading: path.filter(Boolean).join(' > '), text: t });
      body = [];
    };
    for (const line of lines) {
      const h = line.match(HEADING);
      if (h) {
        flush();
        const level = h[1].length;
        path.length = level - 1;
        path[level - 1] = h[2].trim();
      } else {
        body.push(line);
      }
    }
    flush();
  }

  // 2. glue a question block to its answer block
  const glued = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const isQ = b.text.length < 300 && !b.text.includes('\n') && QUESTION.test(b.text);
    if (isQ && next && next.heading === b.heading) {
      glued.push({ heading: b.heading, text: b.text + '\n' + next.text, qa: true });
      i++;
    } else {
      // question and answer in one paragraph ("Question?\nAnswer.")
      const first = b.text.split('\n')[0];
      const qa = b.text.includes('\n') && first.length < 300 && QUESTION.test(first);
      glued.push(qa ? { ...b, qa } : b);
    }
  }

  // 3. merge small blocks of the same section, split big ones
  const chunks = [];
  let cur = null;
  const push = c => { if (c && c.text.trim()) chunks.push({ heading: c.heading, text: c.text.trim() }); };
  for (const b of glued) {
    if (b.text.length > maxChars) {
      push(cur); cur = null;
      for (const part of splitLong(b.text, maxChars, overlap)) push({ heading: b.heading, text: part });
      continue;
    }
    // Q&A pairs stay separate chunks so a citation points at exactly one answer.
    if (cur && !b.qa && !cur.qa && cur.heading === b.heading && cur.text.length + 2 + b.text.length <= maxChars) {
      cur.text += '\n\n' + b.text;
      continue;
    }
    if (cur && cur.text.length < minChars && !b.qa && !cur.qa && cur.heading === b.heading &&
        cur.text.length + 2 + b.text.length <= maxChars * 1.3) {
      cur.text += '\n\n' + b.text;
      continue;
    }
    push(cur);
    cur = { ...b };
  }
  push(cur);
  return chunks;
}

// Chunks a document made of pages (PDF) or a single text. Returns chunks with page numbers when known.
export function chunkDocument(doc, opts) {
  const pages = doc.pages || [doc.text];
  const out = [];
  pages.forEach((p, i) => {
    for (const c of chunkText(p, opts)) out.push({ ...c, page: doc.pages ? i + 1 : null });
  });
  return out;
}

// Text that gets embedded and searched: heading gives context to short answers.
export function searchableText(chunk) {
  return chunk.heading ? chunk.heading + '\n' + chunk.text : chunk.text;
}
