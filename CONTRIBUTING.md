# Contributing changes back to the app

This app is built to be **downloaded, tweaked, and submitted back with as little git
ceremony as possible**. You do not need to clone the repo, configure remotes, or know
git to contribute. Pick whichever path fits:

## 1. From inside the app (no git, no terminal) — best for most people

**Settings → Contribute → "Submit Changes…"**

- It scans your install against the upstream repo and lists exactly what you changed.
- Sign in with GitHub (one click, no Personal Access Token).
- It forks the repo, commits your selected files, and opens a Pull Request for review.

Line endings are normalized automatically, so you only ever see your *real* edits.

## 2. From the command line — best for maintainers and for Claude/automation

A single self-contained script handles everything (it keeps a small cached clone of
the repo under `~/.engorg-submit`, mirrors your changed files into it, commits, and
pushes). The installed app folder does **not** need to be a git checkout.

```bash
# See what changed (no commit, no push):
node submit-changes.js --list

# Commit everything you changed and push to main:
node submit-changes.js -m "Short description of the change"

# Push to a branch instead of main and print a PR link:
node submit-changes.js -m "..." --pr
```

Requirements: `git` on PATH, and push access to the repo (you're the owner or a
collaborator). No push access? Use path #1 above — it forks and PRs instead.

### For Claude / agents

If you've edited files in this install and the user asks to "push", "submit", or
"contribute" the changes, run:

```bash
node submit-changes.js --list          # confirm the change set is what you expect
node submit-changes.js -m "<message>"  # then submit
```

`--list` is always safe (it commits nothing). Only `-m "<message>"` pushes. The script
is update-only: it never deletes repo files the install doesn't ship. See
`submit-changes.js` and `ipc/contribute.js` for the underlying logic, and the
"Submitting changes" section in `CLAUDE.md`.
