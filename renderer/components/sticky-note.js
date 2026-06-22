// Sticky note colors and shared utilities

const STICKY_COLORS_LIGHT = [
  { bg: '#FEF08A', border: '#EAB308', label: 'Yellow' },
  { bg: '#86EFAC', border: '#22C55E', label: 'Green' },
  { bg: '#93C5FD', border: '#3B82F6', label: 'Blue' },
  { bg: '#FCA5A5', border: '#EF4444', label: 'Red' },
  { bg: '#C4B5FD', border: '#8B5CF6', label: 'Purple' },
  { bg: '#FDBA74', border: '#F97316', label: 'Orange' },
];

const STICKY_COLORS_DARK = [
  { bg: '#423A10', border: '#A08520', label: 'Yellow' },
  { bg: '#14352A', border: '#22885A', label: 'Green' },
  { bg: '#162844', border: '#3070C0', label: 'Blue' },
  { bg: '#3A1818', border: '#C04040', label: 'Red' },
  { bg: '#2A1F48', border: '#7050B8', label: 'Purple' },
  { bg: '#3A2410', border: '#C06820', label: 'Orange' },
];

// Dynamic getter picks the right palette based on current theme
function getStickyColors() {
  return document.body.classList.contains('theme-dark') ? STICKY_COLORS_DARK : STICKY_COLORS_LIGHT;
}

// Keep STICKY_COLORS as default (light) for static references; use getStickyColors() for runtime
const STICKY_COLORS = STICKY_COLORS_LIGHT;

const PRIORITY_COLORS = {
  'High':   '#EF4444',
  'Medium': '#F97316',
  'Low':    '#22C55E'
};

const PRIORITIES = ['High', 'Medium', 'Low'];

const STATUS_LABELS = { backlog: 'Backlog', inProgress: 'In Progress', review: 'Review', done: 'Done' };

// Default categories — user can add more; stored in settings.categories
const DEFAULT_CATEGORIES = [
  { id: 'mechanical', label: 'MECH', name: 'Mechanical', color: '#3B82F6' },
  { id: 'electrical', label: 'ELEC', name: 'Electrical', color: '#EAB308' },
  { id: 'purchasing', label: 'PUR',  name: 'Purchasing', color: '#22C55E' },
  { id: 'meeting',    label: 'MTG',  name: 'Meeting',    color: '#F97316' }
];

// These get populated on init from settings
let APP_CATEGORIES = [...DEFAULT_CATEGORIES];

function getCategories() { return APP_CATEGORIES; }

function getCategoryById(id) { return APP_CATEGORIES.find(c => c.id === id); }

function getCategoryColor(id) {
  const cat = getCategoryById(id);
  return cat ? cat.color : '#64748B';
}

function getCategoryLabel(id) {
  const cat = getCategoryById(id);
  return cat ? cat.label : (id || '').toUpperCase().slice(0, 4);
}

// Build lookup maps for backwards-compat
function getCategoryLabels() {
  const map = {};
  APP_CATEGORIES.forEach(c => { map[c.id] = c.label; });
  return map;
}

function getCategoryColors() {
  const map = {};
  APP_CATEGORIES.forEach(c => { map[c.id] = c.color; });
  return map;
}

// Convenience getters (used throughout app)
// Keep old names working
const CATEGORY_LABELS = new Proxy({}, { get: (_, id) => getCategoryLabel(id) });
const PROJECT_CATEGORY_COLORS = new Proxy({}, { get: (_, id) => getCategoryColor(id) });

const DEFAULT_PROJECT_COLOR = '#6366F1'; // Indigo fallback

// Generate rainbow color for a project based on its index in the list
function rainbowColor(index, total) {
  if (total <= 0) total = 1;
  const hue = (index / total) * 360;
  // Convert HSL to hex — saturation 72%, lightness 58% for vivid but not neon
  const s = 0.72, l = 0.58;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (hue < 60)       { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else                { r = c; g = 0; b = x; }
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}

// Assign rainbow colors to all projects in a list (mutates .color)
function assignRainbowColors(projects) {
  const total = projects.length;
  projects.forEach((p, i) => {
    p.color = rainbowColor(i, total);
  });
}

// Auto-color modes — what drives the sticky note color
const COLOR_MODES = [
  { id: 'category', label: 'Category' },
  { id: 'priority', label: 'Priority' },
  { id: 'project',  label: 'Project' },
  { id: 'status',   label: 'Status' },
  { id: 'due',      label: 'Due Date' },
  { id: 'manual',   label: 'Manual' },
];

// Priority → sticky color mapping
const PRIORITY_COLOR_IDX = { 'High': 3, 'Medium': 5, 'Low': 1 }; // Red, Orange, Green

// Status → sticky color mapping
const STATUS_COLOR_IDX = { 'backlog': 0, 'inProgress': 2, 'review': 4, 'done': 1 }; // Yellow, Blue, Purple, Green

// Due date → sticky color mapping
function dueDateColorIdx(note) {
  if (note.completed) return 1; // Green — done
  if (!note.dueDate) return 0;  // Yellow — no date
  const now = new Date();
  const due = new Date(note.dueDate + 'T' + (note.dueTime || '23:59'));
  const daysLeft = (due - now) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0) return 3;   // Red — overdue
  if (daysLeft < 2) return 5;   // Orange — due soon
  if (daysLeft < 7) return 2;   // Blue — this week
  return 1;                      // Green — plenty of time
}

// Resolve auto-color index based on the active color mode
function resolveAutoColor(note, mode, projects) {
  if (!mode || mode === 'manual') return note.colorIdx || 0;
  if (mode === 'category') return categoryToStickyColorIdx(note.category);
  if (mode === 'priority') return PRIORITY_COLOR_IDX[note.priority] ?? 5;
  if (mode === 'status') return STATUS_COLOR_IDX[note.status || 'backlog'] ?? 0;
  if (mode === 'due') return dueDateColorIdx(note);
  if (mode === 'project') {
    const proj = (projects || []).find(p => p.id === note.projectId);
    if (!proj) return 0;
    return hexToClosestStickyIdx(proj.color || DEFAULT_PROJECT_COLOR);
  }
  return note.colorIdx || 0;
}

// Map any hex color to the closest sticky note color index
function hexToClosestStickyIdx(hexColor) {
  if (!hexColor) return 0;
  const colorMap = {
    '#3B82F6': 2, '#EAB308': 0, '#22C55E': 1,
    '#F97316': 5, '#EF4444': 3, '#8B5CF6': 4,
  };
  if (colorMap[hexColor] !== undefined) return colorMap[hexColor];

  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  let bestIdx = 0;
  let bestDist = Infinity;
  STICKY_COLORS.forEach((sc, i) => {
    const sr = parseInt(sc.border.slice(1, 3), 16);
    const sg = parseInt(sc.border.slice(3, 5), 16);
    const sb = parseInt(sc.border.slice(5, 7), 16);
    const dist = Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  });
  return bestIdx;
}

// Map category color to the closest sticky note color index
function categoryToStickyColorIdx(categoryId) {
  const catColor = getCategoryColor(categoryId);
  if (!catColor) return 0;
  return hexToClosestStickyIdx(catColor);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

function isOverdue(note) {
  if (note.completed || !note.dueDate) return false;
  const now = new Date();
  const due = new Date(note.dueDate + 'T' + (note.dueTime || '23:59'));
  return now > due;
}
