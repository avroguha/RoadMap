// Shared helpers: dates as whole UTC day numbers, DOM/SVG builders, colours.

export const DAY = 86400000;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const dayOf = (y, m, d = 1) => Math.round(Date.UTC(y, m, d) / DAY);
export const toDay = s => dayOf(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const fromDay = d => new Date(d * DAY).toISOString().slice(0, 10);
export const ymd = d => {
  const t = new Date(d * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay() };
};
export const today = () => { const n = new Date(); return dayOf(n.getFullYear(), n.getMonth(), n.getDate()); };
export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toDay(s));
export const niceDate = d => { const t = ymd(d); return `${t.d} ${MONTHS[t.m]} ${t.y}`; };
export const shortDate = d => { const t = ymd(d); return `${t.d} ${MONTHS[t.m]}`; };

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clone = o => JSON.parse(JSON.stringify(o));

export function isoWeek(day) {
  const t = new Date(day * DAY);
  const thursday = new Date(t);
  thursday.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((thursday - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

// ---- header segments ------------------------------------------------------

export const UNITS = [
  ['none', 'None'], ['year', 'Years'], ['half', 'Half-years'], ['quarter', 'Quarters'],
  ['month', 'Months'], ['week', 'Weeks'], ['day', 'Days'],
];
const SPAN = { year: 12, half: 6, quarter: 3, month: 1 };

// segments cuts [d0, d1) into calendar units. fiscal = index of the month a
// fiscal year starts in (0 = January, i.e. calendar years).
export function segments(unit, d0, d1, fiscal = 0) {
  const out = [];
  if (unit === 'none' || d1 <= d0) return out;
  let cur;
  if (unit === 'day') cur = d0;
  else if (unit === 'week') cur = d0 - ((ymd(d0).wd + 6) % 7);
  else {
    const { y, m } = ymd(d0);
    cur = dayOf(y, m - (((m - fiscal + 12) % 12) % SPAN[unit]));
  }
  while (cur < d1) {
    const { y, m, d } = ymd(cur);
    let next, full, short, tiny;
    if (unit === 'day') {
      next = cur + 1; full = `${d} ${MONTHS[m]}`; short = tiny = String(d);
    } else if (unit === 'week') {
      next = cur + 7; const w = isoWeek(cur);
      full = `W${w} · ${d} ${MONTHS[m]}`; short = `W${w}`; tiny = String(w);
    } else {
      next = dayOf(y, m + SPAN[unit]);
      const k = (m - fiscal + 12) % 12;
      const fy = fiscal === 0 ? String(y) : 'FY' + String(ymd(dayOf(y, m - k + 11)).y).slice(2);
      if (unit === 'year') { full = short = fy; tiny = "'" + fy.slice(-2); }
      else if (unit === 'half') { short = tiny = 'H' + (Math.floor(k / 6) + 1); full = `${short} ${fy}`; }
      else if (unit === 'quarter') { short = tiny = 'Q' + (Math.floor(k / 3) + 1); full = `${short} ${fy}`; }
      else { short = MONTHS[m]; tiny = short[0]; full = `${short} ${y}`; }
    }
    out.push({ a: Math.max(cur, d0), b: Math.min(next, d1), full, short, tiny });
    cur = next;
  }
  return out;
}

// ---- DOM / SVG builders ---------------------------------------------------

function build(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && !(el instanceof SVGElement) && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const h = (tag, attrs, ...kids) => build(document.createElement(tag), attrs, kids);
export const s = (tag, attrs, ...kids) => build(document.createElementNS('http://www.w3.org/2000/svg', tag), attrs, kids);

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-7 3.5M3 4v4h4M12 7v5l3 2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload: 'M12 15V3M7 8l5-5 5 5M4 21h16',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeoff: 'M3 3l18 18M10.6 5.2A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.5 6.6C3.7 8.5 2 12 2 12s4 7 10 7a9.6 9.6 0 004.3-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  dots: 'M12 6h.01M12 12h.01M12 18h.01',
  moon: 'M20 14.5A8.5 8.5 0 119.5 4a7 7 0 0010.5 10.5z',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 100 10 5 5 0 000-10z',
  palette: 'M12 3a9 9 0 100 18c1.5 0 2-1 2-2s-.5-2 1-2h2a4 4 0 004-4c0-5-4-10-9-10zM7.5 12h.01M9.5 7.5h.01M14.5 7.5h.01',
  sidebar: 'M3 4h18v16H3zM9 4v16',
  panel: 'M3 4h18v16H3zM15 4v16',
  dup: 'M8 8h12v12H8zM4 16V4h12',
  folder: 'M3 6h6l2 2h10v11H3z',
  task: 'M3 9h18v6H3z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  chevron: 'M6 9l6 6 6-6',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  flagpole: 'M6 21V4M6 5h11l-2.5 3.5L17 12H6',
  lock: 'M6 11V8a6 6 0 0112 0v3M5 11h14v10H5zM12 15v3',
  unlock: 'M6 11V8a6 6 0 0111.5-2.3M5 11h14v10H5zM12 15v3',
  bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 21h4',
  share: 'M4 12v8h16v-8M12 3v13M8 7l4-4 4 4',
};
export function icon(name) {
  return s('svg', { class: 'ic', viewBox: '0 0 24 24' }, s('path', { d: ICONS[name] || '' }));
}

// ---- colours --------------------------------------------------------------

export function rgb(hex) {
  const v = hex.replace('#', '');
  const f = v.length === 3 ? v.split('').map(c => c + c).join('') : v;
  return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16));
}
const hex2 = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
export const mix = (a, b, t) => { const A = rgb(a), B = rgb(b); return '#' + A.map((v, i) => hex2(v + (B[i] - v) * t)).join(''); };
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
export const textOn = hex => luminance(hex) > .45 ? '#1b2333' : '#ffffff';

// ---- text measuring -------------------------------------------------------

const ctx = document.createElement('canvas').getContext('2d');
export const FONT = '"Segoe UI", system-ui, sans-serif';
export function textWidth(text, size = 12, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  return ctx.measureText(text).width;
}
export function ellipsize(text, maxW, size = 12, weight = 400) {
  if (textWidth(text, size, weight) <= maxW) return text;
  let t = text;
  while (t.length > 1 && textWidth(t + '…', size, weight) > maxW) t = t.slice(0, -1);
  return t.length > 1 ? t + '…' : '';
}
export function wrapText(text, maxW, maxLines, size = 12, weight = 400) {
  const words = text.split(/\s+/).filter(Boolean), lines = [];
  let line = '';
  for (const w of words) {
    const probe = line ? line + ' ' + w : w;
    if (textWidth(probe, size, weight) <= maxW || !line) line = probe;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = ellipsize(lines[maxLines - 1] + ' …', maxW, size, weight) || '…';
  }
  return lines.map(l => ellipsize(l, maxW, size, weight));
}
