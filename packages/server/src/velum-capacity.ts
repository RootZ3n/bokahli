/**
 * Bokahli — admission control for prompt-injection inspection.
 * ===========================================================================
 * Inspection is not free and its cost is set by the caller. This is the budget
 * that says how much of it may be in flight at once, and refuses the rest with
 * a typed capacity outcome rather than allocating and hoping.
 *
 * ## What was measured
 *
 * Before the engine's cell table became two typed arrays, one megabyte of ASCII
 * evidence cost 62.5 bytes of heap *per code point* — 257 MiB of peak heap for
 * a single scan, and peak RSS past 770 MiB on a four megabyte attempt that the
 * step budget then refused anyway. It is 1.1 MiB of peak heap now. What did not
 * change is time: a scan is synchronous, so a one megabyte request holds the
 * event loop for roughly three seconds and a four megabyte one for eleven.
 *
 * Memory is therefore no longer the binding constraint; **occupancy** is. A
 * reservation here is a claim on the inspector for the lifetime of a request,
 * and its purpose is that a caller cannot get more of it by asking twice.
 *
 * ## Why reservations are held for the whole request, not the scan
 *
 * Scans cannot overlap — `admitRequest` is synchronous, so Node runs exactly
 * one at a time. What *does* accumulate across concurrent requests is what a
 * scan leaves behind: the caller's raw evidence, the fenced rendering, and the
 * transformation map, all retained until the response is finished so a citation
 * can still be resolved. So the reservation is taken before inspection and
 * released in a `finally` when the request ends, which bounds both the
 * transient cost and the retained one with a single number.
 *
 * ## On the absence of a queue
 *
 * There is none, deliberately. A request that cannot be inspected now is
 * refused now, with `retryAfterSeconds`. Queueing it would convert a bounded
 * refusal into unbounded memory held by waiters, which is the failure this file
 * exists to prevent.
 */

/** A granted claim on inspection capacity. Releasing twice is a no-op. */
export interface ScanReservation {
  readonly bytes: number;
  release(): void;
}

export type ScanRefusal =
  /** One request asked for more than any single request may have. */
  | 'PER_REQUEST'
  /** Enough is already in flight that this one does not fit. */
  | 'IN_FLIGHT';

export type ReserveResult =
  | { readonly ok: true; readonly reservation: ScanReservation }
  | {
    readonly ok: false;
    readonly reason: ScanRefusal;
    readonly requestedBytes: number;
    readonly availableBytes: number;
    readonly limitBytes: number;
  };

export interface ScanCapacityUsage {
  readonly inFlightBytes: number;
  readonly inFlightRequests: number;
  readonly limitBytes: number;
  readonly perRequestLimitBytes: number;
  readonly peakInFlightBytes: number;
  readonly granted: number;
  readonly refused: number;
}

export class ScanCapacityError extends Error {}

/**
 * A process-wide budget for bytes under inspection.
 *
 * `reserve` is synchronous and contains no `await`, so the check and the
 * increment cannot interleave with another request: on a single-threaded
 * runtime that is what makes it free of a check-then-allocate race, and it is
 * why the increment lives in the same function as the comparison rather than in
 * a caller that "will remember to". A test races eight callers for the last
 * reservation and asserts exactly one wins.
 */
export class ScanCapacity {
  readonly limitBytes: number;
  readonly perRequestLimitBytes: number;

  #inFlightBytes = 0;
  #inFlightRequests = 0;
  #peakInFlightBytes = 0;
  #granted = 0;
  #refused = 0;

  constructor(limitBytes: number, perRequestLimitBytes: number) {
    for (const [name, v] of [['limitBytes', limitBytes], ['perRequestLimitBytes', perRequestLimitBytes]] as const) {
      if (!Number.isSafeInteger(v) || v <= 0) {
        throw new ScanCapacityError(`${name} must be a positive safe integer, got ${String(v)}`);
      }
    }
    if (perRequestLimitBytes > limitBytes) {
      // Otherwise a single request could be individually acceptable and never
      // satisfiable, which is a refusal that looks like a bug.
      throw new ScanCapacityError(
        `perRequestLimitBytes ${perRequestLimitBytes} exceeds limitBytes ${limitBytes}`,
      );
    }
    this.limitBytes = limitBytes;
    this.perRequestLimitBytes = perRequestLimitBytes;
  }

  reserve(bytes: number): ReserveResult {
    // Reservation arithmetic is in safe integers or it is refused. A byte count
    // that is NaN, negative or past 2^53 is not a size, and treating it as one
    // is how a budget gets bypassed by arithmetic rather than by load.
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ScanCapacityError(`reservation size must be a non-negative safe integer, got ${String(bytes)}`);
    }
    if (bytes > this.perRequestLimitBytes) {
      this.#refused += 1;
      return {
        ok: false, reason: 'PER_REQUEST', requestedBytes: bytes,
        availableBytes: this.perRequestLimitBytes, limitBytes: this.perRequestLimitBytes,
      };
    }
    const available = this.limitBytes - this.#inFlightBytes;
    if (bytes > available) {
      this.#refused += 1;
      return {
        ok: false, reason: 'IN_FLIGHT', requestedBytes: bytes,
        availableBytes: available, limitBytes: this.limitBytes,
      };
    }

    this.#inFlightBytes += bytes;
    this.#inFlightRequests += 1;
    this.#granted += 1;
    if (this.#inFlightBytes > this.#peakInFlightBytes) this.#peakInFlightBytes = this.#inFlightBytes;

    let released = false;
    const self = this;
    return {
      ok: true,
      reservation: {
        bytes,
        release(): void {
          // Idempotent. A `finally` that runs after an early `return` and again
          // on the way out of an outer `finally` would otherwise hand the budget
          // capacity that was never taken, which leaks the limit upward until
          // nothing is refused.
          if (released) return;
          released = true;
          self.#inFlightBytes -= bytes;
          self.#inFlightRequests -= 1;
        },
      },
    };
  }

  /** Current occupancy. Byte counts and request counts; never any content. */
  usage(): ScanCapacityUsage {
    return {
      inFlightBytes: this.#inFlightBytes,
      inFlightRequests: this.#inFlightRequests,
      limitBytes: this.limitBytes,
      perRequestLimitBytes: this.perRequestLimitBytes,
      peakInFlightBytes: this.#peakInFlightBytes,
      granted: this.#granted,
      refused: this.#refused,
    };
  }
}

/**
 * Bytes a request will put through the inspector.
 *
 * Every zone, summed, because the limit is on the request and not on any one
 * field: an attacker who could spend the per-request budget once per evidence
 * item would have no budget at all. Sizes are measured in UTF-8 bytes, which is
 * what the inspector actually walks.
 */
export function inspectionBytes(
  messages: readonly { readonly content: string }[],
  evidence: readonly { readonly content: string }[],
): number {
  let total = 0;
  for (const m of messages) total += Buffer.byteLength(m.content, 'utf8');
  for (const e of evidence) total += Buffer.byteLength(e.content, 'utf8');
  return total;
}
