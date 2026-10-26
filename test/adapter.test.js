import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, normalizeTelemetry } from '../src/adapter.js';
import { makeConfig } from '../src/config.js';
import { fw, T0 } from './helpers.js';

const norm = (raw, config) => normalizeTelemetry(raw, { t: T0, source: 'live', config });

test('parseLine classifies firmware output', () => {
  assert.equal(parseLine('').kind, 'empty');
  assert.equal(parseLine('   \r').kind, 'empty');
  assert.deepEqual(parseLine('SOLAR : 5.20 V  18.0 mA'), { kind: 'text', text: 'SOLAR : 5.20 V  18.0 mA' });
  assert.equal(parseLine('=====================================').kind, 'text');
  assert.equal(parseLine(JSON.stringify(fw())).kind, 'telemetry');
});

test('parseLine reports malformed JSON without throwing', () => {
  assert.equal(parseLine('{"ldr":900,"sV":5.3,"smA":1').kind, 'malformed'); // truncated
  assert.equal(parseLine('{"ldr":900,"wV":nan}').kind, 'malformed'); // printf NaN is not JSON
  assert.equal(parseLine('{"ldr":900,"wV":inf}').kind, 'malformed');
  assert.equal(parseLine('{}garbage').kind, 'malformed');
  assert.equal(parseLine('{"a":1}').kind, 'telemetry'); // valid JSON; rejected later by normalize
});

test('normalizeTelemetry maps a healthy line to the internal model', () => {
  const { ok, sample } = norm(fw({ smA: 18, sV: 5.35, wV: 1.2, wmW: 7.2, bV: 3.9 }));
  assert.equal(ok, true);
  assert.equal(sample.source, 'live');
  assert.equal(sample.solar.status, 'AVAILABLE');
  assert.equal(sample.solar.currentmA, 18);
  assert.equal(sample.solar.voltageV, 5.35);
  assert.equal(sample.wind.status, 'AVAILABLE');
  assert.equal(sample.wind.generating, true);
  assert.equal(sample.wind.estimated, true);
  assert.equal(sample.light.bright, true);
  assert.equal(sample.cleaner.state, 'IDLE');
  assert.equal(sample.battery.pctEstimate, 75);
  assert.equal(sample.battery.estimated, true);
  assert.deepEqual(sample.issues, []);
});

test('INA219 missing is UNAVAILABLE, never a zero reading', () => {
  const { sample } = norm(fw({ ina: 0, sV: 0, smA: 0, smW: 0 }));
  assert.equal(sample.solar.status, 'UNAVAILABLE');
  assert.equal(sample.solar.currentmA, undefined);
  assert.match(sample.solar.reason, /INA219/);
});

test('piezo is unavailable unless enabled; pz field overrides settings', () => {
  assert.equal(norm(fw()).sample.piezo.status, 'UNAVAILABLE');
  const on = makeConfig({ piezo: { enabled: true } });
  const enabled = norm(fw({ cV: 1.5, steps: 3, puJ: 12 }), on).sample.piezo;
  assert.equal(enabled.status, 'AVAILABLE');
  assert.equal(enabled.steps, 3);
  assert.equal(norm(fw({ pz: 1, cV: 1.5, steps: 2 })).sample.piezo.status, 'AVAILABLE');
  assert.equal(norm(fw({ pz: 0 }), on).sample.piezo.status, 'UNAVAILABLE');
});

test('missing fields: too few known keys is rejected, a single missing field degrades one sensor', () => {
  assert.equal(norm({ a: 1 }).ok, false);
  assert.equal(norm({ ldr: 900, ina: 1 }).ok, false);
  const { sample } = norm(fw({ wV: undefined }));
  assert.equal(sample.wind.status, 'UNAVAILABLE');
  assert.equal(sample.solar.status, 'AVAILABLE');
});

test('null, string and non-finite numbers become ERROR with an issue, not zero', () => {
  const cases = [null, 'abc', NaN, Infinity, -Infinity, {}];
  for (const bad of cases) {
    const { sample } = norm(fw({ smA: bad }));
    assert.equal(sample.solar.status, 'ERROR', String(bad));
    assert.ok(sample.issues.some((i) => i.field === 'smA'));
  }
  assert.equal(norm(fw({ ldr: 'x' })).sample.light.status, 'ERROR');
});

test('out-of-range values are rejected using documented plausibility windows', () => {
  assert.equal(norm(fw({ smA: 9999 })).sample.solar.status, 'ERROR');
  assert.equal(norm(fw({ sV: -3 })).sample.solar.status, 'ERROR');
  assert.equal(norm(fw({ wV: 50 })).sample.wind.status, 'ERROR');
  assert.equal(norm(fw({ ldr: 99999 })).sample.light.status, 'ERROR');
  assert.equal(norm(fw({ bV: 5.9 })).sample.battery.status, 'ERROR');
});

test('battery: implausibly low is unavailable; percentage is a clamped estimate', () => {
  const low = norm(fw({ bV: 0.04 })).sample.battery;
  assert.equal(low.status, 'UNAVAILABLE');
  assert.equal(low.pctEstimate, undefined);
  assert.equal(norm(fw({ bV: 4.2 })).sample.battery.pctEstimate, 100);
  assert.equal(norm(fw({ bV: 3.0 })).sample.battery.pctEstimate, 0);
  assert.equal(norm(fw({ bV: 2.5 })).sample.battery.pctEstimate, 0);
});

test('cleaner panel strings map to states; NIGHT is idle with a night flag', () => {
  const state = (panel) => norm(fw({ panel })).sample.cleaner;
  assert.equal(state('CLEAN').state, 'IDLE');
  assert.equal(state('NIGHT').night, true);
  assert.equal(state('CHECKING').state, 'CHECKING');
  assert.equal(state('CLEANING').state, 'CLEANING');
  assert.equal(state('COOLDOWN').state, 'COOLDOWN');
  const bad = state('EXPLODING');
  assert.equal(bad.status, 'ERROR');
  assert.equal(bad.state, 'UNKNOWN');
});

test('light label comes from firmware; falls back to thresholds when absent', () => {
  assert.equal(norm(fw({ ldr: 900, light: undefined })).sample.light.label, 'BRIGHT');
  assert.equal(norm(fw({ ldr: 2000, light: undefined })).sample.light.label, 'DIM');
  assert.equal(norm(fw({ ldr: 3500, light: undefined })).sample.light.label, 'NIGHT');
  assert.equal(norm(fw({ ldr: 3500, light: 'BRIGHT' })).sample.light.bright, true); // firmware wins
});
