// Shared roadmaps: files on a network share, one editor at a time.
//
// The list of opened shared files is remembered in the workspace
// (settings.shared = [{path, name}]); the roadmaps themselves are loaded from
// the share on start and kept in state.shared (never written to workspace.json).

import { h, clone } from './util.js';
import { state, api, active, normalise, reidentify, emit, save, change, sharedMeta, findShared } from './store.js';
import { toast, confirmBox, askText, dialog } from './panels.js';

const POLL_MS = 10000;

function pathName(path) {
  return path.replace(/\\/g, '/').split('/').pop().replace(/\.roadmap\.json$/i, '').replace(/\.json$/i, '');
}

// install puts a roadmap loaded from the share into state.shared.
function install(r, existing) {
  // The engine returns the cleaned path, which can differ from what was typed:
  // match on it too, or the same file would open twice.
  existing = existing || findShared(r.path);
  const rm = normalise(r.roadmap);
  const meta = { path: r.path, rev: r.rev, savedBy: r.savedBy, savedAt: r.savedAt, lock: r.lock, me: r.me, notify: existing?._shared?.notify || false, dirty: false, error: '' };
  if (existing) { Object.keys(existing).forEach(k => delete existing[k]); Object.assign(existing, rm); existing._shared = meta; return existing; }
  rm._shared = meta;
  state.shared.push(rm);
  return rm;
}

function remember(path, name) {
  const list = state.ws.settings.shared ||= [];
  const known = list.find(x => x.path === path);
  if (known) { if (known.name !== name) { known.name = name; save(); } return; }
  list.push({ path, name }); save();
}

export const isReadOnly = rm => !!rm?._shared && !rm._shared.lock?.held;

// ---- opening --------------------------------------------------------------

export async function openShared(path, { edit = true, quiet = false } = {}) {
  const existing = findShared(path);
  try {
    const r = await api('POST', 'shared/open', { path, edit });
    const rm = install(r, existing);
    remember(r.path, rm.name);
    state.ws.activeId = rm.id; state.sel = null;
    if (!quiet) toast(r.lock.held ? `Opened "${rm.name}" - you are editing` : `Opened "${rm.name}" read-only - ${describeLock(r.lock)}`);
    save(); emit();
    return rm;
  } catch (e) {
    if (existing) { existing._shared.error = e.message; emit(); }
    else if (!quiet) toast('Could not open: ' + e.message, true);
    throw e;
  }
}

export async function openSharedDialog() {
  let path = '';
  if (state.info.native) {
    const r = await api('POST', 'shared/browse', { path: '', edit: false });
    if (!r.ok) return;
    path = r.path;
  } else {
    path = await askText('Open shared roadmap', '', 'Full path of the .roadmap.json file on the share');
    if (!path) return;
  }
  await openShared(path).catch(() => {});
}

// shareActive moves the active local roadmap onto the share.
export async function shareActive() {
  const rm = active();
  if (rm._shared) return toast('This roadmap is already shared');
  let path = '';
  if (state.info.native) {
    const r = await api('POST', 'shared/browse', { path: '', edit: true });
    if (!r.ok) return;
    path = r.path;
  } else {
    path = await askText('Save as shared roadmap', '', 'Full path for the new .roadmap.json file on the share');
    if (!path) return;
  }
  if (!(await confirmBox('Share this roadmap', `"${rm.name}" moves to the share and disappears from your local list. Everyone with access to the folder can open it; one person edits at a time. Your local version history is kept.`, 'Share'))) return;
  try {
    const r = await api('POST', 'shared/create', { path, roadmap: rm });
    const shared = install(r);
    remember(r.path, shared.name);
    state.ws.roadmaps.splice(state.ws.roadmaps.indexOf(rm), 1);
    state.ws.activeId = shared.id; state.sel = null;
    save(); emit();
    toast(`Shared as ${pathName(r.path)} - you are editing`);
  } catch (e) { toast('Could not share: ' + e.message, true); }
}

// reconnect opens every remembered shared file at start (read-only, so a
// restart never steals a lock from a colleague who took over meanwhile).
export async function reconnectAll() {
  const list = state.ws.settings.shared || [];
  for (const entry of list) {
    const stub = normalise({ id: 'shared-' + btoa(unescape(encodeURIComponent(entry.path))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40), name: entry.name, lanes: [] });
    stub._shared = { path: entry.path, lock: { free: true }, connecting: true, notify: false };
    state.shared.push(stub);
  }
  emit();
  for (const stub of [...state.shared]) {
    try {
      const r = await api('POST', 'shared/open', { path: stub._shared.path, edit: true });
      const keep = state.ws.activeId === stub.id;
      install(r, stub);
      if (keep) state.ws.activeId = stub.id;
    } catch (e) { stub._shared.connecting = false; stub._shared.error = e.message; }
    emit();
  }
}

// ---- lock actions ---------------------------------------------------------

export function describeLock(lock) {
  if (lock?.held) return 'you are editing';
  if (lock?.free) return 'nobody is editing';
  const o = lock?.owner || {};
  return `${o.user || 'someone'}${o.machine ? ' on ' + o.machine : ''} is editing${lock?.stale ? ' (no sign of life for over 2 minutes)' : ''}`;
}

export async function takeOver(rm) {
  const m = rm._shared;
  const r = await api('POST', 'shared/lock', { path: m.path, takeover: true });
  if (!r.lock.held) { m.lock = r.lock; emit(); return toast('Could not take over: ' + describeLock(r.lock), true); }
  if (r.rev !== m.rev) install({ ...r, path: m.path, me: m.me }, rm);   // pick up whatever was saved meanwhile
  m.lock = r.lock; m.notify = false;
  emit(); toast(`You are now editing "${rm.name}"`);
}

export async function releaseLock(rm) {
  const m = rm._shared;
  await flushShared(rm);
  await api('POST', 'shared/release', { path: m.path });
  m.lock = { free: true }; emit();
  toast(`Released "${rm.name}" - others can edit it now`);
}

export async function closeShared(rm) {
  const m = rm._shared;
  await flushShared(rm);
  await api('POST', 'shared/close', { path: m.path }).catch(() => {});
  state.shared.splice(state.shared.indexOf(rm), 1);
  state.ws.settings.shared = (state.ws.settings.shared || []).filter(x => x.path !== m.path);
  if (state.ws.activeId === rm.id) state.ws.activeId = (state.ws.roadmaps[0] || state.shared[0])?.id;
  state.sel = null; save(); emit();
}

export function keepLocalCopy(rm) {
  const copy = reidentify(normalise(clone(rm)));
  delete copy._shared;
  copy.name += ' (my copy)';
  change(() => { state.ws.roadmaps.push(copy); state.ws.activeId = copy.id; state.sel = null; });
  toast('Saved as a local copy');
}

// ---- saving ---------------------------------------------------------------

let saveTimers = new Map();

// scheduleSharedSave is called by store.save() for a dirty shared roadmap.
export function scheduleSharedSave(rm) {
  rm._shared.dirty = true;
  clearTimeout(saveTimers.get(rm.id));
  saveTimers.set(rm.id, setTimeout(() => flushShared(rm), 600));
}

export async function flushShared(rm) {
  const m = rm._shared;
  if (!m || !m.dirty || !m.lock?.held) return;
  clearTimeout(saveTimers.get(rm.id));
  const body = { ...rm }; delete body._shared;
  try {
    const r = await api('POST', 'shared/save', { path: m.path, rev: m.rev, roadmap: body });
    if (r.ok) { m.rev = r.rev; m.savedBy = r.savedBy; m.savedAt = r.savedAt; m.dirty = false; m.error = ''; }
    else if (r.reason === 'lock') { m.lock = r.lock; m.error = 'lost the lock'; emit(); conflictDialog(rm, 'Your editing lock was taken over by ' + (r.lock.owner?.user || 'someone else') + '.'); }
    else if (r.reason === 'conflict') { m.error = 'conflict'; emit(); conflictDialog(rm, `${r.savedBy || 'Someone'} saved a newer version (rev ${r.rev}) while you were editing.`); }
  } catch (e) { m.error = e.message; emit(); toast('Could not save to the share: ' + e.message, true); }
  emit('save');
}

async function conflictDialog(rm, why) {
  if (rm._shared.asking) return;
  rm._shared.asking = true;
  const v = await dialog('Cannot save to the share', h('div', {}, h('p', { text: why }),
    h('p', { text: 'Your unsaved changes are still here. Keep them as a local copy, or discard them and reload the shared version.' })),
    [{ label: 'Discard mine and reload', value: () => 'reload' }, { label: 'Keep mine as a local copy', cls: 'primary', value: () => 'copy' }]);
  rm._shared.asking = false;
  if (v === 'copy') keepLocalCopy(rm);
  rm._shared.dirty = false;
  await openShared(rm._shared.path, { edit: true, quiet: true }).catch(() => {});
}

// ---- polling --------------------------------------------------------------

async function poll() {
  for (const rm of [...state.shared]) {
    const m = rm._shared;
    if (!m || m.connecting || m.asking) continue;
    let r;
    try { r = await api('POST', 'shared/status', { path: m.path }); m.error = ''; }
    catch (e) { m.error = e.message; emit('save'); continue; }
    const wasHeld = m.lock?.held, wasFree = m.lock?.free || m.lock?.stale;
    m.lock = r.lock;
    if (wasHeld && !r.lock.held) {
      toast(`Your editing lock on "${rm.name}" was taken over${r.lock.owner?.user ? ' by ' + r.lock.owner.user : ''}`, true);
      if (m.dirty) conflictDialog(rm, 'Your editing lock was taken over while you had unsaved changes.');
    }
    if (!r.lock.held && r.rev !== m.rev && !m.dirty) {
      // Someone else saved: reload the read-only copy.
      try { const o = await api('POST', 'shared/open', { path: m.path, edit: false }); const keepSel = state.sel; install(o, rm); if (state.ws.activeId === rm.id) state.sel = keepSel; }
      catch { /* next poll */ }
    }
    if (!r.lock.held && (r.lock.free || r.lock.stale) && !wasFree && m.notify) {
      toast(`"${rm.name}" is free to edit now`);
    }
    if (!r.lock.held && r.lock.free && m.notify) { await takeOver(rm).catch(() => {}); }
  }
  emit('save');
}

export function startSharedPolling() { setInterval(() => poll().catch(() => {}), POLL_MS); }

window.addEventListener('beforeunload', () => { for (const rm of state.shared) if (rm._shared?.dirty) flushShared(rm); });
