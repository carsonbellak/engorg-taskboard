#!/usr/bin/env node
/*
 * release.js — one command to cut a versioned release.
 *
 * Bumps the version in package.json + package-lock.json, pushes it to main via
 * submit-changes.js, then pushes a matching vX.Y.Z git tag. From there CI
 * (.github/workflows/release-installer.yml) builds EngOrg-Setup.exe and attaches
 * it to the GitHub Release automatically — no manual download/upload, no polling.
 *
 * Usage:
 *   node release.js                 # patch bump (1.1.2 -> 1.1.3)
 *   node release.js minor           # 1.1.2 -> 1.2.0
 *   node release.js major           # 1.1.2 -> 2.0.0
 *   node release.js 1.4.0           # explicit version
 *   node release.js patch -m "what changed in this release"
 *
 * Requires push access (owner/collaborator) — same as submit-changes.js.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const config = require('./config');

const { owner, repo, branch } = config.CONTRIB_REPO;
const ROOT = __dirname;
const CLONE_DIR = path.join(os.homedir(), '.engorg-submit', repo);

function die(m) { process.stderr.write('✗ ' + m + '\n'); process.exit(1); }

// ---- args -----------------------------------------------------------------
let bump = 'patch', message = '';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-m' || a === '--message') message = argv[++i] || '';
  else if (/^(patch|minor|major)$/.test(a)) bump = a;
  else if (/^\d+\.\d+\.\d+$/.test(a)) bump = a;       // explicit version
  else die('Unknown argument: ' + a);
}

// ---- compute next version -------------------------------------------------
const pkgPath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');
const cur = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
if (!cur) die('No version in package.json');

function nextVersion(cur, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  let [a, b, c] = cur.split('.').map((n) => parseInt(n, 10) || 0);
  if (bump === 'major') { a++; b = 0; c = 0; }
  else if (bump === 'minor') { b++; c = 0; }
  else { c++; }
  return `${a}.${b}.${c}`;
}
const next = nextVersion(cur, bump);
const tag = 'v' + next;
if (next === cur) die('Version unchanged.');

// ---- write versions (string replace so formatting/diffs stay minimal) -----
function bumpFile(file, count) {
  let raw = fs.readFileSync(file, 'utf8');
  let n = 0;
  raw = raw.replace(new RegExp('"version": "' + cur.replace(/\./g, '\\.') + '"', 'g'),
    (m) => (n++ < count ? '"version": "' + next + '"' : m));
  fs.writeFileSync(file, raw);
  return n;
}
bumpFile(pkgPath, 1);
try { bumpFile(lockPath, 2); } catch { /* lock optional */ }
process.stdout.write(`Releasing ${cur} → ${next} (${tag})\n\n`);

// ---- push the bump to main (submit-changes maintains the clone + creds) ----
const commitMsg = `Release ${tag}` + (message ? ': ' + message : '');
execFileSync('node', [path.join(ROOT, 'submit-changes.js'), '-m', commitMsg], { cwd: ROOT, stdio: 'inherit' });

// ---- tag the release commit and push the tag ------------------------------
if (!fs.existsSync(path.join(CLONE_DIR, '.git'))) die('Cached clone missing — run `node submit-changes.js --list` once first.');
const git = (args) => execFileSync('git', args, { cwd: CLONE_DIR, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
git(['fetch', 'origin', '--quiet']);
const tagMsg = `EngOrg ${tag}` + (message ? '\n\n' + message : '');
git(['tag', '-a', tag, `origin/${branch}`, '-m', tagMsg]);
execFileSync('git', ['push', 'origin', tag], { cwd: CLONE_DIR, stdio: 'inherit' });

process.stdout.write(`\n✓ ${tag} pushed. CI is building the installer and will attach it to the release:\n`);
process.stdout.write(`  ${config.CONTRIB_REPO_URL}/releases/tag/${tag}\n`);
