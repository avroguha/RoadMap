// Import, export and clipboard.

import { h, clone, isDate, toDay, fromDay } from './util.js';
import { state, api, active, normalise, reidentify, newRoadmap, newLane, newSub, newItem, newMarker, find, change, save, eachItem, load, emit } from './store.js';
import { exportSvg } from './timeline.js';
import { themeById } from './themes.js';

const safeName = n => (n || 'roadmap').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'roadmap';

// ---- files ----------------------------------------------------------------

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// saveFile returns the saved path (native), true (browser download) or null (cancelled).
export async function saveFile(name, filter, { text, blob }) {
  if (state.info.native) {
    const body = { name, filter, title: 'Save ' + name };
    if (blob) body.base64 = await blobToBase64(blob); else body.text = text;
    const r = await api('POST', 'savefile', body);
    return r.cancelled ? null : r.path;
  }
  const url = URL.createObjectURL(blob || new Blob([text], { type: 'application/octet-stream' }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export async function openFile(filter, accept) {
  if (state.info.native) {
    const r = await api('POST', 'openfile', { filter, title: 'Import' });
    return r.cancelled ? null : { name: r.name, text: r.text };
  }
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', async () => { const f = input.files[0]; resolve(f ? { name: f.name, text: await f.text() } : null); });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

// ---- images ---------------------------------------------------------------

function stageWidth() { return Math.max(1100, document.getElementById('scroller').clientWidth - 2); }

export function svgText(rm = active()) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(exportSvg(rm, stageWidth()));
}

export async function pngBlob(rm = active(), scale = 2) {
  const svg = exportSvg(rm, stageWidth());
  const w = +svg.getAttribute('width'), hgt = +svg.getAttribute('height');
  // Keep the bitmap inside what a canvas can allocate.
  const k = Math.min(scale, 16000 / w, 16000 / hgt, Math.sqrt(120e6 / (w * hgt)));
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await img.decode();
  const canvas = h('canvas', { width: Math.round(w * k), height: Math.round(hgt * k) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = themeById(rm.view.theme).bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not render the image'))), 'image/png'));
}

export async function copyImage() {
  if (state.info.native) { await api('POST', 'clipboard-image', await pngBlob(), true); return; }
  // Hand the clipboard a promise: Safari only allows the write while the click is
  // still "fresh", which an await before it would use up.
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
}

export const exportPng = async () => saveFile(safeName(active().name) + '.png', 'PNG image|*.png', { blob: await pngBlob() });
export const exportSvgFile = () => saveFile(safeName(active().name) + '.svg', 'SVG image|*.svg', { text: svgText() });

// ---- data -----------------------------------------------------------------

export function exportRoadmap() {
  const doc = { app: 'RoadMap Studio', kind: 'roadmap', schema: 1, exported: new Date().toISOString(), roadmap: active() };
  return saveFile(safeName(active().name) + '.roadmap.json', 'RoadMap Studio roadmap|*.json', { text: JSON.stringify(doc, null, 2) });
}

export async function exportBackup() {
  await save(true);
  const doc = await api('GET', 'backup');
  const stamp = new Date().toISOString().slice(0, 10);
  return saveFile(`RoadMapStudio-backup-${stamp}.json`, 'RoadMap Studio backup|*.json', { text: JSON.stringify(doc) });
}

const BOM = String.fromCharCode(0xFEFF);   // Excel needs it to read UTF-8
const CSV_COLS = ['Swimlane', 'Sub-swimlane', 'Type', 'Name', 'Start', 'End', 'Progress', 'Status', 'Resources', 'Color', 'Label position', 'Shape', 'Hidden', 'Notes', 'Depends on', 'Priority', 'Initiative', 'Placeholder'];

export function exportCsv() {
  const q = v => { const t = String(v ?? ''); return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const rows = [CSV_COLS.join(',')];
  eachItem(active(), (it, sub, lane) => rows.push([lane.name, sub.name, it.type, it.name, it.type === 'task' ? it.start : it.date,
    it.type === 'task' ? it.end : it.date, it.progress, it.status, it.resources, it.color, it.labelPos, it.shape || '', it.hidden ? 'yes' : '', it.notes,
    it.deps.map(d => { const p = find(d.id)?.item; return p ? p.name + (d.type === 'FS' ? '' : ` [${d.type}]`) : ''; }).filter(Boolean).join('; '), it.priority, lane.group, it.placeholder ? 'yes' : ''].map(q).join(',')));
  for (const m of active().markers) rows.push(['', '', 'keydate', m.name, m.date, m.date, '', '', '', m.color, '', '', m.hidden ? 'yes' : '', '', '', '', '', ''].map(q).join(','));
  return saveFile(safeName(active().name) + '.csv', 'CSV (Excel)|*.csv', { text: BOM + rows.join('\r\n') });
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = (text.startsWith(BOM) ? text.slice(1) : text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' && !text.includes(',')) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

function normaliseDate(v) {
  v = String(v || '').trim();
  if (isDate(v)) return v;
  let m = v.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);           // day first, as Excel writes it outside the US
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const t = Date.parse(v);
  return isNaN(t) ? '' : new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function roadmapFromCsv(text, name) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV file has no rows');
  const head = rows[0].map(x => x.trim().toLowerCase());
  const col = (...names) => head.findIndex(x => names.includes(x));
  const ix = { lane: col('swimlane', 'lane'), sub: col('sub-swimlane', 'sub swimlane', 'sublane', 'sub-lane'), type: col('type'), name: col('name', 'task', 'title'),
    start: col('start', 'start date', 'date'), end: col('end', 'end date', 'finish'), progress: col('progress', '% complete', 'percent complete', '%completed'),
    status: col('status'), resources: col('resources', 'resource', 'resources needed'), color: col('color', 'colour'), label: col('label position'),
    shape: col('shape'), hidden: col('hidden'), notes: col('notes'), deps: col('depends on', 'dependencies', 'predecessors'), priority: col('priority'), group: col('initiative', 'sub initiative', 'sub-initiative', 'group'), placeholder: col('placeholder', 'tentative', 'not scoped') };
  if (ix.name < 0 || ix.start < 0) throw new Error('The CSV needs at least "Name" and "Start" columns');
  const rm = newRoadmap(name.replace(/\.csv$/i, ''));
  rm.lanes = [];
  let min = Infinity, max = -Infinity;
  const wanted = [];
  for (const r of rows.slice(1)) {
    const get = k => (ix[k] >= 0 ? (r[ix[k]] ?? '').trim() : '');
    const start = normaliseDate(get('start')); if (!start) continue;
    const end = normaliseDate(get('end')) || start;
    if (/^key/i.test(get('type'))) { rm.markers.push({ ...newMarker(get('name'), toDay(start)), color: /^#[0-9a-f]{6}$/i.test(get('color')) ? get('color') : '' });
      min = Math.min(min, toDay(start)); max = Math.max(max, toDay(start)); continue; }
    const laneName = get('lane') || 'Swimlane', subName = get('sub');
    let lane = rm.lanes.find(l => l.name === laneName);
    if (!lane) { lane = { ...newLane(laneName), group: get('group'), subs: [] }; rm.lanes.push(lane); }
    let sub = lane.subs.find(x => x.name === subName);
    if (!sub) { sub = newSub(subName); lane.subs.push(sub); }
    const milestone = /^m/i.test(get('type')) || (!get('type') && end === start && ix.end >= 0 && !get('end'));
    const it = newItem(milestone ? 'milestone' : 'task', toDay(start), Math.max(toDay(end), toDay(start)));
    Object.assign(it, { name: get('name'), progress: parseFloat(get('progress')) || 0, status: get('status').toLowerCase().replace(/\s+/g, '') || 'none',
      resources: get('resources'), color: /^#[0-9a-f]{6}$/i.test(get('color')) ? get('color') : '', labelPos: get('label').toLowerCase(), notes: get('notes'),
      hidden: /^(y|true|1)/i.test(get('hidden')), placeholder: /^(y|true|1)/i.test(get('placeholder')),
      priority: { p1: 'critical', p2: 'high', p3: 'medium', p4: 'low' }[get('priority').toLowerCase()] || get('priority').toLowerCase() });
    if (milestone && get('shape')) it.shape = get('shape').toLowerCase();
    if (get('deps')) wanted.push([it, get('deps')]);
    sub.items.push(it);
    min = Math.min(min, toDay(start)); max = Math.max(max, toDay(end));
  }
  if (!isFinite(min)) throw new Error('No rows with a usable start date were found');
  // Links are written by name; resolve them now that every row exists.
  const byName = new Map(); eachItem(rm, it => byName.set(it.name.toLowerCase(), it));
  for (const [it, text] of wanted) for (const part of text.split(';')) {
    const m = part.trim().match(/^(.*?)(?:\s*\[(FS|SS|FF)\])?$/i), pred = m && byName.get(m[1].trim().toLowerCase());
    if (pred && pred !== it) it.deps.push({ id: pred.id, type: (m[2] || 'FS').toUpperCase() });
  }
  const pad = Math.max(7, Math.round((max - min) * .04));
  rm.start = fromDay(min - pad); rm.end = fromDay(max + pad);
  return normalise(rm);
}

// importText returns a short description of what was imported.
export async function importText(text, name, confirmReplace) {
  if (/\.csv$/i.test(name) || !/^\s*[{[]/.test(text)) {
    const rm = roadmapFromCsv(text, name);
    change(() => { state.ws.roadmaps.push(rm); state.ws.activeId = rm.id; state.sel = null; });
    return `Imported "${rm.name}" from CSV`;
  }
  const doc = JSON.parse(text);
  if (doc.kind === 'backup') {
    if (!(await confirmReplace())) return null;
    const r = await api('POST', 'restore', doc);
    await load(); state.sel = null; emit();
    return `Backup restored (${state.ws.roadmaps.length} roadmaps, ${r.snapshots} history versions)`;
  }
  const incoming = doc.kind === 'roadmap' ? [doc.roadmap] : Array.isArray(doc.roadmaps) ? doc.roadmaps : doc.lanes ? [doc] : null;
  if (!incoming || !incoming.length) throw new Error('This file is not a RoadMap Studio export');
  const added = incoming.map(r => reidentify(normalise(clone(r))));
  change(() => { state.ws.roadmaps.push(...added); state.ws.activeId = added[0].id; state.sel = null; });
  return added.length === 1 ? `Imported "${added[0].name}"` : `Imported ${added.length} roadmaps`;
}
