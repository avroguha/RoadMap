// Keeping one open roadmap in step with the server and everyone else on it.
//
// Three copies of the roadmap:
//   base     what the server has confirmed, up to `rev`
//   pending  batches this browser has sent and the server has not echoed yet
//   doc      what the person sees: base + pending + whatever they are doing now
//
// The server applies batches in arrival order. When someone else's batch
// arrives it was applied BEFORE our pending ones (otherwise ours would have
// been echoed first), so the server will end up with base + theirs + ours.
// We do exactly that - apply theirs to base, replay our pending on top - and
// then patch `doc` to match, in place. Every browser therefore converges on the
// server's document, whatever the interleaving. Nothing here touches the
// network or the page, so test/sync.test.js can drive it directly.

import { applyOps, diff } from './ops.js';

const clone = o => JSON.parse(JSON.stringify(o));
// The parts of a roadmap object the server knows about (client state lives
// under keys starting with "_").
function plain(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (k[0] !== '_') out[k] = v;
  return clone(out);
}

let counter = 0;
const batchId = () => Date.now().toString(36) + '-' + (++counter).toString(36) + '-' + Math.random().toString(36).slice(2, 8);

export class SyncDoc {
  constructor(doc, rev) {
    this.doc = doc;
    this.base = plain(doc);
    this.shadow = plain(doc);   // base + pending: what the next diff starts from
    this.rev = rev;
    this.pending = [];          // [{id, ops}] in the order sent
    this.stale = false;         // base moved while the person was mid-edit
  }

  // The person finished an edit. Returns {batch, inverse} to send and to
  // undo with, or null when nothing changed.
  commit() {
    const now = plain(this.doc);
    const ops = diff(this.shadow, now);
    let result = null;
    if (ops.length) {
      const batch = { id: batchId(), ops };
      result = { batch, inverse: diff(now, this.shadow) };
      this.pending.push(batch);
      this.shadow = now;
    }
    // Someone else's batches arrived during the edit: replay ours on top now.
    if (this.stale) this.reconcile();
    return result;
  }

  // The person abandoned an edit (Esc during a drag): back to shadow, then
  // catch up with anything that arrived meanwhile.
  abandon() {
    const fix = diff(plain(this.doc), this.shadow);
    if (fix.length) applyOps(this.doc, fix);
    if (this.stale) this.reconcile();
  }

  // A batch from the server, in rev order. While the person is mid-edit
  // (dragging, typing) the page is left alone and patched afterwards.
  // Returns 'old' (already had it), 'ours' (our own echo) or 'theirs'.
  receive(ev, editing = false) {
    if (ev.rev <= this.rev) return 'old';
    this.rev = ev.rev;
    applyOps(this.base, ev.ops);
    if (this.pending.length && this.pending[0].id === ev.batchId) {
      this.pending.shift();
      return 'ours';
    }
    // Ours but out of order would mean the server reordered our sends; we
    // send one at a time, so treat it as theirs and let replay sort it out.
    const at = this.pending.findIndex(p => p.id === ev.batchId);
    if (at > 0) this.pending.splice(at, 1);
    if (editing) this.stale = true;
    else this.reconcile();
    return 'theirs';
  }

  // Make shadow = base + pending, and patch the page's copy to match without
  // losing what the person has typed or dragged but not committed: their
  // uncommitted changes are re-applied on top.
  reconcile() {
    this.stale = false;
    const local = diff(this.shadow, plain(this.doc));        // edits not committed yet
    const target = clone(this.base);
    for (const p of this.pending) applyOps(target, p.ops);
    this.shadow = clone(target);
    applyOps(target, local);
    const fix = diff(plain(this.doc), target);
    if (fix.length) applyOps(this.doc, fix);
    return fix.length > 0;
  }

  // The server accepted a batch as `rev`. Normally its echo confirms it; but
  // a batch resent after a reconnect that the server had already applied is
  // not echoed again - if we already hold that rev, it is confirmed now.
  confirm(batchId, rev) {
    const at = this.pending.findIndex(p => p.id === batchId);
    if (at < 0 || rev > this.rev) return false;
    this.pending.splice(at, 1);
    this.reconcile();
    return true;
  }

  // The server's full document (first load, or after a gap we cannot replay):
  // keep our pending batches and resend them.
  reset(serverDoc, rev) {
    this.base = plain(serverDoc);
    this.rev = rev;
    this.reconcile();
  }
}
