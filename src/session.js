// One Session = one data source (LIVE or DEMO) with its own history, events, diagnostics and
// verification. Live and demo sessions never share state, so simulated data cannot leak into
// hardware data. All time comes from the `t` arguments, which keeps the logic testable.

import { DEFAULT_CONFIG } from './config.js';
import { parseLine, normalizeTelemetry } from './adapter.js';
import { DiagnosticsEngine } from './diagnostics.js';
import { VerificationTracker, Outcome } from './verification.js';
import { SensorHealthMonitor } from './health.js';
import { EventLog } from './events.js';
import { Link, Severity, Cleaner, isAvailable } from './model.js';

const CONSOLE_MAX = 200;

export class Session {
  mode;
  config;
  startedAt;
  history = [];
  latest = null;
  lastTelemetryAt = null;
  cleaningCycles = 0;
  label = '';
  scenarioId = null;
  cleanerSince = null;
  counters = { lines: 0, telemetry: 0, text: 0, malformed: 0, rejected: 0, outOfOrder: 0 };
  consoleLines = [];
  connection = { state: 'idle', since: null, connectedAt: null, everConnected: false, failures: 0, detail: null };
  events = new EventLog();
  diagnostics = new DiagnosticsEngine();
  verifier = new VerificationTracker();
  sensorHealth = new SensorHealthMonitor();
  #goodSinceCleaning = 0;
  #listeners = new Set();
  #diagEvents = 0;

  constructor({ mode, config = DEFAULT_CONFIG, now = Date.now(), label = '' }) {
    this.mode = mode;
    this.config = config;
    this.startedAt = now;
    this.label = label;
    this.events.add({
      t: now,
      type: 'app-start',
      severity: Severity.INFO,
      title: mode === 'demo' ? 'Demo session started' : 'Application started',
      detail: mode === 'demo' ? 'Simulated data - not from hardware.' : 'Waiting for ESP32 connection.',
    });
  }

  setConfig(config) {
    this.config = config;
  }

  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    this.#listeners.forEach((fn) => fn(this));
  }

  /** Feed one raw serial line. Safe for any input. */
  ingestLine(rawLine, t) {
    const parsed = parseLine(rawLine);
    if (parsed.kind === 'empty') return;
    this.counters.lines += 1;
    const note = (kind, text) => {
      this.consoleLines.push({ t, kind, text });
      if (this.consoleLines.length > CONSOLE_MAX) this.consoleLines.shift();
    };

    if (parsed.kind === 'text') {
      this.counters.text += 1;
      note('text', parsed.text);
      this.#emit();
      return;
    }
    if (parsed.kind === 'malformed') {
      this.counters.malformed += 1;
      this.sensorHealth.onParser('malformed', this.config);
      note('malformed', parsed.text);
      this.events.add({
        t, type: 'malformed', severity: Severity.INFO, title: 'Malformed telemetry line ignored',
        detail: parsed.error, key: 'malformed', dedupeMs: 30000,
      });
      this.#emit();
      return;
    }
    const result = normalizeTelemetry(parsed.data, { t, source: this.mode, config: this.config });
    if (!result.ok) {
      this.counters.rejected += 1;
      this.sensorHealth.onParser('rejected', this.config);
      note('rejected', `${result.reason}: ${JSON.stringify(parsed.data).slice(0, 120)}`);
      this.#emit();
      return;
    }
    note('json', JSON.stringify(parsed.data));
    this.sensorHealth.onParser('ok', this.config);
    this.ingestSample(result.sample);
  }

  ingestSample(sample) {
    if (this.latest && sample.t < this.latest.t) {
      this.counters.outOfOrder += 1;
      return;
    }
    const t = sample.t;
    const prev = this.latest;
    this.history.push(sample);
    if (this.history.length > this.config.history.maxSamples) this.history.shift();
    this.latest = sample;
    this.lastTelemetryAt = t;
    this.counters.telemetry += 1;

    if (prev === null) {
      this.events.add({
        t, type: 'telemetry', severity: Severity.SUCCESS, title: 'Valid telemetry received',
        detail: this.mode === 'demo' ? 'First simulated sample.' : 'First valid JSON line from the ESP32.',
      });
    }
    this.sensorHealth.onSample(sample, this.config);
    this.#trackCleaner(prev, sample);
    this.#logAll(t, this.verifier.onSample(sample, this.config));
    this.#watchCleaningRecovery(sample);
    this.#runDiagnostics(t);
    this.#emit();
  }

  #logAll(t, events) {
    events.forEach((e) => {
      this.events.add({ t, ...e });
      if (e.type === 'verification-result') this.#onVerificationResult(t, this.verifier.results.at(-1));
    });
  }

  #logDiagEvents(t, diagEvents) {
    for (const { type, diag } of diagEvents) {
      this.#diagEvents += 1;
      if (type === 'raised') {
        this.events.add({
          t, type: 'diag-raised', severity: diag.severity, title: diag.title,
          detail: diag.evidence[0] ?? diag.explanation, diagId: diag.id,
        });
      } else {
        this.events.add({
          t, type: 'diag-resolved', severity: Severity.SUCCESS, title: `Recovered: ${diag.title}`,
          detail: `Active for ${((diag.resolvedAt - diag.raisedAt) / 1000).toFixed(0)} s.`, diagId: diag.id,
        });
      }
    }
  }

  /** A completed cycle that did not measurably help raises a (non-accusatory) diagnostic; an improvement recovers it. */
  #onVerificationResult(t, rec) {
    if (!rec) return;
    if (rec.outcome === Outcome.IMPROVED) {
      this.#logDiagEvents(t, this.diagnostics.resolveExternal('cleaning-no-improvement', t));
      return;
    }
    if (rec.outcome !== Outcome.NO_CHANGE && rec.outcome !== Outcome.DECREASED) return;
    const pct = rec.pctMa === null ? 'n/a' : `${rec.pctMa >= 0 ? '+' : ''}${rec.pctMa.toFixed(0)}%`;
    this.#goodSinceCleaning = 0;
    this.#logDiagEvents(t, this.diagnostics.raiseExternal('cleaning-no-improvement', {
      severity: Severity.WARNING,
      subsystem: 'Cleaning',
      title: rec.outcome === Outcome.DECREASED ? 'Solar output decreased after cleaning' : 'No measurable improvement detected after cleaning',
      explanation: 'A cleaning cycle completed but solar output did not measurably improve. Changing light, sensor uncertainty, shading, wiring, or a cause other than surface dirt can all explain this; the comparison cannot say which.',
      evidence: [`Median current ${rec.before.mA?.toFixed(1)} mA before, ${rec.after.mA?.toFixed(1)} mA after (${pct})`, `Light change ${rec.lightDeltaRaw === null ? 'unknown' : `${rec.lightDeltaRaw >= 0 ? '+' : ''}${rec.lightDeltaRaw.toFixed(0)} LDR counts`}`, `Data quality ${rec.quality}`],
      action: 'Inspect the panel surface, shading and cabling, then try another cycle in steady light.',
      confidence: 'Measured comparison; the cause is UNDETERMINED',
      recovery: 'Recovers when a later verification shows OUTPUT IMPROVED, or solar current stays above the low-output limit for 10 consecutive valid readings.',
    }, t));
  }

  #watchCleaningRecovery(sample) {
    if (!this.diagnostics.isActive('cleaning-no-improvement')) return;
    const ok = isAvailable(sample.solar) && sample.solar.currentmA > this.config.firmware.dirtyMa + this.config.diagnostics.solarUnderperformance.hysteresisMa;
    this.#goodSinceCleaning = ok ? this.#goodSinceCleaning + 1 : 0;
    if (this.#goodSinceCleaning >= 10) this.#logDiagEvents(sample.t, this.diagnostics.resolveExternal('cleaning-no-improvement', sample.t));
  }

  #trackCleaner(prev, sample) {
    const c = sample.cleaner;
    if (c.status !== 'AVAILABLE') return;
    const before = prev?.cleaner?.status === 'AVAILABLE' ? prev.cleaner : null;
    const t = sample.t;
    if (!before || before.state !== c.state) this.cleanerSince = t;
    if (!before) {
      if (c.state === Cleaner.CLEANING) {
        this.events.add({ t, type: 'cleaning', severity: Severity.INFO, title: 'Cleaning cycle in progress at connect', detail: 'No baseline can be captured for this cycle.' });
      }
      return;
    }
    if (c.state === Cleaner.CLEANING && before.state !== Cleaner.CLEANING) {
      this.cleaningCycles += 1;
      this.events.add({
        t, type: 'cleaning', severity: Severity.INFO, title: 'Cleaning cycle started',
        detail: `ESP32 reported CLEANING (cycle #${c.cycles ?? '?'}) after bright light with low solar current.`,
      });
    } else if (before.state === Cleaner.CLEANING && c.state !== Cleaner.CLEANING) {
      this.events.add({
        t, type: 'cleaning', severity: Severity.INFO, title: 'Cleaning cycle completed',
        detail: `ESP32 reported ${c.state}. This is the firmware's report; motor operation is not independently measured.`,
      });
    }
    if (before.cycles != null && c.cycles != null && c.cycles < before.cycles) {
      this.events.add({ t, type: 'device', severity: Severity.INFO, title: 'ESP32 counters reset', detail: 'The cycle counter went backwards, which usually means the board restarted.' });
    }
  }

  #context(t) {
    const link = this.linkState(t);
    return {
      t,
      link,
      sample: link === Link.RECEIVING ? this.latest : null,
      lastTelemetryAt: this.lastTelemetryAt,
      sinceConnectedMs: this.connection.connectedAt === null ? 0 : t - this.connection.connectedAt,
      counters: this.counters,
    };
  }

  /** Per-channel sensor health at time t (never cached: freshness depends on t). */
  healthSnapshot(t) {
    const base = this.#context(t);
    return this.sensorHealth.evaluate({ ...base, sample: this.latest }, this.config);
  }

  batteryState(t) {
    return this.sensorHealth.batteryState(this.latest, t, this.config);
  }

  #runDiagnostics(t) {
    const ctx = { ...this.#context(t), health: this.healthSnapshot(t) };
    this.#logDiagEvents(t, this.diagnostics.evaluate(ctx, this.config));
  }

  /** Time-driven checks (stale telemetry, verification timeouts). Call ~2x per second. */
  tick(t) {
    this.#runDiagnostics(t);
    this.#logAll(t, this.verifier.tick(t, this.config));
    this.#emit();
  }

  setConnection(state, t, detail = {}) {
    const prev = this.connection;
    if (prev.state === state) return;
    const next = { ...prev, state, since: t, detail };
    const demo = this.mode === 'demo';

    if (state === 'connected') {
      next.connectedAt = t;
      const restored = prev.everConnected && (prev.state === 'disconnected' || prev.state === 'error');
      next.everConnected = true;
      this.connection = next;
      this.events.add({
        t, type: 'connection', severity: Severity.SUCCESS,
        title: restored ? 'Connection restored' : demo ? 'Simulated source running' : 'ESP32 connected',
        detail: demo ? 'Simulated data - not from hardware.' : 'Serial port open at 115200 baud.',
      });
    } else if (state === 'disconnected' || state === 'error') {
      const wasLive = prev.state === 'connected';
      if (wasLive || state === 'error') next.failures = prev.failures + (detail.user ? 0 : 1);
      this.connection = next;
      if (wasLive || state === 'error') {
        const user = detail.user === true;
        this.events.add({
          t, type: 'connection', severity: user ? Severity.INFO : Severity.CRITICAL,
          title: user ? 'Disconnected by user' : state === 'error' ? 'Connection error' : 'Connection lost',
          detail: detail.reason ?? detail.message ?? (user ? 'Port closed.' : 'The serial link dropped; readings are now historical.'),
        });
        this.#logAll(t, this.verifier.onConnectionLost(t, this.config));
      }
    } else {
      this.connection = next;
    }
    this.#runDiagnostics(t);
    this.#emit();
  }

  linkState(t) {
    const { state, connectedAt } = this.connection;
    if (state === 'connecting') return Link.CONNECTING;
    if (state !== 'connected') return Link.NO_CONNECTION;
    if (this.lastTelemetryAt === null || this.lastTelemetryAt < connectedAt) return Link.AWAITING_DATA;
    return t - this.lastTelemetryAt > this.config.link.staleAfterMs ? Link.STALE : Link.RECEIVING;
  }

  /** Overall health for the header badge. */
  health(t) {
    const link = this.linkState(t);
    if (link === Link.NO_CONNECTION) return { level: 'offline', label: this.mode === 'demo' && !this.connection.everConnected ? 'IDLE' : 'OFFLINE' };
    if (link === Link.CONNECTING) return { level: 'offline', label: 'CONNECTING' };
    if (link === Link.AWAITING_DATA) return { level: 'warning', label: 'AWAITING DATA' };
    if (link === Link.STALE) return { level: 'warning', label: 'STALE' };
    const active = this.diagnostics.getActive();
    if (active.some((d) => d.severity === Severity.CRITICAL)) return { level: 'critical', label: 'CRITICAL' };
    if (active.some((d) => d.severity === Severity.ERROR)) return { level: 'error', label: 'ERROR' };
    if (active.some((d) => d.severity === Severity.WARNING)) return { level: 'warning', label: 'ATTENTION' };
    return { level: 'ok', label: 'NOMINAL' };
  }

  get diagnosticEventCount() {
    return this.#diagEvents;
  }
}
