// Live power summary, Sensor Health Center and serial connection panel.
// Pure presentation of session/health state: nothing here decides health or changes telemetry.

import { esc, clock } from '../export.js';
import { isAvailable, Link } from '../model.js';
import { setHtml } from './render.js';

const $ = (sel) => document.querySelector(sel);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const slug = (status) => status.toLowerCase().replace(/ /g, '-');

const STATUS_HELP = {
  HEALTHY: 'Valid, current readings and no problem detected on this channel.',
  WARNING: 'Something needs attention but the evidence is not conclusive.',
  STALE: 'This channel stopped producing valid readings; the last valid value is history, not current.',
  DISCONNECTED: 'The channel cannot be read (no link, or the firmware reports the sensor missing).',
  'SUSPECTED FAILURE': 'The evidence points to a fault but cannot prove it. Software cannot confirm hardware failure from readings alone.',
  'NOT CONFIGURED': 'Not enabled in this build. This is a configuration state, not a fault, and it is not shown as zero.',
  UNKNOWN: 'Not enough information to judge yet.',
};

const ageText = (ms) => {
  if (ms === null) return 'never';
  const s = ms / 1000;
  return s < 120 ? `${s.toFixed(s < 10 ? 1 : 0)} s ago` : `${Math.round(s / 60)} min ago`;
};

// ---------- live power summary ----------

export function renderSummary(session, now, health) {
  const s = session.latest;
  const link = session.linkState(now);
  const current = link === Link.RECEIVING;
  const ch = Object.fromEntries(health.map((c) => [c.id, c]));
  const ok = (key) => current && isAvailable(s?.[key]);
  const why = (id) => (ch[id] ? ch[id].status.toLowerCase() : 'no data');

  const solar = ok('solar') ? s.solar.powermW : null;
  const wind = ok('wind') ? s.wind.powermW : null;
  const battery = session.batteryState(now);
  const combined = solar === null ? null : solar + (wind ?? 0);

  const items = [
    { label: 'Solar power', value: solar === null ? '-' : `${fmt(solar, solar < 10 ? 1 : 0)} mW`, note: solar === null ? why('solar') : 'measured (V x I)', cls: solar === null ? 'off' : 'on' },
    { label: 'Wind power', value: wind === null ? '-' : `~${fmt(wind, 1)} mW`, note: wind === null ? why('wind') : s.wind.generating ? 'estimate (V² / 200 Ω)' : 'generator output not detected', cls: wind === null ? 'off' : 'on' },
    { label: 'Piezo', value: ok('piezo') ? `${s.piezo.steps} steps` : ch.piezo?.status === 'NOT CONFIGURED' ? 'NOT CONFIGURED' : '-', note: ok('piezo') ? 'pulses only, never continuous' : 'no zero is shown', cls: ok('piezo') ? 'on' : 'off' },
    { label: 'Combined generation', value: combined === null ? '-' : `~${fmt(combined, combined < 10 ? 1 : 0)} mW`, note: 'solar measured + wind estimate; piezo excluded', cls: combined === null ? 'off' : 'on' },
    { label: 'Battery', value: ok('battery') ? `${fmt(s.battery.voltageV, 2)} V` : '-', note: ok('battery') ? `${battery.state.toLowerCase()} - ~${s.battery.pctEstimate}% est.` : why('battery'), cls: ok('battery') ? 'on' : 'off', title: ok('battery') ? battery.why : '' },
  ];
  setHtml(
    $('#summary'),
    items.map((i) => `<div class="sum ${i.cls}" title="${esc(i.title ?? '')}"><small>${esc(i.label)}</small><b>${esc(i.value)}</b><span>${esc(i.note)}</span></div>`).join(''),
  );
}

// ---------- sensor health center ----------

export function renderHealthCenter(session, now, health) {
  const link = session.linkState(now);
  const stale = session.config.link.staleAfterMs;
  const counts = {};
  for (const c of health) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const order = ['HEALTHY', 'WARNING', 'STALE', 'SUSPECTED FAILURE', 'DISCONNECTED', 'NOT CONFIGURED', 'UNKNOWN'];
  setHtml(
    $('#healthSummary'),
    order.filter((k) => counts[k]).map((k) => `<span class="hs s-${slug(k)}">${counts[k]} ${k.toLowerCase()}</span>`).join(''),
  );

  const tiles = health.map((c) => {
    const live = link === Link.RECEIVING && c.current === true && (c.status === 'HEALTHY' || c.status === 'WARNING' || c.status === 'NOT CONFIGURED') && c.ageMs !== null && c.ageMs <= stale;
    const fresh = c.status === 'NOT CONFIGURED' ? 'not applicable' : c.ageMs === null ? 'no valid reading yet' : `${ageText(c.ageMs)} - ${c.ageMs <= stale ? 'fresh' : 'STALE'}`;
    const reading = c.reading ? `${live ? '' : '<i>last valid</i> '}${esc(c.reading)}` : '-';
    return `<article class="htile s-${slug(c.status)}" aria-label="${esc(c.name)}: ${esc(c.status)}">
      <header><h3>${esc(c.name)}</h3><span class="gpio">${esc(c.gpio)}</span></header>
      <div class="hbadges"><span class="hbadge s-${slug(c.status)}" title="${esc(STATUS_HELP[c.status])}">${esc(c.status)}</span><span class="conf conf-${c.confidence.toLowerCase()}" title="CONFIRMED = proven by firmware report or timing. SUSPECTED = software inference. UNDETERMINED = cannot tell.">${esc(c.confidence)}</span></div>
      <div class="hread${live ? '' : ' hist'}">${reading}</div>
      <div class="hmeta">Last valid update: ${esc(fresh)}</div>
      ${c.error ? `<p class="herr">${esc(c.error)}</p>` : ''}
      ${c.action && c.status !== 'HEALTHY' ? `<p class="hact"><b>Try:</b> ${esc(c.action)}</p>` : ''}
      ${c.note ? `<p class="hnote">${esc(c.note)}</p>` : ''}
    </article>`;
  });
  setHtml($('#healthGrid'), tiles.join(''));
}

// ---------- serial connection panel ----------

export function renderSerialPanel(session, now, demo) {
  const link = session.linkState(now);
  const c = session.counters;
  const isDemo = session.mode === 'demo';
  const age = session.lastTelemetryAt === null ? null : now - session.lastTelemetryAt;
  const conn = session.connection;
  const state = isDemo ? (demo?.state === 'paused' ? 'simulation paused' : demo ? 'simulated source running' : 'no scenario running') : conn.state === 'connected' ? 'port open' : conn.state;
  const banner = link === Link.RECEIVING && !(isDemo && demo?.state === 'paused')
    ? isDemo ? '<div class="sbanner sim">SIMULATED DATA - no serial connection is used in demo mode</div>' : '<div class="sbanner ok">LIVE DATA - receiving from the ESP32</div>'
    : isDemo ? '<div class="sbanner warn">SIMULATION NOT RUNNING</div>' : '<div class="sbanner warn">LIVE DATA UNAVAILABLE - values below are history, not current</div>';
  const rows = [
    ['Source', isDemo ? 'SIMULATED (software scenario)' : 'LIVE (ESP32 over USB serial)'],
    ['Connection', state],
    ['Baud rate', isDemo ? 'not applicable' : `${session.config.serial.baudRate} (8N1)`],
    ['Last valid message', age === null ? 'none yet' : `${clock(session.lastTelemetryAt)} (${ageText(age)})`],
    ['Lines received', `${c.lines} (${c.telemetry} telemetry, ${c.text} text)`],
    ['Bad lines', `${c.malformed} malformed JSON, ${c.rejected} rejected, ${c.outOfOrder} out of order`],
    ['Connection failures', String(conn.failures)],
  ];
  setHtml(
    $('#serialPanel'),
    `${banner}<dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`,
  );
}
