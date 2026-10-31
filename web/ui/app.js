// Bootstrap: sign-in check, the roadmap list, the open roadmap, keyboard.

import { h } from './util.js';
import { state, load, onChange, selected, select, change, undo, redo, removeSelected, duplicateSelected, addItem, sampleRoadmap, isReadOnly, active, editing } from './store.js';
import { fromDay, toDay } from './util.js';
import { mountTimeline } from './timeline.js';
import { renderChrome, contextMenu, focusName, groupDialog, closeMenu, toast, mountInsightsGrip } from './panels.js';
import { openRoadmap, kick, sendPresence, sendCursor, createRoadmap } from './collab.js';
import { startTour } from './tour.js';
import { mountPresent, presentKeys, onPresence as presentOnPresence, onSelect as presentOnSelect } from './present.js';

const $ = id => document.getElementById(id);

function signedOut() {
  if (document.querySelector('.signedout')) return;
  document.body.append(h('div', { class: 'modal signedout' }, h('div', { class: 'dialog' }, h('h2', { text: 'You are signed out' }),
    h('div', { class: 'body' }, h('p', { text: 'Your session ended. Anything you changed before this message is saved. Sign in again to carry on.' })),
    h('div', { class: 'foot' }, h('a', { class: 'btn primary', href: '/login?return=/' }, 'Sign in again')))));
}

state.onSignedOut = signedOut;
state.onCommit = () => kick();
state.onReadOnly = rm => toast(rm._meta?.role === 'commenter' ? `You can comment on "${rm.name}" but not change it. Ask its owner for Editor access.` : `You can view "${rm.name}" but not change it. Ask its owner for Editor access.`, true);

try {
  await load();
} catch (e) {
  if (e.status !== 401) document.body.replaceChildren(h('div', { class: 'empty', style: 'margin:auto;text-align:center' },
    h('h2', { text: 'RoadMap Studio could not start' }), h('p', { text: e.message })));
  throw e;
}

const timeline = mountTimeline({
  svg: $('tl'), scroller: $('scroller'), tip: $('tip'),
  onContext: contextMenu, onEditName: focusName,
  onAdd: (subId, day) => addItem('task', subId, day),
  onNotice: msg => toast(msg, true),
  onGroup: groupDialog,
  onCursor: sendCursor,
});
mountPresent(timeline);

// What this person is doing, in a few words, for the colleagues' cursor tags.
const DRAG_WORDS = { move: 'moving', resize: 'resizing', progress: 'setting progress on', label: 'placing the label of', link: 'linking', marker: 'moving', reorder: 'reordering' };
function whatImDoing() {
  if (state.pres) return 'presenting';
  const f = selected(), name = f?.obj?.name || (f ? 'an item' : '');
  if (state.drag) return `${DRAG_WORDS[state.drag.kind] || 'changing'} ${name}`;
  if (document.activeElement?.closest?.('.cnew')) return `commenting on ${name}`;
  if (editing() || (document.activeElement?.closest?.('#inspector') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) return `editing ${name}`;
  if (f) return `looking at ${name}`;
  return 'viewing';
}
function updateDoing() {
  const d = whatImDoing();
  if (d !== state.doing) { state.doing = d; sendPresence(); }
}
document.addEventListener('focusin', updateDoing);
document.addEventListener('focusout', () => setTimeout(updateDoing, 0));

onChange(what => {
  if (what === 'presence') {
    timeline.render();
    // Following a presentation: only the presenter's pointer is shown.
    timeline.renderCursors(state.following ? state.presence.filter(p => p.userId === state.following) : state.presence);
    presentOnPresence(state.presence);
    renderChrome('save');
    return;
  }
  updateDoing();
  if (what !== 'save') timeline.render();
  renderChrome(what);
  if (what === 'select') { sendPresence(); if (state.presentMode) presentOnSelect(); }
});
mountInsightsGrip();
renderChrome('all');
timeline.render();

// First sign-in: start with an example rather than an empty page.
if (!state.ws.roadmaps.length) {
  try {
    const rm = sampleRoadmap();
    rm.name = 'My first roadmap';
    state.ws.activeId = await createRoadmap(rm);
  } catch (e) { toast(e.message, true); }
}
if (state.ws.activeId) await openRoadmap(state.ws.activeId);
if (!state.ws.settings.tourSeen) startTour();

window.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (!$('modal').hidden) return;
  if (!typing && presentKeys(e)) return;
  if (e.key === 'Escape') { closeMenu(); if (!typing && state.sel && !state.drag) select(null); return; }
  if (typing) return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (ctrl && k === 'y') { e.preventDefault(); redo(); }
  else if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (e.key === 'Delete') removeSelected();
  else if (e.key === 'F2' || e.key === 'Enter') { if (state.sel) { e.preventDefault(); focusName(); } }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const f = selected(); if ((f?.type !== 'item' && f?.type !== 'marker') || isReadOnly(active())) return;
    e.preventDefault();
    const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1), it = f.obj;
    change(() => { for (const key of it.type === 'task' ? ['start', 'end'] : ['date']) it[key] = fromDay(toDay(it[key]) + d); });
  }
});

// Leaving with edits not yet accepted by the server: ask first.
window.addEventListener('beforeunload', e => {
  if (state.sync?.pending.some(b => !b.sent)) { kick(); e.preventDefault(); e.returnValue = ''; }
});
