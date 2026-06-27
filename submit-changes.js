#!/usr/bin/env node
/*
 * submit-changes.js — one-command "push my changes back to the app repo".
 *
 * Goal: let anyone (or Claude) change files in their installed copy of the app
 * and submit them WITHOUT having to know git. The installed app directory is not
 * itself a git checkout, so this script maintains a small cached clone of the
 * canonical repo, mirrors your changed source files into it, commits, and pushes
 * (or opens a PR branch). Git handles line-ending normalization and auth.
 *
 * Usage:
 *   node submit-changes.js --list                 # show what changed (no push)
 *   node submit-changes.js -m "Fix the thing"     # commit + push to main
 *   node submit-changes.js -m "..." --branch foo  # push to branch 'foo' instead
 *   node submit-changes.js -m "..." --pr          # push to an auto-named branch and print a PR-compare link
 *
 * Notes:
 *   - Pushing to main / a branch on the upstream repo requires push access
 *     (you're the owner, or a collaborator). Contributors without access should
 *     use the in-app Settings → Contribute → "Submit Changes…" flow, which forks
 *     and opens a PR via GitHub sign-in — no git or push access needed.
 *   - The cached clone lives at ~/.engorg-submit/<repo>. Safe to delete anytime.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const config = require('./config');
const { owner, repo, branch } = config.CONTRIB_REPO;
const REPO_URL = config.CONTRIB_REPO_URL + '.git';
const INSTALL_ROOT = __dirname;
const IGNORE = new Set(config.CONTRIB_IGNORE || ['.git', 'node_modules', 'appdata']);
const CACHE_DIR = path.join(os.homedir(), '.engorg-submit');
const CLONE_DIR = path.join(CACHE_DIR, repo);
// Skip binaries/installer artifacts — this flow is for source/text changes.
const BINARY_EXT = /\.(exe|zip|log|dll|node|wasm|bin|dat|ico|icns|png|jpe?g|gif|webp|woff2?|ttf|otf|mp4|mov|pdf|docx|xlsx|pptx)$/i;

// ---- tiny arg parser ------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--list' || t === '-l') a.list = true;
    else if (t === '--pr') a.pr = true;
    else if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '-m' || t === '--message') a.message = argv[++i];
    else if (t === '--branch' || t === '-b') a.branch = argv[++i];
    else a._.push(t);
  }
  // allow a bare message: `node submit-changes.js "msg"`
  if (!a.message && a._.length) a.message = a._.join(' ');
  return a;
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || CLONE_DIR,
    encoding: 'utf-8',
    stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

function log(msg) { process.stdout.write(msg + '\n'); }
function die(msg) { process.stderr.write('✗ ' + msg + '\n'); process.exit(1); }

// ---- maintain a clean, up-to-date clone of the upstream repo ---------------
function ensureClone() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(path.join(CLONE_DIR, '.git'))) {
    log(`Cloning ${owner}/${repo} → ${CLONE_DIR} …`);
    execFileSync('git', ['clone', '--quiet', REPO_URL, CLONE_DIR], { stdio: 'inherit' });
  } else {
    git(['fetch', '--quiet', 'origin', branch]);
  }
  git(['checkout', '--quiet', branch]);
  git(['reset', '--hard', '--quiet', `origin/${branch}`]);
  git(['clean', '-fd', '-q']);
}

// ---- mirror changed source files from the install into the clone ----------
// Update-only: we copy install files over matching/clone-tracked paths and add
// new source files under already-tracked top-level dirs. We NEVER delete files
// the install lacks (the install is a shipped subset that omits repo-only files
// like .github/, firebase config, build scripts — deleting those would be wrong).
function trackedTopLevel() {
  const tracked = git(['ls-files']).split('\n').filter(Boolean);
  const top = new Set();
  for (const p of tracked) top.add(p.split('/')[0]);
  return top;
}

// First 8KB NUL-byte heuristic — skip binaries even without a known extension.
function looksBinary(abs) {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, 8000, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch { /* unreadable → treat as skippable */ return true; }
  return false;
}

function walk(absDir, rel, allowTop, out) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      // Only descend into top-level dirs the repo tracks (skips runtime dirs like
      // nodejs/tools). New files inside an already-tracked dir still get picked up.
      if (rel === '' && allowTop && !allowTop.has(e.name)) continue;
      walk(abs, r, allowTop, out);
    } else if (e.isFile()) {
      // Root files (incl. brand-new ones) are always eligible; skip binaries.
      if (BINARY_EXT.test(e.name)) continue;
      if (looksBinary(abs)) continue;
      out.push(r);
    }
  }
}

function syncIntoClone() {
  const allowTop = trackedTopLevel();
  const files = [];
  walk(INSTALL_ROOT, '', allowTop, files);
  let copied = 0;
  for (const rel of files) {
    const src = path.join(INSTALL_ROOT, rel);
    const dst = path.join(CLONE_DIR, rel);
    try {
      const buf = fs.readFileSync(src);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
      copied++;
    } catch { /* skip unreadable */ }
  }
  return copied;
}

function changedList() {
  // git add normalizes line endings (core.autocrlf), so this is the *real* diff.
  git(['add', '-A']);
  const out = git(['diff', '--cached', '--name-status']).trim();
  return out ? out.split('\n').map(l => l.trim()) : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
  catch { die('git is not installed or not on PATH.'); }

  ensureClone();
  syncIntoClone();
  const changes = changedList();

  if (changes.length === 0) {
    log('✓ No changes to submit — your install matches ' + owner + '/' + repo + '@' + branch + '.');
    return;
  }

  log(`\nChanges to submit (${changes.length}):`);
  for (const c of changes) log('  ' + c.replace(/^(\w)\s+/, (m, s) => ({ A: 'add   ', M: 'modify', D: 'delete' }[s] || s) + '  '));

  if (args.list) {
    log('\n(--list only; nothing committed. Re-run with -m "message" to submit.)');
    git(['reset', '--hard', '--quiet', `origin/${branch}`]); // leave the clone clean
    return;
  }

  if (!args.message) die('Provide a commit message: node submit-changes.js -m "what changed"');

  const targetBranch = args.branch || (args.pr ? 'submit/' + Date.now() : branch);
  if (targetBranch !== branch) git(['checkout', '-q', '-b', targetBranch]);

  git(['commit', '--quiet', '-m', args.message]);
  log(`\nCommitted to '${targetBranch}'. Pushing …`);
  try {
    git(['push', '--quiet', '-u', 'origin', targetBranch], { inherit: true });
  } catch (e) {
    die('Push failed (no access, or auth needed). If you don’t have push access, use the in-app Contribute flow instead.\n' + (e.message || ''));
  }

  const sha = git(['rev-parse', '--short', 'HEAD']).trim();
  if (targetBranch === branch) {
    log(`\n✓ Pushed to ${branch} (${sha}). ${config.CONTRIB_REPO_URL}/commit/${sha}`);
  } else {
    log(`\n✓ Pushed branch '${targetBranch}' (${sha}).`);
    log(`  Open a PR: ${config.CONTRIB_REPO_URL}/compare/${branch}...${targetBranch}?expand=1`);
  }
}

main().catch(e => die(e.stack || e.message));
