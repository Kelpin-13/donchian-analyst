/**
 * US news releases from MT5's economic calendar, as exported by mt5/ExportCalendar.mq5
 * (data/calendar_events.csv, else the terminal's MQL5/Files/calendar_events.csv).
 * Shared by research/news_windows.js and research/trade_features.js.
 *
 * MT5's calendar uses one fixed clock for all its history, so in US winter its times run an hour
 * late against the broker's (New York + 7 h all year). loadReleases() checks this against the US
 * jobs report (8:30 New York = 15:30 server) and shifts every event by the usual difference,
 * summer and winter apart. Times are broker server time, stored as if UTC.
 */
const fs = require('fs');
const path = require('path');

const MIN = 60000, DAY = 86400000;
const TOP = 'Nonfarm Payrolls|CPI m/m|Fed Interest Rate Decision|FOMC Press Conference';

function findCalendar() {
  const local = path.join(__dirname, '..', 'data', 'calendar_events.csv');
  if (fs.existsSync(local)) return local;
  const root = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Terminal');
  if (!fs.existsSync(root)) return null;
  const hits = fs.readdirSync(root).map(d => path.join(root, d, 'MQL5', 'Files', 'calendar_events.csv')).filter(p => fs.existsSync(p));
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0] || null;
}

// US daylight saving (rules since 2007): second Sunday of March to first Sunday of November.
function usDst(ms) {
  const y = new Date(ms).getUTCFullYear();
  const sunday = (m, n) => { const first = new Date(Date.UTC(y, m, 1)).getUTCDay(); return Date.UTC(y, m, 1 + (7 - first) % 7 + 7 * (n - 1)); };
  return ms >= sunday(2, 2) && ms < sunday(10, 1);
}

// US high-importance releases with a set time, sorted, on the broker's clock. `only`: 'top' for the
// big four, or a regular expression matched against the whole event name.
function loadReleases(file, only) {
  const parseT = s => Date.parse(s.trim().replace(/\./g, '-').replace(' ', 'T') + 'Z');
  const events = fs.readFileSync(file, 'latin1').trim().split(/\r?\n/).slice(1).map(l => {
    const p = l.split(',');
    return { t: parseT(p[0]), country: p[1], importance: p[3], mode: p[4], name: p[7] };
  }).filter(e => e.t > 0);

  const minuteOf = ms => ((ms % DAY) + DAY) % DAY / MIN;
  const nfp = events.filter(e => e.country === 'US' && e.mode === 'time' && /nonfarm payrolls/i.test(e.name) && !/private|adp/i.test(e.name));
  const shift = {};
  [true, false].forEach(summer => {
    const counts = {};
    nfp.filter(e => usDst(e.t) === summer).forEach(e => { const d = minuteOf(e.t) - (15 * 60 + 30); counts[d] = (counts[d] || 0) + 1; });
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    shift[summer] = { min: best === undefined ? 0 : Number(best), agree: best === undefined ? 0 : counts[best], n };
  });
  const onlyRe = only ? new RegExp('^(' + (only === 'top' ? TOP : only) + ')$', 'i') : null;
  const releases = events.filter(e => e.country === 'US' && e.importance === 'high' && e.mode === 'time' && (!onlyRe || onlyRe.test(e.name)))
    .map(e => ({ t: e.t - shift[usDst(e.t)].min * MIN, name: e.name }))
    .sort((a, b) => a.t - b.t);
  return { file, events: events.length, shift, onlyRe, releases, times: releases.map(e => e.t) };
}

// Index of the first time in a sorted array at or after t.
function firstFrom(times, t) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}

module.exports = { TOP, findCalendar, usDst, loadReleases, firstFrom };
