// Central configuration. Every threshold here is an ASSUMPTION to be calibrated on the real
// hardware, not a validated engineering limit. `firmware.*` mirrors constants compiled into
// firmware/multi_energy_harvester.ino v3.1 - keep them in sync if you recalibrate the sketch.

const deepFreeze = (obj) => {
  Object.values(obj).forEach((v) => {
    if (v && typeof v === 'object') deepFreeze(v);
  });
  return Object.freeze(obj);
};

export const DEFAULT_CONFIG = deepFreeze({
  serial: { baudRate: 115200, maxLineLength: 4096 },

  // Telemetry is ~1 Hz. 3.5 s tolerates one lost line before declaring the link stale.
  link: { staleAfterMs: 3500, noDataAfterMs: 6000 },

  firmware: {
    ldrBright: 1500, // LDR raw below this = BRIGHT (LDR reads HIGH in the dark)
    ldrNight: 3000,
    dirtyMa: 3.0, // bright light + solar below this = firmware "dirty"
    solarOnMa: 1.0,
    windOnV: 0.3,
    windLoadOhms: 200,
    battEmptyV: 3.0,
    battFullV: 4.2,
    dirtyConfirmMs: 2000, // CLEAN_MS / COOLDOWN_MS / DIRTY_CONFIRM_MS in the sketch
    cleanMs: 5000,
    cooldownMs: 8000,
  },

  // The firmware JSON has no piezo-enabled flag, so this must be set by the operator
  // (Settings) to match #define PIEZO_CONNECTED. A "pz" field in the JSON overrides it.
  piezo: { enabled: false },

  // Plausibility windows derived from the documented circuit (ADC pin max ~3.1 V, divider
  // ratios in the sketch, INA219 16 V / 400 mA calibration). Outside = reading rejected.
  ranges: {
    ldr: [0, 4095],
    solarV: [0, 16],
    solarMa: [0, 400],
    solarMw: [0, 6400],
    windV: [0, 6.6],
    windMw: [0, 250],
    piezoCapV: [0, 20],
    batteryV: [0, 6.6],
    counter: [0, 1e9],
    batteryPlausibleMinV: 2.0, // below this the divider/battery is almost certainly not connected
    batteryPlausibleMaxV: 4.5,
  },

  history: { maxSamples: 7200 }, // 2 h at 1 Hz

  // Sensor-health thresholds. Every one is an assumption to calibrate, not a validated limit.
  health: {
    suspectStaleMs: 30000, // a channel silent this long while the stream is alive = suspected failure
    suspectInvalidCount: 10, // consecutive invalid readings before SUSPECTED FAILURE
    recoverAfterValid: 5, // consecutive valid readings before a problem counts as RECOVERED
    ldrRailLow: 5,
    ldrRailHigh: 4090,
    ldrRailMs: 15000, // pinned at an ADC limit this long -> WARNING (may be genuine darkness)
    ldrStuckMs: 300000, // identical raw value this long (not at a limit) -> WARNING, undetermined
    ldrCrossCheckMa: 10, // solar current above this while the LDR says NIGHT is inconsistent
    ldrCrossCheckMs: 20000,
    windStuckMs: 60000, // identical NON-ZERO generator voltage this long -> WARNING, undetermined
    windStuckEpsV: 0.005,
    batteryTrendMs: 30000,
    batteryTrendEpsV: 0.01, // voltage change over the window that counts as rising/falling
    parserWindow: 30, // last N JSON-looking lines used for parser health
    parserMinBad: 3,
    parserWarnRatio: 0.2,
  },

  diagnostics: {
    solarUnderperformance: { raiseAfterMs: 4000, clearAfterMs: 3000, hysteresisMa: 0.5 },
    lowLight: { raiseAfterMs: 3000, clearAfterMs: 3000 },
    sensorUnavailable: { raiseAfterMs: 2000, clearAfterMs: 2000 },
    invalidData: { raiseAfterMs: 2000, clearAfterMs: 5000 },
    staleTelemetry: { raiseAfterMs: 0, clearAfterMs: 1000 },
    noData: { raiseAfterMs: 0, clearAfterMs: 1000 },
  },

  verification: {
    baselineWindowMs: 8000,
    baselineMaxSamples: 5,
    minBaselineSamples: 1, // firmware already confirmed 2 s of low output before cleaning
    baselineMaxSpreadMa: 1.0,
    baselineMaxSpreadRel: 0.25,
    settleMs: 2000, // wait after the ESP32 reports cleaning finished
    postSamples: 4,
    minPostSamples: 2,
    postWindowMs: 12000,
    significantAbsMa: 1.0,
    significantRelPct: 15,
    lightChangeRaw: 400, // LDR raw change that invalidates a before/after comparison
    epsilonMa: 0.05, // baselines below this are treated as zero for percentage maths
  },
});

export function makeConfig(overrides = {}) {
  const merge = (base, over) => {
    const out = {};
    for (const key of Object.keys(base)) {
      const b = base[key];
      const o = over?.[key];
      out[key] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, o) : o !== undefined ? o : b;
    }
    return out;
  };
  return deepFreeze(merge(DEFAULT_CONFIG, overrides));
}
