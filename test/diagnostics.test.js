import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticsEngine } from '../src/diagnostics.js';
import { normalizeTelemetry } from '../src/adapter.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { fw, T0 } from './helpers.js';

const sampleAt = (over, sec) => normalizeTelemetry(fw(over), { t: T0 + sec * 1000, source: 'live' }).sample;
const ctxAt = (over, sec, extra = {}) => ({
  t: T0 + sec * 1000,
  link: 'RECEIVING',
  sample: sampleAt(over, sec),
  lastTelemetryAt: T0 + sec * 1000,
  sinceConnectedMs: 60000,
  counters: { text: 0, malformed: 0 },
  ...extra,
});
const run = (engine, over, from, to) => {
  const out = [];
  for (let s = from; s < to; s += 1) out.push(...engine.evaluate(ctxAt(typeof over === 'function' ? over(s) : over, s), DEFAULT_CONFIG));
  return out;
};
// piezo-unavailable is a standing info notice (piezo is disabled by default); tests ignore it unless asserting on it
const ids = (events, type) => events.filter((e) => e.type === type).map((e) => e.diag.ruleId).filter((r) => r !== 'piezo-unavailable');
const allIds = (events, type) => events.filter((e) => e.type === type).map((e) => e.diag.ruleId);

const LOW = { smA: 1.5, ldr: 900 };

test('underperformance needs bright light AND persistently low current', () => {
  const engine = new DiagnosticsEngine();
  assert.deepEqual(ids(run(engine, LOW, 0, 4), 'raised'), []); // 0..3 s: not persistent yet
  assert.deepEqual(ids(run(engine, LOW, 4, 5), 'raised'), ['solar-underperformance']);
  const diag = engine.getActive().find((d) => d.ruleId === 'solar-underperformance');
  assert.equal(diag.severity, 'warning');
  assert.match(diag.explanation, /contamination|shading/i);
  assert.match(diag.confidence, /Possible/);
  assert.ok(diag.evidence.length >= 3);
  assert.ok(diag.action.length > 10);
});

test('a single noisy low reading does not raise a warning', () => {
  const engine = new DiagnosticsEngine();
  const events = run(engine, (s) => (s === 5 ? LOW : { smA: 18 }), 0, 30);
  assert.deepEqual(ids(events, 'raised'), []);
});

test('persistent condition raises exactly once and resolves exactly once (no duplicate spam)', () => {
  const engine = new DiagnosticsEngine();
  const events = [...run(engine, LOW, 0, 120), ...run(engine, { smA: 18 }, 120, 140)];
  assert.equal(ids(events, 'raised').filter((r) => r === 'solar-underperformance').length, 1);
  assert.equal(ids(events, 'resolved').filter((r) => r === 'solar-underperformance').length, 1);
  assert.equal(engine.getActive().some((d) => d.ruleId === 'solar-underperformance'), false);
  assert.equal(engine.getResolved()[0].active, false);
  assert.ok(engine.getResolved()[0].resolvedAt > engine.getResolved()[0].raisedAt);
});

test('hysteresis: current just above the threshold does not clear an active warning', () => {
  const engine = new DiagnosticsEngine();
  run(engine, LOW, 0, 10);
  const events = run(engine, { smA: 3.2, ldr: 900 }, 10, 30); // above 3.0 but below 3.0 + 0.5
  assert.deepEqual(ids(events, 'resolved'), []);
  assert.ok(engine.getActive().some((d) => d.ruleId === 'solar-underperformance'));
  const cleared = run(engine, { smA: 4.0, ldr: 900 }, 30, 40);
  assert.deepEqual(ids(cleared, 'resolved'), ['solar-underperformance']);
});

test('low light with low current is explained, not flagged as dirty', () => {
  const engine = new DiagnosticsEngine();
  const events = run(engine, { smA: 0.4, ldr: 3500, light: 'NIGHT', panel: 'NIGHT' }, 0, 10);
  assert.deepEqual(ids(events, 'raised').filter((r) => r !== 'piezo-unavailable'), ['low-light']);
  const low = engine.getActive().find((d) => d.ruleId === 'low-light');
  assert.equal(low.severity, 'info');
  assert.match(low.action, /No action/);
});

test('unavailable sensors are reported as not evaluable; solar rules do not fire on a missing INA219', () => {
  const engine = new DiagnosticsEngine();
  const events = run(engine, { ina: 0, sV: 0, smA: 0, smW: 0 }, 0, 10);
  const raised = allIds(events, 'raised');
  assert.ok(raised.includes('solar-unavailable'));
  assert.ok(raised.includes('piezo-unavailable'));
  assert.ok(!raised.includes('solar-underperformance'));
  assert.ok(!raised.includes('low-light'));
  const solar = engine.getActive().find((d) => d.ruleId === 'solar-unavailable');
  assert.match(solar.explanation, /NOT treated as zero/);
});

test('invalid or implausible data raises one diagnostic listing the failing fields', () => {
  const engine = new DiagnosticsEngine();
  const events = run(engine, { smA: null, wV: 99 }, 0, 10);
  assert.equal(ids(events, 'raised').filter((r) => r === 'invalid-data').length, 1);
  const diag = engine.getActive().find((d) => d.ruleId === 'invalid-data');
  assert.ok(diag.evidence.some((e) => e.startsWith('smA')));
  assert.ok(diag.evidence.some((e) => e.startsWith('wV')));
});

test('stale telemetry raises immediately and resolves after data resumes', () => {
  const engine = new DiagnosticsEngine();
  const stale = (s) => ({ t: T0 + s * 1000, link: 'STALE', sample: null, lastTelemetryAt: T0, sinceConnectedMs: 99999, counters: { text: 0, malformed: 0 } });
  const raised = engine.evaluate(stale(10), DEFAULT_CONFIG);
  assert.deepEqual(ids(raised, 'raised'), ['telemetry-stale']);
  assert.deepEqual(engine.evaluate(stale(11), DEFAULT_CONFIG), []);
  engine.evaluate(ctxAt({}, 12), DEFAULT_CONFIG);
  const resolved = engine.evaluate(ctxAt({}, 14), DEFAULT_CONFIG);
  assert.deepEqual(ids(resolved, 'resolved'), ['telemetry-stale']);
});

test('connected-but-no-data is distinct from stale data', () => {
  const engine = new DiagnosticsEngine();
  const base = { link: 'AWAITING_DATA', sample: null, lastTelemetryAt: null, counters: { text: 4, malformed: 2 } };
  assert.deepEqual(engine.evaluate({ t: T0, sinceConnectedMs: 3000, ...base }, DEFAULT_CONFIG), []);
  const raised = engine.evaluate({ t: T0 + 4000, sinceConnectedMs: 7000, ...base }, DEFAULT_CONFIG);
  assert.deepEqual(ids(raised, 'raised'), ['no-data']);
  assert.match(engine.getActive()[0].evidence.join(' '), /2 malformed/);
});

test('when samples are unavailable (stale) existing diagnostics are held, not silently resolved', () => {
  const engine = new DiagnosticsEngine();
  run(engine, LOW, 0, 10);
  for (let s = 10; s < 60; s += 1) {
    engine.evaluate({ t: T0 + s * 1000, link: 'STALE', sample: null, lastTelemetryAt: T0 + 9000, sinceConnectedMs: 1e5, counters: { text: 0, malformed: 0 } }, DEFAULT_CONFIG);
  }
  assert.ok(engine.getActive().some((d) => d.ruleId === 'solar-underperformance'));
});

test('active diagnostics are sorted most severe first', () => {
  const engine = new DiagnosticsEngine();
  run(engine, { ...LOW, ina: 1 }, 0, 10);
  const severities = engine.getActive().map((d) => d.severity);
  const rank = { critical: 0, warning: 1, info: 2 };
  assert.deepEqual(severities, [...severities].sort((a, b) => rank[a] - rank[b]));
});
