/**
 * Builds the shareable gold backtest report (data/reports/gold_report.html) from research/gold_export.js's output,
 * in the same chaptered layout as the stock report (research/report_base.html + research/gold_report.html).
 *
 *   node research/gold_export.js 200 && node research/gold_report.js
 *
 * Research only: nothing here trades.
 */
const fs = require('fs'), path = require('path');
const { page } = require('./gap_report.js');
const D = path.join(__dirname, '..', 'data', 'reports');
const data = JSON.parse(fs.readFileSync(path.join(D, 'gold.json'), 'utf8'));
// holding gold by calendar year, over the book's window
const last = {}; data.gold.bookEq.forEach(([d, v]) => { last[d.slice(0, 4)] = v; });
let prev = 10000; data.goldYearly = {};
Object.keys(last).sort().forEach(y => { data.goldYearly[y] = last[y] / prev - 1; prev = last[y]; });
const out = page('gold_report.html', data, (k, v) => typeof v === 'number' ? +v.toFixed(5) : v);
fs.writeFileSync(path.join(D, 'gold_report.html'), out);
console.log('wrote data/reports/gold_report.html (' + Math.round(out.length / 1024) + ' KB)');
