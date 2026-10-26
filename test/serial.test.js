import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSerialSource } from '../src/serial.js';

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function makePort() {
  const enc = new TextEncoder();
  let ctrl;
  let dead = false;
  const stream = new ReadableStream({ start: (c) => { ctrl = c; } });
  const port = {
    opened: [],
    closeCalls: 0,
    get readable() { return dead ? null : stream; },
    async open(options) { port.opened.push(options); },
    async close() { port.closeCalls += 1; dead = true; },
    push: (text) => ctrl.enqueue(enc.encode(text)),
    end: () => ctrl.close(),
    fail: (error) => { dead = true; ctrl.error(error); },
  };
  return port;
}

function install({ port, requestError } = {}) {
  const listeners = [];
  const serial = {
    requestCalls: 0,
    async requestPort() {
      serial.requestCalls += 1;
      if (requestError) throw requestError;
      return port;
    },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    listeners,
  };
  Object.defineProperty(globalThis, 'navigator', { value: { serial }, configurable: true, writable: true });
  return serial;
}

function makeSource(extra = {}) {
  const log = { lines: [], states: [], notes: [] };
  const source = new WebSerialSource({
    baudRate: 115200,
    maxLineLength: 64,
    onLine: (line) => log.lines.push(line),
    onState: (state, detail) => log.states.push({ state, ...detail }),
    onNote: (note) => log.notes.push(note),
    ...extra,
  });
  return { source, log };
}

test('a cancelled port chooser returns to idle without error', async () => {
  install({ requestError: new DOMException('No port selected', 'NotFoundError') });
  const { source, log } = makeSource();
  await source.connect();
  assert.deepEqual(log.states.map((s) => s.state), ['connecting', 'idle']);
  assert.equal(log.states[1].cancelled, true);
  assert.equal(source.connected, false);
});

test('open failure is reported with actionable guidance and leaves nothing connected', async () => {
  const port = makePort();
  port.open = async () => { throw new Error('Failed to open serial port.'); };
  install({ port });
  const { source, log } = makeSource();
  await source.connect();
  const err = log.states.at(-1);
  assert.equal(err.state, 'error');
  assert.match(err.message, /Serial Monitor/);
  assert.equal(source.connected, false);
});

test('opens at 115200 and frames newline-delimited lines across chunk boundaries', async () => {
  const port = makePort();
  install({ port });
  const { source, log } = makeSource();
  await source.connect();
  assert.deepEqual(port.opened, [{ baudRate: 115200 }]);
  assert.equal(log.states.at(-1).state, 'connected');

  port.push('=== BANNER ===\r\n{"ldr":9');
  await wait();
  assert.deepEqual(log.lines, ['=== BANNER ===']); // partial JSON line is held back
  port.push('00,"sV":5.3}\n\n  \nSOLAR : ok\n{"a":');
  await wait();
  assert.deepEqual(log.lines, ['=== BANNER ===', '{"ldr":900,"sV":5.3}', 'SOLAR : ok']);
  await source.disconnect();
});

test('calling connect twice never starts a second reader loop', async () => {
  const port = makePort();
  const serial = install({ port });
  const { source } = makeSource();
  await source.connect();
  await source.connect();
  assert.equal(serial.requestCalls, 1);
  assert.equal(port.opened.length, 1);
  await source.disconnect();
});

test('user disconnect closes the port, releases listeners, and allows reconnecting', async () => {
  const port = makePort();
  const serial = install({ port });
  const { source, log } = makeSource();
  await source.connect();
  assert.equal(serial.listeners.length, 1);
  await source.disconnect();
  assert.equal(port.closeCalls, 1);
  assert.equal(serial.listeners.length, 0);
  assert.equal(source.connected, false);
  assert.deepEqual(log.states.at(-1), { state: 'disconnected', user: true });

  const port2 = makePort();
  install({ port: port2 });
  await source.connect();
  assert.equal(source.connected, true);
  await source.disconnect();
});

test('a fatal read error is reported once as a lost connection and the port is cleaned up', async () => {
  const port = makePort();
  install({ port });
  const { source, log } = makeSource();
  await source.connect();
  port.fail(new Error('The device has been lost.'));
  await wait(40);
  const lost = log.states.filter((s) => s.state === 'disconnected');
  assert.equal(lost.length, 1);
  assert.match(lost[0].reason, /device has been lost/);
  assert.equal(lost[0].user, undefined);
  assert.equal(port.closeCalls, 1);
  assert.equal(source.connected, false);
});

test('USB removal event reports the loss exactly once', async () => {
  const port = makePort();
  const serial = install({ port });
  const { source, log } = makeSource();
  await source.connect();
  const handler = serial.listeners.find((l) => l.type === 'disconnect').fn;
  handler({ target: { other: true } }); // some other device: ignored
  assert.equal(log.states.filter((s) => s.state === 'disconnected').length, 0);
  handler({ target: port });
  handler({ target: port });
  await wait(40);
  const lost = log.states.filter((s) => s.state === 'disconnected');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, 'USB device removed');
});

test('a stream that ends cleanly terminates the loop instead of spinning', async () => {
  const port = makePort();
  install({ port });
  const { source, log } = makeSource();
  await source.connect();
  port.end(); // stream closes while the port object still looks open
  await wait(40);
  const lost = log.states.filter((s) => s.state === 'disconnected');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason, 'Serial port closed');
  assert.equal(port.closeCalls, 1);
});

test('wrong-baud garbage without newlines is discarded with a note, not buffered forever', async () => {
  const port = makePort();
  install({ port });
  const { source, log } = makeSource();
  await source.connect();
  port.push('x'.repeat(200));
  await wait();
  assert.equal(log.notes.length, 1);
  assert.match(log.notes[0], /over-long line/);
  port.push('ok\n');
  await wait();
  assert.deepEqual(log.lines, ['ok']);
  await source.disconnect();
});

test('browsers without Web Serial get a clear error and no throw', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  const { source, log } = makeSource();
  await assert.doesNotReject(() => source.connect());
  assert.equal(WebSerialSource.supported, false);
  assert.equal(log.states[0].state, 'error');
  assert.match(log.states[0].message, /Chrome or Edge/);
});

test('an exception in the line handler is isolated: later lines still arrive and it is reported, not treated as a read error', async () => {
  const port = makePort();
  install({ port });
  const seen = [];
  const notes = [];
  const states = [];
  const source = new WebSerialSource({
    baudRate: 115200,
    maxLineLength: 64,
    onLine: (line) => {
      if (line === 'boom') throw new Error('handler bug');
      seen.push(line);
    },
    onState: (state) => states.push(state),
    onNote: (note) => notes.push(note),
  });
  await source.connect();
  port.push('one\nboom\ntwo\n');
  await wait();
  assert.deepEqual(seen, ['one', 'two']);
  assert.match(notes[0], /handler bug/);
  assert.equal(states.includes('disconnected'), false);
  await source.disconnect();
});
