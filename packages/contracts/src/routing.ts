/**
 * Bokahli routing contract.
 *
 * Three modes, one typed escalation, one typed capacity outcome, one typed
 * refusal. Every request passes through this contract — including AUTO in
 * Phase 1, where exactly one artifact is installed. A deterministic selection
 * over a single candidate is still a routing decision and must be recorded as
 * one. Bokahli does not fabricate scores, rankings, or qualification claims to
 * make that decision look richer than it is.
 */
import type { AttemptLifetime, SamplerFacts, TokenCountFacts } from './attestation.js';
import type { VelumTelemetry } from './velum.js';
import type {
  ArtifactDigest,
  CatalogEntry,
  ModelId,
  Qualification,
  ServedIdentity,
} from './identity.js';
import type { QualificationDecision } from './qualification.js';

export type RouteMode = 'AUTO' | 'PROFILE' | 'EXACT';

/** AUTO: Bokahli selects the best qualified available local route for the task. */
export interface AutoRoute {
  readonly mode: 'AUTO';
  /** Caller's task class. Advisory in Phase 1: no qualification data exists to match against. */
  readonly taskClass?: string;
  /**
   * If true, AUTO will only select artifacts Luak has qualified. With no Luak
   * evidence installed this yields ESCALATE rather than a silent substitution.
   */
  readonly requireQualified?: boolean;
}

/** PROFILE: caller-defined capability and operational constraints. Unmet => refuse. */
export interface ProfileRoute {
  readonly mode: 'PROFILE';
  readonly requirements: ProfileRequirements;
}

export interface ProfileRequirements {
  readonly minContextTokens?: number;
  readonly maxContextTokens?: number;
  readonly requiredCapabilities?: readonly ProfileCapability[];
  readonly architecture?: string;
  readonly quantizationAllowList?: readonly string[];
  readonly quantizationDenyList?: readonly string[];
  readonly minParameterCount?: number;
  /** Require Luak-issued qualification, optionally for a specific task class. */
  readonly requireQualified?: boolean;
  readonly requiredTaskClass?: string;
  readonly maxQueueDepth?: number;
}

export type ProfileCapability =
  | 'chat'
  | 'completion'
  | 'tools'
  | 'vision'
  | 'audio'
  | 'embedding'
  | 'reasoningEffort';

/** EXACT: a specific artifact, verified by digest. Never a silent substitution. */
export interface ExactRoute {
  readonly mode: 'EXACT';
  readonly modelId: ModelId;
  /** Required. EXACT without a digest is not exact. */
  readonly artifactDigest: ArtifactDigest;
  /** Task class this request is for. Advisory unless requireQualified is set. */
  readonly taskClass?: string;
  /**
   * Demand that the named artifact be qualified for `taskClass`.
   *
   * EXACT identifies *which* artifact to serve; it says nothing about whether
   * that artifact is fit for anything. A caller that names an artifact and also
   * demands qualification gets both checks, and naming the artifact does not
   * satisfy the second: an unqualified EXACT request with requireQualified
   * escalates rather than serving. Being specific is not the same as being
   * entitled.
   */
  readonly requireQualified?: boolean;
}

export type RouteSpec = AutoRoute | ProfileRoute | ExactRoute;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type RouteOutcomeKind = 'ROUTED' | 'ESCALATE' | 'REFUSED' | 'CAPACITY_UNAVAILABLE';

export interface RouteDecision {
  readonly kind: 'ROUTED';
  readonly mode: RouteMode;
  readonly selected: ServedIdentity;
  /** Every candidate the router considered, and why it was kept or dropped. */
  readonly considered: readonly CandidateAssessment[];
  /** Plain-language statement of why this route was chosen. No numeric scores. */
  readonly rationale: string;
  /**
   * The qualification decision behind this route, when a task class was named.
   * Null when the caller asked for none — which is not the same as qualified.
   */
  readonly qualification?: QualificationDecision | null;
}

export interface CandidateAssessment {
  readonly modelId: ModelId;
  readonly digest: ArtifactDigest;
  readonly eligible: boolean;
  readonly unmet: readonly UnmetRequirement[];
  readonly qualification: Qualification;
  /**
   * Evidence-backed decision for the requested task class, where one was
   * requested. Distinct from `qualification`, which is the catalog's declared
   * state; this is what imported evidence and the operator's policy say.
   */
  readonly qualificationDecision?: QualificationDecision | null;
  /** Position after deterministic ranking, and what decided it. */
  readonly rank?: number;
  readonly rankBasis?: string;
}

export interface UnmetRequirement {
  readonly requirement: string;
  readonly required: string;
  readonly actual: string;
}

/**
 * ESCALATE — no qualified local route is suitable.
 *
 * Bokahli emits this and stops. Where an escalated request goes next is the
 * caller's authority, not Bokahli's: Bokahli has no cloud-routing authority.
 */
export type EscalateReason =
  | 'NO_LOCAL_CANDIDATES'
  | 'NO_QUALIFIED_LOCAL_ROUTE'
  | 'REQUIREMENTS_UNMET'
  | 'CONTEXT_EXCEEDS_LOCAL_CAPABILITY'
  | 'CAPABILITY_UNSUPPORTED'
  /**
   * A task class was named and no installed artifact holds qualification for it
   * under the operator's policy.
   *
   * Distinct from NO_QUALIFIED_LOCAL_ROUTE, which answers the broader question
   * "is anything here qualified at all". This one answers "is anything here
   * qualified *for this*", and is what a caller asking for a specific task
   * class gets when the evidence, the policy, or both fall short. It is the
   * default: absence of evidence produces exactly this, never a pass.
   */
  | 'MODEL_NOT_QUALIFIED_FOR_TASK'
  /**
   * The local runtime is not answering, so no served identity can be attested.
   *
   * This is a *terminal* result for this request, not a retry loop and not an
   * error: Bokahli says plainly that it cannot serve, rather than hanging,
   * crashing, or — worst of all — emitting plausible output it did not get from
   * an attested runtime. It is distinct from CAPACITY_UNAVAILABLE/
   * RUNTIME_UNAVAILABLE, which means the runtime is present but busy.
   */
  | 'RUNTIME_UNHEALTHY'
  /**
   * The evidence behind the served identity had already lapsed at admission.
   *
   * Refused before any work starts rather than after: executing first and
   * discovering afterwards that the request was never validly admitted spends a
   * GPU-minute to produce something that has to be thrown away. The runtime is
   * healthy; a retry re-attests and proceeds.
   */
  | 'ATTESTATION_STALE'
  /**
   * The request completed and the completion cannot be attributed.
   *
   * Reserved for the backend instance changing between admission and
   * completion. The output may be perfectly good; it came from a process that
   * was never attested for this request, so it is not returned. A qualification
   * campaign must drop such an attempt rather than score it against the model —
   * the failure is infrastructure, not capability.
   */
  | 'ATTEMPT_NOT_ATTRIBUTABLE'
  /**
   * Caller-supplied evidence carries a block-severity injection finding.
   *
   * A statement about the content of the evidence and nothing else. The route
   * was sound, the runtime is healthy, and the model is not implicated: the
   * evidence was simply not sent to it. Not retryable — the same bytes produce
   * the same finding — so a caller that wants the text analysed anyway changes
   * the boundary's mode, which is an operator decision and not a request
   * parameter.
   */
  | 'VELUM_EVIDENCE_BLOCKED'
  /**
   * Inspection did not complete, so the request was not executed.
   *
   * A resource ceiling, a mapping failure, or an engine error inside the trust
   * boundary. Deliberately *not* a decision to proceed uninspected: an
   * inspection that fails open is a boundary that disappears exactly when
   * something unusual is happening. Retryable — a smaller document, or the same
   * one after a limit is raised deliberately, may inspect cleanly.
   */
  | 'VELUM_RESOURCE_LIMIT'
  | 'VELUM_MAPPING_FAILURE'
  | 'VELUM_ENGINE_ERROR'
  /**
   * The machine miscomputed a byte conversion, so nothing measured on it can be
   * attributed to the runtime or the model.
   *
   * Deliberately not `RUNTIME_UNHEALTHY`: the runtime is answering and its
   * identity is fine. And deliberately not a degraded token-provenance verdict,
   * which is where this used to land — the tokenizer canary compared base64
   * strings, `Buffer.prototype.toString('base64')` returns a wrong character
   * roughly once in a thousand calls on one core of the deployment host, and a
   * host fault therefore presented as "the runtime decodes differently from the
   * artifact token table" and discarded an otherwise valid attempt.
   *
   * A consumer must treat this as a statement about the machine. It is never a
   * statement about the model, and it can never be favourable evidence.
   * Retryable: the fault is intermittent and core-dependent, so a retry may
   * land on a sound core — but a deployment seeing this needs investigation,
   * not a retry loop.
   */
  | 'HOST_INTEGRITY_FAULT'
  /**
   * Inspection exceeded its deadline and the worker was terminated.
   *
   * A scan is a synchronous loop inside a worker thread, so a deadline is
   * enforced by destroying the worker — nothing else interrupts it. The request
   * was not executed: Bokahli does not proceed with inspection skipped, for the
   * same reason it does not proceed when inspection fails any other way.
   */
  | 'VELUM_SCAN_TIMEOUT'
  /**
   * The inspection worker crashed, exited, or was shut down mid-job.
   *
   * Infrastructure, and retryable: the pool replaces the worker immediately.
   * Nothing about it is a statement about the content, the route, or the model.
   */
  | 'VELUM_WORKER_LOST';

export interface Escalation {
  readonly kind: 'ESCALATE';
  readonly mode: RouteMode;
  readonly reason: EscalateReason;
  readonly detail: string;
  readonly unmet: readonly UnmetRequirement[];
  readonly considered: readonly CandidateAssessment[];
  /** Bokahli asserts no opinion about where this should go instead. */
  readonly authorityNote: string;
  /**
   * True when the local route itself is sound and the same request may succeed
   * here later without any change by the caller — the runtime is simply not
   * healthy right now. False when the escalation is a statement about local
   * capability or qualification, which retrying cannot change.
   */
  readonly retryableLocal: boolean;
}

/**
 * REFUSED — the request was well-formed but cannot be honoured as specified,
 * and substituting something else would violate the caller's contract.
 */
export type RefusalReason =
  | 'EXACT_IDENTITY_UNKNOWN'
  | 'EXACT_DIGEST_MISMATCH'
  | 'EXACT_IDENTITY_NOT_PUBLIC'
  | 'EXACT_NOT_ATTESTED'
  | 'INVALID_ROUTE_SPEC'
  | 'CONTEXT_EXCEEDS_SERVED_LIMIT';

export interface Refusal {
  readonly kind: 'REFUSED';
  readonly mode: RouteMode;
  readonly reason: RefusalReason;
  readonly detail: string;
  /** What the caller asked for, echoed verbatim for audit. */
  readonly requested: { readonly modelId?: string; readonly artifactDigest?: string };
  /** What Bokahli actually has. Never a filesystem path. */
  readonly available: readonly { readonly modelId: ModelId; readonly digest: ArtifactDigest }[];
}

/**
 * CAPACITY_UNAVAILABLE — the route is valid but cannot execute right now.
 * Distinct from ESCALATE: the local route is correct, it is merely unavailable.
 */
export type CapacityReason =
  | 'GPU_LEASE_HELD_BY_OTHER'
  | 'QUEUE_FULL'
  | 'QUEUE_TIMEOUT'
  | 'RUNTIME_UNAVAILABLE'
  | 'RUNTIME_NOT_READY'
  /**
   * The prompt-injection inspector has no capacity for this request right now.
   *
   * A capacity outcome and not an escalation, because it is exactly that: the
   * route is sound, the runtime is healthy, and the model is not implicated.
   * Inspection is synchronous and its cost is set by how much evidence a caller
   * sends, so a process-wide budget bounds what may be in flight and refuses
   * the rest rather than queueing it. Retry after the stated interval.
   */
  | 'VELUM_SCAN_CAPACITY';

export interface CapacityUnavailable {
  readonly kind: 'CAPACITY_UNAVAILABLE';
  readonly mode: RouteMode;
  readonly reason: CapacityReason;
  readonly detail: string;
  readonly queueDepth: number;
  readonly retryAfterSeconds: number | null;
  /** Populated when a foreign process holds the GPU lease. */
  readonly leaseHolder: GpuLeaseHolder | null;
}

export interface GpuLeaseHolder {
  readonly pid: number;
  readonly processName: string;
  readonly usedMiB: number;
}

export type RouteOutcome = RouteDecision | Escalation | Refusal | CapacityUnavailable;

export function isRouted(o: RouteOutcome): o is RouteDecision {
  return o.kind === 'ROUTED';
}

// ---------------------------------------------------------------------------
// Native Bokahli envelope
// ---------------------------------------------------------------------------

export interface BokahliChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface BokahliRequest {
  readonly route: RouteSpec;
  readonly messages: readonly BokahliChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stream?: boolean;
  /** Caller-supplied correlation id. Bokahli always issues its own requestId too. */
  readonly clientRequestId?: string;
}

export interface BokahliResponse {
  readonly requestId: string;
  readonly outcome: RouteOutcomeKind;
  /** Echo of what was requested, for audit. */
  readonly requested: RouteSpec;
  readonly route: RouteOutcome;
  /** Present only when outcome is ROUTED and execution completed. */
  readonly result: BokahliResult | null;
  readonly telemetry: RequestTelemetry;
}

export interface BokahliResult {
  readonly content: string;
  readonly finishReason: string;
  readonly servedIdentity: ServedIdentity;
}

export interface RequestTelemetry {
  readonly requestId: string;
  readonly receivedAt: string;
  readonly completedAt: string | null;
  readonly queueWaitMs: number;
  readonly queueDepthAtAdmission: number;
  readonly routeMs: number;
  readonly timeToFirstTokenMs: number | null;
  readonly totalMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly promptTokensPerSecond: number | null;
  readonly completionTokensPerSecond: number | null;
  readonly servedContextTokens: number | null;
  readonly contextUtilisation: number | null;
  readonly runtimeBuild: string | null;
  /**
   * Whole-GPU telemetry: appliance information about the device, not about our
   * process. It answers "is the box busy", never "did our backend run on the
   * GPU" — that is `qualificationFacts.placement`, and conflating the two is
   * what let a CPU-only backend look healthy in Phase 1.
   */
  readonly gpu: GpuSnapshot | null;
  /**
   * Phase B2. Token counts with their provenance attached.
   *
   * `promptTokens` and `completionTokens` above are unchanged and still carry
   * the same numbers; this says where those numbers came from. A consumer that
   * only reads the bare counts behaves exactly as before — and is exactly the
   * consumer this field exists to stop being the only option.
   */
  readonly tokenCounts: TokenCountFacts;
  /** Phase B2. Requested, sent, and runtime-confirmed sampler settings. */
  readonly sampler: SamplerFacts;
  /**
   * Phase B2. Whether the evidence behind this attempt survived the attempt.
   *
   * Null on paths that never reached a backend — there is no attempt to bound.
   * A consumer scoring model quality must drop anything whose verdict is
   * `infrastructure-invalid`: the output exists, and it is not attributable.
   */
  readonly attemptLifetime: AttemptLifetime | null;
  /**
   * Prompt-injection inspection, when it ran.
   *
   * Additive and nullable. Every field above keeps its meaning and its type; a
   * consumer that does not read this one is unaffected, which is the property
   * that lets Luak's pinned B2 consumer keep working across the change. Null
   * means inspection did not run — a null that says "not inspected" is honest
   * where an empty report would read as "inspected, nothing found".
   *
   * Evidence, never authority. Nothing in here selects a model, alters token
   * provenance, or changes whether an artifact is qualified.
   */
  readonly velum: VelumTelemetry | null;
}

export interface GpuSnapshot {
  readonly totalMiB: number;
  readonly usedMiB: number;
  readonly freeMiB: number;
  readonly utilisationPct: number;
  readonly temperatureC: number;
}

export type { CatalogEntry };
