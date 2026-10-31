// Presentation mode. One person presents a deck of roadmaps - their own and
// the ones shared with them - full screen, stepping through the items with
// the keyboard. Everyone else who has the roadmap open can follow: their
// screen shows what the presenter's shows (roadmap, zoom, scroll position,
// the item in the spotlight), through the presence stream, across every
// roadmap of the deck.

import { h, icon, niceDate, toDay } from './util.js';
import { state, api, active, find, select, emit, save, isShared } from './store.js';
import { statusById, priorityById } from './themes.js';
import { dialog, toast } from './panels.js';
import { switchTo, sendPresence } from './collab.js';

const $ = id => document.getElementById(id);
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

let timeline = null;          // { layout, reveal, scroller }
let deck = null;              // presenter: { ids, title, i }
let order = [];               // ids of the items of the open roadmap, in drawn order
let scrollTimer = 0;
let lostTimer = 0;            // follower: the presenter has not been seen for a while
let pendingNext = '';         // follower: the roadmap we are moving to
let presenterName = '';
const offered = new Set();    // presenters already announced in this tab

export function mountPresent(tl) { timeline = tl; }

const presenting = () => !!state.pres;
const following = () => !!state.following;

// ---- what is on the screen ---------------------------------------------------

// Items in the order they are drawn: swimlane by swimlane, sub-swimlane by
// sub-swimlane, by start date. Hidden ones are skipped unless shown.
function itemOrder() {
  const out = [];
  for (const lane of active().lanes) {
    if (lane.hidden && !state.showHidden) continue;
    for (const sub of lane.subs) {
      if (sub.hidden && !state.showHidden) continue;
      const its = sub.items.filter(it => !it.hidden || state.showHidden);
      its.sort((a, b) => toDay(a.type === 'task' ? a.start : a.date) - toDay(b.type === 'task' ? b.start : b.date));
      for (const it of its) out.push(it.id);
    }
  }
  return out;
}

function setMode(on) {
  state.presentMode = on;
  document.body.classList.toggle('present', on);
  document.body.classList.toggle('presenting', on && presenting());
  $('present').hidden = !on;
  $('stage').querySelector('.present-card')?.remove();
  emit();
}

function card(id) {
  const stage = $('stage');
  stage.querySelector('.present-card')?.remove();
  const f = id ? find(id) : null;
  if (!f?.item) return;
  const it = f.item, rows = [];
  rows.push(['When', it.type === 'task' ? `${niceDate(toDay(it.start))} – ${niceDate(toDay(it.end))} · ${toDay(it.end) - toDay(it.start) + 1} days` : niceDate(toDay(it.date))]);
  if (it.type === 'task') rows.push(['Progress', it.progress + '%']);
  if (it.status && it.status !== 'none') rows.push(['Status', statusById(it.status).name]);
  if (it.priority) rows.push(['Priority', priorityById(it.priority).name]);
  if (it.resources) rows.push(['Resources', it.resources]);
  if (it.deps?.length) rows.push(['Depends on', it.deps.map(d => find(d.id)?.item?.name).filter(Boolean).join(', ')]);
  if (it.placeholder) rows.push(['Scope', 'Not confirmed yet (placeholder)']);
  stage.append(h('div', { class: 'present-card' },
    h('div', { class: 'present-kind', text: `${f.lane?.name || ''}${f.sub?.name ? ' · ' + f.sub.name : ''}` }),
    h('h3', { text: it.name }),
    h('dl', {}, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
    it.notes ? h('p', { class: 'present-notes', text: it.notes }) : null));
}

function renderBar() {
  const bar = $('present'), rm = active(), k = order.indexOf(state.sel?.id || '');
  const pos = k >= 0 ? `${k + 1} / ${order.length}` : `${order.length} items`;
  if (presenting()) {
    put(bar,
      h('span', { class: 'present-title', text: deck.title || 'Presentation' }),
      deck.ids.length > 1 ? h('span', { class: 'present-pos', text: `Roadmap ${deck.i + 1} of ${deck.ids.length}` }) : null,
      h('span', { class: 'present-name', text: rm.name }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', title: 'Previous item (Left arrow)', onclick: prev }, '‹'),
      h('span', { class: 'present-pos', text: pos }),
      h('button', { class: 'btn small', title: 'Next item (Right arrow or Space)', onclick: next }, '›'),
      deck.ids.length > 1 ? h('button', { class: 'btn small', title: 'Next roadmap (Down arrow)', onclick: () => goTo(deck.i + 1) }, 'Next roadmap') : null,
      h('span', { class: 'present-hint', text: '← → items · ↑ ↓ roadmaps · + − zoom · F full screen · Esc ends' }),
      h('button', { class: 'btn small primary', onclick: stopPresenting }, icon('close'), 'End'));
  } else {
    put(bar,
      h('span', { class: 'present-title', text: `Following ${presenterName}` }),
      h('span', { class: 'present-name', text: rm.name }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'present-pos', text: pos }),
      h('span', { class: 'present-hint', text: 'Your screen follows the presenter · Esc stops' }),
      h('button', { class: 'btn small', onclick: () => unfollow(true) }, icon('close'), 'Stop following'));
  }
}

// ---- presenting ----------------------------------------------------------------

function pushView(now = false) {
  if (!presenting() || !timeline) return;
  const sc = timeline.scroller;
  Object.assign(state.pres, { zoom: active().view.zoom, sx: Math.round(sc.scrollLeft), sy: Math.round(sc.scrollTop), sel: state.sel?.id || '' });
  sendPresence(now);
}

function spot(id) {
  if (!presenting()) return;
  state.pres.sel = id || '';
  select(id ? { type: 'item', id } : null);
  if (id) timeline?.reveal(id);
  card(id);
  renderBar();
  pushView();
}

// onSelect: the presenter clicked an item instead of stepping to it.
export function onSelect() {
  if (!state.presentMode) return;
  card(state.sel?.id || '');
  renderBar();
}

export function next() {
  const k = order.indexOf(state.sel?.id || '');
  if (k + 1 < order.length) spot(order[k + 1]);
  else if (deck.i + 1 < deck.ids.length) goTo(deck.i + 1);
  else { spot(null); toast('End of the presentation'); }
}
export function prev() {
  const k = order.indexOf(state.sel?.id || '');
  if (k > 0) spot(order[k - 1]);
  else if (k === 0) spot(null);
  else if (deck.i > 0) goTo(deck.i - 1, 'last');
}

// goTo opens roadmap i of the deck. Followers are told where we are going
// first - through this roadmap's presence, before we leave it.
async function goTo(i, where = 'first') {
  if (!deck || i < 0 || i >= deck.ids.length) return;
  const rid = deck.ids[i], cur = active();
  if (rid !== cur.id) {
    if (state.conn && cur.id && state.pres) {
      try { await api('POST', `roadmaps/${cur.id}/presence`, { conn: state.conn, sel: '', cur: null, doing: 'presenting', pres: { ...state.pres, next: rid } }); } catch { /* best effort */ }
    }
    deck.i = i;
    state.pres = { title: deck.title, i, n: deck.ids.length, zoom: 'fit', sx: 0, sy: 0, sel: '' };
    await switchTo(rid);
    if (!state.pres) return;                 // ended while loading
    if (active().id !== rid) { toast('That roadmap could not be opened', true); return; }
  } else {
    deck.i = i;
    state.pres = { title: deck.title, i, n: deck.ids.length, zoom: active().view.zoom, sx: 0, sy: 0, sel: '' };
  }
  active().view.zoom = state.pres.zoom;
  order = itemOrder();
  timeline?.scroller.scrollTo(0, 0);
  emit('view');
  spot(where === 'last' && order.length ? order[order.length - 1] : null);
  pushView(true);
}

export async function startPresenting(ids, title) {
  ids = ids.filter(id => state.ws.roadmaps.some(r => r.id === id));
  if (!ids.length) return toast('Choose at least one roadmap', true);
  if (following()) unfollow();
  deck = { ids, title: title || '', i: 0 };
  state.pres = { title: deck.title, i: 0, n: ids.length, zoom: 'fit', sx: 0, sy: 0, sel: '' };
  setMode(true);
  document.documentElement.requestFullscreen?.().catch(() => {});
  timeline?.scroller.addEventListener('scroll', onScroll);
  await goTo(0);
}

export function stopPresenting() {
  if (!presenting()) return;
  timeline?.scroller.removeEventListener('scroll', onScroll);
  state.pres = null; deck = null; order = [];
  select(null);
  sendPresence(true);
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  setMode(false);
  toast('Presentation ended');
}

function onScroll() {
  if (scrollTimer) return;
  scrollTimer = setTimeout(() => { scrollTimer = 0; pushView(); }, 150);
}

function zoomBy(factor) {
  const v = active().view, L = timeline?.layout();
  const cur = v.zoom === 'fit' ? (L ? L.ppd : 3) : +v.zoom;
  v.zoom = +Math.min(60, Math.max(.25, cur * factor)).toFixed(3);
  emit('view');
  if (presenting()) pushView();
}

// presentKeys handles the keyboard while presenting or following; true when
// the key was taken (nothing else must act on it).
export function presentKeys(e) {
  if (!state.presentMode) return false;
  if (e.key === 'Escape') { if (presenting()) stopPresenting(); else unfollow(true); return true; }
  if (!presenting()) return true;            // a follower's keys do nothing to the roadmap
  const k = e.key;
  if (k === 'ArrowRight' || k === ' ' || k === 'PageDown') next();
  else if (k === 'ArrowLeft' || k === 'PageUp') prev();
  else if (k === 'ArrowDown' || k.toLowerCase() === 'n') goTo(deck.i + 1);
  else if (k === 'ArrowUp' || k.toLowerCase() === 'p') goTo(deck.i - 1);
  else if (k === 'Home') spot(order[0] || null);
  else if (k === 'End') spot(order[order.length - 1] || null);
  else if (k === '+' || k === '=') zoomBy(1.25);
  else if (k === '-' || k === '_') zoomBy(1 / 1.25);
  else if (k === '0') { active().view.zoom = 'fit'; emit('view'); pushView(); }
  else if (k.toLowerCase() === 'f') { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {}); }
  else return true;
  e.preventDefault();
  return true;
}

// ---- following ------------------------------------------------------------------

// presenterHere: someone (not me) presenting this roadmap right now.
export const presenterHere = () => (state.presence || []).find(p => p.pres && p.userId !== state.me?.id) || null;

export function follow(userId) {
  const p = (state.presence || []).find(x => x.userId === userId && x.pres);
  if (!p) return toast('That presentation has ended', true);
  if (presenting()) stopPresenting();
  state.following = userId; presenterName = p.name; pendingNext = '';
  setMode(true);
  applyView(p);
}

export function unfollow(say = false) {
  if (!following()) return;
  clearTimeout(lostTimer); lostTimer = 0;
  state.following = ''; pendingNext = ''; order = [];
  select(null);
  setMode(false);
  if (say) toast(`No longer following ${presenterName}`);
}

async function applyView(p) {
  const v = p.pres, rm = active();
  if (v.next && v.next !== rm.id) {
    if (pendingNext === v.next) return;
    pendingNext = v.next;
    if (!state.ws.roadmaps.some(r => r.id === v.next)) {
      toast(`${p.name} moved on to a roadmap you do not have access to`, true);
      unfollow();
      return;
    }
    await switchTo(v.next);
    return;                                   // the new roadmap's presence brings the view
  }
  pendingNext = '';
  order = itemOrder();
  if (rm.view.zoom !== v.zoom && (v.zoom === 'fit' || typeof v.zoom === 'number')) { rm.view.zoom = v.zoom; emit('view'); }
  const sc = timeline?.scroller;
  if (sc && (Math.abs(sc.scrollLeft - v.sx) > 2 || Math.abs(sc.scrollTop - v.sy) > 2)) sc.scrollTo({ left: v.sx, top: v.sy, behavior: 'smooth' });
  const sel = v.sel && find(v.sel) ? v.sel : '';
  if ((state.sel?.id || '') !== sel) select(sel ? { type: 'item', id: sel } : null);
  card(sel);
  renderBar();
}

// onPresence is called with every presence update of the open roadmap.
export function onPresence(people) {
  if (following()) {
    const p = people.find(x => x.userId === state.following && x.pres);
    if (p) { clearTimeout(lostTimer); lostTimer = 0; presenterName = p.name; applyView(p); return; }
    // Between two roadmaps of the deck the presenter is briefly nowhere; a
    // presenter who stays away has stopped.
    if (!lostTimer) lostTimer = setTimeout(() => { lostTimer = 0; if (following() && !(state.presence || []).some(x => x.userId === state.following && x.pres)) { toast(`${presenterName}'s presentation ended`); unfollow(); } }, 10000);
    return;
  }
  if (presenting()) return;
  const p = presenterHere();
  if (p && !offered.has(p.userId + active().id)) {
    offered.add(p.userId + active().id);
    toast(`${p.name} is presenting this roadmap - press “Follow” in the red bar to see their screen`);
    emit('save');
  }
}

// ---- choosing what to present -----------------------------------------------------

// The deck: the roadmaps to present, in order. Saved decks are personal.
export function presentDialog() {
  const st = state.ws.settings, rms = state.ws.roadmaps;
  st.decks ||= [];
  const cur = active();
  let ids = [cur.id].filter(Boolean);
  const titleIn = h('input', { type: 'text', value: cur.name || '', placeholder: 'Title shown while presenting', style: 'width:100%' });
  const list = h('div', { class: 'present-list' });
  const deckOptions = sel => [h('option', { value: '', text: 'Saved decks…' }), ...st.decks.map(d => h('option', { value: d.id, text: d.name, selected: d.id === sel }))];
  const saved = h('select', {}, deckOptions(''));
  const pos = id => ids.indexOf(id);
  function renderList() {
    const rows = [...rms].sort((a, b) => (pos(a.id) < 0 ? 1e9 : pos(a.id)) - (pos(b.id) < 0 ? 1e9 : pos(b.id)) || a.name.localeCompare(b.name));
    put(list, rows.map(r => {
      const k = pos(r.id), on = k >= 0;
      const cb = h('input', { type: 'checkbox' });
      cb.checked = on;
      cb.addEventListener('change', () => { if (cb.checked) ids.push(r.id); else ids = ids.filter(x => x !== r.id); renderList(); });
      const m = r._meta || {};
      return h('label', { class: 'present-row' + (on ? ' on' : '') }, cb,
        h('span', { class: 'present-k', text: on ? String(k + 1) : '' }),
        h('span', { class: 'present-rn', text: r.name }),
        h('span', { class: 'present-who', text: m.role === 'owner' ? 'yours' : `${m.owner?.name || 'shared'} · ${m.role || ''}` }),
        on ? h('span', { class: 'present-move' },
          h('button', { class: 'btn tiny', type: 'button', title: 'Earlier', disabled: k === 0, onclick: e => { e.preventDefault(); ids.splice(k, 1); ids.splice(k - 1, 0, r.id); renderList(); } }, '↑'),
          h('button', { class: 'btn tiny', type: 'button', title: 'Later', disabled: k === ids.length - 1, onclick: e => { e.preventDefault(); ids.splice(k, 1); ids.splice(k + 1, 0, r.id); renderList(); } }, '↓')) : null);
    }));
  }
  renderList();
  saved.addEventListener('change', () => {
    const d = st.decks.find(x => x.id === saved.value);
    if (!d) return;
    ids = d.ids.filter(id => rms.some(r => r.id === id)); titleIn.value = d.name; renderList();
    if (ids.length < d.ids.length) toast('Some roadmaps of that deck are no longer shared with you', true);
  });
  const saveDeck = () => {
    const name = titleIn.value.trim() || 'Deck';
    let d = st.decks.find(x => x.name === name);
    if (!d) { d = { id: Math.random().toString(36).slice(2, 10), name, ids: [] }; st.decks.push(d); }
    d.ids = [...ids]; save(); toast(`Deck “${name}” saved`);
    saved.replaceChildren(...deckOptions(d.id));
  };
  const delDeck = () => { const d = st.decks.find(x => x.id === saved.value); if (!d) return; st.decks = st.decks.filter(x => x !== d); save(); saved.replaceChildren(...deckOptions('')); toast('Deck removed'); };
  dialog('Present', h('div', { class: 'present-dialog' },
    h('p', { class: 'meta-note', style: 'max-width:none', text: 'Pick the roadmaps to show, in order - yours and the ones shared with you. Full screen, clean (no comments, no panels), stepping through the items with the arrow keys. Colleagues who have a roadmap open can follow along on their own screen.' }),
    h('div', { class: 'field' }, h('label', { text: 'Title' }), titleIn),
    h('div', { class: 'present-decks' }, saved, h('button', { class: 'btn small', type: 'button', onclick: saveDeck }, 'Save as deck'), h('button', { class: 'btn small', type: 'button', onclick: delDeck }, 'Remove deck')),
    list),
    [{ label: 'Cancel' }, { label: 'Start presenting', cls: 'primary', value: () => ({ ids: [...ids], title: titleIn.value.trim() }) }], true)
    .then(r => { if (r) startPresenting(r.ids, r.title); });
}

export const canFollowHint = () => !state.presentMode && !!presenterHere() && !!active().id && isShared(active());
