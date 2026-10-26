// CSV export and the print-friendly session report. Missing values stay missing: an
// unavailable sensor yields an empty CSV cell and "not available" in the report, never 0.

import { isAvailable } from './model.js';

export const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '-');
const stamp = (t) => (t ? new Date(t).toLocaleString([], { hour12: false }) : '-');
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '');

const CSV_COLUMNS = [
  ['time_iso', (s) => new Date(s.t).toISOString()],
  ['source', (s) => s.source],
  ['light_status', (s) => s.light.status],
  ['ldr_raw', (s) => (isAvailable(s.light) ? s.light.raw : '')],
  ['light_label', (s) => (isAvailable(s.light) ? s.light.label : '')],
  ['solar_status', (s) => s.solar.status],
  ['solar_V', (s) => (isAvailable(s.solar) ? num(s.solar.voltageV) : '')],
  ['solar_mA', (s) => (isAvailable(s.solar) ? num(s.solar.currentmA, 1) : '')],
  ['solar_mW', (s) => (isAvailable(s.solar) ? num(s.solar.powermW, 1) : '')],
  ['wind_status', (s) => s.wind.status],
  ['wind_V', (s) => (isAvailable(s.wind) ? num(s.wind.voltageV) : '')],
  ['wind_mW_estimate', (s) => (isAvailable(s.wind) ? num(s.wind.powermW) : '')],
  ['piezo_status', (s) => s.piezo.status],
  ['piezo_cap_V', (s) => (isAvailable(s.piezo) ? num(s.piezo.capVoltageV) : '')],
  ['piezo_steps', (s) => (isAvailable(s.piezo) ? s.piezo.steps : '')],
  ['battery_status', (s) => s.battery.status],
  ['battery_V', (s) => (isAvailable(s.battery) ? num(s.battery.voltageV) : '')],
  ['battery_pct_estimate', (s) => (isAvailable(s.battery) ? s.battery.pctEstimate : '')],
  ['cleaner_state', (s) => s.cleaner.state],
  ['cleaner_cycles', (s) => s.cleaner.cycles ?? ''],
];

export function buildCsv(history) {
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = history.map((s) => CSV_COLUMNS.map(([, get]) => cell(get(s))).join(','));
  return [CSV_COLUMNS.map(([name]) => name).join(','), ...rows].join('\n');
}

function stats(history, key, field) {
  const values = history.filter((s) => isAvailable(s[key])).map((s) => s[key][field]).filter(Number.isFinite);
  if (values.length === 0) return null;
  return { n: values.length, min: Math.min(...values), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
}

const range = (st, unit, d = 1) => (st ? `${st.min.toFixed(d)} - ${st.max.toFixed(d)} ${unit} (mean ${st.mean.toFixed(d)}, n=${st.n})` : 'not available - no valid readings');

function availability(history, key) {
  if (history.length === 0) return 'no data';
  const ok = history.filter((s) => isAvailable(s[key])).length;
  const last = history[history.length - 1][key];
  const note = isAvailable(last) ? '' : ` - last reason: ${last.reason ?? last.status}`;
  return `${ok} of ${history.length} samples valid (${Math.round((ok / history.length) * 100)}%)${note}`;
}

export function buildReportHtml(session, now = Date.now()) {
  const h = session.history;
  const demo = session.mode === 'demo';
  const last = session.latest;
  const events = session.events.all();
  const raised = events.filter((e) => e.type === 'diag-raised');
  const failures = events.filter((e) => e.type === 'connection' && e.severity === 'critical');
  const results = session.verifier.results;
  const totals = last?.totals ?? {};
  const fmtTotal = (v, unit, d) => (Number.isFinite(v) ? `${v.toFixed(d)} ${unit}` : 'not reported');

  const li = (items) => (items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '<p class="none">None recorded.</p>');

  return `
  <article class="report">
    <h1>HARVESTIQ session report</h1>
    ${demo ? '<p class="sim-note"><b>SIMULATED DATA.</b> Every value in this report came from a software demo scenario, not from hardware.</p>' : ''}
    <table>
      <tr><th>Data source</th><td>${demo ? `SIMULATED (${esc(session.label || 'demo scenario')})` : 'LIVE - ESP32 over USB serial'}</td></tr>
      <tr><th>Session start</th><td>${stamp(session.startedAt)}</td></tr>
      <tr><th>Report generated</th><td>${stamp(now)} (duration ${Math.round((now - session.startedAt) / 1000)} s)</td></tr>
      <tr><th>Valid measurements</th><td>${session.counters.telemetry} telemetry samples; ${session.counters.malformed} malformed and ${session.counters.rejected} rejected lines ignored</td></tr>
    </table>

    <h2>Sensor availability</h2>
    <table>
      <tr><th>Solar (INA219)</th><td>${esc(availability(h, 'solar'))}</td></tr>
      <tr><th>Wind</th><td>${esc(availability(h, 'wind'))}</td></tr>
      <tr><th>Piezo</th><td>${esc(availability(h, 'piezo'))}</td></tr>
      <tr><th>Battery voltage</th><td>${esc(availability(h, 'battery'))}</td></tr>
      <tr><th>Light (LDR)</th><td>${esc(availability(h, 'light'))}</td></tr>
    </table>

    <h2>Observed output</h2>
    <table>
      <tr><th>Solar current</th><td>${range(stats(h, 'solar', 'currentmA'), 'mA')}</td></tr>
      <tr><th>Solar power</th><td>${range(stats(h, 'solar', 'powermW'), 'mW')}</td></tr>
      <tr><th>Wind generator voltage</th><td>${range(stats(h, 'wind', 'voltageV'), 'V', 2)}</td></tr>
      <tr><th>Battery voltage</th><td>${range(stats(h, 'battery', 'voltageV'), 'V', 2)}</td></tr>
      <tr><th>Firmware energy totals</th><td>Solar ${fmtTotal(totals.solarmWh, 'mWh', 4)}; wind ${fmtTotal(totals.windmWh, 'mWh', 4)} (estimate); piezo ${isAvailable(last?.piezo) ? fmtTotal(totals.piezouJ, 'uJ', 1) + ' (estimate)' : 'not available'}</td></tr>
    </table>

    <h2>Diagnostics (${raised.length} raised)</h2>
    ${li(raised.map((e) => `<b>${clock(e.t)}</b> [${esc(e.severity)}] ${esc(e.title)} - ${esc(e.detail)}`))}
    <p>Active at report time: ${session.diagnostics.getActive().map((d) => esc(d.title)).join('; ') || 'none'}</p>

    <h2>Cleaning cycles observed: ${session.cleaningCycles}</h2>
    ${li(results.map((r) => `<b>${clock(r.startT)}</b> cycle #${esc(r.cycle ?? '?')}: <b>${esc(r.outcome)}</b> (data quality ${esc(r.quality)}). ${esc(r.explanation)}`))}

    <h2>Communication failures (${failures.length})</h2>
    ${li(failures.map((e) => `<b>${clock(e.t)}</b> ${esc(e.title)} - ${esc(e.detail)}`))}

    <h2>Limitations</h2>
    <ul>
      <li>Wind power is an estimate (V&sup2;/R with an assumed 200 &Omega; load); battery percentage is a voltage-based estimate; piezo energy is an estimate.</li>
      <li>The LDR is an uncalibrated brightness indicator and does not measure irradiance, so before/after comparisons are qualified, not proven.</li>
      <li>Low solar current does not prove a dirty panel: shading, wiring and load also reduce output.</li>
      <li>Cleaning motor operation is reported by the ESP32 state machine and is not independently measured.</li>
      <li>Thresholds are configurable assumptions that must be calibrated on the real hardware.</li>
    </ul>
  </article>`;
}
