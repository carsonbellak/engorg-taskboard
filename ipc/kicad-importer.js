// IPC handlers: KiCad library importer — consolidates UltraLibrarian / SnapMagic
// ZIP exports into one .kicad_sym + .pretty + 3D_Models set, with optional DigiKey
// metadata enrichment. Ported from the user's kicadImporter.py.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
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
      // Fallback: PowerShell Expand-Archive
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

// Recursively collect files matching a set of lowercase extensions.
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

// ---------------------------------------------------------------------------
// DigiKey parameter cleaning + component-type heuristics (from the .py)
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

module.exports = function registerKicadImporter(getMainWindow) {
  const dlgOpts = () => ({});

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

  ipcMain.handle('kicad:selectExistingLibrary', async () => {
    const res = await dialog.showOpenDialog(getMainWindow(), {
      title: 'Select Folder Containing Existing Library', properties: ['openDirectory'],
    });
    if (res.canceled) return null;
    const folder = res.filePaths[0];
    const syms = (await fsp.readdir(folder)).filter(f => f.endsWith('.kicad_sym'));
    if (!syms.length) return { error: 'No .kicad_sym file found in this folder!' };
    return { folder, libName: path.basename(syms[0], '.kicad_sym') };
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

  // --- Stage 1: extract ZIPs into the target library --------------------
  // Returns { partInfo, mpns, symLib, fpLib, modelDir }
  ipcMain.handle('kicad:extractZips', async (event, { zips, outputFolder, libName }) => {
    libName = (libName || '').trim() || 'My_Imported_FULL';
    const out = outputFolder;
    const symLib = path.join(out, `${libName}.kicad_sym`);
    const fpLib = path.join(out, `${libName}.pretty`);
    const modelDir = path.join(out, '3D_Models');
    await fsp.mkdir(fpLib, { recursive: true });
    await fsp.mkdir(modelDir, { recursive: true });

    const partInfo = {};
    const mpns = new Set();
    const logs = [];
    const log = (m) => logs.push(m);

    for (const zipPath of zips) {
      const base = path.basename(zipPath);
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kicad-imp-'));
      try {
        await extractArchive(zipPath, tmp);

        const symFiles = await walkFiles(tmp, f => f.toLowerCase().endsWith('.kicad_sym'));
        if (!symFiles.length) { log(`No symbol in ${base}`); continue; }

        const content = await fsp.readFile(symFiles[0], 'utf-8');
        const symbolBlocks = content.match(/\(symbol ".*?"[\s\S]*?\n {2}\)\n/g);
        if (!symbolBlocks) { log(`No clean symbol blocks found in ${base}`); continue; }

        // Footprints
        let fpName = null;
        const allMods = await walkFiles(tmp, f => f.toLowerCase().endsWith('.kicad_mod'));
        const prettyPath = await firstPrettyDir(tmp);
        if (prettyPath) {
          const mods = await walkFiles(prettyPath, f => f.toLowerCase().endsWith('.kicad_mod'));
          for (const mod of mods) {
            const dest = path.join(fpLib, path.basename(mod));
            if (!fs.existsSync(dest)) await fsp.copyFile(mod, dest);
            fpName = `${libName}:${path.basename(mod, '.kicad_mod')}`;
          }
        } else if (allMods.length) {
          const mpnGuess = path.basename(zipPath, '.zip').split('_')[0];
          const dest = path.join(fpLib, `${mpnGuess}.kicad_mod`);
          if (!fs.existsSync(dest)) await fsp.copyFile(allMods[0], dest);
          fpName = `${libName}:${mpnGuess}`;
        }

        // 3D model
        let modelPath = null;
        for (const ext of ['.step', '.stp', '.wrl']) {
          const steps = await walkFiles(tmp, f => f.toLowerCase().endsWith(ext));
          if (steps.length) {
            const dest = path.join(modelDir, path.basename(steps[0]));
            if (!fs.existsSync(dest)) await fsp.copyFile(steps[0], dest);
            modelPath = `\${KIPRJMOD}/../3D_Models/${path.basename(steps[0])}`;
            break;
          }
        }

        for (const block of symbolBlocks) {
          const m = block.match(/\(property "Value" "([^"]+)"/);
          const mpn = m ? m[1] : 'Unknown';
          mpns.add(mpn);
          partInfo[mpn] = { content: block, footprint: fpName, model3d: modelPath, has_step: modelPath !== null };
        }
      } catch (e) {
        log(`Error ${base}: ${e.message}`);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    }

    return { partInfo, mpns: [...mpns], symLib, fpLib, modelDir, logs };
  });

  // --- Stage 2: DigiKey lookup for a batch of MPNs ----------------------
  // Returns { results: { mpn: parsed | { error } | { ambiguous, matches:[{display,parsed}] } }, logs }
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

  // --- Stage 3: add a user-provided STEP file for a missing part --------
  ipcMain.handle('kicad:addStepFile', async (event, { mpn, filePath, modelDir }) => {
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === '.zip') {
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kicad-step-'));
        try {
          await extractArchive(filePath, tmp);
          const steps = await walkFiles(tmp, f => /\.(step|stp)$/i.test(f));
          if (!steps.length) return { error: 'No STEP file found in ZIP' };
          const dest = path.join(modelDir, `${mpn}${path.extname(steps[0])}`);
          await fsp.copyFile(steps[0], dest);
          return { model3d: `\${KIPRJMOD}/../3D_Models/${path.basename(dest)}` };
        } finally {
          await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
      } else if (ext === '.step' || ext === '.stp') {
        const dest = path.join(modelDir, `${mpn}${ext}`);
        await fsp.copyFile(filePath, dest);
        return { model3d: `\${KIPRJMOD}/../3D_Models/${path.basename(dest)}` };
      }
      return { error: `Unsupported file type: ${ext}` };
    } catch (e) {
      return { error: e.message };
    }
  });

  // --- Stage 4: write / append the consolidated .kicad_sym --------------
  ipcMain.handle('kicad:writeLibrary', async (event, opts) => {
    const { partInfo, dkData, options, symLib, appendMode, libName } = opts;
    const logs = [];
    const log = (m) => logs.push(m);

    const findPropertyEnd = (text, startPos) => {
      let depth = 1, i = startPos + 1;
      while (i < text.length) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') { depth--; if (depth === 0) return i + 1; }
        i++;
      }
      return -1;
    };

    const tempFile = symLib.replace(/\.kicad_sym$/, '.tmp');
    const doAppend = appendMode && fs.existsSync(symLib);
    let body = '';
    let existingSymbols = new Set();

    if (doAppend) {
      const content = await fsp.readFile(symLib, 'utf-8');
      let lines = content.split(/\r?\n/);
      for (const line of lines) {
        const s = line.trim();
        if (s.startsWith('(symbol "')) {
          const start = s.indexOf('"') + 1;
          const end = s.indexOf('"', start);
          if (end > start) existingSymbols.add(s.slice(start, end));
        }
      }
      while (lines.length && (!lines[lines.length - 1].trim() || lines[lines.length - 1].trim() === ')')) lines.pop();
      if (lines.length) body = lines.join('\n') + '\n';
      else body = `(kicad_symbol_lib (version 20231120) (generator "KiCad Importer - ${libName}")\n`;
      log(`Appending to library with ${existingSymbols.size} existing symbols`);
    } else {
      body = `(kicad_symbol_lib (version 20231120) (generator "KiCad Importer - ${libName}")\n`;
    }

    let added = 0;
    for (const [mpn, info] of Object.entries(partInfo)) {
      let block = info.content;
      const nameMatch = block.match(/\(symbol "([^"]+)"/);
      if (!nameMatch) continue;
      const symbolName = nameMatch[1];
      if (existingSymbols.has(symbolName)) { log(`Skipping duplicate: ${symbolName}`); continue; }

      const existingIds = [...block.matchAll(/\(id (\d+)\)/g)].map(m => parseInt(m[1], 10));
      let maxId = existingIds.length ? Math.max(...existingIds) : 1;
      const dk = (dkData && dkData[mpn]) || {};

      if (options.footprints && info.footprint) {
        block = block.replace(/\(property "Footprint" "([^"]*)"/, `(property "Footprint" "${info.footprint}"`);
      }
      if (options.digikey && !dk.error) {
        if (dk.datasheet) {
          block = block.replace(/\(property "Datasheet" "([^"]*)"/, `(property "Datasheet" "${dk.datasheet}"`);
        }
      }

      let newFieldsStr = '';
      if (options.digikey && !dk.error && Object.keys(dk).length) {
        const fields = [
          ['MPN', dk.mpn || mpn],
          ['Manufacturer', dk.manufacturer || ''],
          ['Supplier', 'DigiKey'],
          ['Supplier PN', dk.digikey_pn || ''],
          ['Description', dk.description || ''],
          ['Package', dk.package || ''],
        ];
        if (dk.stock) fields.push(['Stock', String(dk.stock)]);
        if (dk.unit_price && dk.unit_price !== 'N/A') fields.push(['Unit Price', String(dk.unit_price)]);
        if (dk.cleaned_parameters) {
          for (const key of Object.keys(dk.cleaned_parameters).sort()) {
            const cv = cleanParameterValue(dk.cleaned_parameters[key]);
            if (cv) fields.push([key, cv]);
          }
        }
        if (dk.detailed_description) fields.push(['ki_description', dk.detailed_description]);

        const newLines = [];
        for (const [key, value] of fields) {
          if (!value || ['unknown', 'n/a'].includes(String(value).toLowerCase())) continue;
          if (!block.includes(`"${key}"`)) {
            maxId++;
            const safe = String(value).replace(/"/g, '\\"');
            newLines.push(`  (property "${key}" "${safe}" (id ${maxId}) (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`);
          }
        }
        newFieldsStr = newLines.length ? newLines.join('\n') + '\n' : '';
      }

      const valueStart = block.search(/\(property "Value"/);
      if (valueStart !== -1) {
        const insertPos = findPropertyEnd(block, valueStart);
        if (insertPos !== -1) block = block.slice(0, insertPos) + '\n' + newFieldsStr + block.slice(insertPos);
        else log(`Warning: Unmatched parens in Value property for ${symbolName} — skipping enrichment`);
      } else {
        log(`Warning: No Value property found in ${symbolName} — skipping enrichment`);
      }

      body += '\n' + block.replace(/\s+$/, '') + '\n';
      added++;
    }

    body += ')\n';
    await fsp.writeFile(tempFile, body, 'utf-8');
    if (fs.existsSync(symLib)) await fsp.rm(symLib, { force: true });
    await fsp.rename(tempFile, symLib);

    const mode = doAppend ? 'appended to' : 'created';
    log(`Done — ${added} symbols ${mode} '${libName}'`);
    return { added, mode, symLib, logs };
  });
};

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
