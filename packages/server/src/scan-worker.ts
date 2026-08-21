/**
 * Bokahli — the prompt-injection inspector, in a worker thread.
 * ===========================================================================
 * One job per message: inspect a request's content and post back a bounded,
 * structured-clone-safe result. Nothing else happens in here. There is no
 * network, no filesystem, no timer, and no state that survives a job — a worker
 * that remembered anything between requests would be a place for one caller's
 * evidence to reach another's.
 *
 * ## Why this exists
 *
 * Inspection is synchronous and its cost is chosen by the caller. Measured on
 * this machine: a 1 MiB document takes about 2.6 seconds and a 4 MiB one about
 * 11.3, and on the main thread that is 11.3 seconds during which `/health/live`
 * does not answer, no request is admitted, no queue slot is released and no
 * stream makes progress. The work is unavoidable; blocking the process with it
 * is not.
 *
 * ## The handshake
 *
 * A worker announces which detector it compiled before it accepts any job, and
 * the pool refuses one whose registry digest or detector version differs from
 * its own. Two processes disagreeing about what the rules are is worse than
 * having no worker: the answers would still look like answers.
 */
import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';

import { admitRequest, engineIdentity, inspectModelOutput } from './trust.js';
import type { ScanJob, ScanReady, ScanResponse } from './scan-protocol.js';
import { MAX_RESULT_FINDINGS, MAX_RESULT_PACKETS } from './scan-protocol.js';

if (parentPort === null) throw new Error('scan-worker must be started as a worker thread');
const port = parentPort;

const engine = engineIdentity();

const ready: ScanReady = {
  type: 'ready',
  detectorVersion: engine.detectorVersion,
  registryPayloadSha256: engine.registryPayloadSha256,
  registryVersion: engine.registryVersion,
  patternCount: engine.patternCount,
};
port.postMessage(ready);

port.on('message', (job: ScanJob) => {
  // Everything below is bound to the job that asked for it. A result that does
  // not name the job, the exact bytes, the zone and the registry it was
  // produced under is a result the pool cannot attribute, and it rejects it.
  const bound = {
    jobId: job.jobId,
    inputSha256: job.inputSha256,
    zone: job.zone,
    registryPayloadSha256: engine.registryPayloadSha256,
    detectorVersion: engine.detectorVersion,
  } as const;

  try {
    // The digest is recomputed here, from the bytes that actually arrived,
    // rather than trusted from the message. A transfer that changed the content
    // would otherwise be inspected and reported under the sender's idea of what
    // it was.
    const actual = digestOf(job);
    if (actual !== job.inputSha256) {
      port.postMessage({
        type: 'failed', ...bound,
        reason: 'INPUT_DIGEST_MISMATCH',
        detail: 'the content that arrived is not the content the job named',
      } satisfies ScanResponse);
      return;
    }

    if (job.kind === 'model-output') {
      const { packet } = inspectModelOutput(job.id, job.text, job.mode);
      port.postMessage({
        type: 'model-output', ...bound,
        packet: packet === null ? null : capPacket(packet),
      } satisfies ScanResponse);
      return;
    }

    const outcome = admitRequest({
      requestId: job.jobId,
      authSource: job.authSource,
      messages: job.messages,
      evidence: job.evidence,
      mode: job.mode,
    });

    if (outcome.kind === 'ESCALATE') {
      port.postMessage({
        type: 'escalate', ...bound, reason: outcome.reason, detail: outcome.detail,
      } satisfies ScanResponse);
      return;
    }

    // The transformation map stays in the worker. It is large, it is only ever
    // consulted alongside the raw bytes the main thread already has, and
    // shipping it back would put megabytes through structured clone for
    // something almost no request looks at. What crosses is what the model
    // sees and what a finding says.
    const telemetry = {
      ...outcome.telemetry,
      packets: outcome.telemetry.packets.slice(0, MAX_RESULT_PACKETS).map(capPacket),
    };
    const response: ScanResponse = outcome.kind === 'BLOCKED'
      ? { type: 'blocked', ...bound, messages: [], telemetry, reason: outcome.reason }
      : { type: 'admitted', ...bound, messages: outcome.messages, telemetry, reason: null };
    port.postMessage(response);
  } catch (err) {
    const e = err as Error;
    port.postMessage({
      type: 'failed', ...bound,
      reason: 'VELUM_ENGINE_ERROR',
      // The name and message of a typed engine error. Never any content: an
      // exception raised while inspecting hostile text must not become a way to
      // get that text into a log.
      detail: `${e.name}: ${e.message}`,
    } satisfies ScanResponse);
  }
});

function digestOf(job: ScanJob): string {
  const h = createHash('sha256');
  if (job.kind === 'model-output') {
    h.update(job.text, 'utf8');
  } else {
    for (const m of job.messages) h.update(m.content, 'utf8');
    for (const e of job.evidence) { h.update(e.id, 'utf8'); h.update(e.content, 'utf8'); }
  }
  return `sha256:${h.digest('hex')}`;
}

/** Bound what one packet may carry back. The engine caps the rest. */
function capPacket<T extends { readonly findings: readonly unknown[] }>(p: T): T {
  return p.findings.length <= MAX_RESULT_FINDINGS
    ? p
    : { ...p, findings: p.findings.slice(0, MAX_RESULT_FINDINGS) };
}
