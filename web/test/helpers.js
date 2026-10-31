// Random roadmap edits shared by the browser-side tests.

export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
let nextId = 0;
const nid = p => p + 'n' + (++nextId);   // never collides with the seed's L1, S11, i111...

export function randomEdit(doc, r) {
  const pick = a => a[Math.floor(r() * a.length)];
  const lanes = doc.lanes, subs = lanes.flatMap(l => l.subs), items = subs.flatMap(s => s.items);
  switch (Math.floor(r() * 12)) {
    case 0: lanes.splice(Math.floor(r() * (lanes.length + 1)), 0, { id: nid('L'), name: 'lane', color: '', subs: [{ id: nid('S'), name: '', items: [] }] }); break;
    case 1: if (lanes.length > 1) lanes.splice(Math.floor(r() * lanes.length), 1); break;
    case 2: if (subs.length) pick(lanes).subs.push({ id: nid('S'), name: 'sub', items: [{ id: nid('i'), name: 'x', progress: 0 }] }); break;
    case 3: { const s = pick(subs); if (s) s.items.splice(Math.floor(r() * (s.items.length + 1)), 0, { id: nid('i'), name: 'new', progress: Math.floor(r() * 100), deps: [] }); break; }
    case 4: { const s = pick(subs); if (s?.items.length) s.items.splice(Math.floor(r() * s.items.length), 1); break; }
    case 5: { // move an item somewhere else
      const from = pick(subs); if (!from?.items.length) break;
      const [it] = from.items.splice(Math.floor(r() * from.items.length), 1);
      const to = pick(lanes.flatMap(l => l.subs)); to.items.splice(Math.floor(r() * (to.items.length + 1)), 0, it); break; }
    case 6: { const it = pick(items); if (it) { it.name = 'renamed' + Math.floor(r() * 9); it.progress = Math.floor(r() * 100); } break; }
    case 7: { const it = pick(items); if (it) delete it.progress; break; }
    case 8: if (lanes.length > 1) { const [l] = lanes.splice(Math.floor(r() * lanes.length), 1); lanes.splice(Math.floor(r() * (lanes.length + 1)), 0, l); } break;
    case 9: { const l = pick(lanes); if (l?.subs.length > 1) { const [s] = l.subs.splice(0, 1); pick(lanes).subs.push(s); } break; }
    case 10: doc.markers.push({ id: nid('m'), name: 'key', date: '2026-05-0' + Math.floor(r() * 9 + 1) }); break;
    case 11: doc.name = 'R' + Math.floor(r() * 9); doc.view.theme = pick(['office', 'dark', 'vivid']); break;
  }
}

export function seedDoc() {
  return {
    id: 'rm', name: 'R', start: '2026-01-01', end: '2026-12-31', view: { theme: 'office', zoom: 'fit' }, markers: [],
    lanes: [1, 2, 3].map(n => ({ id: 'L' + n, name: 'Lane ' + n, color: '', subs: [1, 2].map(k => ({ id: `S${n}${k}`, name: '', items: [1, 2, 3].map(j => ({ id: `i${n}${k}${j}`, name: 'item', progress: 0 })) })) })),
  };
}

