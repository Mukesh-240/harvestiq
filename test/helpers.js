import { Session } from '../src/session.js';
import { DEFAULT_CONFIG } from '../src/config.js';

export const T0 = 1_700_000_000_000;

/** A healthy firmware telemetry object with optional overrides. */
export const fw = (over = {}) => ({
  ldr: 900, light: 'BRIGHT', ina: 1, sV: 5.35, smA: 18.0, smW: 96.3, wV: 0.02, wmW: 0,
  cV: 0, steps: 0, puJ: 0, bV: 3.9, bPct: 75, panel: 'CLEAN', cycles: 0, smWh: 0.1, wmWh: 0,
  ...over,
});

export const line = (over) => JSON.stringify(fw(over));

export function liveSession(config = DEFAULT_CONFIG, mode = 'live') {
  const session = new Session({ mode, config, now: T0 });
  session.setConnection('connected', T0);
  return session;
}

/** Feed `count` 1 Hz samples starting at second `startSec`. `over` may be an object or (i)=>object. Returns next second. */
export function feed(session, startSec, count, over = {}) {
  for (let i = 0; i < count; i += 1) {
    const overrides = typeof over === 'function' ? over(i) : over;
    session.ingestLine(line(overrides), T0 + (startSec + i) * 1000);
  }
  return startSec + count;
}
