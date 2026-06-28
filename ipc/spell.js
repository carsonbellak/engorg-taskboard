// IPC handlers: self-contained spell checker for the renderer's note fields.
//
// Uses a bundled word list (renderer/lib/words-en.txt) so it works fully offline —
// no runtime dictionary download (unlike Chromium's built-in checker). Provides
// word-level checking, Norvig-style suggestions, and a persistent user dictionary.
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const WORDS_FILE = path.join(__dirname, '..', 'renderer', 'lib', 'words-en.txt');
const FREQ_FILE = path.join(__dirname, '..', 'renderer', 'lib', 'freq-en.txt');
const USER_DICT_FILE = path.join(config.DATA_DIR, 'spell_user.json');
const ALPHA = 'abcdefghijklmnopqrstuvwxyz';

let DICT = null; // Set<string> of lowercased words (comprehensive — membership/"is it misspelled")
let FREQ = null; // Map<string, number> word → corpus frequency (for ranking suggestions)

function loadUserWords() {
  try { const d = JSON.parse(fs.readFileSync(USER_DICT_FILE, 'utf8')); return Array.isArray(d.words) ? d.words : []; }
  catch { return []; }
}
function saveUserWords(words) {
  try { fs.mkdirSync(path.dirname(USER_DICT_FILE), { recursive: true }); fs.writeFileSync(USER_DICT_FILE, JSON.stringify({ words }, null, 2)); }
  catch {}
}

function ensureLoaded() {
  if (DICT) return;
  DICT = new Set();
  FREQ = new Map();
  try {
    const raw = fs.readFileSync(WORDS_FILE, 'utf8');
    for (const w of raw.split('\n')) { const t = w.trim(); if (t) DICT.add(t); }
  } catch (e) { /* leave dict tiny; check becomes a no-op */ }
  try {
    const raw = fs.readFileSync(FREQ_FILE, 'utf8').replace(/^﻿/, ''); // strip BOM
    for (const line of raw.split('\n')) {
      const sp = line.indexOf(' ');
      if (sp <= 0) continue;
      const word = line.slice(0, sp).trim();
      const count = parseInt(line.slice(sp + 1), 10);
      if (word && count) { FREQ.set(word, count); DICT.add(word); }
    }
  } catch (e) { /* ranking falls back to edit distance only */ }
  for (const w of loadUserWords()) DICT.add(w.toLowerCase());
}

const norm = (w) => w.toLowerCase().replace(/[’]/g, "'");

function inDict(word) {
  const w = norm(word);
  if (DICT.has(w)) return true;
  if (w.endsWith("'s") && DICT.has(w.slice(0, -2))) return true; // possessive
  return false;
}

function tokenize(text) {
  const re = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;
  const out = []; let m;
  while ((m = re.exec(text)) !== null) out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function checkText(text) {
  ensureLoaded();
  if (DICT.size < 100) return []; // dictionary missing — don't flag everything
  const bad = [];
  for (const t of tokenize(text)) {
    if (t.word.length < 3) continue;            // skip very short words
    if (t.word === t.word.toUpperCase()) continue; // skip ALL-CAPS acronyms
    if (/\d/.test(t.word)) continue;
    if (inDict(t.word)) continue;
    bad.push(t);
  }
  return bad;
}

// ---- Norvig suggestions ----------------------------------------------------
function edits1(word) {
  const splits = [];
  for (let i = 0; i <= word.length; i++) splits.push([word.slice(0, i), word.slice(i)]);
  const res = new Set();
  for (const [L, R] of splits) if (R) res.add(L + R.slice(1));                              // delete
  for (const [L, R] of splits) if (R.length > 1) res.add(L + R[1] + R[0] + R.slice(2));     // transpose
  for (const [L, R] of splits) if (R) for (const c of ALPHA) res.add(L + c + R.slice(1));   // replace
  for (const [L, R] of splits) for (const c of ALPHA) res.add(L + c + R);                   // insert
  return res;
}
function known(words) { const r = []; for (const w of words) if (DICT.has(w)) r.push(w); return r; }

function suggest(word) {
  ensureLoaded();
  const w = norm(word);
  if (!w || DICT.has(w)) return [];

  // Candidate → smallest edit distance (1 preferred over 2).
  const dist = new Map();
  const e1 = edits1(w);
  for (const c of e1) if (DICT.has(c)) if (!dist.has(c)) dist.set(c, 1);
  if (dist.size < 8) {
    for (const e of e1) for (const e2 of edits1(e)) if (DICT.has(e2) && !dist.has(e2)) dist.set(e2, 2);
  }

  const arr = [...dist.keys()];
  arr.sort((a, b) => {
    // Closer edit distance wins, but a much more common distance-2 word can still
    // beat a rare distance-1 word — so blend distance with a frequency score.
    const score = (x) => (FREQ.get(x) || 0.5) / (dist.get(x) === 1 ? 1 : 12);
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sb - sa;
    return a.length - b.length || (a < b ? -1 : 1);
  });

  const cap = word[0] === word[0].toUpperCase();
  return arr.slice(0, 7).map((s) => (cap ? s[0].toUpperCase() + s.slice(1) : s));
}

module.exports = function registerSpell() {
  ipcMain.handle('spell:check', async (e, text) => { try { return checkText(text || ''); } catch { return []; } });
  ipcMain.handle('spell:suggest', async (e, word) => { try { return suggest(word || ''); } catch { return []; } });
  ipcMain.handle('spell:add', async (e, word) => {
    ensureLoaded();
    const w = norm(word).replace(/[^a-z']/g, '');
    if (!w) return false;
    DICT.add(w);
    const words = loadUserWords();
    if (!words.includes(w)) { words.push(w); saveUserWords(words); }
    return true;
  });
};
