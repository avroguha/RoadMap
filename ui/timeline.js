// Timeline layout, SVG drawing and direct manipulation.
//
// computeLayout() turns a roadmap into plain geometry; draw() paints that
// geometry. The same two functions produce the on-screen view and the
// exported image, so what is copied is what is shown.

import { s, toDay, fromDay, today, segments, textWidth, ellipsize, wrapText, mix, textOn, clamp, niceDate, shortDate, FONT } from './util.js';
import { themeById, statusById, priorityById, STATUSES, PRIORITIES } from './themes.js';
import { state, active, find, begin, commit, cancel, select, itemStart, itemEnd, move, depGap, addDep } from './store.js';

const PAD = 18, TITLE_H = 46, HEAD_H = 28, LANE_GAP = 8, SUB_PAD = 4, EXTRA = 15, COL_GAP = 5;
const ROW_H = { compact: 28, cozy: 36, roomy: 46 };
const BAR_H = { compact: 18, cozy: 24, roomy: 30 };

// ---- layout ---------------------------------------------------------------

export function laneColor(rm, lane, index) {
  const pal = themeById(rm.view.theme).palette;
  return lane.color || pal[index % pal.length];
}

function labelParts(item, v) {
  const meta = [];
  if (item.placeholder) meta.push('TBC');
  else if (v.showPercent && item.type === 'task') meta.push(item.progress + '%');
  if (v.showDates) meta.push(item.type === 'task' ? `${shortDate(toDay(item.start))} – ${shortDate(toDay(item.end))}` : shortDate(toDay(item.date)));
  if (v.showResources && item.resources) meta.push(item.resources);
  return { name: item.name, meta: meta.join(' · ') };
}

export function computeLayout(rm, { showHidden = false, width = 1200 } = {}) {
  const v = rm.view, theme = themeById(v.theme);
  const d0 = toDay(rm.start), d1 = toDay(rm.end) + 1, days = d1 - d0;
  const horizontal = v.laneLabels === 'horizontal';
  const laneW = horizontal ? 118 : 40, subW = clamp(+v.subWidth || 150, 60, 320);
  // Initiatives: an optional column to the left, one cell per run of swimlanes sharing a name.
  const hasGroups = rm.lanes.some(l => (l.group || '').trim() && (showHidden || !l.hidden));
  const groupW = hasGroups ? 34 : 0, lx = PAD + (hasGroups ? groupW + COL_GAP : 0);
  const x0 = lx + laneW + COL_GAP + subW + COL_GAP + 2;
  const ppd = v.zoom === 'fit' ? Math.max(.25, (width - x0 - PAD) / days) : clamp(+v.zoom || 3, .25, 60);
  const tlW = days * ppd;
  const X = d => x0 + (d - d0) * ppd;
  const rowH = ROW_H[v.density] || 36, barH = BAR_H[v.density] || 24;

  let y = PAD + (v.showTitle ? TITLE_H : 0);
  const heads = [];
  for (const [tier, unit] of [['top', v.top], ['bottom', v.bottom]]) {
    if (!unit || unit === 'none') continue;
    heads.push({ tier, unit, y, h: HEAD_H, segs: segments(unit, d0, d1, +v.fiscal || 0) });
    y += HEAD_H + 3;
  }
  // Key dates: labels sit in their own band under the header, packed into rows.
  const marks = (rm.markers || []).filter(m => (showHidden || !m.hidden) && toDay(m.date) >= d0 && toDay(m.date) < d1)
    .sort((a, b) => toDay(a.date) - toDay(b.date)).map(m => {
      const x = X(toDay(m.date)) + ppd / 2, text = shortDate(toDay(m.date));
      const w = 22 + textWidth(m.name, 11, 700) + 6 + textWidth(text, 10, 400) + 8;
      const px = clamp(x - w / 2, x0, Math.max(x0, x0 + tlW - w));
      return { m, x, w, px, text, color: m.color || (theme.dark ? theme.muted : theme.head1) };
    });
  const markRows = [];
  for (const k of marks) { let r = markRows.findIndex(end => end + 6 <= k.px); if (r < 0) { r = markRows.length; markRows.push(0); } markRows[r] = k.px + k.w; k.y = y + r * 21; }
  const marksTop = y;
  y += markRows.length * 21 + (markRows.length ? 2 : 0);
  const top = y + 5;
  y = top;

  const lanes = [], placed = new Map();
  rm.lanes.forEach((lane, li) => {
    if (lane.hidden && !showHidden) return;
    const color = laneColor(rm, lane, li);
    const subs = lane.subs.filter(sb => showHidden || !sb.hidden);
    const L = { lane, color, y, subs: [], ghost: lane.hidden };
    subs.forEach((sub, si) => {
      const subColor = sub.color || (v.colorBy === 'sub' ? mix(color, si % 2 ? '#ffffff' : '#000000', Math.min(.45, .16 * Math.ceil(si / 2) + (si ? .08 : 0))) : color);
      const S = { sub, y, rows: [], color: subColor, ghost: lane.hidden || sub.hidden };
      const items = sub.items.filter(it => showHidden || !it.hidden).map(item => {
        const a = itemStart(item), b = itemEnd(item), isTask = item.type === 'task';
        const base = item.color || (v.colorBy === 'status' ? statusById(item.status).color : v.colorBy === 'priority' ? priorityById(item.priority).color : subColor);
        const t = labelParts(item, v);
        const dot = v.showStatusDot && v.colorBy !== 'status' && item.status && item.status !== 'none';
        const wName = textWidth(t.name, 12, 600), wMeta = t.meta ? textWidth(t.meta, 11, 400) + 7 : 0;
        // Priority shown beside the name (badge / arrows) takes room in the label.
        const prio = item.priority && v.colorBy !== 'priority' ? priorityById(item.priority) : null;
        const badgeW = !prio ? 0 : v.priorityStyle === 'badge' ? 23 : v.priorityStyle === 'arrows' ? 14 : 0;
        let labelW = wName + wMeta + (dot ? 11 : 0) + badgeW;
        const bx0 = isTask ? X(a) : X(a) + ppd / 2 - barH / 2;
        const bx1 = isTask ? Math.max(X(b + 1), X(a) + 5) : bx0 + barH;
        let pos = item.labelPos || v.labelPos || 'inside';
        if (pos === 'inside' && isTask && labelW + 14 > bx1 - bx0 && labelW - wMeta + 14 <= bx1 - bx0) {
          // The name fits inside the bar but the details do not: keep the name, drop the details.
          t.meta = ''; labelW -= wMeta;
        }
        if (pos === 'inside' && (!isTask || labelW + 14 > bx1 - bx0)) pos = 'right';
        // A side label that would run off the timeline flips to the other side.
        if (pos === 'right' && bx1 + 7 + labelW > x0 + tlW && bx0 - 7 - labelW >= x0) pos = 'left';
        else if (pos === 'left' && bx0 - 7 - labelW < x0 && bx1 + 7 + labelW <= x0 + tlW) pos = 'right';
        let e0 = bx0, e1 = bx1;
        if (pos === 'left') e0 = bx0 - 7 - labelW;
        else if (pos === 'right') e1 = bx1 + 7 + labelW;
        else if (pos === 'above' || pos === 'below') {
          if (isTask) e1 = Math.max(bx1, bx0 + labelW);
          else { e0 = Math.min(bx0, (bx0 + bx1) / 2 - labelW / 2); e1 = Math.max(bx1, (bx0 + bx1) / 2 + labelW / 2); }
        }
        return { item, sub, lane, a, b, isTask, color: base, t, dot, prio, badgeW, labelW, wName, x0: bx0, x1: bx1, pos, e0, e1, barH,
          ghost: S.ghost || item.hidden };
      }).filter(p => p.b >= d0 && p.a < d1);

      const rows = [];
      const order = v.layout === 'rows' ? items : [...items].sort((p, q) => p.a - q.a);
      for (const p of order) {
        let row = v.layout === 'rows' ? null : rows.find(r => r.end + 10 <= p.e0);
        if (!row) { row = { items: [], end: -Infinity }; rows.push(row); }
        row.items.push(p); row.end = Math.max(row.end, p.e1);
      }
      if (!rows.length) rows.push({ items: [], end: 0 });
      y += SUB_PAD;
      for (const row of rows) {
        const above = row.items.some(p => p.pos === 'above'), below = row.items.some(p => p.pos === 'below');
        const lineExtra = v.progress === 'line' ? 3 : 0;
        row.y = y; row.h = rowH + (above ? EXTRA : 0) + (below ? EXTRA : 0) + lineExtra;
        const barY = y + (above ? EXTRA : 0) + (rowH - barH) / 2;
        for (const p of row.items) { p.barY = barY; p.cy = barY + barH / 2; placed.set(p.item.id, p); }
        y += row.h;
      }
      y += SUB_PAD;
      S.rows = rows; S.h = y - S.y;
      L.subs.push(S);
    });
    if (!L.subs.length) { y += rowH; }
    L.h = y - L.y;
    L.merged = v.laneLabels !== 'vertical' && L.subs.length === 1 && !L.subs[0].sub.name;
    lanes.push(L);
    y += LANE_GAP;
  });
  if (!lanes.length) y += 120;

  const groups = [];
  for (const Ln of lanes) {
    const last = groups[groups.length - 1], name = (Ln.lane.group || '').trim();
    if (last && last.name === name) last.h = Ln.y + Ln.h - last.y; else groups.push({ name, y: Ln.y, h: Ln.h });
  }

  // Dependency links between items that are both on screen.
  const links = [];
  if (v.showDeps) for (const p of placed.values()) for (const d of p.item.deps || []) {
    const q = placed.get(d.id);
    if (q) links.push({ from: q, to: p, type: d.type, late: depGap(q.item, p.item, d.type) > 0 });
  }

  // Legend: only what this picture actually uses, so a reader can decode it.
  const legend = [];
  if (v.showLegend) {
    const all = [...placed.values()].filter(p => !p.ghost);
    if (all.some(p => p.item.placeholder)) legend.push({ kind: 'placeholder', label: 'Placeholder - not scoped yet' });
    const statusUsed = STATUSES.filter(x => x.id !== 'none' && all.some(p => p.item.status === x.id));
    if (v.colorBy === 'status' || v.showStatusDot) for (const x of statusUsed) legend.push({ kind: v.colorBy === 'status' ? 'swatch' : 'dot', color: x.color, label: x.name });
    if (v.priorityStyle !== 'off' || v.colorBy === 'priority') for (const x of PRIORITIES) if (x.id && all.some(p => p.item.priority === x.id))
      legend.push({ kind: v.colorBy === 'priority' ? 'swatch' : 'prio', color: x.color, label: `${x.short} ${x.name}`, short: x.short });
    if (links.some(l => l.late)) legend.push({ kind: 'late', label: 'Dependency conflict' });
    let lx2 = x0, ly = y - (lanes.length ? LANE_GAP : 0) + 12;
    for (const e of legend) {
      e.w = 22 + textWidth(e.label, 11, 400) + 16;
      if (lx2 + e.w > x0 + tlW && lx2 > x0) { lx2 = x0; ly += 20; }
      e.x = lx2; e.y = ly; lx2 += e.w;
    }
    if (legend.length) y = ly + 18 + LANE_GAP;
  }

  return { rm, v, theme, d0, d1, ppd, X, x0, tlW, legend, laneW, subW, top, heads, lanes, placed, links, marks, marksTop, groups: groups.filter(g => g.name), groupW, lx, barH, rowH, horizontal,
    W: Math.ceil(x0 + tlW + PAD), H: Math.ceil(y - (lanes.length ? LANE_GAP : 0) + PAD) };
}

// ---- drawing --------------------------------------------------------------

function barPath(shape, x, y, w, h) {
  if (shape === 'chevron') {
    const k = Math.min(h / 2, w / 2);
    return `M${x},${y}H${x + w - k}L${x + w},${y + h / 2}L${x + w - k},${y + h}H${x}L${x + k * .6},${y + h / 2}Z`;
  }
  const r = Math.min(shape === 'pill' ? h / 2 : shape === 'square' ? 2 : 6, w / 2);
  return `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
}

function shapePath(shape, cx, cy, r) {
  switch (shape) {
    case 'circle': return `M${cx - r},${cy}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0Z`;
    case 'square': { const q = r * .82; return `M${cx - q},${cy - q}h${2 * q}v${2 * q}h${-2 * q}Z`; }
    case 'triangle': return `M${cx},${cy + r}L${cx - r},${cy - r * .8}H${cx + r}Z`;
    case 'flag': return `M${cx - r * .7},${cy + r}V${cy - r}H${cx + r}L${cx + r * .45},${cy - r * .3}L${cx + r},${cy + r * .4}H${cx - r * .7 + 2.4}V${cy + r}Z`;
    case 'star': {
      let d = '';
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? r * .48 : r * 1.12, ang = -Math.PI / 2 + i * Math.PI / 5;
        d += (i ? 'L' : 'M') + (cx + rad * Math.cos(ang)).toFixed(2) + ',' + (cy + rad * Math.sin(ang)).toFixed(2);
      }
      return d + 'Z';
    }
    default: return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
  }
}

// roundedPath joins points with axis-aligned segments and rounded corners.
function roundedPath(pts, r = 6) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const k = Math.min(r, Math.hypot(bx - ax, by - ay) / 2, Math.hypot(cx - bx, cy - by) / 2);
    const ux = Math.sign(bx - ax), uy = Math.sign(by - ay), vx = Math.sign(cx - bx), vy = Math.sign(cy - by);
    d += `L${bx - ux * k},${by - uy * k}Q${bx},${by} ${bx + vx * k},${by + vy * k}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${last[0]},${last[1]}`;
}

// linkRoute returns the corner points of a dependency arrow and the way its head points (+1 right, -1 left).
export function linkRoute(link) {
  const a = link.from, b = link.to, gap = 9;
  const dropY = b.cy > a.cy ? a.barY + a.barH + 5 : a.barY - 5;   // lane between the two rows
  if (link.type === 'FF') {
    const x = Math.max(a.x1, b.x1) + gap + 3;
    return { pts: [[a.x1, a.cy], [x, a.cy], [x, b.cy], [b.x1 + 1, b.cy]], dir: -1 };
  }
  const ax = link.type === 'SS' ? a.x0 : a.x1;
  if (link.type === 'SS') {
    const x = Math.min(a.x0, b.x0) - gap - 3;
    return { pts: [[ax, a.cy], [x, a.cy], [x, b.cy], [b.x0 - 1, b.cy]], dir: 1 };
  }
  if (b.x0 - 1 >= ax + gap * 2 || a.cy === b.cy) {
    const x = a.cy === b.cy ? ax : ax + gap;
    return { pts: a.cy === b.cy ? [[ax, a.cy], [b.x0 - 1, b.cy]] : [[ax, a.cy], [x, a.cy], [x, b.cy], [b.x0 - 1, b.cy]], dir: b.x0 >= ax ? 1 : -1 };
  }
  // The dependent item starts before its predecessor ends: loop back around.
  return { pts: [[ax, a.cy], [ax + gap, a.cy], [ax + gap, dropY], [b.x0 - gap - 3, dropY], [b.x0 - gap - 3, b.cy], [b.x0 - 1, b.cy]], dir: 1 };
}

function labelGeometry(p) {
  const mid = (p.x0 + p.x1) / 2;
  switch (p.pos) {
    case 'inside': return { x: p.x0 + 8, y: p.cy, anchor: 'start' };
    case 'left': return { x: p.x0 - 7, y: p.cy, anchor: 'end' };
    case 'above': return p.isTask ? { x: p.x0 + 1, y: p.barY - 7, anchor: 'start' } : { x: mid, y: p.barY - 7, anchor: 'middle' };
    case 'below': return p.isTask ? { x: p.x0 + 1, y: p.barY + p.barH + 9, anchor: 'start' } : { x: mid, y: p.barY + p.barH + 9, anchor: 'middle' };
    default: return { x: p.x1 + 7, y: p.cy, anchor: 'start' };
  }
}

export function labelZones(p) {
  const w = Math.max(54, Math.min(p.labelW, 150)), hgt = 16, mid = (p.x0 + p.x1) / 2;
  const z = {
    left: { x: p.x0 - 7 - w, y: p.cy - hgt / 2, w, h: hgt },
    right: { x: p.x1 + 7, y: p.cy - hgt / 2, w, h: hgt },
    above: { x: p.isTask ? p.x0 : mid - w / 2, y: p.barY - hgt - 1, w: p.isTask ? Math.max(w, p.x1 - p.x0) : w, h: hgt },
    below: { x: p.isTask ? p.x0 : mid - w / 2, y: p.barY + p.barH + 1, w: p.isTask ? Math.max(w, p.x1 - p.x0) : w, h: hgt },
  };
  if (p.isTask) z.inside = { x: p.x0 + 3, y: p.cy - hgt / 2 + 1, w: Math.max(12, p.x1 - p.x0 - 6), h: hgt - 2 };
  return z;
}

export function draw(svg, L, ui = {}) {
  const { theme: T, v, x0, tlW, top, W, H } = L;
  const live = !!ui.interactive, sel = ui.sel, drag = ui.drag;
  const accent = T.dark ? '#9db2ff' : '#3455db';
  svg.replaceChildren();
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('font-family', FONT.replace(/"/g, "'"));

  const defs = s('defs', {},
    s('filter', { id: 'rmShadow', x: '-10%', y: '-30%', width: '120%', height: '180%' },
      s('feDropShadow', { dx: 0, dy: 1.2, stdDeviation: 1.3, 'flood-color': '#0b1430', 'flood-opacity': T.dark ? .55 : .22 })),
    s('clipPath', { id: 'rmClip' }, s('rect', { x: x0, y: top - 4, width: tlW, height: H - top + 4 })));
  const gradients = new Map();
  const gradient = color => {
    if (!gradients.has(color)) {
      const id = 'rmG' + gradients.size;
      defs.append(s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: 0, 'stop-color': mix(color, '#ffffff', .32) }), s('stop', { offset: 1, 'stop-color': mix(color, '#000000', .08) })));
      gradients.set(color, `url(#${id})`);
    }
    return gradients.get(color);
  };
  // Placeholder (not scoped yet) fills: a pattern per colour.
  const patterns = new Map();
  const placeholderFill = color => {
    const style = v.placeholderStyle || 'hatch', base = style === 'grey' ? mix(T.bg, T.muted, .35) : color;
    if (style === 'dashed') return T.bg;
    if (style === 'grey') return mix(T.bg, T.muted, .22);
    const key = style + base;
    if (!patterns.has(key)) {
      const id = 'rmH' + patterns.size, soft = mix(T.bg, base, T.dark ? .3 : .16), ink = mix(T.bg, base, .75);
      defs.append(style === 'dots'
        ? s('pattern', { id, width: 7, height: 7, patternUnits: 'userSpaceOnUse' }, s('rect', { width: 7, height: 7, fill: soft }), s('circle', { cx: 3.5, cy: 3.5, r: 1.3, fill: ink }))
        : s('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, s('rect', { width: 8, height: 8, fill: soft }), s('rect', { width: 3, height: 8, fill: ink, opacity: .7 })));
      patterns.set(key, `url(#${id})`);
    }
    return patterns.get(key);
  };
  const placeholderStroke = color => (v.placeholderStyle === 'grey' ? T.muted : color);
  svg.append(defs, s('rect', { width: W, height: H, fill: T.bg, 'data-role': 'bg' }));

  // -- lane bands, grid and today line
  const back = s('g');
  for (const Ln of L.lanes) {
    back.append(s('rect', { x: x0, y: Ln.y, width: tlW, height: Ln.h, rx: 8, fill: mix(T.bg, Ln.color, T.dark ? .13 : .07), opacity: Ln.ghost ? .4 : 1 }));
    Ln.subs.slice(1).forEach(S => back.append(s('line', { x1: x0, x2: x0 + tlW, y1: S.y, y2: S.y, stroke: mix(T.bg, Ln.color, .28), 'stroke-width': 1, 'stroke-dasharray': '3 3' })));
  }
  const gridTop = top - 4, gridBottom = (L.legend.length ? L.legend[0].y - 12 : H - PAD);
  const tiers = L.heads;
  if (tiers.length) {
    const fine = tiers[tiers.length - 1];
    if (fine.segs.length < 400) fine.segs.slice(1).forEach(g => back.append(s('line', { x1: L.X(g.a), x2: L.X(g.a), y1: gridTop, y2: gridBottom, stroke: T.grid, 'stroke-width': 1 })));
    if (tiers.length > 1) tiers[0].segs.slice(1).forEach(g => back.append(s('line', { x1: L.X(g.a), x2: L.X(g.a), y1: gridTop, y2: gridBottom, stroke: mix(T.grid, T.text, .28), 'stroke-width': 1.2 })));
  }
  svg.append(back);

  // Key-date lines sit behind the work, so bars and labels stay readable across them.
  const gMarks = s('g', { 'pointer-events': 'none' });
  for (const k of L.marks) gMarks.append(s('line', { x1: k.x, x2: k.x, y1: k.y + 18, y2: gridBottom, stroke: k.color, 'stroke-width': live && sel?.id === k.m.id ? 2.6 : 1.8,
    'stroke-dasharray': k.m.line === 'dashed' ? '6 4' : null, opacity: k.m.hidden ? .3 : .9 }));
  svg.append(gMarks);

  if (drag?.kind === 'move' && drag.targetSub) {
    for (const Ln of L.lanes) for (const S of Ln.subs) if (S.sub.id === drag.targetSub)
      svg.append(s('rect', { x: x0, y: S.y + 1, width: tlW, height: S.h - 2, rx: 8, fill: accent, opacity: .12, stroke: accent, 'stroke-dasharray': '5 4' }));
  }

  // -- dependency arrows (under the bars, so they never hide a label)
  const gLinks = s('g', { 'clip-path': 'url(#rmClip)' });
  for (const link of L.links) {
    const { pts, dir } = linkRoute(link), end = pts[pts.length - 1];
    const color = link.late ? '#e5484d' : mix(T.text, T.bg, .38), ghost = link.from.ghost || link.to.ghost;
    const hot = live && sel && (sel.id === link.from.item.id || sel.id === link.to.item.id);
    const g = s('g', { opacity: ghost ? .3 : 1, 'data-role': 'dep', 'data-from': link.from.item.id, 'data-to': link.to.item.id, class: 'dep' },
      s('title', {}, `${link.to.item.name} depends on ${link.from.item.name} (${link.type})${link.late ? ' - conflict' : ''}`),
      s('path', { d: roundedPath(pts), fill: 'none', stroke: hot && !link.late ? accent : color, 'stroke-width': hot ? 2.2 : 1.5, 'stroke-dasharray': link.late ? '5 3' : null, 'stroke-linejoin': 'round' }),
      s('path', { d: `M${end[0]},${end[1]}l${-7 * dir},-4v8Z`, fill: hot && !link.late ? accent : color }));
    if (live) g.append(s('path', { d: roundedPath(pts), fill: 'none', stroke: 'transparent', 'stroke-width': 11 }));
    gLinks.append(g);
  }
  svg.append(gLinks);
  if (drag?.kind === 'link') {
    const p = L.placed.get(drag.id), tgt = drag.target && L.placed.get(drag.target);
    if (p) svg.append(s('g', { 'pointer-events': 'none' },
      tgt ? s('rect', { x: tgt.x0 - 4, y: tgt.barY - 4, width: tgt.x1 - tgt.x0 + 8, height: tgt.barH + 8, rx: 10, fill: accent, 'fill-opacity': .15, stroke: accent, 'stroke-width': 2 }) : null,
      s('path', { d: `M${p.x1},${p.cy}L${drag.x},${drag.y}`, stroke: accent, 'stroke-width': 2, 'stroke-dasharray': '5 4', fill: 'none' }),
      s('circle', { cx: drag.x, cy: drag.y, r: 4, fill: accent })));
  }

  // -- items
  const gItems = s('g', { 'clip-path': 'url(#rmClip)' });
  for (const p of L.placed.values()) gItems.append(drawItem(p));
  svg.append(gItems);


  const t = today();
  if (v.showToday && t >= L.d0 && t < L.d1) {
    const tx = L.X(t) + L.ppd / 2;
    svg.append(s('g', { 'pointer-events': 'none' },
      s('line', { x1: tx, x2: tx, y1: gridTop, y2: gridBottom, stroke: '#e5484d', 'stroke-width': 1.6, 'stroke-dasharray': '4 3' }),
      s('rect', { x: tx - 21, y: gridTop + 1, width: 42, height: 14, rx: 7, fill: '#e5484d' }),
      s('text', { x: tx, y: gridTop + 11.4, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 700, fill: '#fff' }, 'TODAY')));
  }

  if (drag?.kind === 'label') {
    const p = L.placed.get(drag.id);
    if (p) {
      const g = s('g', { 'pointer-events': 'none' });
      for (const [name, z] of Object.entries(labelZones(p))) {
        const on = drag.zone === name;
        g.append(s('rect', { x: z.x, y: z.y, width: z.w, height: z.h, rx: 5, fill: on ? accent : T.bg, 'fill-opacity': on ? .9 : .75, stroke: accent, 'stroke-width': 1.2, 'stroke-dasharray': on ? null : '3 3' }),
          s('text', { x: z.x + z.w / 2, y: z.y + z.h / 2 + 3.2, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: on ? '#fff' : accent }, name.toUpperCase()));
      }
      svg.append(g);
    }
  }

  if (L.legend.length) {
    const g = s('g', { 'pointer-events': 'none' });
    for (const e of L.legend) {
      const cy = e.y + 7;
      if (e.kind === 'placeholder') g.append(s('rect', { x: e.x, y: cy - 6, width: 18, height: 12, rx: 3, fill: placeholderFill(T.palette[0]), stroke: placeholderStroke(T.palette[0]), 'stroke-width': 1.3, 'stroke-dasharray': '4 2.5' }));
      else if (e.kind === 'swatch') g.append(s('rect', { x: e.x + 3, y: cy - 5.5, width: 12, height: 11, rx: 3, fill: e.color }));
      else if (e.kind === 'dot') g.append(s('circle', { cx: e.x + 9, cy, r: 4, fill: e.color }));
      else if (e.kind === 'late') g.append(s('path', { d: `M${e.x},${cy}h17`, stroke: '#e5484d', 'stroke-width': 1.6, 'stroke-dasharray': '5 3' }));
      else if (v.priorityStyle === 'badge') g.append(s('rect', { x: e.x, y: cy - 6.5, width: 19, height: 13, rx: 4, fill: e.color }), s('text', { x: e.x + 9.5, y: cy + 3, 'text-anchor': 'middle', 'font-size': 8.5, 'font-weight': 700, fill: '#ffffff' }, e.short));
      else g.append(s('rect', { x: e.x + 3, y: cy - 5.5, width: 12, height: 11, rx: 3, fill: e.color }));
      g.append(s('text', { x: e.x + 24, y: cy + 3.8, 'font-size': 11, fill: T.muted }, e.kind === 'prio' && v.priorityStyle === 'badge' ? e.label.slice(3) : e.label));
    }
    svg.append(g);
  }

  // -- sticky label columns and header
  const gLeft = s('g', { id: 'rmLeft' }), gHead = s('g', { id: 'rmHead' }), gCorner = s('g', { id: 'rmCorner' });
  gLeft.append(s('rect', { x: 0, y: 0, width: x0 - 1, height: H, fill: T.bg }));
  for (const Ln of L.lanes) {
    const isSel = live && sel?.id === Ln.lane.id;
    const cellW = Ln.merged ? L.laneW + COL_GAP + L.subW : L.laneW;
    const g = s('g', { 'data-role': 'lanecell', 'data-id': Ln.lane.id, class: 'lanecell', opacity: Ln.ghost ? .4 : 1 });
    g.append(s('rect', { x: L.lx, y: Ln.y, width: cellW, height: Ln.h, rx: 8, fill: v.barFill === 'gradient' ? gradient(Ln.color) : Ln.color,
      stroke: isSel ? T.text : 'none', 'stroke-width': 2 }));
    const fg = textOn(Ln.color), cx = L.lx + cellW / 2, cy = Ln.y + Ln.h / 2;
    if (Ln.merged || L.horizontal) {
      const lines = wrapText(Ln.lane.name, cellW - 14, Math.max(1, Math.floor((Ln.h - 6) / 15)), 12.5, 700);
      lines.forEach((ln, i) => g.append(s('text', { x: cx, y: cy + (i - (lines.length - 1) / 2) * 15 + 4.3, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 700, fill: fg }, ln)));
    } else {
      const lines = wrapText(Ln.lane.name, Ln.h - 12, Ln.h > 70 ? 2 : 1, 12.5, 700);
      lines.forEach((ln, i) => g.append(s('text', { x: cx, y: cy + (i - (lines.length - 1) / 2) * 15 + 4.3, transform: `rotate(-90 ${cx} ${cy})`,
        'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 700, 'letter-spacing': '.02em', fill: fg }, ln)));
    }
    gLeft.append(g);
    if (!Ln.merged) for (const S of Ln.subs) {
      const sx = L.lx + L.laneW + COL_GAP, fill = mix(T.bg, S.color, T.dark ? .34 : .2), subSel = live && sel?.id === S.sub.id;
      const sg = s('g', { 'data-role': 'subcell', 'data-id': S.sub.id, class: 'subcell', opacity: S.ghost && !Ln.ghost ? .4 : Ln.ghost ? .4 : 1 });
      sg.append(s('rect', { x: sx, y: S.y + 1.5, width: L.subW, height: S.h - 3, rx: 7, fill, stroke: subSel ? T.text : 'none', 'stroke-width': 2 }),
        s('rect', { x: sx, y: S.y + 1.5, width: 4, height: S.h - 3, rx: 2, fill: S.color }));
      const lines = wrapText(S.sub.name || '—', L.subW - 22, Math.max(1, Math.floor((S.h - 6) / 14)), 12, 600);
      lines.forEach((ln, i) => sg.append(s('text', { x: sx + 13, y: S.y + S.h / 2 + (i - (lines.length - 1) / 2) * 14 + 4.2, 'font-size': 12, 'font-weight': 600, fill: T.text }, ln)));
      gLeft.append(sg);
    }
  }
  for (const G of L.groups) {
    const cx = PAD + L.groupW / 2, cy = G.y + G.h / 2;
    const g = s('g', { 'data-role': 'groupcell', 'data-group': G.name, class: 'groupcell' }, s('title', {}, 'Initiative - double-click to rename'),
      s('rect', { x: PAD, y: G.y, width: L.groupW, height: G.h, rx: 8, fill: T.head1 }));
    const lines = wrapText(G.name.toUpperCase(), G.h - 14, 1, 12.5, 700);
    lines.forEach(ln => g.append(s('text', { x: cx, y: cy + 4.3, transform: `rotate(-90 ${cx} ${cy})`, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 700, 'letter-spacing': '.04em', fill: T.head1Text }, ln)));
    gLeft.append(g);
  }
  if (drag?.kind === 'reorder' && drag.lineY != null)
    gLeft.append(s('rect', { x: drag.type === 'lane' ? L.lx : L.lx + L.laneW + COL_GAP, y: drag.lineY - 1.5, width: drag.type === 'lane' ? x0 - L.lx - 6 : L.subW, height: 3, rx: 1.5, fill: accent }));

  gHead.append(s('rect', { x: 0, y: 0, width: W, height: top - 4, fill: T.bg }));
  tiers.forEach((tier, ti) => {
    const primary = tier.tier === 'top' || tiers.length === 1;
    const fill = primary ? T.head1 : T.head2, fg = primary ? T.head1Text : T.head2Text, size = primary ? 12 : 11.5, weight = primary ? 700 : 600;
    const useShort = tiers.length > 1 && ti > 0;
    for (const g of tier.segs) {
      const gx = L.X(g.a), gw = L.X(g.b) - gx;
      gHead.append(s('rect', { x: gx + .75, y: tier.y, width: Math.max(.5, gw - 1.5), height: tier.h, rx: Math.min(6, gw / 3), fill }));
      const fits = txt => textWidth(txt, size, weight) <= gw - 6;
      const text = [useShort ? g.short : g.full, g.short, g.tiny].find(fits);
      if (text) gHead.append(s('text', { x: gx + gw / 2, y: tier.y + tier.h / 2 + size * .36, 'text-anchor': 'middle', 'font-size': size, 'font-weight': weight, fill: fg }, text));
    }
  });
  for (const k of L.marks) {
    const on = live && sel?.id === k.m.id, fg = textOn(k.color), cy = k.y + 9;
    gHead.append(s('g', { 'data-role': 'marker', 'data-id': k.m.id, class: 'marker', opacity: k.m.hidden ? .4 : 1 },
      s('rect', { x: k.px, y: k.y, width: k.w, height: 18, rx: 9, fill: k.color, stroke: on ? accent : 'none', 'stroke-width': 2.5, filter: 'url(#rmShadow)' }),
      s('path', { d: `M${k.px + 11},${cy - 4.5}l4.5,4.5l-4.5,4.5l-4.5,-4.5Z`, fill: fg }),
      s('text', { x: k.px + 20, y: cy + 3.8, 'font-size': 11, fill: fg }, s('tspan', { 'font-weight': 700 }, k.m.name), s('tspan', { dx: 6, 'font-size': 10, 'fill-opacity': .85 }, k.text))));
  }
  gCorner.append(s('rect', { x: 0, y: 0, width: x0 - 1, height: top - 4, fill: T.bg }));
  if (v.showTitle) {
    gCorner.append(s('text', { x: PAD, y: PAD + 19, 'font-size': 20, 'font-weight': 700, fill: T.text, 'letter-spacing': '-.01em' }, L.rm.name),
      s('text', { x: PAD, y: PAD + 37, 'font-size': 11.5, fill: T.muted }, `${niceDate(L.d0)} – ${niceDate(L.d1 - 1)}`));
  }
  svg.append(gLeft, gHead, gCorner);
  if (live) applyScroll(svg, ui.sx || 0, ui.sy || 0);

  function drawItem(p) {
    const it = p.item, isSel = live && sel?.id === it.id, dragging = drag?.kind === 'move' && drag.id === it.id;
    const g = s('g', { class: 'item' + (p.isTask ? '' : ' ms'), 'data-role': 'item', 'data-id': it.id, opacity: p.ghost ? .35 : dragging ? .85 : 1,
      transform: dragging && drag.dy ? `translate(0 ${drag.dy})` : null });
    const w = p.x1 - p.x0, soft = v.barFill === 'soft', outline = v.barFill === 'outline';
    const paint = outline ? T.bg : soft ? mix(T.bg, p.color, T.dark ? .38 : .24) : v.barFill === 'gradient' ? gradient(p.color) : p.color;
    let insideText = outline || soft || it.placeholder ? T.text : textOn(p.color);
    if (it.placeholder) {
      // Not scoped yet: pattern + dashed edge, no shadow and no progress - it must not look committed.
      const d = p.isTask ? barPath(v.barShape, p.x0, p.barY, w, p.barH) : shapePath(it.shape, (p.x0 + p.x1) / 2, p.cy, p.barH / 2);
      g.append(s('path', { d, fill: placeholderFill(p.color), stroke: placeholderStroke(p.color), 'stroke-width': 1.5, 'stroke-dasharray': '5 3', 'stroke-linejoin': 'round' }));
    } else if (p.isTask) {
      const d = barPath(v.barShape, p.x0, p.barY, w, p.barH);
      g.append(s('path', { d, fill: paint, stroke: outline || soft ? p.color : 'none', 'stroke-width': outline ? 1.8 : 1, filter: outline ? null : 'url(#rmShadow)' }));
      if (it.progress > 0 && v.progress === 'fill') {
        const clipId = 'rmC' + it.id;
        defs.append(s('clipPath', { id: clipId }, s('path', { d })));
        g.append(s('rect', { x: p.x0, y: p.barY, width: w * it.progress / 100, height: p.barH, 'clip-path': `url(#${clipId})`,
          fill: outline || soft ? p.color : '#000000', opacity: outline ? .3 : soft ? .38 : .24 }));
      }
      if (v.progress === 'line') {
        g.append(s('rect', { x: p.x0, y: p.barY + p.barH + 2.5, width: w, height: 3, rx: 1.5, fill: T.grid }),
          s('rect', { x: p.x0, y: p.barY + p.barH + 2.5, width: w * it.progress / 100, height: 3, rx: 1.5, fill: mix(p.color, '#000000', .2) }));
      }
    } else {
      g.append(s('path', { d: shapePath(it.shape, (p.x0 + p.x1) / 2, p.cy, p.barH / 2), fill: outline ? T.bg : v.barFill === 'gradient' ? gradient(p.color) : p.color,
        stroke: outline ? p.color : T.bg, 'stroke-width': outline ? 2 : 1.4, 'stroke-linejoin': 'round', filter: 'url(#rmShadow)' }));
    }
    if (p.prio && v.priorityStyle === 'stripe') {
      if (p.isTask) { const clipId = 'rmP' + it.id; defs.append(s('clipPath', { id: clipId }, s('path', { d: barPath(v.barShape, p.x0, p.barY, w, p.barH) })));
        g.append(s('rect', { x: p.x0, y: p.barY, width: Math.min(6, w), height: p.barH, fill: p.prio.color, 'clip-path': `url(#${clipId})` })); }
      else g.append(s('circle', { cx: p.x1 - 2, cy: p.barY + 2, r: 4, fill: p.prio.color, stroke: T.bg, 'stroke-width': 1.3 }));
    }
    if (p.prio && v.priorityStyle === 'flag') {
      const fx = p.isTask ? p.x0 + 2 : (p.x0 + p.x1) / 2, fy = p.barY - 7;
      g.append(s('path', { d: `M${fx},${fy + 11}V${fy}h9l-2.5,3l2.5,3h-9`, fill: p.prio.color, stroke: T.bg, 'stroke-width': 1.2, 'stroke-linejoin': 'round', 'paint-order': 'stroke' }));
    }
    if (it.status === 'done' && p.isTask && w > 60 && p.pos !== 'inside')
      g.append(s('path', { d: `M${p.x0 + 8},${p.cy}l3.5,3.5l6,-7`, fill: 'none', stroke: insideText, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

    // label
    const lg = labelGeometry(p), inside = p.pos === 'inside';
    const fg = inside ? insideText : T.text, metaFg = inside ? insideText : T.muted;
    // A label inside the bar is part of the bar (dragging it moves the task);
    // the "Aa" handle on a selected task is what drags an inside label out.
    const label = inside ? s('g', { 'pointer-events': 'none' }) : s('g', { class: 'label', 'data-role': 'label', 'data-id': it.id });
    // Lay the label out left to right from its real start: priority, status dot, text.
    let tx = lg.anchor === 'start' ? lg.x : lg.anchor === 'end' ? lg.x - p.labelW : lg.x - p.labelW / 2;
    if (p.badgeW && v.priorityStyle === 'badge') {
      label.append(s('rect', { x: tx, y: lg.y - 6.5, width: 19, height: 13, rx: 4, fill: p.prio.color, stroke: inside ? '#ffffff' : 'none', 'stroke-width': 1 }),
        s('text', { x: tx + 9.5, y: lg.y + 3.3, 'text-anchor': 'middle', 'font-size': 8.5, 'font-weight': 700, fill: '#ffffff' }, p.prio.short));
    } else if (p.badgeW) {
      // Arrows: double up = critical, up = high, bar = medium, down = low.
      const c = tx + 5, y0 = lg.y, shape = { critical: `M${c - 4},${y0 - .5}l4,-4l4,4M${c - 4},${y0 + 4.5}l4,-4l4,4`, high: `M${c - 4},${y0 + 2}l4,-4l4,4`,
        medium: `M${c - 4},${y0 - 2}h8M${c - 4},${y0 + 2}h8`, low: `M${c - 4},${y0 - 2}l4,4l4,-4` }[p.prio.id];
      if (inside) label.append(s('circle', { cx: c, cy: y0, r: 7, fill: '#ffffff' }));
      label.append(s('path', { d: shape, fill: 'none', stroke: p.prio.color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    tx += p.badgeW;
    if (p.dot) {
      label.append(s('circle', { cx: tx + 4, cy: lg.y, r: 3.6, fill: statusById(it.status).color, stroke: inside ? '#ffffff' : T.bg, 'stroke-width': 1.2 }));
      tx += 11;
    }
    // A halo keeps the name readable on top of a placeholder's pattern.
    const halo = it.placeholder && inside ? { stroke: T.bg, 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke' } : {};
    const text = s('text', { x: tx, y: lg.y + 4.2, 'text-anchor': 'start', 'font-size': 12, fill: fg, ...halo },
      s('tspan', { 'font-weight': 600, 'font-style': it.placeholder ? 'italic' : null }, p.t.name),
      p.t.meta ? s('tspan', { dx: 7, 'font-size': 11, fill: metaFg, 'fill-opacity': inside ? .82 : 1 }, p.t.meta) : null);
    label.append(text);
    g.append(label);

    if (isSel) {
      g.append(s('rect', { x: p.x0 - 3, y: p.barY - 3, width: w + 6, height: p.barH + 6, rx: 9, fill: 'none', stroke: accent, 'stroke-width': 2, 'pointer-events': 'none' }));
      g.append(s('g', { class: 'linkh', 'data-role': 'link', 'data-id': it.id },
        s('title', {}, 'Drag onto another item to make it depend on this one'),
        s('circle', { cx: p.x1 + 3, cy: p.barY - 3, r: 6.5, fill: '#ffffff', stroke: accent, 'stroke-width': 1.6 }),
        s('path', { d: `M${p.x1 - 0.5},${p.barY - 3}h6.5m-2.6,-2.6l2.6,2.6l-2.6,2.6`, fill: 'none', stroke: accent, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
      if (p.isTask) {
        const gw = Math.min(9, w / 3);
        g.append(s('rect', { class: 'grip', 'data-role': 'grip', 'data-side': 'start', 'data-id': it.id, x: p.x0 - 4, y: p.barY, width: gw + 4, height: p.barH, fill: 'transparent' }),
          s('rect', { class: 'grip', 'data-role': 'grip', 'data-side': 'end', 'data-id': it.id, x: p.x1 - gw, y: p.barY, width: gw + 4, height: p.barH, fill: 'transparent' }),
          s('g', { class: 'label', 'data-role': 'label', 'data-id': it.id },
            s('title', {}, 'Drag to place the label'),
            s('rect', { x: p.x0 + w / 2 - 11, y: p.barY - 9, width: 22, height: 13, rx: 6.5, fill: '#ffffff', stroke: accent, 'stroke-width': 1.6 }),
            s('text', { x: p.x0 + w / 2, y: p.barY + 1, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: accent }, 'Aa')),
          s('circle', { class: 'prog', 'data-role': 'prog', 'data-id': it.id, cx: p.x0 + w * it.progress / 100, cy: p.barY + p.barH, r: 5, fill: '#ffffff', stroke: accent, 'stroke-width': 2 }));
      }
    } else if (live && p.isTask) {
      const gw = Math.min(7, w / 4);
      g.append(s('rect', { class: 'grip', 'data-role': 'grip', 'data-side': 'start', 'data-id': it.id, x: p.x0, y: p.barY, width: gw, height: p.barH, fill: 'transparent' }),
        s('rect', { class: 'grip', 'data-role': 'grip', 'data-side': 'end', 'data-id': it.id, x: p.x1 - gw, y: p.barY, width: gw, height: p.barH, fill: 'transparent' }));
    }
    return g;
  }
}

export function applyScroll(svg, sx, sy) {
  svg.querySelector('#rmLeft')?.setAttribute('transform', `translate(${sx} 0)`);
  svg.querySelector('#rmHead')?.setAttribute('transform', `translate(0 ${sy})`);
  svg.querySelector('#rmCorner')?.setAttribute('transform', `translate(${sx} ${sy})`);
}

// exportSvg builds a standalone drawing: no selection, no hidden rows, no scroll offsets.
export function exportSvg(rm, width) {
  const svg = s('svg', { xmlns: 'http://www.w3.org/2000/svg' });
  draw(svg, computeLayout(rm, { showHidden: false, width }), { interactive: false });
  svg.querySelectorAll('[data-role],[class]').forEach(el => { el.removeAttribute('data-role'); el.removeAttribute('data-id'); el.removeAttribute('data-side'); el.removeAttribute('class'); });
  return svg;
}

// ---- interaction ----------------------------------------------------------

export function mountTimeline({ svg, scroller, tip, onContext, onEditName, onAdd, onNotice, onGroup }) {
  let L = null;

  function paint() {
    L = computeLayout(active(), { showHidden: state.showHidden, width: scroller.clientWidth - 2 });
    draw(svg, L, { interactive: true, sel: state.sel, drag: state.drag, sx: scroller.scrollLeft, sy: scroller.scrollTop });
  }
  let frame = 0;
  function render(now = false) {
    if (now) { cancelAnimationFrame(frame); frame = 0; paint(); return; }
    if (frame) return;                       // one repaint per displayed frame
    frame = requestAnimationFrame(() => { frame = 0; paint(); });
  }
  // The layout is needed synchronously by the pointer handlers below.
  paint();
  scroller.addEventListener('scroll', () => applyScroll(svg, scroller.scrollLeft, scroller.scrollTop));
  new ResizeObserver(() => render()).observe(scroller);

  const point = e => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const subAt = y => { for (const Ln of L.lanes) for (const S of Ln.subs) if (y >= S.y && y < S.y + S.h) return S; return null; };
  const dayAt = x => clamp(Math.floor(L.d0 + (x - L.x0) / L.ppd), L.d0, L.d1 - 1);

  function hit(e) {
    // Selecting re-renders between the two clicks of a double-click, so the
    // event target can be stale; ask the document what is under the pointer.
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-role]'), pt = point(e);
    const role = el?.dataset.role, id = el?.dataset.id;
    // The sticky columns sit above the items, so a hit there is never an item.
    const inTimeline = pt.x - scroller.scrollLeft >= L.x0 && pt.y - scroller.scrollTop >= L.top - 4;
    return { role, id, group: el?.dataset.group, side: el?.dataset.side, dep: role === 'dep' ? { from: el.dataset.from, to: el.dataset.to } : null, pt, sub: subAt(pt.y)?.sub, day: dayAt(pt.x), inTimeline };
  }

  function showTip(e, text) { tip.hidden = false; tip.textContent = text; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 16 + 'px'; }

  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const hgt = hit(e);
    if (!hgt.role || hgt.role === 'bg' || hgt.role === 'dep') { if (state.sel) select(null); return; }
    const f = find(hgt.id); if (!f) return;
    e.preventDefault();
    const kind = hgt.role === 'lanecell' || hgt.role === 'subcell' ? 'reorder' : hgt.role === 'grip' ? 'resize' : hgt.role === 'prog' ? 'progress' : hgt.role === 'label' ? 'label' : hgt.role === 'link' ? 'link' : hgt.role === 'marker' ? 'marker' : 'move';
    if (state.sel?.id !== hgt.id) select({ type: f.type, id: hgt.id });
    const startPt = hgt.pt, startClient = { x: e.clientX, y: e.clientY };
    const origMark = f.type === 'marker' ? toDay(f.marker.date) : 0;
    const orig = f.type === 'item' ? { a: itemStart(f.item), b: itemEnd(f.item), progress: f.item.progress } : null;
    const p0 = L.placed.get(hgt.id), ppd = L.ppd;
    let moved = false;

    const onMove = ev => {
      const pt = point(ev), dx = pt.x - startPt.x, dy = pt.y - startPt.y;
      if (!moved) {
        if (Math.hypot(ev.clientX - startClient.x, ev.clientY - startClient.y) < 4) return;
        moved = true; begin(); document.body.classList.add('dragging');
      }
      const it = find(hgt.id)?.item;
      if (kind === 'marker') {
        const m = find(hgt.id).marker; m.date = fromDay(clamp(origMark + Math.round(dx / ppd), L.d0, L.d1 - 1));
        state.drag = { kind, id: hgt.id };
        showTip(ev, `${m.name} · ${niceDate(toDay(m.date))}`);
      } else if (kind === 'move') {
        const dd = Math.round(dx / ppd);
        if (it.type === 'task') { it.start = fromDay(orig.a + dd); it.end = fromDay(orig.b + dd); } else it.date = fromDay(orig.a + dd);
        const target = subAt(pt.y);
        state.drag = { kind, id: hgt.id, dy, targetSub: target && target.sub.id !== f.sub.id ? target.sub.id : null };
        showTip(ev, it.type === 'task' ? `${niceDate(orig.a + dd)} → ${niceDate(orig.b + dd)}` : niceDate(orig.a + dd));
      } else if (kind === 'resize') {
        const dd = Math.round(dx / ppd);
        if (hgt.side === 'start') it.start = fromDay(Math.min(orig.a + dd, orig.b)); else it.end = fromDay(Math.max(orig.b + dd, orig.a));
        state.drag = { kind, id: hgt.id };
        showTip(ev, `${niceDate(toDay(it.start))} → ${niceDate(toDay(it.end))} · ${toDay(it.end) - toDay(it.start) + 1} days`);
      } else if (kind === 'progress') {
        it.progress = clamp(Math.round(((pt.x - p0.x0) / (p0.x1 - p0.x0)) * 20) * 5, 0, 100);
        state.drag = { kind, id: hgt.id };
        showTip(ev, it.progress + '% complete');
      } else if (kind === 'label') {
        let best = null, bestD = Infinity;
        for (const [name, z] of Object.entries(labelZones(p0))) {
          const dist = Math.hypot(pt.x - clamp(pt.x, z.x, z.x + z.w), pt.y - (z.y + z.h / 2)) + (name === 'inside' ? 0 : 2);
          if (dist < bestD) { bestD = dist; best = name; }
        }
        state.drag = { kind, id: hgt.id, zone: best };
        showTip(ev, 'Label: ' + best);
      } else if (kind === 'link') {
        let target = null;
        for (const q of L.placed.values()) if (q.item.id !== hgt.id && pt.x >= q.x0 - 5 && pt.x <= q.x1 + 5 && pt.y >= q.barY - 5 && pt.y <= q.barY + q.barH + 5) target = q.item.id;
        state.drag = { kind, id: hgt.id, x: pt.x, y: pt.y, target };
        showTip(ev, target ? `${find(target).item.name} will depend on ${it.name}` : 'Drop on the item that depends on this one');
      } else if (kind === 'reorder') {
        state.drag = { kind, id: hgt.id, type: f.type, ...reorderTarget(f, pt.y) };
      }
      render();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('keydown', onKey);
      document.body.classList.remove('dragging'); tip.hidden = true;
      const d = state.drag; state.drag = null;
      if (!moved) return;
      if (kind === 'link') { commit(); if (d?.target) { const err = addDep(hgt.id, d.target); if (err) onNotice(err); } return; }
      if (kind === 'label' && d?.zone) find(hgt.id).item.labelPos = d.zone;
      if (kind === 'move' && d?.targetSub) {
        const cur = find(hgt.id), dest = find(d.targetSub)?.sub;
        if (dest) { cur.sub.items.splice(cur.sub.items.indexOf(cur.item), 1); dest.items.push(cur.item); }
      }
      if (kind === 'reorder' && d && d.valid) { commit(); move(hgt.id, d.parent, d.before); return; }
      commit();
    };
    const onKey = ev => { if (ev.key === 'Escape') { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('keydown', onKey);
      document.body.classList.remove('dragging'); tip.hidden = true; state.drag = null; if (moved) cancel(); else render(); } };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp); window.addEventListener('keydown', onKey);
  });

  // Where a dragged lane / sub-lane would land for a pointer at height y.
  function reorderTarget(f, y) {
    if (f.type === 'lane') {
      const next = L.lanes.find(Ln => y < Ln.y + Ln.h / 2);
      const last = L.lanes[L.lanes.length - 1];
      return { valid: true, parent: null, before: next ? next.lane.id : null, lineY: next ? next.y - LANE_GAP / 2 : last.y + last.h + LANE_GAP / 2 };
    }
    const Ln = L.lanes.find(l => y < l.y + l.h + LANE_GAP / 2) || L.lanes[L.lanes.length - 1];
    if (!Ln || !Ln.subs.length) return { valid: false };
    const next = Ln.subs.find(S => y < S.y + S.h / 2), last = Ln.subs[Ln.subs.length - 1];
    return { valid: true, parent: Ln.lane.id, before: next ? next.sub.id : null, lineY: next ? next.y : last.y + last.h };
  }

  svg.addEventListener('dblclick', e => {
    const hgt = hit(e);
    if (hgt.role === 'groupcell') return onGroup(hgt.group);
    if (hgt.role === 'marker' || hgt.role === 'item' || hgt.role === 'label' || hgt.role === 'grip' || hgt.role === 'lanecell' || hgt.role === 'subcell') onEditName();
    else if (hgt.inTimeline && hgt.sub) onAdd(hgt.sub.id, hgt.day);
  });
  svg.addEventListener('contextmenu', e => {
    e.preventDefault();
    const hgt = hit(e), f = hgt.id && find(hgt.id);
    if (hgt.dep) return onContext(e, { dep: hgt.dep });
    if (hgt.role === 'groupcell') return onContext(e, { group: hgt.group });
    if (f) select({ type: f.type, id: hgt.id });
    onContext(e, { target: f, sub: hgt.inTimeline ? hgt.sub : null, day: hgt.day });
  });

  return { render, layout: () => L };
}
