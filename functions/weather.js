// Weather for the lock-screen wallpaper (scheduleimage.js), from Open-Meteo — free, no
// API key. Best-effort: any failure/timeout resolves to null and the wallpaper simply
// renders without weather.
//
// Also: today's sunrise/sunset, and a rain alert from Open-Meteo's 15-minute precipitation
// forecast — when it's raining, when it's expected to stop; when it isn't yet, when it's
// expected to start (within RAIN_SOON_SLOTS) and stop.
//
// Location: ?lat=&lon= on the wallpaper URL (an iOS Shortcut can pass Get Current
// Location), else DEFAULT_LOCATION. Units: Fahrenheit unless ?units=c.

const DEFAULT_LOCATION = { lat: 40.4259, lon: -86.9081 }; // West Lafayette, IN (Purdue)
const CACHE_MS = 15 * 60 * 1000;
const _cache = new Map(); // key → { at, data } (per warm instance)
const WET_MM = 0.1;          // a 15-min slot with at least this much precipitation is "wet"
const RAIN_SOON_SLOTS = 12;  // look 3 h ahead for rain that hasn't started yet
const DRY_SLOTS = 4;         // rain has "stopped" after 1 h with no wet slot (showers are spotty)

// WMO weather code → icon kind + short label.
function describeCode(code) {
  const c = Number(code);
  if (c === 0) return { kind: 'sun', label: 'Clear' };
  if (c === 1) return { kind: 'sun', label: 'Mostly clear' };
  if (c === 2) return { kind: 'partly', label: 'Partly cloudy' };
  if (c === 3) return { kind: 'cloud', label: 'Cloudy' };
  if (c === 45 || c === 48) return { kind: 'cloud', label: 'Fog' };
  if (c >= 51 && c <= 57) return { kind: 'rain', label: 'Drizzle' };
  if (c >= 61 && c <= 67) return { kind: 'rain', label: 'Rain' };
  if (c >= 71 && c <= 77) return { kind: 'snow', label: 'Snow' };
  if (c >= 80 && c <= 82) return { kind: 'rain', label: 'Showers' };
  if (c === 85 || c === 86) return { kind: 'snow', label: 'Snow showers' };
  if (c >= 95) return { kind: 'storm', label: 'Thunderstorms' };
  return { kind: 'cloud', label: '' };
}

function parseCoord(v, lim) {
  const n = parseFloat(v);
  return Number.isFinite(n) && Math.abs(n) <= lim ? Math.round(n * 100) / 100 : null;
}

// → { current: { temp, kind, label, night }, today: { hi, lo }, days: [{ date, hi, lo, kind }],
//     sun: { rise, set } ('HH:MM', the wallpaper's day) | null, rain: see rainOutlook() | null }
// with `days` starting at `date` (the wallpaper's day), or null.
async function fetchWeather({ lat, lon, units, date }) {
  let la = parseCoord(lat, 90), lo = parseCoord(lon, 180);
  if (la === null || lo === null) ({ lat: la, lon: lo } = DEFAULT_LOCATION);
  const unit = String(units || '').toLowerCase().startsWith('c') ? 'celsius' : 'fahrenheit';
  const key = `${la},${lo},${unit}`;

  let data = null;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    data = hit.data;
  } else {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${la}&longitude=${lo}`
      + '&current=temperature_2m,weather_code,is_day,precipitation'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset'
      + '&minutely_15=precipitation&forecast_minutely_15=96&past_minutely_15=1'
      + `&temperature_unit=${unit}&timezone=auto&past_days=1&forecast_days=8`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      _cache.set(key, { at: Date.now(), data });
    } catch (err) {
      console.warn('Weather fetch failed:', err.message);
      return hit ? shape(hit.data, date) : null; // stale beats nothing
    }
  }
  return shape(data, date);
}

function shape(data, date) {
  const d = data && data.daily;
  if (!d || !Array.isArray(d.time)) return null;
  let i = d.time.indexOf(date);
  if (i < 0) i = Math.min(1, d.time.length - 1); // past_days=1 → index 1 is the API's today
  const days = [];
  for (let k = i; k < d.time.length && days.length < 7; k++) {
    days.push({
      date: d.time[k],
      hi: Math.round(d.temperature_2m_max[k]),
      lo: Math.round(d.temperature_2m_min[k]),
      kind: describeCode(d.weather_code[k]).kind,
    });
  }
  if (!days.length) return null;
  const cur = data.current || {};
  const curDesc = describeCode(cur.weather_code);
  const hhmm = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : null);
  const rise = d.sunrise && hhmm(d.sunrise[i]), set = d.sunset && hhmm(d.sunset[i]);
  return {
    current: Number.isFinite(cur.temperature_2m)
      ? { temp: Math.round(cur.temperature_2m), kind: curDesc.kind, label: curDesc.label, night: cur.is_day === 0 }
      : null,
    today: { hi: days[0].hi, lo: days[0].lo },
    days,
    sun: rise && set ? { rise, set } : null,
    // The rain alert is about "now", so only on the wallpaper for the location's today.
    rain: typeof cur.time === 'string' && cur.time.slice(0, 10) === days[0].date
      ? rainOutlook(data.minutely_15, cur, curDesc.kind)
      : null,
  };
}

// Shift a local 'YYYY-MM-DDTHH:MM' (Open-Meteo, timezone=auto) by `min` minutes.
function shiftLocal(iso, min) {
  return new Date(Date.parse(iso + 'Z') + min * 60000).toISOString().slice(0, 16);
}

// Each 15-min value is the precipitation of the PRECEDING 15 minutes, so a wet slot at
// 16:00 means rain 15:45–16:00.
// → { now: true, word, end }            raining now; end = when it stops, null if not within ~24 h
// → { now: false, word, start, end }    not raining yet but starts within 3 h
// → null                                dry for the next 3 h
// start/end are { time: 'HH:MM', nextDay: bool }.
function rainOutlook(m15, cur, curKind) {
  if (!m15 || !Array.isArray(m15.time) || !Array.isArray(m15.precipitation)) return null;
  const t = m15.time, p = m15.precipitation;
  const wet = (k) => Number(p[k]) >= WET_MM;
  let i0 = -1; // the slot containing "now"
  for (let k = 0; k < t.length && t[k] <= cur.time; k++) i0 = k;
  if (i0 < 0) return null;
  const today = cur.time.slice(0, 10);
  const at = (iso) => ({ time: iso.slice(11, 16), nextDay: iso.slice(0, 10) !== today });
  const word = curKind === 'snow' ? 'Snow' : 'Rain';

  // Last wet slot of the spell starting at k, i.e. one followed by DRY_SLOTS dry slots.
  // null when the forecast runs out before that.
  const spellEnd = (k) => {
    let last = k;
    for (let j = k + 1; j < t.length; j++) {
      if (wet(j)) last = j;
      else if (j - last >= DRY_SLOTS) return last;
    }
    return t.length - 1 - last >= DRY_SLOTS ? last : null;
  };

  const rainingNow = Number(cur.precipitation) >= WET_MM || wet(i0)
    || ['rain', 'storm', 'snow'].includes(curKind);
  if (rainingNow) {
    const e = spellEnd(i0);
    return { now: true, word, end: e === null ? null : at(t[e]) };
  }
  for (let k = i0 + 1; k <= i0 + RAIN_SOON_SLOTS && k < t.length; k++) {
    if (!wet(k)) continue;
    const e = spellEnd(k);
    return { now: false, word, start: at(shiftLocal(t[k], -15)), end: e === null ? null : at(t[e]) };
  }
  return null;
}

module.exports = { fetchWeather, describeCode, rainOutlook };
