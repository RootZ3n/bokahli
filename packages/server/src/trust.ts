/**
 * Bokahli — the trust boundary.
 * ===========================================================================
 * One function decides what the model is allowed to read, and it is
 * `admitRequest`. Everything about prompt-injection defence in Bokahli happens
 * here: zone assignment, detection, fencing, policy, and the telemetry that
 * says what happened. There are no regex checks in the HTTP handlers, no
 * detector calls in the router, and no second opinion anywhere. A boundary that
 * exists in several places is not a boundary.
 *
 * ## The shape of the decision
 *
 * A request arrives as instructions plus, optionally, evidence. They are not
 * the same kind of thing and the difference is not in the bytes:
 *
 *   - **Instructions** come from an authenticated speaker — the operator at the
 *     chat surface, or a client holding the token. Imperative language here is
 *     a person giving an instruction. It is recorded and it is *not refused*.
 *     "Ignore the previous file and use the second one" is a request.
 *
 *   - **Evidence** is a log, a file, a document. Imperative language here is an
 *     attack, because nothing in the channel had the standing to instruct. It
 *     is scanned, it is fenced, and in enforce mode a block-severity finding
 *     stops the request.
 *
 * ## Fencing does not depend on detection
 *
 * Evidence is fenced whether or not a pattern matched. The detector is a
 * forty-five pattern registry against an attacker with a keyboard; assuming it
 * catches everything is the assumption that makes a miss catastrophic instead
 * of merely a miss. The structural boundary — a delimiter the content cannot
 * forge, and a header saying what the reader is looking at — costs nothing on a
 * clean document and is the only thing standing up when the registry is wrong.
 *
 * ## Raw evidence is immutable
 *
 * The bytes the caller sent are kept exactly, beside the rendering the model
 * saw, and a finding's span is into the raw. That is what makes a citation
 * checkable: an operator can resolve `startByte..endByte` against the file they
 * already have. Nothing here rewrites, redacts or normalises the caller's
 * evidence — the normalised form exists only inside the detector, and a finding
 * discovered in decoded material reports the *encoded* range rather than a
 * fabricated offset into text that never existed on disk.
 *
 * ## What this boundary may not do
 *
 * It does not route. It does not qualify. It does not touch tokenizer
 * provenance, model identity, or import trust. `AUTO`, `PROFILE` and `EXACT`
 * mean exactly what they meant before this file existed, and a Velum finding
 * cannot change which artifact serves a request or whether Luak's evidence is
 * believed. Detection is evidence about content; those are decisions about
 * infrastructure, and they have their own proofs.
 */
import { createHash } from 'node:crypto';
import type {
  BokahliChatMessage,
  BokahliTrustZone,
  VelumFindingCategory,
  VelumFindingSeverity,
  VelumFindingSummary,
  VelumPacketReport,
  VelumPolicyDecision,
  VelumTelemetry,
} from '@bokahli/contracts';
import { VELUM_BOUNDARY_VERSION } from '@bokahli/contracts';
import {
  Detector, MatchLimitExceeded, NormalizeLimitExceeded, FenceLimitExceeded,
  neutralize, resolveToRendered, toUtf8, VELUM_ENGINE,
  type Detection, type NeutralizedContent, type VelumFindingRecord,
} from '@bokahli/velum';
import type { AuthSource } from './auth.js';

/** How the boundary behaves. `enforce` is the default; `off` is still recorded. */
export type TrustMode = 'off' | 'audit' | 'enforce';

export function isTrustMode(v: unknown): v is TrustMode {
  return v === 'off' || v === 'audit' || v === 'enforce';
}

/** One piece of caller-supplied evidence. */
export interface EvidenceItem {
  /** The caller's identity for it. Appears in the fence header and telemetry. */
  readonly id: string;
  readonly content: string;
}

export interface AdmitRequestInput {
  readonly requestId: string;
  /**
   * How the request authenticated.
   *
   * A cookie or a bootstrap query parameter means a browser session, which
   * means a human at Bokahli's own surface. A bearer header means a program.
   * Both are trusted speakers; the distinction is reported, not enforced.
   */
  readonly authSource: AuthSource;
  readonly messages: readonly BokahliChatMessage[];
  readonly evidence: readonly EvidenceItem[];
  readonly mode: TrustMode;
}

/**
 * Evidence as it was admitted: the caller's bytes, and what the model saw.
 *
 * Held so a citation can be checked after the fact. `raw` is never modified.
 */
export interface AdmittedEvidence {
  readonly id: string;
  readonly raw: Uint8Array;
  /** Digest of `raw`. What a finding's own binding is checked against. */
  readonly rawContentSha256: string;
  readonly rendered: NeutralizedContent;
}

export type AdmitOutcome =
  | {
    readonly kind: 'ADMITTED';
    /** The messages to send onward, with evidence fenced. */
    readonly messages: readonly BokahliChatMessage[];
    readonly evidence: readonly AdmittedEvidence[];
    readonly telemetry: VelumTelemetry;
  }
  | {
    readonly kind: 'BLOCKED';
    readonly telemetry: VelumTelemetry;
    /** Which evidence item, and at what severity. Never the matched text. */
    readonly reason: string;
  }
  | {
    /**
     * Bokahli could not answer safely.
     *
     * A resource ceiling, a mapping failure, an engine error. Not a verdict
     * about the content: a statement that no verdict was reached. The caller
     * gets a typed escalation rather than a request that quietly skipped
     * inspection.
     */
    readonly kind: 'ESCALATE';
    readonly telemetry: VelumTelemetry | null;
    readonly reason: 'VELUM_RESOURCE_LIMIT' | 'VELUM_MAPPING_FAILURE' | 'VELUM_ENGINE_ERROR';
    readonly detail: string;
  };

/**
 * The engine identity, for telemetry.
 *
 * Re-exported through this module rather than imported from the vendored
 * package directly, so `trust.ts` stays the only file in Bokahli that reaches
 * the detector. A second import site is a second boundary, whatever it is used
 * for.
 */
export function engineIdentity(): typeof VELUM_ENGINE {
  return VELUM_ENGINE;
}

const sha256 = (b: Uint8Array): string => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/**
 * The detector, compiled once.
 *
 * Compilation validates the whole registry, so a broken one is a startup
 * failure rather than a first-request failure. The aggregate step ceiling is
 * left at the engine's default: it bounds a whole scan across all forty-five
 * patterns, which is the number that matters when an attacker controls how much
 * evidence to send.
 */
let detector: Detector | null = null;
function sharedDetector(): Detector {
  detector ??= Detector.mvp();
  return detector;
}

/** Zone for a caller-supplied message. Never `system-policy`. */
function zoneForMessage(authSource: AuthSource): BokahliTrustZone {
  // A `role: "system"` message in a request body is a client's own text. Calling
  // it `system-policy` would let any authenticated caller relabel its input as
  // Bokahli's scaffolding, and `system-policy` is the one zone never scanned.
  return authSource === 'header' ? 'client-instruction' : 'operator-instruction';
}

function summarise(records: readonly VelumFindingRecord[]): readonly VelumFindingSummary[] {
  return records.map((r) => ({
    patternId: r.patternId,
    contentSha256: r.contentSha256,
    category: r.category as VelumFindingCategory,
    severity: r.severity as VelumFindingSeverity,
    sourceSpan: r.sourceSpan === null ? null : { startByte: r.sourceSpan.startByte, endByte: r.sourceSpan.endByte },
    spanAbsentReason: r.spanAbsentReason,
    fidelity: r.sourceFidelity,
    derivedFrom: r.derivedFrom,
  }));
}

function decisionFor(zone: BokahliTrustZone, detection: Detection | null, mode: TrustMode): {
  readonly decision: VelumPolicyDecision;
  readonly rationale: string;
} {
  if (mode === 'off' || detection === null) {
    return { decision: 'allow', rationale: 'inspection did not run' };
  }
  if (detection.findings.isEmpty) return { decision: 'allow', rationale: 'no detector finding' };

  const peak = detection.peakSeverity;
  if (zone === 'operator-instruction' || zone === 'client-instruction') {
    // A trusted speaker using imperative language is not an injection. The
    // finding is still recorded — an operator may want to know that a request
    // asked for the system prompt — but the request is not refused for it.
    const credential = detection.records.some((r) => r.category === 'credential');
    return {
      decision: credential ? 'warn' : 'allow',
      rationale: credential
        ? 'a credential pattern matched in a trusted-speaker zone; recorded, not refused'
        : `findings in a ${zone} zone are the speaker's own instructions, not injected ones`,
    };
  }

  const raw: VelumPolicyDecision = peak === 'block' ? 'block' : peak === 'review' ? 'review' : peak === 'warn' ? 'warn' : 'allow';
  if (mode === 'audit') {
    return {
      decision: raw === 'block' ? 'review' : raw,
      rationale: `audit mode: ${detection.findings.findings.length} finding(s) in ${zone}, execution preserved`,
    };
  }
  return {
    decision: raw,
    rationale: `enforce mode: ${detection.primaryCategory} at severity ${String(peak)} in a ${zone} zone`,
  };
}

/**
 * Inspect a request and decide what the model may read.
 *
 * The only entry point. Synchronous and deterministic: no clock, no network, no
 * inference.
 */
export function admitRequest(input: AdmitRequestInput): AdmitOutcome {
  const { mode } = input;
  const packets: VelumPacketReport[] = [];
  const admitted: AdmittedEvidence[] = [];
  let steps = 0;
  let overall: VelumPolicyDecision = 'allow';
  const rank: Record<VelumPolicyDecision, number> = { allow: 0, warn: 1, review: 2, block: 3 };
  const raise = (d: VelumPolicyDecision): void => { if (rank[d] > rank[overall]) overall = d; };

  const det = sharedDetector();
  let blocked: string | null = null;

  try {
    // ── instructions ────────────────────────────────────────────────────────
    const zone = zoneForMessage(input.authSource);
    for (let i = 0; i < input.messages.length; i++) {
      const m = input.messages[i] as BokahliChatMessage;
      const bytes = toUtf8(m.content);
      const detection = mode === 'off' ? null : det.scan(bytes);
      if (detection !== null) steps += detection.steps;
      const { decision, rationale } = decisionFor(zone, detection, mode);
      raise(decision);
      packets.push(packetFor(`message[${i}].${m.role}`, zone, bytes, detection, decision, rationale, mode === 'off' ? false : true, null, 'passed'));
    }

    // ── evidence ────────────────────────────────────────────────────────────
    for (const item of input.evidence) {
      const bytes = toUtf8(item.content);
      const detection = mode === 'off' ? null : det.scan(bytes);
      if (detection !== null) steps += detection.steps;
      const { decision, rationale } = decisionFor('evidence', detection, mode);
      raise(decision);

      // Fenced regardless of the verdict, and regardless of the mode being
      // `audit`. `off` is the only state in which no boundary is applied, and
      // it is recorded as such rather than looking like a clean scan.
      const rendered = mode === 'off' ? null : neutralize(bytes, { sourceId: item.id, zoneLabel: 'untrusted-evidence' });
      const isBlocked = mode === 'enforce' && decision === 'block';
      if (isBlocked && blocked === null) {
        blocked = `evidence ${JSON.stringify(item.id)} carries a block-severity ${detection?.primaryCategory ?? 'finding'}`;
      }
      packets.push(packetFor(
        item.id, 'evidence', bytes, detection, decision, rationale,
        mode !== 'off', rendered, isBlocked ? 'blocked' : rendered === null ? 'passed' : 'fenced',
      ));
      if (rendered !== null) {
        admitted.push({ id: item.id, raw: bytes, rawContentSha256: sha256(bytes), rendered });
      }
    }
  } catch (err) {
    return escalationFor(err, mode, steps);
  }

  const telemetry = telemetryFor(mode, packets, overall, steps);
  if (blocked !== null) return { kind: 'BLOCKED', telemetry, reason: blocked };

  // The fenced evidence goes to the model as user-channel content. Not a
  // `system` message: elevating untrusted bytes into the channel the model
  // treats as its own operating instructions is the exact move the fence exists
  // to prevent.
  const messages: BokahliChatMessage[] = [...input.messages];
  for (const e of admitted) messages.push({ role: 'user', content: e.rendered.rendered });

  return { kind: 'ADMITTED', messages, evidence: admitted, telemetry };
}

function packetFor(
  id: string,
  zone: BokahliTrustZone,
  raw: Uint8Array,
  detection: Detection | null,
  decision: VelumPolicyDecision,
  rationale: string,
  scanned: boolean,
  rendered: NeutralizedContent | null,
  disposition: VelumPacketReport['disposition'],
): VelumPacketReport {
  const findings = detection === null ? [] : summarise(detection.records);
  return {
    id,
    zone,
    scanned,
    rawContentSha256: sha256(raw),
    renderedContentSha256: rendered === null ? null : rendered.renderedContentHash,
    findingCount: findings.length,
    categories: [...new Set(findings.map((f) => f.category))],
    severities: [...new Set(findings.map((f) => f.severity))],
    peakSeverity: (detection?.peakSeverity ?? null) as VelumFindingSeverity | null,
    findings,
    decision,
    disposition,
    rationale,
  };
}

function telemetryFor(
  mode: TrustMode,
  packets: readonly VelumPacketReport[],
  decision: VelumPolicyDecision,
  steps: number,
): VelumTelemetry {
  const scannedAll = packets.every((p) => p.scanned);
  const clean = packets.every((p) => p.scanned && p.findingCount === 0);
  return {
    boundaryVersion: VELUM_BOUNDARY_VERSION,
    detectorVersion: VELUM_ENGINE.detectorVersion,
    registryVersion: VELUM_ENGINE.registryVersion,
    registryPayloadSha256: VELUM_ENGINE.registryPayloadSha256,
    fenceVersion: VELUM_ENGINE.fenceVersion,
    normalizationVersion: VELUM_ENGINE.normalizationVersion,
    mode,
    packets,
    decision,
    clean,
    scannedAll,
    steps,
    receipt:
      `velum ${VELUM_ENGINE.detectorVersion} mode=${mode} packets=${packets.length} ` +
      `scanned=${packets.filter((p) => p.scanned).length} ` +
      `fenced=${packets.filter((p) => p.disposition === 'fenced').length} ` +
      `decision=${decision} clean=${clean}`,
  };
}

function escalationFor(err: unknown, mode: TrustMode, steps: number): AdmitOutcome {
  const e = err as Error;
  const reason =
    e instanceof MatchLimitExceeded || e instanceof NormalizeLimitExceeded || e instanceof FenceLimitExceeded
      ? 'VELUM_RESOURCE_LIMIT'
      : 'VELUM_ENGINE_ERROR';
  return {
    kind: 'ESCALATE',
    // No telemetry block: a partial inspection is not an inspection, and
    // publishing half a report invites a consumer to read it as a whole one.
    telemetry: null,
    reason,
    detail: `${e.name}: ${e.message} (after ${steps} VM steps, mode ${mode})`,
  };
}

/**
 * Inspect a model completion.
 *
 * Separate from `admitRequest` because it answers a different question and has
 * a different consequence. Findings here are telemetry and, under an explicit
 * policy, grounds for escalation — they are **never** grounds for rewriting the
 * completion. Silently editing model output would make every downstream measure
 * of that model a measure of Bokahli's editor instead, and Luak's whole purpose
 * is measuring the model.
 */
export function inspectModelOutput(id: string, content: string, mode: TrustMode): {
  readonly packet: VelumPacketReport | null;
  readonly telemetry: VelumTelemetry | null;
} {
  if (mode === 'off') return { packet: null, telemetry: null };
  const bytes = toUtf8(content);
  let detection: Detection;
  try {
    detection = sharedDetector().scan(bytes);
  } catch {
    // Model output is inspected for observation, so a ceiling here degrades to
    // "not inspected" rather than failing a completed request. The request's
    // own evidence was already inspected before any of it reached the model.
    return { packet: null, telemetry: null };
  }
  const { decision, rationale } = decisionFor('model-output', detection, mode);
  const packet = packetFor(id, 'model-output', bytes, detection, decision, rationale, true, null, 'passed');
  return { packet, telemetry: telemetryFor(mode, [packet], decision, detection.steps) };
}

/**
 * Where a finding sits in the evidence, and where the model saw it.
 *
 * Returns null when the finding does not belong to this evidence item — the
 * engine binds a finding to a digest of the bytes it was found in, so a span
 * from one document cannot be resolved against another's map.
 */
export function citationFor(evidence: AdmittedEvidence, finding: VelumFindingSummary): {
  readonly raw: { readonly startByte: number; readonly endByte: number };
  readonly rendered: { readonly startByte: number; readonly endByte: number } | null;
} | null {
  // The binding travels with the finding, so a span lifted out of one document
  // cannot be resolved against another. Without this the helper happily
  // reported where 253..278 fell in an unrelated file.
  if (finding.contentSha256 !== evidence.rawContentSha256) return null;
  if (finding.sourceSpan === null) return null;
  const fwd = resolveToRendered(evidence.rendered.map, finding.sourceSpan);
  return {
    raw: finding.sourceSpan,
    rendered: fwd.ok && fwd.raw !== null ? { startByte: fwd.raw.startByte, endByte: fwd.raw.endByte } : null,
  };
}
