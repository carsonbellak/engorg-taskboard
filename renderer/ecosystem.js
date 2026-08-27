// Ecosystem tab — the "branched view". One workspace tree where each project is a
// limb, categories/deliverables are sub-branches, and leaves mix the app's own
// data (tasks, events, purchases, to-dos) with attached species: folders, files,
// CAD models, links, notes, sub-branches, and live utility instances.
//
// v2 goals (from the user's feedback + engineering-workflow research):
//   * PROGRESSIVE DISCLOSURE — default view is the trunk + projects + collapsed
//     branch bubbles; big fans cluster into "+N more". Never dump 260 leaves.
//   * CURSOR-STEERED NAVIGATION — move toward a screen edge and the view glides
//     that way; hover a branch and it auto-expands; move away and it closes.
//     (Editing is still there via right-click / hover "+" / drag.)
//   * INTELLIGENT SUGGESTIONS — a panel that reacts to the project's state and
//     proposes reorganizations, WIP trims, phase gaps (V-model), utility hookups,
//     and deadline-protecting schedule blocks, each with one-click apply.
//
// Grounding: PARA (organize by actionability), WBS (deliverable hierarchy, 100%
// rule), Ulrich-Eppinger phases, the Systems-Engineering V-model, and Kanban WIP
// limits. Persistence lives in settings.ecosystem so it syncs across devices;
// the camera (pan/zoom) is device-local.

const ecosystemView = (() => {
  const RING = 250, OFF = 50000, GRAY = '#64748B';
  const CHILD_DIST = 235;      // fixed distance a child sits from its parent (stable layout)
  const DRAG_THRESHOLD = 5;
  const CAP = 10;              // max children before a branch clusters into "+N more"
  const EASE = { slow: 0.05, normal: 0.09, fast: 0.16, instant: 1 };
  const FOCUS_RADIUS = 100;    // px — how close the cursor must be to focus a node
  const DWELL = 150;           // ms the cursor must settle on a branch before it expands

  const KIND = {
    root:     { icon: '🌳', structural: true },
    project:  { icon: '📁', structural: true },
    category: { icon: '🏷️', structural: true },
    bucket:   { icon: '🗂️', structural: true },
    branch:   { icon: '🌿', structural: true, user: true },
    folder:   { icon: '📁', structural: true, user: true },
    file:     { icon: '📄', user: true },
    cad:      { icon: '🧊', user: true },
    link:     { icon: '🔗', user: true },
    utility:  { icon: '🔧', user: true },
    note:     { icon: '🗒️', user: true },
    task:     { icon: '📝' },
    event:    { icon: '📅' },
    purchase: { icon: '📦' },
    todo:     { icon: '✅' },
    apphub:   { icon: '🧩', structural: true },
    app:      { icon: '🧩' },
    more:     { icon: '⋯' },
  };
  const EXT_ICON = {
    stl: '🧊', step: '🧊', stp: '🧊', obj: '🧊', glb: '🧊', gltf: '🧊', '3mf': '🧊',
    pdf: '📕', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    zip: '🗜️', csv: '📊', xlsx: '📊', doc: '📄', docx: '📄',
    js: '📜', py: '📜', c: '📜', cpp: '📜', h: '📜', json: '📜', md: '📝',
    kicad_pcb: '🔌', kicad_sch: '🔌', sch: '🔌',
  };
  const CAD_EXTS = ['stl', 'step', 'stp', 'obj', 'glb', 'gltf', '3mf'];
  // Leaf nodes that open on a single click (structural nodes expand on hover instead).
  const OPEN_ON_CLICK = new Set(['file', 'cad', 'link', 'note', 'utility', 'app', 'task', 'event', 'purchase', 'todo', 'folder']);

  // Organizing lenses — re-group a project's tasks under a chosen axis. Grounded in
  // engineering-workflow taxonomies (disciplines, Ulrich-Eppinger / V-model phases,
  // Kanban status). 'category' is the default (the project's own categories).
  const LENSES = [
    { id: 'category', label: 'Categories', icon: '🏷️' },
    { id: 'discipline', label: 'Discipline', icon: '🛠️' },
    { id: 'phase', label: 'Phase', icon: '📶' },
    { id: 'status', label: 'Status', icon: '🚦' },
    { id: 'priority', label: 'Priority', icon: '🔺' },
    { id: 'due', label: 'Timeline', icon: '📅' },
  ];
  const lensLabel = (id) => (LENSES.find(l => l.id === id) || {}).label || 'Categories';

  function taskText(t) { return ((t.title || '') + ' ' + (t.description || '')).toLowerCase(); }
  function disciplineBucket(t) {
    const c = (t.category || '').toLowerCase(), s = taskText(t);
    if (c === 'mechanical' || /\b(cad|bracket|mount|enclosure|chassis|mechanical|tolerance|fastener|3d ?print|fixture)\b/.test(s)) return { key: 'mech', label: 'Mechanical', color: '#3B82F6' };
    if (c === 'electrical' || /\b(pcb|circuit|schematic|electrical|voltage|power|sensor|connector|wiring|analog)\b/.test(s)) return { key: 'elec', label: 'Electrical', color: '#EAB308' };
    if (/\b(firmware|mcu|embedded|rtos|register|uart|i2c|spi|bootloader|driver)\b/.test(s)) return { key: 'fw', label: 'Firmware', color: '#8B5CF6' };
    if (/\b(software|app|ui|ux|api|frontend|backend|code|script|database|web)\b/.test(s)) return { key: 'sw', label: 'Software', color: '#22C55E' };
    if (/\b(system|integration|requirement|architecture|interface|spec)\b/.test(s)) return { key: 'sys', label: 'Systems', color: '#EC4899' };
    return { key: 'gen', label: 'General', color: GRAY };
  }
  function phaseBucket(t) {
    const s = taskText(t);
    if (/\b(concept|research|ideate|brainstorm|feasib|spec|require|scope)\b/.test(s)) return { key: 'concept', label: 'Concept', color: '#8B5CF6' };
    if (/\b(design|cad|model|schematic|layout|architecture|draft|calc)\b/.test(s)) return { key: 'design', label: 'Design', color: '#3B82F6' };
    if (/\b(prototype|build|assemble|fabricate|breadboard|mock|solder|print)\b/.test(s)) return { key: 'proto', label: 'Prototype', color: '#F59E0B' };
    if (/\b(test|verif|validat|\bqa\b|debug|characteri|inspect|measure|bring-?up)\b/.test(s)) return { key: 'test', label: 'Test', color: '#EF4444' };
    if (/\b(production|manufactur|release|ship|deploy|ramp|launch|order)\b/.test(s)) return { key: 'prod', label: 'Production', color: '#22C55E' };
    return { key: 'unsorted', label: 'Unsorted', color: GRAY };
  }
  function dueBucket(t) {
    if (!t.dueDate) return { key: 'none', label: 'No date', color: GRAY };
    const dd = daysBetween(startOfDay(new Date()), startOfDay(t.dueDate));
    if (dd < 0) return { key: 'overdue', label: 'Overdue', color: '#EF4444' };
    if (dd <= 7) return { key: 'week', label: 'This week', color: '#F59E0B' };
    if (dd <= 30) return { key: 'month', label: 'This month', color: '#3B82F6' };
    return { key: 'later', label: 'Later', color: '#22C55E' };
  }
  function taskBucket(lens, t) {
    if (lens === 'status') { const m = { backlog: ['Backlog', GRAY], inProgress: ['In progress', '#3B82F6'], review: ['Review', '#8B5CF6'], done: ['Done', '#22C55E'] }; const s = m[t.status] || m.backlog; return { key: t.status || 'backlog', label: s[0], color: s[1] }; }
    if (lens === 'priority') { const m = { High: ['High', '#EF4444'], Medium: ['Medium', '#F59E0B'], Low: ['Low', '#22C55E'] }; const s = m[t.priority] || ['Unset', GRAY]; return { key: t.priority || 'none', label: s[0], color: s[1] }; }
    if (lens === 'due') return dueBucket(t);
    if (lens === 'discipline') return disciplineBucket(t);
    if (lens === 'phase') return phaseBucket(t);
    return { key: 'all', label: 'All', color: GRAY };
  }

  // Workflow templates for "what's next" suggestions (Ulrich-Eppinger stages + V-model:
  // every phase implies the next). Keyed by the phase they scaffold.
  const PHASE_ORDER = ['concept', 'design', 'proto', 'test', 'prod'];
  const PHASE_LABEL = { concept: 'Concept', design: 'Design', proto: 'Prototype', test: 'Test', prod: 'Production' };
  const NEXT_TASKS = {
    design: ['Define requirements & specs', 'Draft the system architecture'],
    proto: ['Build a first prototype', 'Order long-lead parts'],
    test: ['Write a test/verification plan', 'Run a first-article inspection', 'Characterize key performance'],
    prod: ['Do a design-for-manufacturing review', 'Create the BOM & assembly docs', 'Plan the production ramp'],
  };
  // Actionable intent phrases buried in note text → candidate tasks.
  const INTENT_RE = /\b(?:need to|needs to|should|have to|must|to-?do:?|follow up on|remember to|don'?t forget to|next step:?)\s+([a-z0-9][^.;\n]{3,60})/i;

  // ---- state ---------------------------------------------------------------
  let built = false, active = false;
  let root, world, edgesSvg, edgesG, nodesLayer, mediaLayer, panelEl, toolbarEl, hintEl;
  const mediaCards = new Map(); // id -> persistent media card el (so PDFs/images don't reload each render)
  let store = null;
  let camera = { scale: 1, tx: 0, ty: 0 }, hasCentered = false;
  let graph = new Map();
  let visList = [];                 // ordered visible node ids (incl. synthetic "more")
  let visChildren = new Map();      // id -> [visible child ids]
  let posMap = new Map();
  let placed = new Map();           // id -> cached position, so hovering never reflows the tree
  let depthCache = new Map();
  const moreShown = new Map();      // parentId -> how many children currently shown
  let hoverId = null, expandId = null;
  let focusPath = new Set();
  let selectedId = null;
  let drag = null, pan = null;
  let persistTimer = null, cameraTimer = null;
  let menuEl = null;
  let listPopup = null, listPopupId = null, overPopup = false;  // hover list widget for data nodes
  let steerRAF = null, steerEnabled = true;
  let emptySince = 0, camTarget = null;   // recenter-on-leave timer + eased camera target
  let engagedId = null, engagedSince = 0; // dwell before a hovered branch expands
  let _insights = null, _suggests = null; // cached analytics (busted on data change)
  const mouse = { x: 0, y: 0, inside: false };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s));
  const trim = (s, n = 40) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');

  // ---- date helpers (local, no tz drift) -----------------------------------
  const startOfDay = (d) => { d = new Date(d); d.setHours(0, 0, 0, 0); return d; };
  const isoDate = (d) => { d = new Date(d); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const addDays = (d, n) => { d = new Date(d); d.setDate(d.getDate() + n); return d; };
  const dayName = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long' });
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

  // ===================== STORE ============================================
  function loadStore() {
    store = (dataManager.getEcosystem && dataManager.getEcosystem()) || {};
    if (!Array.isArray(store.nodes)) store.nodes = [];
    if (!store.layout || typeof store.layout !== 'object') store.layout = {};
    if (!store.collapsed || typeof store.collapsed !== 'object') store.collapsed = {}; // projects the user closed
    if (!store.expanded || typeof store.expanded !== 'object') store.expanded = {};    // deep nodes the user pinned open
    if (!store.dismissed || typeof store.dismissed !== 'object') store.dismissed = {}; // suggestion ids dismissed
    if (!store.lens || typeof store.lens !== 'object') store.lens = {};                 // projectId -> organizing lens
    if (!Array.isArray(store.widgets)) store.widgets = [];                              // canvas widgets (timers, notes)
    if (store.showSuggestWidgets === undefined) store.showSuggestWidgets = true;         // suggestions bloom on the canvas
    if (store.showAppAreas === undefined) store.showAppAreas = true;                     // Calendar/Email/… branches in the tree
    if (store.showCompleted === undefined) store.showCompleted = (dataManager.settings.showCompleted !== false); // done tasks in lists
    if (store.showData === undefined) store.showData = true;
    if (store.steer === undefined) store.steer = true;
    if (!store.easeSpeed || !EASE[store.easeSpeed]) store.easeSpeed = 'normal';
    steerEnabled = store.steer;
  }
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { if (dataManager.saveEcosystem) dataManager.saveEcosystem(store); }, 350);
  }

  // ===================== CAMERA (device-local, within-session only) =======
  function saveCamera() { clearTimeout(cameraTimer); cameraTimer = setTimeout(() => { try { localStorage.setItem('ecosystem_camera', JSON.stringify(camera)); } catch (e) {} }, 250); }
  function applyCamera() { if (world) world.style.transform = `translate(${camera.tx}px,${camera.ty}px) scale(${camera.scale})`; positionWidgets(); }

  // ===================== GRAPH ============================================
  function catInfo(cid) {
    const c = (typeof getCategoryById === 'function') ? getCategoryById(cid) : null;
    return { label: c ? (c.name || c.label) : String(cid), color: c ? c.color : GRAY };
  }
  function addNode(n) { graph.set(n.id, { childrenIds: [], ...n }); return graph.get(n.id); }

  function buildGraph() {
    graph = new Map();
    depthCache = new Map();
    addNode({ id: 'root', kind: 'root', label: 'Workspace', color: GRAY, parentId: null, limb: GRAY });
    for (const p of (dataManager.projects || [])) {
      const col = (p && p.color) || '#6366F1';
      addNode({ id: 'proj:' + p.id, kind: 'project', label: p.name || 'Project', color: col, limb: col, parentId: 'root', ref: p });
      const lens = (store.lens && store.lens[p.id]) || 'category';
      const catIds = new Set();
      if (lens === 'category') {
        for (const raw of (Array.isArray(p.categories) ? p.categories : [])) {
          const cid = (raw && typeof raw === 'object') ? raw.id : raw;
          if (!cid || catIds.has(cid)) continue;
          catIds.add(cid);
          const ci = catInfo(cid);
          addNode({ id: `cat:${p.id}:${cid}`, kind: 'category', label: ci.label, color: ci.color, limb: col, parentId: 'proj:' + p.id, catId: cid, projectId: p.id });
        }
      }
      if (store.showData) {
        // Bulk data (tasks/events/purchases/to-dos) are NOT branches — they live as
        // `items` on their container node and surface as a list widget on hover.
        const taskItem = (t) => ({ kind: 'task', ref: t, label: t.title || 'Untitled', done: !!t.completed, priority: t.priority, status: t.status });
        const pushItem = (nodeId, item) => { const nn = graph.get(nodeId); if (nn) { (nn.items = nn.items || []).push(item); } };
        const projTasks = (dataManager.tasks || []).filter(t => t.projectId === p.id);
        if (lens === 'category') {
          let genMade = false;
          for (const t of projTasks) {
            let parent;
            if (t.category && catIds.has(t.category)) parent = `cat:${p.id}:${t.category}`;
            else { if (!genMade) { addNode({ id: `cat:${p.id}:__gen`, kind: 'category', label: 'General', color: GRAY, limb: col, parentId: 'proj:' + p.id, items: [] }); genMade = true; } parent = `cat:${p.id}:__gen`; }
            pushItem(parent, taskItem(t));
          }
        } else {
          const made = new Set();
          for (const t of projTasks) {
            const b = taskBucket(lens, t);
            const bid = `lens:${p.id}:${b.key}`;
            if (!made.has(bid)) { addNode({ id: bid, kind: 'category', label: b.label, color: b.color, limb: col, parentId: 'proj:' + p.id, items: [] }); made.add(bid); }
            pushItem(bid, taskItem(t));
          }
        }
        const buckets = [
          { key: 'schedule', label: 'Schedule', kind: 'event', items: (dataManager.scheduleItems || []).filter(s => s.projectId === p.id), title: s => s.title, sub: s => s.date || s.day || '' },
          { key: 'purchases', label: 'Purchases', kind: 'purchase', items: (dataManager.purchases || []).filter(s => s.projectId === p.id), title: s => s.item, sub: s => s.status || '' },
          { key: 'todos', label: 'To-dos', kind: 'todo', items: (dataManager.todos || []).filter(s => s.projectId === p.id), title: s => s.text || s.title, sub: () => '' },
        ];
        for (const b of buckets) {
          if (!b.items.length) continue;
          addNode({ id: `bucket:${p.id}:${b.key}`, kind: 'bucket', label: b.label, color: col, limb: col, parentId: 'proj:' + p.id,
            items: b.items.map(it => ({ kind: b.kind, ref: it, label: b.title(it) || '(untitled)', sub: b.sub(it), done: !!it.completed })) });
        }
      }
    }
    // App-area branches — the rest of the app, woven into the same tree so the
    // whole workspace lives in one organic space (opening one shows the full view).
    if (store.showAppAreas !== false) {
      addNode({ id: 'app:hub', kind: 'apphub', label: 'Apps', sub: 'the rest of your workspace', color: '#818CF8', limb: '#818CF8', parentId: 'root', icon: '🧩' });
      for (const a of APP_AREAS) addNode({ id: 'app:' + a.key, kind: 'app', label: a.label, sub: a.sub, color: a.color, limb: a.color, parentId: 'app:hub', view: a.key, icon: a.icon });
    }
    for (const un of store.nodes) {
      const parentId = graph.has(un.parentId) ? un.parentId : 'root';
      const limb = graph.get(parentId) ? graph.get(parentId).limb : GRAY;
      addNode({ id: un.id, kind: un.kind, label: un.label || (KIND[un.kind] || KIND.note).icon, sub: un.sub || '', color: limb, limb, parentId, data: un.data || {}, user: true, ref: un });
    }
    for (const n of graph.values()) if (n.parentId && graph.has(n.parentId)) graph.get(n.parentId).childrenIds.push(n.id);
    return graph;
  }
  const APP_AREAS = [
    { key: 'calendar', label: 'Calendar', sub: 'schedule & events', icon: '📅', color: '#F59E0B' },
    { key: 'timeline', label: 'Timeline', sub: 'activity feed', icon: '📈', color: '#8B5CF6' },
    { key: 'board', label: 'Board', sub: 'kanban', icon: '📋', color: '#3B82F6' },
    { key: 'email', label: 'Email', sub: 'inbox', icon: '✉️', color: '#EC4899' },
    { key: 'purchasing', label: 'Purchases', sub: 'orders & tracking', icon: '📦', color: '#22C55E' },
    { key: 'stats', label: 'Stats', sub: 'analytics', icon: '📊', color: '#06B6D4' },
    { key: 'timers', label: 'Timers', sub: 'clocks & alarms', icon: '⏱', color: '#F97316' },
    { key: 'files', label: 'Files', sub: 'browser & CAD', icon: '🗂️', color: '#14B8A6' },
    { key: 'engineering', label: 'Tools', sub: 'utilities', icon: '🔧', color: '#64748B' },
  ];

  function depthOf(id) {
    if (depthCache.has(id)) return depthCache.get(id);
    let d = 0, cur = graph.get(id);
    while (cur && cur.parentId) { d++; cur = graph.get(cur.parentId); }
    depthCache.set(id, d); return d;
  }
  function fullChildCount(id) { const n = graph.get(id); return n ? n.childrenIds.length : 0; }
  function itemCount(id) { const n = graph.get(id); return (n && n.items) ? n.items.length : 0; }
  function subtreeItems(id) { const n = graph.get(id); if (!n) return 0; let s = n.items ? n.items.length : 0; for (const c of n.childrenIds) s += subtreeItems(c); return s; }
  // Node size scales with how much it holds — a category of 40 notes reads bigger
  // than one with 3; a project's size reflects its whole subtree.
  function nodeScale(id) {
    if (id === 'root') return 1.35;
    if (id.startsWith('more:')) return 0.9;
    if (id === 'app:hub') return 1.12;
    if (id.startsWith('app:')) return 1.02;
    const w = subtreeItems(id);
    if (!w) return 0.9;
    return Math.min(0.9 + (Math.min(w, 45) / 45) * 0.55, 1.45);
  }
  function ancestors(id) { const out = []; let c = graph.get(id); while (c && c.parentId) { out.push(c.parentId); c = graph.get(c.parentId); } return out; }
  function ownerProject(id) { let c = graph.get(id); while (c) { if (c.id.startsWith('proj:')) return c.id.slice(5); if (c.id.startsWith('cat:') || c.id.startsWith('bucket:')) return c.id.split(':')[1]; c = c.parentId ? graph.get(c.parentId) : null; } return null; }

  // Progressive disclosure: from the start only the projects show (root is open).
  // Everything deeper opens on demand — pinned open, or on the cursor's focus path.
  function isOpen(id) {
    if (id.startsWith('more:')) return false;
    if (id === 'root') return true;
    return !!(store.expanded[id] || focusPath.has(id));
  }

  // Clustering: only render the first `shown` children of a big branch, plus a
  // synthetic "+N more" node that reveals the next batch when clicked/focused.
  function childrenToShow(id) {
    const kids = graph.get(id).childrenIds;
    if (kids.length <= CAP + 1) return kids.slice();
    const shown = moreShown.get(id) || CAP;
    if (kids.length <= shown + 1) return kids.slice();
    const list = kids.slice(0, shown);
    const moreId = 'more:' + id;
    addNode({ id: moreId, kind: 'more', label: `+${kids.length - shown} more`, color: graph.get(id).limb, limb: graph.get(id).limb, parentId: id, moreParent: id });
    list.push(moreId);
    return list;
  }

  function computeVisible() {
    visList = []; visChildren = new Map();
    const walk = (id) => {
      visList.push(id);
      if (!isOpen(id)) { visChildren.set(id, []); return; }
      const kids = childrenToShow(id);
      visChildren.set(id, kids);
      for (const k of kids) {
        if (k.startsWith('more:')) { visList.push(k); visChildren.set(k, []); }
        else walk(k);
      }
    };
    if (graph.has('root')) walk('root');
  }

  // ===================== LAYOUT (radial tidy tree) =======================
  // Stable, incremental layout. Projects sit evenly around the trunk; a node's
  // children fan outward from IT at a fixed distance. Positions are CACHED (`placed`)
  // and reused across renders, so expanding one branch never moves anything else —
  // that global reflow was what made hovering feel glitchy.
  function computeLayout() {
    posMap = new Map();
    const rootPos = store.layout['root'] || placed.get('root') || { x: 0, y: 0 };
    posMap.set('root', rootPos); placed.set('root', rootPos);
    const posFor = (id, angle, dist, from) => {
      if (store.layout[id] && Number.isFinite(store.layout[id].x)) return store.layout[id];
      if (placed.has(id)) return placed.get(id);
      const p = { x: from.x + Math.cos(angle) * dist, y: from.y + Math.sin(angle) * dist };
      placed.set(id, p); return p;
    };
    const walk = (id) => {
      const kids = visChildren.get(id) || [];
      if (!kids.length) return;
      const P = posMap.get(id);
      if (id === 'root') {
        const n = kids.length, step = (2 * Math.PI) / n, start = -Math.PI / 2;
        const Rr = Math.max(RING, (185 * n) / (2 * Math.PI)); // give projects breathing room
        kids.forEach((k, i) => posMap.set(k, posFor(k, start + i * step, Rr, P)));
      } else {
        // Fan children outward into open space; widen the arc as the count grows and
        // stagger THREE rings so wide text cards don't collide — an organic bloom.
        const outward = Math.atan2(P.y - rootPos.y, P.x - rootPos.x);
        const n = kids.length;
        const spread = Math.min(Math.PI * 1.7, 0.7 + n * 0.4);
        const start = outward - spread / 2, step = n > 1 ? spread / (n - 1) : 0;
        kids.forEach((k, i) => posMap.set(k, posFor(k, n === 1 ? outward : start + i * step, CHILD_DIST + (i % 3) * 118, P)));
      }
      for (const k of kids) walk(k);
    };
    walk('root');
  }

  // ===================== RENDER ==========================================
  function edgePath(px, py, cx, cy) {
    const mx = (px + cx) / 2, my = (py + cy) / 2, dx = cx - px, dy = cy - py, len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(60, len * 0.12);
    return `M${px},${py} Q${mx + (-dy / len) * bow},${my + (dx / len) * bow} ${cx},${cy}`;
  }
  function renderEdges() {
    let s = '';
    for (const id of visList) {
      if (id === 'root') continue;
      const n = graph.get(id), pp = posMap.get(n.parentId), cp = posMap.get(id);
      if (!pp || !cp) continue;
      // tapered, glowing limbs — thicker near the trunk, thinning toward the leaves
      const d = depthOf(id), w = d <= 1 ? 5 : d === 2 ? 3 : 2;
      const pth = edgePath(pp.x, pp.y, cp.x, cp.y);
      s += `<path d="${pth}" fill="none" stroke="${n.limb}" stroke-width="${w + 5}" stroke-opacity="0.12" stroke-linecap="round"/>`; // glow
      s += `<path d="${pth}" fill="none" stroke="${n.limb}" stroke-width="${w}" stroke-opacity="0.72" stroke-linecap="round"/>`;
    }
    edgesG.innerHTML = s;
  }
  function nodeIconHtml(n) {
    if (n.kind === 'project' || n.kind === 'category' || n.kind === 'bucket') return `<span class="eco-dot" style="background:${n.color}"></span>`;
    if (n.kind === 'file' || n.kind === 'cad') {
      const ext = (n.data && n.data.path ? n.data.path.split('.').pop() : '').toLowerCase();
      return `<span class="eco-node-ic">${EXT_ICON[ext] || KIND[n.kind].icon}</span>`;
    }
    if (n.kind === 'utility' && n.data && n.data.icon) return `<span class="eco-node-ic">${esc(n.data.icon)}</span>`;
    if (n.kind === 'app' || n.kind === 'apphub') return `<span class="eco-node-ic">${esc(n.icon || '🧩')}</span>`;
    return `<span class="eco-node-ic">${(KIND[n.kind] || KIND.note).icon}</span>`;
  }
  function nodeSub(n) {
    if (n.kind === 'project') { const l = store.lens && store.lens[n.ref && n.ref.id]; return l ? 'grouped by ' + lensLabel(l).toLowerCase() : ''; }
    if (n.sub) return n.sub;
    if (n.data && n.data.path) return n.data.path.replace(/\\/g, '/').split('/').slice(-1)[0];
    if (n.data && n.data.url) return n.data.url.replace(/^https?:\/\//, '');
    if (n.kind === 'utility' && n.data && n.data.boundFolder) return '→ ' + n.data.boundFolder.replace(/\\/g, '/').split('/').pop();
    return '';
  }
  function renderNodes() {
    let html = '';
    for (const id of visList) {
      const n = graph.get(id), pos = posMap.get(id);
      if (!pos) continue;
      if (isMedia(n)) continue; // rendered as a live preview card in the media layer
      if (n.kind === 'more') {
        html += `<div class="eco-node kind-more" data-more="${esc(id)}" style="left:${pos.x}px;top:${pos.y}px;--eco-accent:${n.color}"><span class="eco-node-ic">⋯</span><span class="eco-node-body"><span class="eco-node-title">${esc(n.label)}</span></span></div>`;
        continue;
      }
      const kids = fullChildCount(id), open = isOpen(id), items = itemCount(id);
      let pill = '';
      if (kids && id !== 'root') {
        if (!open) pill = `<button class="eco-collapse" data-exp="${esc(id)}" title="Pin open">+${kids}</button>`;
        else if (store.expanded[id]) pill = `<button class="eco-collapse open" data-exp="${esc(id)}" title="Unpin">–</button>`;
      }
      const badge = items ? `<span class="eco-count" title="${items} item${items > 1 ? 's' : ''} — hover to list">${items > 99 ? '99+' : items}</span>` : '';
      const sub = nodeSub(n);
      const cls = `eco-node kind-${n.kind}${id === selectedId ? ' selected' : ''}${id === hoverId ? ' focus' : ''}${n.done ? ' done' : ''}`;
      html += `<div class="${cls}" data-id="${esc(id)}" style="left:${pos.x}px;top:${pos.y}px;--eco-accent:${n.color};--eco-scale:${nodeScale(id).toFixed(3)}" title="${esc(n.label)}${sub ? ' — ' + esc(sub) : ''}">`
        + nodeIconHtml(n)
        + `<span class="eco-node-body"><span class="eco-node-title">${esc(n.label)}</span>${sub ? `<span class="eco-node-sub">${esc(sub)}</span>` : ''}</span>`
        + (n.kind === 'app' || n.kind === 'apphub' ? '' : `<button class="eco-node-add" title="Add to this branch" aria-label="Add">+</button>`)
        + pill + badge + `</div>`;
    }
    nodesLayer.innerHTML = html;
  }
  // Image/PDF file nodes render as LIVE preview cards (persistent, so they don't
  // reload each render) in a layer inside the world — you see the content, and
  // clicking opens the maximizable window.
  const MEDIA_IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
  const CAD_THUMB = ['stl', 'obj', 'glb', 'gltf']; // renderable to a thumbnail (STEP needs occt → icon only)
  function isMedia(n) { if (!n || (n.kind !== 'file' && n.kind !== 'cad')) return false; const ext = (n.data && n.data.path ? n.data.path.split('.').pop() : '').toLowerCase(); return MEDIA_IMG.includes(ext) || ext === 'pdf' || CAD_THUMB.includes(ext); }
  function buildMediaCard(id, n) {
    const path = n.data.path, ext = (path.split('.').pop() || '').toLowerCase();
    const card = document.createElement('div');
    card.className = 'eco-node eco-media-card kind-' + n.kind;
    card.dataset.id = id; card.style.setProperty('--eco-accent', n.color);
    card.innerHTML = `<div class="eco-media-bar"><span class="eco-media-name">${esc(n.label)}</span><span class="eco-media-exp" title="Open">⤢</span></div><div class="eco-media-view"><div class="eco-media-click"></div></div>`;
    const view = card.querySelector('.eco-media-view');
    if (ext === 'pdf') { const emb = document.createElement('embed'); emb.type = 'application/pdf'; emb.className = 'eco-media-content'; window.api.files.getFileUrl(path).then(u => { emb.src = u + '#toolbar=0&navpanes=0&scrollbar=0&view=FitH'; }); view.appendChild(emb); }
    else if (CAD_THUMB.includes(ext)) {
      card.classList.add('eco-media-cad');
      const img = document.createElement('img'); img.className = 'eco-media-content'; view.appendChild(img);
      const spin = document.createElement('div'); spin.className = 'eco-media-cadwait'; spin.textContent = '🧊'; view.appendChild(spin);
      requestCadThumb(path, ext, (url) => { if (url) { img.src = url; spin.remove(); } else { spin.textContent = '🧊 3D'; } });
    }
    else { const img = document.createElement('img'); img.className = 'eco-media-content'; window.api.files.getFileUrl(path).then(u => { img.src = u; }); view.appendChild(img); }
    card._path = path;
    return card;
  }
  // CAD thumbnails: render each model once in a throwaway viewer (its own WebGL
  // context, disposed right after capture — so it never clobbers the live singleton),
  // cache the PNG, and reuse it on the card. Generated one at a time via a queue.
  const cadThumbs = new Map(); // path -> dataURL | null
  let _thumbQ = [], _thumbBusy = false;
  function requestCadThumb(path, ext, cb) {
    if (cadThumbs.has(path)) { cb(cadThumbs.get(path)); return; }
    _thumbQ.push({ path, ext, cb }); pumpThumbs();
  }
  async function pumpThumbs() {
    if (_thumbBusy || !_thumbQ.length) return;
    _thumbBusy = true;
    const { path, ext, cb } = _thumbQ.shift();
    let url = null;
    if (typeof CadViewerInstance !== 'undefined' && typeof THREE !== 'undefined') {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:0;width:260px;height:190px;';
      document.body.appendChild(host);
      let inst = null;
      try {
        inst = new CadViewerInstance(host);
        if (ext === 'stl') { const u = await window.api.files.getFileUrl(path); await new Promise((res, rej) => new THREE.STLLoader().load(u, g => { g.computeVertexNormals(); inst.addMesh(g, 0x8899cc); inst.fitToModel(); res(); }, undefined, rej)); }
        else if (ext === 'obj') { const u = await window.api.files.getFileUrl(path); await new Promise((res, rej) => new THREE.OBJLoader().load(u, obj => { obj.traverse(c => { if (c.isMesh) c.material = new THREE.MeshStandardMaterial({ color: 0x8899cc, metalness: 0.3, roughness: 0.6, side: THREE.DoubleSide }); }); inst.scene.add(obj); inst.fitToModel(); res(); }, undefined, rej)); }
        else { const buf = await window.api.files.readBinary(path); await new Promise((res, rej) => new THREE.GLTFLoader().parse(buf, '', gl => { inst.scene.add(gl.scene); inst.fitToModel(); res(); }, rej)); }
        inst.renderer.render(inst.scene, inst.camera);
        url = inst.renderer.domElement.toDataURL('image/png');
      } catch (e) { url = null; }
      try { if (inst) inst.dispose(); } catch (e) {}
      host.remove();
    }
    cadThumbs.set(path, url);
    try { cb(url); } catch (e) {}
    _thumbBusy = false;
    setTimeout(pumpThumbs, 80);
  }
  function renderMedia() {
    if (!mediaLayer) return;
    const visMedia = new Set();
    for (const id of visList) if (isMedia(graph.get(id))) visMedia.add(id);
    for (const id of visMedia) {
      const n = graph.get(id); let card = mediaCards.get(id);
      if (!card || card._path !== (n.data && n.data.path)) { if (card) card.remove(); card = buildMediaCard(id, n); mediaCards.set(id, card); mediaLayer.appendChild(card); }
      const p = posMap.get(id); if (!p) { card.style.display = 'none'; continue; }
      card.style.left = p.x + 'px'; card.style.top = p.y + 'px'; card.style.setProperty('--eco-scale', nodeScale(id).toFixed(3));
      card.classList.toggle('focus', id === hoverId);
      card.style.display = '';
    }
    for (const [id, card] of mediaCards) if (!visMedia.has(id)) { if (!graph.has(id)) { card.remove(); mediaCards.delete(id); } else card.style.display = 'none'; }
  }
  function render() {
    if (!active) return;
    buildGraph();
    computeVisible();
    computeLayout();
    renderEdges();
    renderNodes();
    renderMedia();
    updateTiers();
    applyCamera();
    updateSuggestBadge();
  }
  function updateHoverClass() {
    nodesLayer.querySelectorAll('.eco-node.focus').forEach(el => el.classList.remove('focus'));
    if (hoverId) { const el = nodesLayer.querySelector(`.eco-node[data-id="${cssEsc(hoverId)}"]`); if (el) el.classList.add('focus'); }
  }
  // Microscope depth-of-field: the branch you're looking at (focus node + its
  // descendants) is sharp; its ancestor spine is faintly blurred; everything else
  // recedes into a blurry, dimmed background. No focus → the whole overview is sharp.
  function updateTiers() {
    if (!nodesLayer) return;
    const focusNode = listPopupId || expandId;
    const sharp = new Set(), mid = new Set();
    if (focusNode && graph.has(focusNode)) {
      const mark = (nid) => { sharp.add(nid); const g = graph.get(nid); if (g) g.childrenIds.forEach(mark); };
      mark(focusNode);
      for (const a of ancestors(focusNode)) mid.add(a);
    }
    nodesLayer.querySelectorAll('.eco-node').forEach(el => {
      el.classList.remove('tier-mid', 'tier-bg');
      if (!focusNode) return;
      const id = el.dataset.id || el.dataset.more;
      if (sharp.has(id) || id === focusNode) return;
      el.classList.add(mid.has(id) ? 'tier-mid' : 'tier-bg');
    });
    if (edgesSvg) edgesSvg.classList.toggle('dim', !!focusNode);
  }
  function liveUpdate(id) {
    const card = nodesLayer.querySelector(`.eco-node[data-id="${cssEsc(id)}"]`);
    const pos = posMap.get(id);
    if (card && pos) { card.style.left = pos.x + 'px'; card.style.top = pos.y + 'px'; }
    renderEdges();
  }

  // ===================== CAMERA / FIT ====================================
  function screenToWorld(cx, cy) { const r = root.getBoundingClientRect(); return { x: (cx - r.left - camera.tx) / camera.scale, y: (cy - r.top - camera.ty) / camera.scale }; }
  // Compute a camera { scale, tx, ty } that frames a set of node ids, accounting for
  // the cards' real extent (half-width/half-height) so nothing clips at the edges.
  function fitRectFor(ids) {
    const HW = 120, HH = 36;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) { const p = posMap.get(id); if (!p) continue; minX = Math.min(minX, p.x - HW); minY = Math.min(minY, p.y - HH); maxX = Math.max(maxX, p.x + HW); maxY = Math.max(maxY, p.y + HH); }
    if (!Number.isFinite(minX)) return null;
    const pad = 80, r = root.getBoundingClientRect();
    const w = (maxX - minX) + pad * 2, h = (maxY - minY) + pad * 2;
    const scale = clamp(Math.min(r.width / w, r.height / h) * 0.9, 0.12, 1.25);
    return { scale, tx: r.width / 2 - ((minX + maxX) / 2) * scale, ty: r.height / 2 - ((minY + maxY) / 2) * scale };
  }
  function fitToView(silent) {
    const t = fitRectFor(visList); if (!t) return;
    camera.scale = t.scale; camera.tx = t.tx; camera.ty = t.ty;
    applyCamera(); if (!silent) saveCamera();
  }

  // ===================== CURSOR STEER + FOCUS ============================
  function startSteer() { if (steerRAF) return; const loop = () => { steerTick(); steerRAF = (active && (mouse.inside || camTarget)) ? requestAnimationFrame(loop) : null; }; steerRAF = requestAnimationFrame(loop); }
  function stopSteer() { if (steerRAF) cancelAnimationFrame(steerRAF); steerRAF = null; }
  function easeCamera() {
    if (!camTarget) return;
    const dx = camTarget.tx - camera.tx, dy = camTarget.ty - camera.ty, ds = camTarget.scale - camera.scale;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4 && Math.abs(ds) < 0.001) { camera.tx = camTarget.tx; camera.ty = camTarget.ty; camera.scale = camTarget.scale; camTarget = null; applyCamera(); return; }
    const f = EASE[(store && store.easeSpeed) || 'normal'] || EASE.normal;
    camera.tx += dx * f; camera.ty += dy * f; camera.scale += ds * f; applyCamera();
  }
  function steerTick() {
    if (!steerEnabled || drag || pan || menuEl) return;
    if (overPopup) { emptySince = 0; return; }    // hovering the list widget → stay put
    if (!mouse.inside) { easeCamera(); return; }  // cursor left the canvas → just finish the glide
    if (camTarget) { easeCamera(); if (listPopup) positionPopupNear(listPopupId); return; } // mid-glide: don't re-pick focus
    const r = root.getBoundingClientRect();
    const mx = mouse.x - r.left, my = mouse.y - r.top;
    let best = null, bestD = FOCUS_RADIUS;
    for (const id of visList) {
      if (id === 'root') continue;
      const p = posMap.get(id); if (!p) continue;
      const sx = p.x * camera.scale + camera.tx, sy = p.y * camera.scale + camera.ty;
      const dd = Math.hypot(sx - mx, sy - my); if (dd < bestD) { bestD = dd; best = id; }
    }
    // Cheap highlight follows the exact node under the cursor (no re-render).
    if (best !== hoverId) { hoverId = best; updateHoverClass(); }
    if (best) {
      emptySince = 0; // engaged with a branch — don't recenter
      // Highlight is instant, but wait a beat before actually expanding/listing so a
      // cursor brushing past a node doesn't twitchily hook onto it.
      if (best !== engagedId) { engagedId = best; engagedSince = performance.now(); }
      else if (performance.now() - engagedSince >= DWELL) {
        // data nodes pop a list widget; structural nodes expand their child branches.
        if (itemCount(best)) openListPopup(best); else closeListPopup();
        let target = best;
        if (target) { const n = graph.get(target); if (n && !n.childrenIds.length) target = (n.parentId && n.parentId !== 'root') ? n.parentId : null; }
        if (target && target !== expandId) setExpand(target);
      }
    } else {
      engagedId = null;
      // cursor is off every branch → after a beat, collapse the focus and glide back
      // to the centered overview (recenter) rather than letting the camera drift.
      if (emptySince === 0) emptySince = performance.now();
      else if (emptySince > 0 && performance.now() - emptySince > 450) {
        emptySince = -1; closeListPopup();
        if (focusPath.size) { focusPath = new Set(); expandId = null; render(); }
        camTarget = fitRectFor(visList);
      }
    }
    easeCamera();
    if (listPopup && !overPopup) positionPopupNear(listPopupId);
  }
  function setExpand(id) {
    expandId = id;
    const np = new Set([id]); for (const a of ancestors(id)) np.add(a);
    const changed = np.size !== focusPath.size || [...np].some(x => !focusPath.has(x));
    focusPath = np;
    if (changed) { render(); if (!allVisibleInView()) camTarget = fitRectFor(visList); } // frame the bloom if it overflows
  }
  // Are all visible nodes comfortably inside the viewport? (accounts for the hint bar
  // + toolbar margins). Used to decide whether an expansion needs the camera to move.
  function allVisibleInView() {
    const r = root.getBoundingClientRect();
    for (const id of visList) {
      if (id === 'root') continue;
      const p = posMap.get(id); if (!p) continue;
      const sx = p.x * camera.scale + camera.tx, sy = p.y * camera.scale + camera.ty;
      if (sx < 130 || sx > r.width - 130 || sy < 90 || sy > r.height - 50) return false;
    }
    return true;
  }

  // ===================== INTERACTION =====================================
  function onWheel(e) {
    if (e.target.closest('.eco-panel') || e.target.closest('.eco-list') || e.target.closest('.eco-suggest-stack') || e.target.closest('.eco-win') || e.target.closest('.eco-w')) return; // let panels/widgets scroll
    e.preventDefault();
    camTarget = null; // manual zoom cancels any auto-frame glide
    const r = root.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12, ns = clamp(camera.scale * f, 0.12, 3.5);
    const wx = (mx - camera.tx) / camera.scale, wy = (my - camera.ty) / camera.scale;
    camera.tx = mx - wx * ns; camera.ty = my - wy * ns; camera.scale = ns; applyCamera(); saveCamera();
  }
  function onPointerDown(e) {
    if (e.button === 2) return;
    if (e.target.closest('.eco-panel') || e.target.closest('.eco-toolbar') || e.target.closest('.eco-list') || e.target.closest('.eco-w') || e.target.closest('.eco-win') || e.target.closest('.eco-suggest-stack')) return;
    if (e.target.closest('.eco-node-add') || e.target.closest('.eco-collapse') || e.target.closest('[data-more]')) return;
    closeMenu();
    camTarget = null; // manual pan/drag cancels any auto-frame glide
    const nodeEl = e.target.closest('.eco-node');
    if (nodeEl && nodeEl.dataset.id) {
      const id = nodeEl.dataset.id;
      drag = { id, startX: e.clientX, startY: e.clientY, moved: false, orig: { ...(posMap.get(id) || { x: 0, y: 0 }) }, target: null };
    } else {
      pan = { startX: e.clientX, startY: e.clientY, tx: camera.tx, ty: camera.ty };
      root.classList.add('panning');
    }
    try { root.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function onPointerMove(e) {
    mouse.x = e.clientX; mouse.y = e.clientY;
    if (pan) { camera.tx = pan.tx + (e.clientX - pan.startX); camera.ty = pan.ty + (e.clientY - pan.startY); applyCamera(); return; }
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    posMap.set(drag.id, { x: drag.orig.x + dx / camera.scale, y: drag.orig.y + dy / camera.scale });
    liveUpdate(drag.id);
    const node = graph.get(drag.id);
    // File/CAD attachments can be repositioned but NOT re-parented (no moving them
    // between projects); everything else can be dropped onto a new parent.
    if (node && node.user && node.kind !== 'file' && node.kind !== 'cad') {
      const card = nodesLayer.querySelector(`.eco-node[data-id="${cssEsc(drag.id)}"]`);
      if (card) card.style.pointerEvents = 'none';
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (card) card.style.pointerEvents = '';
      const tEl = hit && hit.closest('.eco-node');
      const tid = tEl && tEl.dataset.id;
      const valid = tid && tid !== drag.id && !tid.startsWith('more:') && !isDescendant(tid, drag.id);
      if (drag.target && drag.target !== tid) markDrop(drag.target, false);
      drag.target = valid ? tid : null;
      if (drag.target) markDrop(drag.target, true);
    }
  }
  function onPointerUp(e) {
    if (pan) { pan = null; root.classList.remove('panning'); saveCamera(); return; }
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) { const nn = graph.get(d.id); if (nn && OPEN_ON_CLICK.has(nn.kind)) { selectNode(d.id); openNode(d.id); } else selectNode(d.id); return; }
    if (d.target) markDrop(d.target, false);
    const node = graph.get(d.id);
    if (node && node.user && d.target) { node.ref.parentId = d.target; delete store.layout[d.id]; placed.delete(d.id); persist(); render(); }
    else { store.layout[d.id] = posMap.get(d.id); placed.set(d.id, posMap.get(d.id)); persist(); }
  }
  function isDescendant(id, ancestorId) { let c = graph.get(id); while (c && c.parentId) { if (c.parentId === ancestorId) return true; c = graph.get(c.parentId); } return false; }
  function markDrop(id, on) { const el = nodesLayer.querySelector(`.eco-node[data-id="${cssEsc(id)}"]`); if (el) el.classList.toggle('eco-drop', on); }
  function selectNode(id) { selectedId = id; nodesLayer.querySelectorAll('.eco-node.selected').forEach(el => el.classList.remove('selected')); const el = nodesLayer.querySelector(`.eco-node[data-id="${cssEsc(id)}"]`); if (el) el.classList.add('selected'); }

  function toggleOpen(id) {
    if (id === 'root' || !fullChildCount(id)) return;
    if (store.expanded[id]) delete store.expanded[id]; else store.expanded[id] = true;
    persist(); render();
  }
  function showMore(parentId) { moreShown.set(parentId, (moreShown.get(parentId) || CAP) + CAP); render(); }
  function setLens(pid, lensId) {
    store.lens = store.lens || {};
    if (lensId === 'category') delete store.lens[pid]; else store.lens[pid] = lensId;
    store.expanded['proj:' + pid] = true; // reveal the regrouped result
    persist(); render();
  }

  // ===================== OPEN (double-click default action) ==============
  async function openNode(id) {
    const n = graph.get(id); if (!n) return;
    switch (n.kind) {
      case 'root': case 'project': case 'category': case 'bucket': case 'branch': case 'folder': case 'apphub':
        if (n.kind === 'folder' && n.data && n.data.path) { window.api.openPath(n.data.path); return; }
        toggleOpen(id); return;
      case 'file': openFileWindow(n); return;
      case 'link': if (n.data && n.data.url) window.api.openExternal(n.data.url); return;
      case 'cad': openFileWindow(n); return;
      case 'utility': openUtilityPanel(n); return;
      case 'note': openNotePanel(n); return;
      case 'app': { if (window.chromeTabsEnabled && window.chromeTabsEnabled()) window.chromeOpenTab({ view: n.view, title: n.label, icon: n.icon }); else if (window.switchToView) window.switchToView(n.view); return; }
      case 'task': if (n.ref) window.dispatchEvent(new CustomEvent('edit-note', { detail: n.ref })); return;
      case 'event': case 'purchase': case 'todo': openInfoPanel(n); return;
    }
  }

  // ===================== ADD / CREATE ====================================
  const ADD_TYPES = [
    { kind: 'folder', label: 'Folder', icon: '📁' }, { kind: 'file', label: 'File(s)', icon: '📄' },
    { kind: 'cad', label: 'CAD model', icon: '🧊' }, { kind: 'link', label: 'Link / URL', icon: '🔗' },
    { kind: 'utility', label: 'Utility', icon: '🔧' }, { kind: 'note', label: 'Note', icon: '🗒️' },
    { kind: 'branch', label: 'Sub-branch', icon: '🌿' },
  ];
  function openAddMenu(parentId, x, y) { showMenu(x, y, ADD_TYPES.map(t => ({ icon: t.icon, label: t.label, onClick: () => createNode(parentId, t.kind, x, y) }))); }
  function newUserNode(parentId, kind, extra, x, y) {
    const id = 'eco_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const node = { id, kind, parentId, ...extra };
    store.nodes.push(node);
    if (Number.isFinite(x)) { const w = screenToWorld(x, y); store.layout[id] = { x: w.x, y: w.y }; }
    if (depthOf(parentId) >= 2) store.expanded[parentId] = true; // make sure the new child is visible
    persist();
    return node;
  }
  async function createNode(parentId, kind, x, y) {
    if (kind === 'folder') { const p = await window.api.files.selectFolder(); if (!p) return; newUserNode(parentId, 'folder', { label: baseName(p), data: { path: p } }, x, y); }
    else if (kind === 'file' || kind === 'cad') {
      const files = await window.api.openFileDialog(); if (!files || !files.length) return;
      let off = 0;
      for (const f of files) { const ext = (f.name.split('.').pop() || '').toLowerCase(); const asCad = kind === 'cad' || CAD_EXTS.includes(ext); newUserNode(parentId, asCad ? 'cad' : 'file', { label: f.name, data: { path: f.path } }, Number.isFinite(x) ? x + off : x, y); off += 26; }
    } else if (kind === 'link') {
      const url = await window._showPrompt({ title: '🔗 Add link', message: 'URL or path', placeholder: 'https://…', confirmText: 'Add' }); if (!url) return;
      const label = await window._showPrompt({ title: '🔗 Label', placeholder: 'Optional name', confirmText: 'Add' });
      newUserNode(parentId, 'link', { label: label || url.replace(/^https?:\/\//, '').slice(0, 40), data: { url } }, x, y);
    } else if (kind === 'utility') { openUtilityPicker(parentId, x, y); return; }
    else if (kind === 'note') { const text = await window._showPrompt({ title: '🗒️ New note', message: 'Note text', placeholder: 'Type a note…', confirmText: 'Add' }); if (!text) return; newUserNode(parentId, 'note', { label: text.slice(0, 40), data: { body: text } }, x, y); }
    else if (kind === 'branch') { const name = await window._showPrompt({ title: '🌿 New sub-branch', placeholder: 'Branch name', confirmText: 'Create' }); if (!name) return; newUserNode(parentId, 'branch', { label: name }, x, y); }
    render();
  }
  function openUtilityPicker(parentId, x, y) {
    const utils = (engineeringUtilities.listInstalled ? engineeringUtilities.listInstalled() : []);
    const items = utils.map(u => ({
      icon: u.icon || '🔧', label: u.name,
      onClick: async () => {
        const bind = await window._showConfirm({ title: 'Bind a folder?', message: `Link "${u.name}" to a folder on disk? (You can skip.)`, confirmText: 'Pick folder', cancelText: 'Skip' });
        let boundFolder = ''; if (bind) { const p = await window.api.files.selectFolder(); if (p) boundFolder = p; }
        newUserNode(parentId, 'utility', { label: u.name, data: { utilityId: u.id, icon: u.icon, boundFolder } }, x, y); render();
      },
    }));
    if (!items.length) items.push({ label: 'No utilities installed', disabled: true });
    showMenu(x, y, items);
  }

  // ===================== CONTEXT MENUS ===================================
  function openNodeMenu(id, x, y) {
    const n = graph.get(id); if (!n) return;
    if (n.kind === 'app') {
      const its = [{ icon: n.icon || '↗', label: 'Open ' + n.label, onClick: () => openNode(id) }];
      if (window.chromeTabsEnabled && window.chromeTabsEnabled()) its.push({ icon: '➕', label: 'Open in new tab', onClick: () => window.chromeOpenTab({ view: n.view, title: n.label, icon: n.icon }) });
      showMenu(x, y, its); return;
    }
    if (n.kind === 'apphub') { showMenu(x, y, [{ icon: isOpen(id) ? '▾' : '▸', label: isOpen(id) ? 'Collapse apps' : 'Show apps', onClick: () => toggleOpen(id) }]); return; }
    const items = [];
    // Create REAL app data scoped to this branch (the tree is a full interface).
    const pid = ownerProject(id);
    if (n.kind === 'project' && window.chromeTabsEnabled && window.chromeTabsEnabled()) {
      items.push({ icon: '➕', label: 'Open in new tab', onClick: () => window.chromeOpenTab({ view: 'notes', project: pid, title: n.label, icon: '📁' }) });
      items.push({ sep: true });
    }
    if (n.kind === 'project' || n.kind === 'category') {
      const cid = n.kind === 'category' ? id.split(':')[2] : null;
      items.push({ icon: '📝', label: 'Add task', onClick: () => addRealItem('task', pid, cid) });
    }
    if (n.kind === 'project') {
      items.push({ icon: '📅', label: 'Add event', onClick: () => addRealItem('event', pid) });
      items.push({ icon: '📦', label: 'Add purchase', onClick: () => addRealItem('purchase', pid) });
      items.push({ icon: '✅', label: 'Add to-do', onClick: () => addTodoQuick(pid) });
    }
    if (n.kind === 'bucket') { const a = addSpecFor(id); if (a) items.push({ icon: '＋', label: a.label, onClick: a.run }); }
    if (items.length) items.push({ sep: true });
    if (n.kind === 'project') {
      const ppid = id.slice(5), cur = (store.lens && store.lens[ppid]) || 'category';
      LENSES.forEach(L => items.push({ icon: L.icon, label: (cur === L.id ? '✓ ' : '') + 'Group by ' + L.label, onClick: () => setLens(ppid, L.id) }));
      items.push({ sep: true });
    }
    ADD_TYPES.forEach(t => items.push({ icon: t.icon, label: 'Attach ' + t.label, onClick: () => createNode(id, t.kind, x, y) }));
    items.push({ sep: true });
    if (n.kind !== 'root') items.push({ icon: '↗', label: 'Open', onClick: () => openNode(id) });
    if (fullChildCount(id)) items.push({ icon: isOpen(id) ? '▾' : '▸', label: isOpen(id) ? 'Collapse' : 'Expand', onClick: () => toggleOpen(id) });
    if (n.user) { items.push({ icon: '✏', label: 'Rename', onClick: () => renameNode(id) }); if (n.kind === 'utility') items.push({ icon: '📂', label: (n.data && n.data.boundFolder) ? 'Change bound folder' : 'Bind folder', onClick: () => bindUtilityFolder(id) }); }
    items.push({ icon: '📍', label: store.layout[id] ? 'Reset position' : 'Auto-place', onClick: () => { delete store.layout[id]; placed.delete(id); persist(); render(); } });
    if (n.user) { items.push({ sep: true }); items.push({ icon: '🗑', label: 'Delete', danger: true, onClick: () => deleteUserNode(id) }); }
    showMenu(x, y, items);
  }
  function openBackgroundMenu(x, y) {
    showMenu(x, y, [
      { icon: '📁', label: 'New project', onClick: () => quickAddProject() },
      { icon: '⏱', label: 'Add timer', onClick: () => newWidget('timer', x, y, { label: 'Timer', total: 1500, remaining: 1500 }) },
      { icon: '🗒️', label: 'Add note widget', onClick: () => newWidget('note', x, y, { text: '' }) },
      { icon: '🌿', label: 'Free branch here', onClick: () => createNode('root', 'branch', x, y) },
      { sep: true },
      { icon: '💡', label: 'Suggestions…', onClick: () => openSuggestions() },
      { icon: '📊', label: 'Insights…', onClick: () => openInsightsPanel() },
      { icon: '🖨️', label: 'Print history…', onClick: () => { if (window.openPrintHistory) window.openPrintHistory(); } },
      { icon: store.showSuggestWidgets !== false ? '🙈' : '👁', label: (store.showSuggestWidgets !== false ? 'Hide' : 'Show') + ' suggestion widgets', onClick: () => { store.showSuggestWidgets = store.showSuggestWidgets === false; persist(); renderWidgets(); } },
      { sep: true },
      { icon: '🎯', label: 'Fit to view', onClick: () => fitToView() },
      { icon: '🧭', label: (steerEnabled ? 'Turn off' : 'Turn on') + ' cursor steering', onClick: () => toggleSteer() },
      { icon: '♻', label: store.showData ? 'Hide data leaves' : 'Show data leaves', onClick: () => { store.showData = !store.showData; persist(); render(); } },
      { icon: '↺', label: 'Reset all positions', danger: true, onClick: () => resetLayout() },
    ]);
  }
  async function quickAddProject() {
    const name = await window._showPrompt({ title: '📁 New project', placeholder: 'Project name', confirmText: 'Create' }); if (!name) return;
    await dataManager.addProject({ name, categories: [] });
    if (typeof assignRainbowColors === 'function') { assignRainbowColors(dataManager.projects); await dataManager._saveProjects(); }
    window.dispatchEvent(new CustomEvent('projects-changed')); render();
  }
  async function renameNode(id) { const n = graph.get(id); const name = await window._showPrompt({ title: 'Rename', defaultValue: n.label, confirmText: 'Save' }); if (name == null) return; n.ref.label = name; persist(); render(); }
  async function bindUtilityFolder(id) { const p = await window.api.files.selectFolder(); if (!p) return; const n = graph.get(id); n.ref.data = { ...(n.ref.data || {}), boundFolder: p }; persist(); render(); }
  async function deleteUserNode(id) {
    const n = graph.get(id);
    const ok = await window._showConfirm({ title: 'Delete node?', message: `Remove "${n.label}"${fullChildCount(id) ? ' and everything attached to it' : ''}? This does not touch your files.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    const rm = new Set(); const walk = (nid) => { rm.add(nid); const g = graph.get(nid); if (g) g.childrenIds.forEach(walk); }; walk(id);
    store.nodes = store.nodes.filter(un => !rm.has(un.id));
    for (const rid of rm) { delete store.layout[rid]; delete store.collapsed[rid]; delete store.expanded[rid]; placed.delete(rid); }
    if (selectedId && rm.has(selectedId)) selectedId = null;
    persist(); render();
  }
  function resetLayout() { window._showConfirm({ title: 'Reset layout?', message: 'Re-run the automatic layout and forget all manual positions?', confirmText: 'Reset' }).then(ok => { if (!ok) return; store.layout = {}; placed = new Map(); persist(); render(); fitToView(); }); }
  function toggleSteer() { steerEnabled = !steerEnabled; store.steer = steerEnabled; persist(); if (!steerEnabled) { hoverId = null; expandId = null; focusPath = new Set(); render(); } refreshToolbar(); }

  // ===================== SLIDE-IN PANEL ==================================
  function showPanel(title, subtitle, bodyBuilder, wide) {
    panelEl.className = 'eco-panel open' + (wide ? ' wide' : '');
    panelEl.innerHTML = `<div class="eco-panel-head"><div class="eco-panel-titles"><div class="eco-panel-title">${esc(title)}</div>${subtitle ? `<div class="eco-panel-sub">${esc(subtitle)}</div>` : ''}</div><button class="eco-panel-close" title="Close (Esc)">×</button></div><div class="eco-panel-body"></div>`;
    panelEl.querySelector('.eco-panel-close').addEventListener('click', closePanel);
    bodyBuilder(panelEl.querySelector('.eco-panel-body'));
  }
  function closePanel() { if (!panelEl) return; if (window.CadViewer && window.CadViewer._ensureCleanup) { try { window.CadViewer._ensureCleanup(); } catch (e) {} } panelEl.classList.remove('open'); panelEl.innerHTML = ''; }
  // ---- maximizable popup windows (files, CAD, PDFs, images) --------------
  let winZ = 3000;
  function openWindow(title, buildBody) {
    const win = document.createElement('div'); win.className = 'eco-win'; win.style.zIndex = ++winZ;
    win.innerHTML = `<div class="eco-win-bar"><span class="eco-win-title">${esc(title)}</span><span class="eco-win-btns"><button data-win="max" title="Maximize / restore">▢</button><button data-win="close" title="Close">×</button></span></div><div class="eco-win-body"></div>`;
    root.appendChild(win);
    const rr = root.getBoundingClientRect();
    win.style.left = Math.max(20, rr.width / 2 - 320) + 'px';
    win.style.top = Math.max(56, rr.height / 2 - 230) + 'px';
    const close = () => { try { if (win._cad && window.CadViewer) window.CadViewer._ensureCleanup(); } catch (e) {} win.remove(); };
    win.querySelector('[data-win="close"]').addEventListener('click', close);
    win.querySelector('[data-win="max"]').addEventListener('click', () => win.classList.toggle('maximized'));
    win.addEventListener('pointerdown', () => { win.style.zIndex = ++winZ; }, true);
    const bar = win.querySelector('.eco-win-bar');
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || win.classList.contains('maximized')) return;
      const ox = win.offsetLeft, oy = win.offsetTop, sx = e.clientX, sy = e.clientY;
      const mv = (ev) => { win.style.left = (ox + ev.clientX - sx) + 'px'; win.style.top = (oy + ev.clientY - sy) + 'px'; };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
    buildBody(win.querySelector('.eco-win-body'), win);
    return win;
  }
  async function openFileWindow(n) {
    const path = n.data && n.data.path; if (!path) return;
    const ext = (path.split('.').pop() || '').toLowerCase();
    openWindow(n.label || 'File', async (body, win) => {
      const img = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'], cad = ['stl', 'step', 'stp', 'obj', 'glb', 'gltf'], txt = ['txt', 'md', 'js', 'py', 'c', 'cpp', 'h', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'kicad_pcb', 'kicad_sch'];
      try {
        if (img.includes(ext)) { const url = await window.api.files.getFileUrl(path); body.innerHTML = `<div class="eco-win-media"><img class="eco-win-img" src="${url}"></div>`; }
        else if (ext === 'pdf') { const url = await window.api.files.getFileUrl(path); body.innerHTML = `<embed class="eco-win-embed" src="${url}" type="application/pdf">`; }
        else if (cad.includes(ext)) {
          win._cad = true; const host = document.createElement('div'); host.className = 'eco-win-cad'; body.appendChild(host);
          if (ext === 'stl') await window.CadViewer.loadStlFile(host, path);
          else if (ext === 'step' || ext === 'stp') await window.CadViewer.loadStepFile(host, path);
          else if (ext === 'obj') await window.CadViewer.loadObjFile(host, path);
          else { const buf = await window.api.files.readBinary(path); await window.CadViewer.loadGlbFile(host, buf); }
        }
        else if (txt.includes(ext)) { const t = await window.api.files.readText(path); body.innerHTML = `<pre class="eco-win-text">${esc(t.slice(0, 200000))}</pre>`; }
        else body.innerHTML = `<div class="eco-win-fallback">No inline preview for <b>.${esc(ext)}</b>.</div>`;
      } catch (e) { body.innerHTML = `<div class="eco-win-fallback">Couldn't open this file.<br><small>${esc(e && e.message || e)}</small></div>`; }
      const foot = document.createElement('div'); foot.className = 'eco-win-foot';
      foot.innerHTML = `<span class="eco-win-path">${esc(path.replace(/\\/g, '/'))}</span><button class="eco-btn" data-ext>Open in default app</button>`;
      body.appendChild(foot);
      foot.querySelector('[data-ext]').addEventListener('click', () => window.api.openPath(path));
    });
  }
  async function openCadPanel(n) {
    const path = n.data && n.data.path; if (!path) return;
    showPanel(n.label, path.replace(/\\/g, '/'), async (body) => {
      const host = document.createElement('div'); host.className = 'eco-cad-host'; body.appendChild(host);
      const actions = document.createElement('div'); actions.className = 'eco-panel-actions'; actions.innerHTML = `<button class="eco-btn" data-a="open">Open in default app</button>`; body.appendChild(actions);
      actions.querySelector('[data-a="open"]').addEventListener('click', () => window.api.openPath(path));
      const ext = (path.split('.').pop() || '').toLowerCase();
      try {
        if (ext === 'stl') await window.CadViewer.loadStlFile(host, path);
        else if (ext === 'step' || ext === 'stp') await window.CadViewer.loadStepFile(host, path);
        else if (ext === 'obj') await window.CadViewer.loadObjFile(host, path);
        else if (ext === 'glb' || ext === 'gltf') { const buf = await window.api.files.readBinary(path); await window.CadViewer.loadGlbFile(host, buf); }
        else host.innerHTML = `<div class="eco-panel-empty">No inline preview for .${esc(ext)} — use “Open in default app”.</div>`;
      } catch (err) { host.innerHTML = `<div class="eco-panel-empty">Couldn’t render this model.<br><small>${esc(err && err.message || err)}</small></div>`; }
    });
  }
  function openUtilityPanel(n) {
    const d = n.data || {}; const meta = engineeringUtilities.meta ? engineeringUtilities.meta(d.utilityId) : { name: n.label, icon: d.icon };
    showPanel((d.icon || '🔧') + ' ' + (meta.name || n.label), d.boundFolder ? d.boundFolder.replace(/\\/g, '/') : 'No folder bound', (body) => {
      const wrap = document.createElement('div'); wrap.className = 'eco-util-panel';
      wrap.innerHTML = `<p class="eco-util-desc">Launch this utility, optionally scoped to its bound folder.</p><div class="eco-panel-actions"><button class="eco-btn primary" data-a="open">Open ${esc(meta.name || 'utility')}</button>${d.boundFolder ? `<button class="eco-btn" data-a="folder">Open bound folder</button>` : ''}<button class="eco-btn" data-a="bind">${d.boundFolder ? 'Change' : 'Bind'} folder</button></div>`;
      body.appendChild(wrap);
      wrap.querySelector('[data-a="open"]').addEventListener('click', () => { if (window.openEngineeringUtility) window.openEngineeringUtility(d.utilityId); });
      const fb = wrap.querySelector('[data-a="folder"]'); if (fb) fb.addEventListener('click', () => window.api.openPath(d.boundFolder));
      wrap.querySelector('[data-a="bind"]').addEventListener('click', async () => { await bindUtilityFolder(n.id); closePanel(); openUtilityPanel(graph.get(n.id) || n); });
    });
  }
  async function openNotePanel(n) {
    const d = n.data || {};
    showPanel('🗒️ ' + n.label, '', (body) => {
      const ta = document.createElement('textarea'); ta.className = 'eco-note-area'; ta.value = d.body || ''; body.appendChild(ta);
      const act = document.createElement('div'); act.className = 'eco-panel-actions'; act.innerHTML = `<button class="eco-btn primary" data-a="save">Save</button>`; body.appendChild(act);
      act.querySelector('[data-a="save"]').addEventListener('click', () => { n.ref.data = { ...(n.ref.data || {}), body: ta.value }; n.ref.label = (ta.value.split('\n')[0] || 'Note').slice(0, 40); persist(); render(); closePanel(); });
    });
  }
  function openInfoPanel(n) {
    const r = n.ref || {};
    showPanel((KIND[n.kind] || KIND.note).icon + ' ' + n.label, n.kind, (body) => {
      const rows = [];
      if (r.date) rows.push(['Date', r.date]);
      if (r.startTime) rows.push(['Time', (r.startTime || '') + (r.endTime ? '–' + r.endTime : '')]);
      if (r.status) rows.push(['Status', r.status]);
      if (r.cost) rows.push(['Cost', '$' + r.cost]);
      if (r.trackingNumber) rows.push(['Tracking', r.trackingNumber]);
      body.innerHTML = rows.length ? `<table class="eco-info">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : `<div class="eco-panel-empty">No extra details.</div>`;
    });
  }

  // ===================== SUGGESTIONS ENGINE ==============================
  // Reactive, heuristic recommendations grounded in the workflow research:
  // PARA (surface what to act on), WBS (deliverable breakdown), the V-model
  // (design ⇒ verification), Kanban WIP limits, and deadline protection.
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function nextWeekday(wd, from) {
    let d = addDays(from || startOfDay(new Date()), 1);
    if (wd == null || wd < 0) return d;
    for (let i = 0; i < 7; i++) { if (d.getDay() === wd) return d; d = addDays(d, 1); }
    return d;
  }
  // Historical statistics that let the engine anticipate rather than just react:
  // recent velocity (per project + overall), median task cycle time, and the
  // weekday the user actually finishes work on.
  function bustCache() { _insights = null; _suggests = null; }
  // General workspace analytics — everything is derived from the actual data, so it
  // works for any user and degrades gracefully with little history. Cached until data
  // changes (`bustCache`) so per-frame badge updates stay cheap.
  function computeInsights() {
    if (_insights) return _insights;
    const tasks = dataManager.tasks || [], nowMs = Date.now(), DAY = 86400000;
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const done = tasks.filter(t => t.completed && t.completedAt && t.createdAt).map(t => ({ t, cyc: (new Date(t.completedAt) - new Date(t.createdAt)) / DAY })).filter(x => x.cyc >= 0);
    const cyc = done.map(x => x.cyc).sort((a, b) => a - b);
    const globalMedian = med(cyc);
    const recent = done.filter(x => nowMs - new Date(x.t.completedAt).getTime() <= 28 * DAY);
    const velByProj = {}; for (const x of recent) velByProj[x.t.projectId] = (velByProj[x.t.projectId] || 0) + 0.25;
    const wkCount = (lo, hi) => done.filter(x => { const w = (nowMs - new Date(x.t.completedAt)) / DAY; return w >= lo && w < hi; }).length;
    const recent4 = wkCount(0, 28) / 4, prior4 = wkCount(28, 56) / 4;
    const velTrend = recent4 > prior4 * 1.2 ? 'up' : recent4 < prior4 * 0.8 ? 'down' : 'flat';
    const wd = new Array(7).fill(0); for (const x of done) wd[new Date(x.t.completedAt).getDay()]++;
    let topWeekday = null, topN = 0; wd.forEach((c, i) => { if (c > topN) { topN = c; topWeekday = i; } });
    const byGroup = (keyFn) => { const g = {}; for (const x of done) { const k = keyFn(x.t); if (k == null) continue; (g[k] = g[k] || []).push(x.cyc); } const o = {}; for (const k in g) if (g[k].length >= 3) o[k] = { n: g[k].length, median: med(g[k]) }; return o; };
    const byCategory = byGroup(t => t.category || null), byProject = byGroup(t => t.projectId);
    for (const pid in byProject) byProject[pid].open = tasks.filter(t => t.projectId === pid && !t.completed).length;
    let bottleneck = null;
    if (globalMedian) for (const pid in byProject) { const b = byProject[pid]; if (b.open > 0 && b.median > Math.max(globalMedian * 2, globalMedian + 5) && (!bottleneck || b.median > bottleneck.median)) bottleneck = { id: pid, median: b.median, n: b.n }; }
    const slowCategories = globalMedian ? Object.keys(byCategory).filter(c => byCategory[c].median > globalMedian * 1.8) : [];
    const shortCyc = done.filter(x => (x.t.title || '').length < 20).map(x => x.cyc), longCyc = done.filter(x => (x.t.title || '').length >= 20).map(x => x.cyc);
    const titlePenalty = (shortCyc.length >= 5 && longCyc.length >= 5 && med(longCyc) > 0) ? { short: med(shortCyc), long: med(longCyc), ratio: med(shortCyc) / med(longCyc) } : null;
    const kw = {}; for (const x of done) { const seen = new Set(); for (const w of String(x.t.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) { if (w.length < 3 || STOP.has(w) || seen.has(w)) continue; seen.add(w); (kw[w] = kw[w] || []).push(x.cyc); } }
    const kwRows = Object.entries(kw).map(([w, a]) => ({ w, n: a.length, median: med(a) })).filter(r => r.n >= 4);
    const fastKw = [...kwRows].sort((a, b) => a.median - b.median).slice(0, 6), slowKw = [...kwRows].sort((a, b) => b.median - a.median).slice(0, 6);
    const open = tasks.filter(t => !t.completed);
    const aged = open.map(t => ({ t, age: (nowMs - new Date(t.createdAt || t.modifiedAt || nowMs)) / DAY })).sort((a, b) => b.age - a.age);
    const medianAge = med(aged.map(a => a.age));
    const someday = aged.filter(a => medianAge != null && a.age > Math.max(medianAge * 1.8, 45));
    const estimate = (task) => {
      const parts = [];
      if (task.category && byCategory[task.category]) parts.push(byCategory[task.category].median);
      const kws = String(task.title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
      for (const r of kwRows) if (kws.includes(r.w)) parts.push(r.median);
      if ((task.title || '').length < 20 && titlePenalty) parts.push(titlePenalty.short);
      return parts.length ? mean(parts) : globalMedian;
    };
    _insights = {
      n: done.length, globalMedian, median: globalMedian, mean: mean(cyc), p90: cyc.length ? cyc[Math.floor(cyc.length * 0.9)] : null,
      sameDayPct: done.length ? done.filter(x => x.cyc < 1).length / done.length : 0,
      velByProj, velWeek: recent.length / 4, velRecent: recent4, velTrend,
      topWeekday, weekdayShare: done.length ? topN / done.length : 0, weekdayHist: wd, doneCount: done.length,
      byCategory, byProject, bottleneck, slowCategories, titlePenalty, fastKw, slowKw,
      aging: { openCount: open.length, medianAge, oldest: aged.slice(0, 6).map(a => ({ title: a.t.title, age: Math.round(a.age), priority: a.t.priority, ref: a.t })), someday },
      estimate,
    };
    return _insights;
  }

  function computeSuggestions() {
    if (_suggests) return _suggests;
    if (!graph.size) { buildGraph(); }
    const out = [], now = new Date(), t0 = startOfDay(now), dismissed = store.dismissed || {};
    const st = computeInsights(), focusDay = nextWeekday(st.topWeekday);
    const onDay = st.topWeekday != null ? ` (on your most productive day, ${WEEKDAYS[st.topWeekday]})` : '';
    const push = (s) => { if (!dismissed[s.id]) out.push(s); };
    const projects = dataManager.projects || [], tasks = dataManager.tasks || [], evs = dataManager.scheduleItems || [];
    const rank = { high: 0, med: 1, low: 2 };

    for (const p of projects) {
      const pt = tasks.filter(t => t.projectId === p.id);

      // R1 — overdue high-priority goals → protect them with a focus block
      const overdueHigh = pt.filter(t => !t.completed && t.priority === 'High' && t.dueDate && startOfDay(t.dueDate) < t0);
      if (overdueHigh.length) push({
        id: `overdue:${p.id}`, sev: 'high', icon: '⏰',
        title: `${overdueHigh.length} overdue high-priority ${overdueHigh.length > 1 ? 'goals' : 'goal'} in ${p.name}`,
        detail: `e.g. “${trim(overdueHigh[0].title, 46)}”. Block focus time${onDay} so ${overdueHigh.length > 1 ? 'they don’t' : 'it doesn’t'} slip further.`,
        actionLabel: 'Schedule focus block',
        apply: async () => { await dataManager.addScheduleItem({ title: `Focus: ${p.name} overdue goals`, projectId: p.id, date: isoDate(focusDay), day: dayName(focusDay), startTime: '09:00', endTime: '10:30' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
      });

      // R2 — imminent deadline with no time blocked (Motion-style protection)
      for (const t of pt) {
        if (t.completed || !t.dueDate) continue;
        const dd = daysBetween(t0, startOfDay(t.dueDate));
        if (dd < 0 || dd > 3) continue;
        if (evs.some(e => e.projectId === p.id && e.date === isoDate(t.dueDate))) continue;
        push({
          id: `deadline:${t.id}`, sev: dd <= 1 ? 'high' : 'med', icon: '📌',
          title: `“${trim(t.title, 40)}” is due ${dd === 0 ? 'today' : dd === 1 ? 'tomorrow' : 'in ' + dd + ' days'}`,
          detail: `No time is blocked for it. Add a work session on ${isoDate(t.dueDate)}?`,
          actionLabel: 'Block time',
          apply: async () => { await dataManager.addScheduleItem({ title: `Work: ${t.title}`, projectId: p.id, date: isoDate(t.dueDate), day: dayName(t.dueDate), startTime: '13:00', endTime: '14:00' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
        });
      }

      // R3 — Kanban WIP overload
      const wip = pt.filter(t => t.status === 'inProgress');
      if (wip.length > 5) push({
        id: `wip:${p.id}`, sev: 'med', icon: '🚦',
        title: `${wip.length} tasks in progress in ${p.name}`,
        detail: `Flow degrades past ~5 concurrent items. Move the ${wip.length - 5} stalest back to backlog to refocus.`,
        actionLabel: `Trim to 5`,
        apply: async () => { const extra = wip.slice().sort((a, b) => new Date(a.modifiedAt || 0) - new Date(b.modifiedAt || 0)).slice(0, wip.length - 5); for (const t of extra) await dataManager.updateTaskStatus(t.id, 'backlog'); window.dispatchEvent(new CustomEvent('tasks-changed')); },
      });

      // R4 — V-model phase gap: design work but nothing testing it
      const txt = pt.map(t => ((t.title || '') + ' ' + (t.description || '')).toLowerCase());
      const hasDesign = txt.some(s => /design|cad|model|schematic|layout|draft|prototype/.test(s)) || (store.nodes || []).some(n => n.kind === 'cad' && ownerProject(n.parentId) === p.id);
      const hasTest = txt.some(s => /test|verif|validat|\bqa\b|inspect|dfmea|characteri/.test(s)) || (p.categories || []).includes('testing');
      if (hasDesign && !hasTest) push({
        id: `phasegap:${p.id}`, sev: 'med', icon: '🧪',
        title: `${p.name} has design work but no testing`,
        detail: `In the V-model every design step has a matching verification. Add a Testing branch to plan it.`,
        actionLabel: 'Add Testing branch',
        apply: () => { const b = newUserNode('proj:' + p.id, 'branch', { label: 'Testing' }); store.expanded['proj:' + p.id] = true; window.dispatchEvent(new CustomEvent('ecosystem-changed')); render(); },
      });

      // R5 — utility hookups from attached assets
      const own = (store.nodes || []).filter(n => ownerProject(n.parentId) === p.id || n.parentId === 'proj:' + p.id);
      const exts = own.filter(n => n.data && n.data.path).map(n => (n.data.path.split('.').pop() || '').toLowerCase());
      const hasUtil = (uid) => own.some(n => n.kind === 'utility' && n.data && n.data.utilityId === uid);
      if (exts.some(e => ['stl', 'step', 'stp', '3mf', 'obj'].includes(e)) && !hasUtil('slicer')) push({
        id: `util-slicer:${p.id}`, sev: 'low', icon: '⚙️', title: `Wire the Slicer into ${p.name}`,
        detail: `You have 3D models attached here — add the Slicer utility to go straight from model to print.`,
        actionLabel: 'Add Slicer node', apply: () => { newUserNode('proj:' + p.id, 'utility', { label: 'Slicer', data: { utilityId: 'slicer', icon: '⚙️' } }); store.expanded['proj:' + p.id] = true; window.dispatchEvent(new CustomEvent('ecosystem-changed')); render(); },
      });
      if (exts.some(e => e.startsWith('kicad')) && !hasUtil('kicad-importer')) push({
        id: `util-kicad:${p.id}`, sev: 'low', icon: '🔌', title: `Add the KiCad importer to ${p.name}`,
        detail: `There are KiCad files here — attach the KiCad importer utility to manage the library.`,
        actionLabel: 'Add KiCad node', apply: () => { newUserNode('proj:' + p.id, 'utility', { label: 'KiCad Importer', data: { utilityId: 'kicad-importer', icon: '🔌' } }); store.expanded['proj:' + p.id] = true; window.dispatchEvent(new CustomEvent('ecosystem-changed')); render(); },
      });

      // R6 — stale project (nudge back into motion)
      if (pt.length) {
        const last = Math.max(...pt.map(t => new Date(t.modifiedAt || t.createdAt || 0).getTime()));
        const stale = daysBetween(new Date(last), now);
        if (stale >= 21) push({
          id: `stale:${p.id}:${Math.floor(last / 86400000)}`, sev: 'low', icon: '🕸️',
          title: `${p.name} untouched for ${stale} days`,
          detail: `Schedule a short review to keep momentum, or archive it if it’s done.`,
          actionLabel: 'Schedule review',
          apply: async () => { await dataManager.addScheduleItem({ title: `Review: ${p.name}`, projectId: p.id, date: isoDate(addDays(t0, 1)), day: dayName(addDays(t0, 1)), startTime: '16:00', endTime: '16:30' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
        });
      }

      // R7 — WBS breakdown: a project with lots of uncategorized notes
      const uncat = pt.filter(t => !t.category || !(p.categories || []).includes(t.category));
      if (uncat.length >= 14) {
        const kw = topKeywords(uncat.map(t => t.title));
        if (kw.length) push({
          id: `wbs:${p.id}`, sev: 'low', icon: '🧭',
          title: `Break ${p.name} into sub-deliverables`,
          detail: `${uncat.length} loose notes here. Recurring themes suggest grouping into: ${kw.map(k => '“' + k + '”').join(', ')}.`,
          actionLabel: 'Create sub-branches',
          apply: () => { for (const k of kw) newUserNode('proj:' + p.id, 'branch', { label: cap(k) }); store.expanded['proj:' + p.id] = true; window.dispatchEvent(new CustomEvent('ecosystem-changed')); render(); },
        });
      }

      // --- statistical / predictive ---
      const openTasks = pt.filter(t => !t.completed);
      // S1 — velocity forecast: project the finish line from recent pace
      const v = st.velByProj[p.id] || 0;
      if (openTasks.length >= 4 && v > 0) {
        const weeks = openTasks.length / v;
        if (weeks >= 3) push({
          id: `forecast:${p.id}`, sev: weeks >= 8 ? 'med' : 'low', icon: '📈',
          title: `${p.name}: ~${weeks.toFixed(1)} weeks left at your current pace`,
          detail: `${openTasks.length} open tasks · finishing ~${v.toFixed(1)}/week lately → on track for about ${isoDate(addDays(t0, Math.round(weeks * 7)))}. A standing focus block would pull that in.`,
          actionLabel: 'Add weekly focus',
          apply: async () => { await dataManager.addScheduleItem({ title: `Focus: ${p.name}`, projectId: p.id, date: isoDate(focusDay), day: dayName(focusDay), startTime: '10:00', endTime: '11:30' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
        });
      }
      // S2 — aging outlier: a task open far longer than your usual cycle time
      if (st.median != null && st.median >= 1) {
        const thresh = Math.max(7, st.median * 2.5);
        const stuck = openTasks.filter(t => (Date.now() - new Date(t.createdAt || 0).getTime()) / 86400000 > thresh).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        if (stuck.length) {
          const t = stuck[0], age = Math.round((Date.now() - new Date(t.createdAt || 0)) / 86400000);
          push({
            id: `stuck:${t.id}`, sev: 'med', icon: '🐌',
            title: `“${trim(t.title, 38)}” has been open ${age} days`,
            detail: `Well past your ~${Math.round(st.median)}-day median cycle time — it may be too big or blocked. Split it or bump its priority.`,
            actionLabel: 'Open task', apply: () => window.dispatchEvent(new CustomEvent('edit-note', { detail: t })),
          });
        }
      }
      // F1 — FUTURE TASKS: the project has reached a phase; scaffold the next one
      const phasesPresent = PHASE_ORDER.filter(k => pt.some(t => phaseBucket(t).key === k));
      if (phasesPresent.length) {
        const lead = phasesPresent[phasesPresent.length - 1];
        const nextKey = PHASE_ORDER[PHASE_ORDER.indexOf(lead) + 1];
        if (nextKey && !phasesPresent.includes(nextKey) && NEXT_TASKS[nextKey]) {
          const titles = NEXT_TASKS[nextKey].filter(tt => !pt.some(t => (t.title || '').toLowerCase().includes(tt.toLowerCase().split(' ').slice(0, 2).join(' '))));
          if (titles.length) push({
            id: `future:${p.id}:${nextKey}`, sev: 'med', icon: '🔮',
            title: `${p.name} looks ready for its ${PHASE_LABEL[nextKey]} phase`,
            detail: `Its work has reached ${PHASE_LABEL[lead]}. Typical next steps: ${titles.join('; ')}.`,
            actionLabel: `Add ${titles.length} starter task${titles.length > 1 ? 's' : ''}`,
            apply: async () => { for (const title of titles) await dataManager.addTask({ title, projectId: p.id, status: 'backlog', priority: 'Medium' }); window.dispatchEvent(new CustomEvent('tasks-changed')); },
          });
        }
      }
      // F2 — INTENTS buried in note text ("need to / should / TODO / follow up …")
      const intents = [];
      for (const t of pt) {
        const m = ((t.description || '') + ' ' + (t.title || '')).match(INTENT_RE);
        if (m) { const phr = cap(m[1].trim().replace(/\s+/g, ' ')); if (phr.length >= 4 && !pt.some(x => (x.title || '').toLowerCase() === phr.toLowerCase())) intents.push(phr); }
      }
      const uniq = [...new Set(intents)].slice(0, 4);
      if (uniq.length) push({
        id: `intent:${p.id}:${uniq.join('|').length}`, sev: 'low', icon: '🧩',
        title: `${uniq.length} follow-up${uniq.length > 1 ? 's' : ''} buried in ${p.name}'s notes`,
        detail: `Your notes say: ${uniq.map(s => '“' + trim(s, 38) + '”').join(', ')}. Turn them into tasks?`,
        actionLabel: 'Create tasks',
        apply: async () => { for (const title of uniq) await dataManager.addTask({ title, projectId: p.id, status: 'backlog', priority: 'Medium' }); window.dispatchEvent(new CustomEvent('tasks-changed')); },
      });
    }
    // S3 — productive cadence: lean into the weekday you actually ship on
    if (st.topWeekday != null && st.doneCount >= 8 && st.weekdayShare >= 0.28) push({
      id: `cadence:${st.topWeekday}`, sev: 'low', icon: '📊',
      title: `You finish most work on ${WEEKDAYS[st.topWeekday]}s`,
      detail: `About ${Math.round(st.weekdayShare * 100)}% of your completions land on ${WEEKDAYS[st.topWeekday]}. Protect a standing deep-work block then to lean into your natural rhythm.`,
      actionLabel: `Block ${WEEKDAYS[st.topWeekday]} focus`,
      apply: async () => { const d = nextWeekday(st.topWeekday); await dataManager.addScheduleItem({ title: 'Deep work', projectId: null, date: isoDate(d), day: dayName(d), startTime: '09:00', endTime: '11:00' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
    });

    // ===== data-driven signals, calibrated to THIS workspace's own history =====
    // D1 — vague/terse titles historically linger
    if (st.titlePenalty && st.titlePenalty.ratio >= 1.8) {
      const vague = (dataManager.tasks || []).filter(t => !t.completed && (t.title || '').length < 20).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      if (vague.length >= 3) push({
        id: `vague:${vague.length}`, sev: 'low', icon: '✂️',
        title: `${vague.length} tasks have short, vague titles`,
        detail: `In your history terse tasks take ~${st.titlePenalty.short.toFixed(0)}d vs ~${st.titlePenalty.long.toFixed(0)}d for specific ones. Sharpening them tends to speed them up — start with “${trim(vague[0].title, 30)}”.`,
        actionLabel: 'Open first', apply: () => window.dispatchEvent(new CustomEvent('edit-note', { detail: vague[0] })),
      });
    }
    // D2 — bottleneck project (its cycle time dwarfs the workspace median)
    if (st.bottleneck) {
      const pj = projects.find(p => p.id === st.bottleneck.id);
      if (pj) push({
        id: `bottleneck:${pj.id}`, sev: 'med', icon: '🐢',
        title: `${pj.name} is your slowest project`,
        detail: `Tasks there take ~${st.bottleneck.median.toFixed(0)}d vs ~${(st.globalMedian || 0).toFixed(0)}d elsewhere, with ${st.byProject[pj.id].open} still open. A dedicated block could unstick it.`,
        actionLabel: 'Block a session', apply: async () => { await dataManager.addScheduleItem({ title: `Unstick: ${pj.name}`, projectId: pj.id, date: isoDate(focusDay), day: dayName(focusDay), startTime: '13:00', endTime: '15:00' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
      });
    }
    // D3 — stale backlog grooming
    if (st.aging.someday.length >= 5) push({
      id: `groom:${st.aging.someday.length}`, sev: 'low', icon: '🧹',
      title: `${st.aging.someday.length} tasks have gone stale`,
      detail: `They've sat well past your ~${Math.round(st.aging.medianAge)}d median (oldest: “${trim(st.aging.oldest[0].title, 32)}”, ${st.aging.oldest[0].age}d). Groom the backlog — finish, defer, or archive.`,
      actionLabel: 'Schedule a groom', apply: async () => { await dataManager.addScheduleItem({ title: 'Backlog grooming', projectId: null, date: isoDate(addDays(t0, 1)), day: dayName(addDays(t0, 1)), startTime: '17:00', endTime: '17:30' }); window.dispatchEvent(new CustomEvent('schedule-changed')); },
    });
    // D4 — deadline vs. lead-time reality check (slow category due sooner than typical)
    for (const t of (dataManager.tasks || [])) {
      if (t.completed || !t.dueDate || !st.slowCategories.includes(t.category)) continue;
      const dd = daysBetween(t0, startOfDay(t.dueDate)), typ = st.byCategory[t.category] ? st.byCategory[t.category].median : null;
      if (typ && dd >= 0 && dd < typ * 0.6) push({
        id: `leadtime:${t.id}`, sev: 'med', icon: '⌛',
        title: `“${trim(t.title, 32)}” may miss its deadline`,
        detail: `Due in ${dd}d, but ${(typeof getCategoryLabel === 'function' ? getCategoryLabel(t.category) : t.category)} tasks historically take ~${typ.toFixed(0)}d. Start now or move the date.`,
        actionLabel: 'Open task', apply: () => window.dispatchEvent(new CustomEvent('edit-note', { detail: t })),
      });
    }
    out.sort((a, b) => rank[a.sev] - rank[b.sev]);
    _suggests = out;
    return out;
  }

  const STOP = new Set('the a an and or of to for in on with your you this that from into new get set fix add make it is are be as at by up we our i my me do done todo task note update finish start create build test use using need needs can will has have had them then than'.split(' '));
  function topKeywords(titles) {
    const freq = new Map();
    for (const t of titles) for (const w of String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
      if (w.length < 4 || STOP.has(w)) continue; freq.set(w, (freq.get(w) || 0) + 1);
    }
    return [...freq.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function openSuggestions() {
    const list = computeSuggestions();
    showPanel('💡 Suggestions', list.length ? `${list.length} ${list.length > 1 ? 'ideas' : 'idea'} from your project state` : '', (body) => {
      if (!list.length) { body.innerHTML = `<div class="eco-panel-empty">Nothing to suggest right now — your tree looks well-tended. 🌱</div>`; return; }
      const wrap = document.createElement('div'); wrap.className = 'eco-suggests'; body.appendChild(wrap);
      for (const s of list) {
        const card = document.createElement('div'); card.className = 'eco-suggest sev-' + s.sev;
        card.innerHTML = `<div class="eco-suggest-ic">${s.icon}</div><div class="eco-suggest-main"><div class="eco-suggest-title">${esc(s.title)}</div><div class="eco-suggest-detail">${esc(s.detail)}</div><div class="eco-suggest-actions"><button class="eco-btn primary" data-a="apply">${esc(s.actionLabel)}</button><button class="eco-btn subtle" data-a="dismiss">Dismiss</button></div></div>`;
        card.querySelector('[data-a="apply"]').addEventListener('click', async () => { card.classList.add('applying'); try { await s.apply(); } catch (e) { console.warn('suggestion apply failed', e); } setTimeout(openSuggestions, 60); });
        card.querySelector('[data-a="dismiss"]').addEventListener('click', () => { store.dismissed[s.id] = true; persist(); _suggests = null; card.remove(); updateSuggestBadge(); });
        wrap.appendChild(card);
      }
    }, true);
  }
  function updateSuggestBadge() {
    if (!toolbarEl) return;
    const btn = toolbarEl.querySelector('[data-a="suggest"]'); if (!btn) return;
    let n = 0; try { n = computeSuggestions().length; } catch (e) {}
    let badge = btn.querySelector('.eco-badge');
    if (n > 0) { if (!badge) { badge = document.createElement('span'); badge.className = 'eco-badge'; btn.appendChild(badge); } badge.textContent = n > 9 ? '9+' : String(n); }
    else if (badge) badge.remove();
  }

  // ===================== INSIGHTS PANEL (general analytics) ===============
  function openInsightsPanel() {
    const s = computeInsights();
    showPanel('📊 Insights', s.n ? `from ${s.n} completed tasks` : '', (body) => {
      if (!s.n) { body.innerHTML = `<div class="eco-panel-empty">Not enough completed tasks yet to find patterns — come back once you've finished a few.</div>`; return; }
      const catName = c => (typeof getCategoryLabel === 'function' ? getCategoryLabel(c) : c);
      const projName = id => ((dataManager.projects || []).find(p => p.id === id) || {}).name || '—';
      const d = n => n == null ? '—' : (n < 10 ? n.toFixed(1) : String(Math.round(n))) + 'd';
      const arrow = s.velTrend === 'up' ? '▲' : s.velTrend === 'down' ? '▼' : '▬';
      let h = `<div class="eco-ins">`;
      h += `<div class="eco-ins-tiles">`
        + `<div class="eco-ins-tile"><div class="eco-ins-num">${d(s.globalMedian)}</div><div class="eco-ins-cap">median cycle</div></div>`
        + `<div class="eco-ins-tile"><div class="eco-ins-num">${Math.round(s.sameDayPct * 100)}%</div><div class="eco-ins-cap">same-day</div></div>`
        + `<div class="eco-ins-tile"><div class="eco-ins-num">${s.velRecent.toFixed(1)} ${arrow}</div><div class="eco-ins-cap">tasks / week</div></div>`
        + `<div class="eco-ins-tile"><div class="eco-ins-num">${s.aging.openCount}</div><div class="eco-ins-cap">open · ${d(s.aging.medianAge)} old</div></div>`
        + `</div>`;
      const maxWd = Math.max(1, ...s.weekdayHist);
      h += `<div class="eco-ins-sec"><div class="eco-ins-h">Weekly rhythm</div><div class="eco-ins-bars">`;
      ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((lb, i) => { const ht = Math.round(s.weekdayHist[i] / maxWd * 48); h += `<div class="eco-ins-bar"><div class="eco-ins-barfill${i === s.topWeekday ? ' top' : ''}" style="height:${ht}px"></div><div class="eco-ins-barlb">${lb}</div></div>`; });
      h += `</div>${s.topWeekday != null ? `<div class="eco-ins-note">You ship most on ${WEEKDAYS[s.topWeekday]}s</div>` : ''}</div>`;
      const catRows = Object.entries(s.byCategory).sort((a, b) => a[1].median - b[1].median);
      if (catRows.length) { h += `<div class="eco-ins-sec"><div class="eco-ins-h">Median cycle by category</div>`; for (const [c, v] of catRows) h += `<div class="eco-ins-row"><span>${esc(catName(c))}</span><span class="eco-ins-val">${d(v.median)} · n${v.n}</span></div>`; h += `</div>`; }
      if (s.bottleneck) h += `<div class="eco-ins-sec"><div class="eco-ins-h">Bottleneck</div><div class="eco-ins-note">🐢 ${esc(projName(s.bottleneck.id))} — ~${d(s.bottleneck.median)} per task (${s.byProject[s.bottleneck.id].open} open)</div></div>`;
      if (s.fastKw.length) h += `<div class="eco-ins-sec"><div class="eco-ins-h">Keywords that predict speed</div><div class="eco-ins-kw"><b>fast</b> ${s.fastKw.map(k => esc(k.w) + ' ' + d(k.median)).join(' · ')}</div><div class="eco-ins-kw"><b>slow</b> ${s.slowKw.map(k => esc(k.w) + ' ' + d(k.median)).join(' · ')}</div></div>`;
      if (s.titlePenalty && s.titlePenalty.ratio >= 1.4) h += `<div class="eco-ins-sec"><div class="eco-ins-note">✂️ Short/vague titles take ~${d(s.titlePenalty.short)} vs ~${d(s.titlePenalty.long)} for specific ones — be specific.</div></div>`;
      h += `<div class="eco-ins-foot">All figures are computed from this workspace's own history.</div></div>`;
      body.innerHTML = h;
    }, true);
  }

  // ===================== FLOATING MENU ===================================
  function showMenu(x, y, items) {
    closeMenu();
    menuEl = document.createElement('div'); menuEl.className = 'eco-menu';
    for (const it of items) {
      if (it.sep) { const s = document.createElement('div'); s.className = 'eco-menu-sep'; menuEl.appendChild(s); continue; }
      const b = document.createElement('button'); b.className = 'eco-menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      b.innerHTML = `<span class="eco-menu-ic">${it.icon || ''}</span>${esc(it.label)}`;
      if (!it.disabled) b.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  // ===================== LIST WIDGET (data popup) ========================
  // Bulk data isn't drawn as branches — a category/bucket node pops a scrollable
  // list of its items on hover, anchored to the node (a child of .eco-root so it
  // doesn't trip the canvas pointerleave).
  const priColor = (p) => p === 'High' ? '#EF4444' : p === 'Medium' ? '#F59E0B' : p === 'Low' ? '#22C55E' : '#94A3B8';
  function listItemDetail(it) {
    const r = it.ref || {}; const parts = [];
    const desc = r.description || r.body || r.notes || '';
    if (desc) parts.push(`<div class="eco-list-desc">${esc(desc)}</div>`);
    const meta = [];
    if (r.priority) meta.push(`<span class="eco-list-tag" style="color:${priColor(r.priority)}">${esc(r.priority)}</span>`);
    if (r.dueDate) meta.push('📅 ' + esc(typeof formatDateShort === 'function' ? formatDateShort(r.dueDate) : r.dueDate));
    if (it.kind === 'event' && r.date) meta.push('📅 ' + esc(r.date) + (r.startTime ? ' ' + esc(r.startTime) : ''));
    if (it.kind === 'purchase') { if (r.cost) meta.push('$' + esc(String(r.cost)) + (r.quantity > 1 ? ` ×${esc(String(r.quantity))}` : '')); if (r.status) meta.push(esc(String(r.status))); if (r.trackingNumber) meta.push('📦 ' + esc(String(r.trackingNumber))); }
    const cl = Array.isArray(r.checklist) ? r.checklist : [];
    if (cl.length) meta.push('☑ ' + cl.filter(c => c.done).length + '/' + cl.length);
    if (meta.length) parts.push(`<div class="eco-list-meta">${meta.join(' · ')}</div>`);
    if (cl.length) parts.push(`<div class="eco-list-checklist">${cl.slice(0, 10).map(c => `<div class="${c.done ? 'done' : ''}">${c.done ? '☑' : '☐'} ${esc(c.text || c.title || c.label || '')}</div>`).join('')}</div>`);
    return parts.length ? `<div class="eco-list-detail">${parts.join('')}</div>` : '';
  }
  function listRowHtml(it, i) {
    const ic = it.kind === 'task' ? `<span class="eco-list-dot" style="background:${priColor(it.priority)}"></span>` : `<span class="eco-list-ic">${(KIND[it.kind] || KIND.note).icon}</span>`;
    const canDone = it.kind === 'task' || it.kind === 'todo';
    const chk = canDone ? `<span class="eco-list-check${it.done ? ' on' : ''}" data-check="${i}" title="Toggle done">${it.done ? '✓' : ''}</span>` : `<span class="eco-list-check ghost"></span>`;
    const detail = listItemDetail(it);
    return `<div class="eco-list-row${it.done ? ' done' : ''}${detail ? ' has-detail' : ''}"><div class="eco-list-top">${chk}<button class="eco-list-open" data-idx="${i}">${ic}<span class="eco-list-label">${esc(it.label)}</span>${it.sub ? `<span class="eco-list-sub">${esc(it.sub)}</span>` : ''}</button></div>${detail}</div>`;
  }
  function openListPopup(id) {
    if (listPopupId === id && listPopup) return;
    closeListPopup();
    const n = graph.get(id); if (!n || !n.items || !n.items.length) return;
    listPopupId = id;
    listPopup = document.createElement('div');
    listPopup.className = 'eco-list';
    const hideDone = dataManager.settings.showCompleted === false;
    const doneCount = n.items.filter(it => it.done).length;
    const shown = hideDone ? n.items.filter(it => !it.done) : n.items;
    const rows = shown.slice(0, 80).map(it => listRowHtml(it, n.items.indexOf(it))).join('');
    const add = addSpecFor(id);
    const toggle = doneCount ? `<button class="eco-list-toggle" data-donetoggle>${hideDone ? `Show ${doneCount} completed` : 'Hide completed'}</button>` : '';
    listPopup.innerHTML = `<div class="eco-list-head"><span class="eco-list-dot" style="background:${n.color}"></span>${esc(n.label)} · ${shown.length}${hideDone && doneCount ? ` / ${n.items.length}` : ''}</div><div class="eco-list-body">${rows}${shown.length > 80 ? `<div class="eco-list-more">+${shown.length - 80} more…</div>` : ''}</div>${toggle}${add ? `<button class="eco-list-add" data-add>＋ ${esc(add.label)}</button>` : ''}`;
    root.appendChild(listPopup);
    listPopup.addEventListener('pointerenter', () => { overPopup = true; });
    listPopup.addEventListener('pointerleave', () => { overPopup = false; });
    listPopup.addEventListener('click', (e) => {
      const cur = graph.get(listPopupId); if (!cur) return;
      if (e.target.closest('[data-donetoggle]')) { dataManager.updateSettings({ showCompleted: dataManager.settings.showCompleted === false }); const pid = listPopupId; closeListPopup(); openListPopup(pid); return; }
      if (e.target.closest('[data-add]')) { const a = addSpecFor(listPopupId); if (a) a.run(); return; }
      const chk = e.target.closest('[data-check]'); if (chk) { const it = cur.items[+chk.dataset.check]; if (it) toggleItemDone(it); return; }
      const row = e.target.closest('[data-idx]'); if (row) { const it = cur.items[+row.dataset.idx]; if (it) openListItem(it); }
    });
    positionPopupNear(id);
    updateTiers();
  }
  // What a data node's inline "+ add" and right-click "Add…" create.
  function addSpecFor(id) {
    const n = graph.get(id); if (!n) return null;
    const pid = ownerProject(id);
    if (n.kind === 'category') { const cid = id.split(':')[2]; return { label: 'Add task', run: () => addRealItem('task', pid, cid) }; }
    if (n.kind === 'bucket') { const key = id.split(':')[2]; if (key === 'schedule') return { label: 'Add event', run: () => addRealItem('event', pid) }; if (key === 'purchases') return { label: 'Add purchase', run: () => addRealItem('purchase', pid) }; if (key === 'todos') return { label: 'Add to-do', run: () => addTodoQuick(pid) }; }
    return null;
  }
  async function toggleItemDone(it) {
    const pid = listPopupId;
    if (it.kind === 'task' && it.ref) await dataManager.updateTaskStatus(it.ref.id, it.ref.completed ? 'backlog' : 'done');
    else if (it.kind === 'todo' && it.ref) await dataManager.toggleTodo(it.ref.id);
    else return;
    window.dispatchEvent(new CustomEvent('tasks-changed'));
    if (pid) { closeListPopup(); openListPopup(pid); }
  }
  // Create REAL app data scoped to a branch — the tree isn't just a viewer.
  function addRealItem(kind, projectId, categoryId) {
    closeListPopup();
    const mm = window.modalManager, pb = window.purchasingBoard;
    if (kind === 'task' && mm) {
      mm.openNoteModal();
      const ps = document.getElementById('note-project'); if (ps && projectId) ps.value = projectId;
      const cs = document.getElementById('note-category'); if (cs && categoryId && !String(categoryId).startsWith('__')) cs.value = categoryId;
    } else if (kind === 'event' && mm) {
      mm.openScheduleModal();
      const ps = document.getElementById('schedule-project'); if (ps && projectId) ps.value = projectId;
    } else if (kind === 'purchase' && pb && pb._openPurchaseModal) {
      pb._openPurchaseModal();
      const ps = document.getElementById('purchase-project'); if (ps && projectId) ps.value = projectId;
    }
  }
  async function addTodoQuick(projectId) {
    closeListPopup();
    const text = await window._showPrompt({ title: '✅ New to-do', placeholder: 'To-do', confirmText: 'Add' });
    if (!text) return;
    await dataManager.addTodo({ projectId, text });
    window.dispatchEvent(new CustomEvent('tasks-changed'));
  }
  function closeListPopup() { const had = !!listPopup; if (listPopup) { listPopup.remove(); listPopup = null; } listPopupId = null; overPopup = false; if (had) updateTiers(); }
  function positionPopupNear(id) {
    if (!listPopup) return;
    const p = posMap.get(id); if (!p) { closeListPopup(); return; }
    const r = root.getBoundingClientRect();
    const sx = p.x * camera.scale + camera.tx, sy = p.y * camera.scale + camera.ty;
    const pw = listPopup.offsetWidth, ph = listPopup.offsetHeight;
    const rootMid = ((posMap.get('root') || { x: 0 }).x) * camera.scale + camera.tx;
    let left = sx >= rootMid ? sx + 100 : sx - pw - 100;
    let top = sy - ph / 2;
    left = Math.max(8, Math.min(left, r.width - pw - 8));
    top = Math.max(58, Math.min(top, r.height - ph - 8));
    listPopup.style.left = left + 'px'; listPopup.style.top = top + 'px';
  }
  function openListItem(it) {
    if (it.kind === 'task' && it.ref) { window.dispatchEvent(new CustomEvent('edit-note', { detail: it.ref })); return; }
    openInfoPanel({ kind: it.kind, label: it.label, ref: it.ref });
  }

  // ===================== CANVAS WIDGETS ==================================
  // First-class objects that live on the canvas and follow it as it pans/zooms:
  // timers, sticky notes, and intelligent suggestion cards that bloom next to the
  // branch they concern. User widgets persist in settings.ecosystem.widgets.
  let widgetsLayer = null, widgetTick = null, widgetDrag = null, _suggestWidgets = [];
  const screenOf = (w) => ({ x: w.x * camera.scale + camera.tx, y: w.y * camera.scale + camera.ty });
  const getWidget = (id) => (store.widgets || []).find(w => w.id === id);
  function newWidget(type, clientX, clientY, data) {
    const w = screenToWorld(clientX, clientY);
    store.widgets.push({ id: 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), type, x: w.x, y: w.y, data: data || {} });
    persist(); renderWidgets();
  }
  function deleteWidget(id) { store.widgets = (store.widgets || []).filter(w => w.id !== id); persist(); renderWidgets(); }
  const fmtClock = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const timerRemaining = (d) => (d.running && d.endTs) ? Math.max(0, (d.endTs - Date.now()) / 1000) : (d.remaining != null ? d.remaining : (d.total || 1500));

  function widgetHtml(w) {
    if (w.type === 'timer') {
      const d = w.data, rem = timerRemaining(d);
      return `<div class="eco-w eco-w-timer${rem <= 0 ? ' fired' : ''}" data-wid="${esc(w.id)}">`
        + `<div class="eco-w-bar" data-drag><span class="eco-w-title" data-w="label">${esc(d.label || 'Timer')}</span><button data-w="del" title="Remove">×</button></div>`
        + `<div class="eco-w-time">${fmtClock(rem)}</div>`
        + `<div class="eco-w-row"><button data-w="toggle">${d.running ? '⏸' : '▶'}</button><button data-w="reset">⟲</button>`
        + `<button data-w="preset" data-min="5">5m</button><button data-w="preset" data-min="15">15m</button><button data-w="preset" data-min="25">25m</button></div></div>`;
    }
    if (w.type === 'note') {
      return `<div class="eco-w eco-w-note" data-wid="${esc(w.id)}">`
        + `<div class="eco-w-bar" data-drag><span class="eco-w-title">Note</span><button data-w="del" title="Remove">×</button></div>`
        + `<textarea class="eco-w-note-ta" data-w="note" placeholder="Jot a thought…">${esc(w.data.text || '')}</textarea></div>`;
    }
    return '';
  }
  const suggestionWidgetHtml = (s) => `<div class="eco-w eco-w-suggest sev-${s.sev}" data-sid="${esc(s.id)}">`
    + `<div class="eco-w-sic">${s.icon || '💡'}</div>`
    + `<div class="eco-w-sbody"><div class="eco-w-stitle">${esc(s.title)}</div><div class="eco-w-sdetail">${esc(s.detail)}</div>`
    + `<div class="eco-w-sact"><button data-w="apply">${esc(s.actionLabel || 'Apply')}</button><button data-w="dismiss">Dismiss</button></div></div></div>`;

  function suggestionTarget(s) {
    const parts = (s.id || '').split(':');
    for (const seg of parts) if (graph.has('proj:' + seg)) return 'proj:' + seg;
    for (const seg of parts) { const t = (dataManager.tasks || []).find(x => x.id === seg); if (t && graph.has('proj:' + t.projectId)) return 'proj:' + t.projectId; }
    return 'root';
  }
  function renderWidgets() {
    if (!widgetsLayer) return;
    let html = (store.widgets || []).map(widgetHtml).join('');
    _suggestWidgets = [];
    if (store.showSuggestWidgets !== false) {
      let list = []; try { list = computeSuggestions(); } catch (e) {}
      _suggestWidgets = list.map(s => ({ s }));
      if (list.length) html += `<div class="eco-suggest-stack"><div class="eco-suggest-head">💡 ${list.length} suggestion${list.length > 1 ? 's' : ''}</div>${list.map(suggestionWidgetHtml).join('')}</div>`;
    }
    // Live printer camera while a tracked print is running.
    if (window.printTracker && printTracker.isPrinting()) {
      html += `<div class="eco-w eco-w-cam" data-cam><div class="eco-w-bar"><span class="eco-w-title">🖨️ Printing…</span><button data-w="prints" title="Print history">📊</button></div>`
        + `<div class="eco-w-cam-view"><img class="eco-w-cam-img" alt=""><div class="eco-w-cam-empty">Camera feed unavailable</div></div></div>`;
    }
    widgetsLayer.innerHTML = html;
    const cimg = widgetsLayer.querySelector('.eco-w-cam-img');
    if (cimg) { cimg.addEventListener('error', () => cimg.closest('.eco-w-cam').classList.add('noimg')); cimg.addEventListener('load', () => cimg.closest('.eco-w-cam').classList.remove('noimg')); cimg.src = printTracker.cameraSnapshotUrl() + Date.now(); }
    positionWidgets();
  }
  function positionWidgets() {
    if (!widgetsLayer) return;
    const r = root.getBoundingClientRect();
    for (const w of (store.widgets || [])) {
      const el = widgetsLayer.querySelector(`.eco-w[data-wid="${cssEsc(w.id)}"]`); if (!el) continue;
      const p = screenOf(w);
      el.style.left = clamp(p.x, 4, r.width - 60) + 'px'; el.style.top = clamp(p.y, 50, r.height - 40) + 'px';
    }
    // suggestion stack is CSS-positioned (fixed, scrollable top-right) — nothing to do here
    // printer camera → fixed bottom-left
    const cam = widgetsLayer.querySelector('.eco-w-cam');
    if (cam) { cam.style.left = '16px'; cam.style.top = (r.height - cam.offsetHeight - 16) + 'px'; }
  }
  function timerToggle(w) { const d = w.data; if (d.running) { d.remaining = timerRemaining(d); d.running = false; d.endTs = null; } else { const rem = timerRemaining(d); if (rem <= 0) return; d.running = true; d.endTs = Date.now() + rem * 1000; } persist(); renderWidgets(); }
  function timerReset(w) { const d = w.data; d.running = false; d.endTs = null; d.remaining = d.total || 1500; persist(); renderWidgets(); }
  function timerSet(w, sec) { const d = w.data; d.total = sec; d.remaining = sec; d.running = false; d.endTs = null; persist(); renderWidgets(); }
  function widgetTickFn() {
    if (!widgetsLayer || !active) return;
    let fired = false;
    for (const w of (store.widgets || [])) {
      if (w.type !== 'timer' || !w.data.running) continue;
      const rem = timerRemaining(w.data);
      const el = widgetsLayer.querySelector(`.eco-w-timer[data-wid="${cssEsc(w.id)}"] .eco-w-time`);
      if (el) el.textContent = fmtClock(rem);
      if (rem <= 0) { w.data.running = false; w.data.remaining = 0; w.data.endTs = null; fired = true; timerBeep(); try { if (window.Notification && Notification.permission === 'granted') new Notification('⏱ Timer done', { body: w.data.label || 'Ecosystem timer finished' }); } catch (e) {} }
    }
    if (fired) { persist(); renderWidgets(); }
    // refresh the printer camera frame
    const cimg = widgetsLayer.querySelector('.eco-w-cam-img');
    if (cimg && window.printTracker) cimg.src = printTracker.cameraSnapshotUrl() + Date.now();
  }
  function timerBeep() { try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(), g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.18; o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 550); } catch (e) {} }
  function bindWidgets() {
    widgetsLayer.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.target.closest('textarea')) return; // let controls click through
      const bar = e.target.closest('[data-drag]'); if (!bar) return;
      const w = getWidget(bar.closest('.eco-w').dataset.wid); if (!w) return;
      widgetDrag = { id: w.id, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y };
      try { widgetsLayer.setPointerCapture(e.pointerId); } catch (err) {}
    });
    widgetsLayer.addEventListener('pointermove', (e) => {
      if (!widgetDrag) return;
      const w = getWidget(widgetDrag.id); if (!w) return;
      w.x = widgetDrag.ox + (e.clientX - widgetDrag.sx) / camera.scale;
      w.y = widgetDrag.oy + (e.clientY - widgetDrag.sy) / camera.scale;
      positionWidgets();
    });
    const end = () => { if (widgetDrag) { persist(); widgetDrag = null; } };
    widgetsLayer.addEventListener('pointerup', end);
    widgetsLayer.addEventListener('pointercancel', end);
    widgetsLayer.addEventListener('input', (e) => { const ta = e.target.closest('[data-w="note"]'); if (!ta) return; const w = getWidget(ta.closest('.eco-w').dataset.wid); if (w) { w.data.text = ta.value; persist(); } });
    widgetsLayer.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-w]'); if (!btn) return;
      const wel = btn.closest('.eco-w'), a = btn.dataset.w;
      if (wel.dataset.sid) {
        const x = _suggestWidgets.find(y => y.s.id === wel.dataset.sid); if (!x) return;
        if (a === 'apply') Promise.resolve(x.s.apply && x.s.apply()).then(() => { bustCache(); renderWidgets(); updateSuggestBadge(); });
        else if (a === 'dismiss') { store.dismissed[wel.dataset.sid] = true; persist(); _suggests = null; renderWidgets(); updateSuggestBadge(); }
        return;
      }
      if (a === 'prints') { if (window.openPrintHistory) window.openPrintHistory(); return; }
      const w = getWidget(wel.dataset.wid); if (!w) return;
      if (a === 'del') deleteWidget(w.id);
      else if (a === 'toggle') timerToggle(w);
      else if (a === 'reset') timerReset(w);
      else if (a === 'preset') timerSet(w, +btn.dataset.min * 60);
      else if (a === 'label') { window._showPrompt({ title: '⏱ Timer name', defaultValue: w.data.label || '', confirmText: 'Save' }).then(v => { if (v != null) { w.data.label = v; persist(); renderWidgets(); } }); }
    });
  }

  // ===================== TOOLBAR / SCAFFOLD ==============================
  function refreshToolbar() {
    if (!toolbarEl) return;
    toolbarEl.innerHTML =
      `<button data-a="suggest" title="Suggestions" class="accent">💡</button>`
      + `<button data-a="insights" title="Insights">📊</button>`
      + `<button data-a="prints" title="Print history">🖨️</button>`
      + `<button data-a="timer" title="Add timer">⏱</button>`
      + `<button data-a="note" title="Add note">🗒️</button>`
      + `<button data-a="fit" title="Fit to view">🎯</button>`
      + `<button data-a="steer" title="Cursor steering ${steerEnabled ? 'on' : 'off'}" class="${steerEnabled ? 'on' : ''}">🧭</button>`
      + `<button data-a="add" title="New project">＋</button>`
      + `<button data-a="data" title="Toggle data leaves">♻</button>`
      + `<button data-a="reset" title="Reset layout">↺</button>`;
    updateSuggestBadge();
  }
  function build() {
    const container = document.getElementById('view-ecosystem');
    container.innerHTML =
      `<div class="eco-root" tabindex="0"><div class="eco-world"><svg class="eco-edges"><g></g></svg><div class="eco-nodes"></div><div class="eco-media"></div></div>`
      + `<div class="eco-widgets"></div>`
      + `<div class="eco-hint">Hover a branch to expand · hover a category for its list · <b>right-click</b> for actions, widgets &amp; tools</div>`
      + `<aside class="eco-panel"></aside></div>`;
    root = container.querySelector('.eco-root');
    world = container.querySelector('.eco-world');
    widgetsLayer = container.querySelector('.eco-widgets');
    edgesSvg = container.querySelector('.eco-edges');
    edgesG = edgesSvg.querySelector('g');
    edgesG.setAttribute('transform', `translate(${OFF},${OFF})`);
    edgesSvg.style.left = -OFF + 'px'; edgesSvg.style.top = -OFF + 'px';
    edgesSvg.setAttribute('width', OFF * 2); edgesSvg.setAttribute('height', OFF * 2);
    nodesLayer = container.querySelector('.eco-nodes');
    mediaLayer = container.querySelector('.eco-media');
    toolbarEl = null; // toolbar removed — actions live in the right-click menu
    hintEl = container.querySelector('.eco-hint');
    panelEl = container.querySelector('.eco-panel');
    bindWidgets();

    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('pointerenter', () => { mouse.inside = true; emptySince = 0; startSteer(); });
    root.addEventListener('pointerleave', () => {
      if (menuEl) return; // a context menu is open → keep the hovered branch expanded
      mouse.inside = false; hoverId = null; updateHoverClass(); emptySince = 0; closeListPopup();
      if (!steerEnabled) { stopSteer(); return; }
      if (focusPath.size) { focusPath = new Set(); expandId = null; render(); } // leaving → back to overview
      camTarget = fitRectFor(visList);
      startSteer(); // keep the loop alive to finish the recenter glide, then it self-stops
    });
    root.addEventListener('dblclick', (e) => { const el = e.target.closest('.eco-node'); if (el && el.dataset.id) openNode(el.dataset.id); });
    root.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]'); if (more) { showMore(graph.get(more.dataset.more).moreParent); return; }
      const add = e.target.closest('.eco-node-add'); if (add) { const el = add.closest('.eco-node'); openAddMenu(el.dataset.id, e.clientX, e.clientY); return; }
      const col = e.target.closest('.eco-collapse'); if (col) { toggleOpen(col.dataset.exp); return; }
    });
    root.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.eco-panel') || e.target.closest('.eco-toolbar') || e.target.closest('.eco-list')) return;
      e.preventDefault();
      const el = e.target.closest('.eco-node');
      if (el && el.dataset.id) openNodeMenu(el.dataset.id, e.clientX, e.clientY); else openBackgroundMenu(e.clientX, e.clientY);
    });
    document.addEventListener('pointerdown', (e) => { if (menuEl && !e.target.closest('.eco-menu')) closeMenu(); }, true);
    document.addEventListener('keydown', (e) => { if (!active) return; if (e.key === 'Escape') { closeMenu(); closePanel(); } });
    ['projects-changed', 'tasks-changed', 'schedule-changed', 'purchases-changed', 'categories-changed', 'ecosystem-changed'].forEach(ev => window.addEventListener(ev, () => { bustCache(); if (active) { render(); renderWidgets(); } }));
    window.addEventListener('prints-changed', () => { if (active) renderWidgets(); });
    built = true;
  }

  function baseName(p) { return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }

  return {
    activate() {
      if (!built) build();
      active = true;
      loadStore();
      refreshToolbar();
      focusPath = new Set(); expandId = null; camTarget = null; // reset transient state on (re)entry
      render();
      renderWidgets();
      if (!widgetTick) widgetTick = setInterval(widgetTickFn, 1000);
      fitToView(true); // always centre the tree when you enter the ecosystem
    },
    deactivate() { active = false; if (!built) return; stopSteer(); closeMenu(); closePanel(); closeListPopup(); if (widgetTick) { clearInterval(widgetTick); widgetTick = null; } },
  };
})();

window.ecosystemView = ecosystemView;
