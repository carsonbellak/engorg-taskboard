#!/usr/bin/env node
/*
 * deploy-functions.js — deploy the Firebase Cloud Functions.
 *
 * WHY THIS EXISTS
 *   The Cloud Functions (`functions/` — e.g. the lock-screen wallpaper `scheduleImage`,
 *   the subscribable `calendarFeed`, the PWA API endpoints) are the ONE part of the app
 *   the release pipeline does not ship: `functions/` lives only in the git repo / the
 *   submit clone, never in the install dir, and `release.js` deploys only the installer,
 *   the APK, and (via CI) hosting. So a change to a function has to be deployed on its
 *   own. This script automates that end-to-end so it isn't a fiddly manual dance:
 *     1. find a checkout that actually has functions/ (the submit clone, or the cwd),
 *     2. install functions/ deps on first run,
 *     3. `firebase deploy --only functions` against project assistant-taskboard,
 *     4. remind you to commit functions/ if the deployed source isn't committed yet.
 *
 *   Auth is the firebase-tools login already stored on this machine (no browser step —
 *   `firebase login:list` shows the account; CI can instead set FIREBASE_TOKEN or
 *   GOOGLE_APPLICATION_CREDENTIALS and firebase-tools picks those up automatically).
 *
 * USAGE
 *   node deploy-functions.js                 # deploy ALL functions
 *   node deploy-functions.js scheduleImage   # deploy only the named function(s)
 *
 * DURABILITY (important)
 *   The submit clone is volatile: submit-changes.js / release.js run `git reset --hard`
 *   + `git clean -fd` on it, which WIPES uncommitted functions/ edits. Deploying does
 *   not persist source — commit + push your functions/ change to the repo too, or the
 *   next fresh clone reverts it. That commit is the one push that goes straight to the
 *   repo instead of through release.js (see CLAUDE.md → "Deploying Cloud Functions").
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require('./config');
const { repo } = config.CONTRIB_REPO;
const PROJECT = 'assistant-taskboard';

function log(m) { process.stdout.write(m + '\n'); }
function die(m) { process.stderr.write('✗ ' + m + '\n'); process.exit(1); }

// A checkout that actually contains functions/: prefer the cwd (running from a full
// repo checkout), else the cached submit clone that submit-changes.js maintains.
function findRepoDir() {
  const candidates = [process.cwd(), path.join(os.homedir(), '.engorg-submit', repo)];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'functions', 'index.js')) &&
        fs.existsSync(path.join(dir, 'firebase.json'))) return dir;
  }
  return null;
}

// The firebase CLI bundled with the install (a devDependency); fall back to npx so
// this still works from a bare checkout.
function firebaseCmd() {
  const local = path.join(__dirname, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
  return fs.existsSync(local) ? ['node', local] : ['npx', '--yes', 'firebase-tools'];
}

function run(cmd, args, cwd) {
  log(`\n> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

// Warn (don't fail) if the functions source that just deployed isn't committed —
// it would be lost on the next clone reset.
function warnIfUncommitted(repoDir) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', 'functions'],
      { cwd: repoDir, encoding: 'utf-8' }).trim();
    if (out) {
      log('\n⚠  functions/ has uncommitted changes in ' + repoDir + ':');
      log(out.split('\n').map((l) => '     ' + l).join('\n'));
      log('   Deploy is live, but commit + push these to the repo or the next fresh');
      log('   clone reverts them (see CLAUDE.md → "Deploying Cloud Functions").');
    }
  } catch { /* not a git dir / no git — skip the reminder */ }
}

(function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  const repoDir = findRepoDir();
  if (!repoDir) {
    die('No checkout with functions/ found. Run a submit/release once to create the ' +
      'clone at ' + path.join(os.homedir(), '.engorg-submit', repo) + ', or run this ' +
      'from a full repo checkout.');
  }
  log('Deploying Cloud Functions from: ' + repoDir);

  // functions/ needs its own node_modules (a fresh clone ships without them).
  if (!fs.existsSync(path.join(repoDir, 'functions', 'node_modules'))) {
    log('Installing functions/ dependencies (first run)…');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], path.join(repoDir, 'functions'));
  }

  const [cli, ...cliArgs] = firebaseCmd();

  // Fail early with a clear message if we're not authenticated.
  try {
    execFileSync(cli, [...cliArgs, 'login:list'], { cwd: repoDir, stdio: 'inherit' });
  } catch {
    die('firebase-tools is not logged in. Run `firebase login` once (or set FIREBASE_TOKEN ' +
      '/ GOOGLE_APPLICATION_CREDENTIALS for CI), then re-run.');
  }

  const target = only.length ? only.map((n) => 'functions:' + n).join(',') : 'functions';
  run(cli, [...cliArgs, 'deploy', '--only', target, '--project', PROJECT, '--non-interactive'], repoDir);

  log('\n✓ Deployed ' + (only.length ? only.join(', ') : 'all functions') + ' to ' + PROJECT + '.');
  warnIfUncommitted(repoDir);
})();
