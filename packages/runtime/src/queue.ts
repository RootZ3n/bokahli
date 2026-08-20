/**
 * Single-lease admission control.
 *
 * Phase 1 runs one loaded model, one inference slot, one active request. The
 * queue makes that explicit rather than letting concurrency emerge from
 * whatever the backend happens to accept. When the queue is full or a waiter
 * times out, the caller gets a typed capacity outcome — never a silent stall.
 */
export interface QueueOptions {
  readonly maxConcurrent: number;
  readonly maxQueueDepth: number;
  readonly queueTimeoutMs: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  maxConcurrent: 1,
  maxQueueDepth: 8,
  queueTimeoutMs: 120_000,
};

export type AdmissionResult =
  | { readonly admitted: true; readonly waitMs: number; readonly depthAtAdmission: number; readonly release: () => void }
  | { readonly admitted: false; readonly reason: 'QUEUE_FULL' | 'QUEUE_TIMEOUT'; readonly depth: number };

interface Waiter {
  resolve: (v: AdmissionResult) => void;
  timer: NodeJS.Timeout;
  enqueuedAt: number;
  settled: boolean;
}

export class AdmissionQueue {
  readonly #opts: QueueOptions;
  #active = 0;
  #waiting: Waiter[] = [];
  #totalAdmitted = 0;
  #totalRejected = 0;
  #totalTimedOut = 0;
  #peakDepth = 0;

  constructor(opts: Partial<QueueOptions> = {}) {
    this.#opts = { ...DEFAULT_QUEUE_OPTIONS, ...opts };
  }

  get depth(): number {
    return this.#waiting.length;
  }

  get active(): number {
    return this.#active;
  }

  stats(): {
    active: number;
    depth: number;
    peakDepth: number;
    totalAdmitted: number;
    totalRejected: number;
    totalTimedOut: number;
    maxConcurrent: number;
    maxQueueDepth: number;
  } {
    return {
      active: this.#active,
      depth: this.#waiting.length,
      peakDepth: this.#peakDepth,
      totalAdmitted: this.#totalAdmitted,
      totalRejected: this.#totalRejected,
      totalTimedOut: this.#totalTimedOut,
      maxConcurrent: this.#opts.maxConcurrent,
      maxQueueDepth: this.#opts.maxQueueDepth,
    };
  }

  async acquire(): Promise<AdmissionResult> {
    if (this.#active < this.#opts.maxConcurrent) {
      this.#active++;
      this.#totalAdmitted++;
      return { admitted: true, waitMs: 0, depthAtAdmission: 0, release: () => this.#release() };
    }
    if (this.#waiting.length >= this.#opts.maxQueueDepth) {
      this.#totalRejected++;
      return { admitted: false, reason: 'QUEUE_FULL', depth: this.#waiting.length };
    }

    return new Promise<AdmissionResult>((resolve) => {
      const waiter: Waiter = {
        resolve,
        enqueuedAt: Date.now(),
        settled: false,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          this.#waiting = this.#waiting.filter((w) => w !== waiter);
          this.#totalTimedOut++;
          resolve({ admitted: false, reason: 'QUEUE_TIMEOUT', depth: this.#waiting.length });
        }, this.#opts.queueTimeoutMs),
      };
      this.#waiting.push(waiter);
      if (this.#waiting.length > this.#peakDepth) this.#peakDepth = this.#waiting.length;
    });
  }

  #release(): void {
    // Exactly one slot is freed per release. Skipping over already-settled
    // waiters must NOT free additional slots — an earlier recursive form of
    // this did, which would let #active drift negative and over-admit.
    this.#active--;
    for (;;) {
      const next = this.#waiting.shift();
      if (!next) return;
      if (next.settled) continue;

      next.settled = true;
      clearTimeout(next.timer);
      this.#active++;
      this.#totalAdmitted++;
      const waitMs = Date.now() - next.enqueuedAt;
      next.resolve({
        admitted: true,
        waitMs,
        depthAtAdmission: this.#waiting.length,
        release: () => this.#release(),
      });
      return;
    }
  }
}
