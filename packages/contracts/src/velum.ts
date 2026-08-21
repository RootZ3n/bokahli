/**
 * Bokahli — the trust-boundary contract.
 * ===========================================================================
 * What Bokahli publishes about prompt-injection inspection: which zone a piece
 * of content was in, what the detector found, what policy decided, and what was
 * done to the bytes on the way to the model.
 *
 * ## Zones are declared, never inferred
 *
 * Velum's own documentation makes the point and it is worth repeating at this
 * boundary, because this is where it is decided: who wrote a string is not a
 * property of the string. "Ignore the previous file and look at the second one"
 * is a request when the operator types it and an attack when it appears in a
 * log the operator asked to have triaged. The words are identical. Bokahli
 * knows which is which because it knows which channel the bytes arrived on, and
 * that knowledge is the whole boundary.
 *
 * So a zone is assigned from the transport, once, at the edge — and never from
 * the content, and never from a field the content could contain.
 *
 * ## `role: "system"` in a request body is not system policy
 *
 * The most tempting mistake available here. An OpenAI-dialect request carries
 * `{"role": "system", "content": "..."}`, and calling that zone `system-policy`
 * would let any authenticated client relabel its own text as Bokahli's
 * scaffolding — and `system-policy` is the one zone that is never scanned.
 * Client-supplied system messages are `client-instruction`. `system-policy`
 * means text Bokahli itself wrote, and nothing that crosses the network can
 * enter it.
 *
 * ## What this layer may not do
 *
 * Detection is evidence, not authority. Nothing here routes, and nothing here
 * qualifies: a `VelumTelemetry` block cannot change which model serves a
 * request, cannot alter tokenizer provenance, cannot make an unqualified
 * artifact qualified, and cannot make imported Luak evidence trusted. Those
 * decisions have their own contracts and their own proofs, and a detector that
 * could reach them would be a second authority answering questions it has no
 * evidence about.
 */

/**
 * Where a piece of content came from, in Bokahli's terms.
 *
 * Seven zones, and the mapping onto Velum's own vocabulary is one-way and
 * total. Two of them do not correspond to anything Velum scans:
 * `system-policy`, which is Bokahli's own text, and `qualification-metadata`,
 * which is strict typed data with its own validator and is deliberately kept
 * away from a text detector entirely.
 */
export type BokahliTrustZone =
  /**
   * A human at Bokahli's own chat surface.
   *
   * Distinguished from `client-instruction` by how the request authenticated:
   * a browser session carries the token in a cookie, a programmatic client
   * sends a bearer header. Both are trusted speakers; the distinction exists so
   * telemetry can say which, not so policy can treat them differently.
   */
  | 'operator-instruction'
  /** An authenticated program's task instruction, including its own `system` messages. */
  | 'client-instruction'
  /** Repository text, logs, documents. Data to be described, never obeyed. */
  | 'evidence'
  /** Anything a tool or retrieval step returned. Untrusted exactly as evidence is. */
  | 'tool-output'
  /** A model completion, inspected for injection-induced violation. */
  | 'model-output'
  /** Bokahli's own scaffolding. Never scanned, and unreachable from the network. */
  | 'system-policy'
  /** Luak bundles and operational metadata. Typed data; never sent to the detector. */
  | 'qualification-metadata';

export const BOKAHLI_TRUST_ZONES: readonly BokahliTrustZone[] = Object.freeze([
  'operator-instruction', 'client-instruction', 'evidence', 'tool-output',
  'model-output', 'system-policy', 'qualification-metadata',
]);

/** Zones whose content is data rather than instruction. */
export const BOKAHLI_UNTRUSTED_ZONES: readonly BokahliTrustZone[] = Object.freeze([
  'evidence', 'tool-output', 'model-output',
]);

export function isBokahliTrustZone(v: unknown): v is BokahliTrustZone {
  return typeof v === 'string' && (BOKAHLI_TRUST_ZONES as readonly string[]).includes(v);
}

/** What the detector reported. Velum's Layer A, carried verbatim. */
export type VelumFindingCategory =
  | 'credential' | 'prompt-injection' | 'instruction-override'
  | 'memory-manipulation' | 'boundary-probe';

export const VELUM_FINDING_CATEGORIES: readonly VelumFindingCategory[] = Object.freeze([
  'credential', 'prompt-injection', 'instruction-override',
  'memory-manipulation', 'boundary-probe',
]);

export type VelumFindingSeverity = 'warn' | 'review' | 'block';

export const VELUM_FINDING_SEVERITIES: readonly VelumFindingSeverity[] = Object.freeze([
  'warn', 'review', 'block',
]);

/** What Bokahli decided. Velum's Layer B, plus Bokahli's own terminal outcome. */
export type VelumPolicyDecision = 'allow' | 'warn' | 'review' | 'block';

export const VELUM_POLICY_DECISIONS: readonly VelumPolicyDecision[] = Object.freeze([
  'allow', 'warn', 'review', 'block',
]);

/**
 * What actually happened to the content.
 *
 * `passed` and `fenced` are the ordinary outcomes. `blocked` means the content
 * never reached the model. `escalated` means Bokahli could not answer safely —
 * a mapping failure, a resource ceiling, a detector error — and returned a
 * typed escalation instead of guessing.
 *
 * There is no `redacted`. Bokahli does not redact: the raw bytes a citation
 * resolves against have to keep existing, and a local single-operator system
 * has no third party whose data would need masking.
 */
export type VelumDisposition = 'passed' | 'fenced' | 'blocked' | 'escalated';

export const VELUM_DISPOSITIONS: readonly VelumDisposition[] = Object.freeze([
  'passed', 'fenced', 'blocked', 'escalated',
]);

/**
 * One finding, as Bokahli publishes it.
 *
 * Never carries matched content. For a credential pattern the matched value is
 * the secret; for an injection pattern it is attacker-chosen text that would be
 * going straight into a log. The span is enough for an operator to find it in
 * the evidence they already have.
 */
export interface VelumFindingSummary {
  readonly patternId: string;
  readonly category: VelumFindingCategory;
  readonly severity: VelumFindingSeverity;
  /**
   * Digest of the bytes this finding was found in.
   *
   * Redundant with the enclosing packet's `rawContentSha256`, and deliberately
   * so: a finding gets lifted out of its packet — into a log line, a dashboard
   * row, a follow-up call — and a span with no idea which document it indexes
   * resolves cleanly against the wrong one. Velum's own audit found exactly
   * that: a span of 7..39 discovered in one file resolved against another and
   * quoted whatever sat at those offsets, with no error. The binding travels
   * with the span.
   */
  readonly contentSha256: string;
  /**
   * Byte range in the caller's raw evidence, or null.
   *
   * Null for credential findings, where a span plus the source is the secret,
   * and for material whose provenance is not resolvable. `spanAbsentReason`
   * says which.
   */
  readonly sourceSpan: { readonly startByte: number; readonly endByte: number } | null;
  readonly spanAbsentReason: 'credential-suppressed' | 'derived-region' | 'unmappable' | null;
  /**
   * How the span relates to what matched.
   *
   * `derived` means the pattern matched inside decoded material — base64, say —
   * and the span names the *encoded* run in the caller's bytes rather than a
   * fabricated offset into text that only exists after decoding.
   */
  readonly fidelity: 'exact' | 'derived' | 'deletion' | 'unavailable';
  readonly derivedFrom: string | null;
}

/** One inspected item: what it was, what was found, what was done. */
export interface VelumPacketReport {
  /** Bokahli's identity for this item. Never the content. */
  readonly id: string;
  readonly zone: BokahliTrustZone;
  readonly scanned: boolean;
  /** sha256 of the exact raw bytes. Binds every span below to the right content. */
  readonly rawContentSha256: string;
  /** sha256 of the model-facing bytes, when the item was transformed. */
  readonly renderedContentSha256: string | null;
  readonly findingCount: number;
  readonly categories: readonly VelumFindingCategory[];
  readonly severities: readonly VelumFindingSeverity[];
  readonly peakSeverity: VelumFindingSeverity | null;
  readonly findings: readonly VelumFindingSummary[];
  readonly decision: VelumPolicyDecision;
  readonly disposition: VelumDisposition;
  /** Why, in one line. Never quotes what matched. */
  readonly rationale: string;
}

/**
 * The whole inspection, as it appears on a response and in telemetry.
 *
 * Additive: every existing B2 field keeps its meaning and its type, and a
 * consumer that does not read this one is unaffected. It is nullable because
 * inspection can be off, and a null that means "not inspected" is honest where
 * an empty report would read as "inspected, nothing found".
 */
export interface VelumTelemetry {
  /** Bokahli's own boundary version, distinct from the engine's. */
  readonly boundaryVersion: string;
  readonly detectorVersion: string;
  readonly registryVersion: string;
  /** Velum's digest over its pattern rows. The engine's real identity. */
  readonly registryPayloadSha256: string;
  readonly fenceVersion: string;
  readonly normalizationVersion: string;
  readonly mode: 'off' | 'audit' | 'enforce';
  readonly packets: readonly VelumPacketReport[];
  /** The strongest decision across every packet. */
  readonly decision: VelumPolicyDecision;
  /** True only when every packet was scanned and none produced a finding. */
  readonly clean: boolean;
  /** False when anything was skipped, which `mode: "off"` always is. */
  readonly scannedAll: boolean;
  /** VM steps spent. Cost is published, not assumed. */
  readonly steps: number;
  /** A one-line receipt, present in every mode including `off`. */
  readonly receipt: string;
}

export const VELUM_BOUNDARY_VERSION = 'bokahli.velum-boundary/1' as const;

/**
 * Validate a `VelumTelemetry` that arrived from somewhere else.
 *
 * Bokahli produces this structure and does not parse its own output, so this
 * exists for consumers — Luak, a future dashboard — and for the tests that
 * prove a malformed block is refused rather than half-read. Strict: unknown
 * zones, categories, severities, decisions and dispositions are all failures,
 * because every one of them is a small closed vocabulary and a value outside it
 * is a version skew somebody needs to see.
 */
export type VelumTelemetryFailure =
  | 'not-an-object'
  | 'bad-version'
  | 'bad-mode'
  | 'bad-decision'
  | 'bad-packets'
  | 'bad-zone'
  | 'bad-category'
  | 'bad-severity'
  | 'bad-disposition'
  | 'bad-span'
  | 'bad-digest'
  | 'bad-counts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function validateVelumTelemetry(v: unknown): VelumTelemetry | VelumTelemetryFailure {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not-an-object';
  const o = v as Record<string, unknown>;

  for (const k of ['boundaryVersion', 'detectorVersion', 'registryVersion', 'fenceVersion', 'normalizationVersion', 'receipt'] as const) {
    if (typeof o[k] !== 'string' || (o[k] as string).length === 0) return 'bad-version';
  }
  if (typeof o['registryPayloadSha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(o['registryPayloadSha256'] as string)) {
    return 'bad-digest';
  }
  if (o['mode'] !== 'off' && o['mode'] !== 'audit' && o['mode'] !== 'enforce') return 'bad-mode';
  if (!(VELUM_POLICY_DECISIONS as readonly unknown[]).includes(o['decision'])) return 'bad-decision';
  if (typeof o['clean'] !== 'boolean' || typeof o['scannedAll'] !== 'boolean') return 'bad-counts';
  if (typeof o['steps'] !== 'number' || !Number.isFinite(o['steps']) || o['steps'] < 0) return 'bad-counts';
  if (!Array.isArray(o['packets'])) return 'bad-packets';

  for (const p of o['packets'] as unknown[]) {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'bad-packets';
    const q = p as Record<string, unknown>;
    if (typeof q['id'] !== 'string' || q['id'].length === 0) return 'bad-packets';
    if (!isBokahliTrustZone(q['zone'])) return 'bad-zone';
    if (typeof q['scanned'] !== 'boolean') return 'bad-packets';
    if (typeof q['rawContentSha256'] !== 'string' || !DIGEST.test(q['rawContentSha256'])) return 'bad-digest';
    if (q['renderedContentSha256'] !== null && (typeof q['renderedContentSha256'] !== 'string' || !DIGEST.test(q['renderedContentSha256'] as string))) {
      return 'bad-digest';
    }
    if (typeof q['findingCount'] !== 'number' || !Number.isInteger(q['findingCount']) || q['findingCount'] < 0) return 'bad-counts';
    if (!(VELUM_POLICY_DECISIONS as readonly unknown[]).includes(q['decision'])) return 'bad-decision';
    if (!(VELUM_DISPOSITIONS as readonly unknown[]).includes(q['disposition'])) return 'bad-disposition';
    if (typeof q['rationale'] !== 'string') return 'bad-packets';
    if (!Array.isArray(q['categories']) || !Array.isArray(q['severities']) || !Array.isArray(q['findings'])) return 'bad-packets';
    for (const c of q['categories'] as unknown[]) {
      if (!(VELUM_FINDING_CATEGORIES as readonly unknown[]).includes(c)) return 'bad-category';
    }
    for (const s of q['severities'] as unknown[]) {
      if (!(VELUM_FINDING_SEVERITIES as readonly unknown[]).includes(s)) return 'bad-severity';
    }
    if (q['peakSeverity'] !== null && !(VELUM_FINDING_SEVERITIES as readonly unknown[]).includes(q['peakSeverity'])) {
      return 'bad-severity';
    }
    if ((q['findings'] as unknown[]).length !== q['findingCount']) return 'bad-counts';

    for (const f of q['findings'] as unknown[]) {
      if (typeof f !== 'object' || f === null || Array.isArray(f)) return 'bad-packets';
      const g = f as Record<string, unknown>;
      if (typeof g['patternId'] !== 'string' || g['patternId'].length === 0) return 'bad-packets';
      if (typeof g['contentSha256'] !== 'string' || !DIGEST.test(g['contentSha256'])) return 'bad-digest';
      // A finding whose binding disagrees with its own packet is a finding that
      // was moved. Refuse it rather than resolve it against the wrong bytes.
      if (g['contentSha256'] !== q['rawContentSha256']) return 'bad-digest';
      if (!(VELUM_FINDING_CATEGORIES as readonly unknown[]).includes(g['category'])) return 'bad-category';
      if (!(VELUM_FINDING_SEVERITIES as readonly unknown[]).includes(g['severity'])) return 'bad-severity';
      const span = g['sourceSpan'];
      if (span !== null) {
        if (typeof span !== 'object' || span === null || Array.isArray(span)) return 'bad-span';
        const s = span as Record<string, unknown>;
        const a = s['startByte'];
        const b = s['endByte'];
        if (typeof a !== 'number' || typeof b !== 'number' || !Number.isInteger(a) || !Number.isInteger(b)) return 'bad-span';
        if (a < 0 || b < a) return 'bad-span';
      }
      if (!['exact', 'derived', 'deletion', 'unavailable'].includes(g['fidelity'] as string)) return 'bad-span';
    }
  }
  return o as unknown as VelumTelemetry;
}
