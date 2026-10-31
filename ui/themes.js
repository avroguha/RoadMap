// Timeline colour themes. These style the drawing that gets exported; the
// app's own light/dark chrome is separate.

export const THEMES = [
  { id: 'office', name: 'Office Blue', bg: '#ffffff', text: '#1f2a3d', muted: '#66738a', grid: '#e6eaf2',
    head1: '#1f3a6e', head1Text: '#ffffff', head2: '#e9eef8', head2Text: '#1f3a6e',
    palette: ['#2f6fed', '#f28b30', '#2aa876', '#8e5bd9', '#e0477a', '#15a3b8', '#c9a227', '#5b6b8c'] },
  { id: 'aurora', name: 'Aurora', bg: '#ffffff', text: '#1d2440', muted: '#6d7693', grid: '#e8eaf6',
    head1: '#3b2f8f', head1Text: '#ffffff', head2: '#eeecfb', head2Text: '#3b2f8f',
    palette: ['#6c5ce7', '#00b8a9', '#ff7675', '#0984e3', '#fdab3d', '#e84393', '#00cec9', '#636e9b'] },
  { id: 'sunset', name: 'Sunset', bg: '#fffdfa', text: '#3b2418', muted: '#8b6f60', grid: '#f3e8df',
    head1: '#b8431f', head1Text: '#ffffff', head2: '#fdeee2', head2Text: '#8f3114',
    palette: ['#e4572e', '#f3a712', '#a8327e', '#d7263d', '#f08a5d', '#6a2c70', '#b83b5e', '#c98a1b'] },
  { id: 'forest', name: 'Forest', bg: '#fcfefb', text: '#1d3026', muted: '#627a6b', grid: '#e3ece4',
    head1: '#1e5a3c', head1Text: '#ffffff', head2: '#e6f2ea', head2Text: '#1e5a3c',
    palette: ['#2d8a56', '#88a825', '#1f7a8c', '#c08a2b', '#5c946e', '#34623f', '#a3b18a', '#587b7f'] },
  { id: 'pastel', name: 'Pastel', bg: '#ffffff', text: '#3a3f55', muted: '#7d839b', grid: '#eef0f7',
    head1: '#cfd8f7', head1Text: '#2e3a66', head2: '#f3f5fd', head2Text: '#4b5680',
    palette: ['#8fb8f5', '#f7b49a', '#a5dcb8', '#cdb2f2', '#f6a9c5', '#9bdbe3', '#f3d98b', '#b9c1d6'] },
  { id: 'slate', name: 'Mono Slate', bg: '#ffffff', text: '#1e2430', muted: '#6b7484', grid: '#e7e9ee',
    head1: '#272e3d', head1Text: '#ffffff', head2: '#eceef2', head2Text: '#272e3d',
    palette: ['#334155', '#64748b', '#0f766e', '#475569', '#94a3b8', '#1e293b', '#0e7490', '#78869c'] },
  { id: 'vivid', name: 'Vivid', bg: '#ffffff', text: '#161a2b', muted: '#626a85', grid: '#e9ebf5',
    head1: '#161a2b', head1Text: '#ffffff', head2: '#f0f1f8', head2Text: '#161a2b',
    palette: ['#ff3d71', '#00c2ff', '#ffb300', '#7c4dff', '#00d68f', '#ff6f3c', '#2962ff', '#d500f9'] },
  { id: 'midnight', name: 'Midnight', dark: true, bg: '#121724', text: '#e8ecf6', muted: '#97a1b8', grid: '#262e42',
    head1: '#0b0f19', head1Text: '#e8ecf6', head2: '#1c2333', head2Text: '#c5cde0',
    palette: ['#6ea8ff', '#ffb86b', '#5be0a8', '#b794ff', '#ff7fa8', '#4dd6e6', '#f0d264', '#9aa7c7'] },
  { id: 'carbon', name: 'Carbon Neon', dark: true, bg: '#0d0f14', text: '#f2f4f8', muted: '#9099ab', grid: '#232733',
    head1: '#000000', head1Text: '#f2f4f8', head2: '#181b24', head2Text: '#c7cedb',
    palette: ['#33e1a0', '#3ea6ff', '#ff5d8f', '#ffd23f', '#a78bfa', '#ff8a3d', '#22d3ee', '#a3adc2'] },
];

export const themeById = id => THEMES.find(t => t.id === id) || THEMES[0];

export const STATUSES = [
  { id: 'none', name: 'No status', color: '#9aa3b5' },
  { id: 'planned', name: 'Planned', color: '#7b8aa8' },
  { id: 'ontrack', name: 'On track', color: '#22a36b' },
  { id: 'atrisk', name: 'At risk', color: '#f0a020' },
  { id: 'delayed', name: 'Delayed', color: '#e0454f' },
  { id: 'done', name: 'Done', color: '#3b82f6' },
];
export const statusById = id => STATUSES.find(x => x.id === id) || STATUSES[0];

export const PRIORITIES = [
  { id: '', name: 'No priority', short: '', color: '#9aa3b5', rank: 9 },
  { id: 'critical', name: 'Critical', short: 'P1', color: '#d92d3a', rank: 1 },
  { id: 'high', name: 'High', short: 'P2', color: '#f0801f', rank: 2 },
  { id: 'medium', name: 'Medium', short: 'P3', color: '#d4a514', rank: 3 },
  { id: 'low', name: 'Low', short: 'P4', color: '#4a90d9', rank: 4 },
];
export const priorityById = id => PRIORITIES.find(x => x.id === id) || PRIORITIES[0];
export const PRIORITY_STYLES = [['off', 'Hidden'], ['badge', 'Badge (P1-P4)'], ['arrows', 'Arrows'], ['stripe', 'Stripe on the bar'], ['flag', 'Corner flag']];

export const PLACEHOLDER_STYLES = [['hatch', 'Hatched'], ['dashed', 'Dashed outline'], ['grey', 'Greyed out'], ['dots', 'Dotted']];

export const LABEL_POSITIONS = [['inside', 'Inside'], ['right', 'Right'], ['left', 'Left'], ['above', 'Above'], ['below', 'Below']];
export const SHAPES = [['diamond', 'Diamond'], ['circle', 'Circle'], ['star', 'Star'], ['flag', 'Flag'], ['triangle', 'Triangle'], ['square', 'Square']];
export const BAR_SHAPES = [['rounded', 'Rounded'], ['pill', 'Pill'], ['square', 'Square'], ['chevron', 'Chevron']];
export const BAR_FILLS = [['solid', 'Solid'], ['gradient', 'Gradient'], ['soft', 'Soft tint'], ['outline', 'Outline']];
export const PROGRESS_STYLES = [['fill', 'Filled portion'], ['line', 'Line under bar'], ['none', 'Hidden']];
export const COLOR_BY = [['lane', 'Swimlane'], ['sub', 'Sub-swimlane'], ['status', 'Status'], ['priority', 'Priority']];
export const DENSITIES = [['compact', 'Compact'], ['cozy', 'Cozy'], ['roomy', 'Roomy']];
