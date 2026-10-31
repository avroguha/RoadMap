// The open roadmap's connection to the server: loading it, sending edits in
// order, the live stream of everyone else's edits, presence, and the dialogs
// for sharing and administration.

import { h, icon, clone, niceDate, toDay } from './util.js';
import { state, api, active, meta, emit, save, adopt, refreshList, normalise, reidentify, editing, isReadOnly, snapshot, change } from './store.js';
import { toast, dialog, askText, confirmBox, field } from './panels.js';

let es = null;            // EventSource of the open roadmap
let sending = false;
let presenceTimer = 0;

// DOM replaceChildren prints null as text; put() drops it like h() does.
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const setStatus = s => { if (state.saveState !== s) { state.saveState = s; emit('save'); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- opening a roadmap -----------------------------------------------------------

export async function openRoadmap(rid) {
  closeStream();
  state.sync = null;
  state.presence = [];
  state.comments = [];
  state.ws.activeId = rid;
  state.sel = null;
  save();
  emit();
  const rm = state.ws.roadmaps.find(r => r.id === rid);
  if (!rm) return;
  try {
    const r = await api('GET', `roadmaps/${rid}`);
    if (state.ws.activeId !== rid) return; // switched again meanwhile
    adopt(rm, r.doc, r.rev, r.role, r.members, r.everyone);
    openStream(rm);
    loadComments(rm);
  } catch (e) {
    toast('Could not open the roadmap: ' + e.message, true);
  }
  emit();
}

// switchTo waits for this roadmap's unsent edits before leaving it.
export async function switchTo(rid) {
  if (rid === state.ws.activeId && meta(active()).loaded) return;
  await flush();
  return openRoadmap(rid);
}

async function reloadActive() {
  const rm = active(), sync = state.sync;
  if (!rm.id || !sync) return;
  try {
    const r = await api('GET', `roadmaps/${rm.id}`);
    Object.assign(rm._meta, { role: r.role, members: Math.max(0, r.members.length - 1), people: r.members, everyone: r.everyone || '' });
    sync.reset(normalise(r.doc), r.rev);
    openStream(rm);
    kick();
    loadComments(rm);
  } catch (e) {
    if (e.status === 404) { await lostAccess(rm); return; }
    toast('Could not reload the roadmap: ' + e.message, true);
  }
  emit();
}

async function lostAccess(rm) {
  toast(`You no longer have access to "${rm.name}".`, true);
  closeStream();
  await refreshList();
  if (state.ws.roadmaps[0]) openRoadmap(state.ws.roadmaps[0].id); else emit();
}

// ---- comments ---------------------------------------------------------------------

export async function loadComments(rm) {
  if (state.ws.activeId !== rm.id) return;
  try { state.comments = await api('GET', `roadmaps/${rm.id}/comments`); } catch { state.comments = []; }
  if (state.ws.activeId === rm.id) emit('comments');
}
export async function addComment(itemId, body) {
  state.comments = await api('POST', `roadmaps/${active().id}/comments`, { itemId, body }); emit('comments');
}
export async function resolveComment(id, resolved) {
  state.comments = await api('PATCH', `roadmaps/${active().id}/comments/${id}`, { resolved }); emit('comments');
}
export async function deleteComment(id) {
  state.comments = await api('DELETE', `roadmaps/${active().id}/comments/${id}`); emit('comments');
}

// ---- sending -----------------------------------------------------------------------

// kick sends unsent batches one at a time, in order: the server must apply
// this browser's batches in the order they were made.
export async function kick() {
  if (sending) return;
  sending = true;
  let delay = 1000;
  try {
    for (;;) {
      const sync = state.sync;
      const next = sync?.pending.find(b => !b.sent);
      if (!next) break;
      const rid = sync.doc.id;
      setStatus('saving');
      try {
        const r = await api('POST', `roadmaps/${rid}/ops`, { batchId: next.id, ops: next.ops });
        next.sent = true;
        if (state.sync === sync && sync.confirm(next.id, r.rev)) emit('remote');
        delay = 1000;
      } catch (e) {
        if (state.sync !== sync) break;
        if (e.status === 401) break;
        if (e.status === 403 || e.status === 404) {
          toast(e.message, true);
          sync.pending.length = 0;
          await refreshList();
          await reloadActive();
          break;
        }
        if (e.status === 400) {
          console.error('edit refused by the server', e.message, next.ops);
          toast('An edit could not be saved and was undone: ' + e.message, true);
          sync.pending.splice(sync.pending.indexOf(next), 1);
          await reloadActive();
          break;
        }
        setStatus('offline');
        await sleep(delay);
        delay = Math.min(delay * 2, 15000);
      }
    }
  } finally {
    sending = false;
    if (state.sync && !state.sync.pending.some(b => !b.sent)) setStatus('saved');
  }
}

// flush waits until everything made so far has been accepted.
export async function flush(timeout = 10000) {
  const until = Date.now() + timeout;
  kick();
  while (state.sync?.pending.some(b => !b.sent) && Date.now() < until) await sleep(100);
}

// ---- the live stream -----------------------------------------------------------------

function closeStream() {
  if (es) { es.close(); es = null; }
  state.online = false;
}

function openStream(rm) {
  closeStream();
  const sync = state.sync;
  const src = new EventSource(`/api/roadmaps/${rm.id}/events?rev=${sync.rev}`);
  es = src;
  src.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    state.conn = d.conn; state.online = true;
    if (d.role && d.role !== meta(rm).role) { rm._meta.role = d.role; }
    sendPresence(true);
    kick();
    emit('save');
  });
  src.addEventListener('ops', e => {
    if (state.sync !== sync) return;
    const ev = JSON.parse(e.data);
    const kind = sync.receive(ev, editing());
    if (kind === 'theirs' && !editing()) emit('remote');
  });
  src.addEventListener('presence', e => {
    state.presence = JSON.parse(e.data).filter(p => p.conn !== state.conn);
    emit('presence');
  });
  src.addEventListener('comments', () => loadComments(rm));
  src.addEventListener('access', async e => {
    const { role } = JSON.parse(e.data);
    if (role === 'recheck') { closeStream(); reloadActive(); return; }   // sharing with everyone changed: re-read my own access
    if (!role) { await lostAccess(rm); return; }
    rm._meta.role = role;
    toast(role === 'viewer' ? `You can now only view "${rm.name}".` : role === 'commenter' ? `You can now comment on "${rm.name}".` : role === 'owner' ? `You are now the owner of "${rm.name}".` : `You can now edit "${rm.name}".`);
    await refreshList();
    emit();
  });
  src.addEventListener('reload', () => { closeStream(); reloadActive(); });
  src.onerror = () => {
    // The browser reconnects by itself and sends the last rev it saw.
    if (state.online) { state.online = false; emit('save'); }
  };
}

// sendPresence tells the others what this tab has selected (throttled).
export function sendPresence(now = false) {
  clearTimeout(presenceTimer);
  const go = () => {
    const rm = active();
    if (!state.conn || !rm.id) return;
    if (state.pres) state.pres.sel = state.sel?.id || '';
    api('POST', `roadmaps/${rm.id}/presence`, { conn: state.conn, sel: state.sel?.id || '', cur: state.cursor, doing: state.doing || '', pres: state.pres || undefined }).catch(() => {});
  };
  if (now) go(); else presenceTimer = setTimeout(go, 250);
}

// sendCursor: the pointer's place on the timeline, at most ~8 times a second,
// and only while someone else has the roadmap open.
let cursorTimer = 0;
export function sendCursor(cur) {
  state.cursor = cur;
  if (!state.presence.length || cursorTimer) return;
  cursorTimer = setTimeout(() => {
    cursorTimer = 0;
    const rm = active();
    if (!state.conn || !rm.id) return;
    api('POST', `roadmaps/${rm.id}/presence`, { conn: state.conn, sel: state.sel?.id || '', cur: state.cursor, doing: state.doing || '', pres: state.pres || undefined }).catch(() => {});
  }, 120);
}

// ---- creating, removing -------------------------------------------------------------------

export async function createRoadmap(doc, versions) {
  const body = clone(doc);
  delete body._meta;
  const r = await api('POST', 'roadmaps', { doc: body, versions });
  await refreshList();
  return r.id;
}

export async function duplicateRoadmap(rm) {
  const copy = reidentify(normalise(clone({ ...rm, _meta: undefined })));
  copy.name += ' (copy)';
  const id = await createRoadmap(copy);
  await switchTo(id);
  toast('Copied to your roadmaps');
}

export async function deleteRoadmap(rm) {
  const m = meta(rm);
  if (m.role !== 'owner') return leaveRoadmap(rm);
  const others = m.members ? ` It is shared with ${m.members} other ${m.members === 1 ? 'person' : 'people'}, who will lose it too.` : '';
  if (!(await confirmBox('Delete roadmap', `Delete "${rm.name}" for good?${others} This cannot be undone - export it first if you may want it back.`, 'Delete'))) return;
  try {
    await api('DELETE', `roadmaps/${rm.id}`);
    await refreshList();
    if (state.ws.roadmaps[0]) await openRoadmap(state.ws.roadmaps[0].id); else { closeStream(); state.sync = null; emit(); }
    toast('Roadmap deleted');
  } catch (e) { toast(e.message, true); }
}

export async function leaveRoadmap(rm) {
  if (!(await confirmBox('Leave roadmap', `Remove "${rm.name}" from your list? Its owner can share it with you again.`, 'Leave'))) return;
  try {
    await api('DELETE', `roadmaps/${rm.id}/members/${state.me.id}`);
    await refreshList();
    if (state.ws.roadmaps[0]) await openRoadmap(state.ws.roadmaps[0].id); else emit();
  } catch (e) { toast(e.message, true); }
}

// ---- people --------------------------------------------------------------------------------

export const avatar = (p, extra = '') => h('span', { class: 'avatar ' + extra, style: `background:${p.color}`, title: p.name + (p.email ? ` (${p.email})` : '') }, p.initials);

const ROLE_TEXT = { owner: 'Owner', editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view' };
const ROLES = ['editor', 'commenter', 'viewer'];
const EVERYONE_TEXT = { '': 'Nobody else - only the people listed', viewer: 'Everyone can view', commenter: 'Everyone can view and comment', editor: 'Everyone can edit' };

export async function shareDialog(rm = active()) {
  if (!rm.id) return;
  const mine = meta(rm).role === 'owner';
  const list = h('div', { class: 'people' });
  const results = h('div', { class: 'people results' });
  const search = h('input', { type: 'text', placeholder: 'Type a name or email', disabled: !mine });
  const addRole = h('select', {}, ROLES.map(r => h('option', { value: r, selected: r === 'editor' }, ROLE_TEXT[r])));
  let people = [];

  const draw = () => {
    list.replaceChildren(...people.map(p => {
      const row = h('div', { class: 'person' }, avatar(p), h('div', { class: 'who' }, h('b', { text: p.name || p.email }), h('span', { text: p.email })));
      if (p.role === 'owner' || !mine) row.append(h('span', { class: 'role', text: ROLE_TEXT[p.role] + (p.id === state.me.id ? ' (you)' : '') }));
      else {
        const sel = h('select', {}, ROLES.map(r => h('option', { value: r, selected: p.role === r }, ROLE_TEXT[r])));
        sel.addEventListener('change', () => setRole(p, sel.value));
        row.append(sel,
          h('button', { class: 'mini', title: `Make ${p.name} the owner`, onclick: () => transfer(p) }, icon('crown')),
          h('button', { class: 'mini', title: 'Remove access', onclick: () => remove(p) }, icon('trash')));
      }
      return row;
    }));
  };
  const keep = ppl => { people = ppl; rm._meta.people = people; rm._meta.members = Math.max(0, people.length - 1); };
  const load = async () => {
    try { keep(await api('GET', `roadmaps/${rm.id}/members`)); } catch (e) { toast(e.message, true); }
    draw(); emit();
  };
  const setRole = async (p, role) => {
    try { keep(await api('PUT', `roadmaps/${rm.id}/members/${p.id}`, { role })); draw(); await refreshList(); emit(); }
    catch (e) { toast(e.message, true); }
  };
  const remove = async p => {
    try { await api('DELETE', `roadmaps/${rm.id}/members/${p.id}`); await load(); await refreshList(); emit(); }
    catch (e) { toast(e.message, true); }
  };
  const transfer = async p => {
    if (!(await confirmBox('Change owner', `Make ${p.name} the owner of "${rm.name}"? You stay on it as an editor, and only they can then share or delete it.`, 'Make owner'))) return shareDialog(rm);
    try { await api('POST', `roadmaps/${rm.id}/owner`, { userId: p.id }); await refreshList(); toast(`${p.name} now owns "${rm.name}"`); }
    catch (e) { toast(e.message, true); }
    return shareDialog(rm);
  };
  // Everyone in the organisation, at one role.
  const everyone = h('select', { disabled: !mine }, Object.entries(EVERYONE_TEXT).map(([v, t]) => h('option', { value: v, selected: (meta(rm).everyone || '') === v }, t)));
  everyone.addEventListener('change', async () => {
    try { keep(await api('PUT', `roadmaps/${rm.id}/everyone`, { role: everyone.value })); rm._meta.everyone = everyone.value; await refreshList(); emit();
      toast(everyone.value ? `Shared with everyone: ${ROLE_TEXT[everyone.value].toLowerCase()}` : 'No longer shared with everyone'); }
    catch (e) { toast(e.message, true); }
  });
  let timer = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (!q) { results.replaceChildren(); return; }
    timer = setTimeout(async () => {
      let found = [];
      try { found = await api('GET', 'users?q=' + encodeURIComponent(q)); } catch (e) { toast(e.message, true); }
      const have = new Set(people.map(p => p.id));
      found = found.filter(p => !have.has(p.id));
      results.replaceChildren(...(found.length ? found.map(p => h('div', { class: 'person' }, avatar(p), h('div', { class: 'who' }, h('b', { text: p.name || p.email }), h('span', { text: p.email })),
        h('button', { class: 'btn small primary', onclick: async () => { await setRole(p, addRole.value); search.value = ''; results.replaceChildren(); } }, icon('plus'), 'Add')))
        : [h('div', { class: 'empty', style: 'padding:6px 2px', text: 'Nobody found. People appear here after they have signed in to RoadMap Studio once.' })]));
    }, 200);
  });
  load();
  const myRole = meta(rm).role;
  const body = h('div', {},
    h('p', { text: mine ? 'Editors change the roadmap with you, live. Commenters see everything and can add comments to items, but not change them. Viewers just watch.'
      : `Only the owner can change who has access. You ${ROLE_TEXT[myRole]?.toLowerCase() || 'can view'}${meta(rm).via === 'everyone' ? ', because it is shared with everyone' : ''}.` }),
    h('div', { class: 'lbl', text: 'Everyone in the organisation' }), everyone,
    h('div', { class: 'lbl', style: 'margin:14px 0 6px', text: 'Particular people' }),
    mine ? h('div', { class: 'two' }, search, addRole) : null, results,
    h('div', { class: 'lbl', style: 'margin:14px 0 6px', text: 'People with access' }), list,
    !mine && meta(rm).via !== 'everyone' ? h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => { document.querySelector('#modal .foot .btn')?.click(); leaveRoadmap(rm); } }, icon('trash'), 'Leave this roadmap') : null);
  await dialog(`Share "${rm.name}"`, body, [{ label: 'Done', cls: 'primary' }], true);
}

// ---- the local administrator's password ---------------------------------------------------

export async function passwordDialog() {
  const inp = (ac) => h('input', { type: 'password', autocomplete: ac });
  const cur = inp('current-password'), next = inp('new-password'), again = inp('new-password');
  const problem = h('div', { class: 'warnbox', hidden: true });
  const fail = msg => { problem.textContent = msg; problem.hidden = false; };
  const body = h('div', {},
    state.me.defaultPassword ? h('p', { text: 'This account still has the default password "admin", which anyone can guess. Choose a new one.' }) : null,
    h('div', { class: 'field' }, h('label', { text: 'Current password' }), cur),
    h('div', { class: 'field' }, h('label', { text: 'New password (at least 8 characters)' }), next),
    h('div', { class: 'field' }, h('label', { text: 'New password again' }), again),
    problem,
    h('p', { class: 'meta-note', text: 'Every other place this account is signed in is signed out.' }));
  for (;;) {
    const ok = await dialog('Change password', body, [{ label: 'Cancel' }, { label: 'Change password', cls: 'primary', value: () => true }]);
    if (!ok) return;
    if (next.value !== again.value) { fail('The two new passwords are different.'); continue; }
    try {
      await api('PUT', 'me/password', { current: cur.value, next: next.value });
      state.me.defaultPassword = false;
      emit('all');
      return toast('Password changed');
    } catch (e) { fail(e.message); }
  }
}

// ---- administration ---------------------------------------------------------------------

export async function adminDialog() {
  const table = h('div', { class: 'people' });
  const sso = h('div', { class: 'sso' });
  let users = [];
  const fmt = t => (t ? new Date(t).toLocaleString() : 'never');
  const draw = () => {
    table.replaceChildren(...users.map(u => {
      const me = u.id === state.me.id;
      return h('div', { class: 'person' + (u.active ? '' : ' off') }, avatar(u),
        h('div', { class: 'who' }, h('b', { text: (u.name || u.email) + (me ? ' (you)' : '') }), h('span', { text: `${u.email} · last sign-in ${fmt(u.lastLogin)} · owns ${u.owns}, shared ${u.sharedIn}` })),
        h('label', { class: 'check', title: 'Administrators manage users and sign-in' }, (() => { const c = h('input', { type: 'checkbox', checked: u.isAdmin, disabled: me }); c.addEventListener('change', () => update(u, { isAdmin: c.checked })); return c; })(), 'Admin'),
        h('label', { class: 'check', title: 'A turned-off account cannot sign in; its roadmaps stay' }, (() => { const c = h('input', { type: 'checkbox', checked: u.active, disabled: me }); c.addEventListener('change', () => update(u, { active: c.checked })); return c; })(), 'Active'),
        u.owns && !u.active ? h('button', { class: 'btn small', title: 'Give all of their roadmaps to someone else', onclick: () => handOver(u) }, 'Hand over roadmaps') : null);
    }));
  };
  const update = async (u, patch) => { try { users = await api('PATCH', `admin/users/${u.id}`, patch); draw(); } catch (e) { toast(e.message, true); } };
  const handOver = async u => {
    const email = await askText(`Hand over ${u.name}'s roadmaps`, '', 'Email of the new owner');
    if (!email) return;
    const to = users.find(x => x.email.toLowerCase() === email.toLowerCase() && x.active);
    if (!to) return toast('No active user with that email', true);
    await update(u, { transferTo: to.id });
    toast(`${u.owns} roadmap(s) now belong to ${to.name}`);
  };
  const drawSSO = s => {
    const row = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), h('code', { class: 'path', text: v || '-' }));
    const v = s.settings || {};
    const opts = (list, cur) => list.map(([val, t]) => h('option', { value: val, selected: cur === val }, t));
    const src = h('select', {}, opts([['url', 'The App Federation Metadata Url from Azure'], ['xml', 'Pasted Federation Metadata XML'],
      ...(s.fileConfigured ? [['file', 'A file on the server (RMS_SAML_METADATA_FILE)']] : []), ['', 'Not configured']], v.source || ''));
    const urlIn = h('input', { type: 'text', value: v.metadataUrl || '', placeholder: 'https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml?appid=…' });
    const xmlIn = h('textarea', { rows: 7, placeholder: 'Paste the Federation Metadata XML downloaded from the Azure Enterprise Application' }); xmlIn.value = v.metadataXml || '';
    const entity = h('input', { type: 'text', value: v.entityId || '', placeholder: `${s.metadataUrl} (default)` });
    const tenant = h('input', { type: 'text', value: v.tenantId || '', placeholder: 'empty = any tenant' });
    const mode = h('select', {}, opts([['off', 'Off - everyone Azure lets through can sign in'], ['allow', 'Allow only members of these groups'], ['deny', 'Deny members of these groups']], v.groupMode || 'off'));
    const groups = h('textarea', { rows: 3, placeholder: 'Azure group object ids, one per line' }); groups.value = (v.groups || []).join('\n');
    const urlField = field('Metadata URL', urlIn), xmlField = field('Metadata XML', xmlIn), groupField = field('Group object ids', groups);
    const sync = () => { urlField.hidden = src.value !== 'url'; xmlField.hidden = src.value !== 'xml'; groupField.hidden = mode.value === 'off'; };
    src.addEventListener('change', sync); mode.addEventListener('change', sync); sync();
    const body = () => ({ source: src.value, metadataUrl: urlIn.value, metadataXml: xmlIn.value, entityId: entity.value, tenantId: tenant.value, groupMode: mode.value, groups: groups.value.split(/\n/) });
    const result = h('div', {});
    const fail = e => put(result, h('div', { class: 'warnbox', text: e.message }));
    const check = async () => { try { const r = await api('POST', 'admin/sso/check', body());
      put(result, h('div', { class: 'okbox' }, h('b', { text: 'Readable. ' }), `Identity provider ${r.entityId}, sign-in at ${r.ssoUrl}, ${r.certificates.length} signing certificate(s)` +
        (r.certificates.length ? ' (valid until ' + r.certificates.map(c => new Date(c.notAfter).toLocaleDateString()).join(', ') + ')' : '') + '. Not saved yet.')); } catch (e) { fail(e); } };
    const save = async () => { try { const r = await api('PUT', 'admin/sso/settings', body()); toast('Single sign-on settings saved'); drawSSO(r); } catch (e) { fail(e); } };
    const test = () => window.open('/saml/login?test=1', 'rmsSSOTest', 'width=800,height=860,popup=yes');
    const btn = (label, ic, fn, cls = '', disabled = false) => h('button', { class: 'btn small ' + cls, onclick: fn, disabled }, icon(ic), label);
    put(sso,
      s.mode === 'dev' ? h('div', { class: 'warnbox', text: 'TEST SIGN-IN MODE - anyone can sign in as anyone. Not for real data.' }) : null,
      s.mode === 'saml' && !s.configured ? h('div', { class: 'warnbox', text: 'Single sign-on is not configured yet: only the local administrator can sign in. Fill in step 2 and save.' }) : null,
      v.fromEnv && s.configured ? h('p', { class: 'meta-note', text: 'These values come from the server configuration (deploy.env). Saving here replaces them, for every server.' }) : null,
      h('div', { class: 'lbl', text: '1. Give Azure these (or upload the metadata file)' }),
      row('Identifier (Entity ID)', s.entityId), row('Reply URL (ACS)', s.acsUrl), row('Sign on URL', s.signOnUrl),
      h('a', { class: 'btn small', href: '/saml/metadata', download: 'roadmap-studio-saml-metadata.xml' }, icon('download'), 'Download metadata XML'),
      h('div', { class: 'lbl', style: 'margin-top:14px', text: '2. Tell RoadMap Studio about Azure' }),
      field('Metadata comes from', src), urlField, xmlField,
      h('div', { class: 'two' }, field('Entity ID (optional)', entity), field('Tenant ID (optional, refuses other tenants)', tenant)),
      h('div', { class: 'lbl', style: 'margin-top:14px', text: '3. Who may sign in' }),
      field('Group access', mode), groupField,
      h('p', { class: 'meta-note', text: 'Off at first: Azure\u2019s own assignment (Users and groups) decides. The lists need the groups claim turned on in the Azure app (Attributes & Claims > Add a group claim).' }),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px' },
        btn('Check metadata', 'eye', check), btn('Save', 'check', save, 'primary'), btn('Test sign-in', 'play', test, '', !s.configured),
        s.mode === 'saml' && s.configured ? btn('Read the metadata again now', 'history', async () => { try { drawSSO(await api('POST', 'admin/sso/refresh')); toast('Metadata read again'); } catch (e) { fail(e); } }) : null),
      h('p', { class: 'meta-note', text: 'Test sign-in opens a window, goes through the identity provider, and shows every claim it sent and what the app would do with it - without signing anyone in.' }),
      result,
      h('div', { class: 'lbl', style: 'margin-top:12px', text: 'Status' }),
      row('Metadata source', s.source), row('Issuer', s.idpEntityId), row('Last read', s.loadedAt && !s.loadedAt.startsWith('0001') ? fmt(s.loadedAt) : 'never'),
      ...(s.certificates || []).map(c => row('Signing certificate', `${c.subject} - valid until ${new Date(c.notAfter).toLocaleDateString()}`)),
      s.lastError ? h('div', { class: 'warnbox', text: s.lastError }) : null);
  };
  try { users = await api('GET', 'admin/users'); draw(); drawSSO(await api('GET', 'admin/sso')); }
  catch (e) { return toast(e.message, true); }
  await dialog('Administration', h('div', {}, h('div', { class: 'lbl', text: 'Single sign-on' }), sso,
    h('div', { class: 'lbl', style: 'margin:18px 0 6px', text: `People (${users.length}) - created automatically at their first sign-in` }), table), [{ label: 'Close', cls: 'primary' }], true);
}

// ---- version history ---------------------------------------------------------------------

const FIELD_LABEL = { name: 'name', start: 'start', end: 'end', date: 'date', progress: '% complete', status: 'status', priority: 'priority', resources: 'resources', notes: 'notes',
  color: 'colour', labelPos: 'label position', hidden: 'visibility', placeholder: 'placeholder', deps: 'dependencies', group: 'initiative', shape: 'shape', type: 'type', line: 'line style', view: 'view settings' };
const KIND_LABEL = { lane: 'swimlane', sub: 'sub-swimlane', item: 'item', marker: 'key date', roadmap: 'roadmap' };
const fmtVal = v => (v == null || v === '' ? '(empty)' : typeof v === 'object' ? (Array.isArray(v) ? `${v.length} item(s)` : '…') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? niceDate(toDay(String(v))) : String(v));
function describe(row) {
  if (row.kind) {
    const d = row.detail || {}, who = d.user?.name || d.user?.email || 'someone';
    return { share: `shared it with ${who} (${ROLE_TEXT[d.role]?.toLowerCase() || d.role})`, unshare: `removed ${who}'s access`, leave: 'left the roadmap',
      transfer: `handed the roadmap over to ${who}`, everyone: d.role ? `shared it with everyone (${ROLE_TEXT[d.role]?.toLowerCase()})` : 'stopped sharing it with everyone',
      version: `saved the version "${d.label}"`, 'comment-removed': `removed a comment by ${who}` }[row.kind] || row.kind;
  }
  if (!row.entries) return `made ${row.ops} change${row.ops === 1 ? '' : 's'}`;
  const q = s => `"${s || '(untitled)'}"`;
  return row.entries.map(e => {
    const k = KIND_LABEL[e.kind] || e.kind;
    switch (e.op) {
      case 'set': return e.field === 'name' ? `renamed ${k} ${q(e.from)} to ${q(e.to)}` : `changed the ${FIELD_LABEL[e.field] || e.field} of ${q(e.name)}: ${fmtVal(e.from)} → ${fmtVal(e.to)}`;
      case 'root': return e.field === 'view' ? 'changed the view settings' : `changed the roadmap ${FIELD_LABEL[e.field] || e.field}: ${fmtVal(e.from)} → ${fmtVal(e.to)}`;
      case 'add': return `added ${k} ${q(e.name)}${e.parent ? ' to ' + q(e.parent) : ''}`;
      case 'del': return `removed ${k} ${q(e.name)}`;
      case 'move': return `moved ${k} ${q(e.name)}${e.parent ? ' to ' + q(e.parent) : ''}`;
      case 'many': return `… and ${e.count} more`;
      default: return e.op;
    }
  });
}

export async function historyDialog(tab = 'versions') {
  const rm = active();
  if (!rm.id) return;
  const canEdit = !isReadOnly(rm);
  const list = h('div', {});
  const refresh = async () => {
    let rows = [];
    try { rows = await api('GET', `roadmaps/${rm.id}/versions`); } catch (e) { toast(e.message, true); }
    list.replaceChildren(...(rows.length ? rows.map(r => h('div', { class: 'hrow' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'when' }, new Date(r.at).toLocaleString(), '  ', h('span', { class: 'badge' + (r.auto ? ' auto' : ''), text: r.auto ? 'auto' : r.label || 'saved version' })),
        h('div', { class: 'meta', text: `${r.items} items${r.by ? ' · ' + r.by : ''}` })),
      canEdit ? h('button', { class: 'btn small', title: 'Make the roadmap look like this version again - for everyone (Undo reverts it)', onclick: () => restore(r, false) }, 'Restore') : null,
      h('button', { class: 'btn small', title: 'Open this version as a separate roadmap of your own', onclick: () => restore(r, true) }, 'Open as copy'),
      canEdit ? h('button', { class: 'mini', title: 'Delete this version', onclick: async () => { await api('DELETE', `roadmaps/${rm.id}/versions/${r.id}`); refresh(); } }, icon('trash')) : null))
      : [h('div', { class: 'empty', text: 'No saved versions yet. One is kept automatically every ten minutes while people work, and whenever someone saves one.' })]));
  };
  const restore = async (r, asCopy) => {
    const v = await api('GET', `roadmaps/${rm.id}/versions/${r.id}`);
    document.querySelector('#modal .foot .btn')?.click();
    if (asCopy) {
      const copy = reidentify(normalise(v.doc));
      copy.name += ` (${new Date(r.at).toLocaleDateString()})`;
      await switchTo(await createRoadmap(copy));
      return toast('Version opened as a copy');
    }
    await snapshot('Before restore');
    const doc = normalise(v.doc);
    change(() => {
      const keep = rm.view.zoom;
      for (const k of ['name', 'start', 'end', 'view', 'markers', 'lanes']) rm[k] = clone(doc[k]);
      rm.view.zoom = keep;
      state.sel = null;
    });
    toast('Version restored for everyone - Undo reverts it');
  };
  const saveNow = canEdit ? h('button', { class: 'btn', onclick: async () => { const label = await askText('Save version', '', 'Label (optional)'); if (label === undefined) return historyDialog();
    await snapshot(label || 'Saved version'); toast('Version saved'); historyDialog(); } }, icon('plus'), 'Save version now') : null;

  // ---- activity: every change, by whom, when
  const act = h('div', { class: 'activity' });
  const filter = h('input', { type: 'text', placeholder: 'Filter by person, item or word' });
  let rows = [], more = false, loading = false;
  const drawActivity = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = rows.map(r => ({ r, lines: [].concat(describe(r)) })).filter(x => !q || (x.r.by.name + ' ' + x.lines.join(' ')).toLowerCase().includes(q));
    const groups = new Map();
    for (const x of shown) { const day = new Date(x.r.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); (groups.get(day) || groups.set(day, []).get(day)).push(x); }
    act.replaceChildren(...(shown.length ? [...groups].map(([day, xs]) => h('div', { class: 'aday' }, h('div', { class: 'lbl', text: day }), ...xs.map(({ r, lines }) =>
      h('div', { class: 'arow' }, h('span', { class: 'atime', text: new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), avatar(r.by),
        h('div', { class: 'abody' }, h('b', { text: r.by.name || r.by.email }), ' ', lines.length === 1 ? lines[0] : h('ul', {}, lines.map(l => h('li', { text: l })))))))) :
      [h('div', { class: 'empty', text: rows.length ? 'Nothing matches the filter.' : 'No changes recorded yet.' })]),
      more ? h('button', { class: 'btn small', style: 'margin-top:8px', onclick: () => loadMore() }, 'Load older changes') : null);
  };
  const loadMore = async () => {
    if (loading) return; loading = true;
    try { const r = await api('GET', `roadmaps/${rm.id}/activity` + (rows.length ? '?before=' + new Date(rows[rows.length - 1].at).getTime() : '')); rows = rows.concat(r.rows); more = r.more; }
    catch (e) { toast(e.message, true); }
    loading = false; drawActivity();
  };
  filter.addEventListener('input', drawActivity);
  const csv = () => {
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [['when', 'who', 'email', 'change'].map(esc).join(',')];
    for (const r of rows) for (const l of [].concat(describe(r))) lines.push([new Date(r.at).toISOString(), r.by.name, r.by.email, l].map(esc).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = `${rm.name} - history.csv`; a.click();
  };

  const versionsPane = h('div', {}, h('p', { text: 'Versions are kept on the server for everyone with access. Restoring saves the current state first.' }), saveNow, h('div', { style: 'height:10px' }), list);
  const activityPane = h('div', {}, h('p', { text: 'Every change to this roadmap, newest first: what changed, by whom, and when. Kept for as long as the roadmap exists.' }),
    h('div', { class: 'two' }, filter, h('button', { class: 'btn small', onclick: csv }, icon('download'), 'Download as CSV')), h('div', { style: 'height:8px' }), act);
  const panes = { versions: versionsPane, activity: activityPane };
  const body = h('div', {});
  const tabs = h('div', { class: 'seg', style: 'margin-bottom:10px' });
  const show = t => { tab = t; tabs.replaceChildren(...['versions', 'activity'].map(x => h('button', { class: x === t ? 'on' : '', type: 'button', onclick: () => show(x) }, x === 'versions' ? 'Versions' : 'Activity')));
    body.replaceChildren(tabs, panes[t]); if (t === 'activity' && !rows.length) loadMore(); };
  refresh();
  show(tab);
  dialog(`History · ${rm.name}`, body, [{ label: 'Close' }], true);
}
