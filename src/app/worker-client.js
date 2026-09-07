// Promise-based client for src/worker.js with cancellation by termination.
export class CancelledError extends Error {
  constructor(message = "Cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export class WorkerClient {
  /** @param {() => Worker} createWorker */
  constructor(createWorker) {
    this.createWorker = createWorker;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;
    this.busy = 0;
    this.info = null;
    this.onStatus = null;
    this.lastError = null;
  }

  start() {
    if (this.worker) return this.ready;
    let worker;
    try {
      worker = this.createWorker();
    } catch (err) {
      this.lastError = err;
      this.onStatus?.("error", err);
      return Promise.reject(err);
    }
    this.worker = worker;
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    worker.onmessage = (e) => this._onMessage(e.data);
    worker.onerror = (e) => {
      const err = new Error(`The numerical worker failed to load: ${e.message || "unknown error"}. The core library (src/lib/index.js) may be missing or failing to import.`);
      this.lastError = err;
      this._rejectReady?.(err);
      this._failAll(err);
      this.onStatus?.("error", err);
    };
    worker.onmessageerror = () => {
      const err = new Error("A worker message could not be deserialized.");
      this._failAll(err);
      this.onStatus?.("error", err);
    };
    return this.ready;
  }

  _onMessage(msg) {
    if (msg?.type === "ready") {
      this.info = msg;
      this._resolveReady?.(msg);
      this.onStatus?.("ready", msg);
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.busy = Math.max(0, this.busy - 1);
    this.onStatus?.(this.busy ? "busy" : "idle");
    if (msg.type === "error") {
      const err = new Error(msg.message);
      err.workerStack = msg.stack;
      p.reject(err);
    } else {
      p.resolve(msg);
    }
  }

  async request(type, payload = {}, transfer = []) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.busy++;
      this.onStatus?.("busy");
      try {
        this.worker.postMessage({ id, type, ...payload }, transfer);
      } catch (err) {
        this.pending.delete(id);
        this.busy = Math.max(0, this.busy - 1);
        reject(err);
      }
    });
  }

  /** Terminate the worker immediately. Pending requests reject with CancelledError. */
  terminate(reason = "Cancelled") {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch {
      // Nothing to do; the worker is gone either way.
    }
    this.worker = null;
    this.ready = null;
    this.info = null;
    this.busy = 0;
    this._failAll(new CancelledError(reason));
    this.onStatus?.("terminated");
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
