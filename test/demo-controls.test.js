import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { DemoSource, SCENARIOS, scenarioFrames, SPEEDS } from '../src/demo.js';
import { Session } from '../src/session.js';
import { heroView } from '../src/ui/render.js';
import { liveSession, feed, T0 } from './helpers.js';

function withTimers(fn) {
  return async () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: T0 });
    const active = new Set();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = (...args) => {
      const id = realSet(...args);
      active.add(id);
      return id;
    };
    globalThis.clearInterval = (id) => {
      active.delete(id);
      return realClear(id);
    };
    try {
      await fn(active);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      mock.timers.reset();
    }
  };
}

const make = (id = '1', speed = 1) => {
  const session = new Session({ mode: 'demo', now: T0 });
  const source = new DemoSource({ session, scenarioId: id, speed });
  return { session, source };
};

test('start arms exactly one timer; restarting never stacks timers', withTimers((active) => {
  const { source } = make();
  source.start();
  source.start();
  source.start();
  assert.equal(active.size, 1);
  assert.equal(source.hasTimer, true);
  source.stop();
  assert.equal(active.size, 0);
  assert.equal(source.state, 'idle');
}));

test('timer advances one simulated second per second at 1x', withTimers(() => {
  const { source, session } = make();
  source.start();
  assert.equal(source.tick, 1);
  mock.timers.tick(5000);
  assert.equal(source.tick, 6);
  assert.equal(session.history.length, 6);
}));

test('pause freezes ticking and the virtual clock; resume continues; stale is never flagged while paused', withTimers((active) => {
  const { source, session } = make();
  source.start();
  mock.timers.tick(4000);
  mock.timers.tick(400);
  source.pause();
  const frozenAt = source.clock();
  const ticks = source.tick;
  mock.timers.tick(120000); // two minutes of wall time while paused
  assert.equal(source.tick, ticks);
  assert.equal(source.clock(), frozenAt);
  assert.equal(active.size, 0);
  session.tick(source.clock());
  assert.equal(session.linkState(source.clock()), 'RECEIVING');
  assert.equal(session.diagnostics.getActive().some((d) => d.ruleId === 'telemetry-stale'), false);

  source.resume();
  assert.equal(active.size, 1);
  mock.timers.tick(3000);
  assert.equal(source.tick, ticks + 3);
  assert.ok(source.clock() >= frozenAt);
}));

test('pause/resume are no-ops in the wrong state and cannot create a second timer', withTimers((active) => {
  const { source } = make();
  source.resume();
  source.pause();
  assert.equal(active.size, 0);
  source.start();
  source.resume();
  assert.equal(active.size, 1);
  source.pause();
  source.pause();
  source.resume();
  source.resume();
  assert.equal(active.size, 1);
}));

test('speed multiplies tick rate, rejects unsupported values, and keeps a single timer', withTimers((active) => {
  const { source } = make('1', 4);
  source.start();
  const before = source.tick;
  mock.timers.tick(1000);
  assert.equal(source.tick - before, 4);
  source.setSpeed(2);
  const mid = source.tick;
  mock.timers.tick(1000);
  assert.equal(source.tick - mid, 2);
  assert.equal(active.size, 1);
  assert.throws(() => source.setSpeed(3));
  assert.deepEqual([...SPEEDS], [1, 2, 4]);
}));

test('virtual clock tracks scenario time, not wall clock', withTimers(() => {
  const { source } = make('1', 4);
  source.start();
  mock.timers.tick(10000); // 40 simulated seconds
  assert.ok(source.clock() - T0 >= 39000 && source.clock() - T0 <= 41000);
}));

test('a finished scenario reports finished and keeps a steady state', withTimers(() => {
  const { source } = make('9', 4);
  source.start();
  mock.timers.tick(60000);
  assert.equal(source.finished, true);
  assert.equal(source.state, 'running');
}));

// ---- hero view-model: every animation must be justified by a valid, current measurement ----

const ui = { lastStepAt: -Infinity };
const hero = (session, now) => heroView(session, now, ui);
const noBadNumbers = (view) => {
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /NaN|undefined|Infinity|null%/);
};

test('hero view-model never produces NaN/undefined across every scenario and second', () => {
  for (const { id } of SCENARIOS) {
    const { session, source } = make(id);
    session.setConnection('connected', T0);
    for (let t = 0; t < source.length; t += 1) {
      source.step(T0 + t * 1000);
      noBadNumbers(hero(session, T0 + t * 1000 + 300));
    }
  }
});

test('nothing animates before any data, or while disconnected / stale', () => {
  const idle = new Session({ mode: 'live', now: T0 });
  let v = hero(idle, T0);
  assert.equal(v.solar.on, false);
  assert.equal(v.wind.on, false);
  assert.equal(v.battery.charging, false);
  assert.equal(v.cleaner.on, false);
  assert.equal(v.light, 'offline');

  const s = liveSession();
  feed(s, 0, 5, { smA: 18, wV: 1.6, panel: 'CLEANING', cycles: 1 });
  v = hero(s, T0 + 4500);
  assert.equal(v.solar.on, true);
  assert.equal(v.wind.on, true);
  assert.equal(v.cleaner.on, true);
  assert.equal(v.battery.charging, true);

  const stale = hero(s, T0 + 30000);
  assert.equal(stale.solar.on, false);
  assert.equal(stale.wind.on, false);
  assert.equal(stale.cleaner.on, false);
  assert.equal(stale.battery.charging, false);
  assert.match(stale.solar.label, /OFFLINE|NO DATA/);

  s.setConnection('disconnected', T0 + 6000, {});
  const off = hero(s, T0 + 6500);
  assert.equal(off.solar.on || off.wind.on || off.cleaner.on || off.battery.charging, false);
  assert.equal(off.esp.state, 'offline');
});

test('unavailable sensors are shown as unavailable and drive no motion', () => {
  const s = liveSession();
  feed(s, 0, 4, { ina: 0, sV: 0, smA: 0, smW: 0, bV: 0.02, wV: 0.02 });
  const v = hero(s, T0 + 3500);
  assert.match(v.solar.label, /UNAVAILABLE/);
  assert.equal(v.solar.on, false);
  assert.match(v.battery.label, /UNAVAILABLE/);
  assert.equal(v.battery.pct, null);
  assert.equal(v.battery.charging, false);
  assert.match(v.piezo.label, /NOT CONFIGURED/);
  assert.equal(v.wind.on, false); // reading is valid but idle: blades stay still
});

test('cleaning progress follows the ESP32-reported state only', () => {
  const s = liveSession();
  feed(s, 0, 3, { panel: 'CHECKING' });
  assert.equal(hero(s, T0 + 2500).cleaner.on, false); // low output being confirmed is not cleaning
  feed(s, 3, 3, { panel: 'CLEANING', cycles: 1 });
  const mid = hero(s, T0 + 3000 + 2500);
  assert.equal(mid.cleaner.on, true);
  assert.ok(mid.cleaner.progress > 0.3 && mid.cleaner.progress < 0.7, String(mid.cleaner.progress));
  assert.match(mid.cleaner.label, /^CLEANING \d\/5 s$/);
  feed(s, 6, 2, { panel: 'COOLDOWN', cycles: 1 });
  const done = hero(s, T0 + 7500);
  assert.equal(done.cleaner.on, false);
  assert.equal(done.cleaner.progress, 0);
});

test('a live session never reports demo data: scenario frames only reach a demo session', () => {
  const live = liveSession();
  const { session, source } = make('9');
  session.setConnection('connected', T0);
  for (let t = 0; t < 20; t += 1) source.step(T0 + t * 1000);
  assert.equal(live.history.length, 0);
  assert.equal(hero(live, T0 + 20000).simulated, false);
  assert.equal(hero(session, T0 + 20000).simulated, true);
  assert.ok(scenarioFrames('9').length > 0);
});

test('piezo steps in scenario 6 raise the step counter and mark the sensor available', () => {
  const { session, source } = make('6');
  session.setConnection('connected', T0);
  for (let t = 0; t < 20; t += 1) source.step(T0 + t * 1000);
  assert.equal(session.latest.piezo.status, 'AVAILABLE');
  assert.equal(session.latest.piezo.steps, 4); // scripted steps at t = 8, 10, 11, 19
  const v = hero(session, T0 + 19500);
  assert.match(v.piezo.label, /PIEZO\s+4 steps/);
});

test('hero view-model survives a missing timing constant without NaN (defensive)', () => {
  const s = liveSession();
  feed(s, 0, 4, { panel: 'CLEANING', cycles: 1 });
  s.setConfig({ ...s.config, firmware: { ...s.config.firmware, cleanMs: undefined } });
  const v = hero(s, T0 + 3500);
  assert.equal(Number.isFinite(v.cleaner.progress), true);
});

// ---- physical realism: the scene follows measurements and per-channel health ----

const withHealth = (session, t) => heroView(session, t, ui, session.healthSnapshot(t));

test('sun-ray intensity follows the measured light level and is zero without a current reading', () => {
  const strong = liveSession();
  feed(strong, 0, 4, { ldr: 350, light: 'BRIGHT' });
  const dim = liveSession();
  feed(dim, 0, 4, { ldr: 2600, light: 'DIM', smA: 1.5 });
  const night = liveSession();
  feed(night, 0, 4, { ldr: 3900, light: 'NIGHT', smA: 0 });
  const r = (s) => withHealth(s, T0 + 3500).rays;
  assert.ok(r(strong) > 0.9, `strong ${r(strong)}`);
  assert.ok(r(dim) > 0.1 && r(dim) < 0.5, `dim ${r(dim)}`);
  assert.ok(r(night) < 0.15, `night ${r(night)}`);
  assert.equal(withHealth(strong, T0 + 60000).rays, 0, 'stale link: no sunlight animation');
});

test('solar sensor failure shows a sensor-warning state, never produced energy', () => {
  const s = liveSession();
  feed(s, 0, 6, { ina: 0, sV: 0, smA: 0, smW: 0 });
  const v = withHealth(s, T0 + 5500);
  assert.equal(v.faults.solar, true);
  assert.match(v.solar.label, /SENSOR FAULT/);
  assert.equal(v.solar.on, false);
  assert.equal(v.battery.charging, false);
});

test('wind: zero output says "output not detected" (not "no wind"); a failed wind sensor stops the animation', () => {
  const calm = liveSession();
  feed(calm, 0, 5, { wV: 0.02, wmW: 0 });
  const c = withHealth(calm, T0 + 4500);
  assert.match(c.wind.label, /output not detected/);
  assert.doesNotMatch(c.wind.label, /no wind/i);
  assert.equal(c.wind.on, false);
  assert.equal(c.faults.wind, false, 'zero output is not a fault');

  const dead = liveSession();
  feed(dead, 0, 4, { wV: 1.5 });
  feed(dead, 4, 40, { wV: undefined });
  const v = withHealth(dead, T0 + 43500);
  assert.equal(v.wind.on, false);
  assert.equal(v.faults.wind, true);
  assert.match(v.wind.label, /SENSOR (SUSPECT|STALE)/);
});

test('battery label states charging / discharging / stable only when supported, and always an estimate', () => {
  const charging = liveSession();
  feed(charging, 0, 5, { smA: 20 });
  const c = withHealth(charging, T0 + 4500);
  assert.match(c.battery.label, /charging/);
  assert.equal(c.battery.estText, 'estimate');

  const unknown = liveSession();
  feed(unknown, 0, 3, { smA: 0, ldr: 3500, light: 'NIGHT' });
  assert.doesNotMatch(withHealth(unknown, T0 + 2500).battery.label, /charging|discharging|stable/);

  const gone = liveSession();
  feed(gone, 0, 5, { bV: 0.03 });
  const g = withHealth(gone, T0 + 4500);
  assert.equal(g.battery.pct, null);
  assert.match(g.battery.label, /UNAVAILABLE|SENSOR/);
});

test('cleaner shows a cooldown countdown only for the firmware-reported COOLDOWN state', () => {
  const s = liveSession();
  feed(s, 0, 2, { panel: 'CLEANING', cycles: 1 });
  feed(s, 2, 3, { panel: 'COOLDOWN', cycles: 1 });
  const v = withHealth(s, T0 + 4500);
  assert.match(v.cleaner.label, /^COOLDOWN ~\d+ s left$/);
  const idle = liveSession();
  feed(idle, 0, 3);
  assert.equal(withHealth(idle, T0 + 2500).cleaner.label, 'CLEANER - IDLE');
  assert.equal(withHealth(idle, T0 + 2500).cleaner.on, false);
});
