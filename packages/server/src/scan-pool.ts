/**
 * Bokahli — a bounded worker pool for prompt-injection inspection.
 * ===========================================================================
 * Scanning is synchronous and its cost is chosen by the caller. On the main
 * thread that meant a 1 MiB document held the process for ~2.6 seconds and a
 * 4 MiB one for ~11.3 — measured — during which `/health/live` did not answer,
 * nothing was admitted, no queue slot was released and no stream progressed.
 * This moves that work to worker threads so the event loop keeps running.
 *
 * ## Bounded, and refusing rather than queueing
 *
 * A fixed number of workers, and no queue at all. A request that arrives when
 * every worker is busy is refused immediately with a typed capacity outcome.
 * Queueing would convert a bounded refusal into unbounded memory held by
 * waiters — each one still holding its evidence — which is the failure the byte
 * reservation in `velum-capacity.ts` exists to prevent, reintroduced one layer
 * down.
 *
 * ## Every exit path returns what it took
 *
 * A job can end five ways: a result, a typed escalation, a deadline, a worker
 * crash, and shutdown. All five settle the promise exactly once and clear the
 * job's slot. The byte reservation is released by the caller in a `finally`;
 * the *worker* slot is released here, and `settle` is the only thing that does
 * it, so there is one place to be right rather than five.
 *
 * ## A deadline means terminating the worker
 *
 * There is no other way. The scan is a synchronous loop inside the worker, so
 * nothing short of `terminate()` interrupts it — posting a cancellation would
 * sit in a queue the worker is not reading. A timed-out worker is destroyed and
 * replaced, which is why the pool is sized rather than pooled forever.
 */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { BokahliChatMessage, VelumPacketReport, VelumTelemetry } from '@bokahli/contracts';

import type { AuthSource } from './auth.js';
import { engineIdentity, type EvidenceItem, type TrustMode } from './trust.js';
import {
  bindsTo, type ScanJob, type ScanReady, type ScanResponse, type ScanZone,
} from './scan-protocol.js';

export interface ScanPoolOptions {
  /** Workers to keep. Fixed; the pool never grows under load. */
  readonly workers: number;
  /** Wall-clock ceiling for one job, after which the worker is terminated. */
  readonly jobTimeoutMs: number;
  /** Where the worker entry point lives. Overridable for tests. */
  readonly workerUrl?: URL;
}

export type ScanDispatch =
  | { readonly kind: 'ADMITTED'; readonly messages: readonly BokahliChatMessage[]; readonly telemetry: VelumTelemetry }
  | { readonly kind: 'BLOCKED'; readonly telemetry: VelumTelemetry; readonly reason: string }
  | {
    readonly kind: 'ESCALATE';
    readonly reason: 'VELUM_RESOURCE_LIMIT' | 'VELUM_MAPPING_FAILURE' | 'VELUM_ENGINE_ERROR' | 'VELUM_SCAN_TIMEOUT' | 'VELUM_WORKER_LOST';
    readonly detail: string;
  }
  | { readonly kind: 'SATURATED'; readonly busy: number; readonly workers: number };

export interface ScanPoolHealth {
  readonly workers: number;
  readonly ready: number;
  readonly busy: number;
  readonly dispatched: number;
  readonly completed: number;
  readonly refusedSaturated: number;
  readonly timeouts: number;
  readonly crashes: number;
  readonly rejectedResults: number;
  readonly handshakeFailures: number;
  readonly lastHandshakeAt: string | null;
  readonly detectorVersion: string;
  readonly registryPayloadSha256: string;
}

interface Slot {
  worker: Worker | null;
  ready: boolean;
  job: PendingJob | null;
}

interface PendingJob {
  readonly jobId: string;
  readonly inputSha256: string;
  readonly zone: ScanZone;
  readonly settle: (r: ScanDispatch | { readonly kind: 'MODEL_OUTPUT'; readonly packet: VelumPacketReport | null }) => void;
  timer: NodeJS.Timeout | null;
  done: boolean;
}

/** How long a first request waits for a worker to announce itself. */
const STARTUP_HANDSHAKE_MS = 5_000;

export class ScanPool {
  readonly #opts: ScanPoolOptions;
  readonly #engine = engineIdentity();
  readonly #slots: Slot[] = [];
  #closed = false;
  #seq = 0;
  /**
   * Resolves when at least one worker has handshaken.
   *
   * A pool whose workers are still starting is not a saturated pool, and
   * refusing the first request after a restart with "all workers are busy"
   * would be both wrong and confusing. Bounded: if no worker ever announces
   * itself, this resolves anyway and the request gets the honest answer.
   */
  #firstReady: Promise<void>;
  #markReady: () => void = () => {};

  #dispatched = 0;
  #completed = 0;
  #refusedSaturated = 0;
  #timeouts = 0;
  #crashes = 0;
  #rejectedResults = 0;
  #handshakeFailures = 0;
  #lastHandshakeAt: string | null = null;

  constructor(opts: ScanPoolOptions) {
    if (!Number.isSafeInteger(opts.workers) || opts.workers < 1) {
      throw new Error(`scan pool needs at least one worker, got ${String(opts.workers)}`);
    }
    if (!Number.isSafeInteger(opts.jobTimeoutMs) || opts.jobTimeoutMs < 1) {
      throw new Error(`scan pool needs a positive job timeout, got ${String(opts.jobTimeoutMs)}`);
    }
    this.#opts = opts;
    this.#firstReady = new Promise<void>((resolve) => { this.#markReady = resolve; });
    const startupBudget = setTimeout(() => this.#markReady(), STARTUP_HANDSHAKE_MS);
    startupBudget.unref?.();
    for (let i = 0; i < opts.workers; i++) this.#slots.push({ worker: null, ready: false, job: null });
    for (const slot of this.#slots) this.#spawn(slot);
  }

  /** Inspect a request. Never throws; every failure is a typed outcome. */
  async inspect(input: {
    readonly requestId: string;
    readonly authSource: AuthSource;
    readonly messages: readonly BokahliChatMessage[];
    readonly evidence: readonly EvidenceItem[];
    readonly mode: TrustMode;
  }): Promise<ScanDispatch> {
    const h = createHash('sha256');
    for (const m of input.messages) h.update(m.content, 'utf8');
    for (const e of input.evidence) { h.update(e.id, 'utf8'); h.update(e.content, 'utf8'); }
    const inputSha256 = `sha256:${h.digest('hex')}`;
    const jobId = `${input.requestId}#${++this.#seq}`;

    const job: ScanJob = {
      kind: 'request', zone: 'request', jobId, inputSha256, mode: input.mode,
      authSource: input.authSource, messages: input.messages, evidence: input.evidence,
    };
    const out = await this.#run(job);
    return out.kind === 'MODEL_OUTPUT'
      ? { kind: 'ESCALATE', reason: 'VELUM_ENGINE_ERROR', detail: 'a request job returned a model-output result' }
      : out;
  }

  /** Inspect a completion. Observation only; a failure degrades to no packet. */
  async inspectModelOutput(requestId: string, id: string, text: string, mode: TrustMode): Promise<VelumPacketReport | null> {
    if (mode === 'off') return null;
    const inputSha256 = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    const job: ScanJob = {
      kind: 'model-output', zone: 'model-output', jobId: `${requestId}#out#${++this.#seq}`,
      inputSha256, mode, id, text,
    };
    const out = await this.#run(job);
    return out.kind === 'MODEL_OUTPUT' ? out.packet : null;
  }

  health(): ScanPoolHealth {
    return {
      workers: this.#slots.length,
      ready: this.#slots.filter((s) => s.ready).length,
      busy: this.#slots.filter((s) => s.job !== null).length,
      dispatched: this.#dispatched,
      completed: this.#completed,
      refusedSaturated: this.#refusedSaturated,
      timeouts: this.#timeouts,
      crashes: this.#crashes,
      rejectedResults: this.#rejectedResults,
      handshakeFailures: this.#handshakeFailures,
      lastHandshakeAt: this.#lastHandshakeAt,
      detectorVersion: this.#engine.detectorVersion,
      registryPayloadSha256: this.#engine.registryPayloadSha256,
    };
  }

  /**
   * Stop accepting work and terminate the workers.
   *
   * In-flight jobs settle as `VELUM_WORKER_LOST` rather than hanging: a caller
   * awaiting a scan during shutdown gets a typed answer and its reservation
   * back, which is what lets the process exit instead of waiting on a promise
   * nobody will resolve.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#markReady();
    const terminations: Promise<unknown>[] = [];
    for (const slot of this.#slots) {
      if (slot.job !== null) {
        this.#settle(slot, { kind: 'ESCALATE', reason: 'VELUM_WORKER_LOST', detail: 'the inspector is shutting down' });
      }
      slot.ready = false;
      if (slot.worker !== null) {
        const w = slot.worker;
        slot.worker = null;
        terminations.push(w.terminate().catch(() => undefined));
      }
    }
    await Promise.all(terminations);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  async #run(job: ScanJob): Promise<ScanDispatch | { kind: 'MODEL_OUTPUT'; packet: VelumPacketReport | null }> {
    if (this.#closed) {
      return { kind: 'ESCALATE', reason: 'VELUM_WORKER_LOST', detail: 'the inspector is shut down' } as const;
    }
    // Starting is not the same as saturated.
    await this.#firstReady;
    if (this.#closed) {
      return { kind: 'ESCALATE', reason: 'VELUM_WORKER_LOST', detail: 'the inspector is shut down' } as const;
    }
    // Claimed before anything is posted, so two callers cannot see the same
    // free slot. Synchronous with no `await` between the check and the claim,
    // which on a single-threaded runtime is what makes it a claim.
    const slot = this.#slots.find((s) => s.ready && s.job === null && s.worker !== null);
    if (slot === undefined) {
      this.#refusedSaturated += 1;
      return {
        kind: 'SATURATED',
        busy: this.#slots.filter((s) => s.job !== null).length,
        workers: this.#slots.length,
      } as const;
    }

    return new Promise((resolve) => {
      const pending: PendingJob = {
        jobId: job.jobId, inputSha256: job.inputSha256, zone: job.zone,
        settle: resolve, timer: null, done: false,
      };
      slot.job = pending;
      this.#dispatched += 1;
      pending.timer = setTimeout(() => {
        // Nothing short of termination interrupts a synchronous scan.
        this.#timeouts += 1;
        this.#settle(slot, {
          kind: 'ESCALATE', reason: 'VELUM_SCAN_TIMEOUT',
          detail: `inspection exceeded ${this.#opts.jobTimeoutMs} ms and the worker was replaced`,
        });
        this.#recycle(slot);
      }, this.#opts.jobTimeoutMs);
      pending.timer.unref?.();
      // Re-referenced for the duration of the job so the process cannot exit
      // between posting the work and hearing the answer.
      slot.worker?.ref();
      slot.worker?.postMessage(job);
    });
  }

  #spawn(slot: Slot): void {
    if (this.#closed) return;
    const url = this.#opts.workerUrl ?? new URL('./scan-worker.js', import.meta.url);
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch {
      this.#handshakeFailures += 1;
      return;
    }
    slot.worker = worker;
    slot.ready = false;
    // An idle inspector must not keep the process alive. While a job is in
    // flight the pending promise does that; between jobs there is nothing to
    // wait for, and a ref'd worker would hold a shutdown open for its whole
    // lifetime.
    worker.unref();

    worker.on('message', (msg: ScanReady | ScanResponse) => {
      if (msg.type === 'ready') {
        // A worker that compiled a different registry is refused rather than
        // used. Two processes disagreeing about what the rules are is worse
        // than having one fewer worker, because the answers still look like
        // answers.
        if (
          msg.detectorVersion !== this.#engine.detectorVersion ||
          msg.registryPayloadSha256 !== this.#engine.registryPayloadSha256
        ) {
          this.#handshakeFailures += 1;
          slot.ready = false;
          void worker.terminate().catch(() => undefined);
          return;
        }
        slot.ready = true;
        this.#lastHandshakeAt = new Date().toISOString();
        this.#markReady();
        return;
      }
      this.#onResult(slot, msg);
    });

    worker.on('error', () => {
      this.#crashes += 1;
      this.#settle(slot, { kind: 'ESCALATE', reason: 'VELUM_WORKER_LOST', detail: 'the inspector worker failed' });
      this.#recycle(slot);
    });

    worker.on('exit', () => {
      if (slot.worker !== worker) return; // already recycled
      this.#crashes += 1;
      this.#settle(slot, { kind: 'ESCALATE', reason: 'VELUM_WORKER_LOST', detail: 'the inspector worker exited' });
      this.#recycle(slot);
    });
  }

  #onResult(slot: Slot, msg: ScanResponse): void {
    const job = slot.job;
    // A result with no job waiting, or one that does not bind to the job that
    // is, is discarded. Late results after a timeout and duplicates both arrive
    // here, and both look exactly like a valid answer to anything that does not
    // check the binding.
    if (job === null || !bindsTo(msg, job, this.#engine)) {
      this.#rejectedResults += 1;
      return;
    }

    switch (msg.type) {
      case 'admitted':
        this.#settle(slot, { kind: 'ADMITTED', messages: msg.messages, telemetry: msg.telemetry });
        return;
      case 'blocked':
        this.#settle(slot, { kind: 'BLOCKED', telemetry: msg.telemetry, reason: msg.reason ?? 'evidence blocked' });
        return;
      case 'escalate':
        this.#settle(slot, { kind: 'ESCALATE', reason: msg.reason, detail: msg.detail });
        return;
      case 'failed':
        this.#settle(slot, {
          kind: 'ESCALATE',
          reason: msg.reason === 'INPUT_DIGEST_MISMATCH' ? 'VELUM_MAPPING_FAILURE' : 'VELUM_ENGINE_ERROR',
          detail: msg.detail,
        });
        return;
      case 'model-output':
        this.#settle(slot, { kind: 'MODEL_OUTPUT', packet: msg.packet });
        return;
      default:
        this.#rejectedResults += 1;
    }
  }

  /** The single place a job ends. Idempotent, and always frees the slot. */
  #settle(
    slot: Slot,
    result: ScanDispatch | { kind: 'MODEL_OUTPUT'; packet: VelumPacketReport | null },
  ): void {
    const job = slot.job;
    if (job === null || job.done) return;
    job.done = true;
    if (job.timer !== null) clearTimeout(job.timer);
    slot.job = null;
    slot.worker?.unref();
    this.#completed += 1;
    job.settle(result);
  }

  #recycle(slot: Slot): void {
    const old = slot.worker;
    slot.worker = null;
    slot.ready = false;
    if (old !== null) void old.terminate().catch(() => undefined);
    if (!this.#closed) this.#spawn(slot);
  }
}
