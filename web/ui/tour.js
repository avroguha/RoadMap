// The guided tour: builds a small roadmap with the person, one feature at a
// time. Each step puts a spotlight on the button or field to use, says what
// to do, and waits until it has actually been done (checked against the
// roadmap itself, not against clicks) - or does it for them.

import { h, icon, toDay, fromDay, dayOf, ymd, today } from './util.js';
import { state, active, meta, find, select, change, editing, isReadOnly, eachItem, newRoadmap, newLane, newSub, newItem, newMarker,
  addLane, addSub, addItem, addMarker, addDep, save, emit, snapshot } from './store.js';
import { THEMES } from './themes.js';
import { renderChrome, toast } from './panels.js';
import { createRoadmap, switchTo } from './collab.js';

const $ = id => document.getElementById(id);
const TOUR_NAME = 'My tutorial roadmap';

// ---- finding things on the page --------------------------------------------------

const ribbonButton = title => $('ribbon').querySelector(`button[title="${title}"]`);
// A field in the Details panel, by its label text.
function detailsField(label) {
  for (const l of $('inspector').querySelectorAll('.field > label')) if (l.textContent.startsWith(label)) return l.parentElement;
  return null;
}
const detailsCheck = text => [...$('inspector').querySelectorAll('label.check')].find(l => l.textContent.includes(text)) || null;
const onTimeline = (role, id) => $('tl').querySelector(`g[data-role="${role}"][data-id="${id}"]`);

function showTab(tab) {
  const st = state.ws.settings;
  if (st.ribbon === tab) return;
  st.ribbon = tab; save(); renderChrome('save');
}

// ---- the roadmap being built ------------------------------------------------------

const rm = () => active();
const lane = () => rm().lanes[0];
const sub = () => lane()?.subs.find(s => s.name && s.name !== '') || lane()?.subs[0];
const tasks = () => { const out = []; eachItem(rm(), it => { if (it.type === 'task') out.push(it); }); return out; };
const milestones = () => { const out = []; eachItem(rm(), it => { if (it.type === 'milestone') out.push(it); }); return out; };
const settled = () => !editing();          // a typed edit counts once it is committed (Enter or leaving the field)
const year = () => ymd(toDay(rm().start)).y;
const on = (m, d) => dayOf(year(), m - 1, d);
const pick = (type, id) => select({ type, id });

// ---- the steps -----------------------------------------------------------------------
//
// target: what to spotlight (looked up every tick, so it survives re-renders).
// done:   true once the person has done it. manual: there is nothing to check.
// doIt:   does the step for them. enter: runs once when the step is shown.

const STEPS = [
  { title: 'Welcome to RoadMap Studio', center: true, manual: true, next: 'Start the tour',
    text: 'This tour builds a small roadmap with you, one feature at a time - swimlanes, tasks, milestones, dependencies, charts, sharing. About five minutes. It makes a roadmap of its own, so nothing you already have is touched. Every step has a "Do it for me" button.' },

  { title: 'Add a swimlane', tab: 'home', target: () => ribbonButton('Swimlane'),
    text: 'A roadmap is rows of swimlanes - one per team, product or stream. Click Swimlane.',
    done: () => rm().lanes.length >= 1, doIt: () => addLane() },

  { title: 'Name it', target: () => detailsField('Swimlane title'), enter: () => pick('lane', lane().id),
    text: 'The Details panel on the right edits whatever is selected. Type "Platform" in Swimlane title and press Enter.',
    done: () => lane() && lane().name !== 'New swimlane' && lane().name.trim() !== '' && settled(),
    doIt: () => change(() => { lane().name = 'Platform'; }) },

  { title: 'Put it in an initiative', target: () => detailsField('Initiative'), enter: () => pick('lane', lane().id),
    text: 'Neighbouring swimlanes with the same initiative share one tall title on the far left. Type "Build" and press Enter.',
    done: () => lane()?.group?.trim() && settled(), doIt: () => change(() => { lane().group = 'Build'; }) },

  { title: 'Split it into sub-swimlanes', tab: 'home', target: () => ribbonButton('Sub-swimlane'), enter: () => pick('lane', lane().id),
    text: 'A swimlane can hold several sub-swimlanes - the rows the bars sit in. With the swimlane selected, click Sub-swimlane.',
    done: () => (lane()?.subs.length || 0) >= 2, doIt: () => addSub(lane().id) },

  { title: 'Name the sub-swimlane', target: () => detailsField('Sub-swimlane title'), enter: () => pick('sub', lane().subs[lane().subs.length - 1].id),
    text: 'Type "Core services" and press Enter. (A sub-swimlane with no title just merges into its swimlane.)',
    done: () => lane()?.subs.some(s => s.name && s.name !== 'New sub-swimlane') && settled(),
    doIt: () => change(() => { lane().subs[lane().subs.length - 1].name = 'Core services'; }) },

  { title: 'Add a task', tab: 'home', target: () => ribbonButton('Task'),
    // The blank row every new swimlane starts with has done its job once a titled one exists.
    enter: () => { const l = lane(); if (l.subs.length > 1 && l.subs.some(s => !s.name && !s.items.length)) change(() => { l.subs = l.subs.filter(s => s.name || s.items.length); }); pick('sub', sub().id); },
    text: 'A task is a bar from a start date to an end date. It lands in the selected sub-swimlane. Click Task.',
    done: () => tasks().length >= 1, doIt: () => addItem('task', sub().id, on(1, 12)) },

  { title: 'Name the task', target: () => detailsField('Name'), enter: () => pick('item', tasks()[0].id),
    text: 'Type "API gateway v2" and press Enter. On the timeline, F2 or Enter also opens the name of whatever is selected.',
    done: () => tasks()[0]?.name !== 'New task' && settled(), doIt: () => change(() => { tasks()[0].name = 'API gateway v2'; }) },

  { title: 'Set its dates', target: () => detailsField('Start')?.parentElement, enter: s => { pick('item', tasks()[0].id); s.before = tasks()[0].start + tasks()[0].end; },
    text: 'Change the Start or End date. On the timeline the same thing is done by dragging the ends of the bar.',
    done: s => tasks()[0] && tasks()[0].start + tasks()[0].end !== s.before,
    doIt: () => change(() => { const t = tasks()[0]; t.start = fromDay(on(1, 12)); t.end = fromDay(on(3, 28)); }) },

  { title: 'How far along is it?', target: () => detailsField('% complete'), enter: () => pick('item', tasks()[0].id),
    text: 'Drag the slider to about 60%. The bar fills up to match; the round handle under the bar does the same by dragging.',
    done: () => tasks()[0]?.progress > 0 && settled(), doIt: () => change(() => { tasks()[0].progress = 60; }) },

  { title: 'Status and priority', target: () => detailsField('Status'), enter: () => pick('item', tasks()[0].id),
    text: 'Status gives the task a coloured dot; priority adds a P1-P4 badge. Pick "On track", then a priority.',
    done: () => tasks()[0] && (tasks()[0].status !== 'none' || tasks()[0].priority),
    doIt: () => change(() => { tasks()[0].status = 'ontrack'; tasks()[0].priority = 'high'; }) },

  { title: 'Who does it need?', target: () => detailsField('Resources needed'), enter: () => pick('item', tasks()[0].id),
    text: 'Type "2 Backend, 1 DevOps" and press Enter. The charts at the bottom add these up across the roadmap, month by month.',
    done: () => tasks()[0]?.resources?.trim() && settled(), doIt: () => change(() => { tasks()[0].resources = '2 Backend, 1 DevOps'; }) },

  { title: 'Move it on the timeline', target: () => onTimeline('item', tasks()[0]?.id), enter: s => { pick('item', tasks()[0].id); s.before = tasks()[0].start + tasks()[0].end; },
    text: 'Drag the bar sideways to move it; drag either end to resize it. Everything you can type in Details can also be done here with the mouse.',
    done: s => tasks()[0] && tasks()[0].start + tasks()[0].end !== s.before,
    doIt: () => change(() => { const t = tasks()[0]; t.start = fromDay(toDay(t.start) + 14); t.end = fromDay(toDay(t.end) + 14); }) },

  { title: 'Add a task straight onto the timeline', target: () => onTimeline('subcell', sub()?.id),
    text: 'Double-click an empty spot in a row to add a task right there. Right-click anywhere for a menu of everything else.',
    done: () => tasks().length >= 2,
    doIt: () => { addItem('task', sub().id, on(4, 6)); change(() => { const t = tasks()[tasks().length - 1]; t.name = 'Event streaming'; t.end = fromDay(on(7, 17)); t.resources = '3 Backend'; }); } },

  { title: 'Make one depend on the other', target: () => detailsField('Depends on'), enter: () => pick('item', tasks()[tasks().length - 1].id),
    text: 'In Depends on, pick the first task: an arrow links them, and the second task warns if it starts too early. On the timeline, drag the round → handle of a selected bar onto another bar.',
    done: () => { let n = 0; eachItem(rm(), it => { n += it.deps.length; }); return n > 0; },
    doIt: () => { const t = tasks(); const err = addDep(t[0].id, t[t.length - 1].id); if (err) toast(err, true); } },

  { title: 'Add a milestone', tab: 'home', target: () => ribbonButton('Milestone'), enter: () => pick('sub', sub().id),
    text: 'A milestone is a single date - a diamond, flag or star. Click Milestone, then name it in Details.',
    done: () => milestones().length >= 1,
    doIt: () => { addItem('milestone', sub().id, on(8, 3)); change(() => { const m = milestones()[milestones().length - 1]; m.name = 'Go-live'; m.shape = 'star'; }); } },

  { title: 'Add a key date', tab: 'home', target: () => ribbonButton('A major date drawn across the whole timeline - UAT, production release, freeze…'),
    text: 'A key date is a line across the whole timeline - a release, a freeze, an audit. Click Key date; drag its label to move it.',
    done: () => rm().markers.length >= 1,
    doIt: () => { addMarker(on(11, 27)); change(() => { const m = rm().markers[rm().markers.length - 1]; m.name = 'Code freeze'; m.line = 'dashed'; }); } },

  { title: 'Not scoped yet? Make it a placeholder', target: () => detailsCheck('Placeholder'), enter: () => pick('item', tasks()[tasks().length - 1].id),
    text: 'A placeholder is drawn hatched and left out of the progress numbers - a slot for work that is not planned in detail yet. Tick it.',
    done: () => { let p = false; eachItem(rm(), it => { p ||= it.placeholder; }); return p; },
    doIt: () => change(() => { tasks()[tasks().length - 1].placeholder = true; }) },

  { title: 'The Outline', target: () => $('outline').querySelector('.panel-head button'),
    text: 'The Outline on the left lists everything. Drag rows to reorder them or move tasks between rows; the eye hides a row. Add a second swimlane here.',
    done: () => rm().lanes.length >= 2,
    doIt: () => { addLane(); change(() => { const l = rm().lanes[rm().lanes.length - 1]; l.name = 'Product'; l.group = 'Build'; l.subs[0].name = 'Web app';
      l.subs[0].items.push({ ...newItem('task', on(2, 2), on(5, 29)), name: 'Onboarding redesign', progress: 30, status: 'atrisk', resources: '1 Design, 2 Frontend' }); }); } },

  { title: 'The charts', target: () => $('insights'), manual: true,
    text: 'Overall progress, status, progress by swimlane, workload and resources over time, next milestones - all drawn from what you just built, and updated as you work. Drag the handle above them to resize.' },

  { title: 'The View tab', tab: 'view', target: () => ribbonButton('Fit the whole range in the window')?.closest('.rgroup')?.parentElement, enter: s => { s.before = JSON.stringify(rm().view); },
    text: 'Header rows (years, quarters, months, weeks), a fiscal year start, zoom, which panels are open, and what each label shows. Change anything.',
    done: s => JSON.stringify(rm().view) !== s.before, doIt: () => change(() => { rm().view.bottom = 'month'; rm().view.showDates = true; }) },

  { title: 'The Format tab', tab: 'format', target: () => ribbonButton('Timeline colour theme'), enter: s => { s.before = JSON.stringify(rm().view); },
    text: 'Colour themes, bar shapes and fills, where labels sit, row density. Pick another theme.',
    done: s => JSON.stringify(rm().view) !== s.before, doIt: () => change(() => { rm().view.theme = THEMES.find(t => t.id !== rm().view.theme)?.id || rm().view.theme; }) },

  { title: 'Working together', tab: 'file', target: () => ribbonButton('Choose who can view or edit this roadmap'), manual: true,
    text: 'Share gives colleagues access: editors change the roadmap with you, live, each person\'s selection shown in their colour; viewers watch. A shared roadmap gets a red banner showing who is on it right now.' },

  { title: 'Versions', tab: 'file', target: () => ribbonButton('Keep a named copy anyone with access can go back to'), manual: true, doIt: async () => { await snapshot('Tutorial checkpoint'); toast('Version saved'); },
    text: 'A version is kept automatically every ten minutes while people work. Save a named one before a big change; History restores any of them, or opens one as a copy.' },

  { title: 'Into PowerPoint', tab: 'file', target: () => ribbonButton('Copy the timeline as an image, ready to paste into PowerPoint'), manual: true,
    text: 'Copy image puts the timeline on the clipboard, ready to paste into a slide or an email. Export gives PNG, SVG, a CSV for Excel, JSON, or a backup of every roadmap you can open.' },

  { title: 'That is the whole tool', center: true, manual: true, next: 'Finish',
    text: 'Undo is Ctrl+Z - it only undoes your own edits, never a colleague\'s. Keep this roadmap or delete it from the File tab. The tour is always in Help > Tutorial, and Help > Tips has the mouse tricks.' },
];

// ---- running it ----------------------------------------------------------------------

let run = null;

export const tourRunning = () => !!run;

export async function startTour() {
  if (run) return;
  state.ws.settings.tourSeen = true; save();
  run = { i: 0, step: null, tick: 0, rid: '', doneAt: 0 };
  const root = h('div', { class: 'tour' },
    ...['t', 'b', 'l', 'r'].map(k => h('div', { class: 'tour-shade', 'data-side': k })),
    h('div', { class: 'tour-ring', hidden: true }),
    h('div', { class: 'tour-card' }));
  document.body.append(root);
  run.root = root;
  window.addEventListener('resize', place);
  document.addEventListener('scroll', place, true);
  show(0);
  run.tick = setInterval(tickTour, 250);
}

export function endTour(msg) {
  if (!run) return;
  clearInterval(run.tick);
  window.removeEventListener('resize', place);
  document.removeEventListener('scroll', place, true);
  run.root.remove();
  run = null;
  if (msg) toast(msg);
}

async function begin() {
  // Its own roadmap, so the steps start from nothing and nothing real is touched.
  const doc = newRoadmap(TOUR_NAME);
  const st = state.ws.settings;
  st.outline = st.inspector = st.insights = true;
  try { run.rid = await createRoadmap(doc); await switchTo(run.rid); }
  catch (e) { endTour(); toast('The tour could not start: ' + e.message, true); return false; }
  return true;
}

async function show(i) {
  if (!run) return;
  if (i >= STEPS.length) { endTour('Tour finished'); return; }
  if (i === 1 && !run.rid && !(await begin())) return;
  const step = STEPS[i];
  run.i = i; run.step = step; run.doneAt = 0; run.state = {};
  if (step.tab) showTab(step.tab);
  try { step.enter?.(run.state); } catch { /* the thing it needs is gone: the tick will notice */ }
  draw();
  place();
  // A text field in the spotlight is ready to type into, with its old text selected.
  let el = null;
  try { el = step.target?.(); } catch { /* not there yet */ }
  const input = el?.querySelector?.('input[type=text], textarea');
  if (input) { input.focus(); input.select(); }
}

function draw() {
  const step = run.step, card = run.root.querySelector('.tour-card');
  const done = isDone();
  const btn = (label, cls, fn) => h('button', { class: 'btn small ' + cls, onclick: fn }, label);
  // replaceChildren prints a null child as the text "null"; h() drops it.
  card.replaceChildren(...h('div', {},
    h('div', { class: 'tour-head' }, h('span', { class: 'tour-n', text: `${run.i + 1} / ${STEPS.length}` }), h('span', { class: 'spacer' }),
      h('button', { class: 'mini', title: 'End the tour', onclick: () => endTour('Tour ended - Help > Tutorial starts it again') }, icon('close'))),
    h('h3', { text: step.title }),
    h('p', { text: step.text }),
    done && !step.manual ? h('div', { class: 'tour-done' }, icon('check'), 'Done') : null,
    h('div', { class: 'tour-foot' },
      run.i > 0 ? btn('Back', 'ghost', () => show(run.i - 1)) : null,
      step.doIt && !done ? btn('Do it for me', '', async () => { try { await step.doIt(); } catch (e) { toast(e.message, true); } tickTour(); }) : null,
      h('span', { class: 'spacer' }),
      step.manual || done ? btn(step.next || (run.i === STEPS.length - 1 ? 'Finish' : 'Next'), 'primary', () => show(run.i + 1))
        : btn('Skip', 'ghost', () => show(run.i + 1)))).childNodes);
}

function isDone() {
  const step = run.step;
  if (step.manual) return false;
  try { return !!step.done?.(run.state); } catch { return false; }
}

function tickTour() {
  if (!run) return;
  if (run.rid && (active().id !== run.rid || (meta(active()).loaded && isReadOnly()))) { endTour('Tour ended: another roadmap was opened'); return; }
  const done = isDone();
  const shown = !!run.root.querySelector('.tour-done');
  if (done !== shown) draw();
  if (done && !run.doneAt) run.doneAt = Date.now();
  if (!done) run.doneAt = 0;
  if (done && Date.now() - run.doneAt > 1400) { show(run.i + 1); return; }
  place();
}

// place puts the spotlight on the target and the card next to it.
function place() {
  if (!run) return;
  const step = run.step, root = run.root, ring = root.querySelector('.tour-ring'), card = root.querySelector('.tour-card');
  let el = null;
  try { el = step.center ? null : step.target?.() || null; } catch { el = null; }
  const W = innerWidth, H = innerHeight;
  const shades = Object.fromEntries([...root.querySelectorAll('.tour-shade')].map(s => [s.dataset.side, s]));
  const put = (s, x, y, w, ww) => { s.style.left = x + 'px'; s.style.top = y + 'px'; s.style.width = Math.max(0, w) + 'px'; s.style.height = Math.max(0, ww) + 'px'; };
  let hole = null;
  if (el) {
    if (el.scrollIntoView && !(el instanceof SVGElement)) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width && r.height) hole = { x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 };
  }
  if (hole) {
    put(shades.t, 0, 0, W, hole.y);
    put(shades.b, 0, hole.y + hole.h, W, H - hole.y - hole.h);
    put(shades.l, 0, hole.y, hole.x, hole.h);
    put(shades.r, hole.x + hole.w, hole.y, W - hole.x - hole.w, hole.h);
    ring.hidden = false;
    Object.assign(ring.style, { left: hole.x + 'px', top: hole.y + 'px', width: hole.w + 'px', height: hole.h + 'px' });
  } else {
    put(shades.t, 0, 0, W, H); put(shades.b, 0, 0, 0, 0); put(shades.l, 0, 0, 0, 0); put(shades.r, 0, 0, 0, 0);
    ring.hidden = true;
  }
  // The card: below the spotlight, else above, else beside; centred when there is none.
  const cw = card.offsetWidth || 360, ch = card.offsetHeight || 200, gap = 14;
  let x, y;
  if (!hole) { x = (W - cw) / 2; y = (H - ch) / 2; }
  else if (hole.y + hole.h + gap + ch <= H) { y = hole.y + hole.h + gap; x = hole.x + hole.w / 2 - cw / 2; }
  else if (hole.y - gap - ch >= 0) { y = hole.y - gap - ch; x = hole.x + hole.w / 2 - cw / 2; }
  else if (hole.x + hole.w + gap + cw <= W) { x = hole.x + hole.w + gap; y = hole.y + hole.h / 2 - ch / 2; }
  else { x = hole.x - gap - cw; y = hole.y + hole.h / 2 - ch / 2; }
  card.style.left = Math.max(10, Math.min(W - cw - 10, x)) + 'px';
  card.style.top = Math.max(10, Math.min(H - ch - 10, y)) + 'px';
}
