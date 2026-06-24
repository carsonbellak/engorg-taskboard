// IPC handlers: KiCad library importer — safely APPEND new parts to an existing
// governance-style shared library (e.g. the "Big Blue Library").
//
// The shared library follows the Landis+Gyr "Governance for KiCad" layout: three
// sibling folders under a shared root (= ${SHARED_LIBRARY_PATH}):
//   symbols/<Lib>.kicad_sym
//   footprints/<Lib>.pretty/
//   3dmodels/<subdir>/
// 3D models are linked from inside the .kicad_mod as
//   ${SHARED_LIBRARY_PATH}/3dmodels/<subdir>/<name>.<ext>
// and the symbol metadata is mirrored onto the footprint (governance §4.2.2).
//
// Flow is split so the library is NEVER touched until the final confirmed write:
//   extractZips  → stage everything read-only into a temp dir, return descriptors
//   digikeyLookup→ optional metadata enrichment
//   addStepFile  → stage a user-supplied STEP for a part missing one
//   writeLibrary → backup, insert-only symbol append, footprint copy+enrich+link,
//                  model copy (renamed to symbol name), validate, atomic replace.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const config = require('../config');

// ---------------------------------------------------------------------------
// ZIP extraction (dependency-free): Windows ships bsdtar (tar.exe) which reads
// .zip; fall back to PowerShell Expand-Archive.
// ---------------------------------------------------------------------------
function extractArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120000 }, (err) => {
      if (!err) return resolve();
      execFile('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`
      ], { timeout: 120000 }, (err2) => {
        if (err2) reject(new Error('ZIP extraction failed: ' + err2.message));
        else resolve();
      });
    });
  });
}

// Recursively collect files matching a filter.
async function walkFiles(dir, filterFn, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, filterFn, out);
    else if (filterFn(full)) out.push(full);
  }
  return out;
}

// Find the first *.pretty directory under root (returns its path or null).
async function firstPrettyDir(root) {
  let stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().endsWith('.pretty')) return full;
        stack.push(full);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// S-expression helpers (whitespace/EOL-agnostic — KiCad files are S-expr)
// ---------------------------------------------------------------------------

// Extract complete TOP-LEVEL (symbol "...") blocks from a .kicad_sym, skipping
// the nested unit sub-symbols. Robust to tabs/spaces and CRLF/LF.
function extractSymbolBlocks(content) {
  const blocks = [];
  let depth = 0, quote = false, i = 0;
  while (i < content.length) {
    const c = content[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') quote = false;
      i++; continue;
    }
    if (c === '"') { quote = true; i++; continue; }
    if (c === '(') {
      // Is this the start of a top-level symbol? (direct child of the lib root → depth 1)
      const rest = content.slice(i + 1, i + 8);
      if (depth === 1 && /^symbol[\s"]/.test(rest)) {
        const start = i;
        const end = matchParen(content, i);
        if (end === -1) break;
        blocks.push(content.slice(start, end));
        i = end;
        continue;
      }
      depth++; i++; continue;
    }
    if (c === ')') { depth--; i++; continue; }
    i++;
  }
  return blocks;
}

// Given index of an opening '(', return the index just past its matching ')'.
function matchParen(text, openIdx) {
  let depth = 0, quote = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// True if every paren is balanced (ignoring parens inside quoted strings).
function parensBalanced(s) {
  let depth = 0, quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === '"') quote = false; continue; }
    if (c === '"') { quote = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return false; }
  }
  return depth === 0 && !quote;
}

const escVal = (v) => String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Read the first property value matching key (handles inline + multiline).
function getPropValue(block, key) {
  const re = new RegExp('\\(property\\s+"' + escRe(key) + '"\\s+"((?:[^"\\\\]|\\\\.)*)"');
  const m = block.match(re);
  return m ? m[1] : null;
}

// Replace an existing property's value; returns null if the property isn't present.
function replacePropValue(block, key, value) {
  const re = new RegExp('(\\(property\\s+"' + escRe(key) + '"\\s+")(?:[^"\\\\]|\\\\.)*(")');
  if (!re.test(block)) return null;
  return block.replace(re, (m, p1, p2) => p1 + escVal(value) + p2);
}

// Find the char index just past the end of the named property (depth-matched).
function propertyEnd(block, key) {
  const re = new RegExp('\\(property\\s+"' + escRe(key) + '"');
  const m = re.exec(block);
  if (!m) return -1;
  return matchParen(block, m.index);
}

// Detect the indentation (leading whitespace) of the first property in a symbol block.
function detectPropIndent(block) {
  const m = block.match(/(^|\n)([ \t]+)\(property\s+"/);
  return m ? m[2] : '    ';
}

// Build a KiCad-9 symbol property (hidden by default — metadata is attached, the
// user can unhide/position fields in KiCad as desired).
function symPropBlock(key, value, indent) {
  const i2 = indent + '\t';
  return `${indent}(property "${escVal(key)}" "${escVal(value)}"\n` +
         `${i2}(at 0 0 0)\n` +
         `${i2}(effects\n${i2}\t(font\n${i2}\t\t(size 1.27 1.27)\n${i2}\t)\n${i2}\t(hide yes)\n${i2})\n` +
         `${indent})`;
}

// Build a KiCad-9 footprint property (custom props carry a uuid).
function fpPropBlock(key, value) {
  return `\t(property "${escVal(key)}" "${escVal(value)}"\n` +
         `\t\t(at 0 0 0)\n\t\t(layer "F.Fab")\n\t\t(hide yes)\n` +
         `\t\t(uuid "${crypto.randomUUID()}")\n` +
         `\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)`;
}

// Set (replace if present, else insert after `afterKey`) a property in a block,
// using the provided block-builder. Returns the modified block.
function setProp(block, key, value, builder, afterKey) {
  if (value == null || value === '') return block;
  const replaced = replacePropValue(block, key, value);
  if (replaced != null) return replaced;
  const insertAt = propertyEnd(block, afterKey);
  if (insertAt === -1) return block; // no anchor — skip rather than risk corruption
  const piece = builder(key, value);
  return block.slice(0, insertAt) + '\n' + piece + block.slice(insertAt);
}

// ---------------------------------------------------------------------------
// DigiKey parameter cleaning + component-type heuristics
// ---------------------------------------------------------------------------
function cleanParameterValue(value) {
  if (!value) return null;
  value = String(value).trim();
  if (['n/a', 'unknown', '', '-', 'not verified'].includes(value.toLowerCase())) return null;
  return value;
}

function getEssentialParameters(params) {
  const result = {};
  if (params['Mounting Type']) result['Mounting Type'] = params['Mounting Type'];
  if (params['Operating Temperature']) result['Operating Temperature'] = params['Operating Temperature'];
  return result;
}

function pick(params, pairs, result) {
  for (const [dkName, cleanName] of pairs) {
    const val = params[dkName];
    if (val) result[cleanName] = val;
  }
}

function getComponentSpecificParameters(description, params) {
  const result = {};
  const desc = (description || '').toLowerCase();
  const has = (words) => words.some(w => desc.includes(w));

  if (has(['mosfet', 'fet', 'transistor']) || 'FET Type' in params) {
    pick(params, [
      ['Drain to Source Voltage (Vdss)', 'Drain-Source Voltage'],
      ['Current - Continuous Drain (Id) @ 25°C', 'Continuous Drain Current'],
      ['Rds On (Max) @ Id, Vgs', 'Rds On'],
      ['Vgs(th) (Max) @ Id', 'Gate Threshold Voltage'],
      ['Gate Charge (Qg) (Max) @ Vgs', 'Gate Charge'],
      ['Input Capacitance (Ciss) (Max) @ Vds', 'Input Capacitance'],
      ['FET Type', 'FET Type'],
      ['Technology', 'Technology'],
    ], result);
  } else if (has(['connector', 'receptacle', 'plug', 'socket', 'jack'])) {
    pick(params, [
      ['Connector Type', 'Connector Type'],
      ['Number of Positions', 'Number of Positions'],
      ['Number of Rows', 'Number of Rows'],
      ['Pitch', 'Pitch'],
      ['Current Rating (Amps)', 'Current Rating'],
      ['Voltage - Rated', 'Voltage Rating'],
      ['Contact Finish', 'Contact Finish'],
    ], result);
  } else if (has(['ic ', 'chip', 'regulator', 'converter', 'charger', 'controller'])) {
    pick(params, [
      ['Voltage - Supply', 'Supply Voltage'],
      ['Voltage - Input', 'Input Voltage'],
      ['Voltage - Output', 'Output Voltage'],
      ['Current - Supply', 'Supply Current'],
      ['Current - Output / Channel', 'Output Current'],
      ['Number of Outputs', 'Number of Outputs'],
      ['Interface', 'Interface'],
      ['Protocol', 'Protocol'],
    ], result);
  } else if (has(['resistor', 'capacitor', 'inductor', 'thermistor'])) {
    pick(params, [
      ['Resistance', 'Resistance'],
      ['Capacitance', 'Capacitance'],
      ['Inductance', 'Inductance'],
      ['Tolerance', 'Tolerance'],
      ['Voltage - Rated', 'Voltage Rating'],
      ['Power (Watts)', 'Power Rating'],
      ['Temperature Coefficient', 'Temperature Coefficient'],
    ], result);
  } else if (has(['diode', 'rectifier', 'tvs', 'zener', 'schottky'])) {
    pick(params, [
      ['Voltage - DC Reverse (Vr) (Max)', 'Reverse Voltage'],
      ['Current - Average Rectified (Io)', 'Current Rating'],
      ['Voltage - Forward (Vf) (Max) @ If', 'Forward Voltage'],
    ], result);
  } else if (has(['relay'])) {
    pick(params, [
      ['Contact Form', 'Contact Form'],
      ['Voltage - Switching', 'Contact Voltage'],
      ['Current - Switching', 'Contact Current'],
      ['Coil Type', 'Coil Type'],
      ['Voltage - Coil (Nominal)', 'Coil Voltage'],
    ], result);
  } else if (has(['battery', 'charger', 'protection'])) {
    pick(params, [
      ['Battery Chemistry', 'Battery Chemistry'],
      ['Number of Cells', 'Number of Cells'],
      ['Charge Current - Max', 'Max Charge Current'],
      ['Fault Protection', 'Fault Protection'],
    ], result);
  }

  if (Object.keys(result).length === 0) {
    pick(params, [
      ['Voltage - Supply', 'Supply Voltage'],
      ['Current - Supply', 'Supply Current'],
      ['Power - Max', 'Max Power'],
    ], result);
  }
  return result;
}

function parseProductData(data, mpn) {
  const rawParams = {};
  for (const p of (data.Parameters || [])) rawParams[p.ParameterText || ''] = p.ValueText || '';

  const variations = data.ProductVariations || [];
  let pricing, dkPn;
  if (variations.length) {
    pricing = variations[0].StandardPricing || [];
    dkPn = variations[0].DigiKeyProductNumber || 'N/A';
  } else {
    pricing = data.StandardPricing || [];
    dkPn = data.DigiKeyProductNumber || 'N/A';
  }
  const price = pricing.length ? (pricing[0].UnitPrice ?? 'N/A') : 'N/A';

  const descObj = data.Description;
  let description, detailedDescription;
  if (descObj && typeof descObj === 'object') {
    description = descObj.ProductDescription || '';
    detailedDescription = descObj.DetailedDescription || '';
  } else {
    description = data.ProductDescription || '';
    detailedDescription = data.DetailedDescription || '';
  }

  let pkg = rawParams['Package / Case'] || '';
  if (!pkg || ['unknown', '-'].includes(pkg.toLowerCase())) {
    pkg = rawParams['Supplier Device Package'] || '';
  }

  const cleanedParams = {
    ...getEssentialParameters(rawParams),
    ...getComponentSpecificParameters(description, rawParams),
  };

  return {
    digikey_pn: dkPn,
    mpn: data.ManufacturerProductNumber || mpn,
    manufacturer: (data.Manufacturer || {}).Name || 'Unknown',
    description,
    detailed_description: detailedDescription,
    stock: data.QuantityAvailable || 0,
    unit_price: price,
    datasheet: data.DatasheetUrl || '',
    package: pkg || 'Unknown',
    mounting_type: rawParams['Mounting Type'] || '',
    cleaned_parameters: cleanedParams,
    product_url: data.ProductUrl || '',
  };
}

// ---------------------------------------------------------------------------
// DigiKey API (OAuth2 client-credentials → product lookup)
// ---------------------------------------------------------------------------
function resolveCreds(creds) {
  const clientId = (creds && creds.clientId) || config.DIGIKEY_CLIENT_ID || '';
  const clientSecret = (creds && creds.clientSecret) || config.DIGIKEY_CLIENT_SECRET || '';
  return { clientId, clientSecret };
}

async function getToken(clientId, clientSecret) {
  const r = await fetch('https://api.digikey.com/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!r.ok) throw new Error(`DigiKey token request failed (${r.status})`);
  return (await r.json()).access_token;
}

async function tryProductDetails(mpn, headers) {
  try {
    const url = `https://api.digikey.com/products/v4/search/${encodeURIComponent(mpn)}/productdetails`;
    const r = await fetch(url, { headers });
    if (r.status === 200) return (await r.json()).Product || {};
  } catch {}
  return null;
}

async function trySearch(mpn, headers) {
  try {
    const r = await fetch('https://api.digikey.com/products/v4/search/keyword', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Keywords: mpn, Limit: 10, Offset: 0 }),
    });
    if (r.status === 200) return (await r.json()).Products || [];
  } catch {}
  return [];
}

function isValidProductData(data) {
  if (!data) return false;
  const mfg = (data.Manufacturer || {}).Name || '';
  return mfg && !['unknown', ''].includes(mfg.toLowerCase());
}

function ambiguousDisplay(match, index) {
  return {
    index,
    mpn: match.ManufacturerProductNumber || 'N/A',
    manufacturer: (match.Manufacturer || {}).Name || 'Unknown',
    digikey_pn: match.DigiKeyProductNumber || 'N/A',
    description: match.ProductDescription || (match.Description || {}).ProductDescription || '',
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Library targeting: derive the 3-folder governance layout from a .kicad_sym
// ---------------------------------------------------------------------------
async function resolveLibraryDescriptor(symLib) {
  if (!fs.existsSync(symLib)) return { error: 'Library file not found: ' + symLib };
  const libName = path.basename(symLib, '.kicad_sym');
  // symLib = <root>/symbols/<Lib>.kicad_sym  →  root = grandparent
  const symbolsDir = path.dirname(symLib);
  const sharedRoot = path.dirname(symbolsDir);

  // Footprint library (.pretty) named after the symbol lib, else first .pretty found.
  let fpLib = path.join(sharedRoot, 'footprints', `${libName}.pretty`);
  if (!fs.existsSync(fpLib)) {
    const found = await firstPrettyDir(path.join(sharedRoot, 'footprints'));
    if (found) fpLib = found;
  }
  const fpNickname = path.basename(fpLib, '.pretty');

  // Detect the 3D-model ref dir by scanning an existing footprint's (model "...") line.
  let modelRefDir = `\${SHARED_LIBRARY_PATH}/3dmodels/${libName}_3dmodels`;
  try {
    const mods = await walkFiles(fpLib, f => f.toLowerCase().endsWith('.kicad_mod'));
    for (const mod of mods) {
      const txt = await fsp.readFile(mod, 'utf-8');
      const m = txt.match(/\(model\s+"([^"]+)"/);
      if (m) {
        const slash = m[1].lastIndexOf('/');
        if (slash > 0) { modelRefDir = m[1].slice(0, slash); break; }
      }
    }
  } catch {}

  // Physical model dir: map ${SHARED_LIBRARY_PATH} → sharedRoot.
  const rel = modelRefDir.replace(/^\$\{SHARED_LIBRARY_PATH\}[\\/]/, '');
  const modelDir = path.isAbsolute(rel) ? rel : path.join(sharedRoot, rel);

  // Existing header version so we never downgrade.
  let symVersion = '20241209';
  try {
    const head = await fsp.readFile(symLib, 'utf-8');
    const v = head.slice(0, 400).match(/\(version\s+(\d+)\)/);
    if (v) symVersion = v[1];
  } catch {}

  return { symLib, libName, sharedRoot, fpLib, fpNickname, modelRefDir, modelDir, symVersion };
}

module.exports = function registerKicadImporter(getMainWindow) {

  // --- File / folder pickers ---------------------------------------------
  ipcMain.handle('kicad:selectZips', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select ZIPs (UltraLibrarian / SnapMagic)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('kicad:selectOutputFolder', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select Output Folder', properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // Pick the existing library's .kicad_sym, then derive the full 3-folder layout.
  ipcMain.handle('kicad:selectExistingLibrary', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select the library .kicad_sym (e.g. Big_Blue_Library.kicad_sym)',
      properties: ['openFile'],
      filters: [{ name: 'KiCad Symbol Library', extensions: ['kicad_sym'] }],
    });
    if (res.canceled) return null;
    return resolveLibraryDescriptor(res.filePaths[0]);
  });

  // Re-derive the descriptor from a saved path (one-click "Append to Big Blue").
  ipcMain.handle('kicad:resolveLibrary', async (event, { symLib }) => {
    if (!symLib) return { error: 'No saved library' };
    return resolveLibraryDescriptor(symLib);
  });

  ipcMain.handle('kicad:selectStepFile', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select STEP or ZIP File', properties: ['openFile'],
      filters: [{ name: '3D Model Files', extensions: ['step', 'stp', 'zip'] }, { name: 'All Files', extensions: ['*'] }],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('kicad:getDigikeyDefaults', async () => ({
    clientId: config.DIGIKEY_CLIENT_ID || '',
    clientSecret: config.DIGIKEY_CLIENT_SECRET || '',
  }));

  // --- Stage 1: extract ZIPs into a temp staging dir (NO library writes) --
  // Returns { parts: { mpn: {...} }, mpns, stageDir, logs }
  ipcMain.handle('kicad:extractZips', async (event, { zips }) => {
    const stageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kicad-stage-'));
    const parts = {};
    const mpns = new Set();
    const logs = [];
    const log = (m) => logs.push(m);

    for (const zipPath of zips) {
      const base = path.basename(zipPath);
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kicad-zip-'));
      try {
        await extractArchive(zipPath, tmp);

        const symFiles = await walkFiles(tmp, f => f.toLowerCase().endsWith('.kicad_sym'));
        if (!symFiles.length) { log(`No symbol in ${base}`); continue; }

        const content = await fsp.readFile(symFiles[0], 'utf-8');
        const symbolBlocks = extractSymbolBlocks(content);
        if (!symbolBlocks.length) { log(`No symbol blocks found in ${base}`); continue; }

        // Footprints — stage the .kicad_mod files (prefer those in a .pretty dir).
        const fpStaged = [];
        const prettyPath = await firstPrettyDir(tmp);
        const modSrc = prettyPath
          ? await walkFiles(prettyPath, f => f.toLowerCase().endsWith('.kicad_mod'))
          : await walkFiles(tmp, f => f.toLowerCase().endsWith('.kicad_mod'));
        for (const mod of modSrc) {
          const dest = path.join(stageDir, path.basename(mod));
          await fsp.copyFile(mod, dest).catch(() => {});
          fpStaged.push({ name: path.basename(mod, '.kicad_mod'), path: dest });
        }

        // 3D models — stage step/stp/wrl.
        const modelStaged = [];
        for (const ext of ['.step', '.stp', '.wrl']) {
          const steps = await walkFiles(tmp, f => f.toLowerCase().endsWith(ext));
          for (const s of steps) {
            const dest = path.join(stageDir, path.basename(s));
            await fsp.copyFile(s, dest).catch(() => {});
            modelStaged.push({ ext: ext.slice(1), path: dest });
          }
        }
        const hasStep = modelStaged.some(m => m.ext === 'step' || m.ext === 'stp');

        for (const block of symbolBlocks) {
          const nameM = block.match(/\(symbol\s+"([^"]+)"/);
          const origName = nameM ? nameM[1] : 'Unknown';
          const mpn = getPropValue(block, 'Value') || origName;
          mpns.add(mpn);
          // Prefer the nominal footprint (UltraLibrarian also ships -L/-M variants).
          const nominalFp = fpStaged.find(f => !/-[LMN]$/i.test(f.name)) || fpStaged[0];
          parts[mpn] = {
            mpn, origName, symbolBlock: block,
            fpStaged, modelStaged, hasStep,
            fpSourceName: nominalFp ? nominalFp.name : null,
          };
        }
      } catch (e) {
        log(`Error ${base}: ${e.message}`);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    }

    return { parts, mpns: [...mpns], stageDir, logs };
  });

  // --- Stage 2: DigiKey lookup for a batch of MPNs ----------------------
  ipcMain.handle('kicad:digikeyLookup', async (event, { mpns, creds }) => {
    const { clientId, clientSecret } = resolveCreds(creds);
    const results = {};
    const logs = [];
    const log = (m) => logs.push(m);
    if (!clientId || !clientSecret) {
      for (const mpn of mpns) results[mpn] = { error: 'DigiKey credentials not configured' };
      return { results, logs: ['DigiKey credentials not configured — skipping enrichment'] };
    }
    let headers;
    try {
      const token = await getToken(clientId, clientSecret);
      headers = {
        Authorization: `Bearer ${token}`,
        'X-DIGIKEY-Client-Id': clientId,
        'X-DIGIKEY-Locale-Site': 'US',
        Accept: 'application/json',
      };
    } catch (e) {
      for (const mpn of mpns) results[mpn] = { error: e.message };
      return { results, logs: [`DigiKey auth failed: ${e.message}`] };
    }

    for (const mpn of mpns) {
      log(`Fetching data for: ${mpn}`);
      const productData = await tryProductDetails(mpn, headers);
      if (productData && isValidProductData(productData)) {
        results[mpn] = parseProductData(productData, mpn);
        await sleep(700);
        continue;
      }
      log(`  → Using search fallback for: ${mpn}`);
      const searchResults = await trySearch(mpn, headers);
      if (!searchResults.length) { results[mpn] = { error: 'No results found' }; continue; }

      const exact = searchResults.filter(p => (p.ManufacturerProductNumber || '').toUpperCase() === mpn.toUpperCase());
      if (exact.length >= 1) {
        log(`  ✓ Found ${exact.length} exact match(es), using first`);
        results[mpn] = parseProductData(exact[0], mpn);
      } else if (searchResults.length > 0) {
        log(`  ⚠ Found ${searchResults.length} non-exact matches — needs user selection`);
        results[mpn] = {
          ambiguous: true,
          matches: searchResults.map((m, i) => ({ display: ambiguousDisplay(m, i), parsed: parseProductData(m, mpn) })),
        };
      } else {
        results[mpn] = { error: 'No matches found' };
      }
      await sleep(700);
    }
    return { results, logs };
  });

  // --- Stage 3: stage a user-provided STEP for a missing part -----------
  ipcMain.handle('kicad:addStepFile', async (event, { filePath, stageDir }) => {
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === '.zip') {
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kicad-step-'));
        try {
          await extractArchive(filePath, tmp);
          const steps = await walkFiles(tmp, f => /\.(step|stp)$/i.test(f));
          if (!steps.length) return { error: 'No STEP file found in ZIP' };
          const dest = path.join(stageDir, path.basename(steps[0]));
          await fsp.copyFile(steps[0], dest);
          return { modelStaged: { ext: path.extname(steps[0]).slice(1).toLowerCase(), path: dest } };
        } finally {
          await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
      } else if (ext === '.step' || ext === '.stp') {
        const dest = path.join(stageDir, path.basename(filePath));
        await fsp.copyFile(filePath, dest);
        return { modelStaged: { ext: ext.slice(1), path: dest } };
      }
      return { error: `Unsupported file type: ${ext}` };
    } catch (e) {
      return { error: e.message };
    }
  });

  // --- Stage 4: commit — backup, insert-only append, footprint+model link
  ipcMain.handle('kicad:writeLibrary', async (event, opts) => {
    const { descriptor, parts, stageDir } = opts;
    const { symLib, fpLib, fpNickname, modelDir, modelRefDir } = descriptor;
    const logs = [];
    const log = (m) => logs.push(m);

    if (!fs.existsSync(symLib)) return { error: 'Library symbol file not found: ' + symLib, logs };

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

    // 1) BACKUP the symbol library before touching it.
    const backupPath = symLib.replace(/\.kicad_sym$/, `.${stamp}.bak`);
    await fsp.copyFile(symLib, backupPath);
    log(`Backup created: ${path.basename(backupPath)}`);

    const orig = await fsp.readFile(symLib, 'utf-8');
    const eol = orig.includes('\r\n') ? '\r\n' : '\n';

    // Collect existing symbol names for dedup.
    const existing = new Set();
    for (const m of orig.matchAll(/\(symbol\s+"([^"]+)"/g)) existing.add(m[1]);

    const newBlocks = [];
    let added = 0, skipped = 0;

    for (const part of parts) {
      const { symbolName, footprintName, fields = {}, symbolBlock, origName, modelStaged = [], fpStaged = [] } = part;
      if (!symbolName) { log(`Skipping a part with no symbol name`); continue; }
      if (existing.has(symbolName)) { log(`Skipping duplicate symbol: ${symbolName}`); skipped++; continue; }

      // --- Build the symbol block (rename + enrich) ---
      let block = symbolBlock;
      const indent = detectPropIndent(block);
      // Rename parent + unit sub-symbols so units stay associated.
      block = block.split(`(symbol "${origName}"`).join(`(symbol "${symbolName}"`);
      block = block.split(`(symbol "${origName}_`).join(`(symbol "${symbolName}_`);

      // Footprint link.
      if (footprintName) {
        block = setProp(block, 'Footprint', `${fpNickname}:${footprintName}`, (k, v) => symPropBlock(k, v, indent), 'Value');
      }
      // Metadata fields (Datasheet replaces the existing one; the rest are added hidden).
      for (const [k, v] of Object.entries(fields)) {
        block = setProp(block, k, v, (kk, vv) => symPropBlock(kk, vv, indent), 'Value');
      }
      newBlocks.push(block.replace(/\r?\n/g, eol).replace(/\s+$/, ''));
      existing.add(symbolName);

      // --- Footprint(s): copy, rename, enrich, link model ---
      const primaryModel = modelStaged.find(m => m.ext === 'step' || m.ext === 'stp') || modelStaged[0];
      const nominalFp = fpStaged.find(f => !/-[LMN]$/i.test(f.name)) || fpStaged[0];
      const fpToWrite = fpStaged.length ? [nominalFp] : [];
      for (const fp of fpToWrite) {
        if (!footprintName) break;
        try {
          let fpTxt = await fsp.readFile(fp.path, 'utf-8');
          // Rename internal footprint token.
          fpTxt = fpTxt.replace(/\(footprint\s+"([^"]+)"/, `(footprint "${footprintName}"`);
          // Link/replace the 3D model path (preserve vendor offset/scale/rotate).
          if (primaryModel) {
            const modelRef = `${modelRefDir}/${symbolName}.${primaryModel.ext}`;
            if (/\(model\s+"/.test(fpTxt)) {
              fpTxt = fpTxt.replace(/(\(model\s+")[^"]*(")/, (m, p1, p2) => p1 + modelRef + p2);
            } else {
              const last = fpTxt.lastIndexOf(')');
              const modelBlock = `\t(model "${modelRef}"\n\t\t(offset (xyz 0 0 0))\n\t\t(scale (xyz 1 1 1))\n\t\t(rotate (xyz 0 0 0))\n\t)\n`;
              fpTxt = fpTxt.slice(0, last) + modelBlock + fpTxt.slice(last);
            }
          }
          // Mirror metadata onto the footprint (governance §4.2.2) — insert before the
          // footprint's closing paren so it works for old- and new-format .kicad_mod.
          const props = [];
          for (const [k, v] of Object.entries(fields)) {
            if (v && !new RegExp('\\(property\\s+"' + escRe(k) + '"').test(fpTxt)) props.push(fpPropBlock(k, v));
          }
          if (props.length) {
            const fend = fpTxt.lastIndexOf(')');
            if (fend !== -1) fpTxt = fpTxt.slice(0, fend) + props.join('\n') + '\n' + fpTxt.slice(fend);
          }
          const fpDest = path.join(fpLib, `${footprintName}.kicad_mod`);
          if (fs.existsSync(fpDest)) {
            await fsp.copyFile(fpDest, fpDest.replace(/\.kicad_mod$/, `.${stamp}.bak`));
            log(`  Backed up existing footprint: ${footprintName}.kicad_mod`);
          }
          await fsp.mkdir(fpLib, { recursive: true });
          await fsp.writeFile(fpDest, fpTxt, 'utf-8');
          log(`  Footprint written: ${footprintName}.kicad_mod`);
        } catch (e) {
          log(`  ! Footprint error for ${symbolName}: ${e.message}`);
        }
      }

      // --- 3D model(s): copy renamed to the symbol name (strict governance) ---
      for (const mdl of modelStaged) {
        try {
          await fsp.mkdir(modelDir, { recursive: true });
          const dest = path.join(modelDir, `${symbolName}.${mdl.ext}`);
          await fsp.copyFile(mdl.path, dest);
          log(`  3D model: ${symbolName}.${mdl.ext}`);
        } catch (e) {
          log(`  ! 3D model error for ${symbolName}: ${e.message}`);
        }
      }

      added++;
    }

    if (!newBlocks.length) {
      log('No new symbols to add.');
      return { added, skipped, backupPath, symLib, logs };
    }

    // 2) INSERT-ONLY: splice the new blocks in before the final top-level ')'.
    const tail = (orig.match(/\s*$/) || [''])[0];
    const core = orig.slice(0, orig.length - tail.length); // ends with ')'
    const insertAt = core.length - 1;
    const blocksText = newBlocks.join(eol + eol) + eol;
    const next = core.slice(0, insertAt) + blocksText + core.slice(insertAt) + tail;

    // 3) VALIDATE before replacing — abort (keeping the original intact) if malformed.
    if (!parensBalanced(next)) {
      return { error: 'Aborted: result failed paren-balance validation. Original library untouched; backup at ' + path.basename(backupPath), logs };
    }

    const tempFile = symLib + '.tmp';
    await fsp.writeFile(tempFile, next, 'utf-8');
    await fsp.rm(symLib, { force: true });
    await fsp.rename(tempFile, symLib);

    // Clean up the staging dir.
    if (stageDir) await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});

    log(`Done — ${added} symbol(s) appended, ${skipped} skipped. Backup: ${path.basename(backupPath)}`);
    return { added, skipped, backupPath, symLib, logs };
  });
};
