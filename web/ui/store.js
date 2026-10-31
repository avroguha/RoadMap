// Workspace state, the open roadmap, and undo.
//
// Roadmaps live on the server. The one open in this tab is kept in step by
// a SyncDoc (sync.js): every edit made through change()/commit() is turned
// into operations, sent, and merged with what everyone else is doing.
// Personal preferences (panels, theme, zoom per roadmap) are saved per
// person, never in the roadmap.

import { uid, clone, today, fromDay, toDay, dayOf, ymd, isDate, clamp } from './util.js';
import { applyOps } from './ops.js';
import { SyncDoc } from './sync.js';

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function api(method, path, body) {
  const opt = { method, headers: { 'X-RMS': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch('/api/' + path, opt); }
  catch { throw new ApiError('The server cannot be reached. Changes are kept and sent when it is back.', 0); }
  if (res.status === 401) { state.onSignedOut?.(); throw new ApiError('You are signed out.', 401); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(data?.error || text || res.statusText, res.status);
  return data;
}

export const state = {
  ws: null,            // { settings, roadmaps: [...], activeId }
  me: null,            // the signed-in person
  info: { native: false, browser: false, version: '', mode: 'web' },
  sync: null,          // SyncDoc of the open roadmap
  presence: [],        // who else has it open
  comments: [],        // comments on the open roadmap
  doing: '',           // what this person is doing, shown to colleagues
  cursor: null,        // this person's pointer on the timeline
  pres: null,          // while presenting: what the screen shows (sent with presence)
  presentMode: false,  // presenting or following: full screen, no chrome, no comments
  following: '',       // user id of the presenter this screen follows
  conn: '',            // this tab's live connection id
  online: false,       // the live connection is up
  sel: null,           // { type: 'item' | 'sub' | 'lane' | 'marker', id }
  showHidden: false,
  update: null,
  onReadOnly: null,    // called when an edit is refused because the roadmap is read-only
  onSignedOut: null,
  onCommit: null,      // called with each batch to send
  drag: null,
  saveState: 'saved',
};

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
export const emit = (what = 'all') => listeners.forEach(fn => fn(what));

// ---- model ----------------------------------------------------------------

export function newRoadmap(name = 'New roadmap') {
  const { y } = ymd(today());
  return {
    id: uid(), name,
    start: fromDay(dayOf(y, 0, 1)), end: fromDay(dayOf(y, 11, 31)),
    view: {
      top: 'year', bottom: 'quarter', fiscal: 0, zoom: 'fit', theme: 'office',
      density: 'cozy', layout: 'compact', labelPos: 'inside', barShape: 'rounded', barFill: 'solid',
      progress: 'fill', colorBy: 'lane', laneLabels: 'auto', subWidth: 150,
      showDeps: true, autoPush: false, priorityStyle: 'badge', placeholderStyle: 'hatch', showLegend: true, showPercent: true, showResources: true, showDates: false, showToday: true, showTitle: true, showStatusDot: true, showComments: true, showPriority: true, showStatus: false, showDuration: false, showNotes: false, showDepCount: false,
    },
    markers: [],
    lanes: [],
  };
}
export const newLane = (name = 'Swimlane') => ({ id: uid(), name, group: '', color: '', hidden: false, subs: [newSub('')] });
export const newMarker = (name, day) => ({ id: uid(), name, date: fromDay(day), color: '', line: 'solid', hidden: false });
export const newSub = (name = 'Sub-swimlane') => ({ id: uid(), name, color: '', hidden: false, items: [] });
export function newItem(type, startDay, endDay) {
  const base = { id: uid(), type, name: type === 'task' ? 'New task' : 'New milestone', progress: 0, status: 'none',
    resources: '', color: '', labelPos: '', hidden: false, notes: '', priority: '', placeholder: false, deps: [] };
  return type === 'task'
    ? { ...base, start: fromDay(startDay), end: fromDay(endDay) }
    : { ...base, date: fromDay(startDay), shape: 'diamond' };
}

export function sampleRoadmap() {
  const rm = newRoadmap('Product roadmap');
  const { y } = ymd(today());
  const d = (m, day) => fromDay(dayOf(y, m - 1, day));
  const task = (name, a, b, progress, status, resources, extra = {}) =>
    ({ ...newItem('task', toDay(a), toDay(b)), name, progress, status, resources, ...extra });
  const ms = (name, a, shape = 'diamond', extra = {}) => ({ ...newItem('milestone', toDay(a)), name, shape, ...extra });
  const lane = (name, subs) => ({ ...newLane(name), subs: subs.map(([n, items]) => ({ ...newSub(n), items })) });
  rm.lanes = [
    lane('Platform', [
      ['Core services', [
        task('API gateway v2', d(1, 12), d(3, 28), 100, 'done', '2 Backend, 1 DevOps'),
        task('Event streaming', d(4, 6), d(7, 17), 55, 'ontrack', '3 Backend'),
        task('Multi-region failover', d(8, 3), d(11, 20), 0, 'planned', '2 Backend, 2 DevOps'),
      ]],
      ['Data', [
        task('Warehouse migration', d(2, 2), d(5, 29), 80, 'atrisk', '2 Data Eng'),
        task('Self-serve analytics', d(6, 15), d(10, 9), 20, 'ontrack', '1 Data Eng, 1 Analyst'),
        ms('Legacy DB retired', d(6, 5), 'flag'),
      ]],
    ]),
    lane('Product', [
      ['Web app', [
        task('Onboarding redesign', d(1, 19), d(4, 10), 100, 'done', '1 Design, 2 Frontend'),
        task('Collaboration features', d(4, 20), d(8, 28), 45, 'ontrack', '3 Frontend, 1 Backend'),
        task('Accessibility AA', d(9, 7), d(12, 11), 0, 'planned', '1 Design, 1 Frontend'),
      ]],
      ['Mobile', [
        task('iOS beta', d(3, 2), d(6, 26), 70, 'delayed', '2 Mobile'),
        task('Android parity', d(7, 6), d(11, 6), 10, 'ontrack', '2 Mobile, 1 QA'),
        ms('App Store launch', d(7, 1), 'star'),
      ]],
    ]),
    lane('Go-to-market', [
      ['', [
        task('Pricing research', d(2, 9), d(4, 3), 100, 'done', '1 PMM'),
        task('Launch campaign', d(5, 11), d(7, 31), 35, 'atrisk', '2 Marketing, 1 Design'),
        ms('Public launch', d(8, 12), 'diamond'),
        task('Partner programme', d(8, 24), d(12, 4), 0, 'planned', '1 BD, 1 PMM'),
      ]],
    ]),
  ];
  eachItem(rm, it => { if (['Multi-region failover', 'Partner programme'].includes(it.name)) it.placeholder = true; });
  rm.lanes[0].group = rm.lanes[1].group = 'Build';
  rm.lanes[2].group = 'Launch';
  rm.markers = [{ ...newMarker('UAT release', toDay(d(6, 22))), color: '#8e5bd9' }, { ...newMarker('Prod release', toDay(d(8, 10))), color: '#d92d3a' }, { ...newMarker('Code freeze', toDay(d(11, 27))), line: 'dashed' }];
  for (const [name, p] of [['Event streaming', 'critical'], ['Warehouse migration', 'high'], ['Collaboration features', 'high'], ['iOS beta', 'critical'],
    ['Launch campaign', 'medium'], ['Accessibility AA', 'low'], ['Public launch', 'critical']]) { let hit; eachItem(rm, it => { if (it.name === name) hit = it; }); hit.priority = p; }
  // A few links so a new user sees what dependencies look like.
  const byName = new Map(); eachItem(rm, it => byName.set(it.name, it));
  for (const [pred, succ] of [['API gateway v2', 'Event streaming'], ['Event streaming', 'Multi-region failover'], ['Warehouse migration', 'Legacy DB retired'],
    ['iOS beta', 'App Store launch'], ['Launch campaign', 'Public launch'], ['Public launch', 'Partner programme']])
    byName.get(succ).deps.push({ id: byName.get(pred).id, type: 'FS' });
  return rm;
}

export const allRoadmaps = () => state.ws.roadmaps;
export const active = () => state.ws.roadmaps.find(r => r.id === state.ws.activeId) || state.ws.roadmaps[0] || EMPTY;
const EMPTY = { id: '', name: '', lanes: [], markers: [], view: {}, start: '2026-01-01', end: '2026-12-31', _meta: { role: '', loaded: false } };
export const meta = rm => rm?._meta || {};
// Nothing can be changed on a roadmap that is still loading, or for a viewer.
export const isReadOnly = (rm = active()) => !meta(rm).loaded || !['owner', 'editor'].includes(meta(rm).role);
export const isShared = (rm = active()) => (meta(rm).members || 0) > 0 || meta(rm).role !== 'owner' || !!meta(rm).everyone;
// canComment: may add comments (editors and owners can too).
export const canComment = (rm = active()) => meta(rm).loaded && ['owner', 'editor', 'commenter'].includes(meta(rm).role);

export function find(id, rm = active()) {
  for (const marker of rm.markers || []) if (marker.id === id) return { type: 'marker', marker, obj: marker };
  for (const lane of rm.lanes) {
    if (lane.id === id) return { type: 'lane', lane, obj: lane };
    for (const sub of lane.subs) {
      if (sub.id === id) return { type: 'sub', lane, sub, obj: sub };
      for (const item of sub.items) if (item.id === id) return { type: 'item', lane, sub, item, obj: item };
    }
  }
  return null;
}
export const selected = () => (state.sel ? find(state.sel.id) : null);

export function eachItem(rm, fn) {
  rm.lanes.forEach((lane, li) => lane.subs.forEach((sub, si) => sub.items.forEach(item => fn(item, sub, lane, li, si))));
}
export const itemStart = it => toDay(it.type === 'task' ? it.start : it.date);
export const itemEnd = it => toDay(it.type === 'task' ? it.end : it.date);

// normalise repairs anything an import or an older version may have left out.
export function normalise(rm) {
  const base = newRoadmap(rm.name || 'Roadmap');
  rm.id = /^[a-zA-Z0-9_-]{1,64}$/.test(rm.id || '') ? rm.id : uid();
  rm.name = String(rm.name || 'Roadmap');
  if (!isDate(rm.start)) rm.start = base.start;
  if (!isDate(rm.end) || toDay(rm.end) <= toDay(rm.start)) rm.end = fromDay(toDay(rm.start) + 364);
  rm.view = { ...base.view, ...(rm.view || {}) };
  rm.markers = (Array.isArray(rm.markers) ? rm.markers : []).filter(m => m && typeof m === 'object');
  for (const m of rm.markers) { m.id ||= uid(); m.name = String(m.name ?? ''); if (!isDate(m.date)) m.date = rm.start; m.color ||= ''; m.line = m.line === 'dashed' ? 'dashed' : 'solid'; m.hidden = !!m.hidden; }
  rm.lanes = Array.isArray(rm.lanes) ? rm.lanes : [];
  for (const lane of rm.lanes) {
    lane.group = String(lane.group ?? '').trim();
    lane.id ||= uid(); lane.name = String(lane.name ?? ''); lane.color ||= ''; lane.hidden = !!lane.hidden;
    lane.subs = Array.isArray(lane.subs) ? lane.subs : [];
    for (const sub of lane.subs) {
      sub.id ||= uid(); sub.name = String(sub.name ?? ''); sub.color ||= ''; sub.hidden = !!sub.hidden;
      sub.items = (Array.isArray(sub.items) ? sub.items : []).filter(it => it && typeof it === 'object');
      for (const it of sub.items) {
        it.id ||= uid(); it.type = it.type === 'milestone' ? 'milestone' : 'task';
        it.name = String(it.name ?? ''); it.progress = clamp(+it.progress || 0, 0, 100);
        it.status ||= 'none'; it.resources = String(it.resources ?? ''); it.color ||= ''; it.labelPos ||= '';
        it.hidden = !!it.hidden; it.notes = String(it.notes ?? ''); it.placeholder = !!it.placeholder;
        it.priority = ['critical', 'high', 'medium', 'low'].includes(it.priority) ? it.priority : '';
        it.deps = (Array.isArray(it.deps) ? it.deps : []).filter(d => d && d.id).map(d => ({ id: String(d.id), type: DEP_TYPES.some(t => t[0] === d.type) ? d.type : 'FS' }));
        if (it.type === 'task') {
          if (!isDate(it.start)) it.start = rm.start;
          if (!isDate(it.end) || toDay(it.end) < toDay(it.start)) it.end = it.start;
        } else {
          if (!isDate(it.date)) it.date = isDate(it.start) ? it.start : rm.start;
          it.shape ||= 'diamond';
        }
      }
    }
  }
  // Drop links to items that no longer exist.
  const ids = new Set(); eachItem(rm, it => ids.add(it.id));
  eachItem(rm, it => { it.deps = it.deps.filter(d => ids.has(d.id) && d.id !== it.id); });
  return rm;
}

// reidentify gives a copied or imported roadmap fresh ids throughout.
export function reidentify(rm) {
  rm.id = uid();
  for (const m of rm.markers || []) m.id = uid();
  const map = new Map();
  for (const lane of rm.lanes) { lane.id = uid(); for (const sub of lane.subs) { sub.id = uid(); for (const it of sub.items) { const id = uid(); map.set(it.id, id); it.id = id; } } }
  eachItem(rm, it => { it.deps = (it.deps || []).filter(d => map.has(d.id)).map(d => ({ ...d, id: map.get(d.id) })); });
  return rm;
}

// ---- dependencies ---------------------------------------------------------

// A link lives on the dependent item: { id: predecessor, type }.
export const DEP_TYPES = [['FS', 'Finish → Start'], ['SS', 'Start → Start'], ['FF', 'Finish → Finish']];

// gap > 0 means the dependent item starts (or ends) too early by that many days.
export function depGap(pred, succ, type) {
  if (type === 'SS') return itemStart(pred) - itemStart(succ);
  if (type === 'FF') return itemEnd(pred) - itemEnd(succ);
  return itemEnd(pred) + (pred.type === 'task' ? 1 : 0) - itemStart(succ);
}

function dependsOn(rm, fromId, targetId, seen = new Set()) {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  return (find(fromId, rm)?.item?.deps || []).some(d => dependsOn(rm, d.id, targetId, seen));
}

// addDep makes `succId` depend on `predId`. Returns an error text or ''.
export function addDep(predId, succId, type = 'FS') {
  const rm = active(), succ = find(succId, rm)?.item, pred = find(predId, rm)?.item;
  if (!succ || !pred || predId === succId) return 'Pick two different items';
  if (succ.deps.some(d => d.id === predId)) return 'These two are already linked';
  if (dependsOn(rm, predId, succId)) return 'That link would create a loop';
  change(() => { succ.deps.push({ id: predId, type }); });
  return '';
}
export function removeDep(predId, succId) {
  change(() => { const it = find(succId)?.item; if (it) it.deps = it.deps.filter(d => d.id !== predId); });
}
export function countConflicts(rm = active()) {
  let n = 0;
  eachItem(rm, it => { for (const d of it.deps) { const p = find(d.id, rm)?.item; if (p && depGap(p, it, d.type) > 0) n++; } });
  return n;
}

// pushDependents moves dependent items later until every link is satisfied.
export function pushDependents(rm) {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    eachItem(rm, it => {
      for (const d of it.deps) {
        const p = find(d.id, rm)?.item; if (!p) continue;
        const gap = depGap(p, it, d.type);
        if (gap <= 0) continue;
        for (const key of it.type === 'task' ? ['start', 'end'] : ['date']) it[key] = fromDay(toDay(it[key]) + gap);
        moved = true;
      }
    });
    if (!moved) return;
  }
}

// ---- loading and saving -----------------------------------------------------

const DEFAULT_SETTINGS = { appTheme: 'light', outline: true, inspector: true, insights: true, zoom: {} };

function stub(r) {
  return { id: r.id, name: r.name, start: '2026-01-01', end: '2026-12-31', view: {}, lanes: [], markers: [],
    _meta: { role: r.role, owner: r.owner, members: r.members, updatedAt: r.updatedAt, everyone: r.everyone || '', via: r.via || '', loaded: false } };
}

export async function load() {
  const me = await api('GET', 'me');
  state.me = me.user;
  state.info = { ...state.info, version: me.version, authMode: me.authMode };
  const settings = { ...DEFAULT_SETTINGS, ...(me.settings || {}) };
  settings.zoom ||= {};
  state.ws = { settings, roadmaps: [], activeId: settings.activeId || '' };
  await refreshList();
}

// refreshList reloads the list of roadmaps, keeping the loaded one as it is.
export async function refreshList() {
  const list = await api('GET', 'roadmaps');
  const old = new Map(state.ws.roadmaps.map(r => [r.id, r]));
  state.ws.roadmaps = list.map(r => {
    const cur = old.get(r.id);
    if (cur) { cur.name = r.name; Object.assign(cur._meta, { role: r.role, owner: r.owner, members: r.members, updatedAt: r.updatedAt, everyone: r.everyone || '', via: r.via || '' }); return cur; }
    return stub(r);
  });
  if (!state.ws.roadmaps.some(r => r.id === state.ws.activeId)) state.ws.activeId = state.ws.roadmaps[0]?.id || '';
}

// adopt fills the roadmap object in place with the server's document.
export function adopt(rm, doc, rev, role, members, everyone = '') {
  const m = rm._meta;
  for (const k of Object.keys(rm)) if (k !== '_meta') delete rm[k];
  Object.assign(rm, normalise(doc));
  rm.view.zoom = state.ws.settings.zoom?.[rm.id] ?? 'fit';
  Object.assign(m, { role, loaded: true, members: Math.max(0, (members?.length || 1) - 1), people: members || [], everyone: everyone || '' });
  state.sync = new SyncDoc(rm, rev);
}

let saveTimer = 0;
// save keeps this person's preferences; roadmaps are saved by their edits.
export function save(now = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    const st = state.ws.settings, rm = active();
    if (rm.id && meta(rm).loaded) (st.zoom ||= {})[rm.id] = rm.view.zoom;
    st.activeId = state.ws.activeId;
    try { await api('PUT', 'me/settings', st); } catch (e) { console.warn('settings not saved', e); }
  };
  if (now) return run();
  saveTimer = setTimeout(run, 600);
}

export const snapshot = (label = '', rm = active()) => api('POST', `roadmaps/${rm.id}/versions`, { label });

// ---- undo / redo ----------------------------------------------------------
//
// Undo replays the inverse of YOUR last edit as a new edit, so it never
// reverts what someone else changed in the meantime.

const undoStacks = new Map();
const stacks = (rid = active().id) => { let s = undoStacks.get(rid); if (!s) undoStacks.set(rid, (s = { undo: [], redo: [] })); return s; };
const LIMIT = 200;
let pending = null, replaying = null;

// begin/commit bracket a drag or a typed edit; change() wraps a single edit.
export const begin = () => { if (!pending) pending = { rid: active().id }; };
export const editing = () => !!pending;

export function commit() {
  if (pending == null) return;
  const rid = pending.rid;
  pending = null;
  const rm = active(), sync = state.sync;
  if (!sync || rm.id !== rid || sync.doc !== rm) { emit(); return; }
  if (isReadOnly(rm)) {
    const before = JSON.stringify(rm.lanes) + JSON.stringify(rm.markers);
    sync.abandon();
    if (before !== JSON.stringify(rm.lanes) + JSON.stringify(rm.markers)) state.onReadOnly?.(rm);
    emit();
    return;
  }
  if (rm.view.autoPush) pushDependents(rm);
  const res = sync.commit();
  if (res) {
    const st = stacks(rid);
    const entry = { ops: res.inverse };
    if (replaying === 'undo') st.redo.push(entry);
    else if (replaying === 'redo') st.undo.push(entry);
    else { st.undo.push(entry); st.redo.length = 0; }
    if (st.undo.length > LIMIT) st.undo.shift();
    state.onCommit?.(res.batch);
  }
  if ((state.ws.settings.zoom || {})[rm.id] !== rm.view.zoom) save();
  emit();
}
export const cancel = () => { if (pending) { pending = null; state.sync?.abandon(); emit(); } };
export function change(fn) { begin(); fn(); commit(); }

export const canUndo = () => !isReadOnly() && stacks().undo.length > 0;
export const canRedo = () => !isReadOnly() && stacks().redo.length > 0;
function replay(kind) {
  const st = stacks(), e = (kind === 'undo' ? st.undo : st.redo).pop();
  if (!e || isReadOnly()) return;
  replaying = kind;
  try { change(() => applyOps(active(), e.ops)); } finally { replaying = null; }
}
export const undo = () => replay('undo');
export const redo = () => replay('redo');

export function select(sel) { state.sel = sel; emit('select'); }

// ---- edits shared by the panels and the timeline ---------------------------

export function addLane() {
  change(() => { const lane = newLane('New swimlane'); const f = selected(); if (f?.lane) lane.group = f.lane.group; active().lanes.push(lane); state.sel = { type: 'lane', id: lane.id }; });
}
export function addMarker(day) {
  change(() => { const rm = active(), a = toDay(rm.start), b = toDay(rm.end); const m = newMarker('Key date', day ?? clamp(today(), a, b)); rm.markers.push(m); state.sel = { type: 'marker', id: m.id }; });
}
// renameGroup renames an initiative everywhere; an empty name removes the grouping.
export function renameGroup(from, to) { change(() => { for (const lane of active().lanes) if (lane.group === from) lane.group = to.trim(); }); }
export function addSub(laneId) {
  change(() => { const f = find(laneId); if (!f) return; const sub = newSub('New sub-swimlane'); f.lane.subs.push(sub); state.sel = { type: 'sub', id: sub.id }; });
}
export function targetSub() {
  const f = selected(), rm = active();
  if (f?.sub) return f.sub;
  const lane = f?.lane || rm.lanes[0] || (rm.lanes.push(newLane('Swimlane')), rm.lanes[0]);
  if (!lane.subs.length) lane.subs.push(newSub(''));
  return lane.subs[0];
}
export function addItem(type, subId, startDay) {
  change(() => {
    const rm = active(), a = toDay(rm.start), b = toDay(rm.end);
    const sub = subId ? find(subId)?.sub : targetSub();
    if (!sub) return;
    const len = Math.max(7, Math.round((b - a) / 8));
    const s0 = startDay ?? clamp(today(), a, Math.max(a, b - len));
    const it = newItem(type, s0, s0 + len - 1);
    sub.items.push(it);
    state.sel = { type: 'item', id: it.id };
  });
}
export function removeSelected() {
  const f = selected(); if (!f) return;
  change(() => {
    const rm = active();
    if (f.type === 'marker') rm.markers.splice(rm.markers.indexOf(f.marker), 1);
    else if (f.type === 'item') f.sub.items.splice(f.sub.items.indexOf(f.item), 1);
    else if (f.type === 'sub') { f.lane.subs.splice(f.lane.subs.indexOf(f.sub), 1); if (!f.lane.subs.length) f.lane.subs.push(newSub('')); }
    else rm.lanes.splice(rm.lanes.indexOf(f.lane), 1);
    const ids = new Set(); eachItem(rm, it => ids.add(it.id));
    eachItem(rm, it => { it.deps = it.deps.filter(d => ids.has(d.id)); });
    state.sel = null;
  });
}
export function duplicateSelected() {
  const f = selected(); if (!f) return;
  change(() => {
    const copy = clone(f.obj);
    copy.id = uid();
    if (f.type === 'marker') { copy.name += ' (copy)'; copy.date = fromDay(toDay(copy.date) + 14); active().markers.push(copy); }
    else if (f.type === 'item') { copy.name += ' (copy)'; f.sub.items.push(copy); }
    else if (f.type === 'sub') { copy.items.forEach(i => (i.id = uid())); f.lane.subs.splice(f.lane.subs.indexOf(f.sub) + 1, 0, copy); }
    else { copy.subs.forEach(sb => { sb.id = uid(); sb.items.forEach(i => (i.id = uid())); }); const rm = active(); rm.lanes.splice(rm.lanes.indexOf(f.lane) + 1, 0, copy); }
    state.sel = { type: f.type, id: copy.id };
  });
}
export function toggleHidden(id) { change(() => { const f = find(id); if (f) f.obj.hidden = !f.obj.hidden; }); }

// move relocates a lane, sub or item. before = id of the sibling to land in
// front of (null = append); parentId = destination lane (for subs) or sub (for items).
export function move(id, parentId, before) {
  change(() => {
    const rm = active(), f = find(id); if (!f) return;
    if (f.type === 'lane') {
      rm.lanes.splice(rm.lanes.indexOf(f.lane), 1);
      const i = before ? rm.lanes.findIndex(l => l.id === before) : -1;
      const at = i < 0 ? rm.lanes.length : i;
      rm.lanes.splice(at, 0, f.lane);
      const prev = rm.lanes[at - 1], next = rm.lanes[at + 1];
      if (prev && next && prev.group === next.group) f.lane.group = prev.group;       // dropped inside an initiative
      else if (![prev?.group, next?.group].includes(f.lane.group)) f.lane.group = (next ?? prev)?.group ?? f.lane.group;
    } else if (f.type === 'sub') {
      const dest = find(parentId)?.lane; if (!dest) return;
      f.lane.subs.splice(f.lane.subs.indexOf(f.sub), 1);
      const i = before ? dest.subs.findIndex(x => x.id === before) : -1;
      dest.subs.splice(i < 0 ? dest.subs.length : i, 0, f.sub);
      if (!f.lane.subs.length) f.lane.subs.push(newSub(''));
    } else {
      const dest = find(parentId)?.sub; if (!dest) return;
      f.sub.items.splice(f.sub.items.indexOf(f.item), 1);
      const i = before ? dest.items.findIndex(x => x.id === before) : -1;
      dest.items.splice(i < 0 ? dest.items.length : i, 0, f.item);
    }
  });
}
