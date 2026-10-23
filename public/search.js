// Pure search logic: query parsing, lexical scoring, fusion. No DOM, no network.

const STOP = new Set(('a an and are as at be but by for from had has have how i if in into is it its me my of on or ' +
  'our so than that the their them then there these they this to was we were what when where which who why will with you ' +
  'about did do does find show tell remember recall').split(' '));

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.%$-]*[\p{L}\p{N}%]|[\p{L}\p{N}]/gu) || []).map((t) => t.replace(/'s$/, ''));
}

// Optimal string alignment distance: counts an adjacent swap ("baord") as one edit.
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// Pulls structured filters out of a plain-language query; whatever is left is the topic.
export function parseQuery(raw, now = new Date()) {
  let q = ' ' + raw + ' ';
  const out = { phrases: [], exclude: [], tags: [], sources: [], range: null, rangeLabel: '' };

  q = q.replace(/"([^"]+)"/g, (_, p) => { out.phrases.push(p.toLowerCase().trim()); return ' '; });
  q = q.replace(/\s-([\p{L}\p{N}]+)/gu, (_, w) => { out.exclude.push(w.toLowerCase()); return ' '; });
  q = q.replace(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu, (_, t) => { out.tags.push(t.toLowerCase()); return ' '; });
  q = q.replace(/\b(?:source|from|via):([\w-]+)/gi, (_, s) => { out.sources.push(s.toLowerCase()); return ' '; });

  const today = startOfDay(now);
  const setRange = (from, to, label) => { if (!out.range) { out.range = [from, to]; out.rangeLabel = label; } return ' '; };
  const dow = (today.getDay() + 6) % 7; // Monday = 0

  q = q.replace(/\btoday\b/i, () => setRange(today, addDays(today, 1), 'today'));
  q = q.replace(/\byesterday\b/i, () => setRange(addDays(today, -1), today, 'yesterday'));
  q = q.replace(/\bthis week\b/i, () => setRange(addDays(today, -dow), addDays(today, 7 - dow), 'this week'));
  q = q.replace(/\blast week\b/i, () => setRange(addDays(today, -dow - 7), addDays(today, -dow), 'last week'));
  q = q.replace(/\bthis month\b/i, () => setRange(new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1), 'this month'));
  q = q.replace(/\blast month\b/i, () => setRange(new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1), 'last month'));
  q = q.replace(/\bthis year\b/i, () => setRange(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1), 'this year'));
  q = q.replace(/\blast year\b/i, () => setRange(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1), 'last year'));
  q = q.replace(/\b(?:in |during |since )?(january|february|march|april|may|june|july|august|september|october|november|december)(?: (\d{4}))?\b/i, (m, mon, yr) => {
    // "may" alone is too ambiguous as a word; only treat it as a month with "in/during" or a year.
    if (/^may$/i.test(mon) && !/^(in|during) /i.test(m) && !yr) return m;
    const mi = MONTHS.indexOf(mon.toLowerCase());
    let y = yr ? +yr : now.getFullYear();
    if (!yr && mi > now.getMonth()) y -= 1;
    return setRange(new Date(y, mi, 1), new Date(y, mi + 1, 1), `${mon} ${y}`);
  });
  q = q.replace(/\b(?:in |during |from )?(20\d{2})\b/, (m, yr) => setRange(new Date(+yr, 0, 1), new Date(+yr + 1, 0, 1), yr));
  q = q.replace(/\b(?:in the )?(?:last|past) (\d+) (day|week|month)s?\b/i, (m, n, unit) => {
    const from = unit === 'day' ? addDays(today, -n) : unit === 'week' ? addDays(today, -7 * n) : new Date(now.getFullYear(), now.getMonth() - n, now.getDate());
    return setRange(from, addDays(today, 1), `last ${n} ${unit}s`);
  });

  const topic = q.replace(/\s+/g, ' ').trim();
  const terms = tokenize(topic).filter((t) => !STOP.has(t));
  return { ...out, topic, terms: [...new Set(terms)] };
}

export function decorate(row) {
  const text = row.Text || '';
  const tokens = tokenize(text);
  return {
    id: row.id,
    text,
    created: row.Created ? new Date(row.Created) : null,
    source: row.Source?.value || '',
    tags: [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((m) => m[1].toLowerCase()),
    lower: text.toLowerCase(),
    stems: tokens.map(stem),
    stemSet: new Set(tokens.map(stem)),
  };
}

export function buildIndex(docs) {
  const df = new Map();
  for (const d of docs) for (const s of d.stemSet) df.set(s, (df.get(s) || 0) + 1);
  return { docs, df, n: docs.length };
}

export function passesFilters(d, p) {
  if (p.range && (!d.created || d.created < p.range[0] || d.created >= p.range[1])) return false;
  if (p.sources.length && !p.sources.some((s) => d.source.toLowerCase().includes(s))) return false;
  if (p.tags.length && !p.tags.every((t) => d.tags.includes(t))) return false;
  if (p.phrases.length && !p.phrases.every((ph) => d.lower.includes(ph))) return false;
  if (p.exclude.length && p.exclude.some((w) => d.stemSet.has(stem(w)))) return false;
  return true;
}

// Per-term match: exact stem > prefix > fuzzy. Returns {score, hit} for one doc.
function termScore(term, d, index) {
  const s = stem(term);
  const idf = (stemKey) => Math.log(1 + (index.n - (index.df.get(stemKey) || 0) + 0.5) / ((index.df.get(stemKey) || 0) + 0.5));
  if (d.stemSet.has(s)) return idf(s);
  let best = 0;
  for (const ds of d.stemSet) {
    if (s.length >= 3 && ds.length > s.length && ds.startsWith(s)) best = Math.max(best, 0.6 * idf(ds));
    else if (s.length >= 5) {
      const max = s.length >= 8 ? 2 : 1;
      if (editDistance(s, ds, max) <= max) best = Math.max(best, 0.5 * idf(ds));
    }
    if (best && s.length < 5) break;
  }
  return best;
}

export function lexicalSearch(index, parsed) {
  const out = [];
  for (const d of index.docs) {
    if (!passesFilters(d, parsed)) continue;
    if (!parsed.terms.length) { out.push({ doc: d, score: 0 }); continue; }
    let score = 0, hits = 0;
    for (const t of parsed.terms) {
      const sc = termScore(t, d, index);
      if (sc > 0) { score += sc; hits++; }
    }
    if (!hits) continue;
    if (hits === parsed.terms.length && hits > 1) score *= 1.5;
    out.push({ doc: d, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are pre-normalised
}

export function semanticSearch(index, parsed, qvec, vectors, threshold = 0.3, limit = 40) {
  const out = [];
  for (const d of index.docs) {
    const v = vectors.get(d.id);
    if (!v || !passesFilters(d, parsed)) continue;
    const score = cosine(qvec, v);
    if (score >= threshold) out.push({ doc: d, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Reciprocal rank fusion; docs found by both lists rise to the top.
export function fuse(lexical, semantic, k = 60) {
  const m = new Map();
  const add = (list, key) => list.forEach((r, i) => {
    const e = m.get(r.doc.id) || { doc: r.doc, score: 0, lex: false, sem: false };
    e.score += 1 / (k + i + 1);
    e[key] = true;
    m.set(r.doc.id, e);
  });
  add(lexical, 'lex');
  add(semantic, 'sem');
  return [...m.values()].sort((a, b) => b.score - a.score);
}

export function byRecency(list) {
  return [...list].sort((a, b) => (b.doc.created?.getTime() || 0) - (a.doc.created?.getTime() || 0));
}
