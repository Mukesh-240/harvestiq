// Standard internal telemetry model shared by LIVE and DEMO sources.

export const Status = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  ERROR: 'ERROR',
});

export const Cleaner = Object.freeze({
  IDLE: 'IDLE',
  CHECKING: 'CHECKING',
  CLEANING: 'CLEANING',
  COOLDOWN: 'COOLDOWN',
  UNKNOWN: 'UNKNOWN',
});

export const Severity = Object.freeze({
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
});

/** Per-channel sensor health. Never HEALTHY merely because the ESP32 stream is alive. */
export const Health = Object.freeze({
  HEALTHY: 'HEALTHY',
  WARNING: 'WARNING',
  STALE: 'STALE',
  DISCONNECTED: 'DISCONNECTED',
  SUSPECTED: 'SUSPECTED FAILURE',
  NOT_CONFIGURED: 'NOT CONFIGURED',
  UNKNOWN: 'UNKNOWN',
});

/** How sure we are. Software cannot confirm most physical faults from ADC values alone. */
export const Confidence = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  SUSPECTED: 'SUSPECTED',
  UNDETERMINED: 'UNDETERMINED',
});

export const Link = Object.freeze({
  NO_CONNECTION: 'NO_CONNECTION',
  CONNECTING: 'CONNECTING',
  AWAITING_DATA: 'AWAITING_DATA',
  RECEIVING: 'RECEIVING',
  STALE: 'STALE',
});

/** kind: 'missing' | 'not-detected' | 'implausible-low' | 'disabled-firmware' | 'disabled-setting' */
export const unavailable = (reason, kind = 'missing') => ({ status: Status.UNAVAILABLE, reason, kind });
export const errored = (reason) => ({ status: Status.ERROR, reason });
export const isAvailable = (sensor) => sensor?.status === Status.AVAILABLE;

export const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

export const mean = (values) => {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
