import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBeforeAfter, percentChange, Outcome, Quality } from '../src/verification.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { liveSession, feed } from './helpers.js';

const pts = (mA, n, ldr = 900) => Array.from({ length: n }, (_, i) => ({ t: i * 1000, mA, mW: mA * 5.3, V: 5.3, ldr }));
const compare = (before, after, flags = {}) => compareBeforeAfter(before, after, flags, DEFAULT_CONFIG);

test('percentChange handles zero, tiny and non-finite baselines without dividing by zero', () => {
  assert.equal(percentChange(2, 3), 50);
  assert.equal(percentChange(10, 5), -50);
  assert.equal(percentChange(0, 5), null);
  assert.equal(percentChange(0.01, 5), null);
  assert.equal(percentChange(NaN, 5), null);
  assert.equal(percentChange(5, Infinity), null);
  assert.equal(percentChange(undefined, 5), null);
});

test('improved output in unchanged light', () => {
  const r = compare(pts(1.8, 3), pts(17.4, 4));
  assert.equal(r.outcome, Outcome.IMPROVED);
  assert.equal(r.quality, Quality.GOOD);
  assert.ok(Math.abs(r.deltaMa - 15.6) < 1e-9);
  assert.ok(r.pctMa > 800);
  assert.match(r.explanation, /not proof/);
});

test('no significant change and decreased output', () => {
  assert.equal(compare(pts(1.8, 3), pts(2.1, 4)).outcome, Outcome.NO_CHANGE);
  assert.equal(compare(pts(10, 3), pts(5, 4)).outcome, Outcome.DECREASED);
  assert.equal(compare(pts(100, 3), pts(104, 4)).outcome, Outcome.NO_CHANGE); // +4 mA but only +4 %
});

test('zero baseline: absolute change decides and percentage is null', () => {
  const r = compare(pts(0, 3), pts(5, 4));
  assert.equal(r.pctMa, null);
  assert.equal(r.outcome, Outcome.IMPROVED);
  assert.match(r.explanation, /near-zero/);
  assert.equal(compare(pts(0, 3), pts(0, 4)).outcome, Outcome.NO_CHANGE);
});

test('missing baseline or missing post-cleaning data is inconclusive', () => {
  const noBase = compare([], pts(17, 4));
  assert.equal(noBase.outcome, Outcome.DATA);
  assert.equal(noBase.quality, Quality.INSUFFICIENT);
  assert.equal(noBase.pctMa, null);
  assert.equal(compare(pts(1.8, 3), []).outcome, Outcome.DATA);
  assert.equal(compare(pts(1.8, 3), pts(17, 1)).outcome, Outcome.DATA);
  assert.equal(compare([], []).outcome, Outcome.DATA);
});

test('a large light change makes the comparison inconclusive and confounded', () => {
  const r = compare(pts(1.8, 3, 900), pts(17, 4, 2300));
  assert.equal(r.outcome, Outcome.CONDITIONS);
  assert.equal(r.quality, Quality.CONFOUNDED);
  assert.equal(r.lightChanged, true);
  assert.match(r.reasons.join(' '), /Light changed/);
});

test('missing light data degrades quality but cannot be silently ignored', () => {
  const r = compare(pts(1.8, 3, null), pts(17, 4, null));
  assert.equal(r.quality, Quality.LIMITED);
  assert.match(r.reasons.join(' '), /Light data unavailable/);
});

test('interrupted telemetry, mid-cycle joins and unstable readings are inconclusive', () => {
  assert.equal(compare(pts(1.8, 3), pts(17, 4), { dataGap: true }).outcome, Outcome.DATA);
  assert.equal(compare(pts(1.8, 3), pts(17, 4), { connectionLost: true }).outcome, Outcome.DATA);
  assert.equal(compare([], pts(17, 4), { midCycle: true }).outcome, Outcome.DATA);
  const wobbly = [1, 9, 2, 11].map((mA, i) => ({ t: i, mA, mW: mA, V: 5, ldr: 900 }));
  assert.equal(compare(wobbly, pts(17, 4)).outcome, Outcome.DATA);
  assert.equal(compare(pts(1.8, 3), wobbly).outcome, Outcome.DATA);
});

// ---- tracker driven by ESP32-reported states through a Session ----

function runCycle(session, { postMa = 17.4, postLdr = 900 } = {}) {
  let t = feed(session, 0, 5, { smA: 18 });
  t = feed(session, t, 2, { smA: 1.8, panel: 'CHECKING' });
  t = feed(session, t, 5, { smA: 1.8, panel: 'CLEANING', cycles: 1 });
  t = feed(session, t, 8, { smA: postMa, ldr: postLdr, panel: 'COOLDOWN', cycles: 1 });
  return t;
}

test('tracker captures the CHECKING baseline, waits for ESP32-reported completion, then compares', () => {
  const session = liveSession();
  runCycle(session);
  const [result] = session.verifier.results;
  assert.equal(session.verifier.results.length, 1);
  assert.equal(result.outcome, Outcome.IMPROVED);
  assert.equal(result.before.n, 2);
  assert.equal(result.after.n, 4);
  assert.equal(result.before.mA, 1.8);
  assert.equal(result.after.mA, 17.4);
  const titles = session.events.all().map((e) => e.title);
  assert.ok(titles.includes('Verification baseline captured'));
  assert.ok(titles.includes('Verification: OUTPUT IMPROVED'));
  assert.equal(session.verifier.active, null);
});

test('tracker reports inconclusive when light changes during the cycle', () => {
  const session = liveSession();
  runCycle(session, { postMa: 6.5, postLdr: 2300 });
  assert.equal(session.verifier.results[0].outcome, Outcome.CONDITIONS);
  assert.ok(session.events.all().some((e) => e.title === 'Verification inconclusive: conditions changed'));
});

test('no verification is invented when the ESP32 never reports a cleaning cycle', () => {
  const session = liveSession();
  feed(session, 0, 60, { smA: 1.5, panel: 'CHECKING' });
  assert.equal(session.verifier.results.length, 0);
  assert.equal(session.verifier.active, null);
});

test('joining mid-cycle cannot produce a successful verification', () => {
  const session = liveSession();
  let t = feed(session, 0, 3, { smA: 1.8, panel: 'CLEANING', cycles: 1 });
  feed(session, t, 8, { smA: 17.4, panel: 'COOLDOWN', cycles: 1 });
  assert.equal(session.verifier.results[0].outcome, Outcome.DATA);
});

test('losing the connection during verification finalises as inconclusive', () => {
  const session = liveSession();
  let t = feed(session, 0, 5, { smA: 18 });
  t = feed(session, t, 2, { smA: 1.8, panel: 'CHECKING' });
  t = feed(session, t, 3, { smA: 1.8, panel: 'CLEANING', cycles: 1 });
  session.setConnection('disconnected', 1_700_000_000_000 + t * 1000, { reason: 'unplugged' });
  const [result] = session.verifier.results;
  assert.equal(result.outcome, Outcome.DATA);
  assert.match(result.reasons.join(' '), /interrupted/);
});

test('a telemetry gap during the post-cleaning window is inconclusive', () => {
  const session = liveSession();
  let t = feed(session, 0, 5, { smA: 18 });
  t = feed(session, t, 2, { smA: 1.8, panel: 'CHECKING' });
  t = feed(session, t, 5, { smA: 1.8, panel: 'CLEANING', cycles: 1 });
  t = feed(session, t, 2, { smA: 17.4, panel: 'COOLDOWN', cycles: 1 });
  feed(session, t + 10, 3, { smA: 17.4, panel: 'COOLDOWN', cycles: 1 }); // 10 s silence
  assert.equal(session.verifier.results[0].outcome, Outcome.DATA);
});

test('a new cleaning cycle before enough post data finalises the previous one as inconclusive', () => {
  const session = liveSession();
  let t = feed(session, 0, 5, { smA: 18 });
  t = feed(session, t, 2, { smA: 1.8, panel: 'CHECKING' });
  t = feed(session, t, 5, { smA: 1.8, panel: 'CLEANING', cycles: 1 });
  t = feed(session, t, 1, { smA: 1.8, panel: 'COOLDOWN', cycles: 1 });
  feed(session, t, 1, { smA: 1.8, panel: 'CLEANING', cycles: 2 });
  assert.equal(session.verifier.results[0].outcome, Outcome.DATA);
  assert.ok(session.verifier.active, 'a fresh verification started for the new cycle');
});

test('each verification explains why the ESP32 started the cycle, without accusing dirt', () => {
  const session = liveSession();
  runCycle(session);
  const [r] = session.verifier.results;
  assert.match(r.trigger, /started this cycle after solar current 1\.8 mA/);
  assert.match(r.trigger, /does not prove the panel is dirty/);
});

test('inconclusive outcomes are distinct: invalid data vs changed conditions', () => {
  assert.notEqual(Outcome.DATA, Outcome.CONDITIONS);
  assert.match(Outcome.DATA, /SENSOR DATA INVALID/);
  assert.match(Outcome.CONDITIONS, /CONDITIONS CHANGED/);
});
