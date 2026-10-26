// Before/after cleaning verification. Observes the cleaner state REPORTED by the ESP32;
// it never decides or commands anything. Pure logic, time comes from sample.t.

import { Cleaner, Severity, isAvailable, median } from './model.js';

export const Outcome = Object.freeze({
  IMPROVED: 'OUTPUT IMPROVED',
  NO_CHANGE: 'NO SIGNIFICANT CHANGE',
  DECREASED: 'OUTPUT DECREASED',
  CONDITIONS: 'INCONCLUSIVE — CONDITIONS CHANGED',
  DATA: 'INCONCLUSIVE — SENSOR DATA INVALID',
});

export const isInconclusive = (outcome) => outcome === Outcome.CONDITIONS || outcome === Outcome.DATA;

export const Quality = Object.freeze({
  GOOD: 'GOOD',
  LIMITED: 'LIMITED',
  CONFOUNDED: 'CONFOUNDED',
  INSUFFICIENT: 'INSUFFICIENT',
});

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const MAX_CLEANING_PHASE_MS = 30000; // firmware cleans for 5 s; anything longer means telemetry was lost

/** Percentage change, or null when it is not mathematically meaningful (no divide-by-zero). */
export function percentChange(before, after, epsilon = 0.05) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  if (Math.abs(before) < epsilon) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

const summarize = (points) => ({
  n: points.length,
  mA: median(points.map((p) => p.mA)),
  mW: median(points.map((p) => p.mW)),
  V: median(points.map((p) => p.V)),
  ldr: median(points.map((p) => p.ldr)),
});

function unstable(points, cfg) {
  if (points.length < 2) return false;
  const values = points.map((p) => p.mA);
  const spread = Math.max(...values) - Math.min(...values);
  const limit = Math.max(cfg.baselineMaxSpreadMa, cfg.baselineMaxSpreadRel * Math.abs(median(values)));
  return spread > limit;
}

/**
 * Compare solar measurements before and after a cleaning cycle.
 * @param {object[]} beforePoints {t,mA,mW,V,ldr}
 * @param {object[]} afterPoints
 * @param {{midCycle?:boolean,dataGap?:boolean,interrupted?:boolean,connectionLost?:boolean}} flags
 */
export function compareBeforeAfter(beforePoints, afterPoints, flags, config) {
  const cfg = config.verification;
  const before = summarize(beforePoints);
  const after = summarize(afterPoints);
  const reasons = [];
  let insufficient = false;

  if (flags.connectionLost || flags.dataGap) {
    reasons.push('Telemetry was interrupted during the verification window.');
    insufficient = true;
  }
  if (flags.midCycle) {
    reasons.push('The cleaning cycle was already running when telemetry started, so no baseline exists.');
    insufficient = true;
  } else if (before.n < cfg.minBaselineSamples) {
    reasons.push('No valid baseline measurements were available before the cycle.');
    insufficient = true;
  }
  if (flags.interrupted && after.n < cfg.minPostSamples) {
    reasons.push('A new cleaning cycle began before enough post-cleaning data was collected.');
    insufficient = true;
  }
  if (after.n < cfg.minPostSamples) {
    if (!flags.interrupted) reasons.push(`Only ${after.n} valid post-cleaning measurement(s) collected (need ${cfg.minPostSamples}).`);
    insufficient = true;
  }
  if (before.n >= 2 && unstable(beforePoints, cfg)) {
    reasons.push('Baseline readings were not stable, so no reliable "before" value exists.');
    insufficient = true;
  }
  if (after.n >= 2 && unstable(afterPoints, cfg)) {
    reasons.push('Post-cleaning readings were still changing, so no reliable "after" value exists.');
    insufficient = true;
  }

  const lightKnown = Number.isFinite(before.ldr) && Number.isFinite(after.ldr);
  const lightDeltaRaw = lightKnown ? after.ldr - before.ldr : null;
  const lightChanged = lightKnown && Math.abs(lightDeltaRaw) > cfg.lightChangeRaw;
  if (lightChanged) {
    reasons.push(
      `Light changed by ${fmt(lightDeltaRaw, 0)} LDR counts between the two windows (limit ${cfg.lightChangeRaw}); output differences may reflect illumination, not cleaning.`,
    );
  }

  const haveBoth = before.n > 0 && after.n > 0;
  const deltaMa = haveBoth ? after.mA - before.mA : null;
  const deltaMw = haveBoth ? after.mW - before.mW : null;
  const pctMa = haveBoth ? percentChange(before.mA, after.mA, cfg.epsilonMa) : null;

  let outcome;
  if (insufficient) {
    outcome = Outcome.DATA;
  } else if (lightChanged) {
    outcome = Outcome.CONDITIONS;
  } else if (deltaMa >= cfg.significantAbsMa && (pctMa === null || pctMa >= cfg.significantRelPct)) {
    outcome = Outcome.IMPROVED;
  } else if (deltaMa <= -cfg.significantAbsMa && (pctMa === null || pctMa <= -cfg.significantRelPct)) {
    outcome = Outcome.DECREASED;
  } else {
    outcome = Outcome.NO_CHANGE;
  }

  let quality;
  if (insufficient) quality = Quality.INSUFFICIENT;
  else if (lightChanged) quality = Quality.CONFOUNDED;
  else if (before.n < 3 || after.n < 3 || !lightKnown) quality = Quality.LIMITED;
  else quality = Quality.GOOD;

  if (!insufficient && !lightKnown) reasons.push('Light data unavailable, so an illumination change cannot be ruled out.');
  if (!insufficient && !lightChanged && (before.n < 3 || after.n < 3)) {
    reasons.push(`Based on ${before.n} baseline and ${after.n} post-cleaning sample(s) - a small sample.`);
  }

  return {
    outcome,
    quality,
    reasons,
    before,
    after,
    deltaMa,
    deltaMw,
    pctMa,
    lightDeltaRaw,
    lightChanged,
    explanation: explain(outcome, { before, after, deltaMa, pctMa, lightDeltaRaw, reasons }),
  };
}

function explain(outcome, r) {
  const caveat = 'This shows an association in time, not proof that cleaning caused the change.';
  const move = `Median solar current ${fmt(r.before.mA)} mA before, ${fmt(r.after.mA)} mA after (${r.deltaMa >= 0 ? '+' : ''}${fmt(r.deltaMa)} mA${r.pctMa === null ? ', percentage not defined for a near-zero baseline' : `, ${r.pctMa >= 0 ? '+' : ''}${fmt(r.pctMa, 0)}%`}).`;
  switch (outcome) {
    case Outcome.IMPROVED:
      return `${move} Light readings were broadly unchanged. ${caveat}`;
    case Outcome.DECREASED:
      return `${move} Output fell after the cycle; check for shading, connections or changing light. ${caveat}`;
    case Outcome.NO_CHANGE:
      return `${move} The change is below the significance threshold, so this cycle did not measurably change output. ${caveat}`;
    default:
      return `No conclusion can be drawn, and none is claimed. ${r.reasons[0] ?? 'Insufficient valid data.'}`;
  }
}

function triggerText(baseline, midCycle, config) {
  if (midCycle) return 'The cycle was already running when telemetry started, so the trigger is unknown.';
  const last = baseline.at(-1);
  if (!last) return 'No valid readings before the cycle, so the trigger cannot be explained from data.';
  const fw = config.firmware;
  const bits = [`solar current ${fmt(last.mA)} mA (firmware low-output limit ${fmt(fw.dirtyMa)} mA)`];
  if (Number.isFinite(last.ldr)) bits.push(`light LDR raw ${last.ldr}${last.ldr < fw.ldrBright ? ' (BRIGHT)' : ''}`);
  return `The ESP32 started this cycle after ${bits.join(' in ')} stayed low for about ${fmt(fw.dirtyConfirmMs / 1000, 0)} s. Low output alone does not prove the panel is dirty.`;
}

const toPoint = (s) =>
  isAvailable(s.solar)
    ? {
        t: s.t,
        mA: s.solar.currentmA,
        mW: s.solar.powermW,
        V: s.solar.voltageV,
        ldr: isAvailable(s.light) ? s.light.raw : null,
        state: s.cleaner.state,
      }
    : null;

export class VerificationTracker {
  #recent = [];
  #active = null;
  #results = [];
  #prev = null;
  #seq = 0;

  get active() {
    return this.#active;
  }

  get results() {
    return [...this.#results];
  }

  /** Feed every accepted sample. @returns timeline events. */
  onSample(sample, config) {
    const cfg = config.verification;
    const events = [];
    const prev = this.#prev;
    this.#prev = sample;
    if (sample.cleaner.status !== 'AVAILABLE') return events;

    const gap = prev !== null && sample.t - prev.t > config.link.staleAfterMs;
    if (gap) {
      this.#recent = [];
      if (this.#active) events.push(...this.#finalize(sample.t, config, { dataGap: true }));
    }
    const state = sample.cleaner.state;
    const prevState = prev && !gap ? prev.cleaner.state : null;
    const point = toPoint(sample);

    if (this.#active?.phase === 'post' && state === Cleaner.CLEANING) {
      events.push(...this.#finalize(sample.t, config, { interrupted: true }));
    }

    if (this.#active?.phase === 'cleaning' && state !== Cleaner.CLEANING) {
      this.#active = { ...this.#active, phase: 'post', endT: sample.t };
    }

    if (state === Cleaner.CLEANING && prevState !== Cleaner.CLEANING && !this.#active) {
      const midCycle = prev === null || gap;
      const baseline = midCycle ? [] : this.#computeBaseline(sample.t, cfg);
      this.#active = {
        id: ++this.#seq,
        cycle: sample.cleaner.cycles,
        startT: sample.t,
        endT: null,
        phase: 'cleaning',
        baseline,
        post: [],
        midCycle,
        trigger: triggerText(baseline, midCycle, config),
      };
      const b = summarize(baseline);
      events.push({
        severity: Severity.INFO,
        type: 'verification-start',
        title: 'Verification baseline captured',
        detail: midCycle
          ? 'Cycle already running at connect - no baseline available.'
          : `${b.n} valid sample(s), median ${fmt(b.mA)} mA before cleaning.`,
      });
    }

    const a = this.#active;
    if (a?.phase === 'post') {
      if (point && sample.t - a.endT >= cfg.settleMs && a.post.length < cfg.postSamples) {
        this.#active = { ...a, post: [...a.post, point] };
      }
      const cur = this.#active;
      if (cur.post.length >= cfg.postSamples || sample.t - cur.endT > cfg.postWindowMs) {
        events.push(...this.#finalize(sample.t, config, {}));
      }
    }

    if (point && state !== Cleaner.CLEANING) {
      this.#recent = [...this.#recent, point].slice(-12);
    }
    return events;
  }

  /** Time-driven finalisation when samples stop arriving. */
  tick(t, config) {
    const a = this.#active;
    if (!a) return [];
    if (a.phase === 'post' && t - a.endT > config.verification.postWindowMs) {
      return this.#finalize(t, config, {});
    }
    if (a.phase === 'cleaning' && t - a.startT > MAX_CLEANING_PHASE_MS) {
      return this.#finalize(t, config, { dataGap: true });
    }
    return [];
  }

  onConnectionLost(t, config) {
    this.#recent = [];
    return this.#active ? this.#finalize(t, config, { connectionLost: true }) : [];
  }

  #computeBaseline(startT, cfg) {
    const window = this.#recent.filter((p) => startT - p.t <= cfg.baselineWindowMs).slice(-cfg.baselineMaxSamples);
    // Samples the firmware itself flagged CHECKING are the confirmed low-output regime.
    const checking = window.filter((p) => p.state === Cleaner.CHECKING);
    return checking.length > 0 ? checking : window;
  }

  #finalize(t, config, flags) {
    const a = this.#active;
    if (!a) return [];
    const result = compareBeforeAfter(a.baseline, a.post, { midCycle: a.midCycle, ...flags }, config);
    const record = Object.freeze({ id: a.id, cycle: a.cycle, startT: a.startT, endT: a.endT, finalizedAt: t, trigger: a.trigger, ...result });
    this.#results.push(record);
    this.#active = null;
    const severity =
      result.outcome === Outcome.IMPROVED ? Severity.SUCCESS : result.outcome === Outcome.DECREASED ? Severity.WARNING : Severity.INFO;
    return [
      {
        severity,
        type: 'verification-result',
        title: result.outcome === Outcome.CONDITIONS ? 'Verification inconclusive: conditions changed' : result.outcome === Outcome.DATA ? 'Verification inconclusive: insufficient or invalid sensor data' : `Verification: ${result.outcome}`,
        detail: isInconclusive(result.outcome) ? result.reasons[0] ?? 'Insufficient valid data.' : result.explanation,
        resultId: record.id,
      },
    ];
  }
}
