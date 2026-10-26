// Firmware adapter: the ONLY module that knows the ESP32 JSON field names.
// Firmware v3.1 emits one line per second, e.g.
// {"ldr":900,"light":"BRIGHT","ina":1,"sV":5.35,"smA":18.0,"smW":96.3,"wV":0.05,"wmW":0.0,
//  "cV":0.0,"steps":0,"puJ":0.0,"bV":3.91,"bPct":75,"panel":"CLEAN","cycles":0,"smWh":0.1,"wmWh":0.0}
// mixed with human-readable text lines (banner, "LIGHT : ...", "SOLAR : ...", totals).

import { DEFAULT_CONFIG } from './config.js';
import { Status, Cleaner, unavailable, errored, clamp } from './model.js';

const KNOWN_KEYS = ['ldr', 'ina', 'sV', 'smA', 'wV', 'bV', 'panel'];
const LIGHT_LABELS = new Set(['BRIGHT', 'DIM', 'NIGHT']);
const PANEL_STATES = {
  CLEAN: { state: Cleaner.IDLE, night: false },
  NIGHT: { state: Cleaner.IDLE, night: true },
  CHECKING: { state: Cleaner.CHECKING, night: false },
  CLEANING: { state: Cleaner.CLEANING, night: false },
  COOLDOWN: { state: Cleaner.COOLDOWN, night: false },
};

/** Classify one serial line. Never throws. */
export function parseLine(raw) {
  const line = String(raw ?? '').trim();
  if (!line) return { kind: 'empty' };
  if (line[0] !== '{') return { kind: 'text', text: line };
  let data;
  try {
    data = JSON.parse(line);
  } catch (error) {
    // Includes truncated lines and printf NaN/inf, which are not valid JSON.
    return { kind: 'malformed', text: line, error: error.message };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'malformed', text: line, error: 'JSON value is not an object' };
  }
  return { kind: 'telemetry', data };
}

function readNumber(raw, key, range) {
  const value = raw[key];
  if (value === undefined) return { ok: false, problem: 'missing' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, problem: 'invalid', value };
  if (range && (value < range[0] || value > range[1])) return { ok: false, problem: 'out-of-range', value, range };
  return { ok: true, value };
}

const problemText = (res) =>
  res.problem === 'out-of-range' ? `${res.value} outside ${res.range[0]}..${res.range[1]}` : res.problem;

/**
 * Convert a parsed firmware object into the internal sample.
 * @returns {{ok:true, sample:object} | {ok:false, reason:string}}
 */
export function normalizeTelemetry(raw, { t, source, config = DEFAULT_CONFIG }) {
  const present = KNOWN_KEYS.filter((k) => raw[k] !== undefined).length;
  if (present < 3) return { ok: false, reason: `not a telemetry object (${present}/${KNOWN_KEYS.length} known fields)` };

  const fw = config.firmware;
  const r = config.ranges;
  const issues = [];
  const flag = (field, res) => issues.push({ field, problem: res.problem, detail: problemText(res) });

  // ---- light ----
  const ldr = readNumber(raw, 'ldr', r.ldr);
  let light;
  if (ldr.ok) {
    const label = LIGHT_LABELS.has(raw.light)
      ? raw.light
      : ldr.value > fw.ldrNight ? 'NIGHT' : ldr.value < fw.ldrBright ? 'BRIGHT' : 'DIM';
    // The firmware label is authoritative so recalibrating LDR_BRIGHT in the sketch needs no dashboard change.
    light = { status: Status.AVAILABLE, raw: ldr.value, label, bright: label === 'BRIGHT' };
  } else {
    flag('ldr', ldr);
    light = ldr.problem === 'missing' ? unavailable('LDR reading not reported', 'missing') : errored(`LDR ${problemText(ldr)}`);
  }

  // ---- solar (INA219) ----
  let solar;
  if (raw.ina === 0) {
    solar = unavailable('INA219 not detected by the firmware (ina=0)', 'not-detected');
  } else if (raw.ina !== 1) {
    flag('ina', { problem: raw.ina === undefined ? 'missing' : 'invalid' });
    solar = errored('INA219 status flag missing or invalid');
  } else {
    const v = readNumber(raw, 'sV', r.solarV);
    const a = readNumber(raw, 'smA', r.solarMa);
    if (v.ok && a.ok) {
      const mW = readNumber(raw, 'smW', r.solarMw);
      solar = {
        status: Status.AVAILABLE,
        voltageV: v.value,
        currentmA: a.value, // firmware clamps negative current to 0, so swapped INA219 wires are not visible here
        powermW: mW.ok ? mW.value : v.value * a.value,
      };
    } else {
      if (!v.ok) flag('sV', v);
      if (!a.ok) flag('smA', a);
      const anyInvalid = [v, a].some((r) => !r.ok && r.problem !== 'missing');
      solar = anyInvalid ? errored('Solar voltage/current invalid') : unavailable('Solar voltage/current not reported', 'missing');
    }
  }

  // ---- wind (voltage across the 200 ohm load; power is an ESTIMATE V^2/R) ----
  const wV = readNumber(raw, 'wV', r.windV);
  let wind;
  if (wV.ok) {
    const wmW = readNumber(raw, 'wmW', r.windMw);
    const generating = wV.value > fw.windOnV;
    wind = {
      status: Status.AVAILABLE,
      voltageV: wV.value,
      powermW: wmW.ok ? wmW.value : generating ? (wV.value ** 2 / fw.windLoadOhms) * 1000 : 0,
      generating,
      estimated: true,
    };
  } else if (wV.problem === 'missing') {
    wind = unavailable('Wind voltage not reported', 'missing');
  } else {
    flag('wV', wV);
    wind = errored(`Wind voltage ${problemText(wV)}`);
  }

  // ---- piezo ----
  const piezoEnabled = raw.pz === 1 ? true : raw.pz === 0 ? false : config.piezo.enabled;
  let piezo;
  if (!piezoEnabled) {
    piezo = raw.pz === 0
      ? unavailable('The firmware reports the piezo channel is disabled (pz=0)', 'disabled-firmware')
      : unavailable('Piezo is treated as disabled: the "Piezo attached" setting is off. The firmware JSON does not report PIEZO_CONNECTED, so cV/steps are placeholders', 'disabled-setting');
  } else {
    const cV = readNumber(raw, 'cV', r.piezoCapV);
    const steps = readNumber(raw, 'steps', r.counter);
    if (cV.ok && steps.ok) {
      const puJ = readNumber(raw, 'puJ', r.counter);
      piezo = {
        status: Status.AVAILABLE,
        capVoltageV: cV.value,
        steps: Math.round(steps.value),
        energyuJ: puJ.ok ? puJ.value : null,
        estimated: true,
      };
    } else {
      if (!cV.ok) flag('cV', cV);
      if (!steps.ok) flag('steps', steps);
      const anyInvalid = [cV, steps].some((r) => !r.ok && r.problem !== 'missing');
      piezo = anyInvalid ? errored('Piezo reading invalid') : unavailable('Piezo reading not reported', 'missing');
    }
  }

  // ---- battery (voltage-divider estimate) ----
  const bV = readNumber(raw, 'bV', r.batteryV);
  let battery;
  if (bV.ok && bV.value < r.batteryPlausibleMinV) {
    battery = unavailable(`${bV.value.toFixed(2)} V is below a plausible Li-ion level - battery or divider not connected?`, 'implausible-low');
  } else if (bV.ok && bV.value > r.batteryPlausibleMaxV) {
    flag('bV', { problem: 'out-of-range', value: bV.value, range: [0, r.batteryPlausibleMaxV] });
    battery = errored(`${bV.value.toFixed(2)} V is above a safe Li-ion level`);
  } else if (bV.ok) {
    battery = {
      status: Status.AVAILABLE,
      voltageV: bV.value,
      pctEstimate: Math.round(clamp(((bV.value - fw.battEmptyV) / (fw.battFullV - fw.battEmptyV)) * 100, 0, 100)),
      estimated: true,
    };
  } else {
    flag('bV', bV);
    battery = bV.problem === 'missing' ? unavailable('Battery voltage not reported', 'missing') : errored(`Battery voltage ${problemText(bV)}`);
  }

  // ---- cleaner (state machine lives on the ESP32; we only observe) ----
  const mapped = PANEL_STATES[raw.panel];
  const cycles = readNumber(raw, 'cycles', r.counter);
  let cleaner;
  if (mapped) {
    cleaner = { status: Status.AVAILABLE, ...mapped, cycles: cycles.ok ? Math.round(cycles.value) : null, raw: raw.panel };
  } else {
    flag('panel', { problem: raw.panel === undefined ? 'missing' : 'invalid' });
    cleaner = { status: Status.ERROR, state: Cleaner.UNKNOWN, night: false, cycles: null, raw: String(raw.panel ?? '') };
  }

  const opt = (key) => {
    const res = readNumber(raw, key, r.counter);
    return res.ok ? res.value : null;
  };

  return {
    ok: true,
    sample: {
      t,
      source,
      light,
      solar,
      wind,
      piezo,
      battery,
      cleaner,
      totals: { solarmWh: opt('smWh'), windmWh: opt('wmWh'), piezouJ: opt('puJ') },
      issues,
    },
  };
}
