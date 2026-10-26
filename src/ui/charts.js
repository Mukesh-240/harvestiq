// Small dependency-free SVG time-series charts. Lines are broken at gaps and unavailable
// values (never interpolated across missing data); cleaning states are shaded; each chart
// has a hover read-out. Colours come from CSS custom properties so the theme stays in CSS.

import { clock } from '../export.js';

const M = { l: 46, r: 12, t: 12, b: 22 };
const NS = 'http://www.w3.org/2000/svg';

function niceStep(span, ticks) {
  const raw = span / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
}

/** Break samples into continuous segments of {t, v}; null values and long gaps end a segment. */
export function segments(samples, get, gapMs) {
  const out = [];
  let cur = [];
  let prevT = null;
  for (const s of samples) {
    const v = get(s);
    const broken = v === null || v === undefined || !Number.isFinite(v) || (prevT !== null && s.t - prevT > gapMs);
    if (broken && cur.length) {
      out.push(cur);
      cur = [];
    }
    if (v !== null && v !== undefined && Number.isFinite(v)) cur.push({ t: s.t, v });
    prevT = s.t;
  }
  if (cur.length) out.push(cur);
  return out;
}

const pathOf = (seg, x, y) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');

/** Tiny inline trend line for the source cards. Returns SVG markup. */
export function sparkline(samples, get, { now, windowMs, gapMs, width = 160, height = 34, color }) {
  const view = samples.filter((s) => s.t >= now - windowMs);
  const segs = segments(view, get, gapMs);
  const all = segs.flat().map((p) => p.v);
  if (all.length < 2) return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><line class="spark-empty" x1="0" x2="${width}" y1="${height - 2}" y2="${height - 2}"/></svg>`;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = hi - lo < 1e-9 ? Math.max(Math.abs(hi) * 0.1, 0.5) : (hi - lo) * 0.15;
  const x = (t) => ((t - (now - windowMs)) / windowMs) * width;
  const y = (v) => height - 3 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (height - 6);
  const paths = segs.map((seg) => (seg.length > 1 ? `<path d="${pathOf(seg, x, y)}" style="stroke:${color}"/>` : `<circle cx="${x(seg[0].t).toFixed(1)}" cy="${y(seg[0].v).toFixed(1)}" r="1.6" style="fill:${color}"/>`)).join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${paths}</svg>`;
}

export function createChart(container, spec) {
  container.innerHTML = '<div class="chart-svg"></div><div class="chart-tip" hidden></div>';
  const host = container.querySelector('.chart-svg');
  const tip = container.querySelector('.chart-tip');
  let last = null;
  let hoverX = null;
  let W = 520;
  let H = 180;
  let lastDrawAt = -Infinity;
  let lastCount = -1;
  // Size comes from a ResizeObserver, never from clientWidth reads, so drawing cannot force a reflow.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      if (w > 0 && h > 0 && (w !== W || h !== H)) {
        W = w;
        H = h;
        draw();
      }
    }).observe(host);
  }

  const draw = () => {
    if (!last) return;
    const { samples, now, windowMs, gapMs, simulated } = last;
    const start = windowMs === Infinity ? Math.min(samples[0]?.t ?? now - 60000, now - 60000) : now - windowMs;
    const view = samples.filter((s) => s.t >= start);
    const x = (t) => M.l + ((t - start) / (now - start)) * (W - M.l - M.r);

    const seriesSegs = spec.series.map((sr) => ({ sr, segs: segments(view, sr.value, gapMs) }));
    const vals = seriesSegs.flatMap((s) => s.segs.flat().map((p) => p.v));
    const thresholds = typeof spec.thresholds === 'function' ? spec.thresholds() : spec.thresholds ?? [];
    const thresholdYs = thresholds.map((th) => th.y);
    let lo = spec.yMin ?? Math.min(0, ...vals);
    let hi = spec.yMax ?? Math.max(...vals, ...thresholdYs, spec.minSpan ?? 1);
    if (spec.yMax === undefined) hi = Math.max(hi * 1.12, lo + (spec.minSpan ?? 1));
    const step = niceStep(hi - lo, 4);
    if (spec.yMax === undefined) hi = Math.ceil(hi / step) * step;
    lo = spec.yMin ?? Math.floor(lo / step) * step;
    const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);

    let svg = `<svg xmlns="${NS}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${spec.title}">`;

    for (let v = lo; v <= hi + step / 2; v += step) {
      svg += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${M.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${+v.toFixed(2)}</text>`;
    }
    const spanS = (now - start) / 1000;
    for (let i = 0; i <= 4; i += 1) {
      const t = start + ((now - start) * i) / 4;
      const ago = (spanS * (4 - i)) / 4;
      const label = i === 4 ? 'now' : ago > 300 ? `-${Math.round(ago / 60)} min` : `-${Math.round(ago)} s`;
      svg += `<text class="axis" x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${label}</text>`;
    }

    if (spec.bands) {
      let i = 0;
      while (i < view.length) {
        const st = view[i].cleaner.state;
        if (st !== 'CLEANING' && st !== 'COOLDOWN') { i += 1; continue; }
        let j = i;
        while (j + 1 < view.length && view[j + 1].cleaner.state === st && view[j + 1].t - view[j].t <= gapMs) j += 1;
        const endT = j + 1 < view.length && view[j + 1].t - view[j].t <= gapMs ? view[j + 1].t : view[j].t + 1000;
        const x0 = Math.max(M.l, x(view[i].t));
        const x1 = Math.min(W - M.r, x(endT));
        svg += `<rect class="band ${st.toLowerCase()}" x="${x0.toFixed(1)}" y="${M.t}" width="${Math.max(1.5, x1 - x0).toFixed(1)}" height="${H - M.t - M.b}"/>`;
        if (st === 'CLEANING' && x1 - x0 > 28) svg += `<text class="band-label" x="${(x0 + 4).toFixed(1)}" y="${M.t + 10}">CLEANING</text>`;
        i = j + 1;
      }
    }

    for (const th of thresholds) {
      if (th.y < lo || th.y > hi) continue;
      svg += `<line class="threshold" x1="${M.l}" x2="${W - M.r}" y1="${y(th.y).toFixed(1)}" y2="${y(th.y).toFixed(1)}"/><text class="threshold-label" x="${M.l + 6}" y="${(y(th.y) - 4).toFixed(1)}">${th.label}</text>`;
    }

    seriesSegs.forEach(({ sr, segs }, idx) => {
      segs.forEach((seg) => {
        if (seg.length > 1) {
          if (spec.area && idx === 0) svg += `<path class="area" style="fill:${sr.color}" d="${pathOf(seg, x, y)}L${x(seg.at(-1).t).toFixed(1)} ${y(lo).toFixed(1)}L${x(seg[0].t).toFixed(1)} ${y(lo).toFixed(1)}Z"/>`;
          svg += `<path class="line${simulated ? ' sim' : ''}" style="stroke:${sr.color}" d="${pathOf(seg, x, y)}"/>`;
        } else {
          svg += `<circle cx="${x(seg[0].t).toFixed(1)}" cy="${y(seg[0].v).toFixed(1)}" r="2" style="fill:${sr.color}"/>`;
        }
      });
    });

    if (vals.length === 0) svg += `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${spec.emptyText ?? 'No valid data in this window'}</text>`;

    if (hoverX !== null) {
      svg += `<line class="cross" x1="${hoverX}" x2="${hoverX}" y1="${M.t}" y2="${H - M.b}"/>`;
    }
    host.innerHTML = `${svg}</svg>`;
    host.__geom = { x, start, now, W, H, view };
  };

  host.addEventListener('mousemove', (ev) => {
    const g = host.__geom;
    if (!g || g.view.length === 0) return;
    const rect = host.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = g.start + ((px - M.l) / (g.W - M.l - M.r)) * (g.now - g.start);
    let best = g.view[0];
    for (const s of g.view) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    hoverX = g.x(best.t);
    const rows = spec.series.map((sr) => {
      const v = sr.value(best);
      return `<div><i style="background:${sr.color}"></i>${sr.label} <b>${v === null || v === undefined ? 'unavailable' : `${v.toFixed(spec.decimals ?? 1)} ${sr.unit ?? ''}`}</b></div>`;
    });
    tip.innerHTML = `<div class="tip-t">${clock(best.t)}${best.source === 'demo' ? ' - simulated' : ''}</div>${rows.join('')}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(hoverX + 10, 4), g.W - 150)}px`;
    draw();
  });
  host.addEventListener('mouseleave', () => {
    hoverX = null;
    tip.hidden = true;
    draw();
  });

  return {
    /** Redraws only when data changed or the sliding window has moved visibly (~1 s). */
    update(state) {
      last = state;
      const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (state.samples.length === lastCount && t - lastDrawAt < 1000 && !state.force) return;
      lastCount = state.samples.length;
      lastDrawAt = t;
      draw();
    },
  };
}
