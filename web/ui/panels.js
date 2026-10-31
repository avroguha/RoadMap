// Everything around the timeline: tabs, toolbar, outline, inspector, insights, menus, dialogs.

import { h, s, icon, UNITS, MONTHS, segments, toDay, fromDay, today, clamp, clone, niceDate, mix } from './util.js';
import { THEMES, themeById, PRIORITIES, priorityById, PRIORITY_STYLES, PLACEHOLDER_STYLES, STATUSES, statusById, LABEL_POSITIONS, SHAPES, BAR_SHAPES, BAR_FILLS, PROGRESS_STYLES, COLOR_BY, DENSITIES } from './themes.js';
import { state, api, active, find, selected, select, change, begin, commit, emit, save, undo, redo, canUndo, canRedo, snapshot, newRoadmap, sampleRoadmap, isReadOnly, canComment, meta,
  normalise, reidentify, addLane, addSub, addItem, addMarker, renameGroup, addDep, removeDep, DEP_TYPES, depGap, countConflicts, removeSelected, duplicateSelected, toggleHidden, move, eachItem, itemStart, itemEnd } from './store.js';
import { laneColor } from './timeline.js';
import * as io from './io.js';
import { renderRibbon } from './ribbon.js';
import { avatar, addComment, resolveComment, deleteComment } from './collab.js';

const $ = id => document.getElementById(id);
// DOM append() prints arrays and null as text; put() flattens and skips them like h() does.
const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter(k => k != null && k !== false));

// ---- toast / menu / modal -------------------------------------------------

let toastTimer = 0;
export function toast(msg, isError = false) {
  const el = $('toast'); el.textContent = msg; el.className = 'toast' + (isError ? ' err' : ''); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2600);
}
export async function attempt(fn, okMsg) {
  try { const r = await fn(); if (r === null) return; toast(typeof okMsg === 'function' ? okMsg(r) : typeof r === 'string' && !okMsg ? r : okMsg || 'Done'); }
  catch (e) { console.error(e); toast(e.message || String(e), true); }
}

export function openMenu(at, items) {
  const menu = $('menu'); menu.replaceChildren();
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') menu.append(h('hr'));
    else if (it.head) menu.append(h('div', { class: 'mh', text: it.head }));
    else if (it.node) menu.append(it.node);
    else menu.append(h('button', { class: it.danger ? 'danger' : '', disabled: it.disabled, onclick: () => { closeMenu(); it.onClick(); } }, it.icon ? icon(it.icon) : null, it.content || it.label));
  }
  menu.hidden = false;
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, bottom: at.y, right: at.x };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = clamp(at.alignRight ? r.right - mw : r.left, 8, innerWidth - mw - 8) + 'px';
  menu.style.top = clamp(r.bottom + 6, 8, Math.max(8, innerHeight - mh - 8)) + 'px';
}
export const closeMenu = () => ($('menu').hidden = true);
window.addEventListener('pointerdown', e => { if (!$('menu').hidden && !$('menu').contains(e.target)) closeMenu(); }, true);

export function dialog(title, body, buttons, wide = false) {
  return new Promise(resolve => {
    const modal = $('modal');
    const close = v => { modal.hidden = true; modal.replaceChildren(); window.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(undefined); } };
    window.addEventListener('keydown', onKey, true);
    modal.replaceChildren(h('div', { class: 'dialog' + (wide ? ' wide' : '') }, h('h2', { text: title }), h('div', { class: 'body' }, body),
      h('div', { class: 'foot' }, buttons.map(b => h('button', { class: 'btn ' + (b.cls || ''), onclick: () => close(b.value?.()) }, b.label)))));
    modal.hidden = false;
    modal.onpointerdown = e => { if (e.target === modal) close(undefined); };
    setTimeout(() => modal.querySelector('input,textarea')?.select?.(), 30);
  });
}
export function askText(title, value = '', label = 'Name') {
  const input = h('input', { type: 'text', value });
  const p = dialog(title, h('div', { class: 'field' }, h('label', { text: label }), input), [{ label: 'Cancel' }, { label: 'OK', cls: 'primary', value: () => input.value.trim() }]);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') $('modal').querySelector('.btn.primary').click(); });
  return p;
}
export const confirmBox = (title, text, okLabel = 'OK', danger = false) =>
  dialog(title, h('p', { text }), [{ label: 'Cancel' }, { label: okLabel, cls: danger ? 'primary danger-bg' : 'primary', value: () => true }]);

// ---- small control builders -----------------------------------------------

export const field = (label, control, cls = '') => h('div', { class: 'field ' + cls }, h('label', { text: label }), control);
export function selectBox(options, value, onPick) {
  const el = h('select', {}, options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
  el.addEventListener('change', () => { el.blur(); onPick(el.value); });
  return el;
}
export function seg(options, value, onPick) {
  return h('div', { class: 'seg' }, options.map(([v, t]) => h('button', { class: v === value ? 'on' : '', type: 'button', onclick: () => onPick(v) }, t)));
}
export function check(label, value, onPick) {
  const box = h('input', { type: 'checkbox', checked: !!value });
  box.addEventListener('change', () => onPick(box.checked));
  return h('label', { class: 'check' }, box, label);
}
const setView = (key, value) => change(() => { active().view[key] = value; });

// ---- outline --------------------------------------------------------------

let dragInfo = null;
function renderOutline() {
  const rm = active(), body = h('div', { class: 'panel-body' });
  const eye = o => h('button', { class: 'mini', title: o.hidden ? 'Show' : 'Hide', onmousedown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); toggleHidden(o.id); } }, icon(o.hidden ? 'eyeoff' : 'eye'));
  const plus = (title, fn) => h('button', { class: 'mini', title, onmousedown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); fn(); } }, icon('plus'));

  const row = (type, o, parentId, cls, kids) => {
    const el = h('div', { class: `tree-row ${type} ${cls}` + (state.sel?.id === o.id ? ' sel' : '') + (o.hidden ? ' dim' : ''), draggable: true }, kids);
    el.addEventListener('mousedown', () => { if (state.sel?.id !== o.id) select({ type, id: o.id }); });
    el.addEventListener('dragstart', e => { dragInfo = { type, id: o.id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', o.id); });
    el.addEventListener('dragend', () => { dragInfo = null; });
    // A row accepts its own kind (drop before it) or its child kind (drop into it).
    const mode = () => (!dragInfo || dragInfo.id === o.id ? null : dragInfo.type === type ? 'before'
      : (dragInfo.type === 'sub' && type === 'lane') || (dragInfo.type === 'item' && type === 'sub') ? 'into' : null);
    el.addEventListener('dragover', e => { const m = mode(); if (!m) return; e.preventDefault(); el.classList.add('drop-' + m); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-into'));
    el.addEventListener('drop', e => { const m = mode(); el.classList.remove('drop-before', 'drop-into'); if (!m) return; e.preventDefault();
      if (m === 'before') move(dragInfo.id, parentId, o.id); else move(dragInfo.id, o.id, null); });
    return el;
  };

  if (rm.markers.length) {
    body.append(h('div', { class: 'tree-head', text: 'Key dates' }));
    for (const m of [...rm.markers].sort((a, b) => toDay(a.date) - toDay(b.date))) {
      const el = h('div', { class: 'tree-row' + (state.sel?.id === m.id ? ' sel' : '') + (m.hidden ? ' dim' : '') }, h('span', { class: 'swatch ms', style: `background:${m.color || 'var(--text)'}` }),
        h('span', { class: 'name', text: m.name || 'Key date' }), h('span', { class: 'pct', text: niceDate(toDay(m.date)) }), h('span', { class: 'tools' }, eye(m)));
      el.addEventListener('mousedown', () => { if (state.sel?.id !== m.id) select({ type: 'marker', id: m.id }); });
      body.append(el);
    }
    body.append(h('div', { class: 'tree-head', text: 'Swimlanes' }));
  }
  let lastGroup = null;
  rm.lanes.forEach((lane, li) => {
    const color = laneColor(rm, lane, li);
    if (lane.group !== lastGroup && (lane.group || lastGroup)) body.append(h('div', { class: 'tree-group', title: 'Initiative - double-click to rename', ondblclick: () => lane.group && groupDialog(lane.group) },
      lane.group || 'No initiative'));
    lastGroup = lane.group;
    body.append(row('lane', lane, null, '', [h('span', { class: 'swatch', style: `background:${color}` }), h('span', { class: 'name', text: lane.name || 'Untitled swimlane' }),
      h('span', { class: 'tools' }, plus('Add sub-swimlane', () => addSub(lane.id)), eye(lane))]));
    for (const sub of lane.subs) {
      body.append(row('sub', sub, lane.id, '', [h('span', { class: 'name', text: sub.name || '(no sub-swimlane title)' }),
        h('span', { class: 'tools' }, plus('Add task', () => addItem('task', sub.id)), eye(sub))]));
      for (const it of sub.items) {
        body.append(row('item', it, sub.id, '', [h('span', { class: 'swatch' + (it.type === 'milestone' ? ' ms' : ''), style: `background:${it.color || color}` }),
          h('span', { class: 'name', style: it.placeholder ? 'font-style:italic' : '', title: it.placeholder ? 'Placeholder - not scoped yet' : '', text: it.name || 'Untitled' }), it.type === 'task' ? h('span', { class: 'pct', text: it.progress + '%' }) : null, h('span', { class: 'tools' }, eye(it))]));
      }
    }
  });
  if (!rm.lanes.length) body.append(h('div', { class: 'empty', text: 'No swimlanes yet. Add one to start laying out the roadmap.' }));
  const scrollTop = $('outline').querySelector('.panel-body')?.scrollTop || 0;
  $('outline').replaceChildren(h('div', { class: 'panel-head' }, 'Outline', h('div', { class: 'spacer' }),
    h('button', { class: 'btn small', onclick: addLane }, icon('plus'), 'Swimlane')), body);
  body.scrollTop = scrollTop;
}

// ---- inspector ------------------------------------------------------------

let editing = false, inspectorKey = '';
function flushEdit() { if (editing) { editing = false; commit(); } }

function textInput(obj, key, { area = false, placeholder = '' } = {}) {
  const el = h(area ? 'textarea' : 'input', { type: area ? null : 'text', value: obj[key] ?? '', placeholder });
  el.addEventListener('input', () => { if (!editing) { begin(); editing = true; } obj[key] = el.value; emit('live'); });
  el.addEventListener('change', () => { skipInspector = true; flushEdit(); skipInspector = false; });
  if (!area) el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
  return el;
}
let skipInspector = false;

function colorRow(obj, fallback) {
  const pal = themeById(active().view.theme).palette;
  const custom = h('input', { type: 'color', value: obj.color || fallback, title: 'Custom colour' });
  custom.addEventListener('input', () => { if (!editing) { begin(); editing = true; } obj.color = custom.value; emit('live'); });
  custom.addEventListener('change', () => flushEdit());
  return h('div', { class: 'swatches' },
    h('button', { class: 'sw none' + (!obj.color ? ' on' : ''), title: 'Automatic', onclick: () => change(() => { obj.color = ''; }) }),
    pal.map(c => h('button', { class: 'sw' + (obj.color === c ? ' on' : ''), style: `background:${c}`, onclick: () => change(() => { obj.color = c; }) })), custom);
}

function renderInspector(force = false) {
  const box = $('inspector'), f = selected();
  const key = f ? f.type + f.obj.id : '';
  if (skipInspector && key === inspectorKey && !force) return;
  flushEdit();
  inspectorKey = key;
  const head = (title, extra) => h('div', { class: 'panel-head' }, title, h('div', { class: 'spacer' }), extra);
  const tools = h('span', {}, h('button', { class: 'mini', title: 'Duplicate (Ctrl+D)', onclick: duplicateSelected }, icon('dup')),
    h('button', { class: 'mini', title: 'Delete (Del)', onclick: removeSelected }, icon('trash')));

  if (!f) {
    box.replaceChildren(head('Details'), h('div', { class: 'panel-body' }, h('div', { class: 'empty' },
      h('p', { text: 'Select a task, milestone or swimlane to edit it.' }),
      h('p', { html: '<b>On the timeline</b><br>Drag a bar to move it, its ends to resize it, the round handle to set % complete.<br>Drag a label - or the small “Aa” handle on a selected task - to choose where the text sits: inside, left, right, above or below.<br>Drag a bar onto another sub-swimlane to move it there.<br>Drag the round → handle of a selected item onto another item to make that one depend on it; right-click an arrow to change or remove it.<br>Drag swimlane titles to reorder them; double-click an initiative (far left) to rename it.<br>Drag a key date’s label to move its line.<br>Double-click an empty row to add a task; right-click for more.' }))));
    return;
  }
  const form = h('div', { class: 'form' + (isReadOnly() ? ' readonly' : '') });
  if (f.type === 'marker') {
    const m = f.marker, date = h('input', { type: 'date', value: m.date });
    date.addEventListener('change', () => { if (date.value) change(() => { m.date = date.value; }); });
    put(form, field('Name', textInput(m, 'name', { placeholder: 'e.g. UAT release' })), field('Date', date),
      field('Line', seg([['solid', 'Solid'], ['dashed', 'Dashed']], m.line, val => change(() => { m.line = val; }))),
      field('Colour', colorRow(m, themeById(active().view.theme).head1)),
      check('Hidden on the timeline', m.hidden, () => toggleHidden(m.id)),
      h('p', { class: 'empty', style: 'padding:4px 2px', text: 'A key date is drawn as a line across every swimlane, with its label under the header. Drag the label to move it.' }));
    box.replaceChildren(head('Key date', tools), h('div', { class: 'panel-body' }, form));
  } else if (f.type === 'item') {
    const it = f.item, rm = active();
    const date = (key, label) => { const el = h('input', { type: 'date', value: it[key] });
      el.addEventListener('change', () => { if (!el.value) return; change(() => { it[key] = el.value;
        if (it.type === 'task' && toDay(it.end) < toDay(it.start)) { if (key === 'start') it.end = it.start; else it.start = it.end; } }); });
      return field(label, el); };
    const pct = h('input', { type: 'range', min: 0, max: 100, step: 5, value: it.progress });
    const pctLabel = h('label', { text: `% complete · ${it.progress}%` });
    pct.addEventListener('input', () => { if (!editing) { begin(); editing = true; } it.progress = +pct.value; pctLabel.textContent = `% complete · ${it.progress}%`; emit('live'); });
    pct.addEventListener('change', () => { skipInspector = true; flushEdit(); skipInspector = false; });
    const where = selectBox(rm.lanes.flatMap(l => l.subs.map(sb => [sb.id, l.name + (sb.name ? ' › ' + sb.name : '')])), f.sub.id, val => move(it.id, val, null));
    put(form, 
      field('Name', textInput(it, 'name')),
      seg([['task', 'Task'], ['milestone', 'Milestone']], it.type, val => change(() => {
        if (val === it.type) return;
        // Remember the task's length while it is a milestone, so switching back restores the range
        // (from the milestone's date, in case it was moved meanwhile).
        if (val === 'milestone') { it.span = toDay(it.end) - toDay(it.start); it.date = it.start; it.shape ||= 'diamond'; delete it.start; delete it.end; }
        else { it.start = it.date; it.end = fromDay(toDay(it.date) + (Number.isFinite(it.span) && it.span >= 0 ? it.span : 13)); delete it.date; delete it.span; }
        it.type = val; })),
      it.type === 'task' ? h('div', { class: 'two' }, date('start', 'Start'), date('end', 'End')) : date('date', 'Date'),
      it.type === 'task' ? h('div', { class: 'field' }, pctLabel, pct) : field('Shape', selectBox(SHAPES, it.shape, val => change(() => { it.shape = val; }))),
      field('Status', selectBox(STATUSES.map(x => [x.id, x.name]), it.status, val => change(() => { it.status = val; if (val === 'done' && it.type === 'task') it.progress = 100; }))),
      field('Priority', seg(PRIORITIES.map(x => [x.id, x.short || 'None']), it.priority, val => change(() => { it.priority = val; }))),
      field('Resources needed', textInput(it, 'resources', { placeholder: 'e.g. 2 Backend, 1 QA' })),
      field('Swimlane', where),
      field('Depends on', (() => {
        const others = []; eachItem(rm, (o, sb, ln) => { if (o.id !== it.id && !it.deps.some(d => d.id === o.id)) others.push([o.id, `${ln.name} › ${o.name}`]); });
        const rows = it.deps.map(d => { const p = find(d.id)?.item; if (!p) return null; const late = depGap(p, it, d.type);
          return h('div', { class: 'dep-row' + (late > 0 ? ' late' : '') }, h('span', { class: 'n', title: p.name, text: p.name + (late > 0 ? ` · ${late}d too early` : '') }),
            selectBox(DEP_TYPES.map(t => [t[0], t[0]]), d.type, val => change(() => { d.type = val; })),
            h('button', { class: 'mini', title: 'Remove link', onclick: () => removeDep(d.id, it.id) }, icon('trash'))); });
        const add = selectBox([['', '+ Add a predecessor…'], ...others], '', val => { if (!val) return; const err = addDep(val, it.id); if (err) toast(err, true); });
        return h('div', { class: 'deps' }, rows, add);
      })()),
      (() => { const blocks = []; eachItem(rm, o => { if (o.deps.some(d => d.id === it.id)) blocks.push(o.name); });
        return blocks.length ? h('div', { class: 'meta-note', text: 'Blocks: ' + blocks.join(', ') }) : null; })(),
      field('Label position', seg([['', 'Auto'], ...LABEL_POSITIONS.filter(p => it.type === 'task' || p[0] !== 'inside')], it.labelPos, val => change(() => { it.labelPos = val; }))),
      field('Colour', colorRow(it, laneColor(rm, f.lane, rm.lanes.indexOf(f.lane)))),
      field('Notes', textInput(it, 'notes', { area: true })),
      check('Placeholder - not scoped yet', it.placeholder, () => change(() => { it.placeholder = !it.placeholder; })),
      check('Hidden on the timeline', it.hidden, () => toggleHidden(it.id)));
    box.replaceChildren(head(it.type === 'task' ? 'Task' : 'Milestone', tools), h('div', { class: 'panel-body' }, form, commentsBlock(it)));
  } else if (f.type === 'sub') {
    put(form, field('Sub-swimlane title', textInput(f.sub, 'name', { placeholder: 'Leave empty to merge with the swimlane' })),
      field('Colour', colorRow(f.sub, laneColor(active(), f.lane, active().lanes.indexOf(f.lane)))),
      check('Hidden on the timeline', f.sub.hidden, () => toggleHidden(f.sub.id)),
      h('div', { class: 'two' }, h('button', { class: 'btn', onclick: () => addItem('task', f.sub.id) }, icon('task'), 'Task'), h('button', { class: 'btn', onclick: () => addItem('milestone', f.sub.id) }, icon('diamond'), 'Milestone')));
    box.replaceChildren(head('Sub-swimlane', tools), h('div', { class: 'panel-body' }, form));
  } else {
    const rm = active();
    const groups = [...new Set(rm.lanes.map(l => l.group).filter(Boolean))];
    const groupInput = textInput(f.lane, 'group', { placeholder: 'e.g. Customer platform' });
    groupInput.setAttribute('list', 'groupNames');
    put(form, field('Swimlane title', textInput(f.lane, 'name')),
      field('Initiative (groups swimlanes)', h('div', {}, groupInput, h('datalist', { id: 'groupNames' }, groups.map(g => h('option', { value: g }))))), field('Colour', colorRow(f.lane, laneColor(rm, f.lane, rm.lanes.indexOf(f.lane)))),
      check('Hidden on the timeline', f.lane.hidden, () => toggleHidden(f.lane.id)),
      h('button', { class: 'btn', onclick: () => addSub(f.lane.id) }, icon('plus'), 'Sub-swimlane'),
      h('p', { class: 'empty', style: 'padding:4px 2px', text: 'Neighbouring swimlanes with the same initiative share one tall title on the far left. A swimlane with several sub-swimlanes shows its own title vertically across them.' }));
    box.replaceChildren(head('Swimlane', tools), h('div', { class: 'panel-body' }, form));
  }
}
// Comments on the selected item. The draft survives a re-render (a colleague's
// comment arriving while you type).
let draftComment = { id: '', text: '' };
function commentsBlock(it) {
  const rm = active(), all = (state.comments || []).filter(c => c.itemId === it.id);
  const can = canComment(rm), owner = meta(rm).role === 'owner';
  const fmt = t => new Date(t).toLocaleString();
  const rows = all.map(c => h('div', { class: 'comment' + (c.resolved ? ' resolved' : '') }, avatar(c.user), h('div', { class: 'cbody' },
    h('div', { class: 'chead' }, h('b', { text: c.user.name || c.user.email }), h('span', { text: fmt(c.at) }), c.resolved ? h('span', { class: 'ctag', text: 'resolved' }) : null),
    h('div', { class: 'ctext', text: c.body }),
    can ? h('div', { class: 'cactions' },
      h('button', { class: 'mini', title: c.resolved ? 'Reopen' : 'Mark resolved', onclick: () => resolveComment(c.id, !c.resolved).catch(e => toast(e.message, true)) }, icon(c.resolved ? 'undo' : 'check')),
      owner || c.mine ? h('button', { class: 'mini', title: owner && !c.mine ? 'Remove (you own this roadmap)' : 'Remove', onclick: () => deleteComment(c.id).catch(e => toast(e.message, true)) }, icon('trash')) : null) : null)));
  const ta = h('textarea', { placeholder: 'Write a comment… Ctrl+Enter posts it', rows: 2 });
  if (draftComment.id === it.id) ta.value = draftComment.text;
  ta.addEventListener('input', () => { draftComment = { id: it.id, text: ta.value }; });
  const post = async () => { const t = ta.value.trim(); if (!t) return; try { await addComment(it.id, t); draftComment = { id: '', text: '' }; } catch (e) { toast(e.message, true); } };
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } });
  const open = all.filter(c => !c.resolved).length;
  return h('div', { class: 'comments' }, h('div', { class: 'lbl', text: `Comments${all.length ? ` (${open} open)` : ''}` }),
    rows.length ? rows : h('div', { class: 'empty', style: 'padding:4px 2px', text: can ? 'No comments yet. Comments are never part of an image or export.' : 'No comments.' }),
    can ? h('div', { class: 'cnew' }, ta, h('div', { style: 'display:flex;justify-content:flex-end' }, h('button', { class: 'btn small primary', onclick: post }, 'Comment'))) : null);
}

export function focusName() { renderInspector(true); const el = $('inspector').querySelector('input[type=text]'); el?.focus(); el?.select(); }

// ---- charts ---------------------------------------------------------------

function parseResources(text) {
  return text.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(\d+(?:\.\d+)?)\s*[x×]?\s*(.+)$/i);
    return m ? { name: m[2].trim(), qty: +m[1] } : { name: part, qty: 1 };
  });
}

const CHARTS = [['overall', 'Overall progress'], ['status', 'Status'], ['lanes', 'Progress by swimlane'], ['workload', 'Workload over time'],
  ['resources', 'Resources needed'], ['demand', 'Resource demand over time'], ['upcoming', 'Next milestones'], ['priority', 'Priority']];
let chartDrag = null;

function chartSettings() {
  const st = state.ws.settings;
  st.charts ||= { order: [], hidden: [] };
  const known = CHARTS.map(c => c[0]);
  st.charts.order = [...st.charts.order.filter(id => known.includes(id)), ...known.filter(id => !st.charts.order.includes(id))];
  st.charts.hidden = (st.charts.hidden || []).filter(id => known.includes(id));
  return st.charts;
}

// While a value is being dragged, redraw the charts at most every 150 ms:
// they are the most expensive panel and nobody reads them mid-drag.
let insightsTimer = 0;
function renderInsightsSoon() {
  clearTimeout(insightsTimer);
  insightsTimer = setTimeout(renderInsights, 150);
}

function renderInsights() {
  const box = $('insights'), grip = $('insightsGrip'), st = state.ws.settings;
  box.hidden = grip.hidden = !st.insights;
  if (box.hidden) return;
  box.style.height = clamp(+st.insightsH || 220, 150, 520) + 'px';
  const rm = active(), cfg = chartSettings(), now = today();
  const d0 = toDay(rm.start), d1 = toDay(rm.end) + 1;

  // -- gather
  let wSum = 0, wDone = 0, wExpected = 0, tasks = 0, placeholders = 0;
  const byStatus = new Map(), byPrio = new Map(), byLane = new Map(), res = new Map(), milestones = [], visible = [];
  eachItem(rm, (it, sub, lane, li) => {
    if (it.hidden || sub.hidden || lane.hidden) return;
    byStatus.set(it.status, (byStatus.get(it.status) || 0) + 1);
    const P = byPrio.get(it.priority) || { n: 0, open: 0 }; P.n++; if (it.type === 'task' ? it.progress < 100 : toDay(it.date) >= now) P.open++; byPrio.set(it.priority, P);
    const color = laneColor(rm, lane, li);
    if (it.type === 'milestone') { milestones.push({ d: toDay(it.date), name: it.name, color: it.color || color }); return; }
    if (it.placeholder) { placeholders++; return; }
    tasks++;
    const a = itemStart(it), b = itemEnd(it), w = b - a + 1, expected = clamp((now - a + 1) / w, 0, 1);
    wSum += w; wDone += w * it.progress / 100; wExpected += w * expected;
    const L = byLane.get(lane.id) || { id: lane.id, name: lane.name, color, w: 0, done: 0, expected: 0 };
    L.w += w; L.done += w * it.progress / 100; L.expected += w * expected; byLane.set(lane.id, L);
    const parsed = parseResources(it.resources);
    for (const r of parsed) { const k = r.name.toLowerCase(); const cur = res.get(k) || { name: r.name, qty: 0 }; cur.qty += r.qty; res.set(k, cur); }
    visible.push({ a, b, laneId: lane.id, qty: parsed.reduce((n, r) => n + r.qty, 0) });
  });
  for (const m of rm.markers) if (!m.hidden) milestones.push({ d: toDay(m.date), name: '★ ' + m.name, color: m.color || 'var(--text)', key: true });
  const pct = (done, w) => (w ? Math.round(done / w * 100) : 0);
  const overall = pct(wDone, wSum), expectedAll = pct(wExpected, wSum), conflicts = countConflicts(rm);
  const lanes = [...byLane.values()];

  // -- time buckets for the two "over time" charts
  const months = segments('month', d0, d1, 0);
  const buckets = (months.length > 30 ? segments('quarter', d0, d1, +rm.view.fiscal || 0) : months).map(g => {
    const per = new Map(); let qty = 0;
    for (const t of visible) if (t.b >= g.a && t.a < g.b) { per.set(t.laneId, (per.get(t.laneId) || 0) + 1); qty += t.qty; }
    return { label: g.short, full: g.full, per, total: [...per.values()].reduce((x, y) => x + y, 0), qty, current: now >= g.a && now < g.b };
  });
  const axis = () => h('div', { class: 'cols-axis' }, buckets.map((b, i) => h('span', { class: b.current ? 'now' : '', text: buckets.length > 16 && i % 2 ? '' : b.label })));
  const none = text => h('div', { class: 'empty', style: 'padding:0', text });

  const bars = rows => h('div', { class: 'bars' }, rows.length ? rows.map(r => h('div', { class: 'bar-row', title: r.title || '' }, h('span', { class: 'n', text: r.name }),
    h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${r.pct}%;background:${r.color}` }), r.mark != null ? h('span', { class: 'mark', style: `left:${r.mark}%` }) : null),
    h('span', { class: 'v', text: r.label }))) : none('Nothing to show yet'));

  const build = {
    overall() {
      const R = 40, C = 2 * Math.PI * R, behind = expectedAll - overall;
      const ring = s('svg', { width: 104, height: 104, viewBox: '0 0 104 104' },
        s('circle', { cx: 52, cy: 52, r: R, fill: 'none', stroke: 'var(--card-2)', 'stroke-width': 12 }),
        s('circle', { cx: 52, cy: 52, r: R, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': `${overall / 100 * C} ${C}`, transform: 'rotate(-90 52 52)' }),
        s('text', { x: 52, y: 59, 'text-anchor': 'middle', 'font-size': 21, 'font-weight': 700, fill: 'currentColor' }, overall + '%'));
      return h('div', { class: 'donut-wrap' }, ring, h('div', { class: 'legend' },
        h('div', { text: `${tasks} tasks · ${milestones.filter(m => !m.key).length} milestones` }),
        placeholders ? h('div', { class: 'meta', text: `${placeholders} placeholder${placeholders === 1 ? '' : 's'} not counted` }) : null,
        h('div', { style: `font-weight:700;color:${behind > 5 ? 'var(--danger)' : '#22a36b'}`,
          title: `${overall}% of the work is done. By today ${expectedAll}% should be, because each task counts for as many days as it lasts and is credited for the days that have passed. The gap is ${Math.abs(behind)}%.`,
          text: !tasks ? '' : `${behind > 5 ? 'Behind plan' : behind < -5 ? 'Ahead of plan' : 'On plan'} · ${expectedAll}% expected by today` }),
        conflicts ? h('div', { style: 'font-weight:700;color:var(--danger)', text: `${conflicts} dependency conflict${conflicts === 1 ? '' : 's'}` }) : h('div', { class: 'meta', title: 'Each task counts for as many days as it lasts, and is credited for the days that have already passed. A 3-month task therefore weighs three times a 1-month one.', text: 'Weighted by task duration' })));
    },
    status() {
      const total = [...byStatus.values()].reduce((a, b) => a + b, 0), R = 38, C = 2 * Math.PI * R;
      if (!total) return none('Nothing to show yet');
      let offset = 0;
      const donut = s('svg', { width: 100, height: 100, viewBox: '0 0 100 100' }, s('circle', { cx: 50, cy: 50, r: R, fill: 'none', stroke: 'var(--card-2)', 'stroke-width': 13 }));
      const legend = h('div', { class: 'legend' });
      for (const x of STATUSES) {
        const n = byStatus.get(x.id); if (!n) continue;
        const len = n / total * C;
        donut.append(s('circle', { cx: 50, cy: 50, r: R, fill: 'none', stroke: x.color, 'stroke-width': 13, 'stroke-dasharray': `${Math.max(0, len - 1.5)} ${C}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 50 50)' },
          s('title', {}, `${x.name}: ${n}`)));
        offset += len;
        legend.append(h('div', {}, h('i', { style: `background:${x.color}` }), `${x.name} · ${n}`));
      }
      donut.append(s('text', { x: 50, y: 56, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 700, fill: 'currentColor' }, String(total)));
      return h('div', { class: 'donut-wrap' }, donut, legend);
    },
    lanes: () => h('div', { class: 'chart-fill' }, bars(lanes.map(L => ({ name: L.name, pct: pct(L.done, L.w), mark: pct(L.expected, L.w), color: L.color, label: pct(L.done, L.w) + '%',
      title: `${L.name}: ${pct(L.done, L.w)}% done, ${pct(L.expected, L.w)}% expected by today` }))), lanes.length ? h('div', { class: 'meta', text: '▏ marker = expected by today' }) : null),
    workload() {
      const max = Math.max(1, ...buckets.map(b => b.total));
      if (!visible.length) return none('Add tasks to see how busy each month is');
      return h('div', { class: 'chart-fill' }, h('div', { class: 'cols' }, buckets.map(b => h('div', { class: 'col' + (b.current ? ' now' : ''), title: `${b.full}: ${b.total} active task${b.total === 1 ? '' : 's'}` },
        h('span', { class: 'cv', text: b.total || '' }),
        lanes.filter(L => b.per.get(L.id)).map(L => h('i', { style: `height:${b.per.get(L.id) / max * 100}%;background:${L.color}`, title: `${b.full} · ${L.name}: ${b.per.get(L.id)}` }))))), axis(),
        h('div', { class: 'legend row' }, lanes.map(L => h('div', {}, h('i', { style: `background:${L.color}` }), L.name))));
    },
    resources() {
      const rows = [...res.values()].sort((a, b) => b.qty - a.qty), max = Math.max(1, ...rows.map(r => r.qty));
      return rows.length ? bars(rows.map(r => ({ name: r.name, pct: r.qty / max * 100, color: 'var(--accent)', label: String(+r.qty.toFixed(1)), title: `${r.name}: ${+r.qty.toFixed(1)} across all tasks` })))
        : none('Fill in "Resources needed" on tasks, e.g. "2 Backend, 1 QA"');
    },
    demand() {
      const max = Math.max(...buckets.map(b => b.qty));
      if (!(max > 0)) return none('Fill in "Resources needed" to see demand per month');
      const n = buckets.length, pts = buckets.map((b, i) => [(i + .5) / n * 100, 100 - b.qty / max * 92]);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('');
      const svg = s('svg', { class: 'area', viewBox: '0 0 100 100', preserveAspectRatio: 'none' },
        s('path', { d: `${line}L${pts[n - 1][0]},100L${pts[0][0]},100Z`, fill: 'var(--accent)', opacity: .16 }),
        s('path', { d: line, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
      return h('div', { class: 'chart-fill' }, h('div', { class: 'area-wrap' }, svg,
        h('div', { class: 'cols ghost' }, buckets.map(b => h('div', { class: 'col' + (b.current ? ' now' : ''), title: `${b.full}: ${+b.qty.toFixed(1)} people needed` }, h('span', { class: 'cv', text: b.qty ? +b.qty.toFixed(1) : '' }))))), axis(),
        h('div', { class: 'meta', text: `Peak ${+max.toFixed(1)} · people needed at the same time` }));
    },
    priority() {
      const rows = PRIORITIES.filter(x => byPrio.get(x.id)), max = Math.max(1, ...rows.map(x => byPrio.get(x.id).n));
      if (!rows.some(x => x.id)) return none('Give tasks a priority (details panel or right-click) to see the split here');
      return h('div', { class: 'chart-fill' }, bars(rows.map(x => { const P = byPrio.get(x.id); return { name: (x.short ? x.short + ' ' : '') + x.name, pct: P.n / max * 100, color: x.color,
        label: `${P.open}/${P.n}`, title: `${x.name}: ${P.n} items, ${P.open} still open` }; })), h('div', { class: 'meta', text: 'open / total' }));
    },
    upcoming() {
      const next = milestones.filter(m => m.d >= now).sort((a, b) => a.d - b.d).slice(0, 8);
      return next.length ? h('div', { class: 'bars' }, next.map(m => h('div', { class: 'ms-row' }, h('i', { style: `background:${m.color}` }),
        h('span', { class: 'n', title: m.name, text: m.name }), h('span', { class: 'v', text: m.d === now ? 'today' : `${niceDate(m.d)} · ${m.d - now}d` })))) : none('No upcoming milestones');
    },
  };

  const cards = cfg.order.filter(id => !cfg.hidden.includes(id)).map(id => {
    const card = h('div', { class: 'card chart', draggable: true },
      h('h3', { title: 'Drag to rearrange' }, h('span', { class: 'grab', text: '⋮⋮' }), CHARTS.find(c => c[0] === id)[1], h('span', { class: 'spacer' }),
        h('button', { class: 'mini', title: 'Hide this chart', onclick: () => { cfg.hidden.push(id); save(); renderInsights(); } }, icon('eyeoff'))),
      build[id]());
    card.addEventListener('dragstart', e => { chartDrag = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); card.classList.add('dragging-card'); });
    card.addEventListener('dragend', () => { chartDrag = null; card.classList.remove('dragging-card'); });
    card.addEventListener('dragover', e => { if (!chartDrag || chartDrag === id) return; e.preventDefault();
      const r = card.getBoundingClientRect(); card.classList.toggle('drop-left', e.clientX < r.left + r.width / 2); card.classList.toggle('drop-right', e.clientX >= r.left + r.width / 2); });
    card.addEventListener('dragleave', () => card.classList.remove('drop-left', 'drop-right'));
    card.addEventListener('drop', e => { if (!chartDrag || chartDrag === id) return; e.preventDefault();
      const r = card.getBoundingClientRect(), after = e.clientX >= r.left + r.width / 2;
      cfg.order.splice(cfg.order.indexOf(chartDrag), 1); cfg.order.splice(cfg.order.indexOf(id) + (after ? 1 : 0), 0, chartDrag);
      chartDrag = null; save(); renderInsights(); });
    return card;
  });
  if (cfg.hidden.length) cards.push(h('div', { class: 'card chart add' }, h('h3', { text: 'Hidden charts' }),
    h('div', { class: 'bars' }, cfg.hidden.map(id => h('button', { class: 'btn small', onclick: () => { cfg.hidden.splice(cfg.hidden.indexOf(id), 1); save(); renderInsights(); } }, icon('plus'), CHARTS.find(c => c[0] === id)[1])))));
  const scrollLeft = box.scrollLeft;
  box.replaceChildren(...cards);
  box.scrollLeft = scrollLeft;
}

// The grip between the timeline and the charts resizes the chart row.
export function mountInsightsGrip() {
  const grip = $('insightsGrip');
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startY = e.clientY, startH = $('insights').offsetHeight;
    const onMove = ev => { state.ws.settings.insightsH = clamp(startH + startY - ev.clientY, 150, Math.min(520, innerHeight - 320)); $('insights').style.height = state.ws.settings.insightsH + 'px'; };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); document.body.classList.remove('resizing'); save(); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); document.body.classList.add('resizing');
  });
}

// ---- history and about ----------------------------------------------------

export function aboutDialog() {
  const i = state.info, me = state.me || {};
  dialog('RoadMap Studio ' + (i.version || ''), h('div', {},
    h('p', { text: 'Swimlane roadmaps with tasks, milestones, progress and resources - shared and edited together, live, and built to be pasted into slides.' }),
    h('p', {}, 'Signed in as ', h('b', { text: me.name || me.email || '' }), me.email ? ` (${me.email})` : '', me.isAdmin ? ' - administrator' : ''),
    h('p', { text: i.authMode === 'dev' ? 'Sign-in: TEST MODE (anyone can sign in as anyone).' : 'Sign-in: Microsoft Entra ID single sign-on.' }),
    h('p', { text: 'Roadmaps are stored on the server, with every version, for everyone they are shared with. Export > Backup downloads all of yours as one file.' }),
    h('a', { class: 'btn', href: '/auth/logout' }, icon('logout'), 'Sign out')), [{ label: 'Close', cls: 'primary' }]);
}

export async function groupDialog(name) {
  const to = await askText('Rename initiative', name, 'Initiative name (empty removes the grouping)');
  if (to !== undefined && to !== name) renameGroup(name, to);
}

// ---- context menu ---------------------------------------------------------

export function contextMenu(e, ctx) {
  if (ctx.dep) {
    const a = find(ctx.dep.from)?.item, b = find(ctx.dep.to)?.item; if (!a || !b) return;
    const link = b.deps.find(d => d.id === a.id);
    return openMenu({ x: e.clientX, y: e.clientY }, [{ head: `${b.name} depends on ${a.name}` },
      ...DEP_TYPES.map(([val, t]) => ({ label: t + (link?.type === val ? '  ✓' : ''), onClick: () => change(() => { link.type = val; }) })),
      'sep', { label: 'Remove dependency', icon: 'trash', danger: true, onClick: () => removeDep(a.id, b.id) }]);
  }
  if (ctx.group) return openMenu({ x: e.clientX, y: e.clientY }, [{ head: 'Initiative · ' + ctx.group }, { label: 'Rename…', icon: 'edit', onClick: () => groupDialog(ctx.group) },
    { label: 'Remove grouping', icon: 'trash', danger: true, onClick: () => renameGroup(ctx.group, '') }]);
  const items = [];
  const f = ctx.target;
  if (f?.type === 'marker') {
    items.push({ label: 'Edit name', icon: 'edit', onClick: focusName }, { label: 'Duplicate', icon: 'dup', onClick: duplicateSelected },
      { label: f.marker.hidden ? 'Show' : 'Hide', icon: 'eyeoff', onClick: () => toggleHidden(f.marker.id) }, 'sep', { label: 'Delete', icon: 'trash', danger: true, onClick: removeSelected });
  } else if (f?.type === 'item') {
    items.push({ label: 'Edit name', icon: 'edit', onClick: focusName }, { label: 'Duplicate', icon: 'dup', onClick: duplicateSelected },
      { label: f.item.hidden ? 'Show' : 'Hide', icon: 'eyeoff', onClick: () => toggleHidden(f.item.id) },
      { label: f.item.placeholder ? 'Mark as scoped (normal)' : 'Mark as placeholder - not scoped', icon: 'task', onClick: () => change(() => { f.item.placeholder = !f.item.placeholder; }) }, { head: 'Label position' },
      ...[['', 'Auto'], ...LABEL_POSITIONS].filter(p => f.item.type === 'task' || p[0] !== 'inside').map(([val, t]) => ({ label: t + (f.item.labelPos === val ? '  ✓' : ''), onClick: () => change(() => { f.item.labelPos = val; }) })),
      { head: 'Status' }, ...STATUSES.map(st => ({ content: h('span', { class: 'theme-row' }, h('span', { class: 'chips' }, h('i', { style: `background:${st.color}` })), st.name + (f.item.status === st.id ? '  ✓' : '')),
        onClick: () => change(() => { f.item.status = st.id; if (st.id === 'done' && f.item.type === 'task') f.item.progress = 100; }) })),
      { head: 'Priority' }, ...PRIORITIES.map(x => ({ content: h('span', { class: 'theme-row' }, h('span', { class: 'chips' }, h('i', { style: `background:${x.color}` })), (x.short ? x.short + ' · ' : '') + x.name + (f.item.priority === x.id ? '  ✓' : '')),
        onClick: () => change(() => { f.item.priority = x.id; }) })),
      'sep', { label: 'Delete', icon: 'trash', danger: true, onClick: removeSelected });
  } else if (f) {
    items.push({ label: 'Rename', icon: 'edit', onClick: focusName },
      f.type === 'lane' ? { label: 'Add sub-swimlane', icon: 'plus', onClick: () => addSub(f.lane.id) } : { label: 'Add task', icon: 'task', onClick: () => addItem('task', f.sub.id) },
      { label: 'Duplicate', icon: 'dup', onClick: duplicateSelected }, { label: f.obj.hidden ? 'Show' : 'Hide', icon: 'eyeoff', onClick: () => toggleHidden(f.obj.id) },
      'sep', { label: 'Delete', icon: 'trash', danger: true, onClick: removeSelected });
  } else {
    if (ctx.sub) items.push({ label: `Add task at ${niceDate(ctx.day)}`, icon: 'task', onClick: () => addItem('task', ctx.sub.id, ctx.day) },
      { label: `Add milestone at ${niceDate(ctx.day)}`, icon: 'diamond', onClick: () => addItem('milestone', ctx.sub.id, ctx.day) },
      { label: `Add key date at ${niceDate(ctx.day)}`, icon: 'flagpole', onClick: () => addMarker(ctx.day) }, 'sep');
    items.push({ label: 'Add swimlane', icon: 'plus', onClick: addLane }, { label: 'Copy timeline image', icon: 'copy', onClick: () => attempt(io.copyImage, 'Timeline image copied - paste it anywhere') });
  }
  openMenu({ x: e.clientX, y: e.clientY }, items);
}

// ---- wiring ---------------------------------------------------------------

export function renderChrome(what) {
  const st = state.ws.settings;
  document.documentElement.dataset.theme = st.appTheme;
  const work = document.querySelector('.work');
  work.classList.toggle('no-outline', !st.outline); work.classList.toggle('no-inspector', !st.inspector);
  if (what === 'save') { renderRibbon(); return; }
  if (what === 'view') return;                      // timeline-only change (zoom, widths)
  if (what === 'live') { renderOutline(); renderInsightsSoon(); return; }
  renderRibbon(); renderOutline(); renderInspector(); renderInsights();
  const n = active().lanes.length;
  $('hint').hidden = !!n;
  $('hint').textContent = n ? '' : 'Start with “+ Swimlane”, then add tasks and milestones.';
}
