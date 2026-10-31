// Edit operations - the browser half of ../ops.go, which documents the format.
//
// applyOps() must behave exactly like the server's: both are run against
// testdata/ops/cases.json. diff() turns "the document before" and "the
// document after" into the operations that make one into the other, so the
// rest of the UI can keep editing plain objects.

const CONTAINER = { lane: 'lanes', marker: 'markers', sub: 'subs', item: 'items' };
const PARENT_KIND = { lane: '', marker: '', sub: 'lane', item: 'sub' };
const CHILD = { lane: 'subs', sub: 'items' };
const PROTECTED = new Set(['id', 'lanes', 'markers', 'subs', 'items']);
const ROOT_FIELDS = ['name', 'start', 'end'];
// View settings that belong to one person rather than to the roadmap.
export const PERSONAL_VIEW = new Set(['zoom']);

const arr = (holder, field) => (Array.isArray(holder[field]) ? holder[field] : (holder[field] = []));

export function indexDoc(doc) {
  const ents = new Map();
  for (const m of arr(doc, 'markers')) if (m?.id) ents.set(m.id, { node: m, kind: 'marker', parent: '' });
  for (const lane of arr(doc, 'lanes')) {
    if (!lane?.id) continue;
    ents.set(lane.id, { node: lane, kind: 'lane', parent: '' });
    for (const sub of arr(lane, 'subs')) {
      if (!sub?.id) continue;
      ents.set(sub.id, { node: sub, kind: 'sub', parent: lane.id });
      for (const it of arr(sub, 'items')) if (it?.id) ents.set(it.id, { node: it, kind: 'item', parent: sub.id });
    }
  }
  return { root: doc, ents };
}

function holderOf(d, kind, parent) {
  const want = PARENT_KIND[kind];
  if (want === undefined) return null;
  if (want === '') return parent ? null : d.root;
  const p = d.ents.get(parent);
  return p && p.kind === want ? p.node : null;
}

function insertAfter(list, node, after) {
  let at = list.length;
  if (!after) at = 0;
  else { const i = list.findIndex(x => x?.id === after); if (i >= 0) at = i + 1; }
  list.splice(at, 0, node);
}

function detach(d, e, id) {
  const h = holderOf(d, e.kind, e.parent);
  if (!h) return;
  const list = arr(h, CONTAINER[e.kind]);
  const i = list.findIndex(x => x?.id === id);
  if (i >= 0) list.splice(i, 1);
}

function forget(d, id) {
  const e = d.ents.get(id);
  if (!e) return;
  d.ents.delete(id);
  const cf = CHILD[e.kind];
  if (cf) for (const c of arr(e.node, cf)) forget(d, c?.id);
}

function applyOne(d, o) {
  switch (o.t) {
    case 'root':
      for (const [k, v] of Object.entries(o.f || {})) {
        if (ROOT_FIELDS.includes(k)) d.root[k] = v;
        else if (k.startsWith('view.') && k.length > 5) (d.root.view ||= {})[k.slice(5)] = v;
      }
      return;
    case 'set': {
      const e = d.ents.get(o.id);
      if (!e) return;
      for (const [k, v] of Object.entries(o.f || {})) if (!PROTECTED.has(k)) e.node[k] = v;
      return;
    }
    case 'add': {
      if (d.ents.has(o.id)) return;
      const h = holderOf(d, o.kind, o.parent || '');
      if (!h) return;
      const node = {};
      for (const [k, v] of Object.entries(o.data || {})) if (!PROTECTED.has(k)) node[k] = v;
      node.id = o.id;
      if (CHILD[o.kind]) node[CHILD[o.kind]] = [];
      insertAfter(arr(h, CONTAINER[o.kind]), node, o.after || '');
      d.ents.set(o.id, { node, kind: o.kind, parent: o.parent || '' });
      return;
    }
    case 'move': {
      const e = d.ents.get(o.id);
      if (!e) return;
      const h = holderOf(d, e.kind, o.parent || '');
      if (!h || o.after === o.id) return;
      detach(d, e, o.id);
      insertAfter(arr(h, CONTAINER[e.kind]), e.node, o.after || '');
      e.parent = o.parent || '';
      return;
    }
    case 'del': {
      const e = d.ents.get(o.id);
      if (!e) return;
      detach(d, e, o.id);
      forget(d, o.id);
    }
  }
}

// applyOps changes doc in place, keeping every untouched object the same
// object - the UI holds references to them.
export function applyOps(doc, ops) {
  const d = indexDoc(doc);
  for (const o of ops) applyOne(d, o);
  return doc;
}

// ---- diff ------------------------------------------------------------------

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The fields an operation carries: everything except identity, structure,
// client-only state (_ prefix) and undefined.
function fieldsOf(node) {
  const out = {};
  for (const [k, v] of Object.entries(node)) if (!PROTECTED.has(k) && k[0] !== '_' && v !== undefined) out[k] = v;
  return out;
}

function flatten(doc) {
  const m = new Map();
  (doc.markers || []).forEach(x => x?.id && m.set(x.id, { node: x, kind: 'marker', parent: '' }));
  for (const lane of doc.lanes || []) {
    if (!lane?.id) continue;
    m.set(lane.id, { node: lane, kind: 'lane', parent: '' });
    for (const sub of lane.subs || []) {
      if (!sub?.id) continue;
      m.set(sub.id, { node: sub, kind: 'sub', parent: lane.id });
      for (const it of sub.items || []) if (it?.id) m.set(it.id, { node: it, kind: 'item', parent: sub.id });
    }
  }
  return m;
}

// The ids that kept their relative order: a longest common subsequence, so a
// single drag produces a single move rather than one per shifted sibling.
function stableIds(before, after) {
  const n = before.length, m = after.length;
  if (!n || !m) return new Set();
  if (n * m > 250000) {
    // Very long lists: keep whoever still follows the same sibling.
    const prevA = new Map(before.map((id, i) => [id, before[i - 1] ?? '']));
    return new Set(after.filter((id, i) => prevA.get(id) === (after[i - 1] ?? '')));
  }
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = before[i] === after[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (before[i] === after[j]) { keep.add(before[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return keep;
}

// diff returns operations that turn a into b. Neither is modified.
export function diff(a, b) {
  const ops = [];
  const rf = {};
  for (const k of ROOT_FIELDS) if (!same(a[k], b[k])) rf[k] = b[k] ?? null;
  const va = a.view || {}, vb = b.view || {};
  for (const k of new Set([...Object.keys(va), ...Object.keys(vb)]))
    if (!PERSONAL_VIEW.has(k) && !same(va[k], vb[k])) rf['view.' + k] = vb[k] ?? null;
  if (Object.keys(rf).length) ops.push({ t: 'root', f: rf });

  const A = flatten(a), B = flatten(b), sets = [];
  const siblings = (parent, kind, list) => {
    const before = [];
    const holderA = parent === '' ? a : A.get(parent)?.node;
    for (const x of (holderA && holderA[CONTAINER[kind]]) || []) {
      const e = x?.id && A.get(x.id);
      if (e && B.get(x.id)?.parent === parent) before.push(x.id);
    }
    const after = list.filter(x => x?.id && A.get(x.id)?.parent === parent).map(x => x.id);
    const keep = stableIds(before, after);
    let prev = '';
    for (const x of list) {
      if (!x?.id) continue;
      const old = A.get(x.id);
      if (!old) ops.push({ t: 'add', id: x.id, kind, parent, after: prev, data: fieldsOf(x) });
      else {
        if (old.parent !== parent || !keep.has(x.id)) ops.push({ t: 'move', id: x.id, parent, after: prev });
        const fa = fieldsOf(old.node), fb = fieldsOf(x), f = {};
        for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) if (!same(fa[k], fb[k])) f[k] = fb[k] ?? null;
        if (Object.keys(f).length) sets.push({ t: 'set', id: x.id, f });
      }
      prev = x.id;
    }
  };
  siblings('', 'marker', b.markers || []);
  siblings('', 'lane', b.lanes || []);
  for (const lane of b.lanes || []) {
    if (!lane?.id) continue;
    siblings(lane.id, 'sub', lane.subs || []);
    for (const sub of lane.subs || []) if (sub?.id) siblings(sub.id, 'item', sub.items || []);
  }
  ops.push(...sets);
  // Deletions last, so anything moved out of a deleted parent is safe first.
  // Only the topmost: deleting a lane takes its subs and items with it.
  for (const [id, e] of A) if (!B.has(id) && (e.parent === '' || B.has(e.parent))) ops.push({ t: 'del', id });
  return ops;
}
