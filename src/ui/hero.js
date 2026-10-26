// Hero illustration: one coherent SVG scene of the real build (solar panel + cleaner, wind
// motor, piezo tile, ESP32 monitor, battery). It is built ONCE; update() only flips data-*
// attributes and a few attributes/text nodes, so there is no DOM churn. All motion is CSS/SMIL
// gated by those attributes: nothing moves unless a valid measurement says the thing is active.
//
// Honesty rules baked into the drawing: only the solar path charges the battery; wind and piezo
// are measurement-only taps into the ESP32 (dashed). Wiring is conceptual, labelled as such.

const P = { TL: [226, 186], TR: [420, 160], BR: [434, 252], BL: [238, 284] };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const at = (u, v) => lerp(lerp(P.TL, P.TR, u), lerp(P.BL, P.BR, u), v);
const pt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;

const cellLines = () => {
  const lines = [];
  for (let i = 1; i < 6; i += 1) lines.push(`<line x1="${at(i / 6, 0)[0].toFixed(1)}" y1="${at(i / 6, 0)[1].toFixed(1)}" x2="${at(i / 6, 1)[0].toFixed(1)}" y2="${at(i / 6, 1)[1].toFixed(1)}"/>`);
  for (let j = 1; j < 3; j += 1) lines.push(`<line x1="${at(0, j / 3)[0].toFixed(1)}" y1="${at(0, j / 3)[1].toFixed(1)}" x2="${at(1, j / 3)[0].toFixed(1)}" y2="${at(1, j / 3)[1].toFixed(1)}"/>`);
  return lines.join('');
};

const rays = (count, r0, r1, r2) =>
  Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    const r = i % 2 ? r1 : r2;
    return `<line x1="${(Math.cos(a) * r0).toFixed(1)}" y1="${(Math.sin(a) * r0).toFixed(1)}" x2="${(Math.cos(a) * r).toFixed(1)}" y2="${(Math.sin(a) * r).toFixed(1)}"/>`;
  }).join('');

const particles = (cls, pathId, count, dur) =>
  Array.from({ length: count }, (_, i) =>
    `<circle class="particle ${cls}" r="3.4"><animateMotion dur="${dur}s" begin="${(-(dur * i) / count).toFixed(2)}s" repeatCount="indefinite"><mpath href="#${pathId}"/></animateMotion></circle>`,
  ).join('');

const pill = (role, cx, cy, w) =>
  `<g class="pill p-${role.split('-')[0]}"><rect x="${cx - w / 2}" y="${cy - 12}" width="${w}" height="24" rx="12"/><text data-role="${role}" x="${cx}" y="${cy + 4.2}" text-anchor="middle">-</text></g>`;

const blade = (deg) =>
  `<path class="blade" transform="rotate(${deg} 832 178)" d="M832 178 C 825 150, 827 112, 832 74 C 838 112, 839 150, 832 178 Z"/>`;

const RING_LEN = 2 * Math.PI * 17;

const SVG = `
<svg class="hero-svg" viewBox="0 0 960 470" role="img" aria-label="Illustration of the harvester: solar panel with vibration cleaner, wind turbine, piezo tile, ESP32 monitor and battery">
  <defs>
    <linearGradient id="gSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#DCECF5"/><stop offset="1" stop-color="#F6F8F2"/></linearGradient>
    <radialGradient id="gSun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#F6D27A" stop-opacity="0.75"/><stop offset="1" stop-color="#F6D27A" stop-opacity="0"/></radialGradient>
    <linearGradient id="gCell" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3F6B85"/><stop offset="1" stop-color="#27495E"/></linearGradient>
    <linearGradient id="gSheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="gHill1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#DCE9D8"/><stop offset="1" stop-color="#E8F0E6"/></linearGradient>
    <linearGradient id="gCharge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#78A878"/><stop offset="1" stop-color="#9CC89C"/></linearGradient>
    <clipPath id="clipPanel"><polygon points="${pt(P.TL)} ${pt(P.TR)} ${pt(P.BR)} ${pt(P.BL)}"/></clipPath>
    <clipPath id="clipBatt"><rect x="658" y="353" width="104" height="46" rx="5"/></clipPath>
    <pattern id="hatchLight" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="#D5DDD3" stroke-width="2.2"/></pattern>
  </defs>

  <g class="cloud c1"><ellipse cx="470" cy="70" rx="46" ry="13"/><ellipse cx="500" cy="60" rx="30" ry="14"/><ellipse cx="445" cy="62" rx="26" ry="11"/></g>
  <g class="cloud c2"><ellipse cx="660" cy="112" rx="38" ry="11"/><ellipse cx="684" cy="104" rx="24" ry="12"/></g>

  <path d="M0 360 C 120 322, 220 332, 330 352 C 450 372, 560 328, 700 340 C 800 348, 880 322, 960 336 L960 470 L0 470 Z" fill="#E1EBDD"/>
  <path d="M0 405 C 160 385, 300 408, 470 398 C 640 388, 800 410, 960 392 L960 470 L0 470 Z" fill="url(#gHill1)"/>
  <rect y="410" width="960" height="60" fill="#E8F0E6"/>
  <line x1="0" y1="410" x2="960" y2="410" class="ground-line"/>

  <!-- SUN -->
  <g class="sun" transform="translate(140 104)">
    <circle class="sun-glow" r="104" fill="url(#gSun)"/>
    <g class="sun-rays slow">${rays(16, 54, 72, 90)}</g>
    <g class="sun-rays rev">${rays(12, 48, 58, 58)}</g>
    <circle class="sun-core" r="38"/>
    <circle class="sun-shine" cx="-12" cy="-13" r="10"/>
  </g>

  <!-- sunlight travelling toward the panel; only while the LDR reports light -->
  <g class="streaks">
    <line x1="208" y1="120" x2="278" y2="182"/><line x1="224" y1="100" x2="318" y2="164"/>
    <line x1="200" y1="146" x2="256" y2="214"/><line x1="236" y1="84" x2="360" y2="150"/>
  </g>

  <!-- ENERGY / SENSING PATHS -->
  <g class="flow" data-flow="solar"><path id="pSolar" class="path energy" d="M398 252 C 430 292, 468 300, 520 318"/>${particles('p-solar', 'pSolar', 3, 2.2)}</g>
  <g class="flow" data-flow="charge"><path id="pCharge" class="path energy" d="M600 364 H650"/>${particles('p-charge', 'pCharge', 2, 1.1)}</g>
  <g class="flow" data-flow="wind"><path id="pWind" class="path sense" d="M826 404 C 770 444, 650 446, 586 410"/>${particles('p-wind', 'pWind', 2, 3)}</g>
  <g class="flow" data-flow="piezo"><path id="pPiezo" class="path sense" d="M236 412 C 330 446, 430 446, 492 410"/>${particles('p-piezo', 'pPiezo', 1, 1.6)}</g>
  <g class="flow" data-flow="control"><path id="pControl" class="path control" d="M480 326 C 400 344, 300 334, 258 300"/>${particles('p-control', 'pControl', 2, 1.2)}</g>

  <!-- SOLAR PANEL + CLEANER -->
  <g class="panel-rig">
    <rect class="pole" x="324" y="262" width="11" height="150" rx="3"/>
    <rect class="foot" x="304" y="402" width="52" height="10" rx="4"/>
    <g class="panel-body">
      <polygon class="panel-frame" points="${pt(P.TL)} ${pt(P.TR)} ${pt(P.BR)} ${pt(P.BL)}"/>
      <polygon class="panel-cells" points="${pt(P.TL)} ${pt(P.TR)} ${pt(P.BR)} ${pt(P.BL)}"/>
      <g class="cell-lines">${cellLines()}</g>
      <g clip-path="url(#clipPanel)"><rect class="sheen" x="150" y="130" width="90" height="190" transform="skewX(-14)" fill="url(#gSheen)"/></g>
      <g class="motor" transform="translate(246 296)">
        <circle class="ring-bg" r="17"/>
        <circle class="ring" r="17" stroke-dasharray="${RING_LEN.toFixed(1)}" stroke-dashoffset="${RING_LEN.toFixed(1)}" transform="rotate(-90)" data-role="ring"/>
        <circle class="motor-core" r="9"/>
        <path class="ripple r1" d="M-23 -9 a 25 25 0 0 0 0 18"/><path class="ripple r2" d="M23 -9 a 25 25 0 0 1 0 18"/>
      </g>
    </g>
  </g>
  ${pill('solar-label', 330, 138, 168)}
  ${pill('clean-label', 196, 338, 164)}

  <!-- ESP32 MONITOR -->
  <g class="esp" id="espNode">
    <rect class="esp-box" x="470" y="318" width="130" height="92" rx="12"/>
    <text class="esp-title" x="485" y="338">ESP32 MONITOR</text>
    <circle class="esp-led" cx="582" cy="333" r="5"/>
    <rect class="esp-screen" x="485" y="347" width="100" height="40" rx="6"/>
    <text class="esp-text" data-role="esp-text" x="535" y="371" text-anchor="middle">-</text>
    <g class="esp-pins"><line x1="494" y1="398" x2="494" y2="410"/><line x1="508" y1="398" x2="508" y2="410"/><line x1="522" y1="398" x2="522" y2="410"/></g>
  </g>

  <!-- BATTERY -->
  <g class="battery" id="battNode">
    <rect class="batt-body" x="650" y="345" width="118" height="64" rx="10"/>
    <rect class="batt-cap" x="768" y="364" width="10" height="26" rx="3"/>
    <g clip-path="url(#clipBatt)">
      <rect class="batt-fill" data-role="batt-fill" x="658" y="353" width="104" height="46"/>
      <rect class="batt-shine" x="640" y="353" width="40" height="46" fill="url(#gSheen)"/>
    </g>
    <g class="batt-ticks"><line x1="684" y1="353" x2="684" y2="399"/><line x1="710" y1="353" x2="710" y2="399"/><line x1="736" y1="353" x2="736" y2="399"/></g>
    <path class="bolt" transform="translate(-34 0)" d="M713 356 L700 380 H710 L706 400 L722 374 H712 Z"/>
    <text class="batt-pct" data-role="batt-pct" x="728" y="380" text-anchor="middle"></text>
    <text class="batt-est" data-role="batt-est" x="728" y="396" text-anchor="middle"></text>
  </g>
  ${pill('batt-label', 709, 322, 190)}

  <!-- WIND TURBINE -->
  <g class="turbine">
    <polygon class="tower" points="826,412 838,412 835,186 829,186"/>
    <rect class="nacelle" x="820" y="170" width="30" height="17" rx="7"/>
    <g class="blades">${blade(0)}${blade(120)}${blade(240)}</g>
    <circle class="hub" cx="832" cy="178" r="8"/>
  </g>
  <g class="windlines">
    <path d="M610 120 C 660 106, 700 134, 760 120"/><path d="M590 160 C 650 144, 700 176, 770 158"/>
    <path d="M620 200 C 670 188, 710 214, 764 200"/><path d="M640 240 C 690 230, 720 250, 770 240"/>
  </g>
  ${pill('wind-label', 806, 34, 250)}

  <!-- PIEZO TILE -->
  <g class="tile" id="tileNode">
    <rect class="tile-base" x="56" y="410" width="190" height="14" rx="4"/>
    <ellipse class="tile-pulse" cx="151" cy="410" rx="46" ry="9"/>
    <g class="tile-plate"><rect x="66" y="394" width="170" height="18" rx="5"/><ellipse class="foot-a" cx="128" cy="403" rx="9" ry="4.5"/><ellipse class="foot-b" cx="172" cy="403" rx="9" ry="4.5"/></g>
    <path class="tile-bolt" d="M151 372 l-7 12 h6 l-3 10 l11 -15 h-7 z"/>
  </g>
  ${pill('piezo-label', 151, 366, 168)}

  <g class="fault" data-fault="solar" transform="translate(442 152)"><circle r="12"/><text y="4.6" text-anchor="middle">!</text></g>
  <g class="fault" data-fault="wind" transform="translate(900 178)"><circle r="12"/><text y="4.6" text-anchor="middle">!</text></g>
  <g class="fault" data-fault="battery" transform="translate(784 346)"><circle r="12"/><text y="4.6" text-anchor="middle">!</text></g>
  <g class="fault" data-fault="light" transform="translate(212 54)"><circle r="12"/><text y="4.6" text-anchor="middle">!</text></g>

  <text class="scene-note" x="480" y="458" text-anchor="middle">Conceptual wiring - solid green = charging path, dashed = measured only (wind and piezo do not charge the battery)</text>
</svg>`;

const SPIN_SECONDS = [0, 5.2, 3.2, 2.0, 1.3];

export function createHero(root) {
  root.innerHTML = SVG;
  const svg = root.querySelector('svg');
  const roles = new Map([...root.querySelectorAll('[data-role]')].map((el) => [el.dataset.role, el]));
  const plate = root.querySelector('.tile');
  let lastSpinLevel = -1;
  let lastHit = null;
  let liveTimer = null;
  let lastRay = -1;

  const text = (role, value) => {
    const el = roles.get(role);
    if (el && el.textContent !== value) el.textContent = value;
  };

  return {
    /** v is the hero view-model built in render.js. Idempotent and cheap. */
    update(v) {
      const set = svg.dataset;
      set.sim = v.simulated ? '1' : '0';
      set.link = v.link;
      set.light = v.light;
      set.solar = v.solar.on ? 'on' : 'off';
      set.solarLevel = String(v.solar.level);
      set.wind = v.wind.on ? 'on' : 'off';
      set.charging = v.battery.charging ? 'on' : 'off';
      set.clean = v.cleaner.on ? 'on' : 'off';
      set.cleaner = v.cleaner.state;
      set.piezo = v.piezo.state;
      set.battery = v.battery.state;
      set.windState = v.wind.state;
      set.solarState = v.solar.state;
      set.esp = v.esp.state;
      set.faultSolar = v.faults.solar ? 'on' : 'off';
      set.faultWind = v.faults.wind ? 'on' : 'off';
      set.faultBattery = v.faults.battery ? 'on' : 'off';
      set.faultLight = v.faults.light ? 'on' : 'off';
      const ray = Math.round(v.rays * 20) / 20;
      if (ray !== lastRay) {
        lastRay = ray;
        svg.style.setProperty('--ray', String(ray));
      }

      text('solar-label', v.solar.label);
      text('wind-label', v.wind.label);
      text('piezo-label', v.piezo.label);
      text('batt-label', v.battery.label);
      text('clean-label', v.cleaner.label);
      text('esp-text', v.esp.label);
      text('batt-pct', v.battery.pctText);
      text('batt-est', v.battery.estText);

      if (v.wind.spinLevel !== lastSpinLevel) {
        lastSpinLevel = v.wind.spinLevel;
        svg.style.setProperty('--spin', `${SPIN_SECONDS[v.wind.spinLevel] || 5}s`);
      }
      roles.get('batt-fill').style.transform = `scaleX(${Math.max(0, Math.min(100, v.battery.pct ?? 0)) / 100})`;
      const progress = Number.isFinite(v.cleaner.progress) ? v.cleaner.progress : 0;
      roles.get('ring').setAttribute('stroke-dashoffset', (RING_LEN * (1 - progress)).toFixed(1));

      if (v.piezo.hitAt !== lastHit) {
        const first = lastHit === null;
        lastHit = v.piezo.hitAt;
        if (!first && Number.isFinite(v.piezo.hitAt)) {
          plate.classList.remove('hit');
          void plate.getBoundingClientRect(); // restart the one-shot animation
          plate.classList.add('hit');
          svg.classList.add('piezo-live');
          clearTimeout(liveTimer);
          liveTimer = setTimeout(() => svg.classList.remove('piezo-live'), 1600);
        }
      }
    },
  };
}
