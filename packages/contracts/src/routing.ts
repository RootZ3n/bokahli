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
import type {
  ArtifactDigest,
  CatalogEntry,
  ModelId,
  Qualification,
  ServedIdentity,
} from './identity.js';

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
}

export interface CandidateAssessment {
  readonly modelId: ModelId;
  readonly digest: ArtifactDigest;
  readonly eligible: boolean;
  readonly unmet: readonly UnmetRequirement[];
  readonly qualification: Qualification;
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
  | 'CAPABILITY_UNSUPPORTED';

export interface Escalation {
  readonly kind: 'ESCALATE';
  readonly mode: RouteMode;
  readonly reason: EscalateReason;
  readonly detail: string;
  readonly unmet: readonly UnmetRequirement[];
  readonly considered: readonly CandidateAssessment[];
  /** Bokahli asserts no opinion about where this should go instead. */
  readonly authorityNote: string;
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
  | 'RUNTIME_NOT_READY';

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
  readonly gpu: GpuSnapshot | null;
}

export interface GpuSnapshot {
  readonly totalMiB: number;
  readonly usedMiB: number;
  readonly freeMiB: number;
  readonly utilisationPct: number;
  readonly temperatureC: number;
}

export type { CatalogEntry };
