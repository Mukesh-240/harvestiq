// Web Serial transport. Chrome/Edge only, secure context (http://localhost or https).
// Responsibilities: user-initiated connect, one read loop at a time, newline framing,
// clean shutdown. It knows nothing about telemetry - lines go to onLine().

const MAX_CONSECUTIVE_READ_ERRORS = 5;

export class WebSerialSource {
  #port = null;
  #reader = null;
  #loop = null;
  #closing = false;
  #lostReported = false;
  #buffer = '';
  #opts;
  #usbListener = null;

  /** @param {{baudRate:number, maxLineLength:number, onLine:(line:string,t:number)=>void, onState:(state:string, detail?:object)=>void, onNote?:(msg:string)=>void}} opts */
  constructor(opts) {
    this.#opts = opts;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get connected() {
    return this.#port !== null;
  }

  /** Must be called from a user gesture (button click). */
  async connect() {
    if (this.#port) return; // never start a second read loop
    if (!WebSerialSource.supported) {
      this.#opts.onState('error', { message: 'This browser has no Web Serial API. Use Chrome or Edge on a laptop, served from http://localhost.' });
      return;
    }
    this.#opts.onState('connecting');
    let port;
    try {
      port = await navigator.serial.requestPort();
    } catch (error) {
      this.#opts.onState('idle', { cancelled: true, message: error?.message });
      return;
    }
    try {
      await port.open({ baudRate: this.#opts.baudRate });
    } catch (error) {
      this.#opts.onState('error', {
        message: `Could not open the port (${error?.message ?? 'unknown error'}). Close Arduino Serial Monitor or any other program using it, then try again.`,
      });
      return;
    }
    this.#port = port;
    this.#closing = false;
    this.#lostReported = false;
    this.#buffer = '';
    this.#usbListener = (event) => {
      if (event.target === this.#port) this.#handleLoss('USB device removed');
    };
    navigator.serial.addEventListener('disconnect', this.#usbListener);
    this.#opts.onState('connected');
    this.#loop = this.#readLoop(port);
  }

  /** User-initiated disconnect. */
  async disconnect() {
    if (!this.#port) return;
    this.#closing = true;
    try {
      await this.#reader?.cancel();
    } catch {
      // reader may already be released
    }
    try {
      await this.#loop;
    } catch {
      // read-loop errors are reported through onState
    }
    await this.#release();
    this.#opts.onState('disconnected', { user: true });
  }

  async #readLoop(port) {
    const decoder = new TextDecoder();
    let errors = 0;
    let lastError = null;
    let ended = false;
    while (port.readable && !this.#closing && !ended && errors < MAX_CONSECUTIVE_READ_ERRORS) {
      const reader = port.readable.getReader();
      this.#reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true; // a cleanly ended stream must not be re-read in a tight loop
            break;
          }
          if (value) {
            errors = 0;
            this.#feed(decoder.decode(value, { stream: true }));
          }
        }
      } catch (error) {
        errors += 1;
        lastError = error;
      } finally {
        reader.releaseLock();
        this.#reader = null;
      }
    }
    if (!this.#closing) this.#handleLoss(lastError?.message ?? 'Serial port closed');
  }

  #feed(chunk) {
    this.#buffer += chunk;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop();
    const t = Date.now();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.#opts.onLine(trimmed, t);
      } catch (error) {
        // A bug in the consumer must not look like a serial failure or drop the rest of the chunk.
        this.#opts.onNote?.(`Line handler error: ${error?.message ?? error}`);
      }
    }
    if (this.#buffer.length > this.#opts.maxLineLength) {
      this.#buffer = '';
      this.#opts.onNote?.('Discarded an over-long line with no newline (wrong baud rate?)');
    }
  }

  async #handleLoss(reason) {
    if (this.#lostReported || this.#closing) return;
    this.#lostReported = true;
    await this.#release();
    this.#opts.onState('disconnected', { reason });
  }

  async #release() {
    if (this.#usbListener) navigator.serial.removeEventListener('disconnect', this.#usbListener);
    this.#usbListener = null;
    const port = this.#port;
    this.#port = null;
    this.#reader = null;
    try {
      await port?.close();
    } catch {
      // already closed or device gone
    }
  }
}
