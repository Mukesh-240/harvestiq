// Application bootstrap: owns the LIVE and DEMO sessions, wires controls, runs the render loop.
// Live and demo are separate Session objects; switching modes only changes which one is shown.
// The demo is driven by ONE DemoSource at a time (its own single timer + virtual clock), is
// paused the moment you leave DEMO mode, and never writes into the live session.

import { DEFAULT_CONFIG, makeConfig } from '../config.js';
import { Session } from '../session.js';
import { DemoSource, SCENARIOS } from '../demo.js';
import { WebSerialSource } from '../serial.js';
import { buildCsv, buildReportHtml, esc } from '../export.js';
import { isAvailable, Severity } from '../model.js';
import { createChart } from './charts.js';
import { createHero } from './hero.js';
import * as view from './render.js';
import { renderSummary, renderHealthCenter, renderSerialPanel } from './panels.js';

const STORE_KEY = 'harvestiq.settings.v1';
const $ = (sel) => document.querySelector(sel);

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveOverrides(overrides) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  } catch {
    // storage unavailable (private window): settings last for this page load only
  }
}

const app = {
  overrides: loadOverrides(),
  config: DEFAULT_CONFIG,
  mode: 'live',
  sessions: { live: null, demo: null },
  demoSource: null,
  demoSpeed: 1,
  serial: null,
  notice: null,
  ui: { sparkWindowMs: 120000, rangeMs: 120000, seenEvents: new Map(), verifyIndex: null, lastStepAt: -Infinity, lastSteps: null },
};
try {
  app.config = makeConfig(app.overrides);
} catch {
  app.overrides = {};
}

let hero;
let charts;
let scheduled = false;
const schedule = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
};

const current = () => app.sessions[app.mode] ?? app.sessions.live;

/** Demo time is virtual (pausable, speed-scaled); live time is the wall clock. */
const clockFor = (session) => (session.mode === 'demo' && app.demoSource && app.sessions.demo === session ? app.demoSource.clock() : Date.now());

function newSession(mode, label = '') {
  const session = new Session({ mode, config: app.config, label });
  session.subscribe(schedule);
  return session;
}

// ---------- charts ----------

function buildCharts() {
  const cfg = () => app.config;
  const mk = (id, spec) => createChart($(id), spec);
  return {
    power: mk('#chartPower', {
      title: 'Power output',
      area: true,
      decimals: 1,
      minSpan: 10,
      series: [
        { key: 'solar', label: 'Solar', unit: 'mW', color: 'var(--solar)', value: (s) => (isAvailable(s.solar) ? s.solar.powermW : null) },
        { key: 'wind', label: 'Wind (est.)', unit: 'mW', color: 'var(--wind)', value: (s) => (isAvailable(s.wind) ? s.wind.powermW : null) },
      ],
      emptyText: 'No valid power readings yet',
    }),
    current: mk('#chartCurrent', {
      title: 'Solar current and cleaning events',
      bands: true,
      decimals: 1,
      minSpan: 5,
      thresholds: () => [{ y: cfg().firmware.dirtyMa, label: `firmware low-output limit ${cfg().firmware.dirtyMa} mA` }],
      series: [{ key: 'mA', label: 'Solar current', unit: 'mA', color: 'var(--solar)', value: (s) => (isAvailable(s.solar) ? s.solar.currentmA : null) }],
      emptyText: 'Solar current unavailable',
    }),
    light: mk('#chartLight', {
      title: 'Ambient light',
      bands: true,
      yMin: 0,
      yMax: 4095,
      decimals: 0,
      minSpan: 4095,
      thresholds: () => [{ y: cfg().firmware.ldrBright, label: 'bright below this' }],
      series: [{ key: 'ldr', label: 'LDR raw (lower = brighter)', unit: '', color: 'var(--light)', value: (s) => (isAvailable(s.light) ? s.light.raw : null) }],
      emptyText: 'Light sensor unavailable',
    }),
    battery: mk('#chartBattery', {
      title: 'Battery voltage',
      yMin: 2.5,
      yMax: 4.4,
      decimals: 2,
      minSpan: 1.6,
      series: [{ key: 'bV', label: 'Battery', unit: 'V', color: 'var(--battery)', value: (s) => (isAvailable(s.battery) ? s.battery.voltageV : null) }],
      emptyText: 'Battery voltage unavailable',
    }),
  };
}

// ---------- render ----------

function demoInfo() {
  const src = app.demoSource;
  return src ? { state: src.state, speed: src.speed, scenarioId: src.scenarioId, finished: src.finished, tick: src.tick, length: src.length } : null;
}

function render() {
  const session = current();
  const now = clockFor(session);
  const demo = demoInfo();
  const s = session.latest;
  const steps = isAvailable(s?.piezo) ? s.piezo.steps : null;
  // A step only counts as an event if it arrives on a current link, never when a hidden tab catches up.
  if (steps !== null && app.ui.lastSteps !== null && steps > app.ui.lastSteps && session.linkState(now) === 'RECEIVING') app.ui.lastStepAt = now;
  app.ui.lastSteps = steps;

  view.renderHeader(session, now, { serialSupported: WebSerialSource.supported, mode: app.mode, demo, demoSpeed: app.demoSpeed });
  const health = session.healthSnapshot(now);
  view.renderPipeline(session, now);
  renderSummary(session, now, health);
  view.renderCards(session, now, app.ui);
  hero.update(view.heroView(session, now, app.ui, health));
  renderHealthCenter(session, now, health);
  view.renderDiagnostics(session, now);
  renderSerialPanel(session, now, demo);
  view.renderVerify(session, now, app.ui);
  view.renderTimeline(session, app.ui, now);
  if ($('#console').open) view.renderConsole(session);

  const chartState = { samples: session.history, now, windowMs: app.ui.rangeMs, gapMs: app.config.link.staleAfterMs, simulated: session.mode === 'demo', force: app.ui.forceCharts };
  app.ui.forceCharts = false;
  Object.values(charts).forEach((c) => c.update(chartState));

  const notice = $('#notice');
  notice.hidden = !app.notice;
  if (app.notice) {
    notice.className = `notice ${app.notice.level}`;
    $('#noticeText').textContent = app.notice.text;
  }
  if (demo && app.mode === 'demo') {
    $('#demoProgress i').style.transform = `scaleX(${Math.min(1, demo.tick / demo.length)})`;
    const secs = Math.min(demo.tick, demo.length);
    $('#demoStatus').textContent = demo.finished ? 'Scenario complete - holding steady state' : `${demo.state === 'paused' ? 'Paused at ' : ''}${secs} s of ${demo.length} s`;
    $('#demoBlurb').textContent = SCENARIOS.find((x) => x.id === demo.scenarioId)?.blurb ?? '';
  } else if (app.mode === 'demo') {
    $('#demoStatus').textContent = 'No scenario running';
    const picked = SCENARIOS.find((x) => x.id === $('#scenarioSelect').value);
    $('#demoBlurb').textContent = `${picked ? `${picked.blurb} ` : ''}Press Start to run it. Nothing is simulated until you do.`;
  }
}

// ---------- controls ----------

async function connectSerial() {
  const session = app.sessions.live;
  if (!app.serial) {
    app.serial = new WebSerialSource({
      baudRate: app.config.serial.baudRate,
      maxLineLength: app.config.serial.maxLineLength,
      onLine: (line, t) => session.ingestLine(line, t),
      onState: (state, detail = {}) => {
        app.notice =
          state === 'error'
            ? { level: 'crit', text: detail.message ?? 'Serial error' }
            : state === 'disconnected' && !detail.user
              ? { level: 'warn', text: `Serial link lost${detail.reason ? `: ${detail.reason}` : ''}. Historical data is kept; press Reconnect after checking the cable.` }
              : null;
        session.setConnection(state, Date.now(), detail);
      },
      onNote: (text) => session.events.add({ t: Date.now(), type: 'malformed', severity: Severity.INFO, title: 'Serial note', detail: text, key: 'serial-note', dedupeMs: 30000 }),
    });
  }
  await app.serial.connect();
}

function resetUiForSession() {
  app.ui.forceCharts = true;
  app.ui.seenEvents = new Map();
  app.ui.verifyIndex = null;
  app.ui.lastSteps = null;
  app.ui.lastStepAt = -Infinity;
}

/** Start (or restart) a scenario. Any previous DemoSource is stopped first, so there is never more than one timer. */
function startDemo(id) {
  app.demoSource?.stop();
  const def = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
  const session = newSession('demo', `Scenario ${def.id} - ${def.name}`);
  session.scenarioId = def.id;
  app.sessions.demo = session;
  app.demoSource = new DemoSource({ session, scenarioId: def.id, speed: app.demoSpeed });
  resetUiForSession();
  app.demoSource.start();
  schedule();
}

function toggleDemo() {
  const src = app.demoSource;
  if (!src) return startDemo($('#scenarioSelect').value);
  if (src.finished) return startDemo(src.scenarioId);
  if (src.state === 'running') src.pause();
  else src.resume();
  schedule();
  return undefined;
}

function setMode(mode) {
  if (mode === app.mode) return;
  app.mode = mode;
  if (mode === 'live') app.demoSource?.pause(); // simulation stops completely when leaving DEMO
  // Entering DEMO shows an empty, clearly labelled session; nothing runs until the user presses Start.
  if (mode === 'demo' && !app.sessions.demo) app.sessions.demo = newSession('demo', 'No scenario started');
  resetUiForSession();
  schedule();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openSettings() {
  const f = $('#settingsForm');
  const c = app.config;
  f.piezo.checked = c.piezo.enabled;
  f.dirtyMa.value = c.firmware.dirtyMa;
  f.staleSec.value = c.link.staleAfterMs / 1000;
  f.absMa.value = c.verification.significantAbsMa;
  f.relPct.value = c.verification.significantRelPct;
  f.lightRaw.value = c.verification.lightChangeRaw;
  f.settleSec.value = c.verification.settleMs / 1000;
  f.recoverN.value = c.health.recoverAfterValid;
  $('#settingsDialog').showModal();
}

function applySettings(ev) {
  const f = $('#settingsForm');
  const n = (el, min) => (Number.isFinite(el.valueAsNumber) && el.valueAsNumber >= min ? el.valueAsNumber : null);
  const values = { dirty: n(f.dirtyMa, 0.1), stale: n(f.staleSec, 2), abs: n(f.absMa, 0.1), rel: n(f.relPct, 1), light: n(f.lightRaw, 50), settle: n(f.settleSec, 0), recover: n(f.recoverN, 1) };
  if (Object.values(values).some((v) => v === null)) {
    ev.preventDefault();
    $('#settingsError').textContent = 'Every value must be a valid number above its minimum.';
    return;
  }
  app.overrides = {
    piezo: { enabled: f.piezo.checked },
    firmware: { dirtyMa: values.dirty },
    link: { staleAfterMs: values.stale * 1000 },
    verification: { significantAbsMa: values.abs, significantRelPct: values.rel, lightChangeRaw: values.light, settleMs: values.settle * 1000 },
    health: { recoverAfterValid: Math.round(values.recover) },
  };
  app.config = makeConfig(app.overrides);
  Object.values(app.sessions).forEach((s) => s?.setConfig(app.config));
  saveOverrides(app.overrides);
  $('#settingsError').textContent = '';
  schedule();
}

function openReport() {
  $('#reportBody').innerHTML = buildReportHtml(current(), clockFor(current()));
  $('#reportView').hidden = false;
  document.body.dataset.report = '1';
}

function bind() {
  document.querySelectorAll('[data-mode-btn]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.modeBtn)));
  document.querySelectorAll('[data-action="connect"]').forEach((b) => b.addEventListener('click', () => connectSerial()));
  document.querySelectorAll('[data-action="disconnect"]').forEach((b) => b.addEventListener('click', () => app.serial?.disconnect()));
  $('#btnSettings').addEventListener('click', openSettings);
  $('#settingsForm').addEventListener('submit', applySettings);
  $('#settingsCancel').addEventListener('click', () => $('#settingsDialog').close());
  $('#btnCsv').addEventListener('click', () => {
    const session = current();
    if (session.history.length === 0) {
      app.notice = { level: 'warn', text: 'Nothing to export yet - no valid samples in this session.' };
      schedule();
      return;
    }
    download(`harvestiq-${session.mode}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, buildCsv(session.history), 'text/csv');
  });
  $('#btnReport').addEventListener('click', openReport);
  $('#reportClose').addEventListener('click', () => {
    $('#reportView').hidden = true;
    delete document.body.dataset.report;
  });
  $('#reportPrint').addEventListener('click', () => window.print());
  $('#noticeClose').addEventListener('click', () => {
    app.notice = null;
    schedule();
  });
  $('#demoToggle').addEventListener('click', toggleDemo);
  $('#demoReset').addEventListener('click', () => app.demoSource && startDemo(app.demoSource.scenarioId));
  $('#speedButtons').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-speed]');
    if (!b) return;
    app.demoSpeed = Number(b.dataset.speed);
    app.demoSource?.setSpeed(app.demoSpeed);
    schedule();
  });
  $('#scenarioSelect').addEventListener('change', (ev) => {
    // Choosing a different scenario while one is loaded restarts cleanly; with none loaded it only selects.
    if (app.demoSource) startDemo(ev.target.value);
    else schedule();
  });
  $('#rangeButtons').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-range]');
    if (!b) return;
    app.ui.rangeMs = b.dataset.range === 'all' ? Infinity : Number(b.dataset.range);
    app.ui.forceCharts = true;
    document.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    schedule();
  });
  $('#verifyBody').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-verify-idx]');
    if (b) {
      app.ui.verifyIndex = Number(b.dataset.verifyIdx);
      schedule();
    }
  });
  $('#console').addEventListener('toggle', schedule);
  window.addEventListener('error', (ev) => {
    app.notice = { level: 'crit', text: `Unexpected error: ${ev.message}` };
    schedule();
  });
}

/** Highlight the nav link for the section in view. One observer, no per-frame work. */
function watchSections() {
  const links = new Map([...document.querySelectorAll('[data-nav]')].map((a) => [a.dataset.nav, a]));
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) links.forEach((a, id) => a.toggleAttribute('aria-current', id === e.target.id));
      });
    },
    { rootMargin: '-35% 0px -55% 0px' },
  );
  links.forEach((_, id) => {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  });
}

function init() {
  $('#scenarioSelect').innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${s.id}. ${esc(s.name)}</option>`).join('');
  view.mountCards($('#cards'));
  hero = createHero($('#heroScene'));
  charts = buildCharts();
  app.sessions.live = newSession('live');
  bind();
  watchSections();

  const params = new URLSearchParams(location.search);
  if (params.has('demo') || params.get('mode') === 'demo') {
    app.mode = 'demo';
    const wanted = params.get('demo');
    startDemo(SCENARIOS.some((x) => x.id === wanted) ? wanted : '1');
  }

  setInterval(() => Object.values(app.sessions).forEach((s) => s?.tick(clockFor(s))), 500);
  window.addEventListener('resize', schedule);
  window.__harvestiq = app;
  render();
}

init();
