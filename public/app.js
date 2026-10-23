import { hasVault, saveVault, openVault, resetVault } from './vault.js';
import { fetchRows } from './baserow.js';
import { decorate, buildIndex, parseQuery, lexicalSearch, semanticSearch, fuse, byRecency, passesFilters } from './search.js';
import { Embedder, loadCache, saveCache, hash } from './embeddings.js';

const $ = (s) => document.querySelector(s);
const state = {
  config: null, index: null, mode: 'smart', sourceFilter: new Set(),
  vectors: new Map(), semantic: 'idle', // idle | loading | indexing | ready | off
  indexed: 0, toIndex: 0, loadPct: 0, seq: 0, qvecCache: new Map(),
};
const embedder = new Embedder();

// ---------- Lock screen ----------
function showLock() {
  const setup = !hasVault();
  $('#lock-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#setup-fields').classList.toggle('hidden', !setup);
  $('#reset-setup').classList.toggle('hidden', setup);
  $('#lock-submit').textContent = setup ? 'Save & unlock' : 'Unlock';
  $('#pass-input').autocomplete = setup ? 'new-password' : 'current-password';
  $('#pass-input').value = '';
  $('#pass-input').focus();
}

$('#reset-setup').addEventListener('click', () => {
  if (confirm('Forget the saved token on this device?')) { resetVault(); showLock(); }
});

$('#lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#lock-error');
  err.textContent = '';
  const pass = $('#pass-input').value;
  if (!pass) return;
  try {
    if (!hasVault()) {
      const token = $('#token-input').value.trim();
      const tableId = $('#table-input').value.trim();
      const baseUrl = $('#url-input').value.trim() || 'https://api.baserow.io';
      if (!token || !tableId) { err.textContent = 'Token and table ID are required'; return; }
      if (pass.length < 8) { err.textContent = 'Use a passphrase of 8+ characters'; return; }
      state.config = { token, tableId, baseUrl };
      await fetchRows({ ...state.config }).then(() => {}); // fail fast on bad credentials
      await saveVault(pass, state.config);
      $('#token-input').value = '';
    } else {
      state.config = await openVault(pass);
    }
  } catch (ex) {
    state.config = null;
    err.textContent = hasVault() ? 'Wrong passphrase' : `Could not reach Baserow (${ex.message})`;
    return;
  }
  $('#lock-screen').classList.add('hidden');
  $('#pass-input').value = '';
  start();
});

$('#lock-btn').addEventListener('click', () => location.reload());

// ---------- Boot ----------
async function start() {
  $('#app').classList.remove('hidden');
  $('#search-input').focus();
  setStatus('Loading…');
  const rows = await fetchRows(state.config).catch((ex) => { setStatus(`Could not load memories (${ex.message})`); return []; });
  const docs = rows.filter((r) => !r.Archived && (r.Text || '').trim()).map(decorate);
  state.index = buildIndex(docs);
  renderChips();
  render();
  initSemantic();
}

async function initSemantic() {
  const docs = state.index.docs;
  const cache = await loadCache();
  const need = [];
  for (const d of docs) {
    const c = cache.get(d.id);
    if (c && c.hash === hash(d.text)) state.vectors.set(d.id, Float32Array.from(c.vec));
    else need.push(d);
  }
  const live = new Set(docs.map((d) => d.id));
  const stale = [...cache.keys()].filter((id) => !live.has(id));
  if (stale.length) saveCache([], stale);

  state.toIndex = need.length;
  state.semantic = need.length ? 'loading' : 'ready';
  // Don't pull the model down just to search an already-cached, unchanged set... except the
  // query itself needs embedding, so the model is always needed once Smart mode is used.
  embedder.onProgress = (pct) => { state.loadPct = pct; if (state.semantic === 'loading') render(true); };
  try {
    await embedder.start();
    state.semantic = need.length ? 'indexing' : 'ready';
    for (let i = 0; i < need.length; i += 16) {
      const batch = need.slice(i, i + 16);
      const vecs = await embedder.embed(batch.map((d) => d.text.slice(0, 1500)));
      const entries = batch.map((d, j) => {
        state.vectors.set(d.id, Float32Array.from(vecs[j]));
        return [d.id, { hash: hash(d.text), vec: vecs[j] }];
      });
      await saveCache(entries, []);
      state.indexed = i + batch.length;
      render(true);
    }
    state.semantic = 'ready';
  } catch (ex) {
    console.warn('semantic search unavailable', ex);
    state.semantic = 'off';
  }
  render(true);
}

// ---------- Search ----------
function currentParsed() {
  const p = parseQuery($('#search-input').value.trim());
  p.sources = [...p.sources, ...state.sourceFilter];
  return p;
}

async function runSearch(parsed) {
  const lex = lexicalSearch(state.index, parsed);
  const useSem = state.mode === 'smart' && state.semantic !== 'off' && state.vectors.size && parsed.terms.length;
  if (!useSem) return { hits: parsed.terms.length ? lex : byRecency(lex), fused: false };
  let qvec = state.qvecCache.get(parsed.topic);
  if (!qvec) {
    try { qvec = Float32Array.from((await embedder.embed([parsed.topic]))[0]); state.qvecCache.set(parsed.topic, qvec); }
    catch { return { hits: lex, fused: false }; }
  }
  const sem = semanticSearch(state.index, parsed, qvec, state.vectors, 0.32);
  return { hits: fuse(lex, sem), fused: true };
}

let timer;
$('#search-input').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => render(), 120); });
$('#mode-smart').addEventListener('click', () => setMode('smart'));
$('#mode-exact').addEventListener('click', () => setMode('exact'));
function setMode(m) {
  state.mode = m;
  $('#mode-smart').classList.toggle('active', m === 'smart');
  $('#mode-exact').classList.toggle('active', m === 'exact');
  render();
}

// ---------- Render ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

function highlight(text, terms) {
  const safe = esc(text);
  const words = terms.filter((t) => t.length > 1).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return safe;
  return safe.replace(new RegExp(`(${words.join('|')})`, 'gi'), '<mark>$1</mark>');
}

function setStatus(t) { $('#status').textContent = t; }

function semanticNote() {
  if (state.mode !== 'smart') return '';
  if (state.semantic === 'loading') return ` · preparing smart search${state.loadPct ? ` (${Math.round(state.loadPct)}%)` : ''}…`;
  if (state.semantic === 'indexing') return ` · learning your memories ${state.indexed}/${state.toIndex}…`;
  if (state.semantic === 'off') return ' · smart search unavailable, using exact';
  return '';
}

let renderSeq = 0;
async function render() {
  if (!state.index) return;
  const my = ++renderSeq;
  const q = $('#search-input').value.trim();
  const parsed = currentParsed();
  const hasQuery = q || state.sourceFilter.size;
  $('#search-shell').classList.toggle('has-results', !!hasQuery);

  let hits, fused = false;
  if (!hasQuery) {
    hits = byRecency(state.index.docs.map((doc) => ({ doc }))).slice(0, 25);
  } else {
    ({ hits, fused } = await runSearch(parsed));
    if (my !== renderSeq) return; // a newer keystroke superseded this one
  }

  const bits = [];
  if (!hasQuery) bits.push(`${state.index.docs.length} memories · newest first`);
  else {
    bits.push(`${hits.length} result${hits.length === 1 ? '' : 's'}`);
    if (parsed.rangeLabel) bits.push(parsed.rangeLabel);
    parsed.phrases.forEach((p) => bits.push(`“${p}”`));
    parsed.tags.forEach((t) => bits.push(`#${t}`));
    parsed.exclude.forEach((w) => bits.push(`not ${w}`));
  }
  setStatus(bits.join(' · ') + semanticNote());

  const container = $('#results');
  if (!hits.length) { container.innerHTML = `<div class="empty">Nothing matches that.</div>`; return; }
  const shown = hits.slice(0, 100);
  container.innerHTML = shown.map(({ doc, lex, sem }) => {
    const related = fused && sem && !lex ? '<span class="badge related" title="Matched by meaning, not wording">≈ related</span>' : '';
    const long = doc.text.length > 400 ? ' clamp' : '';
    return `<article class="card${long}" data-id="${doc.id}">
      <div class="text">${highlight(doc.text, parsed.terms)}</div>
      <div class="meta">${doc.source ? `<span class="badge">${esc(doc.source)}</span>` : ''}${related}<span class="date">${fmtDate(doc.created)}</span></div>
    </article>`;
  }).join('');
}

$('#results').addEventListener('click', (e) => {
  const card = e.target.closest('.card.clamp');
  if (card && !window.getSelection().toString()) card.classList.toggle('open');
});

function renderChips() {
  const sources = [...new Set(state.index.docs.map((d) => d.source).filter(Boolean))].sort();
  const box = $('#chips');
  box.innerHTML = sources.length > 1 ? sources.map((s) => `<button type="button" class="chip" data-s="${esc(s.toLowerCase())}">${esc(s)}</button>`).join('') : '';
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const s = b.dataset.s;
  state.sourceFilter.has(s) ? state.sourceFilter.delete(s) : state.sourceFilter.add(s);
  b.classList.toggle('active');
  render();
});

showLock();
