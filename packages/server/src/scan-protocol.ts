/**
 * Bokahli — the message contract between the request path and a scan worker.
 * ===========================================================================
 * Every message here is structured-clone-safe: plain objects, strings, numbers
 * and arrays. No class instances, no functions, no `Uint8Array` views onto a
 * shared buffer, nothing whose identity would be lost or shared across the
 * boundary.
 *
 * ## What binds a result to its job
 *
 * Five fields, on every response: the job id, the digest of the exact input,
 * the trust zone, the registry payload digest and the detector version. The
 * pool checks all five against the job it is waiting for and discards anything
 * that does not match.
 *
 * That is not defensive decoration. A worker pool has four ways to hand back
 * the wrong answer — a result that arrives after its job timed out, a duplicate
 * of one already consumed, a result for a different job on a recycled worker,
 * and a result produced under a registry the main process is no longer running
 * — and all four look exactly like a valid answer if nothing checks.
 */
import type { BokahliChatMessage, VelumPacketReport, VelumTelemetry } from '@bokahli/contracts';
import type { AuthSource } from './auth.js';
import type { EvidenceItem, TrustMode } from './trust.js';

/** Bokahli's trust zone for a job. Carried so a result can be bound to it. */
export type ScanZone = 'request' | 'model-output';

/** Ceilings on what a result may carry back across the boundary. */
export const MAX_RESULT_PACKETS = 64;
export const MAX_RESULT_FINDINGS = 64;

export interface ScanReady {
  readonly type: 'ready';
  readonly detectorVersion: string;
  readonly registryPayloadSha256: string;
  readonly registryVersion: string;
  readonly patternCount: number;
}

interface JobBase {
  readonly jobId: string;
  /** sha256 over the exact content, recomputed by the worker on arrival. */
  readonly inputSha256: string;
  readonly zone: ScanZone;
  readonly mode: TrustMode;
}

export interface RequestScanJob extends JobBase {
  readonly kind: 'request';
  readonly zone: 'request';
  readonly authSource: AuthSource;
  readonly messages: readonly BokahliChatMessage[];
  readonly evidence: readonly EvidenceItem[];
}

export interface ModelOutputScanJob extends JobBase {
  readonly kind: 'model-output';
  readonly zone: 'model-output';
  readonly id: string;
  readonly text: string;
}

export type ScanJob = RequestScanJob | ModelOutputScanJob;

interface Bound {
  readonly jobId: string;
  readonly inputSha256: string;
  readonly zone: ScanZone;
  readonly registryPayloadSha256: string;
  readonly detectorVersion: string;
}

export type ScanResponse =
  | (Bound & {
    readonly type: 'admitted';
    readonly messages: readonly BokahliChatMessage[];
    readonly telemetry: VelumTelemetry;
    readonly reason: null;
  })
  | (Bound & {
    readonly type: 'blocked';
    readonly messages: readonly BokahliChatMessage[];
    readonly telemetry: VelumTelemetry;
    readonly reason: string | null;
  })
  | (Bound & {
    readonly type: 'escalate';
    readonly reason: 'VELUM_RESOURCE_LIMIT' | 'VELUM_MAPPING_FAILURE' | 'VELUM_ENGINE_ERROR';
    readonly detail: string;
  })
  | (Bound & {
    readonly type: 'failed';
    readonly reason: 'VELUM_ENGINE_ERROR' | 'INPUT_DIGEST_MISMATCH';
    readonly detail: string;
  })
  | (Bound & {
    readonly type: 'model-output';
    readonly packet: VelumPacketReport | null;
  });

/** Does this response belong to the job that is waiting for it? */
export function bindsTo(
  response: Bound,
  job: { readonly jobId: string; readonly inputSha256: string; readonly zone: ScanZone },
  engine: { readonly registryPayloadSha256: string; readonly detectorVersion: string },
): boolean {
  return (
    response.jobId === job.jobId &&
    response.inputSha256 === job.inputSha256 &&
    response.zone === job.zone &&
    response.registryPayloadSha256 === engine.registryPayloadSha256 &&
    response.detectorVersion === engine.detectorVersion
  );
}
