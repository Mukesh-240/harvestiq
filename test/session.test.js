import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../src/session.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { liveSession, feed, line, T0 } from './helpers.js';

const at = (sec) => T0 + sec * 1000;
const titles = (session) => session.events.all().map((e) => e.title);
const count = (session, title) => titles(session).filter((t) => t === title).length;

test('valid telemetry updates state and link becomes RECEIVING', () => {
  const session = liveSession();
  assert.equal(session.linkState(at(0)), 'AWAITING_DATA');
  feed(session, 0, 3);
  assert.equal(session.linkState(at(3)), 'RECEIVING');
  assert.equal(session.history.length, 3);
  assert.equal(session.latest.solar.currentmA, 18);
  assert.equal(session.health(at(3)).level, 'ok');
  assert.equal(count(session, 'Valid telemetry received'), 1);
});

test('malformed, text and unrecognised lines never crash and never create samples', () => {
  const session = liveSession();
  feed(session, 0, 1);
  const junk = ['{"ldr":900,"sV":5.3,"smA":1', '{"ldr":900,"wV":nan}', '=====', 'LIGHT : BRIGHT (LDR raw 900)', '{"hello":1}', '\u0000\u0001', '{', '[1,2]', '', 'null'];
  for (const j of junk) assert.doesNotThrow(() => session.ingestLine(j, at(1)));
  assert.equal(session.history.length, 1);
  assert.equal(session.counters.malformed, 3); // truncated, NaN, lone "{"
  assert.equal(session.counters.rejected, 1); // valid JSON, not telemetry
  assert.equal(session.counters.text, 5);
  assert.ok(session.consoleLines.length > 0);
});

test('malformed-line events are rate limited', () => {
  const session = liveSession();
  for (let i = 0; i < 50; i += 1) session.ingestLine('{"broken', at(i / 5));
  assert.equal(count(session, 'Malformed telemetry line ignored'), 1);
  assert.equal(session.counters.malformed, 50);
});

test('stale telemetry: link goes STALE, diagnostic raised once, resolved when data resumes', () => {
  const session = liveSession();
  feed(session, 0, 5);
  session.tick(at(5));
  assert.equal(session.linkState(at(5)), 'RECEIVING');
  for (let s = 8; s < 20; s += 1) session.tick(at(s));
  assert.equal(session.linkState(at(19)), 'STALE');
  assert.equal(session.health(at(19)).label, 'STALE');
  assert.equal(count(session, 'Controller telemetry timeout'), 1);
  feed(session, 20, 4);
  assert.equal(session.linkState(at(24)), 'RECEIVING');
  assert.ok(titles(session).includes('Recovered: Controller telemetry timeout'));
});

test('connected but never receiving valid data is reported separately', () => {
  const session = liveSession();
  session.ingestLine('Booting...', at(1));
  session.ingestLine('{"oops', at(2));
  for (let s = 1; s <= 9; s += 1) session.tick(at(s));
  assert.equal(session.linkState(at(9)), 'AWAITING_DATA');
  assert.ok(session.diagnostics.getActive().some((d) => d.ruleId === 'no-data'));
  assert.ok(!session.diagnostics.getActive().some((d) => d.ruleId === 'telemetry-stale'));
});

test('disconnect keeps history but stops presenting data as current', () => {
  const session = liveSession();
  feed(session, 0, 10);
  session.setConnection('disconnected', at(10), { reason: 'cable pulled' });
  assert.equal(session.linkState(at(10)), 'NO_CONNECTION');
  assert.equal(session.history.length, 10);
  assert.ok(session.latest);
  assert.equal(session.health(at(10)).label, 'OFFLINE');
  const lost = session.events.all().find((e) => e.title === 'Connection lost');
  assert.equal(lost.severity, 'critical');
  assert.equal(session.connection.failures, 1);
});

test('reconnect logs a restore and does not treat old data as fresh', () => {
  const session = liveSession();
  feed(session, 0, 5);
  session.setConnection('disconnected', at(5), {});
  session.setConnection('connected', at(30));
  assert.equal(session.linkState(at(30)), 'AWAITING_DATA');
  assert.equal(count(session, 'Connection restored'), 1);
  feed(session, 31, 2);
  assert.equal(session.linkState(at(33)), 'RECEIVING');
});

test('user disconnect is informational, a cancelled chooser creates no events', () => {
  const session = new Session({ mode: 'live', now: T0 });
  session.setConnection('connecting', at(0));
  session.setConnection('idle', at(1), { cancelled: true });
  assert.equal(session.events.size, 1); // application started only
  session.setConnection('connected', at(2));
  session.setConnection('disconnected', at(3), { user: true });
  const ev = session.events.all().find((e) => e.title === 'Disconnected by user');
  assert.equal(ev.severity, 'info');
  assert.equal(session.connection.failures, 0);
});

test('cleaner transitions create exactly one start and one completion event per cycle', () => {
  const session = liveSession();
  let t = feed(session, 0, 3);
  t = feed(session, t, 5, { panel: 'CLEANING', cycles: 1, smA: 1 });
  t = feed(session, t, 8, { panel: 'COOLDOWN', cycles: 1, smA: 1 });
  feed(session, t, 5, { panel: 'CLEAN', cycles: 1 });
  assert.equal(count(session, 'Cleaning cycle started'), 1);
  assert.equal(count(session, 'Cleaning cycle completed'), 1);
  assert.equal(session.cleaningCycles, 1);
});

test('a persistent warning produces one timeline entry, not one per second', () => {
  const session = liveSession();
  feed(session, 0, 120, { smA: 1.5 });
  const raised = session.events.all().filter((e) => e.type === 'diag-raised' && e.title === 'Possible solar underperformance');
  assert.equal(raised.length, 1);
  assert.ok(session.events.size < 12);
});

test('unavailable INA219 is never shown as zero current and does not trigger solar rules', () => {
  const session = liveSession();
  feed(session, 0, 10, { ina: 0, sV: 0, smA: 0, smW: 0 });
  assert.equal(session.latest.solar.status, 'UNAVAILABLE');
  assert.equal('currentmA' in session.latest.solar, false);
  const ids = session.diagnostics.getActive().map((d) => d.ruleId);
  assert.ok(ids.includes('solar-unavailable'));
  assert.ok(!ids.includes('solar-underperformance'));
});

test('live and demo sessions are fully isolated and sources are tagged', () => {
  const live = liveSession();
  const demo = new Session({ mode: 'demo', now: T0 });
  demo.setConnection('connected', T0);
  feed(demo, 0, 5);
  assert.equal(demo.history.length, 5);
  assert.ok(demo.history.every((s) => s.source === 'demo'));
  assert.equal(live.history.length, 0);
  assert.equal(live.latest, null);
  feed(live, 0, 2);
  assert.ok(live.history.every((s) => s.source === 'live'));
  assert.equal(demo.history.length, 5);
});

test('out-of-order samples are ignored; history is bounded', () => {
  const session = liveSession();
  feed(session, 10, 2);
  session.ingestLine(line(), at(5));
  assert.equal(session.history.length, 2);
  assert.equal(session.counters.outOfOrder, 1);
});

test('subscribers are notified and can unsubscribe', () => {
  const session = liveSession();
  let calls = 0;
  const off = session.subscribe(() => { calls += 1; });
  feed(session, 0, 2);
  assert.ok(calls >= 2);
  off();
  const before = calls;
  feed(session, 2, 2);
  assert.equal(calls, before);
});

test('review 3: a dark room or a pinned-bright reading never raises a diagnostic (undetermined findings stay on the health tile)', () => {
  const dark = liveSession();
  feed(dark, 0, 40, { ldr: 4095, light: 'NIGHT', smA: 0, smW: 0 });
  assert.deepEqual(dark.diagnostics.getActive().filter((d) => d.severity !== 'info'), [], 'at most informational notices in a dark room');
  assert.equal(dark.healthSnapshot(T0 + 39500).find((c) => c.id === 'light').status, 'HEALTHY');
  const bright = liveSession();
  feed(bright, 0, 40, { ldr: 2, light: 'BRIGHT', smA: 20 });
  assert.equal(bright.healthSnapshot(T0 + 39500).find((c) => c.id === 'light').status, 'WARNING');
  assert.ok(!bright.diagnostics.getActive().some((d) => d.ruleId === 'health-light'));
});

test('review 4: disabling a configured piezo cannot leave its incident stuck active', () => {
  const on = { ...DEFAULT_CONFIG, piezo: { enabled: true } };
  const s = new Session({ mode: 'live', config: on, now: T0 });
  s.setConnection('connected', T0);
  feed(s, 0, 6, { cV: 0.1, steps: 0 });
  feed(s, 6, 40, { cV: undefined, steps: undefined });
  s.tick(T0 + 46000);
  assert.ok(s.diagnostics.getActive().some((d) => d.ruleId === 'health-piezo'), 'raised while missing');
  s.setConfig({ ...on, piezo: { enabled: false } });
  feed(s, 46, 8, {});
  s.tick(T0 + 54500);
  assert.ok(!s.diagnostics.getActive().some((d) => d.ruleId === 'health-piezo'));
  assert.ok(s.diagnostics.getResolved().some((d) => d.ruleId === 'health-piezo'));
});

test('review 6: a mid-cycle join is reported as insufficient data, not as invalid sensors', () => {
  const s = liveSession();
  feed(s, 0, 3, { smA: 1.8, panel: 'CLEANING', cycles: 1 });
  feed(s, 3, 8, { smA: 17, panel: 'COOLDOWN', cycles: 1 });
  assert.ok(s.events.all().some((e) => e.title === 'Verification inconclusive: insufficient or invalid sensor data'));
});

test('firmware v3.2: pz=1 enables the piezo without the setting, and an INA219 lost mid-run is DISCONNECTED, not zero', () => {
  const s = liveSession(); // default config: "Piezo attached" setting OFF
  const at = (sec) => T0 + sec * 1000;
  const next = feed(s, 0, 5, (i) => ({ pz: 1, cV: 0.2 * i, steps: i, puJ: 10 * i }));
  const piezo = s.healthSnapshot(at(next - 1)).find((c) => c.id === 'piezo');
  assert.equal(piezo.status, 'HEALTHY');
  assert.equal(piezo.confidence, 'CONFIRMED');
  assert.equal(s.latest.piezo.steps, 4);

  feed(s, next, 2, { pz: 1, ina: 0, sV: 0, smA: 0, smW: 0 }); // v3.2 re-check reports the loss
  const solar = s.healthSnapshot(at(next + 1)).find((c) => c.id === 'solar');
  assert.equal(solar.status, 'DISCONNECTED');
  assert.notEqual(s.latest.solar.status, 'AVAILABLE');
});

test('piezo NOT CONFIGURED says which sketch the board is running, from its banner line', () => {
  const at = (sec) => T0 + sec * 1000;
  const piezoNote = (banner) => {
    const s = liveSession();
    if (banner) s.ingestLine(banner, at(0));
    feed(s, 1, 4); // no pz flag, like the old solar+wind sketch
    return s.healthSnapshot(at(4)).find((c) => c.id === 'piezo');
  };

  const old = piezoNote('  SOLAR + WIND HARVESTER + CLEANER');
  assert.equal(old.status, 'NOT CONFIGURED');
  assert.match(old.note, /SOLAR \+ WIND HARVESTER \+ CLEANER/);
  assert.match(old.note, /Upload firmware/);

  assert.match(piezoNote(null).note, /press EN/);
  assert.match(piezoNote('SOLAR + WIND + PIEZO HARVESTER v3.2').note, /not the current v3\.2 file/);
});

test('a firmware with no pz flag enables the piezo once it reports real values, and keeps it enabled between steps', () => {
  const s = liveSession();
  const at = (sec) => T0 + sec * 1000;
  const piezo = (sec) => s.healthSnapshot(at(sec)).find((c) => c.id === 'piezo');

  feed(s, 0, 3); // placeholders: cV 0, steps 0
  assert.equal(piezo(2).status, 'NOT CONFIGURED');

  feed(s, 3, 2, { cV: 0.79, steps: 5, puJ: 315.5 });
  assert.equal(piezo(4).status, 'HEALTHY');
  assert.equal(s.latest.piezo.steps, 5);

  feed(s, 5, 3, { cV: 0, steps: 5, puJ: 315.5 }); // cap drained, steps stay: must NOT flip back
  assert.equal(piezo(7).status, 'HEALTHY');
  assert.equal(s.events.all().filter((e) => e.type === 'piezo-detected').length, 1); // logged once, not every line
});

test('piezo values printed only in the board\'s "PIEZO :" text line are used when its JSON sends zeros', () => {
  const s = liveSession();
  const at = (sec) => T0 + sec * 1000;
  for (let i = 0; i < 4; i += 1) {
    s.ingestLine('PIEZO : cap 0.79 V  steps 5  energy 315.5 uJ', at(i));
    s.ingestLine(line({ cV: 0, steps: 0, puJ: 0 }), at(i)); // JSON placeholders, no pz
  }
  const piezo = s.healthSnapshot(at(3)).find((c) => c.id === 'piezo');
  assert.equal(piezo.status, 'HEALTHY');
  assert.equal(s.latest.piezo.steps, 5);
  assert.equal(s.latest.piezo.capVoltageV, 0.79);
  assert.equal(s.events.all().filter((e) => e.type === 'piezo-detected').length, 1);

  // Real zeros with no recent text line stay placeholders (never invented).
  const quiet = liveSession();
  feed(quiet, 0, 4);
  assert.equal(quiet.healthSnapshot(at(3)).find((c) => c.id === 'piezo').status, 'NOT CONFIGURED');
});
