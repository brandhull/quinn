import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, decorate, buildIndex, lexicalSearch, fuse, stem, editDistance } from '../public/search.js';

const NOW = new Date(2026, 9, 23); // Oct 23 2026
const rows = [
  { id: 1, Text: 'Onboarding takes 14 days on average #metrics', Created: '2026-10-05T10:00:00Z', Source: { value: 'Arthur' } },
  { id: 2, Text: 'Podcast guest suggested using retrospectives monthly', Created: '2026-09-12T10:00:00Z', Source: { value: 'Relay' } },
  { id: 3, Text: 'Renewal rate target is 92%', Created: '2025-03-01T10:00:00Z', Source: { value: 'Arthur' } },
];
const idx = buildIndex(rows.map(decorate));
const run = (q) => lexicalSearch(idx, parseQuery(q, NOW)).map((r) => r.doc.id);

test('stem + edit distance', () => {
  assert.equal(stem('retrospectives'), 'retrospective');
  assert.equal(editDistance('onbaording', 'onboarding', 2) <= 2, true);
});
test('keyword + stemming', () => assert.deepEqual(run('retrospective'), [2]));
test('prefix', () => assert.deepEqual(run('onboard'), [1]));
test('typo tolerance', () => assert.deepEqual(run('onbaording'), [1]));
test('source filter', () => assert.deepEqual(run('source:relay'), [2]));
test('tag filter', () => assert.deepEqual(run('#metrics'), [1]));
test('date: last month', () => assert.deepEqual(run('last month'), [2]));
test('date: year', () => assert.deepEqual(run('renewal in 2025'), [3]));
test('phrase and exclude', () => {
  assert.deepEqual(run('"14 days"'), [1]);
  assert.deepEqual(run('rate -renewal'), []);
});
test('fusion boosts docs found by both', () => {
  const a = [{ doc: { id: 1 } }, { doc: { id: 2 } }];
  const b = [{ doc: { id: 2 } }, { doc: { id: 3 } }];
  assert.equal(fuse(a, b)[0].doc.id, 2);
});
