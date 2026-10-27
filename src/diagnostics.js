// Deterministic diagnostic engine. Pure logic: no DOM, no clock (time comes from ctx.t).
//
// ctx = { t, sample|null (fresh sample only), link, lastTelemetryAt, sinceConnectedMs, counters,
//         health: SensorHealthMonitor channel list }
// Each rule returns null (cannot evaluate: hold state) or { on, detail() }.
// The engine adds persistence (raiseAfterMs), hysteresis windows (clearAfterMs) and
// duplicate suppression: a persistent condition raises ONE diagnostic until it recovers.
// A diagnostic is never deleted: when it clears it becomes status RECOVERED and stays in history.
//
// Lifecycle fields on every diagnostic: id, ruleId, severity (info|warning|error|critical),
// subsystem, title, explanation, evidence[], action, confidence, recovery (the condition that
// clears it), firstDetectedAt, lastUpdatedAt, resolvedAt, status (ACTIVE | RECOVERED).

import { Severity, Link, Health, Confidence, isAvailable } from './model.js';

const fmt = (x, digits = 1) => (Number.isFinite(x) ? x.toFixed(digits) : '-');
const SEVERITY_RANK = { [Severity.CRITICAL]: 0, [Severity.ERROR]: 1, [Severity.WARNING]: 2, [Severity.INFO]: 3, [Severity.SUCCESS]: 4 };

function sensorUnavailableRule({ id, key, label, subsystem, severity, title, action, explanation, match, confidence }) {
  return {
    id,
    cfgKey: 'sensorUnavailable',
    subsystem,
    recovery: 'Clears 2 s after the sensor reports valid data again.',
    check(ctx) {
      const sensor = ctx.sample?.[key];
      if (!sensor) return null;
      return {
        on: match(sensor),
        detail: () => ({
          severity,
          title,
          explanation,
          evidence: [sensor.reason ?? 'No reason reported'],
          action,
          confidence: confidence?.(sensor) ?? `CONFIRMED - reported by the firmware, not inferred (${label})`,
        }),
      };
    },
  };
}

/** One rule per hardware channel, driven by SensorHealthMonitor. Recovery needs N consecutive valid readings. */
function healthRule(channelId, subsystem) {
  return {
    id: `health-${channelId}`,
    cfgKey: 'sensorUnavailable',
    subsystem,
    recovery: 'Counts as RECOVERED after the configured number of consecutive valid readings.',
    check(ctx, cfg, wasActive) {
      const ch = ctx.health?.find((c) => c.id === channelId);
      if (!ch || ctx.link !== Link.RECEIVING) return null;
      const recovering = ch.status === Health.WARNING && ch.error?.startsWith('Recovering');
      // UNDETERMINED findings (e.g. constant light, pinned bright reading) stay on the health tile but never raise an alert.
      const bad =
        ch.status === Health.STALE ||
        ch.status === Health.SUSPECTED ||
        (ch.status === Health.WARNING && !recovering && ch.confidence === Confidence.CONFIRMED);
      // Hold the incident open only while the channel is actually recovering; a channel that became NOT CONFIGURED
      // or DISCONNECTED must not keep a stale incident alive forever.
      const holding = wasActive && (recovering || ch.status === Health.HEALTHY) && ch.validStreak < cfg.health.recoverAfterValid;
      const on = bad || holding;
      return {
        on,
        detail: () => {
          const age = ch.ageMs === null ? 'never' : `${fmt(ch.ageMs / 1000, 0)} s ago`;
          const severity = ch.status === Health.STALE ? Severity.ERROR : ch.status === Health.SUSPECTED ? Severity.WARNING : Severity.INFO;
          return {
            severity,
            title: `${ch.name}: ${recovering ? 'recovering' : ch.status.toLowerCase()}`,
            explanation:
              ch.status === Health.SUSPECTED
                ? 'The evidence points to a problem with this channel but cannot prove a hardware failure. The browser only sees values, not wiring.'
                : ch.status === Health.STALE
                  ? 'This channel has stopped producing valid readings while the controller stream continues. Its last valid value is kept as history, not shown as current.'
                  : 'This channel needs attention but the evidence is not conclusive.',
            evidence: [ch.error ?? 'No detail', `Last valid reading ${age}`, `Confidence: ${ch.confidence}`, ...(ch.reading ? [`Last value: ${ch.reading}`] : [])],
            action: ch.action ?? 'Check wiring for this channel.',
            confidence: `${ch.confidence} - ${ch.confidence === 'CONFIRMED' ? 'based on missing or invalid data, not on a hardware test' : 'a software inference, not a hardware test'}`,
          };
        },
      };
    },
  };
}

export const RULES = [
  {
    id: 'solar-underperformance',
    cfgKey: 'solarUnderperformance',
    subsystem: 'Solar',
    recovery: 'Clears when solar current stays above the low-output limit (+hysteresis) or the light is no longer BRIGHT for 3 s.',
    check(ctx, cfg, wasActive) {
      const s = ctx.sample;
      if (!s || !isAvailable(s.solar) || !isAvailable(s.light)) return null;
      const threshold = cfg.firmware.dirtyMa + (wasActive ? cfg.diagnostics.solarUnderperformance.hysteresisMa : 0);
      const on = s.light.bright && s.solar.currentmA < threshold;
      return {
        on,
        detail: () => ({
          severity: Severity.WARNING,
          title: 'Possible solar underperformance',
          explanation:
            'Solar current is lower than expected for the current light level. Possible causes: surface contamination, partial shading, a loose or high-resistance connection, or an electrical load/charge-state effect. This check cannot tell which.',
          evidence: [
            `Light ${s.light.label} (LDR raw ${s.light.raw})`,
            `Solar current ${fmt(s.solar.currentmA)} mA vs ${fmt(cfg.firmware.dirtyMa)} mA threshold`,
            `Solar voltage ${fmt(s.solar.voltageV, 2)} V`,
            `Cleaner reports ${s.cleaner.state}`,
          ],
          action:
            'Check the panel for shading or debris and inspect the INA219/panel wiring. If a cleaning cycle ran, see Cleaning verification below.',
          confidence: 'Possible - a single LDR and INA219 reading; not a confirmed fault',
        }),
      };
    },
  },
  {
    id: 'low-light',
    cfgKey: 'lowLight',
    subsystem: 'Solar',
    recovery: 'Clears when light returns to BRIGHT or solar current rises above the limit.',
    check(ctx, cfg) {
      const s = ctx.sample;
      if (!s || !isAvailable(s.solar) || !isAvailable(s.light)) return null;
      return {
        on: !s.light.bright && s.solar.currentmA < cfg.firmware.dirtyMa,
        detail: () => ({
          severity: Severity.INFO,
          title: 'Low solar output is consistent with low available light',
          explanation:
            'Ambient light is not bright and solar current is low, which is the normal behaviour for a solar panel. Low output alone does not indicate dirt.',
          evidence: [
            `Light ${s.light.label}${s.cleaner.night ? ' (night)' : ''} (LDR raw ${s.light.raw})`,
            `Solar current ${fmt(s.solar.currentmA)} mA`,
          ],
          action: 'No action needed. Cleaning is not indicated by low output in low light.',
          confidence: 'Expected behaviour',
        }),
      };
    },
  },
  sensorUnavailableRule({
    id: 'solar-unavailable',
    key: 'solar',
    label: 'INA219',
    subsystem: 'Solar',
    severity: Severity.ERROR,
    match: (sensor) => sensor.kind === 'not-detected',
    title: 'INA219 solar sensor not detected',
    explanation: 'The firmware reports it cannot find the INA219 (v3.2 re-checks every 0.5 s; v3.1 only at boot). Solar output cannot be measured, and it is NOT treated as zero output.',
    action: 'Check INA219 VCC, GND, SDA->D21, SCL->D22 (not the screw terminals), then reset the ESP32.',
  }),
  sensorUnavailableRule({
    id: 'piezo-unavailable',
    key: 'piezo',
    label: 'piezo',
    subsystem: 'Piezo',
    severity: Severity.INFO,
    match: (sensor) => String(sensor.kind).startsWith('disabled'),
    confidence: (sensor) => (sensor.kind === 'disabled-firmware' ? 'CONFIRMED - the firmware reports pz=0' : 'UNDETERMINED - based on the "Piezo attached" setting; this firmware sent no pz flag (v3.1)'),
    title: 'Piezo not configured',
    explanation: 'The piezo channel is treated as disabled, so it is shown as NOT CONFIGURED rather than as zero production.',
    action: 'Set PIEZO_CONNECTED true in the sketch and re-upload. Firmware v3.2 reports this itself; with v3.1 also tick "Piezo attached" in Settings.',
  }),
  healthRule('solar', 'Solar'),
  healthRule('light', 'Light'),
  healthRule('wind', 'Wind'),
  healthRule('battery', 'Battery'),
  healthRule('piezo', 'Piezo'),
  {
    id: 'invalid-data',
    cfgKey: 'invalidData',
    subsystem: 'Telemetry',
    recovery: 'Clears 5 s after the last invalid or out-of-range value.',
    check(ctx) {
      const s = ctx.sample;
      if (!s) return null;
      const bad = s.issues.filter((i) => i.problem !== 'missing');
      return {
        on: bad.length > 0,
        detail: () => ({
          severity: Severity.WARNING,
          title: 'Invalid or implausible telemetry',
          explanation:
            'One or more fields are non-numeric or outside the range the documented circuit can produce. Those readings are rejected (the last valid value is kept) rather than shown as zero.',
          evidence: bad.slice(0, 5).map((i) => `${i.field}: ${i.detail}`),
          action: 'Check wiring and divider values for the listed channels; confirm the firmware version matches v3.1.',
          confidence: 'CONFIRMED - failed validation. Ranges are assumptions from the circuit design',
        }),
      };
    },
  },
  {
    id: 'parser-errors',
    cfgKey: 'invalidData',
    subsystem: 'Telemetry',
    recovery: 'Clears 5 s after the share of bad lines falls below the warning level.',
    check(ctx) {
      const ch = ctx.health?.find((c) => c.id === 'parser');
      if (!ch) return null;
      return {
        on: ch.status === Health.WARNING,
        detail: () => ({
          severity: Severity.WARNING,
          title: 'Telemetry parser is rejecting lines',
          explanation: 'Many recent data lines were malformed or rejected. This is a communication or format problem, tracked separately from sensor faults; valid lines are still used.',
          evidence: [ch.error, ch.reading ?? ''],
          action: ch.action,
          confidence: 'CONFIRMED - counted from received lines',
        }),
      };
    },
  },
  {
    id: 'telemetry-stale',
    cfgKey: 'staleTelemetry',
    subsystem: 'ESP32 link',
    recovery: 'Clears 1 s after a valid telemetry line arrives.',
    check(ctx, cfg) {
      return {
        on: ctx.link === Link.STALE,
        detail: () => ({
          severity: Severity.CRITICAL,
          title: 'Controller telemetry timeout',
          explanation:
            'The serial port is still open but no valid telemetry line has arrived recently. Live animations are stopped and every value shown is the last known reading, not a current one.',
          evidence: [
            `Last valid telemetry ${fmt((ctx.t - ctx.lastTelemetryAt) / 1000)} s ago (limit ${fmt(cfg.link.staleAfterMs / 1000)} s)`,
          ],
          action: 'Check the USB cable and that the ESP32 has not reset. Press EN on the board; reconnect if needed.',
          confidence: 'CONFIRMED - based on message timing',
        }),
      };
    },
  },
  {
    id: 'no-data',
    cfgKey: 'noData',
    subsystem: 'ESP32 link',
    recovery: 'Clears 1 s after the first valid telemetry line.',
    check(ctx, cfg) {
      return {
        on: ctx.link === Link.AWAITING_DATA && ctx.sinceConnectedMs > cfg.link.noDataAfterMs,
        detail: () => ({
          severity: Severity.ERROR,
          title: 'Connected but no valid telemetry',
          explanation:
            'The serial port opened but no valid telemetry line has been received. The firmware may not be running, may use a different baud rate, or may be sending malformed lines.',
          evidence: [
            `${fmt(ctx.sinceConnectedMs / 1000, 0)} s since connect`,
            `${ctx.counters.text} text lines, ${ctx.counters.malformed} malformed JSON lines`,
          ],
          action: 'Confirm the sketch is uploaded, baud is 115200, and no other program (Arduino Serial Monitor) holds the port.',
          confidence: 'CONFIRMED - nothing parseable has arrived',
        }),
      };
    },
  },
];

export class DiagnosticsEngine {
  #pending = new Map();
  #active = new Map();
  #resolved = [];
  #seq = 0;

  #make(ruleId, rule, detail, t) {
    return {
      id: `${ruleId}#${++this.#seq}`,
      ruleId,
      subsystem: rule.subsystem,
      recovery: rule.recovery,
      ...detail,
      firstDetectedAt: t,
      raisedAt: t,
      lastUpdatedAt: t,
      resolvedAt: null,
      status: 'ACTIVE',
      active: true,
    };
  }

  /** @returns {{type:'raised'|'resolved', diag:object}[]} state changes only. */
  evaluate(ctx, cfg) {
    const events = [];
    for (const rule of RULES) {
      const timing = cfg.diagnostics[rule.cfgKey];
      const current = this.#active.get(rule.id);
      if (current?.external) continue;
      const result = rule.check(ctx, cfg, current !== undefined);
      const pend = this.#pending.get(rule.id) ?? { onSince: null, offSince: null };

      if (result === null) {
        if (!current) this.#pending.set(rule.id, { onSince: null, offSince: null });
        continue;
      }

      if (result.on) {
        const onSince = pend.onSince ?? ctx.t;
        this.#pending.set(rule.id, { onSince, offSince: null });
        if (current) {
          this.#active.set(rule.id, { ...current, ...result.detail(), lastUpdatedAt: ctx.t });
        } else if (ctx.t - onSince >= timing.raiseAfterMs) {
          const diag = this.#make(rule.id, rule, result.detail(), ctx.t);
          this.#active.set(rule.id, diag);
          events.push({ type: 'raised', diag });
        }
      } else if (current) {
        const offSince = pend.offSince ?? ctx.t;
        if (ctx.t - offSince >= timing.clearAfterMs) {
          events.push(this.#recover(rule.id, ctx.t));
        } else {
          this.#pending.set(rule.id, { onSince: null, offSince });
        }
      } else {
        this.#pending.set(rule.id, { onSince: null, offSince: null });
      }
    }
    return events;
  }

  #recover(ruleId, t) {
    const current = this.#active.get(ruleId);
    const diag = { ...current, active: false, status: 'RECOVERED', resolvedAt: t, lastUpdatedAt: t };
    this.#active.delete(ruleId);
    this.#resolved.push(diag);
    if (this.#resolved.length > 100) this.#resolved.shift();
    this.#pending.set(ruleId, { onSince: null, offSince: null });
    return { type: 'resolved', diag };
  }

  /** Raise a diagnostic decided outside the per-sample rules (e.g. a finished cleaning verification). */
  raiseExternal(ruleId, def, t) {
    const current = this.#active.get(ruleId);
    if (current) {
      this.#active.set(ruleId, { ...current, ...def, lastUpdatedAt: t });
      return [];
    }
    const diag = { ...this.#make(ruleId, { subsystem: def.subsystem, recovery: def.recovery }, def, t), external: true };
    this.#active.set(ruleId, diag);
    return [{ type: 'raised', diag }];
  }

  resolveExternal(ruleId, t) {
    return this.#active.get(ruleId)?.external ? [this.#recover(ruleId, t)] : [];
  }

  isActive(ruleId) {
    return this.#active.has(ruleId);
  }

  /** Most severe first, then oldest first. */
  getActive() {
    return [...this.#active.values()].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.raisedAt - b.raisedAt,
    );
  }

  /** Recovered incidents, newest first. They are history, never deleted on recovery. */
  getResolved() {
    return [...this.#resolved].reverse();
  }
}
