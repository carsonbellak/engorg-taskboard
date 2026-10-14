// Calendar feed cache. The desktop's calendar:fetchFeed asks the Pi first; the Pi answers
// from cache (stale-while-revalidate) and keeps refreshing every feed a desktop asked for in
// the last 14 days, so a desktop sync never waits on a slow Brightspace/Google/iCloud server.
// Parsing is the desktop's own core/ics.js, so results are identical to a local fetch.
const crypto = require('crypto');
const { fetchFeed } = require('../../core/ics');
const store = require('./store');

const FILE = 'calendar_cache.json';
const FRESH_MS = 10 * 60 * 1000;          // serve without refreshing
const REFRESH_EVERY_MS = 10 * 60 * 1000;  // background refresh cadence
const FORGET_AFTER_MS = 14 * 24 * 3600 * 1000;

const feeds = new Map(Object.entries(store.read(FILE, {})));  // key → { url, source, tz, events, fetchedAt, lastRequested, error }
const saver = store.debounced(FILE, () => Object.fromEntries(feeds), 5000);
const inflight = new Map();
let timer = null;

const keyOf = (url, source) => crypto.createHash('sha1').update(source + '|' + url).digest('hex');
const tz = () => process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || '';

function refresh(key) {
  if (inflight.has(key)) return inflight.get(key);
  const f = feeds.get(key);
  const p = (async () => {
    try {
      const events = await fetchFeed(f.url, f.source);
      Object.assign(f, { events, tz: tz(), fetchedAt: Date.now(), error: null });
    } catch (e) {
      f.error = e.message;
      throw e;
    } finally {
      saver.schedule();
      inflight.delete(key);
    }
    return f;
  })();
  inflight.set(key, p);
  return p;
}

// → { events, fetchedAt, stale }. Throws if the feed has never been fetched successfully.
async function get(url, source = 'feed') {
  const key = keyOf(url, source);
  let f = feeds.get(key);
  if (!f) { f = { url, source, events: null, fetchedAt: 0, lastRequested: 0 }; feeds.set(key, f); }
  f.lastRequested = Date.now();
  // A timezone change invalidates rendered local times.
  const usable = Array.isArray(f.events) && f.tz === tz();
  if (!usable) {
    try { await refresh(key); }
    catch (e) { if (!Array.isArray(f.events)) feeds.delete(key); throw e; } // never cache a feed that never worked
    return { events: f.events, fetchedAt: f.fetchedAt, stale: false };
  }
  const stale = Date.now() - f.fetchedAt > FRESH_MS;
  if (stale) refresh(key).catch(() => {});
  saver.schedule();
  return { events: f.events, fetchedAt: f.fetchedAt, stale };
}

async function tick() {
  const now = Date.now();
  for (const [key, f] of feeds) {
    if (now - (f.lastRequested || 0) > FORGET_AFTER_MS) { feeds.delete(key); saver.schedule(); continue; }
    if (now - (f.fetchedAt || 0) >= REFRESH_EVERY_MS) {
      try { await refresh(key); } catch (e) { console.warn('[calendar] refresh failed:', e.message); }
    }
  }
}

function start() { if (!timer) { timer = setInterval(tick, 60 * 1000); setTimeout(tick, 5000); } }
function stop() { if (timer) { clearInterval(timer); timer = null; } saver.flush(); }

function summary() {
  let lastRefresh = 0, errors = 0;
  for (const f of feeds.values()) { lastRefresh = Math.max(lastRefresh, f.fetchedAt || 0); if (f.error) errors++; }
  return { feeds: feeds.size, errors, lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null };
}

module.exports = { get, start, stop, summary };
