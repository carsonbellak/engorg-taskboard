// Weather for the lock-screen wallpaper (scheduleimage.js), from Open-Meteo — free, no
// API key. Best-effort: any failure/timeout resolves to null and the wallpaper simply
// renders without weather.
//
// Location: ?lat=&lon= on the wallpaper URL (an iOS Shortcut can pass Get Current
// Location), else DEFAULT_LOCATION. Units: Fahrenheit unless ?units=c.

const DEFAULT_LOCATION = { lat: 40.4259, lon: -86.9081 }; // West Lafayette, IN (Purdue)
const CACHE_MS = 15 * 60 * 1000;
const _cache = new Map(); // key → { at, data } (per warm instance)

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

// → { current: { temp, kind, label, night }, today: { hi, lo }, days: [{ date, hi, lo, kind }] }
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
      + '&current=temperature_2m,weather_code,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
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
  return {
    current: Number.isFinite(cur.temperature_2m)
      ? { temp: Math.round(cur.temperature_2m), kind: curDesc.kind, label: curDesc.label, night: cur.is_day === 0 }
      : null,
    today: { hi: days[0].hi, lo: days[0].lo },
    days,
  };
}

module.exports = { fetchWeather, describeCode };
