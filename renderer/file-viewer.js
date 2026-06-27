// File Viewer - multi-tab, multi-pane file browser + embedded viewers
// Features: G-code viewer, editable text w/ syntax highlight, search, git, bookmarks, drag, send-to-printer, file watcher, breadcrumbs, tooltips

const FILE_TYPES = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp', 'ico', 'tiff', 'tif', 'avif'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'],
  gcode: ['gcode', 'gco', 'g'],
  text: ['txt', 'md', 'log', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'dockerignore',
         'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'hpp',
         'cs', 'php', 'swift', 'sh', 'bash', 'bat', 'ps1', 'cmd',
         'html', 'css', 'scss', 'less', 'xml', 'json', 'yaml', 'yml', 'toml',
         'sql', 'r', 'lua', 'dart', 'zig', 'v', 'nim', 'ex', 'exs', 'erl',
         'makefile', 'cmake', 'gradle', 'properties'],
  csv: ['csv', 'tsv'],
  pdf: ['pdf'],
  excel: ['xlsx', 'xls', 'xlsm', 'ods'],
  word: ['docx'],
  pptx: ['pptx', 'ppt'],
  step: ['step', 'stp', 'iges', 'igs'],
  stl: ['stl'],
  obj: ['obj'],
  kicad: ['kicad_sch', 'kicad_pcb', 'kicad_pro'],
  zip: ['zip'],
  archive: ['rar', '7z', 'tar', 'gz', 'bz2']
};

const FILE_ICONS = {
  folder: '\uD83D\uDCC1', image: '\uD83D\uDDBC', video: '\uD83C\uDFAC', audio: '\uD83C\uDFB5',
  gcode: '\u2699', text: '\uD83D\uDCC4', csv: '\uD83D\uDCCA', pdf: '\uD83D\uDCD5', excel: '\uD83D\uDCCA',
  word: '\uD83D\uDCC3', pptx: '\uD83D\uDCCA', zip: '\uD83D\uDCE6', step: '\uD83D\uDD27',
  stl: '\uD83D\uDD27', obj: '\uD83D\uDD27', kicad: '\u26A1', archive: '\uD83D\uDCE6', unknown: '\uD83D\uDCC4'
};

// ============ UTILITY FUNCTIONS ============
let _fvNextId = 1;
function fvId(prefix) { return prefix + '-' + (_fvNextId++); }

function fvGetExt(filename) {
  const lower = filename.toLowerCase();
  for (const ext of ['kicad_sch', 'kicad_pcb', 'kicad_pro']) {
    if (lower.endsWith('.' + ext)) return ext;
  }
  const parts = lower.split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function fvGetFileType(filename) {
  const ext = fvGetExt(filename);
  if (!ext) return 'unknown';
  for (const [type, exts] of Object.entries(FILE_TYPES)) {
    if (exts.includes(ext)) return type;
  }
  return 'unknown';
}

function fvFormatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + ' ' + sizes[i];
}

function fvColLetter(idx) {
  let s = '';
  while (idx >= 0) { s = String.fromCharCode(65 + (idx % 26)) + s; idx = Math.floor(idx / 26) - 1; }
  return s;
}

function fvEsc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fvEscAttr(str) { return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function fvToast(message, type = 'info') {
  const existing = document.querySelector('.fv-toast');
  if (existing) existing.remove();
  const icons = { success: '\u2705', error: '\u274C', info: '\u2139\uFE0F' };
  const toast = document.createElement('div');
  toast.className = `fv-toast ${type}`;
  toast.innerHTML = `<span class="fv-toast-icon">${icons[type] || icons.info}</span><span>${fvEsc(message)}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 3500);
}

// ============ SYNTAX HIGHLIGHTING ============
const SyntaxHL = {
  _rules: {
    js: [
      { re: /(\/\/[^\n]*)/g, cls: 'syn-comment' },
      { re: /(\/\*[\s\S]*?\*\/)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, cls: 'syn-string' },
      { re: /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|of|in|yield)\b/g, cls: 'syn-keyword' },
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[\da-fA-F]+|0b[01]+|0o[0-7]+)\b/g, cls: 'syn-number' },
      { re: /\b(true|false|null|undefined|NaN|Infinity)\b/g, cls: 'syn-builtin' },
    ],
    py: [
      { re: /(#[^\n]*)/g, cls: 'syn-comment' },
      { re: /("""[\s\S]*?"""|'''[\s\S]*?''')/g, cls: 'syn-string' },
      { re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, cls: 'syn-string' },
      { re: /\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|yield|lambda|pass|global|nonlocal|assert|del|in|not|and|or|is)\b/g, cls: 'syn-keyword' },
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[\da-fA-F]+|0b[01]+|0o[0-7]+)\b/g, cls: 'syn-number' },
      { re: /\b(True|False|None|self|print|len|range|list|dict|set|tuple|int|float|str|bool|type|super|input|open|map|filter)\b/g, cls: 'syn-builtin' },
    ],
    html: [
      { re: /(&lt;!--[\s\S]*?--&gt;)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, cls: 'syn-string' },
      { re: /(&lt;\/?)([\w-]+)/g, cls: 'syn-tag', group: 2 },
      { re: /\b([\w-]+)(?==)/g, cls: 'syn-attr' },
    ],
    css: [
      { re: /(\/\*[\s\S]*?\*\/)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, cls: 'syn-string' },
      { re: /\b(\d+\.?\d*(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)\b/g, cls: 'syn-number' },
      { re: /(#[\da-fA-F]{3,8})\b/g, cls: 'syn-number' },
      { re: /(@[\w-]+)/g, cls: 'syn-keyword' },
    ],
    c: [
      { re: /(\/\/[^\n]*)/g, cls: 'syn-comment' },
      { re: /(\/\*[\s\S]*?\*\/)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*")/g, cls: 'syn-string' },
      { re: /\b(auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|#include|#define|#ifdef|#ifndef|#endif|#pragma)\b/g, cls: 'syn-keyword' },
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?[fFlLuU]*|0x[\da-fA-F]+[lLuU]*)\b/g, cls: 'syn-number' },
      { re: /\b(NULL|true|false|stdin|stdout|stderr)\b/g, cls: 'syn-builtin' },
    ],
    json: [
      { re: /("(?:[^"\\]|\\.)*")(?=\s*:)/g, cls: 'syn-property' },
      { re: /("(?:[^"\\]|\\.)*")/g, cls: 'syn-string' },
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/g, cls: 'syn-number' },
      { re: /\b(true|false|null)\b/g, cls: 'syn-builtin' },
    ],
    yaml: [
      { re: /(#[^\n]*)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, cls: 'syn-string' },
      { re: /^(\s*[\w.-]+)(?=\s*:)/gm, cls: 'syn-property' },
      { re: /\b(true|false|null|yes|no)\b/gi, cls: 'syn-builtin' },
      { re: /\b(\d+\.?\d*)\b/g, cls: 'syn-number' },
    ],
    go: [
      { re: /(\/\/[^\n]*)/g, cls: 'syn-comment' },
      { re: /(\/\*[\s\S]*?\*\/)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*"|`[^`]*`)/g, cls: 'syn-string' },
      { re: /\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/g, cls: 'syn-keyword' },
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[\da-fA-F]+)\b/g, cls: 'syn-number' },
      { re: /\b(true|false|nil|iota|append|cap|close|copy|delete|len|make|new|panic|print|println|recover)\b/g, cls: 'syn-builtin' },
    ],
    rs: [
      { re: /(\/\/[^\n]*)/g, cls: 'syn-comment' },
      { re: /(\/\*[\s\S]*?\*\/)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*")/g, cls: 'syn-string' },
      { re: /\b(as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while)\b/g, cls: 'syn-keyword' },
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?(?:_\d+)*(?:f32|f64|i\d+|u\d+|usize|isize)?|0x[\da-fA-F_]+)\b/g, cls: 'syn-number' },
      { re: /\b(true|false|None|Some|Ok|Err|Vec|String|Box|Option|Result|println|print|format|panic|assert)\b/g, cls: 'syn-builtin' },
    ],
    sh: [
      { re: /(#[^\n]*)/g, cls: 'syn-comment' },
      { re: /("(?:[^"\\]|\\.)*"|'[^']*')/g, cls: 'syn-string' },
      { re: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|alias|unset|set|echo|printf|read|shift|exit|break|continue)\b/g, cls: 'syn-keyword' },
      { re: /(\$[\w{]+}?)/g, cls: 'syn-builtin' },
    ],
  },

  _langMap: {
    js: 'js', ts: 'js', jsx: 'js', tsx: 'js',
    py: 'py', rb: 'py',
    html: 'html', htm: 'html', xml: 'html', svg: 'html',
    css: 'css', scss: 'css', less: 'css',
    c: 'c', cpp: 'c', h: 'c', hpp: 'c', cs: 'c', java: 'c', kt: 'c', dart: 'c', php: 'c', swift: 'c',
    json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'yaml',
    go: 'go',
    rs: 'rs', zig: 'rs',
    sh: 'sh', bash: 'sh', bat: 'sh', ps1: 'sh', cmd: 'sh',
  },

  highlight(text, ext) {
    const lang = this._langMap[ext] || null;
    if (!lang || !this._rules[lang]) return fvEsc(text);
    let escaped = fvEsc(text);
    const rules = this._rules[lang];
    // Tokenize: replace matches with placeholders, then restore
    // Use %%HLTOKEN_id%% as placeholder — won't appear in real code
    let tokenId = 0;
    const tokens = [];
    for (const rule of rules) {
      escaped = escaped.replace(rule.re, (...args) => {
        const match = rule.group ? args[rule.group] : args[0];
        const full = args[0];
        const id = tokenId++;
        const placeholder = `%%HLTOKEN_${id}%%`;
        tokens.push({ id, html: `<span class="${rule.cls}">${match}</span>` });
        if (rule.group) return full.replace(match, placeholder);
        return placeholder;
      });
    }
    // Single-pass restore
    escaped = escaped.replace(/%%HLTOKEN_(\d+)%%/g, (_, idStr) => {
      const t = tokens[parseInt(idStr)];
      return t ? t.html : '';
    });
    return escaped;
  },

  getLangLabel(ext) {
    const labels = { js: 'JavaScript', ts: 'TypeScript', py: 'Python', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML', go: 'Go', rs: 'Rust', sh: 'Shell', c: 'C', cpp: 'C++', java: 'Java', cs: 'C#' };
    return labels[ext] || ext.toUpperCase();
  }
};

// ============ G-CODE PARSER ============
const GCodeParser = {
  parse(text) {
    const layers = [];
    let currentLayer = [];
    let x = 0, y = 0, z = 0, e = 0, t = 0;
    let lastZ = -1;
    const TOOL_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B'];

    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.split(';')[0].trim();
      if (!line) continue;

      // Tool change
      if (/^T(\d+)/i.test(line)) {
        t = parseInt(RegExp.$1);
        continue;
      }

      if (!/^G[01]\s/i.test(line)) continue;

      const newX = this._param(line, 'X', x);
      const newY = this._param(line, 'Y', y);
      const newZ = this._param(line, 'Z', z);
      const newE = this._param(line, 'E', e);

      // Layer change
      if (newZ !== lastZ && newZ !== z) {
        if (currentLayer.length > 0) {
          layers.push(currentLayer);
          currentLayer = [];
        }
        lastZ = newZ;
      }

      // Only extrusion moves (E increases)
      if (newE > e && (newX !== x || newY !== y)) {
        currentLayer.push({ x1: x, y1: y, x2: newX, y2: newY, tool: t, color: TOOL_COLORS[t % 4] });
      }

      x = newX; y = newY; z = newZ; e = newE;
    }
    if (currentLayer.length > 0) layers.push(currentLayer);
    return { layers, toolColors: TOOL_COLORS };
  },

  _param(line, letter, fallback) {
    const m = line.match(new RegExp(letter + '([\\d.+-]+)', 'i'));
    return m ? parseFloat(m[1]) : fallback;
  }
};

// ============ VIEWER RENDERER ============
const ViewerRenderer = {
  async showImage(el, filePath) {
    const url = await window.api.files.getFileUrl(filePath);
    el.innerHTML = `<div class="viewer-image-container"><img class="viewer-image" src="${url}" alt="" draggable="false"></div>`;
    const img = el.querySelector('.viewer-image');
    let scale = 1;
    el.querySelector('.viewer-image-container').addEventListener('wheel', (e) => {
      e.preventDefault();
      scale = Math.max(0.1, Math.min(10, scale + (e.deltaY > 0 ? -0.1 : 0.1)));
      img.style.transform = `scale(${scale})`;
    });
  },

  async showVideo(el, filePath) {
    const url = await window.api.files.getFileUrl(filePath);
    el.innerHTML = `<div class="viewer-media-container"><video class="viewer-video" controls autoplay><source src="${url}"></video></div>`;
  },

  async showAudio(el, filePath) {
    const url = await window.api.files.getFileUrl(filePath);
    const name = filePath.split(/[/\\]/).pop();
    el.innerHTML = `<div class="viewer-audio-container"><div class="viewer-audio-icon">\uD83C\uDFB5</div><div class="viewer-audio-name">${fvEsc(name)}</div><audio class="viewer-audio" controls autoplay><source src="${url}"></audio></div>`;
  },

  // Editable text with syntax highlighting, backup and revert
  async showText(el, filePath, ext, pane) {
    const rawContent = await window.api.files.readText(filePath);
    const content = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); // normalize line endings
    // Create backup
    const backupPath = filePath + '.fvbak';
    try { await window.api.files.writeText(backupPath, rawContent); } catch {} // backup preserves original

    const lines = content.split('\n');
    const langLabel = SyntaxHL.getLangLabel(ext);
    const highlighted = SyntaxHL.highlight(content, ext);
    const gutterHtml = lines.map((_, i) => `<span>${i + 1}</span>`).join('');

    el.innerHTML = `<div class="viewer-editor-toolbar">
        <span class="editor-lang">${fvEsc(langLabel)}</span>
        <span class="editor-lines">${lines.length} lines</span>
        <span class="editor-modified hidden">Modified</span>
        <span class="editor-spacer"></span>
        <button class="editor-btn revert-btn" title="Revert to backup">Revert</button>
        <button class="editor-btn save-btn" title="Save (Ctrl+S)">Save</button>
      </div>
      <div class="viewer-editor-scroll">
        <div class="viewer-editor-gutter">${gutterHtml}</div>
        <div class="viewer-editor-code">
          <div class="viewer-editor-highlight">${highlighted}</div>
          <textarea class="viewer-editor-textarea" spellcheck="false"></textarea>
        </div>
      </div>`;

    const scrollWrap = el.querySelector('.viewer-editor-scroll');
    const textarea = el.querySelector('.viewer-editor-textarea');
    textarea.value = content; // Set via JS, not innerHTML — avoids HTML parsing issues
    const highlightEl = el.querySelector('.viewer-editor-highlight');
    const gutterEl = el.querySelector('.viewer-editor-gutter');
    const modBadge = el.querySelector('.editor-modified');
    let originalContent = content;
    let isModified = false;

    const updateHighlight = () => {
      const text = textarea.value;
      highlightEl.innerHTML = SyntaxHL.highlight(text, ext);
      const newLines = text.split('\n');
      gutterEl.innerHTML = newLines.map((_, i) => `<span>${i + 1}</span>`).join('');
      const modified = text !== originalContent;
      if (modified !== isModified) {
        isModified = modified;
        modBadge.classList.toggle('hidden', !modified);
      }
    };

    textarea.addEventListener('input', updateHighlight);
    // Sync gutter scroll with the scroll container
    scrollWrap.addEventListener('scroll', () => {
      gutterEl.style.transform = `translateY(-${scrollWrap.scrollTop}px)`;
    });

    // Ctrl+S save
    textarea.addEventListener('keydown', async (e) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        try {
          await window.api.files.writeText(filePath, textarea.value);
          originalContent = textarea.value;
          isModified = false;
          modBadge.classList.add('hidden');
          fvToast('File saved', 'success');
        } catch (err) { fvToast('Save failed: ' + err.message, 'error'); }
      }
      // Tab inserts spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        updateHighlight();
      }
    });

    // Save button
    el.querySelector('.save-btn').addEventListener('click', async () => {
      try {
        await window.api.files.writeText(filePath, textarea.value);
        originalContent = textarea.value;
        isModified = false;
        modBadge.classList.add('hidden');
        fvToast('File saved', 'success');
      } catch (err) { fvToast('Save failed: ' + err.message, 'error'); }
    });

    // Revert button
    el.querySelector('.revert-btn').addEventListener('click', async () => {
      try {
        const backup = await window.api.files.readText(backupPath);
        textarea.value = backup;
        updateHighlight();
        fvToast('Reverted to backup', 'info');
      } catch { fvToast('No backup available', 'error'); }
    });
  },

  // G-code viewer with canvas rendering
  async showGcode(el, filePath) {
    el.innerHTML = `<div class="gcode-viewer-container">
      <div class="gcode-toolbar">
        <label>Layer:</label>
        <input type="range" class="gcode-layer-slider" min="0" max="0" value="0">
        <span class="gcode-layer-info">Parsing...</span>
      </div>
      <div class="gcode-canvas-wrap"><canvas></canvas></div>
      <div class="gcode-legend"></div>
    </div>`;

    const text = await window.api.files.readText(filePath);
    const { layers, toolColors } = GCodeParser.parse(text);
    if (layers.length === 0) {
      el.querySelector('.gcode-layer-info').textContent = 'No extrusion moves found';
      return;
    }

    const slider = el.querySelector('.gcode-layer-slider');
    const info = el.querySelector('.gcode-layer-info');
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const wrap = el.querySelector('.gcode-canvas-wrap');

    slider.max = layers.length - 1;
    slider.value = layers.length - 1;

    // Find bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const layer of layers) {
      for (const seg of layer) {
        minX = Math.min(minX, seg.x1, seg.x2);
        minY = Math.min(minY, seg.y1, seg.y2);
        maxX = Math.max(maxX, seg.x1, seg.x2);
        maxY = Math.max(maxY, seg.y1, seg.y2);
      }
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    // Legend
    const usedTools = new Set();
    for (const layer of layers) for (const seg of layer) usedTools.add(seg.tool);
    const legendEl = el.querySelector('.gcode-legend');
    legendEl.innerHTML = [...usedTools].sort().map(t =>
      `<span class="gcode-legend-item"><span class="gcode-legend-color" style="background:${toolColors[t % 4]}"></span>T${t}</span>`
    ).join('');

    const draw = () => {
      const layerIdx = parseInt(slider.value);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = w * devicePixelRatio;
      canvas.height = h * devicePixelRatio;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(0, 0, w, h);

      const padding = 20;
      const scaleX = (w - 2 * padding) / rangeX;
      const scaleY = (h - 2 * padding) / rangeY;
      const scale = Math.min(scaleX, scaleY);
      const offX = padding + (w - 2 * padding - rangeX * scale) / 2;
      const offY = padding + (h - 2 * padding - rangeY * scale) / 2;

      const toX = (x) => offX + (x - minX) * scale;
      const toY = (y) => h - (offY + (y - minY) * scale); // flip Y

      // Draw faded previous layers
      for (let li = 0; li <= layerIdx; li++) {
        const alpha = li === layerIdx ? 1 : 0.1;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = li === layerIdx ? 1 : 0.5;
        for (const seg of layers[li]) {
          ctx.strokeStyle = seg.color;
          ctx.beginPath();
          ctx.moveTo(toX(seg.x1), toY(seg.y1));
          ctx.lineTo(toX(seg.x2), toY(seg.y2));
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      info.textContent = `Layer ${layerIdx + 1} / ${layers.length}  (${layers[layerIdx].length} moves)`;
    };

    slider.addEventListener('input', draw);
    // Resize observer
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    draw();
  },

  async showCsv(el, filePath, ext) {
    const content = await window.api.files.readText(filePath);
    const delimiter = ext === 'tsv' ? '\t' : ',';
    let rows;
    if (typeof Papa !== 'undefined') {
      rows = Papa.parse(content, { delimiter: delimiter === '\t' ? '\t' : undefined, skipEmptyLines: true }).data;
    } else {
      rows = content.split('\n').filter(l => l.trim()).map(l => l.split(delimiter));
    }
    if (rows.length === 0) { el.innerHTML = '<div class="viewer-empty">Empty file</div>'; return; }
    const header = rows[0], body = rows.slice(1), maxRows = 1000;
    el.innerHTML = `<div class="viewer-table-container"><div class="viewer-table-header"><span>${rows.length - 1} rows, ${header.length} columns</span>${body.length > maxRows ? `<span class="viewer-table-truncated">Showing first ${maxRows} rows</span>` : ''}</div><div class="viewer-table-scroll"><table class="viewer-table"><thead><tr>${header.map(h => `<th>${fvEsc(h)}</th>`).join('')}</tr></thead><tbody>${body.slice(0, maxRows).map(row => `<tr>${row.map(cell => `<td>${fvEsc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  },

  async showPdf(el, filePath) {
    const url = await window.api.files.getFileUrl(filePath);
    el.innerHTML = `<div class="viewer-pdf-container"><embed class="viewer-pdf" src="${url}" type="application/pdf"></div>`;
  },

  async showExcel(el, filePath) {
    if (typeof XLSX === 'undefined') { el.innerHTML = '<div class="viewer-error"><div class="viewer-error-msg">SheetJS library not loaded</div></div>'; return; }
    const buffer = await window.api.files.readBinary(filePath);
    const workbook = XLSX.read(buffer, { type: 'array' });
    let html = '<div class="viewer-excel-container"><div class="viewer-excel-tabs">';
    workbook.SheetNames.forEach((name, i) => {
      html += `<button class="viewer-excel-tab ${i === 0 ? 'active' : ''}" data-sheet="${i}">${fvEsc(name)}</button>`;
    });
    html += '</div>';
    workbook.SheetNames.forEach((name, i) => {
      const data = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1 });
      const maxRows = 500;
      html += `<div class="viewer-excel-sheet ${i === 0 ? '' : 'hidden'}" data-sheet="${i}">`;
      if (data.length === 0) { html += '<div class="viewer-empty">Empty sheet</div>'; }
      else {
        html += '<div class="viewer-table-scroll"><table class="viewer-table"><thead><tr><th>#</th>';
        const maxCols = Math.max(...data.slice(0, 10).map(r => r.length));
        for (let c = 0; c < maxCols; c++) html += `<th>${fvColLetter(c)}</th>`;
        html += '</tr></thead><tbody>';
        data.slice(0, maxRows).forEach((row, ri) => {
          html += `<tr><td class="viewer-excel-rownum">${ri + 1}</td>`;
          for (let c = 0; c < maxCols; c++) html += `<td>${row[c] != null ? fvEsc(String(row[c])) : ''}</td>`;
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        if (data.length > maxRows) html += `<div class="viewer-table-truncated">Showing first ${maxRows} of ${data.length} rows</div>`;
      }
      html += '</div>';
    });
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll('.viewer-excel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        el.querySelectorAll('.viewer-excel-tab').forEach(t => t.classList.remove('active'));
        el.querySelectorAll('.viewer-excel-sheet').forEach(s => s.classList.add('hidden'));
        tab.classList.add('active');
        el.querySelector(`.viewer-excel-sheet[data-sheet="${tab.dataset.sheet}"]`).classList.remove('hidden');
      });
    });
  },

  async showWord(el, filePath) {
    if (typeof mammoth === 'undefined') { el.innerHTML = '<div class="viewer-error"><div class="viewer-error-msg">Mammoth.js not loaded</div></div>'; return; }
    const buffer = await window.api.files.readBinary(filePath);
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
    el.innerHTML = `<div class="viewer-word-container"><div class="viewer-word-content">${result.value}</div></div>`;
  },

  async showPptx(el, filePath) {
    if (typeof JSZip === 'undefined') { el.innerHTML = '<div class="viewer-error"><div class="viewer-error-msg">JSZip not loaded</div></div>'; return; }
    const buffer = await window.api.files.readBinary(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/slide(\d+)/)[1]) - parseInt(b.match(/slide(\d+)/)[1]));
    if (slideFiles.length === 0) { el.innerHTML = '<div class="viewer-empty">No slides found</div>'; return; }
    const slides = [];
    for (const sf of slideFiles) {
      const xml = await zip.file(sf).async('string');
      const texts = [];
      for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) { if (m[1].trim()) texts.push(m[1]); }
      slides.push({ texts });
    }
    el.innerHTML = `<div class="viewer-pptx-container"><div class="viewer-pptx-header">${slides.length} slide${slides.length !== 1 ? 's' : ''}</div>${slides.map((s, i) => `<div class="viewer-pptx-slide"><div class="viewer-pptx-slide-num">Slide ${i + 1}</div><div class="viewer-pptx-slide-content">${s.texts.length > 0 ? s.texts.map(t => `<p>${fvEsc(t)}</p>`).join('') : '<p class="viewer-pptx-empty">No text content</p>'}</div></div>`).join('')}</div>`;
  },

  async showZip(el, filePath) {
    if (typeof JSZip === 'undefined') { el.innerHTML = '<div class="viewer-error"><div class="viewer-error-msg">JSZip not loaded</div></div>'; return; }
    const buffer = await window.api.files.readBinary(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const entries = [];
    zip.forEach((p, f) => entries.push({ path: p, dir: f.dir, size: f._data ? f._data.uncompressedSize || 0 : 0 }));
    entries.sort((a, b) => { if (a.dir !== b.dir) return a.dir ? -1 : 1; return a.path.localeCompare(b.path); });
    const fileCount = entries.filter(e => !e.dir).length;
    const dirCount = entries.filter(e => e.dir).length;
    const totalSize = entries.filter(e => !e.dir).reduce((s, e) => s + e.size, 0);
    const previewId = fvId('zip-preview');
    let html = `<div class="viewer-zip-layout"><div class="viewer-zip-sidebar"><div class="viewer-zip-header"><span>${fileCount} files, ${dirCount} folders</span><span>${fvFormatSize(totalSize)}</span></div><div class="viewer-zip-list">`;
    for (const entry of entries) {
      if (entry.dir) continue;
      const icon = FILE_ICONS[fvGetFileType(entry.path)] || FILE_ICONS.unknown;
      html += `<div class="viewer-zip-item" data-path="${fvEsc(entry.path)}" title="${fvEsc(entry.path)}"><span class="file-tree-icon">${icon}</span><span class="viewer-zip-name">${fvEsc(entry.path)}</span><span class="file-tree-size">${fvFormatSize(entry.size)}</span></div>`;
    }
    html += `</div></div><div class="viewer-zip-preview" id="${previewId}"><div class="viewer-empty-state"><div class="viewer-empty-icon">\uD83D\uDCE6</div><div class="viewer-empty-text">Click a file to preview</div></div></div></div>`;
    el.innerHTML = html;
    el.querySelectorAll('.viewer-zip-item').forEach(item => {
      item.addEventListener('click', async () => {
        el.querySelectorAll('.viewer-zip-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        await ViewerRenderer._previewZipEntry(el.querySelector(`#${previewId}`), zip, item.dataset.path);
      });
    });
  },

  async _previewZipEntry(previewEl, zip, entryPath) {
    const ext = fvGetExt(entryPath);
    const fileType = fvGetFileType(entryPath);
    const file = zip.file(entryPath);
    if (!file) { previewEl.innerHTML = '<div class="viewer-error"><div class="viewer-error-msg">Not found in archive</div></div>'; return; }
    try {
      switch (fileType) {
        case 'image': {
          const blob = await file.async('blob');
          const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp' };
          const url = URL.createObjectURL(new Blob([blob], { type: mimeMap[ext] || 'image/png' }));
          previewEl.innerHTML = `<div class="viewer-image-container"><img class="viewer-image" src="${url}"></div>`; break;
        }
        case 'text': {
          const content = await file.async('string');
          const lines = content.split('\n');
          const highlighted = SyntaxHL.highlight(content, ext);
          previewEl.innerHTML = `<div class="viewer-text-container"><div class="viewer-text-header"><span class="viewer-text-lang">${ext.toUpperCase()}</span><span class="viewer-text-lines">${lines.length} lines</span></div><div class="viewer-text-body"><div class="viewer-line-nums">${lines.map((_, i) => `<span>${i + 1}</span>`).join('\n')}</div><pre class="viewer-text-content">${highlighted}</pre></div></div>`; break;
        }
        case 'csv': {
          const content = await file.async('string');
          let rows;
          if (typeof Papa !== 'undefined') rows = Papa.parse(content, { skipEmptyLines: true }).data;
          else rows = content.split('\n').filter(l => l.trim()).map(l => l.split(','));
          if (rows.length > 0) {
            const header = rows[0], body = rows.slice(1, 500);
            previewEl.innerHTML = `<div class="viewer-table-container"><div class="viewer-table-scroll"><table class="viewer-table"><thead><tr>${header.map(h => `<th>${fvEsc(h)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${fvEsc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
          } else previewEl.innerHTML = '<div class="viewer-empty">Empty</div>';
          break;
        }
        case 'word': {
          if (typeof mammoth !== 'undefined') {
            const ab = await file.async('arraybuffer');
            const r = await mammoth.convertToHtml({ arrayBuffer: ab });
            previewEl.innerHTML = `<div class="viewer-word-container"><div class="viewer-word-content">${r.value}</div></div>`;
          } else previewEl.innerHTML = '<div class="viewer-error"><div class="viewer-error-msg">Word viewer not available</div></div>';
          break;
        }
        case 'pdf': {
          const blob = await file.async('blob');
          const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
          previewEl.innerHTML = `<div class="viewer-pdf-container"><embed class="viewer-pdf" src="${url}" type="application/pdf"></div>`; break;
        }
        default: {
          const data = await file.async('arraybuffer');
          if (data.byteLength < 500000) {
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
              const lines = text.split('\n');
              previewEl.innerHTML = `<div class="viewer-text-container"><div class="viewer-text-header"><span class="viewer-text-lang">${ext.toUpperCase() || 'FILE'}</span><span class="viewer-text-lines">${lines.length} lines</span></div><div class="viewer-text-body"><div class="viewer-line-nums">${lines.map((_, i) => `<span>${i + 1}</span>`).join('\n')}</div><pre class="viewer-text-content">${fvEsc(text)}</pre></div></div>`;
            } catch { previewEl.innerHTML = `<div class="viewer-error"><div class="viewer-error-icon">\uD83D\uDCC4</div><div class="viewer-error-msg">.${ext || '?'} — binary, no preview (${fvFormatSize(data.byteLength)})</div></div>`; }
          } else previewEl.innerHTML = `<div class="viewer-error"><div class="viewer-error-icon">\uD83D\uDCC4</div><div class="viewer-error-msg">Too large for preview (${fvFormatSize(data.byteLength)})</div></div>`;
        }
      }
    } catch (err) { previewEl.innerHTML = `<div class="viewer-error"><div class="viewer-error-msg">Preview failed: ${fvEsc(err.message)}</div></div>`; }
  },

  async show3d(el, filePath, type) {
    const loaderId = fvId('viewer-3d');
    el.innerHTML = `<div class="viewer-3d-container" id="${loaderId}"><div class="viewer-3d-loading">Loading 3D model...</div></div>`;
    try {
      const container = el.querySelector(`#${loaderId}`);
      container.innerHTML = '';
      if (type === 'step') await window.CadViewer.loadStepFile(container, filePath);
      else if (type === 'stl') await window.CadViewer.loadStlFile(container, filePath);
      else if (type === 'obj') await window.CadViewer.loadObjFile(container, filePath);
      return container;
    } catch (err) {
      el.innerHTML = `<div class="viewer-error"><div class="viewer-error-icon">\uD83D\uDD27</div><div class="viewer-error-msg">Failed to load 3D file</div><div class="viewer-error-detail">${fvEsc(err.message)}</div><button class="btn-viewer-action" onclick="window.api.files.openPath('${fvEscAttr(filePath)}')">Open in Default App</button></div>`;
      return null;
    }
  },

  async showKicad(el, filePath, ext) {
    if (ext === 'kicad_pro') { await ViewerRenderer.showText(el, filePath, 'json'); return null; }
    const isPcb = ext === 'kicad_pcb';
    el.innerHTML = `<div class="viewer-kicad-container"><div class="viewer-3d-loading">${isPcb ? 'Exporting PCB to SVG...' : 'Exporting schematic to SVG...'}</div></div>`;
    try {
      const svgs = await window.api.files.exportKicad(filePath);
      const svgBlobs = svgs.map(svg => {
        const blob = new Blob([svg.content], { type: 'image/svg+xml' });
        return { name: svg.name, url: URL.createObjectURL(blob) };
      });
      let html = '<div class="viewer-kicad-container">';
      if (isPcb) {
        html += `<div class="viewer-kicad-tabs"><button class="viewer-kicad-tab active" data-kicad-view="pcb">PCB</button><button class="viewer-kicad-tab" data-kicad-view="3d">3D Model</button></div>`;
        html += `<div class="viewer-kicad-page" data-kicad-view="pcb"><div class="viewer-kicad-svg"><img src="${svgBlobs[0].url}" draggable="false"></div></div>`;
        html += `<div class="viewer-kicad-page hidden" data-kicad-view="3d"><div class="viewer-3d-wrapper" style="position:absolute;top:0;left:0;right:0;bottom:0;"></div></div>`;
      } else {
        if (svgBlobs.length > 1) {
          html += '<div class="viewer-kicad-tabs">';
          svgBlobs.forEach((svg, i) => { html += `<button class="viewer-kicad-tab ${i === 0 ? 'active' : ''}" data-idx="${i}">${fvEsc(svg.name.replace('.svg', '').replace(/_/g, ' '))}</button>`; });
          html += '</div>';
          svgBlobs.forEach((svg, i) => { html += `<div class="viewer-kicad-page ${i === 0 ? '' : 'hidden'}" data-idx="${i}"><div class="viewer-kicad-svg"><img src="${svg.url}" draggable="false"></div></div>`; });
        } else {
          html += `<div class="viewer-kicad-svg"><img src="${svgBlobs[0].url}" draggable="false"></div>`;
        }
      }
      html += '</div>';
      el.innerHTML = html;

      if (isPcb) {
        let glbLoaded = false;
        el.querySelectorAll('.viewer-kicad-tab').forEach(tab => {
          tab.addEventListener('click', async () => {
            const view = tab.dataset.kicadView;
            el.querySelectorAll('.viewer-kicad-tab').forEach(t => t.classList.remove('active'));
            el.querySelectorAll('.viewer-kicad-page').forEach(p => p.classList.add('hidden'));
            tab.classList.add('active');
            el.querySelector(`.viewer-kicad-page[data-kicad-view="${view}"]`).classList.remove('hidden');
            if (view === '3d' && !glbLoaded) {
              glbLoaded = true;
              const wrapper = el.querySelector('.viewer-3d-wrapper');
              wrapper.innerHTML = '<div class="viewer-3d-loading">Exporting 3D model (15-30s)...</div>';
              try {
                const glb = await window.api.files.exportKicadGlb(filePath);
                wrapper.innerHTML = '';
                await window.CadViewer.loadGlbFile(wrapper, glb);
              } catch (e) { wrapper.innerHTML = `<div class="viewer-error"><div class="viewer-error-msg">3D failed: ${fvEsc(e.message)}</div></div>`; }
            }
          });
        });
      } else {
        el.querySelectorAll('.viewer-kicad-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            el.querySelectorAll('.viewer-kicad-tab').forEach(t => t.classList.remove('active'));
            el.querySelectorAll('.viewer-kicad-page').forEach(p => p.classList.add('hidden'));
            tab.classList.add('active');
            el.querySelector(`.viewer-kicad-page[data-idx="${tab.dataset.idx}"]`).classList.remove('hidden');
          });
        });
      }

      // Zoom/pan on SVGs
      el.querySelectorAll('.viewer-kicad-svg').forEach(container => {
        let scale = 1, panX = 0, panY = 0, isPanning = false, startX, startY;
        const img = container.querySelector('img');
        let baseWidth = 0;
        const onLoad = () => { baseWidth = img.naturalWidth; img.style.width = baseWidth + 'px'; img.style.height = 'auto'; };
        img.addEventListener('load', onLoad);
        if (img.complete && img.naturalWidth) onLoad();
        const apply = () => { if (baseWidth) img.style.width = (baseWidth * scale) + 'px'; img.style.transform = `translate(${panX}px, ${panY}px)`; };
        container.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.max(0.1, Math.min(20, scale * (e.deltaY > 0 ? 0.9 : 1.1))); apply(); });
        container.addEventListener('mousedown', (e) => { if (e.button === 0) { isPanning = true; startX = e.clientX - panX; startY = e.clientY - panY; container.style.cursor = 'grabbing'; e.preventDefault(); } });
        container.addEventListener('mousemove', (e) => { if (isPanning) { panX = e.clientX - startX; panY = e.clientY - startY; apply(); } });
        const stop = () => { isPanning = false; container.style.cursor = 'grab'; };
        container.addEventListener('mouseup', stop);
        container.addEventListener('mouseleave', stop);
        container.style.cursor = 'grab';
      });

      return svgBlobs.map(s => s.url);
    } catch (err) {
      el.innerHTML = `<div class="viewer-error"><div class="viewer-error-icon">\u26A1</div><div class="viewer-error-msg">KiCad Viewer</div><div class="viewer-error-detail">${fvEsc(err.message)}</div><button class="btn-viewer-action" onclick="window.api.files.openPath('${fvEscAttr(filePath)}')">Open in KiCad</button></div>`;
      return null;
    }
  },

  showUnsupported(el, filePath, ext) {
    el.innerHTML = `<div class="viewer-error"><div class="viewer-error-icon">\uD83D\uDCC4</div><div class="viewer-error-msg">.${ext || '?'} files</div><div class="viewer-error-detail">No embedded viewer for this type.</div><button class="btn-viewer-action" onclick="window.api.files.openPath('${fvEscAttr(filePath)}')">Open in Default App</button></div>`;
  },

  showEmpty(el) {
    el.innerHTML = `<div class="viewer-empty-state"><div class="viewer-empty-icon">&#128194;</div><div class="viewer-empty-text">Open a file to preview</div><div class="viewer-empty-formats">Supports: Images, Video, Audio, PDF, G-code, Text/Code (editable), CSV, Excel, Word, PPTX, ZIP, STEP, STL, OBJ, KiCad</div></div>`;
  },

  async renderFile(el, filePath, fileInfo, pane) {
    const name = filePath.split(/[/\\]/).pop();
    const ext = fvGetExt(name);
    const fileType = fvGetFileType(name);
    el.innerHTML = '';
    el.classList.remove('pane-content-editor');
    try {
      switch (fileType) {
        case 'image': await ViewerRenderer.showImage(el, filePath); break;
        case 'video': await ViewerRenderer.showVideo(el, filePath); break;
        case 'audio': await ViewerRenderer.showAudio(el, filePath); break;
        case 'gcode': await ViewerRenderer.showGcode(el, filePath); break;
        case 'text': await ViewerRenderer.showText(el, filePath, ext, pane); break;
        case 'csv': await ViewerRenderer.showCsv(el, filePath, ext); break;
        case 'pdf': await ViewerRenderer.showPdf(el, filePath); break;
        case 'excel': await ViewerRenderer.showExcel(el, filePath); break;
        case 'word': await ViewerRenderer.showWord(el, filePath); break;
        case 'pptx': await ViewerRenderer.showPptx(el, filePath); break;
        case 'zip': await ViewerRenderer.showZip(el, filePath); break;
        case 'step': case 'stl': case 'obj': await ViewerRenderer.show3d(el, filePath, fileType); break;
        case 'kicad': await ViewerRenderer.showKicad(el, filePath, ext); break;
        default: ViewerRenderer.showUnsupported(el, filePath, ext); break;
      }
    } catch (err) {
      el.innerHTML = `<div class="viewer-error"><div class="viewer-error-icon">\u26A0</div><div class="viewer-error-msg">Failed to load file</div><div class="viewer-error-detail">${fvEsc(err.message)}</div><button class="btn-viewer-action" onclick="window.api.files.openPath('${fvEscAttr(filePath)}')">Open in Default App</button></div>`;
    }
  }
};


// ============ PANE (has tab bar + content + breadcrumbs) ============
class FVPane {
  constructor(paneManager) {
    this.pm = paneManager;
    this.id = fvId('pane');
    this.tabs = [];
    this.activeTabId = null;

    // Build DOM
    this.el = document.createElement('div');
    this.el.className = 'pane-container';
    this.el.dataset.paneId = this.id;

    // Tab bar
    this.tabBarEl = document.createElement('div');
    this.tabBarEl.className = 'pane-tab-bar';
    this.tabBarEl.innerHTML = `<div class="pane-tab-list"></div><div class="pane-tab-actions"><button class="pane-action-btn" data-action="split-v" title="Split vertical">\u2503</button><button class="pane-action-btn" data-action="split-h" title="Split horizontal">\u2501</button><button class="pane-action-btn pane-close-btn" data-action="close" title="Close pane">\u2715</button></div>`;
    this.el.appendChild(this.tabBarEl);

    // Per-pane toolbar with breadcrumbs
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'pane-toolbar';
    this.toolbarEl.innerHTML = `<div class="pane-breadcrumbs"></div><div class="pane-toolbar-right"><span class="pane-toolbar-info"></span><button class="pane-toolbar-open hidden">Open in App</button></div>`;
    this.el.appendChild(this.toolbarEl);

    // Content
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'pane-content';
    ViewerRenderer.showEmpty(this.contentEl);
    this.el.appendChild(this.contentEl);

    // Events
    this.el.addEventListener('mousedown', () => this.pm.setActivePane(this.id));

    this.tabBarEl.querySelector('.pane-tab-actions').addEventListener('click', (e) => {
      const btn = e.target.closest('.pane-action-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'split-v') this.pm.splitPane(this.id, 'vertical');
      else if (action === 'split-h') this.pm.splitPane(this.id, 'horizontal');
      else if (action === 'close') this.pm.closePane(this.id);
    });

    this.tabBarEl.querySelector('.pane-tab-list').addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.pane-tab-close');
      if (closeBtn) {
        e.stopPropagation();
        this.closeTab(closeBtn.parentElement.dataset.tabId);
        return;
      }
      const tab = e.target.closest('.pane-tab');
      if (tab) this.activateTab(tab.dataset.tabId);
    });

    // Middle-click to close tab
    this.tabBarEl.querySelector('.pane-tab-list').addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        const tab = e.target.closest('.pane-tab');
        if (tab) { e.preventDefault(); this.closeTab(tab.dataset.tabId); }
      }
    });

    this.toolbarEl.querySelector('.pane-toolbar-open').addEventListener('click', () => {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab) window.api.files.openPath(tab.filePath);
    });

    // Drop target for drag-to-pane
    this.contentEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.contentEl.classList.add('fv-drop-target');
    });
    this.contentEl.addEventListener('dragleave', () => {
      this.contentEl.classList.remove('fv-drop-target');
    });
    this.contentEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.contentEl.classList.remove('fv-drop-target');
      const filePath = e.dataTransfer.getData('text/fv-filepath');
      if (filePath) {
        const name = filePath.split(/[/\\]/).pop();
        this.openFile(filePath, { name }, true);
      }
    });
  }

  openFile(filePath, fileInfo, newTab = false) {
    const name = filePath.split(/[/\\]/).pop();

    // If not new tab and we have an active tab, reuse it
    if (!newTab && this.activeTabId) {
      const tab = this.tabs.find(t => t.id === this.activeTabId);
      if (tab) {
        tab.filePath = filePath;
        tab.fileInfo = fileInfo;
        tab.label = name;
        this._updateTabLabel(tab);
        this._renderActive();
        return;
      }
    }

    // Create new tab
    const tab = { id: fvId('tab'), filePath, fileInfo, label: name };
    this.tabs.push(tab);
    this._addTabEl(tab);
    this.activateTab(tab.id);
  }

  _addTabEl(tab) {
    const tabEl = document.createElement('div');
    tabEl.className = 'pane-tab';
    tabEl.dataset.tabId = tab.id;
    tabEl.innerHTML = `<span class="pane-tab-label" title="${fvEsc(tab.filePath)}">${fvEsc(tab.label)}</span><span class="pane-tab-close">\u2715</span>`;
    this.tabBarEl.querySelector('.pane-tab-list').appendChild(tabEl);
  }

  activateTab(tabId) {
    this.activeTabId = tabId;
    this.tabBarEl.querySelectorAll('.pane-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tabId === tabId);
    });
    this._renderActive();
  }

  closeTab(tabId) {
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);

    const tabEl = this.tabBarEl.querySelector(`.pane-tab[data-tab-id="${tabId}"]`);
    if (tabEl) tabEl.remove();

    if (this.tabs.length === 0) {
      this.activeTabId = null;
      this._updateToolbar(null);
      ViewerRenderer.showEmpty(this.contentEl);
    } else if (this.activeTabId === tabId) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.activateTab(this.tabs[newIdx].id);
    }
  }

  _renderActive() {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab) return;
    this._updateToolbar(tab);
    ViewerRenderer.renderFile(this.contentEl, tab.filePath, tab.fileInfo, this);
  }

  _updateToolbar(tab) {
    const breadcrumbs = this.toolbarEl.querySelector('.pane-breadcrumbs');
    const infoEl = this.toolbarEl.querySelector('.pane-toolbar-info');
    const openBtn = this.toolbarEl.querySelector('.pane-toolbar-open');
    if (tab) {
      // Build breadcrumbs
      const sep = tab.filePath.includes('/') ? '/' : '\\';
      const parts = tab.filePath.split(/[/\\]/);
      let html = '';
      for (let i = 0; i < parts.length; i++) {
        const partial = parts.slice(0, i + 1).join(sep);
        if (i > 0) html += '<span class="pane-breadcrumb-sep">\u203A</span>';
        html += `<span class="pane-breadcrumb" data-path="${fvEsc(partial)}" title="${fvEsc(partial)}">${fvEsc(parts[i])}</span>`;
      }
      breadcrumbs.innerHTML = html;
      // Click breadcrumb to navigate folder
      breadcrumbs.querySelectorAll('.pane-breadcrumb').forEach(bc => {
        bc.addEventListener('click', () => {
          if (fileViewer && bc.dataset.path) {
            // Navigate tree to this folder
            fileViewer.rootDir = bc.dataset.path;
            fileViewer.expandedDirs.clear();
            fileViewer.expandedDirs.add(bc.dataset.path);
            fileViewer.loadTree();
          }
        });
      });
      // Scroll to end
      breadcrumbs.scrollLeft = breadcrumbs.scrollWidth;

      infoEl.textContent = tab.fileInfo ? fvFormatSize(tab.fileInfo.size) : '';
      openBtn.classList.remove('hidden');
    } else {
      breadcrumbs.innerHTML = '<span style="color:#64748B;font-size:11px">No file open</span>';
      infoEl.textContent = '';
      openBtn.classList.add('hidden');
    }
  }

  _updateTabLabel(tab) {
    const tabEl = this.tabBarEl.querySelector(`.pane-tab[data-tab-id="${tab.id}"]`);
    if (tabEl) {
      tabEl.querySelector('.pane-tab-label').textContent = tab.label;
      tabEl.querySelector('.pane-tab-label').title = tab.filePath;
    }
  }
}


// ============ PANE MANAGER (split tree) ============
class PaneManager {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.panes = new Map();
    this.activePaneId = null;

    const pane = new FVPane(this);
    this.panes.set(pane.id, pane);
    this.activePaneId = pane.id;
    pane.el.classList.add('active');

    this.root = { type: 'pane', paneId: pane.id };
    this._rebuild();
  }

  getActivePane() {
    return this.panes.get(this.activePaneId) || this.panes.values().next().value;
  }

  setActivePane(id) {
    if (this.activePaneId === id) return;
    this.panes.forEach(p => p.el.classList.remove('active'));
    this.activePaneId = id;
    const pane = this.panes.get(id);
    if (pane) pane.el.classList.add('active');
  }

  splitPane(paneId, direction) {
    const node = this._findNode(this.root, paneId);
    if (!node) return;

    const newPane = new FVPane(this);
    this.panes.set(newPane.id, newPane);

    const parent = this._findParent(this.root, paneId);
    const splitNode = { type: 'split', dir: direction, children: [{ type: 'pane', paneId }, { type: 'pane', paneId: newPane.id }] };

    if (!parent) {
      this.root = splitNode;
    } else {
      const idx = parent.children.findIndex(c => c.type === 'pane' && c.paneId === paneId);
      if (idx !== -1) parent.children[idx] = splitNode;
    }

    this.setActivePane(newPane.id);
    this._rebuild();
  }

  closePane(paneId) {
    if (this.panes.size <= 1) return;

    const parent = this._findParent(this.root, paneId);
    if (!parent) return;

    const idx = parent.children.findIndex(c => c.type === 'pane' && c.paneId === paneId);
    if (idx === -1) {
      for (let i = 0; i < parent.children.length; i++) {
        if (this._containsPane(parent.children[i], paneId)) {
          const directParent = this._findDirectSplitParent(this.root, paneId);
          if (directParent) {
            const dIdx = directParent.children.findIndex(c => c.type === 'pane' && c.paneId === paneId);
            if (dIdx !== -1) {
              const sibling = directParent.children[1 - dIdx];
              this._replaceSplitWith(directParent, sibling);
            }
          }
          break;
        }
      }
    } else {
      const sibling = parent.children[1 - idx];
      this._replaceSplitWith(parent, sibling);
    }

    this.panes.delete(paneId);
    if (this.activePaneId === paneId) {
      this.activePaneId = this.panes.keys().next().value;
    }
    this.setActivePane(this.activePaneId);
    this._rebuild();
  }

  _replaceSplitWith(splitNode, replacement) {
    const grandParent = this._findParentOfSplit(this.root, splitNode);
    if (!grandParent) {
      this.root = replacement;
    } else {
      const idx = grandParent.children.indexOf(splitNode);
      if (idx !== -1) grandParent.children[idx] = replacement;
    }
  }

  _findParentOfSplit(node, target) {
    if (node.type !== 'split') return null;
    for (const child of node.children) {
      if (child === target) return node;
      if (child.type === 'split') {
        const found = this._findParentOfSplit(child, target);
        if (found) return found;
      }
    }
    return null;
  }

  _findDirectSplitParent(node, paneId) {
    if (node.type !== 'split') return null;
    for (const child of node.children) {
      if (child.type === 'pane' && child.paneId === paneId) return node;
    }
    for (const child of node.children) {
      if (child.type === 'split') {
        const found = this._findDirectSplitParent(child, paneId);
        if (found) return found;
      }
    }
    return null;
  }

  _findNode(node, paneId) {
    if (node.type === 'pane') return node.paneId === paneId ? node : null;
    for (const child of node.children) {
      const found = this._findNode(child, paneId);
      if (found) return found;
    }
    return null;
  }

  _findParent(node, paneId) {
    if (node.type !== 'split') return null;
    for (const child of node.children) {
      if (child.type === 'pane' && child.paneId === paneId) return node;
      if (child.type === 'split') {
        const found = this._findParent(child, paneId);
        if (found) return found;
      }
    }
    return null;
  }

  _containsPane(node, paneId) {
    if (node.type === 'pane') return node.paneId === paneId;
    return node.children.some(c => this._containsPane(c, paneId));
  }

  _rebuild() {
    this.containerEl.innerHTML = '';
    const dom = this._buildDom(this.root);
    this.containerEl.appendChild(dom);
  }

  _buildDom(node) {
    if (node.type === 'pane') {
      const pane = this.panes.get(node.paneId);
      return pane.el;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'pane-split';
    wrapper.dataset.direction = node.dir;

    const child0 = this._buildDom(node.children[0]);
    child0.style.flex = '1 1 50%';
    child0.style.minWidth = '0';
    child0.style.minHeight = '0';
    wrapper.appendChild(child0);

    const handle = document.createElement('div');
    handle.className = 'pane-split-handle';
    handle.dataset.direction = node.dir;
    wrapper.appendChild(handle);

    const child1 = this._buildDom(node.children[1]);
    child1.style.flex = '1 1 50%';
    child1.style.minWidth = '0';
    child1.style.minHeight = '0';
    wrapper.appendChild(child1);

    this._bindSplitResize(handle, child0, child1, node.dir);

    return wrapper;
  }

  _bindSplitResize(handle, el0, el1, direction) {
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      document.body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const parent = handle.parentElement;
      const rect = parent.getBoundingClientRect();
      let ratio;
      if (direction === 'vertical') {
        ratio = (e.clientX - rect.left) / rect.width;
      } else {
        ratio = (e.clientY - rect.top) / rect.height;
      }
      ratio = Math.max(0.1, Math.min(0.9, ratio));
      el0.style.flex = `${ratio} 1 0%`;
      el1.style.flex = `${1 - ratio} 1 0%`;
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }
}


// ============ FILE VIEWER (sidebar + pane manager + all features) ============
class FileViewer {
  constructor() {
    this.rootDir = null;
    this.currentDir = null;
    this.expandedDirs = new Set();
    this.hasKicadCli = false;
    this._filterText = '';
    this.bookmarks = [];
    this.recentFiles = [];
    this.isGitRepo = false;
    this.gitStatus = {};
    this._watchedDir = null;
    this._tooltipEl = null;
    this._tooltipTimer = null;
    this._treeSortMode = 'name';
    this._totalDirSize = 0;
    this._hiddenExts = ['fvbak']; // hide backup files
  }

  async init() {
    window.api.files.hasKicadCli().then(v => { this.hasKicadCli = v; });

    this.treeEl = document.getElementById('file-tree');
    this.browseBtn = document.getElementById('file-viewer-browse');
    this.filterInput = document.getElementById('fv-filter');
    this.fileCountEl = document.getElementById('fv-file-count');

    // Initialize pane manager
    const mainEl = document.querySelector('.file-viewer-main');
    let paneArea = mainEl.querySelector('.pane-area');
    if (!paneArea) {
      paneArea = document.createElement('div');
      paneArea.className = 'pane-area';
      mainEl.appendChild(paneArea);
    }
    this.paneManager = new PaneManager(paneArea);

    this.browseBtn.addEventListener('click', () => this.selectRootFolder());

    this.filterInput.addEventListener('input', () => {
      this._filterText = this.filterInput.value.toLowerCase();
      this._applyFilter();
    });

    // Back/up button
    document.getElementById('fv-btn-back').addEventListener('click', () => {
      if (this.rootDir) {
        const parent = this.rootDir.replace(/[/\\][^/\\]+$/, '');
        if (parent && parent !== this.rootDir) {
          this.rootDir = parent;
          this.expandedDirs.clear();
          this.expandedDirs.add(parent);
          this.loadTree();
          window.api.loadData('settings.json').then(s => { s = s || {}; s.fileViewerRoot = parent; window.api.saveData('settings.json', s); });
        }
      }
    });

    // Batch rename
    this._initBatchRename();

    // Search
    this._initSearch();

    // Bookmarks
    this._initBookmarks();

    // Git
    this._initGit();

    // File watcher
    this._initFileWatcher();

    // Inspector panel
    this._initInspector();

    // Tooltips
    this._initTooltips();

    // Sidebar actions: new file, new folder, collapse, sort
    this._initSidebarActions();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        this._toggleSearch();
      }
    });

    // Sidebar resizer
    const resizer = document.getElementById('file-viewer-resizer');
    const sidebar = document.querySelector('.file-viewer-sidebar');
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => { isResizing = true; resizer.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const layoutRect = document.querySelector('.file-viewer-layout').getBoundingClientRect();
      sidebar.style.width = Math.max(180, Math.min(500, e.clientX - layoutRect.left)) + 'px';
    });
    document.addEventListener('mouseup', () => { if (isResizing) { isResizing = false; resizer.classList.remove('dragging'); document.body.style.cursor = ''; document.body.style.userSelect = ''; } });

    // Close context menu on click
    document.addEventListener('click', () => { const m = document.querySelector('.fv-context-menu'); if (m) m.remove(); });

    // Load last path + settings
    const settings = await window.api.loadData('settings.json');
    if (settings && settings.fileViewerRoot) {
      this.rootDir = settings.fileViewerRoot;
      this.loadTree();
    }
    if (settings && settings.fileViewerBookmarks) {
      this.bookmarks = settings.fileViewerBookmarks;
      this._renderBookmarks();
    }
    if (settings && settings.fileViewerRecent) {
      this.recentFiles = settings.fileViewerRecent;
      this._renderRecent();
    }
    if (settings && settings.fileViewerSort) {
      this._treeSortMode = settings.fileViewerSort;
      const sortSelect = document.getElementById('fv-sort-tree');
      if (sortSelect) sortSelect.value = this._treeSortMode;
    }
  }

  // -------- SIDEBAR ACTIONS --------
  _initSidebarActions() {
    // New file
    document.getElementById('fv-btn-new-file').addEventListener('click', async () => {
      const dir = this.currentDir || this.rootDir;
      if (!dir) { fvToast('Open a folder first', 'error'); return; }
      const name = await window._showPrompt({ title: '📄 New File', placeholder: 'New file name', confirmText: 'Create' });
      if (!name || !name.trim()) return;
      const fullPath = dir + (dir.includes('/') ? '/' : '\\') + name.trim();
      try {
        await window.api.files.writeText(fullPath, '');
        fvToast('Created: ' + name.trim(), 'success');
        await this.loadTree();
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });

    // New folder
    document.getElementById('fv-btn-new-folder').addEventListener('click', async () => {
      const dir = this.currentDir || this.rootDir;
      if (!dir) { fvToast('Open a folder first', 'error'); return; }
      const name = await window._showPrompt({ title: '📁 New Folder', placeholder: 'New folder name', confirmText: 'Create' });
      if (!name || !name.trim()) return;
      const fullPath = dir + (dir.includes('/') ? '/' : '\\') + name.trim();
      try {
        await window.api.files.mkdir(fullPath);
        fvToast('Created: ' + name.trim(), 'success');
        this.expandedDirs.add(fullPath);
        await this.loadTree();
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });

    // Collapse all
    document.getElementById('fv-btn-collapse-all').addEventListener('click', () => {
      if (!this.rootDir) return;
      this.expandedDirs.clear();
      this.expandedDirs.add(this.rootDir);
      this.loadTree();
    });

    // Sort tree
    const sortSelect = document.getElementById('fv-sort-tree');
    sortSelect.addEventListener('change', async () => {
      this._treeSortMode = sortSelect.value;
      await this.loadTree();
      const settings = await window.api.loadData('settings.json') || {};
      settings.fileViewerSort = this._treeSortMode;
      await window.api.saveData('settings.json', settings);
    });
  }

  _sortItems(items) {
    const dirs = items.filter(i => i.isDirectory);
    const files = items.filter(i => !i.isDirectory);
    const sortFn = (a, b) => {
      switch (this._treeSortMode) {
        case 'type': {
          const extA = fvGetExt(a.name), extB = fvGetExt(b.name);
          if (extA !== extB) return extA.localeCompare(extB);
          return a.name.localeCompare(b.name);
        }
        case 'size': return (b.size || 0) - (a.size || 0);
        case 'modified': return (b.modified || '').localeCompare(a.modified || '');
        default: return a.name.localeCompare(b.name);
      }
    };
    dirs.sort((a, b) => a.name.localeCompare(b.name)); // dirs always alpha
    files.sort(sortFn);
    return [...dirs, ...files];
  }

  // -------- RECENT FILES --------
  _trackRecent(filePath) {
    this.recentFiles = this.recentFiles.filter(r => r !== filePath);
    this.recentFiles.unshift(filePath);
    if (this.recentFiles.length > 8) this.recentFiles = this.recentFiles.slice(0, 8);
    this._renderRecent();
    window.api.loadData('settings.json').then(s => {
      s = s || {};
      s.fileViewerRecent = this.recentFiles;
      window.api.saveData('settings.json', s);
    });
  }

  _renderRecent() {
    const container = document.getElementById('fv-recent');
    if (!this.recentFiles || this.recentFiles.length === 0) {
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');
    container.innerHTML = `<div class="fv-recent-title">Recent</div>` +
      this.recentFiles.map(f => {
        const name = f.split(/[/\\]/).pop();
        const icon = FILE_ICONS[fvGetFileType(name)] || FILE_ICONS.unknown;
        return `<div class="fv-recent-item" data-path="${fvEsc(f)}" title="${fvEsc(f)}"><span class="fv-recent-icon">${icon}</span>${fvEsc(name)}</div>`;
      }).join('');

    container.querySelectorAll('.fv-recent-item').forEach(el => {
      el.addEventListener('click', async () => {
        const path = el.dataset.path;
        if (!path) return;
        const name = path.split(/[/\\]/).pop();
        const info = { name };
        try { const s = await window.api.files.stat(path); info.size = s.size; info.modified = s.mtime; } catch {}
        this.paneManager.getActivePane().openFile(path, info, false);
        this.inspectFile(path, info);
      });
    });
  }

  // -------- SEARCH --------
  _initSearch() {
    const searchBtn = document.getElementById('fv-btn-search');
    const panel = document.getElementById('fv-search-panel');
    const input = document.getElementById('fv-search-input');
    const closeBtn = document.getElementById('fv-search-close');
    const resultsEl = document.getElementById('fv-search-results');
    const regexCheck = document.getElementById('fv-search-regex');
    const caseCheck = document.getElementById('fv-search-case');

    searchBtn.addEventListener('click', () => this._toggleSearch());
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

    let searchTimeout;
    input.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this._runSearch(), 400);
    });
    regexCheck.addEventListener('change', () => this._runSearch());
    caseCheck.addEventListener('change', () => this._runSearch());
  }

  _toggleSearch() {
    const panel = document.getElementById('fv-search-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      document.getElementById('fv-search-input').focus();
    }
  }

  async _runSearch() {
    const query = document.getElementById('fv-search-input').value;
    const resultsEl = document.getElementById('fv-search-results');
    if (!query || !this.rootDir) { resultsEl.innerHTML = ''; return; }

    const regex = document.getElementById('fv-search-regex').checked;
    const caseSensitive = document.getElementById('fv-search-case').checked;

    resultsEl.innerHTML = '<div class="fv-search-status">Searching...</div>';

    try {
      const results = await window.api.files.searchContent(this.rootDir, query, { regex, caseSensitive, maxResults: 200 });
      if (!results || results.length === 0) {
        resultsEl.innerHTML = '<div class="fv-search-status">No results found</div>';
        return;
      }

      // Group by file
      const grouped = {};
      for (const r of results) {
        if (!grouped[r.file]) grouped[r.file] = [];
        grouped[r.file].push(r);
      }

      let html = `<div class="fv-search-status">${results.length} match${results.length !== 1 ? 'es' : ''} in ${Object.keys(grouped).length} file${Object.keys(grouped).length !== 1 ? 's' : ''}</div>`;
      for (const [file, matches] of Object.entries(grouped)) {
        const shortName = file.replace(this.rootDir, '').replace(/^[/\\]/, '');
        html += `<div class="fv-search-result-file" data-path="${fvEsc(file)}" title="${fvEsc(file)}">${fvEsc(shortName)}</div>`;
        for (const m of matches.slice(0, 10)) {
          const escapedLine = fvEsc(m.text || '');
          // Highlight match in text
          let highlighted = escapedLine;
          if (query) {
            try {
              const flags = caseSensitive ? 'g' : 'gi';
              const re = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
              highlighted = fvEsc(m.text || '').replace(re, match => `<span class="fv-search-match">${match}</span>`);
            } catch {}
          }
          html += `<div class="fv-search-result-line" data-path="${fvEsc(file)}" data-line="${m.line || 0}"><span class="fv-search-line-num">${m.line || ''}</span><span class="fv-search-line-text">${highlighted}</span></div>`;
        }
        if (matches.length > 10) {
          html += `<div class="fv-search-status" style="padding-left:12px">...${matches.length - 10} more</div>`;
        }
      }
      resultsEl.innerHTML = html;

      // Click handlers
      resultsEl.querySelectorAll('.fv-search-result-file, .fv-search-result-line').forEach(el => {
        el.addEventListener('click', async () => {
          const path = el.dataset.path;
          if (!path) return;
          const name = path.split(/[/\\]/).pop();
          const info = { name };
          try { const s = await window.api.files.stat(path); info.size = s.size; info.modified = s.mtime; } catch {}
          this.paneManager.getActivePane().openFile(path, info, false);
          this.inspectFile(path, info);
        });
      });
    } catch (err) {
      resultsEl.innerHTML = `<div class="fv-search-status" style="color:#F87171">Search error: ${fvEsc(err.message)}</div>`;
    }
  }

  // -------- BOOKMARKS --------
  _initBookmarks() {
    const bookmarkBtn = document.getElementById('fv-btn-bookmark');
    bookmarkBtn.addEventListener('click', () => {
      if (!this.rootDir) return;
      const dir = this.currentDir || this.rootDir;
      if (this.bookmarks.some(b => b.path === dir)) {
        // Remove
        this.bookmarks = this.bookmarks.filter(b => b.path !== dir);
        bookmarkBtn.textContent = '\u2606';
      } else {
        const name = dir.split(/[/\\]/).pop();
        this.bookmarks.push({ path: dir, name });
        bookmarkBtn.textContent = '\u2605';
      }
      this._renderBookmarks();
      this._saveBookmarks();
    });
  }

  _renderBookmarks() {
    const container = document.getElementById('fv-bookmarks');
    if (this.bookmarks.length === 0) {
      container.classList.add('hidden');
      return;
    }
    container.classList.remove('hidden');
    container.innerHTML = `<div class="fv-bookmarks-title">Bookmarks</div>` +
      this.bookmarks.map((b, i) =>
        `<div class="fv-bookmark-item" data-idx="${i}" data-path="${fvEsc(b.path)}" title="${fvEsc(b.path)}"><span class="fv-bookmark-icon">\uD83D\uDCC1</span><span class="fv-bookmark-name">${fvEsc(b.name)}</span><span class="fv-bookmark-remove" data-idx="${i}">\u2715</span></div>`
      ).join('');

    container.querySelectorAll('.fv-bookmark-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('fv-bookmark-remove')) {
          const idx = parseInt(e.target.dataset.idx);
          this.bookmarks.splice(idx, 1);
          this._renderBookmarks();
          this._saveBookmarks();
          return;
        }
        const path = el.dataset.path;
        if (path) {
          this.rootDir = path;
          this.expandedDirs.clear();
          this.expandedDirs.add(path);
          this.loadTree();
          window.api.loadData('settings.json').then(s => { s = s || {}; s.fileViewerRoot = path; window.api.saveData('settings.json', s); });
        }
      });
    });
  }

  async _saveBookmarks() {
    const settings = await window.api.loadData('settings.json') || {};
    settings.fileViewerBookmarks = this.bookmarks;
    await window.api.saveData('settings.json', settings);
  }

  // -------- GIT --------
  _initGit() {
    const commitBtn = document.getElementById('fv-btn-git-commit');
    const commitPanel = document.getElementById('fv-commit-panel');
    const commitCloseBtn = document.getElementById('fv-commit-close');
    const commitApplyBtn = document.getElementById('fv-commit-apply');
    const commitMsg = document.getElementById('fv-commit-msg');

    commitBtn.addEventListener('click', async () => {
      commitPanel.classList.toggle('hidden');
      if (!commitPanel.classList.contains('hidden')) {
        await this._refreshGitCommitPanel();
      }
    });
    commitCloseBtn.addEventListener('click', () => commitPanel.classList.add('hidden'));

    commitMsg.addEventListener('input', () => {
      commitApplyBtn.disabled = !commitMsg.value.trim();
    });

    commitApplyBtn.addEventListener('click', async () => {
      const msg = commitMsg.value.trim();
      if (!msg || !this.rootDir) return;
      commitApplyBtn.disabled = true;
      commitApplyBtn.textContent = 'Committing...';
      try {
        await window.api.git.commit(this.rootDir, msg);
        fvToast('Committed successfully', 'success');
        commitMsg.value = '';
        await this._refreshGitCommitPanel();
        await this._refreshGitStatus();
      } catch (err) {
        fvToast('Commit failed: ' + err.message, 'error');
      }
      commitApplyBtn.disabled = false;
      commitApplyBtn.textContent = 'Commit';
    });
  }

  async _checkGitRepo() {
    if (!this.rootDir) return;
    try {
      this.isGitRepo = await window.api.git.isRepo(this.rootDir);
    } catch { this.isGitRepo = false; }

    const branchEl = document.getElementById('fv-git-branch');
    const commitBtn = document.getElementById('fv-btn-git-commit');

    if (this.isGitRepo) {
      branchEl.classList.remove('hidden');
      commitBtn.classList.remove('hidden');
      await this._refreshGitStatus();
    } else {
      branchEl.classList.add('hidden');
      commitBtn.classList.add('hidden');
      branchEl.textContent = '';
    }
  }

  async _refreshGitStatus() {
    if (!this.isGitRepo || !this.rootDir) return;
    try {
      const status = await window.api.git.status(this.rootDir);
      const branchEl = document.getElementById('fv-git-branch');
      if (status.branch) branchEl.textContent = '\u2387 ' + status.branch;

      // Build status map: relative path -> status char
      this.gitStatus = {};
      if (status.files) {
        for (const f of status.files) {
          this.gitStatus[f.path] = f.status;
        }
      }

      // Update badges on visible tree items
      this._applyGitBadges();
    } catch {}
  }

  _applyGitBadges() {
    if (!this.rootDir) return;
    this.treeEl.querySelectorAll('.file-tree-item').forEach(row => {
      // Remove existing badge
      const existingBadge = row.querySelector('.fv-git-badge');
      if (existingBadge) existingBadge.remove();

      const fullPath = row.dataset.path;
      if (!fullPath) return;
      const relPath = fullPath.replace(this.rootDir, '').replace(/^[/\\]/, '').replace(/\\/g, '/');

      // Check if any git status matches
      let status = this.gitStatus[relPath];
      if (!status) {
        // Check for directory: any file inside has changes?
        for (const [gp, gs] of Object.entries(this.gitStatus)) {
          if (gp.startsWith(relPath + '/')) { status = gs; break; }
        }
      }
      if (!status) return;

      const badge = document.createElement('span');
      badge.className = 'fv-git-badge';
      if (status === 'M' || status === 'MM' || status === 'AM') { badge.classList.add('modified'); badge.textContent = 'M'; }
      else if (status === 'A' || status === 'A ') { badge.classList.add('added'); badge.textContent = 'A'; }
      else if (status === 'D' || status === 'D ') { badge.classList.add('deleted'); badge.textContent = 'D'; }
      else if (status === '??' || status === '?') { badge.classList.add('untracked'); badge.textContent = '?'; }
      else { badge.classList.add('modified'); badge.textContent = status.charAt(0); }
      row.appendChild(badge);
    });
  }

  async _refreshGitCommitPanel() {
    if (!this.isGitRepo || !this.rootDir) return;
    const stagedEl = document.getElementById('fv-commit-staged');
    try {
      const status = await window.api.git.status(this.rootDir);
      if (!status.files || status.files.length === 0) {
        stagedEl.innerHTML = '<div style="color:#64748B;font-size:11px">No changes</div>';
        return;
      }
      stagedEl.innerHTML = status.files.map(f => {
        const statusChar = (f.status || '?').charAt(0);
        const statusClass = { M: 'M', A: 'A', D: 'D', '?': 'U' }[statusChar] || 'M';
        return `<div class="fv-commit-staged-file" data-path="${fvEsc(f.path)}"><span class="fv-commit-staged-status ${statusClass}">${statusChar}</span><span class="fv-commit-staged-name">${fvEsc(f.path)}</span></div>`;
      }).join('');

      // Click to stage/unstage
      stagedEl.querySelectorAll('.fv-commit-staged-file').forEach(el => {
        el.addEventListener('click', async () => {
          const filePath = el.dataset.path;
          try {
            const fullPath = this.rootDir + '/' + filePath;
            await window.api.git.stage(fullPath);
            fvToast('Staged: ' + filePath, 'info');
            await this._refreshGitCommitPanel();
          } catch (err) { fvToast('Stage failed', 'error'); }
        });
      });
    } catch (err) {
      stagedEl.innerHTML = `<div style="color:#F87171;font-size:11px">${fvEsc(err.message)}</div>`;
    }
  }

  // -------- FILE WATCHER --------
  _initFileWatcher() {
    this._watchDebounce = null;
    window.api.files.onFileChange((dir) => {
      if (this.rootDir && dir === this._watchedDir) {
        // Debounce to avoid rapid rebuilds while user is interacting
        clearTimeout(this._watchDebounce);
        this._watchDebounce = setTimeout(() => {
          this.loadTree();
        }, 1500);
      }
    });
  }

  async _startWatch() {
    if (this._watchedDir) {
      try { await window.api.files.unwatch(this._watchedDir); } catch {}
    }
    if (this.rootDir) {
      this._watchedDir = this.rootDir;
      try { await window.api.files.watch(this.rootDir); } catch {}
    }
  }

  // -------- TOOLTIPS --------
  _initTooltips() {
    this._tooltipEl = document.createElement('div');
    this._tooltipEl.className = 'fv-tooltip hidden';
    document.body.appendChild(this._tooltipEl);

    if (this.treeEl) {
      this.treeEl.addEventListener('mouseover', (e) => {
        const row = e.target.closest('.file-tree-item');
        if (!row || row.querySelector('.file-tree-arrow:not([style*="hidden"])')) return;
        clearTimeout(this._tooltipTimer);
        this._tooltipTimer = setTimeout(() => this._showTooltip(row), 600);
      });
      this.treeEl.addEventListener('mouseout', () => {
        clearTimeout(this._tooltipTimer);
        this._tooltipEl.classList.add('hidden');
      });
    }
  }

  async _showTooltip(row) {
    const filePath = row.dataset.path;
    if (!filePath) return;
    const fileType = fvGetFileType(filePath.split(/[/\\]/).pop());

    try {
      if (fileType === 'image') {
        const url = await window.api.files.getFileUrl(filePath);
        this._tooltipEl.innerHTML = `<img src="${url}">`;
      } else if (fileType === 'text' || fileType === 'gcode') {
        const head = await window.api.files.readHead(filePath, 500);
        this._tooltipEl.innerHTML = `<div class="fv-tooltip-text">${fvEsc(head)}</div>`;
      } else {
        return; // No tooltip for other types
      }

      const rect = row.getBoundingClientRect();
      this._tooltipEl.style.left = (rect.right + 8) + 'px';
      this._tooltipEl.style.top = rect.top + 'px';
      this._tooltipEl.classList.remove('hidden');

      // Reposition if off screen
      requestAnimationFrame(() => {
        const tipRect = this._tooltipEl.getBoundingClientRect();
        if (tipRect.right > window.innerWidth) this._tooltipEl.style.left = (rect.left - tipRect.width - 8) + 'px';
        if (tipRect.bottom > window.innerHeight) this._tooltipEl.style.top = Math.max(8, window.innerHeight - tipRect.height - 8) + 'px';
      });
    } catch {}
  }

  // -------- INSPECTOR PANEL --------
  _initInspector() {
    const inspector = document.getElementById('fv-inspector');
    // Tab switching
    const tabs = inspector.querySelectorAll('.fv-inspector-tab');
    const bodies = inspector.querySelectorAll('.fv-inspector-body');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        bodies.forEach(b => b.classList.add('hidden'));
        tab.classList.add('active');
        inspector.querySelector(`.fv-inspector-body[data-tab="${tab.dataset.tab}"]`).classList.remove('hidden');
      });
    });

    // Show inspector when hovering sidebar or inspector itself
    const sidebar = document.querySelector('.file-viewer-sidebar');
    const hideDelay = 300;
    let hideTimer = null;
    const show = () => { clearTimeout(hideTimer); inspector.classList.add('pinned'); };
    const scheduleHide = () => { hideTimer = setTimeout(() => inspector.classList.remove('pinned'), hideDelay); };
    sidebar.addEventListener('mouseenter', show);
    sidebar.addEventListener('mouseleave', scheduleHide);
    inspector.addEventListener('mouseenter', show);
    inspector.addEventListener('mouseleave', scheduleHide);
  }

  async inspectFile(filePath, fileInfo) {
    if (!filePath) return;
    const name = filePath.split(/[/\\]/).pop();
    const ext = fvGetExt(name);
    const fileType = fvGetFileType(name);
    const size = fileInfo ? fileInfo.size : 0;
    const modified = fileInfo ? fileInfo.modified : null;

    // ---- DETAILS TAB ----
    const detailsEl = document.getElementById('fv-inspect-details');
    let dHtml = '';

    // File info section
    dHtml += `<div class="fv-detail-section">
      <div class="fv-detail-section-title">File Info</div>
      <div class="fv-detail-row"><span class="fv-detail-label">Name</span><span class="fv-detail-value">${fvEsc(name)}</span></div>
      <div class="fv-detail-row"><span class="fv-detail-label">Type</span><span class="fv-detail-value">${fvEsc(ext.toUpperCase() || 'Unknown')} (${fvEsc(fileType)})</span></div>
      <div class="fv-detail-row"><span class="fv-detail-label">Size</span><span class="fv-detail-value">${fvFormatSize(size)}</span></div>`;
    if (modified) {
      const d = new Date(modified);
      dHtml += `<div class="fv-detail-row"><span class="fv-detail-label">Modified</span><span class="fv-detail-value">${d.toLocaleDateString()} ${d.toLocaleTimeString()}</span></div>`;
    }
    dHtml += `<div class="fv-detail-row"><span class="fv-detail-label">Path</span></div><div class="fv-detail-value path-val">${fvEsc(filePath)}</div>`;
    dHtml += `</div>`;

    // Image preview + dimensions
    if (fileType === 'image') {
      try {
        const url = await window.api.files.getFileUrl(filePath);
        dHtml += `<div class="fv-detail-section">
          <div class="fv-detail-section-title">Preview</div>
          <img class="fv-detail-preview" src="${url}" id="fv-inspect-img">
        </div>`;
        // Dimensions calculated after render
      } catch {}
    }

    // Code file stats
    if (fileType === 'text' || fileType === 'gcode') {
      try {
        const content = await window.api.files.readText(filePath);
        const lines = content.split('\n');
        const words = content.split(/\s+/).filter(w => w).length;
        const chars = content.length;
        const blankLines = lines.filter(l => !l.trim()).length;
        const commentLines = lines.filter(l => {
          const t = l.trim();
          return t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*') || t.startsWith(';');
        }).length;

        dHtml += `<div class="fv-detail-section">
          <div class="fv-detail-section-title">Content Stats</div>
          <div class="fv-detail-row"><span class="fv-detail-label">Lines</span><span class="fv-detail-value">${lines.length.toLocaleString()}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Words</span><span class="fv-detail-value">${words.toLocaleString()}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Characters</span><span class="fv-detail-value">${chars.toLocaleString()}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Blank lines</span><span class="fv-detail-value">${blankLines}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Comment lines</span><span class="fv-detail-value">${commentLines}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Code lines</span><span class="fv-detail-value">${(lines.length - blankLines - commentLines).toLocaleString()}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Avg line length</span><span class="fv-detail-value">${lines.length ? Math.round(chars / lines.length) : 0} chars</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Longest line</span><span class="fv-detail-value">${Math.max(...lines.map(l => l.length))} chars</span></div>
        </div>`;

        // Encoding & formatting info
        const hasNonAscii = /[^\x00-\x7F]/.test(content);
        const hasTabs = content.includes('\t');
        const hasTrailingWS = lines.some(l => l !== l.trimEnd());
        const hasCRLF = content.includes('\r\n');
        const hasLF = content.replace(/\r\n/g, '').includes('\n');
        const mixedEndings = hasCRLF && hasLF;
        const lineEnding = mixedEndings ? 'Mixed' : hasCRLF ? 'CRLF (Windows)' : 'LF (Unix)';
        const indentStyle = hasTabs ? 'Tabs' : 'Spaces';
        // Detect indent size from spaces
        let indentSize = '?';
        if (!hasTabs) {
          const indents = lines.map(l => { const m = l.match(/^( +)/); return m ? m[1].length : 0; }).filter(n => n > 0);
          if (indents.length > 0) {
            const counts = {};
            for (let k = 0; k < indents.length - 1; k++) {
              const d = Math.abs(indents[k + 1] - indents[k]);
              if (d > 0 && d <= 8) counts[d] = (counts[d] || 0) + 1;
            }
            const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            if (best) indentSize = best[0];
          }
        }

        dHtml += `<div class="fv-detail-section">
          <div class="fv-detail-section-title">Formatting</div>
          <div class="fv-detail-row"><span class="fv-detail-label">Line endings</span><span class="fv-detail-value">${lineEnding}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Indentation</span><span class="fv-detail-value">${indentStyle}${!hasTabs ? ' (' + indentSize + ')' : ''}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Encoding</span><span class="fv-detail-value">${hasNonAscii ? 'UTF-8 (non-ASCII)' : 'ASCII'}</span></div>
        </div>`;

        // Warnings
        const warnings = [];
        if (mixedEndings) warnings.push({ text: 'Mixed line endings (CRLF + LF)', color: '#F59E0B' });
        if (hasTrailingWS) warnings.push({ text: 'Trailing whitespace detected', color: '#F59E0B' });
        const longLines = lines.filter(l => l.length > 120).length;
        if (longLines > 0) warnings.push({ text: `${longLines} lines exceed 120 chars`, color: '#F59E0B' });
        const maxLine = Math.max(...lines.map(l => l.length));
        if (maxLine > 500) warnings.push({ text: `Max line length: ${maxLine} chars`, color: '#EF4444' });

        if (warnings.length > 0) {
          dHtml += `<div class="fv-detail-section"><div class="fv-detail-section-title">Warnings</div>`;
          for (const w of warnings) dHtml += `<div class="fv-detail-row"><span class="fv-detail-label" style="color:${w.color}">\u26A0 ${w.text}</span></div>`;
          dHtml += `</div>`;
        }

        // TODOs / FIXMEs
        const todos = [];
        for (let li = 0; li < lines.length; li++) {
          const m = lines[li].match(/\b(TODO|FIXME|HACK|XXX|BUG|WARN|NOTE)\b[:\s]*(.*)/i);
          if (m) todos.push({ line: li + 1, tag: m[1].toUpperCase(), text: m[2].trim().substring(0, 60) });
        }
        if (todos.length > 0) {
          dHtml += `<div class="fv-detail-section"><div class="fv-detail-section-title">Annotations (${todos.length})</div>`;
          const tagColors = { TODO: '#60A5FA', FIXME: '#F87171', HACK: '#F59E0B', BUG: '#EF4444', XXX: '#F59E0B', WARN: '#FBBF24', NOTE: '#34D399' };
          for (const t of todos.slice(0, 20)) {
            dHtml += `<div class="fv-detail-row fv-todo-item" data-line="${t.line}">
              <span class="fv-todo-tag" style="color:${tagColors[t.tag] || '#94A3B8'}">${t.tag}</span>
              <span class="fv-detail-value" style="flex:1">${fvEsc(t.text || '(no description)')}</span>
              <span class="fv-detail-label" style="font-size:10px">:${t.line}</span>
            </div>`;
          }
          if (todos.length > 20) dHtml += `<div class="fv-detail-row"><span class="fv-detail-label">...${todos.length - 20} more</span></div>`;
          dHtml += `</div>`;
        }

        // Dependencies / Imports
        const imports = [];
        for (const l of lines) {
          let m;
          if ((m = l.match(/(?:import|from)\s+['"]([^'"]+)['"]/))) imports.push(m[1]);
          else if ((m = l.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/))) imports.push(m[1]);
          else if ((m = l.match(/^#include\s+[<"]([^>"]+)[>"]/))) imports.push(m[1]);
          else if ((m = l.match(/^import\s+([\w.]+)/)) && ['py','java','kt','go'].includes(ext)) imports.push(m[1]);
          else if ((m = l.match(/^using\s+([\w.]+);/))) imports.push(m[1]);
        }
        const uniqueImports = [...new Set(imports)];
        if (uniqueImports.length > 0) {
          dHtml += `<div class="fv-detail-section"><div class="fv-detail-section-title">Dependencies (${uniqueImports.length})</div>`;
          for (const dep of uniqueImports.slice(0, 25)) {
            const isLocal = dep.startsWith('.') || dep.startsWith('/') || dep.startsWith('..');
            dHtml += `<div class="fv-detail-row"><span class="fv-dep-badge ${isLocal ? 'fv-dep-local' : 'fv-dep-ext'}">${isLocal ? 'local' : 'pkg'}</span><span class="fv-detail-value">${fvEsc(dep)}</span></div>`;
          }
          if (uniqueImports.length > 25) dHtml += `<div class="fv-detail-row"><span class="fv-detail-label">...${uniqueImports.length - 25} more</span></div>`;
          dHtml += `</div>`;
        }
      } catch {}
    }

    // G-code stats
    if (fileType === 'gcode') {
      try {
        const content = await window.api.files.readText(filePath);
        const gcLines = content.split('\n');
        const toolChanges = gcLines.filter(l => /^T\d/i.test(l.trim())).length;
        const layers = new Set();
        let maxZ = 0;
        for (const l of gcLines) {
          const zm = l.match(/Z([\d.]+)/i);
          if (zm) { const z = parseFloat(zm[1]); layers.add(z.toFixed(2)); if (z > maxZ) maxZ = z; }
        }
        dHtml += `<div class="fv-detail-section">
          <div class="fv-detail-section-title">G-code Stats</div>
          <div class="fv-detail-row"><span class="fv-detail-label">Layers</span><span class="fv-detail-value">~${layers.size}</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Max Z</span><span class="fv-detail-value">${maxZ.toFixed(2)} mm</span></div>
          <div class="fv-detail-row"><span class="fv-detail-label">Tool changes</span><span class="fv-detail-value">${toolChanges}</span></div>
        </div>`;
      } catch {}
    }

    detailsEl.innerHTML = dHtml;

    // Image dimensions (async after img loads)
    const imgEl = detailsEl.querySelector('#fv-inspect-img');
    if (imgEl) {
      imgEl.onload = () => {
        const dimRow = document.createElement('div');
        dimRow.className = 'fv-detail-row';
        dimRow.innerHTML = `<span class="fv-detail-label">Dimensions</span><span class="fv-detail-value">${imgEl.naturalWidth} x ${imgEl.naturalHeight}</span>`;
        imgEl.parentElement.appendChild(dimRow);
      };
    }

    // ---- OUTLINE TAB ----
    const outlineEl = document.getElementById('fv-inspect-outline');
    if (fileType === 'text' && ['js','ts','jsx','tsx','py','c','cpp','h','hpp','java','go','rs','cs','rb'].includes(ext)) {
      try {
        const content = await window.api.files.readText(filePath);
        const outline = this._extractOutline(content, ext);
        if (outline.length > 0) {
          let oHtml = '';
          let lastGroup = '';
          for (const item of outline) {
            if (item.group !== lastGroup) {
              oHtml += `<div class="fv-outline-group-title">${fvEsc(item.group)}</div>`;
              lastGroup = item.group;
            }
            oHtml += `<div class="fv-outline-item" data-line="${item.line}">
              <span class="fv-outline-icon ${item.iconCls}">${item.icon}</span>
              <span class="fv-outline-name">${fvEsc(item.name)}</span>
              <span class="fv-outline-line">:${item.line}</span>
            </div>`;
          }
          outlineEl.innerHTML = oHtml;
        } else {
          outlineEl.innerHTML = '<div class="fv-inspect-empty">No symbols found</div>';
        }
      } catch { outlineEl.innerHTML = '<div class="fv-inspect-empty">Could not parse file</div>'; }
    } else {
      outlineEl.innerHTML = '<div class="fv-inspect-empty">Outline not available for this file type</div>';
    }

    // ---- TOOLS TAB ----
    const toolsEl = document.getElementById('fv-inspect-tools');
    let tHtml = '';

    // Quick stats
    tHtml += `<div class="fv-tool-section">
      <div class="fv-tool-title">Quick Info</div>
      <div class="fv-tool-stat"><span class="fv-tool-stat-label">Extension</span><span class="fv-tool-stat-value">.${fvEsc(ext)}</span></div>
      <div class="fv-tool-stat"><span class="fv-tool-stat-label">Size</span><span class="fv-tool-stat-value">${fvFormatSize(size)} (${(size || 0).toLocaleString()} bytes)</span></div>
    </div>`;

    // Size context bars
    const sizeKB = (size || 0) / 1024;
    tHtml += `<div class="fv-tool-section">
      <div class="fv-tool-title">Size Context</div>
      <div class="fv-tool-bar-row">
        <span class="fv-tool-bar-label">1 KB</span>
        <div class="fv-tool-bar-track"><div class="fv-tool-bar-fill" style="width:${Math.min(100, sizeKB / 1 * 100)}%;background:#34D399"></div></div>
      </div>
      <div class="fv-tool-bar-row">
        <span class="fv-tool-bar-label">1 MB</span>
        <div class="fv-tool-bar-track"><div class="fv-tool-bar-fill" style="width:${Math.min(100, sizeKB / 1024 * 100)}%;background:#60A5FA"></div></div>
      </div>
      <div class="fv-tool-bar-row">
        <span class="fv-tool-bar-label">100 MB</span>
        <div class="fv-tool-bar-track"><div class="fv-tool-bar-fill" style="width:${Math.min(100, sizeKB / 102400 * 100)}%;background:#F59E0B"></div></div>
      </div>
    </div>`;

    // Actions
    tHtml += `<div class="fv-tool-section">
      <div class="fv-tool-title">Actions</div>
      <button class="fv-tool-btn" id="fv-tool-copy-path">Copy Full Path</button>
      <button class="fv-tool-btn" id="fv-tool-copy-name">Copy File Name</button>
      <button class="fv-tool-btn" id="fv-tool-open-folder">Open Containing Folder</button>
      <button class="fv-tool-btn" id="fv-tool-open-app">Open in Default App</button>`;

    if (['gcode','gco','g','3mf'].includes(ext)) {
      tHtml += `<button class="fv-tool-btn" id="fv-tool-send-printer" style="border-color:#166534;color:#86EFAC">Send to Printer</button>`;
    }
    if (fileType === 'text' || fileType === 'gcode' || fileType === 'csv') {
      tHtml += `<button class="fv-tool-btn" id="fv-tool-compare" style="border-color:#1E40AF;color:#93C5FD">Compare With...</button>`;
    }
    tHtml += `<button class="fv-tool-btn" id="fv-tool-copy-rel">Copy Relative Path</button>`;
    tHtml += `<button class="fv-tool-btn" id="fv-tool-duplicate">Duplicate File</button>`;
    tHtml += `</div>`;

    // Text cleanup tools
    if (fileType === 'text' || fileType === 'csv') {
      tHtml += `<div class="fv-tool-section">
        <div class="fv-tool-title">Text Cleanup</div>
        <button class="fv-tool-btn" id="fv-tool-trim-ws">Trim Trailing Whitespace</button>
        <button class="fv-tool-btn" id="fv-tool-fix-eol">Normalize Line Endings (LF)</button>
        <button class="fv-tool-btn" id="fv-tool-remove-blank">Remove Consecutive Blank Lines</button>
        <button class="fv-tool-btn" id="fv-tool-sort-lines">Sort Lines (A-Z)</button>
        <button class="fv-tool-btn" id="fv-tool-dedup-lines">Remove Duplicate Lines</button>
      </div>`;
    }

    // Hex preview
    tHtml += `<div class="fv-tool-section">
      <div class="fv-tool-title">Hex Preview (first 256 bytes)</div>
      <div class="fv-hex-preview" id="fv-tool-hex">Loading...</div>
    </div>`;

    // Git info if available
    if (this.isGitRepo) {
      const relPath = filePath.replace(this.rootDir, '').replace(/^[/\\]/, '').replace(/\\/g, '/');
      const status = this.gitStatus[relPath] || 'clean';
      tHtml += `<div class="fv-tool-section">
        <div class="fv-tool-title">Git</div>
        <div class="fv-tool-stat"><span class="fv-tool-stat-label">Status</span><span class="fv-tool-stat-value">${status === 'clean' ? 'Tracked (clean)' : fvEsc(status)}</span></div>
        <button class="fv-tool-btn" id="fv-tool-git-stage">Stage File</button>
        <button class="fv-tool-btn" id="fv-tool-git-diff">View Diff</button>
      </div>`;
    }

    toolsEl.innerHTML = tHtml;

    // Bind tool buttons
    toolsEl.querySelector('#fv-tool-copy-path')?.addEventListener('click', () => { navigator.clipboard.writeText(filePath); fvToast('Path copied', 'info'); });
    toolsEl.querySelector('#fv-tool-copy-name')?.addEventListener('click', () => { navigator.clipboard.writeText(name); fvToast('Name copied', 'info'); });
    toolsEl.querySelector('#fv-tool-open-folder')?.addEventListener('click', () => {
      const dir = filePath.replace(/[/\\][^/\\]+$/, '');
      window.api.files.openPath(dir);
    });
    toolsEl.querySelector('#fv-tool-open-app')?.addEventListener('click', () => window.api.files.openPath(filePath));
    toolsEl.querySelector('#fv-tool-send-printer')?.addEventListener('click', () => this._sendToPrinter(filePath));
    toolsEl.querySelector('#fv-tool-compare')?.addEventListener('click', () => this._compareWith(filePath));
    toolsEl.querySelector('#fv-tool-git-stage')?.addEventListener('click', async () => {
      try { await window.api.git.stage(filePath); fvToast('Staged', 'success'); await this._refreshGitStatus(); } catch { fvToast('Stage failed', 'error'); }
    });
    toolsEl.querySelector('#fv-tool-git-diff')?.addEventListener('click', async () => {
      try {
        const diff = await window.api.git.diff(filePath);
        if (diff) this.paneManager.getActivePane().openFile(filePath + '.diff', { name: name + ' (diff)' }, true);
        else fvToast('No changes', 'info');
      } catch { fvToast('Diff failed', 'error'); }
    });

    // Copy relative path
    toolsEl.querySelector('#fv-tool-copy-rel')?.addEventListener('click', () => {
      const rel = this.rootDir ? filePath.replace(this.rootDir, '').replace(/^[/\\]/, '') : name;
      navigator.clipboard.writeText(rel);
      fvToast('Relative path copied', 'info');
    });

    // Duplicate file
    toolsEl.querySelector('#fv-tool-duplicate')?.addEventListener('click', async () => {
      const dir = filePath.replace(/[/\\][^/\\]+$/, '');
      const baseName = name.replace(/(\.[^.]+)$/, '');
      const extPart = name.includes('.') ? '.' + ext : '';
      let newName = `${baseName} - Copy${extPart}`;
      let dest = dir + (dir.includes('/') ? '/' : '\\') + newName;
      try {
        if (await window.api.files.exists(dest)) {
          for (let i = 2; i < 100; i++) {
            newName = `${baseName} - Copy (${i})${extPart}`;
            dest = dir + (dir.includes('/') ? '/' : '\\') + newName;
            if (!(await window.api.files.exists(dest))) break;
          }
        }
        await window.api.files.copyFile(filePath, dest);
        fvToast('Duplicated: ' + newName, 'success');
        await this.loadTree();
      } catch (err) { fvToast('Duplicate failed: ' + err.message, 'error'); }
    });

    // Text cleanup tools
    toolsEl.querySelector('#fv-tool-trim-ws')?.addEventListener('click', async () => {
      try {
        const content = await window.api.files.readText(filePath);
        const cleaned = content.split('\n').map(l => l.trimEnd()).join('\n');
        if (cleaned === content) { fvToast('No trailing whitespace found', 'info'); return; }
        await window.api.files.writeText(filePath, cleaned);
        fvToast('Trimmed trailing whitespace', 'success');
        this.paneManager.getActivePane().openFile(filePath, { name }, true);
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });
    toolsEl.querySelector('#fv-tool-fix-eol')?.addEventListener('click', async () => {
      try {
        const content = await window.api.files.readText(filePath);
        const cleaned = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (cleaned === content) { fvToast('Line endings already LF', 'info'); return; }
        await window.api.files.writeText(filePath, cleaned);
        fvToast('Normalized to LF', 'success');
        this.paneManager.getActivePane().openFile(filePath, { name }, true);
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });
    toolsEl.querySelector('#fv-tool-remove-blank')?.addEventListener('click', async () => {
      try {
        const content = await window.api.files.readText(filePath);
        const cleaned = content.replace(/\n{3,}/g, '\n\n');
        if (cleaned === content) { fvToast('No consecutive blank lines found', 'info'); return; }
        await window.api.files.writeText(filePath, cleaned);
        fvToast('Removed consecutive blank lines', 'success');
        this.paneManager.getActivePane().openFile(filePath, { name }, true);
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });
    toolsEl.querySelector('#fv-tool-sort-lines')?.addEventListener('click', async () => {
      try {
        const content = await window.api.files.readText(filePath);
        const sorted = content.split('\n').sort((a, b) => a.localeCompare(b)).join('\n');
        await window.api.files.writeText(filePath, sorted);
        fvToast('Lines sorted A-Z', 'success');
        this.paneManager.getActivePane().openFile(filePath, { name }, true);
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });
    toolsEl.querySelector('#fv-tool-dedup-lines')?.addEventListener('click', async () => {
      try {
        const content = await window.api.files.readText(filePath);
        const lines = content.split('\n');
        const seen = new Set();
        const deduped = lines.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
        const cleaned = deduped.join('\n');
        const removed = lines.length - deduped.length;
        if (removed === 0) { fvToast('No duplicate lines found', 'info'); return; }
        await window.api.files.writeText(filePath, cleaned);
        fvToast(`Removed ${removed} duplicate lines`, 'success');
        this.paneManager.getActivePane().openFile(filePath, { name }, true);
      } catch (err) { fvToast('Failed: ' + err.message, 'error'); }
    });

    // Hex preview
    const hexEl = toolsEl.querySelector('#fv-tool-hex');
    if (hexEl) {
      try {
        const headData = await window.api.files.readHead(filePath, 256);
        if (headData) {
          let hexHtml = '';
          const bytes = typeof headData === 'string' ? new TextEncoder().encode(headData) : new Uint8Array(headData);
          for (let i = 0; i < bytes.length; i += 16) {
            const addr = i.toString(16).padStart(6, '0');
            let hex = '', ascii = '';
            for (let j = 0; j < 16; j++) {
              if (i + j < bytes.length) {
                hex += bytes[i + j].toString(16).padStart(2, '0') + ' ';
                const c = bytes[i + j];
                ascii += (c >= 32 && c <= 126) ? String.fromCharCode(c) : '.';
              } else { hex += '   '; ascii += ' '; }
              if (j === 7) hex += ' ';
            }
            hexHtml += `<span class="fv-hex-addr">${addr}</span> <span class="fv-hex-bytes">${hex}</span> <span class="fv-hex-ascii">${fvEsc(ascii)}</span>\n`;
          }
          hexEl.innerHTML = hexHtml;
        } else { hexEl.textContent = 'Could not read file'; }
      } catch { hexEl.textContent = 'Could not read file'; }
    }
  }

  // -------- DOCUMENT COMPARE --------
  async _compareWith(filePathA) {
    let filePathB;
    try {
      const result = await window.api.openFileDialog();
      if (!result || result.length === 0) return;
      filePathB = result[0];
    } catch {
      fvToast('Could not open file picker', 'error');
      return;
    }

    fvToast('Comparing files...', 'info');
    let textA, textB;
    try {
      [textA, textB] = await Promise.all([
        window.api.files.readText(filePathA),
        window.api.files.readText(filePathB)
      ]);
    } catch (err) {
      fvToast('Error reading files: ' + err.message, 'error');
      return;
    }

    const nameA = filePathA.split(/[/\\]/).pop();
    const nameB = filePathB.split(/[/\\]/).pop();
    const linesA = textA.split('\n');
    const linesB = textB.split('\n');

    // LCS-based diff
    const diff = this._computeDiff(linesA, linesB);

    // Render in the active pane
    const pane = this.paneManager.getActivePane();
    const container = pane.contentEl;
    container.innerHTML = '';
    container.className = 'fv-pane-content';

    const wrap = document.createElement('div');
    wrap.className = 'fv-compare-wrap';

    // Header
    const header = document.createElement('div');
    header.className = 'fv-compare-header';
    header.innerHTML = `
      <div class="fv-compare-file-label fv-compare-left">${fvEsc(nameA)} <span class="fv-compare-path">${fvEsc(filePathA)}</span></div>
      <div class="fv-compare-file-label fv-compare-right">${fvEsc(nameB)} <span class="fv-compare-path">${fvEsc(filePathB)}</span></div>
    `;
    wrap.appendChild(header);

    // Stats
    const added = diff.filter(d => d.type === 'add').length;
    const removed = diff.filter(d => d.type === 'remove').length;
    const unchanged = diff.filter(d => d.type === 'same').length;
    const statsBar = document.createElement('div');
    statsBar.className = 'fv-compare-stats';
    statsBar.innerHTML = `<span class="fv-compare-stat same">${unchanged} unchanged</span>
      <span class="fv-compare-stat added">+${added} added</span>
      <span class="fv-compare-stat removed">-${removed} removed</span>`;
    wrap.appendChild(statsBar);

    // Side-by-side diff view
    const diffEl = document.createElement('div');
    diffEl.className = 'fv-compare-diff';

    const leftCol = document.createElement('div');
    leftCol.className = 'fv-compare-col fv-compare-col-left';
    const rightCol = document.createElement('div');
    rightCol.className = 'fv-compare-col fv-compare-col-right';

    let lineNumA = 0, lineNumB = 0;
    for (const entry of diff) {
      if (entry.type === 'same') {
        lineNumA++; lineNumB++;
        leftCol.appendChild(this._makeDiffLine(lineNumA, entry.value, 'same'));
        rightCol.appendChild(this._makeDiffLine(lineNumB, entry.value, 'same'));
      } else if (entry.type === 'remove') {
        lineNumA++;
        leftCol.appendChild(this._makeDiffLine(lineNumA, entry.value, 'remove'));
        rightCol.appendChild(this._makeDiffLine('', '', 'remove-blank'));
      } else if (entry.type === 'add') {
        lineNumB++;
        leftCol.appendChild(this._makeDiffLine('', '', 'add-blank'));
        rightCol.appendChild(this._makeDiffLine(lineNumB, entry.value, 'add'));
      } else if (entry.type === 'change') {
        lineNumA++; lineNumB++;
        // Word-level highlight
        const [hlA, hlB] = this._wordDiff(entry.oldValue, entry.newValue);
        leftCol.appendChild(this._makeDiffLineHtml(lineNumA, hlA, 'remove'));
        rightCol.appendChild(this._makeDiffLineHtml(lineNumB, hlB, 'add'));
      }
    }

    diffEl.appendChild(leftCol);
    diffEl.appendChild(rightCol);
    // Sync scroll
    leftCol.addEventListener('scroll', () => { rightCol.scrollTop = leftCol.scrollTop; rightCol.scrollLeft = leftCol.scrollLeft; });
    rightCol.addEventListener('scroll', () => { leftCol.scrollTop = rightCol.scrollTop; leftCol.scrollLeft = rightCol.scrollLeft; });
    wrap.appendChild(diffEl);
    container.appendChild(wrap);

    // Update tab title
    const tab = pane.tabBar.querySelector('.fv-tab.active .fv-tab-title');
    if (tab) tab.textContent = `Compare: ${nameA} ↔ ${nameB}`;
  }

  _makeDiffLine(num, text, type) {
    const row = document.createElement('div');
    row.className = 'fv-diff-line fv-diff-' + type;
    const numSpan = document.createElement('span');
    numSpan.className = 'fv-diff-num';
    numSpan.textContent = num;
    const textSpan = document.createElement('span');
    textSpan.className = 'fv-diff-text';
    textSpan.textContent = text;
    row.appendChild(numSpan);
    row.appendChild(textSpan);
    return row;
  }

  _makeDiffLineHtml(num, html, type) {
    const row = document.createElement('div');
    row.className = 'fv-diff-line fv-diff-' + type;
    const numSpan = document.createElement('span');
    numSpan.className = 'fv-diff-num';
    numSpan.textContent = num;
    const textSpan = document.createElement('span');
    textSpan.className = 'fv-diff-text';
    textSpan.innerHTML = html;
    row.appendChild(numSpan);
    row.appendChild(textSpan);
    return row;
  }

  _computeDiff(linesA, linesB) {
    // Myers-like LCS diff producing same/add/remove/change entries
    const n = linesA.length, m = linesB.length;

    // For large files, use a simplified approach
    if (n + m > 20000) return this._simpleDiff(linesA, linesB);

    // Build LCS table (optimized for memory)
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = linesA[i - 1] === linesB[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    // Backtrack to produce diff
    const result = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
        result.unshift({ type: 'same', value: linesA[i - 1] });
        i--; j--;
      } else if (i > 0 && j > 0 && dp[i - 1][j - 1] >= dp[i - 1][j] && dp[i - 1][j - 1] >= dp[i][j - 1]) {
        // Changed line — pair them for word diff
        result.unshift({ type: 'change', oldValue: linesA[i - 1], newValue: linesB[j - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift({ type: 'add', value: linesB[j - 1] });
        j--;
      } else {
        result.unshift({ type: 'remove', value: linesA[i - 1] });
        i--;
      }
    }
    return result;
  }

  _simpleDiff(linesA, linesB) {
    // Line-by-line comparison for large files
    const result = [];
    const max = Math.max(linesA.length, linesB.length);
    for (let i = 0; i < max; i++) {
      if (i < linesA.length && i < linesB.length) {
        if (linesA[i] === linesB[i]) result.push({ type: 'same', value: linesA[i] });
        else result.push({ type: 'change', oldValue: linesA[i], newValue: linesB[i] });
      } else if (i < linesA.length) {
        result.push({ type: 'remove', value: linesA[i] });
      } else {
        result.push({ type: 'add', value: linesB[i] });
      }
    }
    return result;
  }

  _wordDiff(lineA, lineB) {
    // Split into words, diff them, and return HTML with highlights
    const wordsA = lineA.split(/(\s+)/);
    const wordsB = lineB.split(/(\s+)/);
    const n = wordsA.length, m = wordsB.length;

    // LCS on words
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        dp[i][j] = wordsA[i - 1] === wordsB[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    // Backtrack
    const ops = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && wordsA[i - 1] === wordsB[j - 1]) {
        ops.unshift({ type: 'same', a: wordsA[i - 1], b: wordsB[j - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        ops.unshift({ type: 'add', b: wordsB[j - 1] });
        j--;
      } else {
        ops.unshift({ type: 'remove', a: wordsA[i - 1] });
        i--;
      }
    }

    let htmlA = '', htmlB = '';
    for (const op of ops) {
      if (op.type === 'same') {
        htmlA += fvEsc(op.a);
        htmlB += fvEsc(op.b);
      } else if (op.type === 'remove') {
        htmlA += `<span class="fv-word-del">${fvEsc(op.a)}</span>`;
      } else if (op.type === 'add') {
        htmlB += `<span class="fv-word-add">${fvEsc(op.b)}</span>`;
      }
    }
    return [htmlA, htmlB];
  }

  _extractOutline(content, ext) {
    const items = [];
    const lines = content.split('\n');

    // JS/TS patterns
    if (['js','ts','jsx','tsx'].includes(ext)) {
      lines.forEach((line, i) => {
        // Functions
        let m = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (m) { items.push({ name: m[1] + '()', group: 'Functions', icon: 'f', iconCls: 'fn', line: i + 1 }); return; }
        // Arrow / const functions
        m = line.match(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?.*\)?\s*=>/);
        if (m) { items.push({ name: m[1] + '()', group: 'Functions', icon: 'f', iconCls: 'fn', line: i + 1 }); return; }
        // Methods
        m = line.match(/^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        if (m && !['if','for','while','switch','catch'].includes(m[1])) { items.push({ name: m[1] + '()', group: 'Methods', icon: 'f', iconCls: 'fn', line: i + 1 }); return; }
        // Classes
        m = line.match(/(?:export\s+)?class\s+(\w+)/);
        if (m) { items.push({ name: m[1], group: 'Classes', icon: 'C', iconCls: 'cls', line: i + 1 }); return; }
        // Imports
        m = line.match(/import\s+.*from\s+['"]([^'"]+)['"]/);
        if (m) { items.push({ name: m[1], group: 'Imports', icon: 'I', iconCls: 'imp', line: i + 1 }); return; }
      });
    }

    // Python patterns
    if (['py'].includes(ext)) {
      lines.forEach((line, i) => {
        let m = line.match(/^(?:async\s+)?def\s+(\w+)/);
        if (m) { items.push({ name: m[1] + '()', group: 'Functions', icon: 'f', iconCls: 'fn', line: i + 1 }); return; }
        m = line.match(/^class\s+(\w+)/);
        if (m) { items.push({ name: m[1], group: 'Classes', icon: 'C', iconCls: 'cls', line: i + 1 }); return; }
        m = line.match(/^(\w+)\s*=\s*(?!.*(?:def|class|lambda))/);
        if (m && m[1] === m[1].toUpperCase() && m[1].length > 1) { items.push({ name: m[1], group: 'Constants', icon: 'V', iconCls: 'var', line: i + 1 }); return; }
        m = line.match(/^(?:from\s+(\S+)\s+)?import\s+(.+)/);
        if (m) { items.push({ name: m[1] || m[2].split(',')[0].trim(), group: 'Imports', icon: 'I', iconCls: 'imp', line: i + 1 }); return; }
      });
    }

    // C/C++/Java/Go/Rust patterns
    if (['c','cpp','h','hpp','java','go','rs','cs'].includes(ext)) {
      lines.forEach((line, i) => {
        // C/C++ function definitions
        let m = line.match(/^(?:[\w*&:]+\s+)+(\w+)\s*\([^;]*$/);
        if (m && !['if','for','while','switch','return','else'].includes(m[1])) {
          items.push({ name: m[1] + '()', group: 'Functions', icon: 'f', iconCls: 'fn', line: i + 1 }); return;
        }
        // Struct/class
        m = line.match(/(?:class|struct|enum|interface|trait|impl)\s+(\w+)/);
        if (m) { items.push({ name: m[1], group: 'Types', icon: 'C', iconCls: 'cls', line: i + 1 }); return; }
        // #include / import
        m = line.match(/#include\s*[<"]([^>"]+)[>"]/);
        if (m) { items.push({ name: m[1], group: 'Includes', icon: 'I', iconCls: 'imp', line: i + 1 }); return; }
        m = line.match(/^import\s+(.+)/);
        if (m) { items.push({ name: m[1].replace(/;$/, '').trim(), group: 'Imports', icon: 'I', iconCls: 'imp', line: i + 1 }); return; }
      });
    }

    return items;
  }

  // -------- BATCH RENAME --------
  _initBatchRename() {
    const panel = document.getElementById('fv-rename-panel');
    const findInput = document.getElementById('fv-rename-find');
    const replaceInput = document.getElementById('fv-rename-replace');
    const regexCheck = document.getElementById('fv-rename-regex');
    const caseCheck = document.getElementById('fv-rename-case');
    const previewEl = document.getElementById('fv-rename-preview');
    const applyBtn = document.getElementById('fv-rename-apply');
    const closeBtn = document.getElementById('fv-rename-close');

    document.getElementById('fv-btn-rename').addEventListener('click', () => {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) { findInput.focus(); this._updateRenamePreview(); }
    });
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

    const updatePreview = () => this._updateRenamePreview();
    findInput.addEventListener('input', updatePreview);
    replaceInput.addEventListener('input', updatePreview);
    regexCheck.addEventListener('change', updatePreview);
    caseCheck.addEventListener('change', updatePreview);

    applyBtn.addEventListener('click', async () => {
      const dir = this.currentDir || this.rootDir;
      if (!dir) return;
      const find = findInput.value, replace = replaceInput.value;
      if (!find) return;
      applyBtn.disabled = true; applyBtn.textContent = 'Renaming...';
      try {
        const results = await window.api.files.batchRename(dir, find, replace, { regex: regexCheck.checked, caseSensitive: caseCheck.checked });
        const ok = results.filter(r => r.success).length, fail = results.filter(r => !r.success).length;
        previewEl.innerHTML = `<div class="fv-rename-result">Renamed ${ok} file${ok !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}</div>`;
        await this.loadTree();
      } catch (err) { previewEl.innerHTML = `<div class="fv-rename-error">Error: ${fvEsc(err.message)}</div>`; }
      applyBtn.disabled = false; applyBtn.textContent = 'Apply Rename';
    });
  }

  async _updateRenamePreview() {
    const dir = this.currentDir || this.rootDir;
    if (!dir) return;
    const findInput = document.getElementById('fv-rename-find');
    const replaceInput = document.getElementById('fv-rename-replace');
    const regexCheck = document.getElementById('fv-rename-regex');
    const caseCheck = document.getElementById('fv-rename-case');
    const previewEl = document.getElementById('fv-rename-preview');
    const applyBtn = document.getElementById('fv-rename-apply');
    const find = findInput.value, replace = replaceInput.value;
    if (!find) { previewEl.innerHTML = '<div class="fv-rename-hint">Type a search string to see matches</div>'; applyBtn.disabled = true; return; }
    try {
      const items = await window.api.files.readdir(dir);
      const previews = [];
      for (const item of items) {
        let newName;
        if (regexCheck.checked) { try { newName = item.name.replace(new RegExp(find, caseCheck.checked ? 'g' : 'gi'), replace); } catch { newName = item.name; } }
        else { newName = caseCheck.checked ? item.name.split(find).join(replace) : item.name.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replace); }
        if (newName !== item.name && newName.length > 0) previews.push({ old: item.name, new: newName });
      }
      if (previews.length === 0) { previewEl.innerHTML = '<div class="fv-rename-hint">No files match</div>'; applyBtn.disabled = true; }
      else {
        previewEl.innerHTML = previews.slice(0, 50).map(p => `<div class="fv-rename-preview-row"><span class="fv-rename-old">${fvEsc(p.old)}</span><span class="fv-rename-arrow">&rarr;</span><span class="fv-rename-new">${fvEsc(p.new)}</span></div>`).join('') + (previews.length > 50 ? `<div class="fv-rename-hint">...and ${previews.length - 50} more</div>` : '');
        applyBtn.disabled = false;
      }
    } catch { previewEl.innerHTML = ''; applyBtn.disabled = true; }
  }

  // -------- FILTER --------
  _applyFilter() {
    const items = this.treeEl.querySelectorAll('.file-tree-item');
    let visibleCount = 0;
    items.forEach(item => {
      if (item.classList.contains('file-tree-empty-dir')) return;
      const nameEl = item.querySelector('.file-tree-name');
      if (!nameEl) return;
      const isDir = item.querySelector('.file-tree-arrow:not([style*="hidden"])');
      if (isDir) { item.style.display = ''; }
      else if (this._filterText && !nameEl.textContent.toLowerCase().includes(this._filterText)) { item.style.display = 'none'; }
      else { item.style.display = ''; visibleCount++; }
    });
    if (this._filterText && this.fileCountEl) this.fileCountEl.textContent = `${visibleCount} matching`;
  }

  // -------- TREE --------
  async selectRootFolder() {
    const dir = await window.api.files.selectFolder();
    if (!dir) return;
    this.rootDir = dir;
    this.expandedDirs.clear();
    this.expandedDirs.add(dir);
    this.loadTree();
    const settings = await window.api.loadData('settings.json') || {};
    settings.fileViewerRoot = dir;
    await window.api.saveData('settings.json', settings);
  }

  async loadTree() {
    if (!this.rootDir) { this.treeEl.innerHTML = '<div class="file-tree-empty">Select a folder to browse</div>'; if (this.fileCountEl) this.fileCountEl.textContent = ''; return; }
    this.currentDir = this.rootDir;
    this.treeEl.innerHTML = '';
    this._totalFileCount = 0;
    this._totalDirSize = 0;
    const rootNode = await this._buildTreeNode(this.rootDir, 0, true);
    this.treeEl.appendChild(rootNode);
    if (this.fileCountEl) this.fileCountEl.textContent = `${this._totalFileCount} files`;
    if (this._filterText) this._applyFilter();

    // Show total size in footer
    if (this.fileCountEl && this._totalDirSize > 0) {
      this.fileCountEl.textContent = `${this._totalFileCount} files \u00B7 ${fvFormatSize(this._totalDirSize)}`;
    }

    // Git check
    this._checkGitRepo();

    // File watcher
    this._startWatch();

    // Update bookmark star
    const bookmarkBtn = document.getElementById('fv-btn-bookmark');
    if (bookmarkBtn) {
      const dir = this.currentDir || this.rootDir;
      bookmarkBtn.textContent = this.bookmarks.some(b => b.path === dir) ? '\u2605' : '\u2606';
    }
  }

  async _buildTreeNode(dirPath, depth, expanded) {
    const container = document.createElement('div');
    container.className = 'file-tree-group';
    let items = await window.api.files.readdir(dirPath);

    // Filter out backup files (.fvbak)
    items = items.filter(item => {
      const ext = fvGetExt(item.name);
      return !this._hiddenExts.includes(ext);
    });

    // Sort items
    items = this._sortItems(items);

    // Track total size for disk bar
    for (const item of items) {
      if (!item.isDirectory && item.size) this._totalDirSize += item.size;
    }

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'file-tree-item';
      row.style.paddingLeft = (12 + depth * 16) + 'px';
      row.dataset.path = item.path;

      if (item.isDirectory) {
        const isExpanded = this.expandedDirs.has(item.path);
        row.innerHTML = `<span class="file-tree-arrow ${isExpanded ? 'expanded' : ''}">\u25B6</span><span class="file-tree-icon">${FILE_ICONS.folder}</span><span class="file-tree-name">${fvEsc(item.name)}</span>`;
        row.addEventListener('click', async (e) => {
          e.stopPropagation();
          this.currentDir = item.path;
          if (this.expandedDirs.has(item.path)) {
            this.expandedDirs.delete(item.path);
            const childGroup = row.nextElementSibling;
            if (childGroup && childGroup.classList.contains('file-tree-group')) childGroup.remove();
            row.querySelector('.file-tree-arrow').classList.remove('expanded');
          } else {
            this.expandedDirs.add(item.path);
            row.querySelector('.file-tree-arrow').classList.add('expanded');
            row.after(await this._buildTreeNode(item.path, depth + 1, true));
            if (this.isGitRepo) this._applyGitBadges();
          }
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this._showContextMenu(e.clientX, e.clientY, item, dirPath); });

        // Drag: folder as drop target
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          row.classList.add('fv-drop-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('fv-drop-target'));
        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          row.classList.remove('fv-drop-target');
          const srcPath = e.dataTransfer.getData('text/fv-filepath');
          if (srcPath) {
            const name = srcPath.split(/[/\\]/).pop();
            const sep = item.path.includes('/') ? '/' : '\\';
            const dest = item.path + sep + name;
            const action = e.ctrlKey ? 'copy' : 'move';
            try {
              if (action === 'copy') await window.api.files.copyFile(srcPath, dest);
              else await window.api.files.moveFile(srcPath, dest);
              fvToast(`${action === 'copy' ? 'Copied' : 'Moved'}: ${name}`, 'success');
              await this.loadTree();
            } catch (err) { fvToast(`${action} failed: ${err.message}`, 'error'); }
          }
        });
      } else {
        const fileType = fvGetFileType(item.name);
        const icon = FILE_ICONS[fileType] || FILE_ICONS.unknown;
        row.innerHTML = `<span class="file-tree-arrow" style="visibility:hidden">\u25B6</span><span class="file-tree-icon">${icon}</span><span class="file-tree-name">${fvEsc(item.name)}</span><span class="file-tree-size">${fvFormatSize(item.size)}</span>`;
        this._totalFileCount++;

        // Draggable
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/fv-filepath', item.path);
          e.dataTransfer.effectAllowed = 'copyMove';
        });

        // Left-click: open in active tab + inspect
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          this.treeEl.querySelectorAll('.file-tree-item.active').forEach(el => el.classList.remove('active'));
          row.classList.add('active');
          this.currentDir = dirPath;
          this.paneManager.getActivePane().openFile(item.path, item, false);
          this._trackRecent(item.path);
          this.inspectFile(item.path, item);
        });

        // Middle-click: open in new tab
        row.addEventListener('mousedown', (e) => {
          if (e.button === 1) {
            e.preventDefault();
            this.paneManager.getActivePane().openFile(item.path, item, true);
            this._trackRecent(item.path);
          }
        });

        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this._showContextMenu(e.clientX, e.clientY, item, dirPath); });
      }
      container.appendChild(row);

      // Recursively expand children that were previously expanded
      if (item.isDirectory && this.expandedDirs.has(item.path)) {
        const childNode = await this._buildTreeNode(item.path, depth + 1, true);
        container.appendChild(childNode);
      }
    }

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-tree-item file-tree-empty-dir';
      empty.style.paddingLeft = (12 + depth * 16) + 'px';
      empty.textContent = '(empty)';
      container.appendChild(empty);
    }
    return container;
  }

  _showContextMenu(x, y, item, dirPath) {
    const old = document.querySelector('.fv-context-menu');
    if (old) old.remove();
    const menu = document.createElement('div');
    menu.className = 'fv-context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const actions = [];
    if (!item.isDirectory) {
      actions.push({ label: 'Open in App', action: () => window.api.files.openPath(item.path) });
      actions.push({ label: 'Open in New Tab', action: () => this.paneManager.getActivePane().openFile(item.path, item, true) });
      actions.push({ label: 'Rename', action: () => this._inlineRename(item, dirPath) });

      // Send to printer (gcode/3mf files)
      const ext = fvGetExt(item.name);
      if (['gcode', 'gco', 'g', '3mf'].includes(ext)) {
        actions.push({ label: 'Send to Printer', action: () => this._sendToPrinter(item.path) });
      }

      // Git stage/unstage
      if (this.isGitRepo) {
        actions.push({ label: 'Git Stage', action: async () => {
          try { await window.api.git.stage(item.path); fvToast('Staged', 'success'); await this._refreshGitStatus(); } catch (e) { fvToast('Stage failed', 'error'); }
        }});
        actions.push({ label: 'Git Diff', action: async () => {
          try {
            const diff = await window.api.git.diff(item.path);
            if (diff) {
              // Open diff as a virtual text file in a new tab
              this.paneManager.getActivePane().openFile(item.path + '.diff', { name: item.name + ' (diff)' }, true);
            } else { fvToast('No diff', 'info'); }
          } catch (e) { fvToast('Diff failed', 'error'); }
        }});
      }

      actions.push({ label: 'Delete', action: () => this._deleteFile(item), danger: true });
    } else {
      actions.push({ label: 'Open Folder', action: () => {
        this.rootDir = item.path; this.expandedDirs.clear(); this.expandedDirs.add(item.path); this.loadTree();
        window.api.loadData('settings.json').then(s => { s = s || {}; s.fileViewerRoot = item.path; window.api.saveData('settings.json', s); });
      }});
      actions.push({ label: 'Batch Rename Contents', action: () => {
        this.currentDir = item.path;
        document.getElementById('fv-rename-panel').classList.remove('hidden');
        document.getElementById('fv-rename-find').focus();
        this._updateRenamePreview();
      }});
      actions.push({ label: 'Bookmark', action: () => {
        if (!this.bookmarks.some(b => b.path === item.path)) {
          this.bookmarks.push({ path: item.path, name: item.name });
          this._renderBookmarks();
          this._saveBookmarks();
          fvToast('Bookmarked: ' + item.name, 'success');
        }
      }});
    }
    actions.push({ label: 'Copy Path', action: () => { navigator.clipboard.writeText(item.path); fvToast('Path copied', 'info'); } });

    menu.innerHTML = actions.map(a => `<button class="fv-context-item${a.danger ? ' fv-context-danger' : ''}">${fvEsc(a.label)}</button>`).join('');
    document.body.appendChild(menu);
    menu.querySelectorAll('.fv-context-item').forEach((btn, i) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); actions[i].action(); });
    });
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    });
  }

  async _sendToPrinter(filePath) {
    try {
      const settings = await window.api.loadData('settings.json') || {};
      const printerUrl = settings.printerUrl || 'http://192.168.0.130:7125';
      fvToast('Uploading to printer...', 'info');
      await window.api.printer.uploadFile(printerUrl, filePath);
      fvToast('Uploaded to printer!', 'success');
    } catch (err) {
      fvToast('Upload failed: ' + err.message, 'error');
    }
  }

  async _inlineRename(item, dirPath) {
    const row = this.treeEl.querySelector(`.file-tree-item[data-path="${CSS.escape(item.path)}"]`);
    if (!row) return;
    const nameEl = row.querySelector('.file-tree-name');
    if (!nameEl) return;
    const oldName = item.name;
    const input = document.createElement('input');
    input.type = 'text'; input.value = oldName; input.className = 'fv-inline-rename';
    nameEl.replaceWith(input);
    input.focus();
    const dotIdx = oldName.lastIndexOf('.');
    if (dotIdx > 0) input.setSelectionRange(0, dotIdx); else input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== oldName) {
        const sep = dirPath.includes('/') ? '/' : '\\';
        try { await window.api.files.rename(item.path, dirPath + sep + newName); await this.loadTree(); }
        catch (err) { alert('Rename failed: ' + err.message); const span = document.createElement('span'); span.className = 'file-tree-name'; span.textContent = oldName; input.replaceWith(span); }
      } else { const span = document.createElement('span'); span.className = 'file-tree-name'; span.textContent = oldName; input.replaceWith(span); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { const span = document.createElement('span'); span.className = 'file-tree-name'; span.textContent = oldName; input.replaceWith(span); }
    });
    input.addEventListener('blur', commit);
  }

  async _deleteFile(item) {
    if (!confirm(`Move "${item.name}" to trash?`)) return;
    try { await window.api.files.deleteFile(item.path); await this.loadTree(); }
    catch (err) { alert('Delete failed: ' + err.message); }
  }
}

// Global instance
const fileViewer = new FileViewer();
