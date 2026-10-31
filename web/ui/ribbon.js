// Office-style chrome: menu bar (File · Home · View · Format · Tools · Help),
// the ribbon under it, the Local / Shared roadmap tabs and the shared banner.

import { h, icon, UNITS, MONTHS, toDay, fromDay, clone } from './util.js';
import { THEMES, themeById, PRIORITY_STYLES, PLACEHOLDER_STYLES, LABEL_POSITIONS, BAR_SHAPES, BAR_FILLS, PROGRESS_STYLES, COLOR_BY, DENSITIES } from './themes.js';
import { state, api, active, meta, isReadOnly, isShared, selected, change, begin, commit, emit, save, undo, redo, canUndo, canRedo, snapshot, newRoadmap, sampleRoadmap,
  addLane, addSub, addItem, addMarker, removeSelected, duplicateSelected, toggleHidden, eachItem, itemStart, itemEnd } from './store.js';
import { toast, attempt, openMenu, askText, confirmBox, dialog, field, selectBox, seg, check, aboutDialog } from './panels.js';
import { switchTo, createRoadmap as createOnServer, duplicateRoadmap, deleteRoadmap, leaveRoadmap, shareDialog, adminDialog, historyDialog, avatar, passwordDialog } from './collab.js';
import * as io from './io.js';
import { startTour } from './tour.js';
import { presentDialog, presenterHere, follow } from './present.js';

const $ = id => document.getElementById(id);
// DOM append prints null/arrays as text; put() flattens and drops them like h() does.
const put = (el, ...kids) => { el.replaceChildren(); el.append(...kids.flat(Infinity).filter(k => k != null && k !== false)); };
const TABS = [['file', 'File'], ['home', 'Home'], ['view', 'View'], ['format', 'Format'], ['tools', 'Tools'], ['help', 'Help']];
const setView = (key, value) => change(() => { active().view[key] = value; });
const setting = (key, value) => { state.ws.settings[key] = value; save(); emit(); };

// ---- building blocks ------------------------------------------------------

const big = (label, ic, onclick, opts = {}) => h('button', { class: 'rbtn' + (opts.on ? ' on' : '') + (opts.primary ? ' primary' : ''), title: opts.title || label, disabled: opts.disabled, onclick }, icon(ic), h('span', { text: label }));
const small = (label, ic, onclick, opts = {}) => h('button', { class: 'rsmall' + (opts.on ? ' on' : ''), title: opts.title || label, disabled: opts.disabled, onclick }, ic ? icon(ic) : null, label);
const group = (label, ...items) => h('div', { class: 'rgroup' }, h('div', { class: 'ritems' }, items), h('div', { class: 'rlabel', text: label }));
const stack = (...items) => h('div', { class: 'rstack' }, items);
const exportItems = () => [
  { label: 'Image (PNG)…', icon: 'download', onClick: () => attempt(io.exportPng, r => (r === true ? 'PNG downloaded' : 'Saved ' + r)) },
  { label: 'Vector image (SVG)…', icon: 'download', onClick: () => attempt(io.exportSvgFile, r => (r === true ? 'SVG downloaded' : 'Saved ' + r)) },
  { label: 'Data (JSON)…', icon: 'download', onClick: () => attempt(io.exportRoadmap, r => (r === true ? 'Roadmap downloaded' : 'Saved ' + r)) },
  { label: 'Table (CSV for Excel)…', icon: 'download', onClick: () => attempt(io.exportCsv, r => (r === true ? 'CSV downloaded' : 'Saved ' + r)) },
];
const copyImage = () => attempt(io.copyImage, 'Timeline image copied - paste it anywhere');

// ---- roadmap actions ------------------------------------------------------

async function createRoadmap(sample) {
  const name = await askText('New roadmap', sample ? 'Product roadmap' : 'New roadmap');
  if (!name) return;
  const rm = sample ? sampleRoadmap() : newRoadmap(name);
  rm.name = name;
  try { await switchTo(await createOnServer(rm)); } catch (e) { toast(e.message, true); }
}
async function renameRoadmap(rm) {
  const name = await askText('Rename roadmap', rm.name);
  if (name) change(() => { rm.name = name; });
}
export function doImport() {
  attempt(async () => {
    const file = await io.openFile('RoadMap Studio or CSV|*.json;*.csv|All files|*.*', '.json,.csv');
    if (!file) return null;
    return io.importText(file.text, file.name);
  });
}
function fitDates() {
  let min = Infinity, max = -Infinity;
  eachItem(active(), it => { min = Math.min(min, itemStart(it)); max = Math.max(max, itemEnd(it)); });
  if (!isFinite(min)) return toast('There are no tasks yet');
  const pad = Math.max(7, Math.round((max - min) * .03));
  change(() => { active().start = fromDay(min - pad); active().end = fromDay(max + pad); });
}
function roadmapMenu(anchor, rm) {
  const m = meta(rm), owner = m.role === 'owner';
  openMenu(anchor, [
    { label: 'Rename…', icon: 'edit', onClick: () => renameRoadmap(rm), disabled: isReadOnly(rm) },
    { label: owner ? 'Share…' : 'People with access…', icon: 'people', onClick: () => shareDialog(rm) },
    { label: 'Duplicate as my own', icon: 'dup', onClick: () => duplicateRoadmap(rm) },
    { label: 'Version history…', icon: 'history', onClick: historyDialog },
    'sep',
    owner ? { label: 'Delete roadmap', icon: 'trash', danger: true, onClick: () => deleteRoadmap(rm) }
      : { label: 'Leave this roadmap', icon: 'trash', onClick: () => leaveRoadmap(rm) },
  ]);
}

function themeMenu(anchor) {
  const cur = active().view.theme;
  openMenu(anchor, [{ head: 'Timeline colour theme' }, ...THEMES.map(t => ({
    content: h('span', { class: 'theme-row' }, h('span', { class: 'chips' }, [t.head1, ...t.palette.slice(0, 5)].map(c => h('i', { style: `background:${c}` }))), t.name + (t.id === cur ? '  ✓' : '')),
    onClick: () => setView('theme', t.id) }))]);
}

// ---- ribbon tabs ----------------------------------------------------------

const ribbon = {
  file() {
    const rm = active(), ro = isReadOnly(rm), owner = meta(rm).role === 'owner', has = !!rm.id;
    return [
      group('New', big('Blank', 'plus', () => createRoadmap(false), { title: 'A new empty roadmap' }), big('Sample', 'task', () => createRoadmap(true), { title: 'A filled-in example to start from' }),
        big('Import', 'upload', doImport, { title: 'A roadmap, a desktop backup, or a CSV from Excel' })),
      group('Collaborate', big(owner ? 'Share' : 'People', 'people', () => shareDialog(rm), { primary: owner && has, disabled: !has, title: owner ? 'Choose who can view or edit this roadmap' : 'Who has access' }),
        big('Duplicate', 'dup', () => duplicateRoadmap(rm), { disabled: !has, title: 'A copy that belongs to you' }),
        big('Present', 'play', presentDialog, { disabled: !has, title: 'Full-screen presentation of one or more roadmaps; colleagues can follow on their own screens' })),
      group('This roadmap', big('Rename', 'edit', () => renameRoadmap(rm), { disabled: ro }),
        big('Save version', 'history', async () => { const label = await askText('Save version', '', 'Label (optional)'); if (label === undefined) return; await snapshot(label || 'Saved version'); toast('Version saved'); }, { disabled: ro, title: 'Keep a named copy anyone with access can go back to' }),
        big('History', 'history', () => historyDialog('versions'), { disabled: !has, title: 'Saved versions of this roadmap' }),
        big('Activity', 'edit', () => historyDialog('activity'), { disabled: !has, title: 'Every change: what, by whom, when' }),
        owner ? big('Delete', 'trash', () => deleteRoadmap(rm), { disabled: !has }) : big('Leave', 'logout', () => leaveRoadmap(rm), { disabled: !has, title: 'Remove it from your list' })),
      group('Export', big('PNG', 'download', () => attempt(io.exportPng, r => (r === true ? 'PNG downloaded' : 'Saved ' + r)), { title: 'Picture of the timeline' }),
        big('SVG', 'download', () => attempt(io.exportSvgFile, r => (r === true ? 'SVG downloaded' : 'Saved ' + r)), { title: 'Vector picture, scales without blurring' }),
        big('JSON', 'download', () => attempt(io.exportRoadmap, r => (r === true ? 'Roadmap downloaded' : 'Saved ' + r)), { title: 'The roadmap as data, to import elsewhere' }),
        big('CSV', 'download', () => attempt(io.exportCsv, r => (r === true ? 'CSV downloaded' : 'Saved ' + r)), { title: 'A table for Excel' }),
        big('Backup', 'folder', () => attempt(io.exportBackup, r => (r === true ? 'Backup downloaded' : 'Saved ' + r)), { title: 'Every roadmap you can open, in one file' })),
      group('Share', big('Copy image', 'copy', copyImage, { primary: true, title: 'Copy the timeline as an image, ready to paste into PowerPoint' })),
    ];
  },
  home() {
    const rm = active(), f = selected(), ro = isReadOnly(rm);
    const dateInput = key => { const el = h('input', { type: 'date', value: rm[key], disabled: ro });
      el.addEventListener('change', () => { if (!el.value) return; change(() => { rm[key] = el.value; if (toDay(rm.end) <= toDay(rm.start)) { if (key === 'start') rm.end = fromDay(toDay(rm.start) + 30); else rm.start = fromDay(toDay(rm.end) - 30); } }); });
      return el; };
    return [
      group('Undo', big('Undo', 'undo', undo, { disabled: !canUndo(), title: 'Undo (Ctrl+Z)' }), big('Redo', 'redo', redo, { disabled: !canRedo(), title: 'Redo (Ctrl+Y)' })),
      group('Insert', big('Swimlane', 'plus', addLane, { disabled: ro }), big('Sub-swimlane', 'plus', () => { const g = f?.lane; if (!g) return toast('Select a swimlane first'); addSub(g.id); }, { disabled: ro }),
        big('Task', 'task', () => addItem('task'), { disabled: ro }), big('Milestone', 'diamond', () => addItem('milestone'), { disabled: ro }),
        big('Key date', 'flagpole', () => addMarker(), { disabled: ro, title: 'A major date drawn across the whole timeline - UAT, production release, freeze…' })),
      group('Selection', big('Duplicate', 'dup', duplicateSelected, { disabled: !f || ro, title: 'Duplicate (Ctrl+D)' }), big('Delete', 'trash', removeSelected, { disabled: !f || ro, title: 'Delete (Del)' }),
        big(f?.obj?.hidden ? 'Show' : 'Hide', f?.obj?.hidden ? 'eye' : 'eyeoff', () => f && toggleHidden(f.obj.id), { disabled: !f || ro })),
      group('Date range', field('From', dateInput('start')), field('To', dateInput('end')), stack(small('Fit to tasks', 'fit', fitDates, { disabled: ro, title: 'Set the range to cover every task' }))),
      group('Present', big('Present', 'play', presentDialog, { disabled: !active().id, title: 'Full-screen presentation of one or more roadmaps; colleagues can follow on their own screens' })),
      group('Share', big('Copy image', 'copy', copyImage, { primary: true, title: 'Copy the timeline as an image, ready to paste into PowerPoint' }), big('Export', 'download', e => openMenu(e.currentTarget, exportItems()))),
    ];
  },
  view() {
    const v = active().view, st = state.ws.settings;
    const zoom = h('input', { type: 'range', min: 0, max: 100, step: 1, value: v.zoom === 'fit' ? 0 : Math.round(Math.log(v.zoom / .3) / Math.log(40 / .3) * 100), title: 'Zoom' });
    zoom.addEventListener('input', () => { active().view.zoom = +(0.3 * Math.pow(40 / .3, zoom.value / 100)).toFixed(3); emit('view'); });
    zoom.addEventListener('change', () => { zoom.blur(); save(); emit(); });
    const panel = (key, label, ic) => big(label, ic, () => setting(key, !st[key]), { on: st[key] });
    return [
      group('Header', field('Row 1', selectBox(UNITS.filter(u => u[0] !== 'day'), v.top, val => setView('top', val))), field('Row 2', selectBox(UNITS, v.bottom, val => setView('bottom', val))),
        field('Year starts', selectBox(MONTHS.map((m, i) => [i, i ? m + ' (fiscal)' : 'Jan']), v.fiscal, val => setView('fiscal', +val)))),
      group('Zoom', big('Fit', 'fit', () => setView('zoom', 'fit'), { on: v.zoom === 'fit', title: 'Fit the whole range in the window' }), field('Zoom', zoom)),
      group('Panels', panel('outline', 'Outline', 'sidebar'), panel('inspector', 'Details', 'panel'), panel('insights', 'Charts', 'chart')),
      group('Show', stack(check('Hidden items (faded)', state.showHidden, x => { state.showHidden = x; emit(); }), check('Today line', v.showToday, x => setView('showToday', x)), check('Title', v.showTitle, x => setView('showTitle', x))),
        stack(check('Legend', v.showLegend, x => setView('showLegend', x)), check('Dependency arrows', v.showDeps, x => setView('showDeps', x)))),
      group('On labels', stack(check('% complete', v.showPercent, x => setView('showPercent', x)), check('Dates', v.showDates, x => setView('showDates', x)), check('Duration', !!v.showDuration, x => setView('showDuration', x))),
        stack(check('Status dot', v.showStatusDot, x => setView('showStatusDot', x)), check('Status name', !!v.showStatus, x => setView('showStatus', x)), check('Priority badge', v.showPriority !== false, x => setView('showPriority', x))),
        stack(check('Resources', v.showResources, x => setView('showResources', x)), check('Dependencies', !!v.showDepCount, x => setView('showDepCount', x)), check('Notes (first line)', !!v.showNotes, x => setView('showNotes', x))),
        stack(check('Comments', v.showComments !== false, x => setView('showComments', x)))),
    ];
  },
  format() {
    const v = active().view;
    const pick = (label, options, key) => field(label, selectBox(options, v[key], val => setView(key, val)));
    const width = h('input', { type: 'range', min: 80, max: 300, step: 10, value: v.subWidth, title: 'Sub-swimlane column width' });
    let live = false;
    width.addEventListener('input', () => { if (!live) { begin(); live = true; } active().view.subWidth = +width.value; emit('view'); });
    width.addEventListener('change', () => { live = false; commit(); });
    return [
      group('Theme', big(themeById(v.theme).name, 'palette', e => themeMenu(e.currentTarget), { title: 'Timeline colour theme' })),
      group('Bars', pick('Shape', BAR_SHAPES, 'barShape'), pick('Fill', BAR_FILLS, 'barFill'), pick('Progress', PROGRESS_STYLES, 'progress')),
      group('Colour', pick('Colour by', COLOR_BY, 'colorBy')),
      group('Labels', pick('Position', LABEL_POSITIONS, 'labelPos'), pick('Swimlane titles', [['auto', 'Vertical, spanning'], ['horizontal', 'Horizontal'], ['vertical', 'Always vertical']], 'laneLabels'), field('Sub width', width)),
      group('Markers', pick('Priority', PRIORITY_STYLES, 'priorityStyle'), pick('Placeholder', PLACEHOLDER_STYLES, 'placeholderStyle')),
      group('Rows', pick('Density', DENSITIES, 'density'), pick('Layout', [['compact', 'Pack rows'], ['rows', 'One per row']], 'layout')),
    ];
  },
  tools() {
    const rm = active(), v = rm.view, st = state.ws.settings;
    return [
      group('Scheduling', stack(check('Auto-push dependents', v.autoPush, x => setView('autoPush', x)), h('div', { class: 'meta-note', text: 'Moving a task moves what depends on it' }))),
      group('Data', big('History', 'history', historyDialog, { title: 'Saved versions of this roadmap' }), big('Import', 'upload', doImport),
        big('Backup', 'folder', () => attempt(io.exportBackup, r => (r === true ? 'Backup downloaded' : 'Saved ' + r)), { title: 'Every roadmap you can open, in one file' })),
      state.me?.isAdmin ? group('Administration', big('Users & sign-in', 'shield', adminDialog, { title: 'People, administrators, and the single sign-on settings' })) : null,
      group('Appearance', big(st.appTheme === 'dark' ? 'Light mode' : 'Dark mode', st.appTheme === 'dark' ? 'sun' : 'moon', () => setting('appTheme', st.appTheme === 'dark' ? 'light' : 'dark'))),
      group('Account', state.me?.local ? big('Password', 'shield', passwordDialog, { title: 'Change the local administrator password' }) : null,
        big('Sign out', 'logout', () => { location.href = '/auth/logout'; })),
    ];
  },
  help() {
    return [
      group('Help', big('Tutorial', 'play', startTour, { primary: true, title: 'A guided tour that builds a sample roadmap with you' }),
        big('About', 'info', aboutDialog, { title: 'Version and who you are signed in as' }), big('Shortcuts', 'edit', shortcutsDialog), big('Tips', 'task', tipsDialog)),
    ];
  },
};

function shortcutsDialog() {
  const rows = [['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+D', 'Duplicate the selection'], ['Delete', 'Delete the selection'], ['F2 or Enter', 'Edit the name'], ['← / →', 'Move the selected item one day (Shift: one week)'], ['Esc', 'Deselect, close menus, cancel a drag'], ['Double-click a row', 'Add a task there'], ['Right-click', 'Context menu on anything']];
  dialog('Keyboard shortcuts', h('table', { class: 'keys' }, rows.map(([k, t]) => h('tr', {}, h('td', {}, h('kbd', { text: k })), h('td', { text: t })))), [{ label: 'Close', cls: 'primary' }]);
}
function tipsDialog() {
  dialog('Working on the timeline', h('div', { class: 'empty', style: 'padding:0', html: 'Drag a bar to move it, its ends to resize it, the round handle to set % complete.<br>Drag a label - or the small “Aa” handle on a selected task - to choose where the text sits.<br>Drag a bar onto another sub-swimlane to move it there.<br>Drag the round → handle of a selected item onto another item to make that one depend on it; right-click an arrow to change or remove it.<br>Drag swimlane titles to reorder them; double-click an initiative (far left) to rename it.<br>Drag a key date’s label to move its line.<br><br><b>Shared roadmaps</b> live on a network share; one person edits at a time. Take over when it is free, or press “Notify me” to grab it automatically.' }), [{ label: 'Close', cls: 'primary' }]);
}

// ---- rendering ------------------------------------------------------------

// A ribbon too wide for the window scrolls sideways; the wheel drives it, so
// nobody has to find the scrollbar.
let wheelBound = false;
function bindWheel(el) {
  if (wheelBound) return;
  wheelBound = true;
  el.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { el.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
}

export function renderRibbon() {
  const st = state.ws.settings;
  st.ribbon ||= 'home';
  if (!TABS.some(t => t[0] === st.ribbon)) st.ribbon = 'home';
  const bar = $('menubar');
  if (bar.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;
  put(bar,
    h('div', { class: 'brand' }, h('svg', {}), h('span', { text: 'RoadMap Studio' })),
    ...TABS.map(([id, label]) => h('button', { class: 'mtab' + (id === 'file' ? ' file' : '') + (st.ribbon === id ? ' active' : ''), onclick: () => { st.ribbon = id; save(); renderRibbon(); } }, label)),
    h('div', { class: 'spacer' }),
    h('span', { class: 'savestate ' + statusClass(), title: statusTitle(), text: statusText() }),
    state.me ? h('button', { class: 'mebtn', title: `${state.me.name} (${state.me.local ? 'local account' : state.me.email})`, onclick: e => openMenu(Object.assign(e.currentTarget, { alignRight: true }), [
      { head: state.me.name || state.me.email }, { label: state.me.local ? 'Local administrator account' : state.me.email, disabled: true },
      state.me.isAdmin ? { label: 'Users & sign-in…', icon: 'shield', onClick: adminDialog } : null,
      state.me.local ? { label: 'Change password…', icon: 'shield', onClick: passwordDialog } : null,
      { label: 'Sign out', icon: 'logout', onClick: () => { location.href = '/auth/logout'; } }]) }, avatar(state.me)) : null,
    h('button', { class: 'btn ghost icon small', title: 'Light / dark', onclick: () => setting('appTheme', st.appTheme === 'dark' ? 'light' : 'dark') }, icon(st.appTheme === 'dark' ? 'sun' : 'moon')));
  bar.querySelector('.brand svg').replaceWith(brandIcon());
  put($('ribbon'), ribbon[st.ribbon]());
  bindWheel($('ribbon'));
  renderTabs();
  renderPasswordBar();
  renderSharedBar();
}

// Red until the local administrator stops using the default password.
function renderPasswordBar() {
  const bar = $('pwbar'), show = !!(state.me?.local && state.me.defaultPassword);
  bar.hidden = !show;
  if (show) put(bar, icon('shield'), h('span', { text: 'This administrator account still uses the default password "admin" - anyone who tries it gets in.' }),
    h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: passwordDialog }, 'Change password'));
}

function brandIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', 22); svg.setAttribute('height', 22);
  svg.innerHTML = '<rect width="32" height="32" rx="8" fill="var(--accent)"/><rect x="6" y="8" width="13" height="4" rx="2" fill="#fff"/><rect x="11" y="14" width="15" height="4" rx="2" fill="#fff" opacity=".8"/><rect x="8" y="20" width="9" height="4" rx="2" fill="#fff" opacity=".6"/><path d="M23 19l3 3-3 3-3-3z" fill="#fff"/>';
  return svg;
}

function statusText() {
  if (!active().id) return '';
  if (!meta(active()).loaded) return 'Opening…';
  if (state.saveState === 'offline') return 'Offline - changes kept';
  if (!state.online) return 'Reconnecting…';
  if (state.saveState === 'saving') return 'Saving…';
  return 'All changes saved';
}
const statusClass = () => (state.saveState === 'offline' || (!state.online && meta(active()).loaded) ? 'err' : '');
const statusTitle = () => 'Every change is saved to the server as you make it and appears for everyone on this roadmap.';

function tab(rm) {
  const on = rm.id === state.ws.activeId, m = meta(rm), shared = isShared(rm);
  const t = h('button', { class: 'tab' + (on ? ' active' : '') + (shared ? ' shared' : ''), title: rm.name + (shared ? ` - ${m.role === 'owner' ? 'you share it' : 'shared by ' + (m.owner?.name || 'someone')}` : '') },
    shared ? h('span', { class: 'tabstate' + (['viewer', 'commenter'].includes(m.role) ? '' : ' editing') }, icon(['viewer', 'commenter'].includes(m.role) ? 'eye' : 'people')) : on ? h('span', { class: 'dot' }) : null,
    rm.name, on ? h('span', { class: 'more' }, icon('chevron')) : null);
  t.addEventListener('click', e => {
    if (!on) { switchTo(rm.id); return; }
    if (e.target.closest('.more')) roadmapMenu(t, rm);
  });
  t.addEventListener('dblclick', () => !isReadOnly(rm) && renameRoadmap(rm));
  t.addEventListener('contextmenu', e => { e.preventDefault(); roadmapMenu(t, rm); });
  return t;
}

function renderTabs() {
  const mine = state.ws.roadmaps.filter(r => meta(r).role === 'owner'), others = state.ws.roadmaps.filter(r => meta(r).role !== 'owner');
  put($('tabs'),
    h('div', { class: 'tabsection' }, h('span', { class: 'tablabel', text: 'My roadmaps' }), ...mine.map(tab),
      h('button', { class: 'btn ghost icon small', title: 'New roadmap', onclick: e => openMenu(e.currentTarget, [
        { label: 'Blank roadmap', icon: 'plus', onClick: () => createRoadmap(false) }, { label: 'Sample roadmap', icon: 'task', onClick: () => createRoadmap(true) },
        'sep', { label: 'Import from file…', icon: 'upload', onClick: doImport }]) }, icon('plus'))),
    h('div', { class: 'tabsection shared' }, h('span', { class: 'tablabel', text: 'Shared with me' }),
      ...(others.length ? others.map(tab) : [h('span', { class: 'tabhint', text: 'Roadmaps others share with you appear here' })])));
}

// The red banner: this roadmap is a shared working environment.
function renderSharedBar() {
  const rm = active(), m = meta(rm), bar = $('sharedbar');
  const shared = !!rm.id && isShared(rm);
  document.querySelector('.stage').classList.toggle('shared', shared);
  document.body.classList.toggle('readonly', !!rm.id && m.loaded && isReadOnly(rm));
  bar.hidden = !shared;
  if (!shared) return;
  const people = m.people || [];
  const others = state.presence || [];
  const owner = m.role === 'owner' ? 'You own it' : `Owner: ${m.owner?.name || people.find(p => p.role === 'owner')?.name || '?'}`;
  const role = m.role === 'viewer' ? 'You can view - read-only' : m.role === 'commenter' ? 'You can comment - read-only otherwise' : 'You can edit';
  const everyone = m.everyone ? ` · everyone can ${m.everyone === 'viewer' ? 'view' : m.everyone === 'commenter' ? 'comment' : 'edit'}` : '';
  const online = new Map();
  for (const p of others) if (!online.has(p.userId)) online.set(p.userId, p);
  put(bar, h('span', { class: 'sharedtag', text: 'SHARED' }),
    h('span', { class: 'sharedstatus', text: `${owner} · ${(m.members || 0) + 1} people${everyone} · ${role}` }),
    h('span', { class: 'spacer' }),
    online.size ? h('span', { class: 'online' }, h('span', { class: 'onlinelabel', text: 'Here now' }), ...[...online.values()].map(p => { const a = avatar(p, 'live'); a.title = p.name + (p.doing ? ' - ' + p.doing : ''); return a; })) : h('span', { class: 'onlinelabel', text: 'Nobody else here right now' }),
    (p => p && !state.presentMode ? h('button', { class: 'btn small primary', title: 'See what they see, on this screen', onclick: () => follow(p.userId) }, icon('play'), `Follow ${p.name}'s presentation`) : null)(presenterHere()),
    h('button', { class: 'btn small' + (m.role === 'owner' ? ' primary' : ''), onclick: () => shareDialog(rm) }, icon('people'), m.role === 'owner' ? 'Share' : 'People'));
}
