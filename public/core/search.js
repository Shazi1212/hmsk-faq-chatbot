// Retrieval: BM25 keyword search, cosine similarity on embeddings, and reciprocal rank fusion of both.
// No imports and no DOM: the export step inlines this file into the embeddable widget (it strips the
// `export` keywords), and the tests run it in Node. Keep it that way.

export const STOPWORDS = new Set((
  'a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our ' +
  'so than that the their them then there these they this to us was we were what when where which who why will ' +
  'with you your yours ' +
  'aber als am an auch auf aus bei bin bis bist da dann das dass dein deine dem den der des die dir doch du ein ' +
  'eine einem einen einer eines er es euer eure für hat hatte ich ihr ihre im in ist ja kann man mein mich mir ' +
  'mit nach nicht noch nur ob oder sein sich sie sind so über um und uns unser vom von vor war was welche wenn ' +
  'wer wie wir wird wo zu zum zur'
).split(' '));

// Lowercase word tokens (letters and digits in any script), stopwords removed, light plural/suffix folding
// so "hours" matches "hour" and "Öffnungszeiten" matches "Öffnungszeit".
export function tokenize(text) {
  const words = String(text || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (let w of words) {
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOPWORDS.has(w)) continue;
    if (w.length > 4) w = w.replace(/(?:ies)$/, 'y').replace(/(?:es|en|er|s|e|n)$/, '');
    out.push(w);
  }
  return out;
}

// Builds a BM25 index over an array of strings. The result is plain JSON (exported with the widget).
export function buildBm25(texts) {
  const docs = texts.map(t => {
    const tf = {};
    const toks = tokenize(t);
    for (const w of toks) tf[w] = (tf[w] || 0) + 1;
    return { len: toks.length, tf };
  });
  const df = {};
  for (const d of docs) for (const w in d.tf) df[w] = (df[w] || 0) + 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  return { n: docs.length, avgdl, df, docs };
}

// Scores every document for the query. Returns [{ i, score }] sorted, only score > 0.
export function bm25Search(index, query, k1 = 1.2, b = 0.75) {
  const q = [...new Set(tokenize(query))];
  const res = [];
  index.docs.forEach((d, i) => {
    let s = 0;
    for (const w of q) {
      const f = d.tf[w];
      if (!f) continue;
      const n = index.df[w] || 0;
      const idf = Math.log(1 + (index.n - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / (index.avgdl || 1)));
    }
    if (s > 0) res.push({ i, score: s });
  });
  return res.sort((a, b2) => b2.score - a.score);
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// vecs: array of vectors (or null where a chunk has no embedding yet). Returns [{ i, score }] sorted.
export function vectorSearch(vecs, qvec) {
  const res = [];
  vecs.forEach((v, i) => { if (v) res.push({ i, score: cosine(v, qvec) }); });
  return res.sort((a, b) => b.score - a.score);
}

// Reciprocal rank fusion: robust way to merge rankings whose scores are not comparable.
export function rrf(lists, k = 60) {
  const s = new Map();
  for (const list of lists) list.forEach((r, rank) => s.set(r.i, (s.get(r.i) || 0) + 1 / (k + rank + 1)));
  return [...s.entries()].map(([i, score]) => ({ i, score })).sort((a, b) => b.score - a.score);
}

// Hybrid retrieval. `minSim` drops vector hits that are clearly unrelated, so an off-topic question
// gets no context and the model says it does not know instead of answering from a random chunk.
export function retrieve({ bm25, vecs, qvec, query, topK = 5, minSim = 0.25 }) {
  const kw = bm25Search(bm25, query).slice(0, 20);
  const lists = [kw];
  if (vecs && qvec) lists.push(vectorSearch(vecs, qvec).filter(r => r.score >= minSim).slice(0, 20));
  return (lists.length > 1 ? rrf(lists) : kw).slice(0, topK);
}
