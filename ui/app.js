// Bootstrap: load the workspace, mount the timeline, wire keyboard shortcuts.

import { state, load, onChange, api, selected, select, change, undo, redo, removeSelected, duplicateSelected, addItem, save, setSharedSaver } from './store.js';
import { reconnectAll, startSharedPolling, scheduleSharedSave, describeLock } from './shared.js';
import { fromDay, toDay } from './util.js';
import { mountTimeline } from './timeline.js';
import { renderChrome, contextMenu, focusName, groupDialog, checkForUpdate, closeMenu, toast, mountInsightsGrip } from './panels.js';

const $ = id => document.getElementById(id);

await load();
history.replaceState(null, '', location.pathname);   // keep the session token out of the address

const timeline = mountTimeline({
  svg: $('tl'), scroller: $('scroller'), tip: $('tip'),
  onContext: contextMenu, onEditName: focusName,
  onAdd: (subId, day) => addItem('task', subId, day),
  onNotice: msg => toast(msg, true),
  onGroup: groupDialog,
});

onChange(what => {
  if (what !== 'save') timeline.render();
  renderChrome(what);
  if (what === 'save' && state.saveState === 'error') toast('Could not save the workspace - check the data folder', true);
});
mountInsightsGrip();
setSharedSaver(scheduleSharedSave);
state.onReadOnly = rm => toast(`"${rm.name}" is read-only - ${describeLock(rm._shared.lock)}. Use "Take over editing" on the red bar.`, true);
renderChrome('all');
timeline.render();
reconnectAll().catch(() => {});
startSharedPolling();

window.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (!$('modal').hidden) return;
  if (e.key === 'Escape') { closeMenu(); if (!typing && state.sel && !state.drag) select(null); return; }
  if (typing) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (ctrl && k === 'y') { e.preventDefault(); redo(); }
  else if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (e.key === 'Delete') removeSelected();
  else if (e.key === 'F2' || e.key === 'Enter') { if (state.sel) { e.preventDefault(); focusName(); } }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const f = selected(); if (f?.type !== 'item' && f?.type !== 'marker') return;
    e.preventDefault();
    const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1), it = f.obj;
    change(() => { for (const key of it.type === 'task' ? ['start', 'end'] : ['date']) it[key] = fromDay(toDay(it[key]) + d); });
  }
});

window.addEventListener('beforeunload', () => { save(true); });
setInterval(() => api('GET', 'ping').catch(() => {}), 20000);
setTimeout(() => checkForUpdate().catch(() => {}), 4000);
