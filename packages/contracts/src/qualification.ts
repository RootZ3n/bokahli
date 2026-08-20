/**
 * Bokahli qualification import contract.
 *
 * Luak is the qualification authority. Bokahli consumes evidence Luak has
 * issued and decides, under an operator-configured policy, whether that
 * evidence is sufficient to route a task class to a specific installed
 * artifact. Bokahli never issues qualification, never scores a model, and
 * never converts absence of evidence into permission.
 *
 * Three rules hold everywhere in this file:
 *
 *   1. Fail closed. No evidence, no policy, or an unsatisfied policy all mean
 *      the same thing: MODEL_NOT_QUALIFIED_FOR_TASK.
 *   2. Unknown stays unknown. Every optional measurement is a *required* field
 *      that may be `null`. A missing TTFT must not be readable as zero, and an
 *      absent key must not be readable as "not applicable".
 *   3. Qualification is keyed to what was actually tested. A verdict earned by
 *      one artifact on one runtime build on one machine says nothing about a
 *      different quantisation, a different build, or different hardware.
 */
import type { ArtifactDigest, ModelId } from './identity.js';

/**
 * Version of the Bokahli-side import bundle format. Changing it is a breaking
 * change: the importer refuses any bundle whose version it does not implement,
 * rather than guessing which fields moved.
 */
export const QUALIFICATION_BUNDLE_VERSION = '2.0.0-phase2a' as const;
export type QualificationBundleVersion = typeof QUALIFICATION_BUNDLE_VERSION;

/** Bundle versions this build can import. Explicit, not a range. */
export const SUPPORTED_QUALIFICATION_BUNDLE_VERSIONS: readonly string[] = [
  QUALIFICATION_BUNDLE_VERSION,
];

// ---------------------------------------------------------------------------
// The qualification key
// ---------------------------------------------------------------------------

/**
 * What a qualification verdict is *about*.
 *
 * Every field here can invalidate a verdict on its own. A Q4 build of the same
 * weights is a different model in every way that matters to a task; a runtime
 * upgrade changes sampling, tokenisation edge cases and numerics; different
 * hardware changes throughput and, with partial offload, sometimes output. So
 * the key is the full tuple, and a lookup miss on any element is a miss.
 */
export interface QualificationKey {
  /** Stable public catalog identity. Never a filesystem path. */
  readonly modelId: ModelId;
  /** Exact artifact content digest the evidence was produced against. */
  readonly artifactDigest: ArtifactDigest;
  /** Quantisation as the catalog states it, e.g. "Q2_K". */
  readonly quantization: string;
  /** Runtime engine name and its pinned build, e.g. llama.cpp / b10505-ee4c505a4. */
  readonly runtimeName: string;
  readonly runtimeBuild: string;
  /**
   * Identity of the machine profile the evidence was produced on. An opaque,
   * operator-assigned id (see HardwareProfile) — Bokahli compares it, it does
   * not interpret it.
   */
  readonly hardwareProfileId: string;
  /** Task class, and the version of that task class's contract. */
  readonly taskClass: string;
  readonly taskClassContractVersion: string;
  /** Fixture suite the attempts were drawn from, and its version. */
  readonly fixtureSuiteId: string;
  readonly fixtureSuiteVersion: string;
  /** Version of the verification/scoring regime that produced the verdicts. */
  readonly verificationRegimeVersion: string;
}

/** Field order is part of the contract: the key string must be stable across builds. */
export const QUALIFICATION_KEY_FIELDS: readonly (keyof QualificationKey)[] = [
  'modelId',
  'artifactDigest',
  'quantization',
  'runtimeName',
  'runtimeBuild',
  'hardwareProfileId',
  'taskClass',
  'taskClassContractVersion',
  'fixtureSuiteId',
  'fixtureSuiteVersion',
  'verificationRegimeVersion',
];

/**
 * Render a key as a single comparable string.
 *
 * Values are escaped so a value containing the separator cannot forge a
 * different key — `a|b` and `a` + `b` must not collide.
 */
export function qualificationKeyString(key: QualificationKey): string {
  return QUALIFICATION_KEY_FIELDS.map((f) => escapeKeyPart(String(key[f]))).join('|');
}

function escapeKeyPart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export function qualificationKeysEqual(a: QualificationKey, b: QualificationKey): boolean {
  return QUALIFICATION_KEY_FIELDS.every((f) => a[f] === b[f]);
}

/**
 * Describes a hardware profile. `id` is what the key compares; the rest is
 * provenance so an operator can tell what `mushin-rtx4070-12g` meant.
 */
export interface HardwareProfile {
  readonly id: string;
  readonly gpuModel: string | null;
  readonly gpuMemoryMiB: number | null;
  readonly gpuDriver: string | null;
  readonly cudaVersion: string | null;
  readonly cpuModel: string | null;
  readonly systemMemoryMiB: number | null;
  /** Whether experts/layers were held off-device, e.g. llama.cpp --cpu-moe. */
  readonly partialOffload: boolean | null;
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// Outcomes and attribution
// ---------------------------------------------------------------------------

/**
 * Outcome of one attempt.
 *
 * PROVIDER_FAILURE and HARNESS_FAILURE exist so infrastructure noise cannot be
 * silently counted as model failure — and, just as importantly, so it cannot be
 * quietly dropped to make a pass rate look better. Both are counted, and the
 * policy decides what to do about them.
 *
 * Maps onto Luak's CompletionState (PASS/FAIL/NC) plus FailureOrigin; see
 * docs/phase2a/LUAK-BOUNDARY.md for the field-by-field derivation.
 */
export type AttemptOutcome =
  | 'PASS'
  | 'PARTIAL'
  | 'FAIL'
  | 'INCOMPLETE'
  | 'PROVIDER_FAILURE'
  | 'HARNESS_FAILURE';

export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'PASS',
  'PARTIAL',
  'FAIL',
  'INCOMPLETE',
  'PROVIDER_FAILURE',
  'HARNESS_FAILURE',
];

/**
 * Where a failure originated. Mirrors Luak's FailureOrigin exactly so imported
 * evidence is not reinterpreted on the way in.
 */
export type FailureOrigin =
  | 'MODEL'
  | 'PROVIDER'
  | 'NETWORK'
  | 'TEST'
  | 'JUDGE'
  | 'HARNESS'
  | 'UNKNOWN';

/**
 * The closed vocabulary, bound to this build.
 *
 * Accepting arbitrary strings here would let an exporter invent an origin
 * Bokahli has no rule for, and an origin with no rule is an origin that gets
 * ignored. A value outside this list is a rejection, not a passthrough.
 */
export const FAILURE_ORIGINS: readonly FailureOrigin[] = [
  'MODEL',
  'PROVIDER',
  'NETWORK',
  'TEST',
  'JUDGE',
  'HARNESS',
  'UNKNOWN',
];

/**
 * Which origins are consistent with which outcomes.
 *
 * This is the check that stops a bundle author labelling their own model's
 * failures as somebody else's problem. An attempt marked PROVIDER_FAILURE whose
 * origin is MODEL is not a provider failure, and counting it as one would
 * remove a real failure from the pass-rate denominator.
 */
export const OUTCOME_ORIGIN_RULES: Readonly<Record<AttemptOutcome, readonly FailureOrigin[]>> =
  Object.freeze({
    PASS: [],
    PARTIAL: ['MODEL', 'UNKNOWN'],
    FAIL: ['MODEL', 'UNKNOWN'],
    INCOMPLETE: ['MODEL', 'UNKNOWN'],
    PROVIDER_FAILURE: ['PROVIDER', 'NETWORK'],
    HARNESS_FAILURE: ['HARNESS', 'TEST', 'JUDGE'],
  });

/** Outcomes attributable to the model under test rather than to infrastructure. */
export const MODEL_ATTRIBUTABLE_OUTCOMES: readonly AttemptOutcome[] = [
  'PASS',
  'PARTIAL',
  'FAIL',
  'INCOMPLETE',
];

/** Outcomes attributable to infrastructure rather than to the model. */
export const INFRASTRUCTURE_OUTCOMES: readonly AttemptOutcome[] = [
  'PROVIDER_FAILURE',
  'HARNESS_FAILURE',
];

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/**
 * Timing measurements. Every field is required and nullable: `null` means the
 * harness did not measure it. It never means zero.
 */
export interface AttemptTimings {
  readonly timeToFirstTokenMs: number | null;
  readonly prefillTokensPerSecond: number | null;
  readonly decodeTokensPerSecond: number | null;
  readonly wallTimeMs: number | null;
}

export interface AttemptTokens {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
}

/**
 * Compliance signals relevant to the task class. Counted per attempt as
 * booleans; `null` where the task class does not define the check or the
 * harness did not run it.
 */
export interface AttemptCompliance {
  /** Output validated against the task class's declared output schema. */
  readonly outputSchemaValid: boolean | null;
  /** Every citation resolved to the supplied input. */
  readonly citationsValid: boolean | null;
  /** Tool calls, if any, were well-formed under the declared tool contract. */
  readonly toolCallsValid: boolean | null;
}

export interface QualificationAttempt {
  readonly attemptId: string;
  /** Fixture within the suite this attempt ran. */
  readonly fixtureId: string;
  readonly outcome: AttemptOutcome;
  readonly failureOrigin: FailureOrigin | null;
  /** Luak's failureReasonCode, carried through verbatim and not reinterpreted. */
  readonly failureReasonCode: string | null;
  /** Normalised 0..1. `null` when the attempt produced no scoreable result. */
  readonly score: number | null;
  readonly contextTierTokens: number | null;
  readonly tokens: AttemptTokens;
  readonly timings: AttemptTimings;
  readonly compliance: AttemptCompliance;
  /** Opaque pointer back to the Luak-side record. Bokahli does not parse it. */
  readonly sourceRef: string | null;
}

/**
 * Aggregates over the attempts.
 *
 * These are carried rather than recomputed so that Luak stays the scoring
 * authority — but the importer *does* recompute them to check consistency, and
 * refuses evidence whose aggregates contradict its own attempts. Trusting the
 * summary while the detail says otherwise is how a bundle lies without any
 * single field being false.
 */
export interface QualificationAggregate {
  readonly attemptCount: number;
  /** Distinct fixtures exercised. May be lower than attemptCount with repeats. */
  readonly sampleCount: number;
  readonly outcomeCounts: Readonly<Record<AttemptOutcome, number>>;
  /** Mean score over attempts that produced a score. `null` if none did. */
  readonly meanScore: number | null;
  /** Passes divided by model-attributable attempts. `null` if there are none. */
  readonly passRate: number | null;
  /**
   * Infrastructure failures divided by all attempts. Reported separately from
   * passRate so a run that mostly failed to execute cannot present as a run
   * that mostly passed.
   */
  readonly infrastructureFailureRate: number | null;
  /** Attempts whose output failed its schema, over attempts where it was checked. */
  readonly schemaViolationRate: number | null;
  /** Attempts with an invalid citation, over attempts where citations were checked. */
  readonly citationViolationRate: number | null;
  /** Population standard deviation of scores, where computable. */
  readonly scoreStdDev: number | null;
  /**
   * Fraction of repeated fixtures that produced differing outcomes. `null` when
   * no fixture was attempted more than once, which is not the same as 0.
   */
  readonly repeatabilityDisagreementRate: number | null;
  /** Context tier the suite was run at, in tokens. */
  readonly contextTierTokens: number | null;
  readonly knownFailureModes: readonly string[];
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where the evidence *claims* to have come from.
 *
 * Every field here is attacker-controlled if the evidence file is. A bundle can
 * say `authority: "luak"`, invent bundle ids, quote another bundle's hash, and
 * assert `luakSignatureStatus: "valid"` — all of it is text the payload chose
 * for itself, and none of it is checkable by Bokahli, which holds no Luak key
 * and performs no Luak-side verification.
 *
 * So this type is provenance and nothing else: a record of the claim, kept for
 * audit. It never becomes trust. `verifiedByBokahli` is typed as the literal
 * `false` so the compiler rejects any code that tries to set it otherwise; the
 * only thing that can authorise routing is `ImportTrust`, which is derived from
 * operator configuration and never from the payload.
 */
export interface UpstreamProvenance {
  /**
   * The authority the payload claims issued it. **Unverified.** Read this as
   * "the file says Luak", never as "Luak said".
   */
  readonly claimedAuthority: string;
  /** Luak's own contract/bundle version the source records were produced under. */
  readonly sourceContractVersion: string;
  /** Luak bundle ids that were aggregated into this evidence. */
  readonly luakBundleIds: readonly string[];
  /** The `bundle_hash` each source bundle carried. */
  readonly luakBundleHashes: readonly string[];
  /**
   * The signature verdict the payload claims Luak reached. **Unverified, and
   * unverifiable here.** Luak signs with HMAC-SHA256 under a shared secret;
   * Bokahli deliberately does not hold that key, because a key that lets
   * Bokahli check a signature is the same key that lets Bokahli forge one.
   * A payload asserting "valid" has asserted a string about itself.
   */
  readonly claimedSignatureStatus: string | null;
  /** Luak repo commit the evidence claims to have been produced at. */
  readonly luakRepoCommit: string | null;
  /** Free-form note. Never load-bearing. */
  readonly note: string | null;
  /**
   * Bokahli has not verified any of the above and structurally cannot.
   * Typed as the literal `false`: this is a compile-time guarantee, not a
   * default that a later edit can quietly flip.
   */
  readonly verifiedByBokahli: false;
}

/**
 * What Bokahli itself derived from the bytes it received.
 *
 * This is the one integrity claim Bokahli can make on its own, and it is
 * narrower than it looks: a matching hash proves the payload is intact as
 * received and has not been edited since it was sealed. It proves nothing about
 * who sealed it. The hash is unkeyed, so anyone who can write the file can
 * recompute it — integrity, never authorship.
 */
export interface PayloadIntegrity {
  readonly algorithm: 'bokahli-canonical-json-sha256-v1';
  readonly contentHash: string;
  readonly verified: boolean;
}

/**
 * Whether the operator has authorised this evidence.
 *
 * The only thing in the system that can turn evidence into permission, and the
 * only one derived entirely outside the payload. Phase 2A implements one basis:
 * an operator-pinned list of evidence content hashes. An empty anchor trusts
 * nothing, which is the default and the deployed state.
 *
 * No cryptography was invented for this. Pinning a digest an operator has
 * looked at is a smaller, more honest claim than a signature scheme Bokahli
 * would have had to design itself.
 */
export interface ImportTrust {
  readonly accepted: boolean;
  readonly basis: ImportTrustBasis;
  /** Where the operator recorded the decision, for audit. */
  readonly anchorRef: string | null;
}

export type ImportTrustBasis =
  /** The computed content hash is on the operator's pinned list. */
  | 'OPERATOR_PINNED_DIGEST'
  /** Nothing authorised it. The default, and the only value that ever fails closed wrong. */
  | 'NONE';

/**
 * The operator's trust anchor. Supplied to the importer; never read from a
 * bundle, never defaulted to something permissive.
 */
export interface TrustAnchor {
  /** Content hashes the operator has explicitly pinned. */
  readonly pinnedEvidenceDigests: readonly string[];
  /** Human-meaningful pointer to where these were recorded. */
  readonly anchorRef: string | null;
}

/** An anchor that authorises nothing. The default everywhere. */
export const EMPTY_TRUST_ANCHOR: TrustAnchor = Object.freeze({
  pinnedEvidenceDigests: Object.freeze([]) as readonly string[],
  anchorRef: null,
});

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/**
 * One qualification verdict, for one key, with the evidence behind it.
 *
 * `verdict` is Luak's, not Bokahli's. Bokahli's own decision is a separate
 * thing (see QualificationDecision) and depends additionally on operator
 * policy: Luak may say QUALIFIED and Bokahli may still refuse to route,
 * because the operator's policy demands more than Luak's threshold did.
 */
export interface QualificationBundle {
  readonly bundleVersion: QualificationBundleVersion;
  readonly key: QualificationKey;
  readonly hardwareProfile: HardwareProfile;
  readonly verdict: 'QUALIFIED' | 'DISQUALIFIED';
  readonly attempts: readonly QualificationAttempt[];
  readonly aggregate: QualificationAggregate;
  /** What the payload claims about its origin. Untrusted by construction. */
  readonly provenance: UpstreamProvenance;
  /** ISO-8601. When the evidence was generated, not when it was imported. */
  readonly generatedAt: string;
  /**
   * ISO-8601 hard expiry stated by the issuer, or null for none. Distinct from
   * policy staleness: this is the issuer saying "do not rely on this after X",
   * and it is enforced even when the operator's policy sets no maximum age.
   */
  readonly expiresAt: string | null;
  /**
   * sha256 over the canonical form of this bundle with `contentHash` itself
   * excluded, under an explicit domain tag. Recomputed and checked on import.
   */
  readonly contentHash: string;
}

/**
 * A bundle the importer accepted, with Bokahli's own findings attached.
 *
 * The three concepts are kept in three separate fields on purpose. They are
 * routinely conflated, and conflating them is precisely how forged evidence
 * gets authority: integrity is mistaken for authorship, and a claimed
 * provenance is mistaken for a checked one.
 */
export interface AcceptedQualificationBundle {
  readonly bundle: QualificationBundle;
  /** Derived by Bokahli from the received bytes. Integrity only. */
  readonly payloadIntegrity: PayloadIntegrity;
  /** Copied from the payload. Never believed. */
  readonly upstreamProvenance: UpstreamProvenance;
  /** Derived from operator configuration. The only thing that authorises. */
  readonly importTrust: ImportTrust;
}

/** A bundle as it appears before its hash is computed or checked. */
export type UnhashedQualificationBundle = Omit<QualificationBundle, 'contentHash'>;

/** The field excluded from the canonical form when hashing. */
export const QUALIFICATION_CONTENT_HASH_FIELD = 'contentHash' as const;

// ---------------------------------------------------------------------------
// Typed import failures
// ---------------------------------------------------------------------------

export type QualificationImportErrorCode =
  /** Not an object, missing required fields, or a field of the wrong type. */
  | 'MALFORMED_BUNDLE'
  /** bundleVersion is not one this build implements. */
  | 'UNSUPPORTED_BUNDLE_VERSION'
  /** Recomputed canonical hash does not equal the stated contentHash. */
  | 'CONTENT_HASH_MISMATCH'
  /** The key names an artifact digest that is not the one installed. */
  | 'ARTIFACT_MISMATCH'
  /** The key names a runtime name/build that is not the one pinned here. */
  | 'RUNTIME_MISMATCH'
  /** The key names a hardware profile that is not this machine's. */
  | 'HARDWARE_MISMATCH'
  /** generatedAt is in the future, or expiresAt has passed. */
  | 'STALE_EVIDENCE'
  /** Aggregates disagree with the attempts they claim to summarise. */
  | 'CONTRADICTORY_AGGREGATE'
  /** taskClass is not a task class this build defines a contract for. */
  | 'UNKNOWN_TASK_CLASS'
  /** taskClassContractVersion is not the version this build implements. */
  | 'TASK_CONTRACT_VERSION_MISMATCH'
  /** Provenance is absent, or claims an authority other than Luak. */
  | 'PROVENANCE_INVALID'
  /** Another accepted bundle already occupies this exact key. */
  | 'DUPLICATE_KEY'
  /**
   * The payload could not be canonicalised: too deeply nested, an unsafe
   * integer, or a value with no JSON representation. A typed refusal rather
   * than a crash, because the input is a file someone else wrote.
   */
  | 'UNCANONICALISABLE'
  /**
   * The evidence describes a context tier this deployment does not serve.
   * Measurements taken at one context length are not measurements of another.
   */
  | 'CONTEXT_TIER_MISMATCH';

export interface QualificationImportError {
  readonly code: QualificationImportErrorCode;
  /** What was wrong, in terms an operator can act on. */
  readonly detail: string;
  /** Dotted path to the offending field, where one is identifiable. */
  readonly field: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
}

export type QualificationImportResult =
  | { readonly ok: true; readonly accepted: AcceptedQualificationBundle }
  | { readonly ok: false; readonly errors: readonly QualificationImportError[] };

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Operator-configured requirements.
 *
 * Every field is optional and there are **no defaults**. Bokahli has no data
 * on which to base a production threshold, so it declines to invent one: a
 * policy that states nothing accepts nothing (see DENY_ALL_POLICY). Choosing
 * these numbers is an operator act, informed by evidence that does not exist
 * yet.
 */
export interface QualificationPolicy {
  /** Distinct fixtures that must have been exercised. */
  readonly minSampleCount?: number;
  /** Attempts that must have been run, including repeats. */
  readonly minAttemptCount?: number;
  /** Minimum pass rate over model-attributable attempts, 0..1. */
  readonly minPassRate?: number;
  /** Minimum mean score, 0..1. */
  readonly minMeanScore?: number;
  /** Maximum age of the evidence at evaluation time. */
  readonly maxAgeDays?: number;
  readonly requiredFixtureSuiteId?: string;
  readonly requiredFixtureSuiteVersion?: string;
  /** The evidence must have been produced at or above this context tier. */
  readonly minContextTierTokens?: number;
  /** Maximum share of model-attributable attempts that may fail, 0..1. */
  readonly maxFailureRate?: number;
  /** Maximum share of attempts that may violate the output schema, 0..1. */
  readonly maxSchemaViolationRate?: number;
  /** Maximum share of attempts that may carry an invalid citation, 0..1. */
  readonly maxCitationViolationRate?: number;
  /** Maximum share of attempts that may be infrastructure failures, 0..1. */
  readonly maxInfrastructureFailureRate?: number;
  /** Maximum disagreement across repeats of the same fixture, 0..1. */
  readonly maxRepeatabilityDisagreementRate?: number;
  readonly requiredVerificationRegimeVersion?: string;
  /** Failure modes that disqualify outright regardless of scores. */
  readonly blockingFailureModes?: readonly string[];
  /**
   * Whether a required measurement being `null` blocks qualification.
   * Defaults to true at evaluation time: unknown must not read as acceptable.
   */
  readonly treatUnknownAsFailure?: boolean;
}

/** A policy that states nothing, and therefore accepts nothing. */
export const DENY_ALL_POLICY: QualificationPolicy = Object.freeze({});

export type QualificationDecisionReason =
  /** Policy satisfied and Luak's verdict is QUALIFIED. */
  | 'QUALIFIED'
  /** The default: no evidence, no policy, or policy unsatisfied. */
  | 'MODEL_NOT_QUALIFIED_FOR_TASK'
  /** Evidence exists for this task class but not for this exact key. */
  | 'NO_EVIDENCE_FOR_KEY'
  /** No policy has been configured for this task class. */
  | 'NO_POLICY_CONFIGURED'
  /** Luak issued DISQUALIFIED. No policy can override that. */
  | 'DISQUALIFIED_BY_AUTHORITY'
  /** Evidence exists and is otherwise fine, but is older than policy allows. */
  | 'EVIDENCE_STALE'
  /**
   * Evidence exists, its payload is intact, and the operator has not authorised
   * it. A correct content hash is integrity, not permission.
   */
  | 'EVIDENCE_NOT_TRUSTED'
  /**
   * The policy omits a requirement this build refuses to leave unstated.
   * A half-written policy must not silently disable the checks it forgot.
   */
  | 'POLICY_INCOMPLETE'
  /** A required measurement is unknown and the policy does not accept unknowns. */
  | 'EVIDENCE_INCOMPLETE';

/**
 * One unmet policy requirement. Shaped like the router's UnmetRequirement on
 * purpose: an escalation should be able to quote it without translation.
 */
export interface PolicyShortfall {
  readonly requirement: string;
  readonly required: string;
  readonly actual: string;
}

export interface QualificationDecision {
  readonly qualified: boolean;
  readonly reason: QualificationDecisionReason;
  readonly taskClass: string;
  /** The key the decision was made against, when one was resolved. */
  readonly key: QualificationKey | null;
  readonly shortfalls: readonly PolicyShortfall[];
  /** Content hash of the evidence relied on, or null when none was found. */
  readonly evidenceHash: string | null;
  readonly evidenceGeneratedAt: string | null;
  /**
   * Who Bokahli can actually account for.
   *
   * `'luak'` **only** when the operator's trust anchor accepted this evidence.
   * A payload claiming `authority: "luak"` does not put it here — that claim
   * lives in `claimedAuthority`, and the gap between the two fields is the
   * whole point of them being two fields.
   */
  readonly authority: 'luak' | 'none';
  /** What the evidence claimed about itself. Unverified. */
  readonly claimedAuthority: string | null;
  /** How, if at all, the operator authorised this evidence. */
  readonly importTrustBasis: ImportTrustBasis;
  readonly detail: string;
}

/** The answer whenever anything is missing. Constructed, never defaulted into. */
export function notQualified(
  taskClass: string,
  reason: QualificationDecisionReason,
  detail: string,
  shortfalls: readonly PolicyShortfall[] = [],
  key: QualificationKey | null = null,
): QualificationDecision {
  return {
    qualified: false,
    reason,
    taskClass,
    key,
    shortfalls,
    evidenceHash: null,
    evidenceGeneratedAt: null,
    authority: 'none',
    claimedAuthority: null,
    importTrustBasis: 'NONE',
    detail,
  };
}
