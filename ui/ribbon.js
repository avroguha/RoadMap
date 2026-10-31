// Office-style chrome: menu bar (File · Home · View · Format · Tools · Help),
// the ribbon under it, the Local / Shared roadmap tabs and the shared banner.

import { h, icon, UNITS, MONTHS, toDay, fromDay, clone } from './util.js';
import { THEMES, themeById, PRIORITY_STYLES, PLACEHOLDER_STYLES, LABEL_POSITIONS, BAR_SHAPES, BAR_FILLS, PROGRESS_STYLES, COLOR_BY, DENSITIES } from './themes.js';
import { state, api, active, selected, change, begin, commit, emit, save, undo, redo, canUndo, canRedo, snapshot, newRoadmap, sampleRoadmap, reidentify,
  addLane, addSub, addItem, addMarker, removeSelected, duplicateSelected, toggleHidden, eachItem, itemStart, itemEnd } from './store.js';
import { toast, attempt, openMenu, askText, confirmBox, dialog, field, selectBox, seg, check, historyDialog, aboutDialog, updateDialog, checkForUpdate } from './panels.js';
import { openSharedDialog, shareActive, takeOver, releaseLock, closeShared, keepLocalCopy, describeLock, isReadOnly } from './shared.js';
import * as io from './io.js';

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
  change(() => { const rm = sample ? sampleRoadmap() : newRoadmap(name); rm.name = name; state.ws.roadmaps.push(rm); state.ws.activeId = rm.id; state.sel = null; });
}
async function renameRoadmap(rm) {
  const name = await askText('Rename roadmap', rm.name);
  if (name) change(() => { rm.name = name; });
}
async function deleteRoadmap(rm) {
  if (rm._shared) return closeShared(rm);
  if (!(await confirmBox('Delete roadmap', `Delete "${rm.name}"? Its saved versions stay in the history folder, and Undo brings the roadmap back.`, 'Delete'))) return;
  change(() => { const ws = state.ws; ws.roadmaps.splice(ws.roadmaps.indexOf(rm), 1); if (!ws.roadmaps.length && !state.shared.length) ws.roadmaps.push(newRoadmap('New roadmap')); ws.activeId = (ws.roadmaps[0] || state.shared[0]).id; state.sel = null; });
}
function duplicateRoadmap(rm) {
  change(() => { const c = reidentify(clone(rm)); delete c._shared; c.name += ' (copy)'; state.ws.roadmaps.push(c); state.ws.activeId = c.id; state.sel = null; });
}
export function doImport() {
  attempt(async () => {
    const file = await io.openFile('RoadMap Studio or CSV|*.json;*.csv|All files|*.*', '.json,.csv');
    if (!file) return null;
    return io.importText(file.text, file.name, () => confirmBox('Restore backup', 'This backup replaces every roadmap in the workspace. The current workspace is kept as workspace.bak.json in the data folder.', 'Replace everything'));
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
  openMenu(anchor, [
    { label: 'Rename…', icon: 'edit', onClick: () => renameRoadmap(rm), disabled: isReadOnly(rm) },
    { label: rm._shared ? 'Duplicate as local roadmap' : 'Duplicate', icon: 'dup', onClick: () => duplicateRoadmap(rm) },
    { label: 'Version history…', icon: 'history', onClick: historyDialog },
    ...(rm._shared ? ['sep', { label: 'Where is this file?', icon: 'info', onClick: () => dialog('Shared roadmap', h('code', { class: 'path', text: rm._shared.path }), [{ label: 'Close', cls: 'primary' }]) }] : ['sep', { label: 'Share on the network…', icon: 'share', onClick: shareActive }]),
    'sep',
    { label: rm._shared ? 'Close shared roadmap' : 'Delete roadmap', icon: 'trash', danger: !rm._shared, onClick: () => deleteRoadmap(rm) },
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
    const rm = active(), ro = isReadOnly(rm);
    return [
      group('New', big('Blank', 'plus', () => createRoadmap(false), { title: 'A new empty roadmap' }), big('Sample', 'task', () => createRoadmap(true), { title: 'A filled-in example to start from' }),
        big('Import', 'upload', doImport, { title: 'Open a roadmap, workspace, backup or CSV file' })),
      group('Shared (network)', big('Open shared', 'folder', openSharedDialog, { title: 'Open a roadmap stored on a network share' }),
        big('Share this', 'share', shareActive, { disabled: !!rm._shared, title: 'Move this roadmap to a network share so others can open it' })),
      group('This roadmap', big('Rename', 'edit', () => renameRoadmap(rm), { disabled: ro }),
        big('Save version', 'history', async () => { const label = await askText('Save version', '', 'Label (optional)'); if (label === undefined) return; await snapshot(label || 'Saved version', false); toast('Version saved'); }, { title: 'Keep a named copy you can go back to' }),
        big('History', 'history', historyDialog, { title: 'Saved versions of this roadmap' }),
        big(rm._shared ? 'Close' : 'Delete', 'trash', () => deleteRoadmap(rm))),
      group('Export', big('PNG', 'download', () => attempt(io.exportPng, r => (r === true ? 'PNG downloaded' : 'Saved ' + r)), { title: 'Picture of the timeline' }),
        big('SVG', 'download', () => attempt(io.exportSvgFile, r => (r === true ? 'SVG downloaded' : 'Saved ' + r)), { title: 'Vector picture, scales without blurring' }),
        big('JSON', 'download', () => attempt(io.exportRoadmap, r => (r === true ? 'Roadmap downloaded' : 'Saved ' + r)), { title: 'The roadmap as data, to import elsewhere' }),
        big('CSV', 'download', () => attempt(io.exportCsv, r => (r === true ? 'CSV downloaded' : 'Saved ' + r)), { title: 'A table for Excel' }),
        big('Backup', 'folder', () => attempt(io.exportBackup, r => (r === true ? 'Backup downloaded' : 'Saved ' + r)), { title: 'All roadmaps and history in one file' })),
      group('Share', big('Copy image', 'copy', copyImage, { primary: true, title: 'Copy the timeline as an image, ready to paste into PowerPoint' })),
      state.info.browser ? group('App', big('Quit', 'trash', async () => { await save(true); await api('POST', 'quit').catch(() => {}); document.body.replaceChildren(h('div', { class: 'empty', style: 'margin:auto;text-align:center', text: 'RoadMap Studio has stopped. You can close this window.' })); }, { title: 'Stop the RoadMap Studio engine' })) : null,
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
      group('On labels', stack(check('% complete', v.showPercent, x => setView('showPercent', x)), check('Resources', v.showResources, x => setView('showResources', x))),
        stack(check('Dates', v.showDates, x => setView('showDates', x)), check('Status dot', v.showStatusDot, x => setView('showStatusDot', x)))),
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
    const rm = active(), v = rm.view, st = state.ws.settings, m = rm._shared;
    const sharedGroup = m
      ? group('This shared roadmap',
        m.lock?.held ? big('Release', 'unlock', () => releaseLock(rm), { title: 'Let someone else edit; you drop to read-only' })
          : big('Take over', 'lock', () => takeOver(rm), { disabled: !(m.lock?.free || m.lock?.stale), title: m.lock?.stale ? 'The editor stopped responding - take the lock' : m.lock?.free ? 'Start editing' : 'Someone is editing right now' }),
        !m.lock?.held ? big('Notify me', 'bell', () => { m.notify = !m.notify; emit(); }, { on: m.notify, title: 'Take over automatically as soon as it is free' }) : null,
        big('Local copy', 'dup', () => keepLocalCopy(rm), { title: 'Copy this roadmap into your local list' }),
        big('Close', 'trash', () => closeShared(rm)))
      : group('Shared (network)', big('Open shared…', 'folder', openSharedDialog), big('Share this…', 'share', shareActive, { title: 'Move this roadmap to a network share so others can open it' }));
    return [
      sharedGroup,
      group('Scheduling', stack(check('Auto-push dependents', v.autoPush, x => setView('autoPush', x)), h('div', { class: 'meta-note', text: 'Moving a task moves what depends on it' }))),
      group('Data', big('History', 'history', historyDialog, { title: 'Saved versions of this roadmap' }), big('Import', 'upload', doImport), big('Backup', 'folder', () => attempt(io.exportBackup, r => (r === true ? 'Backup downloaded' : 'Saved ' + r)), { title: 'All roadmaps + history in one file' }),
        big('Data folder', 'folder', () => api('POST', 'open-data-dir').catch(e => toast(e.message, true)))),
      group('Updates', big('Location…', 'edit', updateLocationDialog, { title: 'Where the app looks for new versions (URL or network folder)' }), big(state.update ? 'Update to ' + state.update.latest : 'Check now', 'download', () => (state.update ? updateDialog(state.update) : attempt(() => checkForUpdate(true).then(r => !r ? 'No update location set - see Help › About' : r.error ? Promise.reject(new Error(r.error)) : r.available ? (updateDialog(r), null) : `You have the latest version (${r.current})`))), { on: !!state.update })),
      group('Appearance', big(st.appTheme === 'dark' ? 'Light mode' : 'Dark mode', st.appTheme === 'dark' ? 'sun' : 'moon', () => setting('appTheme', st.appTheme === 'dark' ? 'light' : 'dark'))),
    ];
  },
  help() {
    return [
      group('Help', big('About', 'info', aboutDialog, { title: 'Version, data folder, update location' }), big('Shortcuts', 'edit', shortcutsDialog), big('Tips', 'task', tipsDialog)),
    ];
  },
};

async function updateLocationDialog() {
  let st = {}; try { st = await api('GET', 'update/settings'); } catch { /* offline */ }
  const input = h('input', { type: 'text', value: st.location || '', placeholder: 'https://cdn.example.com/roadmap  or  \\server\share\RoadMapStudio' });
  const v = await dialog('Update location', h('div', {}, h('p', { text: 'The folder or URL that holds latest.json and the release files. The app checks it once a day and offers to install a newer version. Leave empty to turn updates off.' }),
    input, st.builtIn && st.location ? h('p', { class: 'meta-note', text: 'Built-in default: ' + st.location }) : null), [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', value: () => input.value.trim() }]);
  if (v === undefined) return;
  try { await api('PUT', 'update/settings', { location: v }); toast(v ? 'Update location saved' : 'Updates turned off'); if (v) checkForUpdate(true).catch(() => {}); }
  catch (e) { toast(e.message, true); }
}

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
    state.update ? h('button', { class: 'btn small on', onclick: () => updateDialog(state.update) }, icon('download'), 'Update to ' + state.update.latest) : null,
    h('span', { class: 'savestate' + (state.saveState === 'error' ? ' err' : ''), text: state.saveState === 'error' ? 'Not saved!' : '' }),
    h('button', { class: 'btn ghost icon small', title: 'Light / dark', onclick: () => setting('appTheme', st.appTheme === 'dark' ? 'light' : 'dark') }, icon(st.appTheme === 'dark' ? 'sun' : 'moon')));
  bar.querySelector('.brand svg').replaceWith(brandIcon());
  put($('ribbon'), ribbon[st.ribbon]());
  bindWheel($('ribbon'));
  renderTabs();
  renderSharedBar();
}

function brandIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', 22); svg.setAttribute('height', 22);
  svg.innerHTML = '<rect width="32" height="32" rx="8" fill="var(--accent)"/><rect x="6" y="8" width="13" height="4" rx="2" fill="#fff"/><rect x="11" y="14" width="15" height="4" rx="2" fill="#fff" opacity=".8"/><rect x="8" y="20" width="9" height="4" rx="2" fill="#fff" opacity=".6"/><path d="M23 19l3 3-3 3-3-3z" fill="#fff"/>';
  return svg;
}

function tab(rm, shared) {
  const on = rm.id === state.ws.activeId, m = rm._shared;
  const status = !m ? null : m.connecting ? '…' : m.error ? '!' : m.lock?.held ? icon('edit') : m.lock?.free || m.lock?.stale ? icon('unlock') : icon('lock');
  const t = h('button', { class: 'tab' + (on ? ' active' : '') + (shared ? ' shared' : ''), title: m ? `${m.path}\n${m.error || describeLock(m.lock)}` : rm.name },
    shared ? h('span', { class: 'tabstate' + (m.lock?.held ? ' editing' : '') }, status) : on ? h('span', { class: 'dot' }) : null, rm.name, on ? h('span', { class: 'more' }, icon('chevron')) : null);
  t.addEventListener('click', e => {
    if (!on) { state.ws.activeId = rm.id; state.sel = null; save(); emit(); return; }
    if (e.target.closest('.more')) roadmapMenu(t, rm);
  });
  t.addEventListener('dblclick', () => !isReadOnly(rm) && renameRoadmap(rm));
  t.addEventListener('contextmenu', e => { e.preventDefault(); roadmapMenu(t, rm); });
  return t;
}

function renderTabs() {
  put($('tabs'),
    h('div', { class: 'tabsection' }, h('span', { class: 'tablabel', text: 'Local' }), ...state.ws.roadmaps.map(rm => tab(rm, false)),
      h('button', { class: 'btn ghost icon small', title: 'New roadmap', onclick: e => openMenu(e.currentTarget, [
        { label: 'Blank roadmap', icon: 'plus', onClick: () => createRoadmap(false) }, { label: 'Sample roadmap', icon: 'task', onClick: () => createRoadmap(true) },
        'sep', { label: 'Import from file…', icon: 'upload', onClick: doImport }]) }, icon('plus'))),
    h('div', { class: 'tabsection shared' }, h('span', { class: 'tablabel', text: 'Shared' }), ...state.shared.map(rm => tab(rm, true)),
      h('button', { class: 'btn ghost icon small', title: 'Open a shared roadmap from the network', onclick: openSharedDialog }, icon('folder'))));
}

function renderSharedBar() {
  const rm = active(), m = rm._shared, bar = $('sharedbar');
  document.querySelector('.stage').classList.toggle('shared', !!m);
  document.body.classList.toggle('readonly', isReadOnly(rm));
  bar.hidden = !m;
  if (!m) return;
  const lock = m.lock || {};
  const status = m.connecting ? 'Connecting to the share…' : m.error ? 'Problem: ' + m.error : lock.held ? (m.dirty ? 'You are editing · saving…' : 'You are editing' + (m.savedAt ? ' · saved ' + new Date(m.savedAt).toLocaleTimeString() : ''))
    : 'Read-only · ' + describeLock(lock).replace(/^./, c => c.toUpperCase()) + (m.savedBy ? ` · last saved by ${m.savedBy}${m.savedAt ? ' ' + new Date(m.savedAt).toLocaleString() : ''}` : '');
  put(bar, h('span', { class: 'sharedtag', text: 'SHARED' }), h('span', { class: 'sharedpath', title: m.path, text: m.path }), h('span', { class: 'sharedstatus', text: status }), h('span', { class: 'spacer' }),
    lock.held ? h('button', { class: 'btn small', onclick: () => releaseLock(rm) }, icon('unlock'), 'Release')
      : h('button', { class: 'btn small primary', disabled: !(lock.free || lock.stale), onclick: () => takeOver(rm) }, icon('lock'), lock.stale ? 'Take over (editor not responding)' : 'Take over editing'),
    !lock.held ? h('button', { class: 'btn small' + (m.notify ? ' on' : ''), title: 'Take over automatically as soon as it is free', onclick: () => { m.notify = !m.notify; emit(); } }, icon('bell'), 'Notify me') : null,
    h('button', { class: 'btn small', title: 'Copy this roadmap into your local list', onclick: () => keepLocalCopy(rm) }, icon('dup'), 'Local copy'));
}
