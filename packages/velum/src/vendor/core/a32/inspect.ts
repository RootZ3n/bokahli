/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/a32/inspect.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — the injection-only inspection API.
 * ============================================================
 * The entry point a host calls. It is deliberately **not** the three-stage
 * guard in `core/guard.ts`: that one is a privacy-and-injection middleware
 * whose result is a single `allow | warn | review | block` decision with an
 * optional redacted string. This one detects injection, decides policy, and
 * returns evidence — and it never redacts.
 *
 * ## The caller supplies trust; Velum never guesses it
 *
 * Velum scans strings. Who wrote a string is not a property of the string, and
 * every attempt to infer it ends in the same failure: a user saying "ignore the
 * previous file and look at the second one" is making a request, and the same
 * words inside a log the user asked to have triaged are an attack. The words
 * are identical. The difference is provenance, and provenance is the host's
 * knowledge.
 *
 * So `TrustZone` is an input. Imperative language in `human-instruction` is a
 * human giving an instruction; imperative language in `untrusted-evidence` is
 * an injection. Velum applies the same detector to both and lets policy differ.
 *
 * ## Fencing does not depend on detection
 *
 * Untrusted zones are fenced whether or not a pattern matched, following the
 * ABAIYA rule that a detector miss must not silently disable the boundary.
 */
import { createHash } from "node:crypto";
import { toUtf8, type ByteSpan } from "../bytes.js";
import { Detector, DETECTOR_VERSION, type Detection, type VelumFindingRecord } from "./detect.js";
import { REGISTRY_VERSION } from "./registry.js";
import { neutralize, resolveToRendered, type NeutralizedContent } from "./fence.js";
import type { PolicyDecision, TransformationApplied, VelumCategory, VelumSeverity } from "./categories.js";

export const INSPECTION_CONTRACT_VERSION = "velum.inspection.v1" as const;

/** Where a piece of content came from. Supplied by the host, never inferred. */
export type TrustZone =
  /** Velum's or the host's own scaffolding. Never scanned. */
  | "system"
  /** The calling application's task instruction. Trusted by configuration. */
  | "caller-instruction"
  /** A human typing. Instructions here are requests, not injections. */
  | "human-instruction"
  /** Logs, files, README text, retrieved pages. The primary target. */
  | "untrusted-evidence"
  /** Anything a tool returned. Untrusted as evidence is. */
  | "tool-output"
  /** A model completion, inspected for injection-induced violation. */
  | "model-output";

export const UNTRUSTED_ZONES: readonly TrustZone[] = Object.freeze([
  "untrusted-evidence", "tool-output", "model-output",
]);

export type PolicyMode = "off" | "audit" | "enforce";

/** Where the inspected content is heading. */
export type Destination = "model-prompt" | "tool-call" | "user-display" | "storage";

export interface InspectionPacket {
  /** Caller's identity for this item. Appears in receipts and in the fence. */
  readonly id: string;
  readonly zone: TrustZone;
  /** The exact bytes. Velum never modifies them. */
  readonly content: Uint8Array | string;
  readonly destination: Destination;
}

export interface InspectionOptions {
  readonly mode?: PolicyMode;
  readonly detector?: Detector;
  /** Fence untrusted zones even in `audit`. Default true. */
  readonly fence?: boolean;
}

export interface PacketResult {
  readonly id: string;
  readonly zone: TrustZone;
  readonly destination: Destination;
  readonly rawContentHash: string;
  /** Layer A — what was found. */
  readonly findings: readonly VelumFindingRecord[];
  readonly primaryCategory: VelumCategory;
  readonly peakSeverity: VelumSeverity | null;
  /** Layer B — what policy decided. */
  readonly decision: PolicyDecision;
  /** Layer C — what was done to the bytes. */
  readonly transformation: TransformationApplied;
  /** Present when the packet was fenced. Carries the transformation map. */
  readonly fenced: NeutralizedContent | null;
  /** Why the decision is what it is. Never quotes matched content. */
  readonly rationale: string;
  readonly scanned: boolean;
  readonly steps: number;
}

export interface InspectionResult {
  readonly contractVersion: typeof INSPECTION_CONTRACT_VERSION;
  readonly detectorVersion: string;
  readonly registryVersion: string;
  readonly mode: PolicyMode;
  readonly packets: readonly PacketResult[];
  /** The strongest decision across every packet. */
  readonly decision: PolicyDecision;
  /**
   * True when every packet was scanned and none produced a finding.
   *
   * `false` when anything was skipped, which `mode: "off"` always is. It used
   * to be `results.every(r => r.findings.length === 0)`, and an unscanned
   * packet has no findings — so turning inspection off reported every document
   * in the system as clean. `scannedAll` says which of the two `false` means.
   */
  readonly clean: boolean;
  /** Whether every packet was actually inspected. */
  readonly scannedAll: boolean;
  readonly observedAt: string;
  /**
   * A receipt line for every mode, `off` included.
   *
   * `off` must be observable. A bypass that looks like a system where nobody
   * wired Velum up is a bypass nobody can audit, so the result still exists,
   * still names the mode, and still records what was not scanned.
   */
  readonly receipt: string;
}

function severityToDecision(s: VelumSeverity | null): PolicyDecision {
  switch (s) {
    case "block": return "block";
    case "review": return "review";
    case "warn": return "warn";
    case null: return "allow";
    default:
      // Not reachable: `VelumFindingSet` refuses a severity outside the
      // vocabulary, so `peakSeverity` is one of the three or null. It used to
      // be reachable, and the arm read `default: return "allow"` — so a finding
      // marked with any unrecognised severity became the peak of its set and
      // then became permission. Fail closed on the way out as well as on the
      // way in.
      return "block";
  }
}

/** Zones the host has named. Anything else is not a zone Velum knows. */
const KNOWN_ZONES: readonly TrustZone[] = Object.freeze([
  "system", "caller-instruction", "human-instruction",
  "untrusted-evidence", "tool-output", "model-output",
]);

export function isTrustZone(z: unknown): z is TrustZone {
  return typeof z === "string" && (KNOWN_ZONES as readonly string[]).includes(z);
}

/**
 * Is this zone one whose content is data rather than instruction?
 *
 * An unrecognised zone answers **yes**. `UNTRUSTED_ZONES.includes(zone)` used to
 * answer the question, and for a zone nobody had added to that array it
 * answered "no" — so a packet labelled `retrieved-document` or `rag` was
 * scanned, was decided as untrusted, and was then handed to the model with no
 * fence at all. The structural boundary disappeared for exactly the zones a
 * future integrator would invent. A label Velum does not recognise is not a
 * promise of trust.
 */
function isUntrustedZone(zone: TrustZone): boolean {
  if (!isTrustZone(zone)) return true;
  return UNTRUSTED_ZONES.includes(zone);
}

const DECISION_RANK: Record<PolicyDecision, number> = { allow: 0, warn: 1, review: 2, block: 3 };

function strongest(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

/**
 * Decide policy for one packet.
 *
 * The zone is what makes the same finding mean different things. An
 * `instruction-override` inside evidence is an attack on the host; the same
 * pattern in a human's own message is that human giving an instruction, which
 * is recorded and not refused. Nothing here deletes or rewrites content.
 */
function decideFor(
  zone: TrustZone,
  detection: Detection | null,
  mode: PolicyMode,
): { readonly decision: PolicyDecision; readonly rationale: string } {
  if (mode === "off") {
    return { decision: "allow", rationale: "policy mode is off; no inspection was performed" };
  }
  if (detection === null || detection.findings.isEmpty) {
    return { decision: "allow", rationale: "no detector finding" };
  }

  const severity = detection.peakSeverity;
  const raw = severityToDecision(severity);

  if (isTrustZone(zone) && (zone === "human-instruction" || zone === "caller-instruction")) {
    // A trusted speaker using imperative language is not an injection. The
    // finding is still recorded — an operator may want to know a user asked to
    // have the system prompt revealed — but it does not refuse the request.
    const credential = detection.records.some((r) => r.category === "credential");
    return {
      decision: credential ? "warn" : "allow",
      rationale: credential
        ? "a credential pattern matched in a trusted-speaker zone; recorded, not refused"
        : `findings in a ${zone} zone are the speaker's own instructions, not injected ones`,
    };
  }

  if (mode === "audit") {
    return {
      decision: raw === "block" ? "review" : raw,
      rationale: `audit mode: ${detection.findings.findings.length} finding(s), execution preserved`,
    };
  }

  return {
    decision: raw,
    rationale:
      `enforce mode: ${detection.primaryCategory} at severity ${String(severity)} in a ` +
      `${zone} zone`,
  };
}

/**
 * Inspect a set of packets.
 *
 * Synchronous, deterministic, and free of any privacy transformation: nothing
 * in this path masks, redacts, normalizes away, or drops caller content.
 */
export function inspect(
  packets: readonly InspectionPacket[],
  opts: InspectionOptions = {},
): InspectionResult {
  const mode = opts.mode ?? "enforce";
  const detector = opts.detector ?? Detector.mvp();
  const doFence = opts.fence ?? true;
  const results: PacketResult[] = [];
  let overall: PolicyDecision = "allow";

  for (const p of packets) {
    const bytes = typeof p.content === "string" ? toUtf8(p.content) : p.content;
    // `system` is Velum's own scaffolding and is never scanned. An unrecognised
    // zone is scanned: not scanning it would be a trust decision made by a
    // typo.
    const scannable = mode !== "off" && !(isTrustZone(p.zone) && p.zone === "system");
    const detection = scannable ? detector.scan(bytes) : null;
    const { decision, rationale } = decideFor(p.zone, detection, mode);

    const shouldFence =
      doFence && mode !== "off" && isUntrustedZone(p.zone) && p.destination === "model-prompt";
    const fenced = shouldFence
      ? neutralize(bytes, { sourceId: p.id, zoneLabel: p.zone })
      : null;

    results.push({
      id: p.id,
      zone: p.zone,
      destination: p.destination,
      rawContentHash: fenced?.rawContentHash ?? hashOf(bytes),
      findings: detection?.records ?? [],
      primaryCategory: detection?.primaryCategory ?? "safe",
      peakSeverity: detection?.peakSeverity ?? null,
      decision,
      transformation: fenced === null ? "unchanged" : "fenced",
      fenced,
      rationale,
      scanned: scannable,
      steps: detection?.steps ?? 0,
    });
    overall = strongest(overall, decision);
  }

  return {
    contractVersion: INSPECTION_CONTRACT_VERSION,
    detectorVersion: DETECTOR_VERSION,
    registryVersion: REGISTRY_VERSION,
    mode,
    packets: Object.freeze(results),
    decision: overall,
    clean: results.every((r) => r.scanned && r.findings.length === 0),
    scannedAll: results.every((r) => r.scanned),
    observedAt: new Date().toISOString(),
    receipt:
      `velum ${INSPECTION_CONTRACT_VERSION} mode=${mode} packets=${results.length} ` +
      `scanned=${results.filter((r) => r.scanned).length} fenced=${results.filter((r) => r.fenced !== null).length} ` +
      `decision=${overall} clean=${results.every((r) => r.scanned && r.findings.length === 0)}`,
  };
}

function hashOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Resolve a finding back to the caller's raw bytes through a fence.
 *
 * The citation path: a finding carries a source span into the raw evidence, and
 * a fenced packet carries a map. This confirms the two agree, so a consumer can
 * quote the original bytes for a span the model saw inside a fence.
 */
export function citationFor(
  packet: PacketResult,
  finding: VelumFindingRecord,
): {
  readonly raw: ByteSpan | null;
  /** The same region as the model saw it, when the packet was fenced. */
  readonly rendered: ByteSpan | null;
  readonly reason: string | null;
} {
  // A span is only meaningful against the bytes it came from. Without this
  // check a finding discovered in one document resolved cleanly against
  // another's map — `ok`, no reason, a rendered range — and quoted whatever
  // happened to sit at those offsets in the wrong file.
  if (finding.contentSha256 !== packet.rawContentHash) {
    return { raw: null, rendered: null, reason: "finding-belongs-to-other-content" };
  }
  if (finding.sourceSpan === null) {
    return { raw: null, rendered: null, reason: finding.spanAbsentReason ?? "no source span" };
  }
  if (packet.fenced === null) {
    return { raw: finding.sourceSpan, rendered: null, reason: null };
  }
  // Findings already carry raw coordinates. The map answers the other half:
  // where the model saw those bytes, so a reviewer can line up the fenced
  // rendering against the original evidence.
  const fwd = resolveToRendered(packet.fenced.map, finding.sourceSpan);
  return {
    raw: finding.sourceSpan,
    rendered: fwd.ok ? fwd.raw : null,
    reason: fwd.ok ? null : fwd.failure,
  };
}
