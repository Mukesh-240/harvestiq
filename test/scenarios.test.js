import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, DemoSource, scenarioFrames } from '../src/demo.js';
import { parseLine } from '../src/adapter.js';
import { Session } from '../src/session.js';
import { Outcome } from '../src/verification.js';
import { T0 } from './helpers.js';

/** Play a scenario to second `until` (exclusive) the way the app does: step, then tick half a second later. */
function play(id, until) {
  const source0 = scenarioFrames(id);
  const session = new Session({ mode: 'demo', now: T0 });
  const source = new DemoSource({ session, scenarioId: id });
  session.setConnection('connected', T0);
  const n = until ?? source0.length;
  for (let t = 0; t < n; t += 1) {
    source.step(T0 + t * 1000);
    session.tick(T0 + t * 1000 + 500);
  }
  return { session, now: T0 + (n - 1) * 1000 + 500 };
}
const channels = ({ session, now }) => Object.fromEntries(session.healthSnapshot(now).map((c) => [c.id, c]));
const active = ({ session }) => session.diagnostics.getActive().map((d) => d.ruleId);
const recovered = ({ session }) => session.diagnostics.getResolved().map((d) => d.ruleId);
const titles = ({ session }) => session.events.all().map((e) => e.title);

test('the catalogue contains the 16 requested scenarios plus the changed-light verification case', () => {
  assert.equal(SCENARIOS.length, 17);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 17);
  for (const s of SCENARIOS) assert.ok(s.name && s.blurb && s.length >= 40, s.id);
});

test('scenarios are deterministic, and every non-corrupted line is real firmware-format JSON', () => {
  for (const { id } of SCENARIOS) {
    assert.equal(JSON.stringify(scenarioFrames(id)), JSON.stringify(scenarioFrames(id)));
    const kinds = scenarioFrames(id).filter((f) => f.line).map((f) => parseLine(f.line).kind);
    assert.ok(kinds.filter((k) => k === 'telemetry').length >= kinds.length * 0.6, id);
  }
});

test('every demo sample is tagged SIMULATED (source=demo) in every scenario', () => {
  for (const { id } of SCENARIOS) assert.ok(play(id).session.history.every((x) => x.source === 'demo'), id);
});

test('1 Normal operation: every hardware channel healthy, piezo NOT CONFIGURED, nothing to warn about', () => {
  const r = play('1', 45);
  const c = channels(r);
  for (const id of ['solar', 'light', 'wind', 'battery', 'stream', 'parser']) assert.equal(c[id].status, 'HEALTHY', id);
  assert.equal(c.piezo.status, 'NOT CONFIGURED');
  assert.equal(c.cleaner.status, 'NOT CONFIGURED');
  assert.deepEqual(active(r), ['piezo-unavailable']);
  assert.equal(r.session.cleaningCycles, 0);
});

test('2 Strong sunlight: very bright light and high current, no warnings', () => {
  const r = play('2', 40);
  assert.ok(r.session.latest.light.raw < 450);
  assert.ok(r.session.latest.solar.currentmA > 35);
  assert.deepEqual(active(r), ['piezo-unavailable']);
  assert.equal(r.session.batteryState(r.now).state, 'CHARGING');
});

test('3 Low sunlight: explained as low light, no underperformance claim, no cleaning', () => {
  const r = play('3');
  assert.ok(active(r).includes('low-light'));
  assert.ok(!active(r).includes('solar-underperformance'));
  assert.equal(r.session.cleaningCycles, 0);
  assert.equal(r.session.latest.light.label, 'DIM');
  assert.equal(channels(r).solar.status, 'HEALTHY');
});

test('4 Possible solar underperformance: warning raises, cleaning does not help, shade removal recovers everything', () => {
  const mid = play('4', 30);
  assert.ok(active(mid).includes('solar-underperformance'));
  assert.ok(mid.session.cleaningCycles >= 1);
  const end = play('4');
  assert.ok(!active(end).includes('solar-underperformance'));
  assert.ok(recovered(end).includes('solar-underperformance'));
  assert.ok(end.session.verifier.results.every((v) => v.outcome === Outcome.NO_CHANGE));
  assert.ok(recovered(end).includes('cleaning-no-improvement'), 'the no-improvement diagnostic recovers once output is good again');
});

test('5 Wind fluctuating: blades speed varies, calm gaps are HEALTHY (output not detected, not a fault)', () => {
  const r = play('5');
  const volts = r.session.history.map((s) => s.wind.voltageV);
  assert.ok(Math.max(...volts) > 1.5);
  assert.ok(volts.filter((v) => v < 0.1).length >= 8, 'calm gaps exist');
  assert.equal(channels(r).wind.status, 'HEALTHY');
  assert.ok(active(r).every((id) => id === 'piezo-unavailable'));
  assert.match(channels(r).wind.note, /not wind speed/);
});

test('6 Piezo pulses: tile configured by the pz flag, 12 steps counted, channel healthy between pulses', () => {
  const r = play('6');
  assert.equal(r.session.latest.piezo.steps, 12);
  assert.equal(channels(r).piezo.status, 'HEALTHY');
  assert.ok(!active(r).includes('piezo-unavailable'));
  const mid = play('6', 16);
  assert.equal(mid.session.latest.piezo.steps, 3);
  assert.equal(channels(mid).piezo.status, 'HEALTHY', 'no footsteps for a while must never look like a failed sensor');
});

test('7 Battery: CHARGING while sun and rising, STABLE in the dark plateau, DISCHARGING when falling; always an estimate', () => {
  const state = (t) => { const r = play('7', t); return r.session.batteryState(r.now).state; };
  assert.equal(state(45), 'CHARGING');
  assert.equal(state(90), 'STABLE');
  assert.equal(state(125), 'DISCHARGING');
  const r = play('7', 40);
  assert.equal(r.session.latest.battery.estimated, true);
  assert.equal(channels(r).battery.status, 'HEALTHY');
  assert.match(channels(r).battery.note, /estimated from voltage/);
});

test('8 Cleaning cycle: IDLE, CHECKING, CLEANING, COOLDOWN, IDLE with matching timeline events', () => {
  const r = play('8');
  const states = r.session.history.map((x) => x.cleaner.state).filter((v, i, a) => i === 0 || v !== a[i - 1]);
  assert.deepEqual(states, ['IDLE', 'CHECKING', 'CLEANING', 'COOLDOWN', 'IDLE']);
  assert.ok(titles(r).includes('Cleaning cycle started'));
  assert.ok(titles(r).includes('Cleaning cycle completed'));
  assert.equal(r.session.verifier.results[0].outcome, Outcome.NO_CHANGE);
});

test('9 Cleaning then improved output: OUTPUT IMPROVED with a trigger explanation, no no-improvement diagnostic', () => {
  const r = play('9');
  const [v] = r.session.verifier.results;
  assert.equal(r.session.verifier.results.length, 1);
  assert.equal(v.outcome, Outcome.IMPROVED);
  assert.ok(v.after.mA > v.before.mA * 5);
  assert.match(v.trigger, /started this cycle/);
  assert.ok(!active(r).includes('cleaning-no-improvement'));
  assert.ok(!recovered(r).includes('cleaning-no-improvement'));
});

test('10 Cleaning with no improvement: every cycle verifies NO SIGNIFICANT CHANGE and the diagnostic stays active', () => {
  const r = play('10');
  assert.ok(r.session.verifier.results.length >= 2);
  assert.ok(r.session.verifier.results.every((v) => v.outcome === Outcome.NO_CHANGE));
  const d = r.session.diagnostics.getActive().find((x) => x.ruleId === 'cleaning-no-improvement');
  assert.ok(d);
  assert.match(d.title, /No measurable improvement/);
  assert.match(d.explanation, /cause other than surface dirt/);
  assert.equal(d.subsystem, 'Cleaning');
  assert.ok(d.recovery.length > 20);
});

test('11 INA219 failure: DISCONNECTED (confirmed by firmware), never zero output, scene gets a fault state', () => {
  const r = play('11', 30);
  const solar = channels(r).solar;
  assert.equal(solar.status, 'DISCONNECTED');
  assert.equal(solar.confidence, 'CONFIRMED');
  assert.match(solar.error, /cannot see|only checks at boot/);
  assert.ok(active(r).includes('solar-unavailable'));
  assert.equal(r.session.diagnostics.getActive().find((d) => d.ruleId === 'solar-unavailable').severity, 'error');
  const bad = r.session.history.filter((s) => s.t >= T0 + 16000);
  assert.ok(bad.every((s) => s.solar.status === 'UNAVAILABLE' && !('currentmA' in s.solar)));
  assert.ok(!active(r).includes('solar-underperformance'));
  assert.equal(channels(r).light.status, 'HEALTHY', 'other sensors are judged independently');
});

test('12 LDR: stuck at 4095 against a producing panel is SUSPECTED, then missing data is STALE; solar stays healthy', () => {
  const sus = channels(play('12', 45));
  assert.equal(sus.light.status, 'SUSPECTED FAILURE');
  assert.equal(sus.light.confidence, 'SUSPECTED');
  assert.match(sus.light.error, /disagree/);
  assert.equal(sus.solar.status, 'HEALTHY');
  const stale = channels(play('12', 70));
  assert.equal(stale.light.status, 'STALE');
  assert.equal(stale.solar.status, 'HEALTHY');
  assert.ok(active(play('12', 70)).includes('health-light'));
});

test('13 Wind data unavailable: STALE after 3.5 s, SUSPECTED after 30 s, other channels unaffected', () => {
  assert.equal(channels(play('13', 12)).wind.status, 'HEALTHY');
  const early = channels(play('13', 25));
  assert.equal(early.wind.status, 'STALE');
  assert.equal(early.wind.confidence, 'CONFIRMED');
  const late = channels(play('13', 55));
  assert.equal(late.wind.status, 'SUSPECTED FAILURE');
  assert.equal(late.wind.confidence, 'SUSPECTED');
  assert.equal(late.solar.status, 'HEALTHY');
  assert.equal(late.stream.status, 'HEALTHY');
  assert.ok(active(play('13', 55)).includes('health-wind'));
});

test('14 ESP32 disconnected: stale warning, then every channel DISCONNECTED, then restored; history is kept', () => {
  const stale = play('14', 22);
  assert.equal(channels(stale).stream.status, 'STALE');
  assert.ok(active(stale).includes('telemetry-stale'));
  assert.equal(stale.session.diagnostics.getActive().find((d) => d.ruleId === 'telemetry-stale').severity, 'critical');
  const down = play('14', 31);
  const c = channels(down);
  for (const id of ['solar', 'light', 'wind', 'battery']) assert.equal(c[id].status, 'DISCONNECTED', id);
  assert.equal(c.stream.status, 'DISCONNECTED');
  assert.ok(down.session.history.length >= 18);
  assert.ok(c.solar.reading, 'last valid value is kept as history');
  const back = play('14');
  assert.equal(channels(back).stream.status, 'HEALTHY');
  assert.ok(titles(back).includes('Connection restored'));
});

test('15 Malformed telemetry: bad lines ignored, parser health tracked separately, sensors keep their last valid values and recover', () => {
  const mid = play('15', 36);
  assert.ok(mid.session.counters.malformed >= 6);
  assert.equal(channels(mid).parser.status, 'WARNING');
  assert.ok(active(mid).includes('parser-errors'));
  assert.ok(mid.session.history.every((s) => Number.isFinite(s.light.raw)), 'no NaN reached the model');
  assert.ok(mid.session.latest.solar.status === 'AVAILABLE' || mid.session.history.some((s) => s.solar.status === 'AVAILABLE'));
  assert.equal(channels(mid).stream.status, 'HEALTHY');
  const end = play('15');
  assert.equal(channels(end).parser.status, 'HEALTHY');
  assert.equal(channels(end).solar.status, 'HEALTHY');
  assert.ok(recovered(end).includes('parser-errors'));
});

test('16 Recovery: diagnostics raise, then become RECOVERED only after consecutive valid readings, and stay in history', () => {
  const mid = play('16', 28);
  assert.equal(channels(mid).solar.status, 'DISCONNECTED');
  assert.equal(channels(mid).wind.status, 'STALE');
  assert.ok(active(mid).includes('solar-unavailable'));
  assert.ok(active(mid).includes('health-wind'));

  const early = play('16', 41); // wind has returned for only ~2 readings
  assert.equal(channels(early).wind.status, 'WARNING');
  assert.match(channels(early).wind.error, /Recovering after a fault: \d of 5/);
  assert.ok(active(early).includes('health-wind'), 'not recovered yet');

  const end = play('16');
  const c = channels(end);
  assert.equal(c.solar.status, 'HEALTHY');
  assert.equal(c.wind.status, 'HEALTHY');
  assert.deepEqual(active(end), ['piezo-unavailable']);
  const hist = end.session.diagnostics.getResolved();
  assert.ok(hist.some((d) => d.ruleId === 'solar-unavailable' && d.status === 'RECOVERED' && d.resolvedAt > d.firstDetectedAt));
  assert.ok(hist.some((d) => d.ruleId === 'health-wind' && d.status === 'RECOVERED'));
  assert.ok(titles(end).some((t) => t.startsWith('Recovered:')));
});

test('17 Changed light: verification refuses to claim success', () => {
  const r = play('17');
  assert.equal(r.session.verifier.results[0].outcome, Outcome.CONDITIONS);
  assert.equal(r.session.verifier.results[0].quality, 'CONFOUNDED');
});

test('lifecycle fields exist on every diagnostic in every scenario', () => {
  for (const { id } of SCENARIOS) {
    const { session } = play(id);
    for (const d of [...session.diagnostics.getActive(), ...session.diagnostics.getResolved()]) {
      for (const k of ['id', 'severity', 'subsystem', 'title', 'evidence', 'action', 'firstDetectedAt', 'lastUpdatedAt', 'status', 'recovery']) {
        assert.ok(d[k] !== undefined && d[k] !== null, `${id}: ${d.ruleId} missing ${k}`);
      }
      assert.ok(['info', 'warning', 'error', 'critical'].includes(d.severity), `${id}: ${d.ruleId} severity ${d.severity}`);
      assert.ok(['ACTIVE', 'RECOVERED'].includes(d.status));
    }
  }
});

test('a persistent condition never spams the timeline: each scenario stays under a sane event count', () => {
  for (const { id } of SCENARIOS) assert.ok(play(id).session.events.size < 40, id);
});
