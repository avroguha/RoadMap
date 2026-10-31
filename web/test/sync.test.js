// Several browsers editing one roadmap at once must end up identical to the
// server - whatever order their messages cross in. This drives SyncDoc with a
// simulated server and random interleavings of: local edits, edits in
// progress (drags, typing) while others' changes arrive, sends, and
// deliveries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../ui/ops.js';
import { SyncDoc } from '../ui/sync.js';
import { rng, randomEdit, seedDoc } from './helpers.js';

const clone = o => JSON.parse(JSON.stringify(o));
const comparable = o => JSON.parse(JSON.stringify(o, (k, v) => (v === null ? undefined : v)));

function simulate(seed, clients = 3, steps = 120) {
  const r = rng(seed);
  const server = { doc: seedDoc(), rev: 0, log: [] };
  const cs = Array.from({ length: clients }, () => ({
    sync: new SyncDoc(clone(server.doc), 0),
    sent: 0,          // pending batches already delivered to the server
    seen: 0,          // log entries delivered to this client
    editing: false,   // a drag / typing is in progress
  }));
  const serverApply = b => { applyOps(server.doc, b.ops); server.rev++; server.log.push({ rev: server.rev, batchId: b.id, ops: b.ops }); };
  // A client sends one batch at a time, in order (the real client does too).
  const unsent = c => c.sync.pending.slice(c.sent - (c.sync.pending.length ? 0 : 0));
  const sendOne = c => {
    const queue = c.sync.pending.filter(p => !p.delivered);
    if (!queue.length) return false;
    queue[0].delivered = true;
    serverApply(queue[0]);
    return true;
  };
  const deliverOne = c => {
    if (c.seen >= server.log.length) return false;
    c.sync.receive(server.log[c.seen++], c.editing);
    return true;
  };

  for (let s = 0; s < steps; s++) {
    const c = cs[Math.floor(r() * cs.length)];
    const roll = r();
    if (roll < 0.30) {                                   // edit, maybe left in progress
      randomEdit(c.sync.doc, r);
      if (r() < 0.4) c.editing = true; else { c.editing = false; c.sync.commit(); }
    } else if (roll < 0.40 && c.editing) {               // finish or abandon the edit
      c.editing = false;
      if (r() < 0.8) c.sync.commit(); else c.sync.abandon();
    } else if (roll < 0.70) sendOne(c);
    else deliverOne(c);
  }
  // Quiesce: finish every edit, send everything, deliver everything.
  for (const c of cs) if (c.editing) { c.editing = false; c.sync.commit(); }
  let moved = true;
  while (moved) {
    moved = false;
    for (const c of cs) while (sendOne(c)) moved = true;
    for (const c of cs) while (deliverOne(c)) moved = true;
  }
  return { server, cs };
}

test('three browsers editing at once converge on the server document (300 random runs)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { server, cs } = simulate(seed);
    cs.forEach((c, i) => {
      assert.equal(c.sync.pending.length, 0, `seed ${seed} client ${i}: unconfirmed batches left`);
      assert.equal(c.sync.rev, server.rev, `seed ${seed} client ${i}: rev`);
      assert.deepEqual(comparable(c.sync.doc), comparable(server.doc), `seed ${seed} client ${i}: page differs from the server`);
      assert.deepEqual(comparable(c.sync.base), comparable(server.doc), `seed ${seed} client ${i}: base differs from the server`);
    });
  }
});

test('my own change wins over an earlier concurrent change to the same field', () => {
  const doc = seedDoc();
  const a = new SyncDoc(clone(doc), 0), b = new SyncDoc(clone(doc), 0);
  a.doc.lanes[0].name = 'from A'; const ba = a.commit().batch;
  b.doc.lanes[0].name = 'from B'; const bb = b.commit().batch;
  // Server gets A first, then B: B's value is final everywhere.
  const log = [{ rev: 1, batchId: ba.id, ops: ba.ops }, { rev: 2, batchId: bb.id, ops: bb.ops }];
  b.receive(log[0]);
  assert.equal(b.doc.lanes[0].name, 'from B', 'B keeps its own pending value when A arrives');
  b.receive(log[1]);
  a.receive(log[0]); a.receive(log[1]);
  assert.equal(a.doc.lanes[0].name, 'from B');
  assert.equal(b.doc.lanes[0].name, 'from B');
});

test('something moved into a sub-swimlane I just deleted disappears for me too', () => {
  const doc = seedDoc();
  const me = new SyncDoc(clone(doc), 0), other = new SyncDoc(clone(doc), 0);
  me.doc.lanes[0].subs.splice(1, 1);                         // delete S12
  const mine = me.commit().batch;
  const it = other.doc.lanes[1].subs[0].items.shift();       // move i211 into S12
  other.doc.lanes[0].subs[1].items.push(it);
  const theirs = other.commit().batch;
  // The server took theirs first: the item went into S12, then S12 was deleted with it.
  me.receive({ rev: 1, batchId: theirs.id, ops: theirs.ops });
  me.receive({ rev: 2, batchId: mine.id, ops: mine.ops });
  const ids = JSON.stringify(me.doc);
  assert.ok(!ids.includes('"i211"'), 'the moved item went with the deleted sub-swimlane');
  assert.ok(!ids.includes('"S12"'));
});

test('a change arriving mid-drag is applied after the drag, without losing the drag', () => {
  const doc = seedDoc();
  const me = new SyncDoc(clone(doc), 0), other = new SyncDoc(clone(doc), 0);
  me.doc.lanes[0].subs[0].items[0].start = '2026-03-01';    // drag in progress
  other.doc.lanes[2].name = 'renamed elsewhere';
  const theirs = other.commit().batch;
  me.receive({ rev: 1, batchId: theirs.id, ops: theirs.ops }, true);
  assert.equal(me.doc.lanes[2].name, 'Lane 3', 'not applied mid-drag');
  const out = me.commit();
  assert.ok(out, 'the drag is sent');
  assert.equal(me.doc.lanes[0].subs[0].items[0].start, '2026-03-01');
  assert.equal(me.doc.lanes[2].name, 'renamed elsewhere', 'applied once the drag ended');
});

test('undo restores only what I changed', () => {
  const doc = seedDoc();
  const me = new SyncDoc(clone(doc), 0), other = new SyncDoc(clone(doc), 0);
  me.doc.lanes[0].subs[0].items[0].name = 'mine';
  const { batch, inverse } = me.commit();
  other.doc.lanes[0].subs[0].items[1].name = 'theirs';
  const theirs = other.commit().batch;
  me.receive({ rev: 1, batchId: batch.id, ops: batch.ops });
  me.receive({ rev: 2, batchId: theirs.id, ops: theirs.ops });
  applyOps(me.doc, inverse);
  me.commit();
  assert.equal(me.doc.lanes[0].subs[0].items[0].name, 'item', 'my change undone');
  assert.equal(me.doc.lanes[0].subs[0].items[1].name, 'theirs', 'their change kept');
});
