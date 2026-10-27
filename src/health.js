// Per-channel sensor health. Pure logic: no DOM, no clock (time comes from the arguments).
//
// Every hardware channel is judged on its OWN evidence: when it last produced a valid value,
// whether recent readings were invalid, and a few narrow plausibility checks. A live ESP32
// stream never makes a channel HEALTHY by itself. The browser cannot see I2C/ADC wiring, so
// anything it cannot prove is reported with confidence SUSPECTED or UNDETERMINED, never as a
// confirmed hardware failure. Only facts the firmware itself reports (e.g. ina=0) are CONFIRMED.

import { Health, Confidence, Link, Status, Cleaner, isAvailable } from './model.js';

const KEYS = ['solar', 'light', 'wind', 'piezo', 'battery'];
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

const newTracker = () => ({
  lastValidAt: null,
  lastInvalidAt: null,
  faultSince: null,
  validStreak: 0,
  invalidStreak: 0,
  lastProblem: null,
  lastValue: null,
  sameSince: null,
  sameValue: null,
  railSince: null,
});

export class SensorHealthMonitor {
  #trackers = Object.fromEntries(KEYS.map((k) => [k, newTracker()]));
  #parser = [];
  #battery = [];
  #crossSince = null;
  #seenSample = false;
  #lastT = null;
  #solarFlowAt = null;

  /** Duration trackers must not span an outage: "pinned for N s" cannot include time we were not listening. */
  #resetDurations() {
    this.#crossSince = null;
    for (const key of ['light', 'wind']) {
      const tr = this.#trackers[key];
      tr.sameSince = null;
      tr.sameValue = null;
      tr.railSince = null;
    }
  }

  /** Feed every accepted sample. */
  onSample(sample, cfg) {
    this.#seenSample = true;
    const t = sample.t;
    const h = cfg.health;
    if (this.#lastT !== null && t - this.#lastT > cfg.link.staleAfterMs) this.#resetDurations();
    this.#lastT = t;
    for (const key of KEYS) {
      const sensor = sample[key];
      const tr = this.#trackers[key];
      if (sensor.status === Status.AVAILABLE) {
        tr.lastValidAt = t;
        tr.validStreak += 1;
        tr.invalidStreak = 0;
        tr.lastProblem = null;
        if (tr.faultSince !== null && tr.validStreak >= h.recoverAfterValid) tr.faultSince = null;
      } else if (key === 'piezo' && String(sensor.kind).startsWith('disabled')) {
        // Disabled is a configuration state, not a fault: leave the tracker untouched.
        tr.validStreak = 0;
        tr.faultSince = null;
      } else {
        tr.validStreak = 0;
        tr.invalidStreak += 1;
        tr.lastInvalidAt = t;
        tr.faultSince ??= t;
        tr.lastProblem = sensor.reason ?? sensor.status;
      }
    }

    const light = sample.light;
    const lt = this.#trackers.light;
    if (isAvailable(light)) {
      lt.lastValue = light.raw;
      lt.sameSince = lt.sameValue === light.raw ? lt.sameSince : t;
      lt.sameValue = light.raw;
      const atRail = light.raw <= h.ldrRailLow || light.raw >= h.ldrRailHigh;
      lt.railSince = atRail ? lt.railSince ?? t : null;
    } else {
      lt.sameSince = null;
      lt.sameValue = null;
      lt.railSince = null;
    }

    const wt = this.#trackers.wind;
    if (isAvailable(sample.wind)) {
      const v = sample.wind.voltageV;
      const same = wt.sameValue !== null && Math.abs(v - wt.sameValue) <= h.windStuckEpsV;
      wt.sameSince = same ? wt.sameSince : t;
      wt.sameValue = same ? wt.sameValue : v;
      wt.lastValue = v;
    } else {
      wt.sameSince = null;
      wt.sameValue = null;
    }

    if (isAvailable(sample.battery)) {
      this.#battery.push({ t, v: sample.battery.voltageV });
      const cutoff = t - Math.max(h.batteryTrendMs * 2, 60000);
      while (this.#battery.length && this.#battery[0].t < cutoff) this.#battery.shift();
    }

    this.remember(sample);
    const night = isAvailable(light) && light.label === 'NIGHT';
    const solarFlowing = isAvailable(sample.solar) && sample.solar.currentmA >= h.ldrCrossCheckMa;
    this.#crossSince = night && solarFlowing ? this.#crossSince ?? t : null;
    if (isAvailable(sample.solar) && sample.solar.currentmA > cfg.firmware.solarOnMa) this.#solarFlowAt = t;
  }

  /** Record one JSON-looking line: 'ok' | 'malformed' | 'rejected'. Text lines are not parser errors. */
  onParser(kind, cfg) {
    this.#parser.push(kind);
    if (this.#parser.length > cfg.health.parserWindow) this.#parser.shift();
  }

  /** Reset everything (used when a session restarts). */
  reset() {
    this.#trackers = Object.fromEntries(KEYS.map((k) => [k, newTracker()]));
    this.#parser = [];
    this.#battery = [];
    this.#crossSince = null;
    this.#seenSample = false;
    this.#lastT = null;
    this.#solarFlowAt = null;
  }

  tracker(key) {
    return this.#trackers[key];
  }

  /** CHARGING / DISCHARGING / STABLE / UNKNOWN, each only when the readings support it. */
  batteryState(sample, t, cfg) {
    const h = cfg.health;
    if (!sample || !isAvailable(sample.battery)) return { state: 'UNKNOWN', why: 'No valid battery voltage.' };
    if (isAvailable(sample.solar) && sample.solar.currentmA > cfg.firmware.solarOnMa) {
      return { state: 'CHARGING', why: `Solar current ${fmt(sample.solar.currentmA)} mA is flowing into the charger (above the dashboard's ${fmt(cfg.firmware.solarOnMa)} mA charging threshold).` };
    }
    const win = this.#battery.filter((p) => p.t >= t - h.batteryTrendMs);
    if (win.length < 5 || win.at(-1).t - win[0].t < h.batteryTrendMs * 0.6) return { state: 'UNKNOWN', why: 'Not enough battery history to judge a trend.' };
    const delta = win.at(-1).v - win[0].v;
    const solarRecently = this.#solarFlowAt !== null && t - this.#solarFlowAt <= h.batteryTrendMs;
    if (delta <= -h.batteryTrendEpsV && solarRecently) return { state: 'UNKNOWN', why: 'Voltage fell, but solar current was flowing within the window, so "discharging" is not supported.' };
    if (delta <= -h.batteryTrendEpsV) return { state: 'DISCHARGING', why: `Voltage fell ${fmt(-delta * 1000, 0)} mV over ${h.batteryTrendMs / 1000} s with no solar input.` };
    if (delta >= h.batteryTrendEpsV) return { state: 'CHARGING', why: `Voltage rose ${fmt(delta * 1000, 0)} mV over ${h.batteryTrendMs / 1000} s.` };
    return { state: 'STABLE', why: `Voltage changed under ${fmt(h.batteryTrendEpsV * 1000, 0)} mV over ${h.batteryTrendMs / 1000} s.` };
  }

  parserHealth(cfg) {
    const h = cfg.health;
    const n = this.#parser.length;
    const bad = this.#parser.filter((k) => k !== 'ok').length;
    return { n, bad, ratio: n ? bad / n : 0, warn: bad >= h.parserMinBad && bad / n >= h.parserWarnRatio };
  }

  /**
   * Evaluate every channel.
   * ctx: { t, link, sample (latest or null), sinceConnectedMs, counters }
   * @returns {object[]} channel health objects
   */
  evaluate(ctx, cfg) {
    const { t, link, sample } = ctx;
    const h = cfg.health;
    const stale = cfg.link.staleAfterMs;
    const base = (id, name, gpio) => ({ id, name, gpio, status: Health.UNKNOWN, confidence: Confidence.UNDETERMINED, reading: null, unit: '', lastValidAt: null, ageMs: null, error: null, action: null, note: null, validStreak: 0 });
    const out = [];

    const offlineState = () => {
      if (link === Link.NO_CONNECTION || link === Link.CONNECTING) return { status: Health.DISCONNECTED, confidence: Confidence.CONFIRMED, error: 'ESP32 link is down, so this channel cannot be read. Last values are historical only.', action: 'Reconnect the ESP32 (check the USB cable and that no other program holds the port).' };
      if (link === Link.AWAITING_DATA) return { status: Health.UNKNOWN, confidence: Confidence.UNDETERMINED, error: 'Connected, but no valid telemetry has arrived yet.', action: 'Wait a few seconds; if nothing arrives, check baud (115200) and that the sketch is running.' };
      if (link === Link.STALE) return { status: Health.STALE, confidence: Confidence.CONFIRMED, error: 'The whole telemetry stream has stopped, so every channel is stale.', action: 'Check the USB cable and press EN on the ESP32.' };
      return null;
    };

    for (const spec of [
      { key: 'solar', id: 'solar', name: 'Solar (INA219)', gpio: 'I2C - D21 SDA / D22 SCL' },
      { key: 'light', id: 'light', name: 'Light (LDR)', gpio: 'GPIO34' },
      { key: 'wind', id: 'wind', name: 'Wind generator', gpio: 'GPIO35' },
      { key: 'piezo', id: 'piezo', name: 'Piezo tile', gpio: 'GPIO32' },
      { key: 'battery', id: 'battery', name: 'Battery voltage', gpio: 'GPIO33' },
    ]) {
      const ch = base(spec.id, spec.name, spec.gpio);
      const tr = this.#trackers[spec.key];
      const s = sample?.[spec.key];
      ch.lastValidAt = tr.lastValidAt;
      ch.ageMs = tr.lastValidAt === null ? null : Math.max(0, t - tr.lastValidAt);
      ch.validStreak = tr.validStreak;
      ch.reading = describeReading(spec.key, this.#lastGood(spec.key, sample));

      const off = offlineState();
      if (off) {
        Object.assign(ch, off);
        out.push(ch);
        continue;
      }
      if (!s || !this.#seenSample) {
        ch.error = 'No reading yet.';
        out.push(ch);
        continue;
      }

      ch.current = s.status === Status.AVAILABLE;

      // Piezo that is disabled is a configuration state, not a fault. Only a pz flag from the firmware is CONFIRMED.
      if (spec.key === 'piezo' && String(s.kind).startsWith('disabled')) {
        const fromFirmware = s.kind === 'disabled-firmware';
        Object.assign(ch, {
          status: Health.NOT_CONFIGURED,
          confidence: fromFirmware ? Confidence.CONFIRMED : Confidence.UNDETERMINED,
          reading: null,
          current: false,
          note: fromFirmware
            ? 'The firmware reports the piezo channel disabled (pz=0). The dashboard does not treat this as zero output.'
            : 'Treated as disabled because the "Piezo attached" setting is off and the firmware sent no pz flag (firmware v3.1). Firmware v3.2 reports pz itself; with v3.1, tick the setting if PIEZO_CONNECTED is true. Never shown as zero output.',
          action: 'Set PIEZO_CONNECTED true in the sketch and re-upload (v3.2 reports it automatically; with v3.1 also tick "Piezo attached" in Settings).',
        });
        out.push(ch);
        continue;
      }

      if (s.status === Status.AVAILABLE) {
        Object.assign(ch, { status: Health.HEALTHY, confidence: Confidence.CONFIRMED });
        this.#specific(spec.key, ch, s, sample, tr, t, cfg);
        if (ch.status === Health.HEALTHY && tr.faultSince !== null) {
          Object.assign(ch, { status: Health.WARNING, confidence: Confidence.CONFIRMED, error: `Recovering after a fault: ${tr.validStreak} of ${h.recoverAfterValid} consecutive valid readings.`, action: 'No action needed unless it fails again; it counts as recovered after the required valid readings.' });
        }
        out.push(ch);
        continue;
      }

      // Not AVAILABLE. Classify by WHY, never by how long we have been listening.
      ch.error = s.reason ?? 'Reading unavailable.';
      // Time without a valid reading: since its last valid one, or since it first went bad if it was never valid.
      const silentMs = tr.lastValidAt !== null ? t - tr.lastValidAt : t - (tr.faultSince ?? t);
      if (s.kind === 'not-detected') {
        Object.assign(ch, { status: Health.DISCONNECTED, confidence: Confidence.CONFIRMED, error: 'The firmware reports the INA219 was not detected (ina=0). Firmware v3.2 re-checks it every 0.5 s, so this also covers a sensor lost after boot (v3.1 only checks at boot).', action: 'Check INA219 VCC/GND and SDA->D21, SCL->D22 (not the screw terminals), then reset the ESP32.' });
      } else if (s.kind === 'implausible-low') {
        Object.assign(ch, { status: Health.SUSPECTED, confidence: Confidence.SUSPECTED, error: `${s.reason} This is not an empty battery: the divider or battery is probably not connected.`, action: 'Measure the node with a multimeter; check the two 100k resistors and the TP4056 B+/B- wiring.' });
      } else if (s.status === Status.ERROR) {
        // Values ARRIVE but are invalid: a data-quality problem, not silence.
        if (tr.invalidStreak >= h.suspectInvalidCount) {
          Object.assign(ch, { status: Health.SUSPECTED, confidence: Confidence.SUSPECTED, error: `${tr.invalidStreak} consecutive invalid readings: ${ch.error}`, action: troubleshooting(spec.key) });
        } else {
          Object.assign(ch, { status: Health.WARNING, confidence: Confidence.CONFIRMED, error: `Invalid reading: ${ch.error}`, action: 'Ignored (the last valid value is kept). Persistent repeats suggest wiring or a divider problem.' });
        }
      } else if (silentMs > h.suspectStaleMs) {
        Object.assign(ch, { status: Health.SUSPECTED, confidence: Confidence.SUSPECTED, error: `No valid ${spec.name} reading for ${fmt(silentMs / 1000, 0)} s while the rest of the stream is live. Cause unknown: sensor, wiring, ADC or firmware.`, action: troubleshooting(spec.key) });
      } else if (silentMs > stale) {
        Object.assign(ch, { status: Health.STALE, confidence: Confidence.CONFIRMED, error: `No valid ${spec.name} reading for ${fmt(silentMs / 1000, 1)} s while other channels still update. ${ch.error}`, action: troubleshooting(spec.key) });
      } else {
        Object.assign(ch, { status: Health.WARNING, confidence: Confidence.CONFIRMED, error: `${ch.error} (not yet long enough to call it stale).`, action: 'Wait a few seconds; a single missing reading is not a fault.' });
      }
      out.push(ch);
    }

    out.push(this.#stream(ctx, cfg));
    out.push(this.#parserChannel(ctx, cfg));
    out.push(this.#cleaner(ctx, sample));
    return out;
  }

  #lastGood(key, sample) {
    const s = sample?.[key];
    if (s && s.status === Status.AVAILABLE) return s;
    return this.#last?.[key] ?? null;
  }

  #last = {};

  /** Remember the last AVAILABLE sensor object per channel so stale/invalid channels can show "last valid". */
  remember(sample) {
    for (const k of KEYS) if (isAvailable(sample[k])) this.#last = { ...this.#last, [k]: sample[k] };
  }

  #specific(key, ch, s, sample, tr, t, cfg) {
    const h = cfg.health;
    if (key === 'solar') {
      ch.note = s.currentmA === 0 ? 'Valid zero-current reading. This is normal in darkness or shade; it is not treated as a sensor fault.' : s.currentmA < cfg.firmware.solarOnMa ? 'Valid low-power reading.' : null;
      ch.note = `${ch.note ? `${ch.note} ` : ''}The browser cannot independently confirm INA219 hardware health, only that valid values keep arriving.`;
    } else if (key === 'light') {
      const label = s.label;
      const cross = this.#crossSince !== null && t - this.#crossSince >= h.ldrCrossCheckMs;
      const railed = tr.railSince !== null && t - tr.railSince >= h.ldrRailMs;
      const darkEnd = s.raw >= h.ldrRailHigh;
      const stuck = tr.sameSince !== null && t - tr.sameSince >= h.ldrStuckMs && !railed;
      if (cross) {
        Object.assign(ch, { status: Health.SUSPECTED, confidence: Confidence.SUSPECTED, error: `The LDR reports ${label} (raw ${s.raw}) but solar current has been above ${h.ldrCrossCheckMa} mA for ${fmt((t - this.#crossSince) / 1000, 0)} s. Light and panel output disagree.`, action: 'Check the LDR module wiring (AO->D34) and that it sits beside the panel in the same light. A lamp aimed only at the panel can also cause this.' });
      } else if (railed && darkEnd) {
        // This module reads HIGH in the dark, so a pinned high reading is exactly what a dark room looks like.
        ch.note = `Reading is at the dark end of the ADC range (raw ${s.raw}) for ${fmt((t - tr.railSince) / 1000, 0)} s. That is normal in darkness (this module reads HIGH when dark); an open circuit would look the same, so cover/uncover the sensor if you doubt it.`;
      } else if (railed) {
        Object.assign(ch, { status: Health.WARNING, confidence: Confidence.UNDETERMINED, error: `Reading pinned at the bright end of the ADC range (raw ${s.raw}) for ${fmt((t - tr.railSince) / 1000, 0)} s. This can be glare/saturation or a short to ground.`, action: 'Shade the sensor: a working LDR reading should rise. If it never moves, check AO->D34, VCC and GND.' });
      } else if (stuck) {
        Object.assign(ch, { status: Health.WARNING, confidence: Confidence.UNDETERMINED, error: `Identical raw value (${s.raw}) for ${fmt((t - tr.sameSince) / 60000, 0)} min. Constant light would also do this.`, action: 'Change the light on the sensor and watch for a response.' });
      }
    } else if (key === 'wind') {
      const stuck = tr.sameSince !== null && s.voltageV > h.windStuckEpsV * 4 && t - tr.sameSince >= h.windStuckMs;
      ch.note = 'This is generator output voltage, not wind speed. Zero output does not prove there is no wind: a slow motor can stay under the diode drop.';
      if (stuck) Object.assign(ch, { status: Health.WARNING, confidence: Confidence.UNDETERMINED, error: `Generator voltage has stayed at ${fmt(s.voltageV, 2)} V for ${fmt((t - tr.sameSince) / 1000, 0)} s. Real wind output fluctuates; a floating or shorted input can look constant.`, action: 'Spin the propeller by hand and watch for a response; check the D35 divider node (row 10).' });
    } else if (key === 'piezo') {
      ch.note = 'Piezo output arrives as brief pulses. Quiet periods between footsteps are normal.';
    } else if (key === 'battery') {
      ch.note = 'Percentage is estimated from voltage (3.0 V = 0 %, 4.2 V = 100 %); the ADC and divider are uncalibrated, so treat it as approximate.';
    }
  }

  #stream(ctx, cfg) {
    const { link, t } = ctx;
    const ch = { current: ctx.link === Link.RECEIVING, id: 'stream', name: 'ESP32 telemetry stream', gpio: 'USB serial, 115200 baud', status: Health.UNKNOWN, confidence: Confidence.CONFIRMED, reading: null, unit: '', lastValidAt: ctx.lastTelemetryAt ?? null, ageMs: ctx.lastTelemetryAt ? t - ctx.lastTelemetryAt : null, error: null, action: null, note: null, validStreak: 0 };
    if (link === Link.RECEIVING) Object.assign(ch, { status: Health.HEALTHY, reading: `receiving, last line ${fmt(ch.ageMs / 1000, 1)} s ago`, note: 'This only means lines arrive. Each sensor is judged separately.' });
    else if (link === Link.STALE) Object.assign(ch, { status: Health.STALE, error: `No valid telemetry for ${fmt(ch.ageMs / 1000, 1)} s (limit ${fmt(cfg.link.staleAfterMs / 1000, 1)} s).`, action: 'Check the USB cable and press EN on the ESP32.' });
    else if (link === Link.AWAITING_DATA) Object.assign(ch, { status: Health.UNKNOWN, confidence: Confidence.UNDETERMINED, error: 'Port open but no valid telemetry yet.', action: 'Confirm baud 115200 and that the sketch is running.' });
    else Object.assign(ch, { status: Health.DISCONNECTED, error: 'No serial connection.', action: 'Connect the ESP32 (LIVE mode) or start a demo scenario.' });
    return ch;
  }

  #parserChannel(ctx, cfg) {
    const p = this.parserHealth(cfg);
    const ch = { current: ctx.link === Link.RECEIVING, id: 'parser', name: 'Telemetry parser', gpio: 'dashboard', status: Health.UNKNOWN, confidence: Confidence.CONFIRMED, reading: p.n ? `${p.n - p.bad} of ${p.n} recent lines valid` : null, unit: '', lastValidAt: ctx.lastTelemetryAt ?? null, ageMs: ctx.lastTelemetryAt ? ctx.t - ctx.lastTelemetryAt : null, error: null, action: null, note: 'Parser problems (bad lines) are tracked separately from sensor faults.', validStreak: 0 };
    if (p.n === 0) return ch;
    if (p.warn) Object.assign(ch, { status: Health.WARNING, error: `${p.bad} of the last ${p.n} data lines were malformed or rejected (${Math.round(p.ratio * 100)} %).`, action: 'Check cable quality and baud rate; look at the Serial console for the raw lines.' });
    else Object.assign(ch, { status: Health.HEALTHY });
    return ch;
  }

  #cleaner(ctx, sample) {
    const ch = { id: 'cleaner', name: 'Cleaner feedback', gpio: 'GPIO25 -> L298N IN1', status: Health.NOT_CONFIGURED, confidence: Confidence.CONFIRMED, reading: null, unit: '', lastValidAt: null, ageMs: null, error: null, action: null, note: 'There is no motor-current or vibration feedback in this build. The state below is what the ESP32 firmware reports; the motor itself is not measured.', validStreak: 0 };
    const c = sample?.cleaner;
    if (c && c.status === Status.AVAILABLE && ctx.link === Link.RECEIVING) ch.reading = `ESP32 reports ${c.state === Cleaner.IDLE ? 'IDLE' : c.state}`;
    return ch;
  }
}

function troubleshooting(key) {
  return {
    solar: 'Check INA219 power and I2C wiring (SDA D21, SCL D22), then reset the ESP32.',
    light: 'Check the LDR module wiring (AO->D34, VCC, GND).',
    wind: 'Check the wind divider node (row 10) wired to D35, and the 1N4007 orientation.',
    piezo: 'Check the piezo bridge/divider wiring to D32.',
    battery: 'Check the battery divider (100k/100k) on D33 and the TP4056 B+/B- wiring.',
  }[key];
}

function describeReading(key, s) {
  if (!s) return null;
  switch (key) {
    case 'solar': return `${fmt(s.currentmA)} mA - ${fmt(s.voltageV, 2)} V - ${fmt(s.powermW, s.powermW < 10 ? 1 : 0)} mW`;
    case 'light': return `raw ${s.raw} (${s.label})`;
    case 'wind': return `${fmt(s.voltageV, 2)} V generator output`;
    case 'piezo': return s.status === Status.AVAILABLE ? `${s.steps} steps - cap ${fmt(s.capVoltageV, 2)} V` : null;
    case 'battery': return `${fmt(s.voltageV, 2)} V (~${s.pctEstimate}% est.)`;
    default: return null;
  }
}
