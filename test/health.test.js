import test from 'node:test';
import assert from 'node:assert/strict';
import { SensorHealthMonitor } from '../src/health.js';
import { normalizeTelemetry } from '../src/adapter.js';
import { DEFAULT_CONFIG, makeConfig } from '../src/config.js';
import { fw, T0 } from './helpers.js';

/** Drive a monitor with 1 Hz firmware lines; `over(i)` gives overrides per second. Returns an evaluator. */
function run(seconds, over = {}, { config = DEFAULT_CONFIG, from = 0, monitor = new SensorHealthMonitor() } = {}) {
  let last = null;
  for (let i = from; i < from + seconds; i += 1) {
    const raw = fw(typeof over === 'function' ? over(i) : over);
    for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
    const { sample } = normalizeTelemetry(raw, { t: T0 + i * 1000, source: 'live', config });
    monitor.onSample(sample, config);
    monitor.onParser('ok', config);
    last = sample;
  }
  const t = T0 + (from + seconds - 1) * 1000 + 300;
  const eval_ = (link = 'RECEIVING', at = t) => {
    const list = monitor.evaluate({ t: at, link, sample: last, lastTelemetryAt: T0 + (from + seconds - 1) * 1000, counters: { text: 0, malformed: 0 } }, config);
    return Object.fromEntries(list.map((c) => [c.id, c]));
  };
  return { monitor, eval: eval_, last, t, next: from + seconds };
}

test('A. a live stream does not make a channel healthy: a channel silent while others update goes STALE then SUSPECTED', () => {
  const r = run(45, (i) => (i >= 10 ? { wV: undefined } : {}));
  const c = r.eval();
  assert.equal(c.stream.status, 'HEALTHY');
  assert.equal(c.solar.status, 'HEALTHY');
  assert.equal(c.wind.status, 'SUSPECTED FAILURE'); // silent 35 s while the stream is alive
});

test('A. staleness is per sensor and shows the age of the last valid reading', () => {
  const r = run(16, (i) => (i >= 10 ? { wV: undefined } : {}));
  const wind = r.eval().wind;
  assert.equal(wind.status, 'STALE');
  assert.ok(wind.ageMs >= 5000 && wind.ageMs <= 7000, `age ${wind.ageMs}`);
  assert.match(wind.reading, /V generator output/, 'last valid value is kept as history');
  assert.equal(r.eval().light.ageMs < 1000, true);
});

test('A. whole-stream stale and disconnected states mark every hardware channel unavailable', () => {
  const r = run(10);
  const stale = r.eval('STALE', r.t + 6000);
  for (const id of ['solar', 'light', 'wind', 'battery']) assert.equal(stale[id].status, 'STALE', id);
  const down = r.eval('NO_CONNECTION');
  for (const id of ['solar', 'light', 'wind', 'battery']) assert.equal(down[id].status, 'DISCONNECTED', id);
  assert.equal(down.stream.status, 'DISCONNECTED');
  assert.ok(down.solar.reading, 'historical value retained, flagged by status');
  assert.equal(r.eval('AWAITING_DATA').solar.status, 'UNKNOWN');
});

test('B. invalid readings do not overwrite the last valid value or become zero; recovery needs consecutive valid readings', () => {
  let r = run(10, { smA: 18 });
  r = run(1, { smA: 'garbage' }, { from: r.next, monitor: r.monitor });
  let c = r.eval();
  assert.equal(c.solar.status, 'WARNING');
  assert.match(c.solar.error, /Invalid reading/);
  assert.match(c.solar.reading, /^18\.0 mA/);
  for (let n = 1; n <= 5; n += 1) {
    r = run(1, { smA: 18 }, { from: r.next, monitor: r.monitor });
    c = r.eval();
    if (n < 5) assert.match(c.solar.error, new RegExp(`Recovering after a fault: ${n} of 5`));
  }
  assert.equal(c.solar.status, 'HEALTHY');
});

test('B. malformed lines are a parser problem, never a sensor fault', () => {
  const mon = new SensorHealthMonitor();
  const r = run(10, {}, { monitor: mon });
  for (let i = 0; i < 12; i += 1) mon.onParser('malformed', DEFAULT_CONFIG);
  const c = r.eval();
  assert.equal(c.parser.status, 'WARNING');
  for (const id of ['solar', 'light', 'wind', 'battery']) assert.equal(c[id].status, 'HEALTHY', id);
});

test('B. a few bad lines among many good ones do not trip the parser warning', () => {
  const mon = new SensorHealthMonitor();
  const r = run(25, {}, { monitor: mon });
  mon.onParser('malformed', DEFAULT_CONFIG);
  mon.onParser('malformed', DEFAULT_CONFIG);
  assert.equal(r.eval().parser.status, 'HEALTHY');
});

test('C. INA219: ina=0 is CONFIRMED by firmware, valid zero current and valid low power are not failures', () => {
  const dead = run(8, { ina: 0, sV: 0, smA: 0, smW: 0 }).eval().solar;
  assert.equal(dead.status, 'DISCONNECTED');
  assert.equal(dead.confidence, 'CONFIRMED');
  assert.match(dead.error, /only checks at boot/);
  assert.equal(dead.reading, null, 'no fake zero reading');

  const zero = run(60, { smA: 0, smW: 0, ldr: 3500, light: 'NIGHT' }).eval().solar;
  assert.equal(zero.status, 'HEALTHY');
  assert.match(zero.note, /Valid zero-current reading/);
  assert.match(zero.note, /cannot independently confirm/);
  assert.match(run(8, { smA: 0.4, smW: 2 }).eval().solar.note, /Valid low-power/);
});

test('D. LDR: constant darkness is NOT a failure; pinned at a rail is only an UNDETERMINED warning', () => {
  const dark = run(400, { ldr: 3300, light: 'NIGHT', smA: 0, smW: 0 }).eval().light;
  assert.equal(dark.status, 'WARNING', 'identical raw for minutes is worth a note...');
  assert.equal(dark.confidence, 'UNDETERMINED', '...but never a failure');
  assert.notEqual(dark.status, 'SUSPECTED FAILURE');
  const noisyDark = run(400, (i) => ({ ldr: 3300 + (i % 7), light: 'NIGHT', smA: 0, smW: 0 })).eval().light;
  assert.equal(noisyDark.status, 'HEALTHY');

  const darkEnd = run(30, { ldr: 4095, light: 'NIGHT', smA: 0.2, smW: 1 }).eval().light;
  assert.equal(darkEnd.status, 'HEALTHY', 'this module reads HIGH in the dark, so a pinned-high reading is just a dark room');
  assert.match(darkEnd.note, /dark end of the ADC range/);
  const brightEnd = run(30, { ldr: 2, light: 'BRIGHT', smA: 20 }).eval().light;
  assert.equal(brightEnd.status, 'WARNING');
  assert.equal(brightEnd.confidence, 'UNDETERMINED');
  assert.match(brightEnd.error, /glare\/saturation or a short/);
});

test('D. LDR: night reading while the panel produces current is SUSPECTED, not confirmed', () => {
  const l = run(40, { ldr: 4095, light: 'NIGHT', smA: 18 }).eval().light;
  assert.equal(l.status, 'SUSPECTED FAILURE');
  assert.equal(l.confidence, 'SUSPECTED');
  assert.match(l.action, /AO->D34/);
  const brief = run(10, { ldr: 4095, light: 'NIGHT', smA: 18 }).eval().light;
  assert.notEqual(brief.status, 'SUSPECTED FAILURE', 'needs a sustained disagreement');
});

test('D. LDR: values come from the firmware label (lower raw = brighter), so BRIGHT readings are healthy', () => {
  const l = run(30, (i) => ({ ldr: 600 + (i % 5) })).eval().light;
  assert.equal(l.status, 'HEALTHY');
  assert.match(l.reading, /BRIGHT/);
});

test('E. wind: zero generator output is HEALTHY and explained, never "failed" or "no wind"', () => {
  const w = run(200, { wV: 0.02, wmW: 0 }).eval().wind;
  assert.equal(w.status, 'HEALTHY');
  assert.match(w.note, /not wind speed/);
  assert.match(w.note, /does not prove there is no wind/);
});

test('E. wind: varying output is healthy; an identical non-zero voltage for a minute is only UNDETERMINED', () => {
  assert.equal(run(120, (i) => ({ wV: 1 + 0.3 * Math.sin(i / 3) })).eval().wind.status, 'HEALTHY');
  const stuck = run(90, { wV: 1.2 }).eval().wind;
  assert.equal(stuck.status, 'WARNING');
  assert.equal(stuck.confidence, 'UNDETERMINED');
});

test('F. piezo: NOT CONFIGURED when disabled; once enabled, quiet periods are healthy, missing data goes stale', () => {
  assert.equal(run(20).eval().piezo.status, 'NOT CONFIGURED');
  const on = makeConfig({ piezo: { enabled: true } });
  const quiet = run(120, { cV: 0.05, steps: 3, puJ: 20 }, { config: on }).eval().piezo;
  assert.equal(quiet.status, 'HEALTHY');
  assert.match(quiet.note, /brief pulses/);
  const off = run(20, (i) => (i >= 10 ? { pz: 1, cV: undefined } : { pz: 1, cV: 0.1, steps: 0 }), { config: on }).eval().piezo;
  assert.notEqual(off.status, 'HEALTHY');
  assert.notEqual(off.status, 'NOT CONFIGURED');
});

test('F. enabling piezo does not leave a phantom fault behind', () => {
  const mon = new SensorHealthMonitor();
  let r = run(10, {}, { monitor: mon });
  const on = makeConfig({ piezo: { enabled: true } });
  r = run(3, { cV: 0.1, steps: 0 }, { config: on, from: r.next, monitor: mon });
  assert.equal(r.eval().piezo.status, 'HEALTHY');
});

test('G. battery: missing is never "empty"; implausibly low is SUSPECTED, with an estimate caveat', () => {
  const missing = run(12, (i) => (i >= 4 ? { bV: undefined } : {})).eval().battery;
  assert.ok(['STALE', 'WARNING'].includes(missing.status));
  assert.doesNotMatch(String(missing.reading), /^0/);
  const low = run(10, { bV: 0.04 }).eval().battery;
  assert.equal(low.status, 'SUSPECTED FAILURE');
  assert.match(low.error, /not an empty battery/);
  assert.match(run(10, {}).eval().battery.note, /estimated from voltage/);
  assert.match(run(10, {}).eval().battery.reading, /est\./);
});

test('G. battery state is only claimed when the readings support it', () => {
  const mk = (over, n = 50) => { const r = run(n, over); return r.monitor.batteryState(r.last, r.t, DEFAULT_CONFIG).state; };
  assert.equal(mk({ smA: 20 }), 'CHARGING');
  assert.equal(mk((i) => ({ smA: 0, bV: 3.9 - i * 0.002 })), 'DISCHARGING');
  assert.equal(mk({ smA: 0, bV: 3.9 }), 'STABLE');
  assert.equal(mk({ smA: 0 }, 3), 'UNKNOWN');
  assert.equal(mk({ bV: 0.03 }), 'UNKNOWN');
});

test('H. ESP32 stream and cleaner feedback: connection state is reported, motor feedback is honestly NOT CONFIGURED', () => {
  const c = run(10).eval();
  assert.equal(c.stream.status, 'HEALTHY');
  assert.match(c.stream.note, /Each sensor is judged separately/);
  assert.equal(c.cleaner.status, 'NOT CONFIGURED');
  assert.match(c.cleaner.note, /not measured/);
});

test('confidence is CONFIRMED only for facts the firmware or timing proves', () => {
  const sus = run(40, { ldr: 4095, light: 'NIGHT', smA: 18 }).eval();
  assert.notEqual(sus.light.confidence, 'CONFIRMED');
  assert.equal(run(8, { ina: 0, sV: 0, smA: 0, smW: 0 }).eval().solar.confidence, 'CONFIRMED');
});

test('every channel exposes name, status, confidence, freshness, error and action fields', () => {
  const list = Object.values(run(20, (i) => (i >= 8 ? { wV: undefined } : {})).eval());
  assert.ok(list.length >= 8);
  for (const ch of list) {
    for (const k of ['id', 'name', 'status', 'confidence', 'lastValidAt', 'ageMs', 'error', 'action']) assert.ok(k in ch, `${ch.id} missing ${k}`);
  }
});

// ---- regression tests for the independent review ----

test('review 1: the first-ever bad or missing reading is not jumped straight to SUSPECTED FAILURE', () => {
  const bad = run(1, { wV: 99 }).eval().wind;
  assert.equal(bad.status, 'WARNING');
  assert.doesNotMatch(bad.error, /for - s/);
  const missing = run(2, { wV: undefined }).eval().wind;
  assert.equal(missing.status, 'WARNING');
  assert.match(missing.error, /not yet long enough/);
  assert.equal(run(8, { wV: undefined }).eval().wind.status, 'STALE');
  assert.equal(run(40, { wV: undefined }).eval().wind.status, 'SUSPECTED FAILURE');
});

test('review 2: values that keep ARRIVING but are invalid escalate by count, not by being called stale', () => {
  const few = run(5, { wV: 99 }).eval().wind;
  assert.equal(few.status, 'WARNING', 'invalid-but-arriving is a data-quality warning, not STALE');
  assert.equal(run(12, { wV: 99 }).eval().wind.status, 'SUSPECTED FAILURE');
  assert.equal(run(12, { wV: 99 }).eval().wind.confidence, 'SUSPECTED');
});

test('review 5: a channel whose latest sample is invalid is never presented as current', () => {
  let r = run(8, { smA: 18 });
  assert.equal(r.eval().solar.current, true);
  r = run(1, { smA: 'garbage' }, { from: r.next, monitor: r.monitor });
  assert.equal(r.eval().solar.current, false);
  assert.match(r.eval().solar.reading, /18\.0 mA/, 'last valid value kept for context');
});

test('review 4: piezo NOT CONFIGURED is CONFIRMED only when the firmware says pz=0, otherwise it is a setting', () => {
  assert.equal(run(6).eval().piezo.confidence, 'UNDETERMINED');
  assert.match(run(6).eval().piezo.note, /"Piezo attached" setting/);
  assert.equal(run(6, { pz: 0 }).eval().piezo.confidence, 'CONFIRMED');
});

test('minor: duration trackers do not span an outage', () => {
  let r = run(20, { ldr: 2, light: 'BRIGHT', smA: 20 });
  assert.equal(r.eval().light.status, 'WARNING');
  r = run(2, { ldr: 2, light: 'BRIGHT', smA: 20 }, { from: r.next + 60, monitor: r.monitor });
  assert.equal(r.eval().light.status, 'HEALTHY', 'only 2 s of continuous data since the gap');
});

test('minor: DISCHARGING is not claimed when solar was flowing within the trend window', () => {
  const r = run(40, (i) => ({ smA: i < 25 ? 20 : 0, bV: 4.0 - i * 0.004 }));
  assert.notEqual(r.monitor.batteryState(r.last, r.t, DEFAULT_CONFIG).state, 'DISCHARGING');
  const later = run(70, (i) => ({ smA: i < 25 ? 20 : 0, bV: 4.0 - i * 0.004 }));
  assert.equal(later.monitor.batteryState(later.last, later.t, DEFAULT_CONFIG).state, 'DISCHARGING');
});
