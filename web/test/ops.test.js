// node --test test/   (Node 22+, no packages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOps, diff, indexDoc } from '../ui/ops.js';
import { rng, randomEdit, seedDoc } from './helpers.js';

const clone = o => JSON.parse(JSON.stringify(o));
const file = JSON.parse(readFileSync(new URL('../testdata/ops/cases.json', import.meta.url)));

function shape(doc) {
  const lanes = (doc.lanes || []).map(l => `${l.id}[${(l.subs || []).map(s => `${s.id}(${(s.items || []).map(i => i.id).join(',')})`).join(',')}]`);
  return lanes.join(',') + '|' + (doc.markers || []).map(m => m.id).join(',');
}

// Same cases as the server's ops_test.go.
for (const c of file.cases) {
  test(`shared case: ${c.name}`, () => {
    const doc = clone(file.doc);
    applyOps(doc, c.ops);
    assert.equal(shape(doc), c.shape);
    const d = indexDoc(doc);
    for (const [id, field, want] of c.checks) {
      const node = id === '' ? doc : d.ents.get(id)?.node;
      if (field === '') { assert.equal(!!node, want !== null, `${id} exists`); continue; }
      assert.ok(node, `${id} missing`);
      const got = field.startsWith('view.') ? node.view[field.slice(5)] : node[field];
      assert.deepEqual(got ?? null, want, `${id}.${field}`);
    }
  });
}

test('applyOps keeps untouched objects the same objects', () => {
  const doc = clone(file.doc);
  const i3 = doc.lanes[0].subs[0].items[2], lane2 = doc.lanes[1];
  applyOps(doc, [{ t: 'move', id: 'i1', parent: 'S2', after: '' }, { t: 'set', id: 'i3', f: { name: 'C2' } }]);
  assert.equal(doc.lanes[0].subs[0].items[1], i3);
  assert.equal(i3.name, 'C2');
  assert.equal(doc.lanes[1], lane2);
});

// ---- diff: random edits, then diff + apply must reproduce them exactly ------

// diff emits null for a removed field; the two documents are otherwise equal.
const comparable = o => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v)));

test('diff + applyOps reproduces 500 random edit sequences exactly', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed), a = seedDoc(), b = clone(a);
    const n = 1 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) randomEdit(b, r);
    const ops = diff(a, b);
    const c = clone(a);
    applyOps(c, ops);
    assert.deepEqual(comparable(c), comparable(b), `seed ${seed}: ${JSON.stringify(ops)}`);
  }
});

test('one drag produces one move, not one per shifted sibling', () => {
  const a = seedDoc(), b = clone(a);
  const [it] = b.lanes[0].subs[0].items.splice(0, 1);
  b.lanes[0].subs[0].items.push(it);
  const ops = diff(a, b);
  assert.deepEqual(ops, [{ t: 'move', id: 'i111', parent: 'S11', after: 'i113' }]);
});

test('zoom is personal and never sent', () => {
  const a = seedDoc(), b = clone(a);
  b.view.zoom = 7;
  assert.deepEqual(diff(a, b), []);
});
