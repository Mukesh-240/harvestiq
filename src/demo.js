// Deterministic demo scenarios. They emit lines in the REAL firmware format (including its
// quirks) and feed them through the same Session.ingestLine path as live data. A small
// emulator reproduces the sketch's IDLE -> CLEANING -> COOLDOWN logic at 1 s resolution so
// the cleaner states are realistic. Nothing here is random: the same scenario always
// produces the same lines. Results are SIMULATED, never hardware results.

const TWO_PI = Math.PI * 2;
const wob = (t, amp, period) => amp * Math.sin((TWO_PI * t) / period);

class FirmwareEmulator {
  state = 'IDLE';
  since = 0;
  dirtySince = null;
  cycles = 0;
  completed = 0;

  step(t, dirty) {
    if (this.state === 'IDLE') {
      if (dirty) {
        if (this.dirtySince === null) this.dirtySince = t;
        if (t - this.dirtySince >= 2) {
          this.state = 'CLEANING';
          this.since = t;
          this.cycles += 1;
          this.dirtySince = null;
        }
      } else {
        this.dirtySince = null;
      }
    } else if (this.state === 'CLEANING') {
      if (t - this.since >= 5) {
        this.state = 'COOLDOWN';
        this.since = t;
        this.completed += 1;
      }
    } else if (t - this.since >= 8) {
      this.state = 'IDLE';
    }
  }

  panel(ldr) {
    if (this.state === 'CLEANING') return 'CLEANING';
    if (this.state === 'COOLDOWN') return 'COOLDOWN';
    if (this.dirtySince !== null) return 'CHECKING';
    return ldr > 3000 ? 'NIGHT' : 'CLEAN';
  }
}

const NORMAL_MA = (t) => 18 + wob(t, 0.4, 7);
const LOW_MA = (t) => 1.8 + wob(t, 0.1, 5);
const BRIGHT_LDR = 900;
const DIM_LDR = 2300;
const CLEAN_MA = 17.4;

/** Default generator output: two gusts per 40 s, otherwise a quiet pull-down reading. */
const gust = (t) => {
  const c = t % 40;
  return c >= 6 && c < 18 ? 1.1 + 0.6 * Math.sin((Math.PI * (c - 6)) / 12) : 0.02;
};

/** Scenario 5: irregular but fully deterministic gusts with calm gaps (generator output ~0). */
const gustyWind = (t) => {
  if (t % 30 >= 22) return 0.02;
  return Math.min(2.2, Math.max(0.05, 0.95 + 0.8 * Math.sin(t / 4.2) + 0.4 * Math.sin(t / 1.7)));
};

/** Scenario 15: between t=15 and t=38, two of every three lines are corrupted in a different way. */
const BAD_LINES = [
  (line) => line.slice(0, 44), // truncated JSON
  (line) => line.replace(/"wV":[^,]+/, '"wV":nan'), // printf NaN is not valid JSON
  (line) => line.replace(/"smA":[^,]+/, '"smA":"abc"'), // valid JSON, wrong type
  (line) => line.slice(0, 70), // truncated again
  (line) => line.replace(/"smA":[^,]+/, '"smA":99999'), // valid JSON, impossible value
  (line) => line.replace(/"bV":[^,]+/, '"bV":inf'), // printf inf is not valid JSON
  () => '@@@ corrupted bytes @@@', // not JSON at all
];
const isBad = (t) => t >= 15 && t <= 38 && t % 3 !== 0;

/** Each scenario returns physical conditions per second; the emulator supplies cleaner state. */
export const SCENARIOS = Object.freeze([
  {
    id: '1', name: 'Normal operation', length: 60,
    blurb: 'Healthy solar output in bright light with wind gusts. Every hardware channel healthy; piezo is NOT CONFIGURED, exactly like the real build.',
    cond: (t) => ({ smA: NORMAL_MA(t) }),
  },
  {
    id: '2', name: 'Strong sunlight', length: 50,
    blurb: 'Very bright light and high panel current. Sun rays are at full strength; nothing is flagged.',
    cond: (t) => ({ ldr: 350 + Math.round(wob(t, 20, 11)), smA: 38 + wob(t, 0.8, 7), sV: 5.6 + wob(t, 0.05, 9) }),
  },
  {
    id: '3', name: 'Low sunlight', length: 50,
    blurb: 'Dim light and low panel current. The dashboard says low output is consistent with low light and does NOT suggest cleaning.',
    cond: (t) => ({ ldr: 2500 + Math.round(wob(t, 40, 13)), smA: 1.5 + wob(t, 0.1, 6), sV: 4.6 + wob(t, 0.04, 9) }),
  },
  {
    id: '4', name: 'Possible solar underperformance', length: 70,
    blurb: 'Output collapses in bright light (shading), the firmware cleans without effect, then the shade is removed at 40 s and the warning recovers.',
    cond: (t) => ({ smA: t < 8 || t >= 40 ? NORMAL_MA(t) : 1.6 + wob(t, 0.15, 5) }),
  },
  {
    id: '5', name: 'Wind-generator output fluctuating', length: 60,
    blurb: 'Gusts and calm gaps. The turbine speeds up and slows with generator voltage; in calm gaps it says output is not detected, not that there is no wind.',
    cond: (t) => ({ smA: NORMAL_MA(t), wV: gustyWind(t) }),
  },
  {
    id: '6', name: 'Piezoelectric pulse events', length: 60,
    blurb: 'A simulated piezo tile (enabled by a pz flag) receives 12 footsteps. The tile presses and the step counter rises only when a pulse is measured.',
    cond: (t) => ({ smA: NORMAL_MA(t) }),
    piezoSteps: [8, 10, 11, 19, 20, 21, 22, 35, 36, 47, 48, 49],
  },
  {
    id: '7', name: 'Battery charging estimate', length: 130,
    blurb: 'Voltage rises under sun (CHARGING), holds when dark (STABLE), then falls (DISCHARGING). Percentages are voltage-derived estimates. Voltage changes are accelerated for the demo.',
    cond: (t) => ({
      ldr: t < 50 ? 700 : 3300,
      smA: t < 50 ? 22 + wob(t, 0.4, 7) : 0,
      bRate: t < 50 ? 0.004 : t < 100 ? 0 : -0.002,
    }),
    bV0: 3.55,
  },
  {
    id: '8', name: 'Cleaning cycle', length: 60,
    blurb: 'IDLE, CONFIRMING, CLEANING, COOLDOWN, IDLE. The cover is only removed after the verification window, so the result is no significant change.',
    cond: (t) => ({ smA: t >= 8 && t < 24 ? 2.4 + wob(t, 0.1, 5) : NORMAL_MA(t) }),
  },
  {
    id: '9', name: 'Cleaning followed by improved output', length: 50,
    blurb: 'Low baseline, one cleaning cycle, then clearly higher output in unchanged light: OUTPUT IMPROVED with a LIMITED data-quality rating (only ~2 baseline samples).',
    cond: (t, emu) => ({ smA: t < 8 ? NORMAL_MA(t) : emu.completed === 0 ? LOW_MA(t) : CLEAN_MA + wob(t, 0.4, 7) }),
  },
  {
    id: '10', name: 'Cleaning with no measurable improvement', length: 60,
    blurb: 'Output stays low through repeated cycles. Each verification says NO SIGNIFICANT CHANGE and a "no improvement after cleaning" diagnostic stays active.',
    cond: (t) => ({ smA: t < 8 ? NORMAL_MA(t) : LOW_MA(t) }),
  },
  {
    id: '11', name: 'INA219 communication failure', length: 50,
    blurb: 'The firmware reports the INA219 is not detected (ina=0). Solar is DISCONNECTED (confirmed by firmware), never shown as zero output; the scene shows a sensor warning.',
    cond: (t) => ({ smA: NORMAL_MA(t), ina: t >= 15 ? 0 : 1 }),
  },
  {
    id: '12', name: 'LDR stale or suspected failure', length: 90,
    blurb: 'From 10 s the LDR reads a constant 4095 (NIGHT) while the panel makes 18 mA: SUSPECTED FAILURE, not confirmed. From 50 s the LDR field disappears: STALE.',
    cond: (t) => ({ smA: NORMAL_MA(t), ldr: t >= 10 ? 4095 : BRIGHT_LDR + Math.round(wob(t, 15, 13)) }),
    omit: (t) => (t >= 50 ? ['ldr', 'light'] : []),
  },
  {
    id: '13', name: 'Wind sensor data unavailable', length: 60,
    blurb: 'The wind reading stops arriving at 15 s while everything else updates: STALE after 3.5 s, SUSPECTED FAILURE after 30 s. The turbine stops presenting a live measurement.',
    cond: (t) => ({ smA: NORMAL_MA(t), wV: 1.2 }),
    omit: (t) => (t >= 15 ? ['wV', 'wmW'] : []),
  },
  {
    id: '14', name: 'ESP32 disconnected', length: 60,
    blurb: 'Telemetry goes silent (stale), then the port drops, then the link is restored. All live animation stops; history is kept and marked historical.',
    cond: (t) => ({ smA: NORMAL_MA(t) }),
    link: (t) => (t >= 24 && t < 36 ? 'disconnected' : 'connected'),
    silent: (t) => t >= 18 && t < 36,
  },
  {
    id: '15', name: 'Invalid telemetry / malformed JSON', length: 90,
    blurb: 'Between 15 s and 38 s most lines are corrupted (truncated, NaN, wrong type, impossible value, noise). Bad lines are ignored, the parser reports its own health separately from the sensors, and everything recovers.',
    cond: (t) => ({ smA: NORMAL_MA(t) }),
    mangle: (t, line) => (isBad(t) ? BAD_LINES[(t - 15) % BAD_LINES.length](line) : line),
  },
  {
    id: '16', name: 'Sensor recovery after failure', length: 70,
    blurb: 'The INA219 drops out (15-32 s) and the wind reading disappears (20-38 s), then both return. Diagnostics become RECOVERED only after 5 consecutive valid readings and stay in the history.',
    cond: (t) => ({ smA: NORMAL_MA(t), ina: t >= 15 && t < 33 ? 0 : 1, wV: 1.2 }),
    omit: (t) => (t >= 20 && t < 39 ? ['wV', 'wmW'] : []),
  },
  {
    id: '17', name: 'Cleaning with changed light (inconclusive)', length: 50,
    blurb: 'Output rises after cleaning but the light level changed a lot: verification says INCONCLUSIVE and refuses to claim success.',
    cond: (t, emu) =>
      t < 8 ? { smA: NORMAL_MA(t) } : emu.completed === 0 ? { smA: LOW_MA(t) } : { smA: 6.5 + wob(t, 0.2, 6), ldr: DIM_LDR },
  },
]);

const fixed = (x, d) => Number(x).toFixed(d);

function buildFrames(def) {
  const emu = new FirmwareEmulator();
  const frames = [];
  let bV = def.bV0 ?? 3.82;
  let smWh = 0;
  let wmWh = 0;
  let capV = 0.05;
  let steps = 0;
  let puJ = 0;
  for (let t = 0; t < def.length; t += 1) {
    const c = { ina: 1, ldr: BRIGHT_LDR + Math.round(wob(t, 15, 13)), wV: gust(t), ...def.cond(t, emu) };
    const inaOk = c.ina === 1;
    const sV = inaOk ? c.sV ?? 5.35 + wob(t, 0.05, 11) : 0;
    const smA = inaOk ? c.smA : 0;
    const smW = sV * smA;
    const wV = c.wV;
    const wmW = wV > 0.3 ? (wV * wV * 1000) / 200 : 0;
    bV = Math.min(4.2, Math.max(3.0, bV + (c.bRate ?? (smA > 1 ? 0.0012 : -0.0003))));
    smWh += smW / 3600;
    wmWh += wmW / 3600;

    if (def.piezoSteps?.includes(t)) {
      const before = capV;
      capV += 0.45;
      steps += 1;
      puJ += 0.5 * 470e-6 * (capV ** 2 - before ** 2) * 1e6;
    } else {
      capV = Math.max(0.05, capV * 0.82);
    }

    emu.step(t, inaOk && c.ldr < 1500 && smA < 3.0);
    const light = c.ldr > 3000 ? 'NIGHT' : c.ldr < 1500 ? 'BRIGHT' : 'DIM';
    const bPct = Math.max(0, Math.min(100, Math.trunc(((bV - 3) / 1.2) * 100)));
    const fields = [
      ['ldr', `${c.ldr}`], ['light', `"${light}"`], ['ina', `${inaOk ? 1 : 0}`],
      ['sV', fixed(sV, 2)], ['smA', fixed(smA, 1)], ['smW', fixed(smW, 1)],
      ['wV', fixed(wV, 2)], ['wmW', fixed(wmW, 2)],
      ...(def.piezoSteps ? [['pz', '1'], ['cV', fixed(capV, 2)], ['steps', `${steps}`], ['puJ', fixed(puJ, 1)]] : [['cV', '0.00'], ['steps', '0'], ['puJ', '0.0']]),
      ['bV', fixed(bV, 2)], ['bPct', `${bPct}`],
      ['panel', `"${emu.panel(c.ldr)}"`], ['cycles', `${emu.cycles}`],
      ['smWh', fixed(smWh, 4)], ['wmWh', fixed(wmWh, 4)],
    ];
    const omit = new Set(def.omit?.(t) ?? []);
    const raw = `{${fields.filter(([k]) => !omit.has(k)).map(([k, v]) => `"${k}":${v}`).join(',')}}`;
    frames.push({
      t,
      link: def.link ? def.link(t) : 'connected',
      line: def.silent?.(t) ? null : def.mangle ? def.mangle(t, raw) : raw,
    });
  }
  return frames;
}

const cache = new Map();
export function scenarioFrames(id) {
  const def = SCENARIOS.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown scenario ${id}`);
  if (!cache.has(id)) cache.set(id, buildFrames(def));
  return cache.get(id);
}

export const SPEEDS = Object.freeze([1, 2, 4]);

/**
 * Plays one scenario into a demo Session. Exactly one timer exists at a time (arm() always clears
 * first). Simulated time is a virtual clock so pausing, resuming and speed changes cannot trigger
 * false stale-data detections: the UI must read time from clock(), not Date.now().
 */
export class DemoSource {
  #timer = null;
  #tick = 0;
  #session;
  #frames;
  #base = 0;
  #speed = 1;
  #state = 'idle'; // idle | running | paused
  #lastStepReal = 0;
  #frozenFrac = 0;
  #nowFn;

  constructor({ session, scenarioId, intervalMs = 1000, speed = 1, nowFn = Date.now }) {
    this.#session = session;
    this.scenarioId = scenarioId;
    this.intervalMs = intervalMs;
    this.#speed = SPEEDS.includes(speed) ? speed : 1;
    this.#nowFn = nowFn;
    this.#frames = scenarioFrames(scenarioId);
  }

  get state() {
    return this.#state;
  }

  get speed() {
    return this.#speed;
  }

  get tick() {
    return this.#tick;
  }

  get length() {
    return this.#frames.length;
  }

  get finished() {
    return this.#tick >= this.#frames.length;
  }

  get hasTimer() {
    return this.#timer !== null;
  }

  start(now = this.#nowFn()) {
    this.#clear();
    this.#base = now;
    this.#tick = 0;
    this.#frozenFrac = 0;
    this.#state = 'running';
    this.#session.setConnection('connected', now);
    this.step();
    this.#arm();
  }

  pause() {
    if (this.#state !== 'running') return;
    this.#frozenFrac = this.#fraction();
    this.#clear();
    this.#state = 'paused';
  }

  resume() {
    if (this.#state !== 'paused') return;
    this.#state = 'running';
    this.#lastStepReal = this.#nowFn() - this.#frozenFrac / this.#speed;
    this.#arm();
  }

  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) throw new Error(`Unsupported demo speed ${speed}`);
    if (this.#state === 'running') this.#frozenFrac = this.#fraction();
    this.#speed = speed;
    if (this.#state === 'running') {
      this.#lastStepReal = this.#nowFn() - this.#frozenFrac / speed;
      this.#arm();
    }
  }

  stop() {
    if (this.#state === 'running') this.#frozenFrac = this.#fraction();
    this.#clear();
    this.#state = 'idle';
  }

  /** Simulated "now" in epoch ms: advances smoothly while running, frozen otherwise. */
  clock(real = this.#nowFn()) {
    if (this.#tick === 0) return this.#base;
    const lastFrameT = this.#base + (this.#tick - 1) * 1000;
    const frac = this.#state === 'running' ? Math.min((real - this.#lastStepReal) * this.#speed, 999) : this.#frozenFrac;
    return lastFrameT + Math.max(0, frac);
  }

  /** Advance one second of simulated time. After the scenario ends its last (steady) frame repeats. */
  step(now = this.#base + this.#tick * 1000) {
    const frame = this.#frames[Math.min(this.#tick, this.#frames.length - 1)];
    this.#tick += 1;
    this.#lastStepReal = this.#nowFn();
    const conn = this.#session.connection.state;
    if (frame.link === 'disconnected' && conn === 'connected') {
      this.#session.setConnection('disconnected', now, { reason: 'Simulated serial disconnection' });
    } else if (frame.link === 'connected' && conn !== 'connected') {
      this.#session.setConnection('connected', now);
    }
    if (frame.line !== null && frame.link === 'connected') this.#session.ingestLine(frame.line, now);
  }

  #fraction() {
    return Math.min((this.#nowFn() - this.#lastStepReal) * this.#speed, 999);
  }

  #arm() {
    this.#clear();
    this.#timer = setInterval(() => this.step(), this.intervalMs / this.#speed);
  }

  #clear() {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}
