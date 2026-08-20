import type { Catalog, InternalArtifact } from '@bokahli/catalog';
import type { Attestation, LlamaBackend } from '@bokahli/runtime';
import { rankCandidates, type RankableCandidate } from '@bokahli/qualification';
import {
  isPathLike,
  isValidDigest,
  type CandidateAssessment,
  type QualificationDecision,
  type CatalogEntry,
  type Escalation,
  type ProfileRequirements,
  type Refusal,
  type RouteDecision,
  type RouteOutcome,
  type RouteSpec,
  type ServedIdentity,
  type UnmetRequirement,
} from '@bokahli/contracts';

const AUTHORITY_NOTE =
  'Bokahli emits a typed escalation and stops. Bokahli holds no cloud-routing ' +
  'authority; where this request goes next is the calling system’s decision.';

export interface RouteContext {
  readonly catalog: Catalog;
  readonly backend: LlamaBackend;
  /**
   * Evidence-backed qualification. Always present; an unconfigured deployment
   * supplies an empty, deny-everything gate rather than omitting the check.
   */
  readonly qualification: QualificationGate;
  readonly queueDepth: number;
  /** Approximate prompt size, used only for context-capability checks. */
  readonly estimatedPromptTokens: number;
  readonly requestedMaxTokens: number;
}

/**
 * The qualification question, as the router needs to ask it.
 *
 * Declared as an interface here rather than importing the concrete gate so the
 * router can be exercised against a stub in tests without standing up an
 * evidence store — and so the routing rules stay readable as rules.
 */
export interface QualificationGate {
  decide(
    artifact: { readonly modelId: string; readonly digest: string; readonly quantization: string },
    taskClass: string | undefined,
  ): QualificationDecision;
  rankable(
    artifact: { readonly modelId: string; readonly digest: string; readonly quantization: string },
    taskClass: string | undefined,
  ): RankableCandidate;
}

function identityOf(a: InternalArtifact): {
  modelId: string;
  digest: string;
  quantization: string;
} {
  return { modelId: a.modelId, digest: a.digest, quantization: a.facts.quantization };
}

/**
 * Pick the escalation reason that matches what the caller actually asked.
 *
 * A caller who named a task class is told about that task class; a caller who
 * demanded qualification in the abstract is told nothing here is qualified at
 * all. Collapsing the two would answer a question nobody asked.
 */
function qualificationEscalateReason(taskClass: string | undefined): Escalation['reason'] {
  return taskClass ? 'MODEL_NOT_QUALIFIED_FOR_TASK' : 'NO_QUALIFIED_LOCAL_ROUTE';
}

/** A failed qualification decision, rendered as unmet requirements. */
function qualificationUnmet(
  decision: QualificationDecision,
  taskClass: string | undefined,
): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [
    {
      requirement: `qualification.${taskClass ?? '(no task class named)'}`,
      required: 'QUALIFIED, on imported Luak evidence, under the operator policy',
      actual: decision.reason,
    },
  ];
  for (const s of decision.shortfalls) {
    unmet.push({ requirement: s.requirement, required: s.required, actual: s.actual });
  }
  return unmet;
}

export interface RouteRunResult {
  readonly outcome: RouteOutcome;
  /** Internal artifact for execution. Present only when outcome.kind === 'ROUTED'. */
  readonly artifact: InternalArtifact | null;
  readonly routeMs: number;
}

export async function route(spec: RouteSpec, ctx: RouteContext): Promise<RouteRunResult> {
  const started = Date.now();
  const outcome = await decide(spec, ctx);
  const artifact =
    outcome.kind === 'ROUTED' ? (ctx.catalog.internal(outcome.selected.modelId) ?? null) : null;
  return { outcome, artifact, routeMs: Date.now() - started };
}

async function decide(spec: RouteSpec, ctx: RouteContext): Promise<RouteOutcome> {
  switch (spec.mode) {
    case 'EXACT':
      return decideExact(
        spec.modelId,
        spec.artifactDigest,
        ctx,
        spec.taskClass,
        spec.requireQualified === true,
      );
    case 'PROFILE':
      return decideProfile(spec.requirements, ctx);
    case 'AUTO':
      return decideAuto(spec.requireQualified === true, spec.taskClass, ctx);
    default: {
      const bad = spec as { mode?: unknown };
      return refuse('AUTO', 'INVALID_ROUTE_SPEC', `unknown route mode: ${String(bad.mode)}`, {}, ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// EXACT
// ---------------------------------------------------------------------------

async function decideExact(
  modelId: string,
  digest: string,
  ctx: RouteContext,
  taskClass: string | undefined,
  requireQualified: boolean,
): Promise<RouteOutcome> {
  // The public identity boundary. llama-server reports its model as a
  // filesystem path; Bokahli must never accept one as an identity, even if it
  // would happen to resolve.
  if (typeof modelId !== 'string' || modelId.length === 0 || isPathLike(modelId)) {
    return refuse(
      'EXACT',
      'EXACT_IDENTITY_NOT_PUBLIC',
      'modelId must be a stable public catalog identity. Filesystem paths and ' +
        'artifact filenames are not valid identities and are never accepted.',
      { modelId, artifactDigest: digest },
      ctx,
    );
  }
  if (!isValidDigest(digest)) {
    return refuse(
      'EXACT',
      'INVALID_ROUTE_SPEC',
      'EXACT requires artifactDigest in the form sha256:<64 hex>. ' +
        'A route without a digest is not exact.',
      { modelId, artifactDigest: digest },
      ctx,
    );
  }

  const artifact = ctx.catalog.internal(modelId);
  if (!artifact) {
    return refuse(
      'EXACT',
      'EXACT_IDENTITY_UNKNOWN',
      `no installed artifact has the identity "${modelId}". No substitution was attempted.`,
      { modelId, artifactDigest: digest },
      ctx,
    );
  }
  if (artifact.digest !== digest) {
    return refuse(
      'EXACT',
      'EXACT_DIGEST_MISMATCH',
      `identity "${modelId}" is installed, but its artifact digest does not match the ` +
        'one requested. Serving it would be a silent substitution.',
      { modelId, artifactDigest: digest },
      ctx,
    );
  }

  const attestation = await ctx.backend.attest(artifact);
  // Runtime absent is a health outcome; runtime present but serving something
  // else is a refusal. Only the second is a statement about identity.
  if (!attestation.reachable) {
    return runtimeUnhealthy('EXACT', attestation.reasons, [assess(artifact, true, [])]);
  }
  if (!attestation.attested) {
    return refuse(
      'EXACT',
      'EXACT_NOT_ATTESTED',
      `the live runtime could not be attested as serving "${modelId}": ` +
        attestation.reasons.join('; '),
      { modelId, artifactDigest: digest },
      ctx,
    );
  }

  const served = attestation.servedContextTokens ?? artifact.operational.servedContextTokens;
  const needed = ctx.estimatedPromptTokens + ctx.requestedMaxTokens;
  if (needed > served) {
    return refuse(
      'EXACT',
      'CONTEXT_EXCEEDS_SERVED_LIMIT',
      `request needs about ${needed} tokens but "${modelId}" is served with a ` +
        `${served}-token context. EXACT will not silently truncate.`,
      { modelId, artifactDigest: digest },
      ctx,
    );
  }

  // Identity and fitness are separate questions, and EXACT answers only the
  // first. A caller who names an artifact *and* demands it be qualified is
  // asking both; naming it does not satisfy the second.
  const decision = ctx.qualification.decide(identityOf(artifact), taskClass);
  if (requireQualified && !decision.qualified) {
    return escalate(
      'EXACT',
      qualificationEscalateReason(taskClass),
      `"${modelId}" is installed and its digest matches, but it is not qualified for ` +
        `${taskClass ? `"${taskClass}"` : 'any task class'}: ${decision.detail} ` +
        'EXACT selects an artifact; it does not confer fitness on one.',
      qualificationUnmet(decision, taskClass),
      [assess(artifact, false, qualificationUnmet(decision, taskClass), decision)],
      false,
    );
  }

  return routed('EXACT', artifact, attestation, [assess(artifact, true, [], decision)],
    `EXACT match on catalog identity and artifact digest, attested against the live runtime ` +
    `(build ${attestation.build}).` +
    (taskClass ? ` Qualification for "${taskClass}": ${decision.reason}.` : ''),
    taskClass ? decision : null);
}

// ---------------------------------------------------------------------------
// PROFILE
// ---------------------------------------------------------------------------

async function decideProfile(
  req: ProfileRequirements,
  ctx: RouteContext,
): Promise<RouteOutcome> {
  const candidates = ctx.catalog.internalAll();
  if (candidates.length === 0) {
    return escalate('PROFILE', 'NO_LOCAL_CANDIDATES', 'no artifacts are installed.', [], []);
  }

  const wantsQualification = req.requireQualified === true || req.requiredTaskClass !== undefined;
  const taskClass = req.requiredTaskClass;

  const assessments: CandidateAssessment[] = [];
  const eligible: InternalArtifact[] = [];
  const decisions = new Map<string, QualificationDecision>();

  for (const a of candidates) {
    const decision = ctx.qualification.decide(identityOf(a), taskClass);
    decisions.set(a.modelId, decision);
    const unmet = evaluateProfile(a, req, ctx);
    if (wantsQualification && !decision.qualified) {
      unmet.push(...qualificationUnmet(decision, taskClass));
    }
    assessments.push(assess(a, unmet.length === 0, unmet, decision));
    if (unmet.length === 0) eligible.push(a);
  }

  if (eligible.length === 0) {
    const allUnmet = assessments.flatMap((c) => c.unmet);
    const contextOnly =
      allUnmet.length > 0 && allUnmet.every((u) => u.requirement.startsWith('context'));
    const qualificationBlocked =
      wantsQualification && allUnmet.some((u) => u.requirement.startsWith('qualification'));
    return escalate(
      'PROFILE',
      qualificationBlocked
        ? qualificationEscalateReason(taskClass)
        : contextOnly
          ? 'CONTEXT_EXCEEDS_LOCAL_CAPABILITY'
          : 'REQUIREMENTS_UNMET',
      qualificationBlocked
        ? 'no installed artifact holds qualification evidence that satisfies this profile. ' +
          'A profile requirement that evidence does not support is refused, not approximated.'
        : 'no installed artifact satisfies the caller-defined profile. Bokahli will ' +
          'not substitute a model that fails the stated constraints.',
      allUnmet,
      assessments,
    );
  }

  const chosen = pickBest(eligible, ctx, taskClass, assessments);
  const attestation = await ctx.backend.attest(chosen);
  if (!attestation.reachable) {
    return runtimeUnhealthy('PROFILE', attestation.reasons, assessments);
  }
  if (!attestation.attested) {
    return escalate(
      'PROFILE',
      'REQUIREMENTS_UNMET',
      `the only eligible artifact could not be attested on the live runtime: ` +
        attestation.reasons.join('; '),
      [{ requirement: 'runtime.attested', required: 'true', actual: 'false' }],
      assessments,
    );
  }
  return routed('PROFILE', chosen, attestation, assessments,
    `Selected by deterministic rank over ${eligible.length} artifact(s) that satisfy every ` +
    `stated requirement. ${assessments.length - eligible.length} candidate(s) were excluded ` +
    'for unmet constraints.',
    wantsQualification ? (decisions.get(chosen.modelId) ?? null) : null);
}

function evaluateProfile(
  a: InternalArtifact,
  req: ProfileRequirements,
  ctx: RouteContext,
): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [];
  const served = a.operational.servedContextTokens;

  if (req.minContextTokens != null && served < req.minContextTokens) {
    unmet.push({
      requirement: 'context.minContextTokens',
      required: `>= ${req.minContextTokens}`,
      actual: String(served),
    });
  }
  if (req.maxContextTokens != null && served > req.maxContextTokens) {
    unmet.push({
      requirement: 'context.maxContextTokens',
      required: `<= ${req.maxContextTokens}`,
      actual: String(served),
    });
  }
  const needed = ctx.estimatedPromptTokens + ctx.requestedMaxTokens;
  if (needed > served) {
    unmet.push({
      requirement: 'context.requestFits',
      required: `<= ${served}`,
      actual: `~${needed}`,
    });
  }
  for (const cap of req.requiredCapabilities ?? []) {
    if (!a.capabilities[cap]) {
      unmet.push({ requirement: `capability.${cap}`, required: 'true', actual: 'false' });
    }
  }
  if (req.architecture && a.facts.architecture !== req.architecture) {
    unmet.push({
      requirement: 'facts.architecture',
      required: req.architecture,
      actual: a.facts.architecture,
    });
  }
  if (req.quantizationAllowList && !req.quantizationAllowList.includes(a.facts.quantization)) {
    unmet.push({
      requirement: 'facts.quantization',
      required: `one of [${req.quantizationAllowList.join(', ')}]`,
      actual: a.facts.quantization,
    });
  }
  if (req.quantizationDenyList?.includes(a.facts.quantization)) {
    unmet.push({
      requirement: 'facts.quantization',
      required: `not one of [${req.quantizationDenyList.join(', ')}]`,
      actual: a.facts.quantization,
    });
  }
  if (req.minParameterCount != null && a.facts.parameterCount < req.minParameterCount) {
    unmet.push({
      requirement: 'facts.parameterCount',
      required: `>= ${req.minParameterCount}`,
      actual: String(a.facts.parameterCount),
    });
  }
  // Qualification is evaluated by the gate, against imported evidence and the
  // operator's policy — not against the catalog's declared status. A catalog
  // edit must never be able to confer fitness.
  if (req.maxQueueDepth != null && ctx.queueDepth > req.maxQueueDepth) {
    unmet.push({
      requirement: 'operational.maxQueueDepth',
      required: `<= ${req.maxQueueDepth}`,
      actual: String(ctx.queueDepth),
    });
  }
  return unmet;
}

// ---------------------------------------------------------------------------
// AUTO
// ---------------------------------------------------------------------------

async function decideAuto(
  requireQualified: boolean,
  taskClass: string | undefined,
  ctx: RouteContext,
): Promise<RouteOutcome> {
  const candidates = ctx.catalog.internalAll();
  if (candidates.length === 0) {
    return escalate('AUTO', 'NO_LOCAL_CANDIDATES', 'no artifacts are installed.', [], []);
  }

  const assessments: CandidateAssessment[] = [];
  const eligible: InternalArtifact[] = [];
  const decisions = new Map<string, QualificationDecision>();
  const needed = ctx.estimatedPromptTokens + ctx.requestedMaxTokens;

  for (const a of candidates) {
    const unmet: UnmetRequirement[] = [];
    if (!a.capabilities.chat) {
      unmet.push({ requirement: 'capability.chat', required: 'true', actual: 'false' });
    }
    if (needed > a.operational.servedContextTokens) {
      unmet.push({
        requirement: 'context.requestFits',
        required: `<= ${a.operational.servedContextTokens}`,
        actual: `~${needed}`,
      });
    }
    // AUTO does not invent qualification. The gate answers from imported
    // evidence and operator policy, and with neither present it answers no.
    const decision = ctx.qualification.decide(identityOf(a), taskClass);
    decisions.set(a.modelId, decision);
    if (requireQualified && !decision.qualified) {
      unmet.push(...qualificationUnmet(decision, taskClass));
    }
    assessments.push(assess(a, unmet.length === 0, unmet, decision));
    if (unmet.length === 0) eligible.push(a);
  }

  if (eligible.length === 0) {
    const allUnmet = assessments.flatMap((c) => c.unmet);
    const qualificationBlocked = allUnmet.some((u) => u.requirement.startsWith('qualification'));
    const contextBlocked = allUnmet.some((u) => u.requirement.startsWith('context'));
    return escalate(
      'AUTO',
      qualificationBlocked
        ? qualificationEscalateReason(taskClass)
        : contextBlocked
          ? 'CONTEXT_EXCEEDS_LOCAL_CAPABILITY'
          : 'REQUIREMENTS_UNMET',
      qualificationBlocked
        ? 'no installed artifact holds qualification evidence sufficient for this request ' +
          'under the configured policy. Bokahli does not assert fitness it has no evidence for.'
        : 'no installed artifact can serve this request.',
      allUnmet,
      assessments,
    );
  }

  const chosen = pickBest(eligible, ctx, taskClass, assessments);
  const attestation = await ctx.backend.attest(chosen);
  if (!attestation.reachable) {
    return runtimeUnhealthy('AUTO', attestation.reasons, assessments);
  }
  if (!attestation.attested) {
    return escalate(
      'AUTO',
      'REQUIREMENTS_UNMET',
      `the only eligible artifact could not be attested on the live runtime: ` +
        attestation.reasons.join('; '),
      [{ requirement: 'runtime.attested', required: 'true', actual: 'false' }],
      assessments,
    );
  }

  const chosenAssessment = assessments.find((c) => c.modelId === chosen.modelId);
  const basis = chosenAssessment?.rankBasis ?? 'IDENTITY_TIEBREAK';
  const rationale =
    eligible.length === 1
      ? 'Deterministic selection: exactly one installed artifact is eligible. ' +
        (basis === 'IDENTITY_TIEBREAK'
          ? 'No qualification evidence distinguished it, so no fitness ranking was performed or implied.'
          : `Ranked on ${basis.toLowerCase().replace(/_/g, ' ')} from imported evidence.`)
      : `Deterministic rank over ${eligible.length} eligible artifacts, decided by ${basis
          .toLowerCase()
          .replace(/_/g, ' ')}. ` +
        (basis === 'IDENTITY_TIEBREAK'
          ? 'No evidence distinguished these candidates: the order is by identity alone and ' +
            'asserts nothing about fitness. It exists so catalog order cannot change the answer.'
          : 'Ordering comes from imported measurements, never from a score Bokahli invented.');

  return routed('AUTO', chosen, attestation, assessments, rationale,
    requireQualified || taskClass ? (decisions.get(chosen.modelId) ?? null) : null);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assess(
  a: InternalArtifact,
  eligible: boolean,
  unmet: readonly UnmetRequirement[],
  decision: QualificationDecision | null = null,
): CandidateAssessment {
  return {
    modelId: a.modelId,
    digest: a.digest,
    eligible,
    unmet,
    // The catalog's declared state and the evidence-backed decision are
    // reported side by side on purpose. They answer different questions, and a
    // reader who conflates them is exactly the reader this contract is for.
    qualification: a.qualification,
    qualificationDecision: decision,
  };
}

/**
 * Choose among eligible artifacts, deterministically.
 *
 * The ranking is computed over the whole eligible set and written back onto the
 * assessments, so the recorded decision shows not just which artifact won but
 * on what basis — and, critically, when the basis was nothing but identity
 * order. That case is the honest one today, and it should read as such in the
 * audit trail rather than as a judgement.
 */
function pickBest(
  eligible: readonly InternalArtifact[],
  ctx: RouteContext,
  taskClass: string | undefined,
  assessments: CandidateAssessment[],
): InternalArtifact {
  const ranked = rankCandidates(eligible.map((a) => ctx.qualification.rankable(identityOf(a), taskClass)));
  for (const r of ranked) {
    const i = assessments.findIndex((c) => c.modelId === r.modelId);
    const existing = assessments[i];
    if (i >= 0 && existing) {
      assessments[i] = { ...existing, rank: r.rank, rankBasis: r.rankBasis };
    }
  }
  const winner = ranked[0];
  const chosen = winner ? eligible.find((a) => a.modelId === winner.modelId) : undefined;
  // eligible is non-empty at every call site; the fallback keeps that a type
  // fact rather than an assertion.
  return chosen ?? (eligible[0] as InternalArtifact);
}

function servedIdentityOf(a: InternalArtifact, at: Attestation): ServedIdentity {
  return {
    modelId: a.modelId,
    digest: a.digest,
    runtime: {
      engine: 'llama.cpp',
      build: at.build ?? 'unknown',
      executableDigest: null,
      cuda: null,
      driver: null,
    },
    servedContextTokens: at.servedContextTokens ?? a.operational.servedContextTokens,
    qualification: a.qualification,
    attested: at.attested,
    attestationMethod: at.attested ? 'backend-props-match' : 'unverified',
  };
}

function routed(
  mode: RouteDecision['mode'],
  a: InternalArtifact,
  at: Attestation,
  considered: readonly CandidateAssessment[],
  rationale: string,
  qualification: QualificationDecision | null = null,
): RouteDecision {
  return {
    kind: 'ROUTED',
    mode,
    selected: servedIdentityOf(a, at),
    considered,
    rationale,
    qualification,
  };
}

function escalate(
  mode: Escalation['mode'],
  reason: Escalation['reason'],
  detail: string,
  unmet: readonly UnmetRequirement[],
  considered: readonly CandidateAssessment[],
  retryableLocal = false,
): Escalation {
  return {
    kind: 'ESCALATE',
    mode,
    reason,
    detail,
    unmet,
    considered,
    authorityNote: AUTHORITY_NOTE,
    retryableLocal,
  };
}

/**
 * The runtime is not answering.
 *
 * Bokahli's API is deliberately still up to say so. A terminal, typed result
 * beats every alternative available here: hanging until the caller times out
 * teaches them nothing, a 500 says the API is broken when it is not, and
 * answering from anything other than an attested runtime would be a fabricated
 * completion. `retryableLocal` marks this as a health condition — the local
 * route is correct and will serve again once the runtime returns and its exact
 * identity is re-attested.
 */
function runtimeUnhealthy(
  mode: Escalation['mode'],
  reasons: readonly string[],
  considered: readonly CandidateAssessment[],
): Escalation {
  return escalate(
    mode,
    'RUNTIME_UNHEALTHY',
    'the local inference runtime is not answering, so no served identity can be ' +
      'attested and no output can be produced: ' +
      (reasons.join('; ') || 'backend unreachable') +
      '. Bokahli will serve this route again once the runtime is healthy and its ' +
      'exact identity has been re-attested.',
    [{ requirement: 'runtime.reachable', required: 'true', actual: 'false' }],
    considered,
    true,
  );
}

function refuse(
  mode: Refusal['mode'],
  reason: Refusal['reason'],
  detail: string,
  requested: { modelId?: string; artifactDigest?: string },
  ctx: RouteContext,
): Refusal {
  const available = ctx.catalog
    .publicEntries()
    .map((e: CatalogEntry) => ({ modelId: e.modelId, digest: e.digest }));
  return { kind: 'REFUSED', mode, reason, detail, requested, available };
}
