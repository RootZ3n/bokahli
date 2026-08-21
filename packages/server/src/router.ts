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
  type QualificationFacts,
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
  /**
   * Phase B2 provenance facts for the artifact being routed to.
   *
   * Supplied by the caller rather than gathered here so routing stays a pure
   * decision over inputs. A router that reached out to probe the GPU mid-decision
   * would be a router whose outcome depends on the weather.
   */
  readonly qualificationFacts: (a: InternalArtifact, at: Attestation) => Promise<QualificationFacts>;
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

  return await routed('EXACT', artifact, attestation, [assess(artifact, true, [], decision)],
    `EXACT match on catalog identity and artifact digest, attested against the live runtime ` +
    `(build ${attestation.build}).` +
    (taskClass ? ` Qualification for "${taskClass}": ${decision.reason}.` : ''),
    ctx, taskClass ? decision : null);
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

  // One attestation, of the top-ranked eligible artifact. Residency is read from
  // it, and a second round-trip happens only when the resident artifact is not
  // the one ranking would have named.
  const ranked = pickBest(eligible, ctx, taskClass, assessments);
  const probe = await ctx.backend.attest(ranked);
  const pick = preferResident('PROFILE', ranked, probe, candidates, eligible, assessments);
  if ('escalation' in pick) return pick.escalation;
  const chosen = pick.chosen;
  const attestation = pick.reuseAttestation ? probe : await ctx.backend.attest(chosen);
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
  return await routed('PROFILE', chosen, attestation, assessments,
    `Selected by deterministic rank over ${eligible.length} artifact(s) that satisfy every ` +
    `stated requirement. ${assessments.length - eligible.length} candidate(s) were excluded ` +
    'for unmet constraints.',
    ctx, wantsQualification ? (decisions.get(chosen.modelId) ?? null) : null);
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


/**
 * Prefer what is already loaded, and say so plainly when nothing loaded fits.
 *
 * Bokahli serves one model at a time and cannot swap: starting a different
 * artifact is an operator action through `bokahli-runtime.service`. Before this
 * existed, AUTO and PROFILE ranked the catalog, picked a winner, and then failed
 * `attest()` when the winner was not the resident artifact — a correct refusal
 * carrying a misleading reason, because the artifact met every stated
 * requirement and was simply not loaded. That is a different thing from
 * "nothing installed can serve this", and the difference is what tells a caller
 * whether to fall back to a remote provider or ask for a swap.
 *
 * It takes the attestation the caller already had to fetch rather than probing
 * again. The first version made its own `attest()` call, which doubled the
 * backend round-trips on every routed request; the extra socket was enough to
 * stop `node --test` exiting after a suite that passed, which is a fair warning
 * about a request path that quietly does twice the I/O it needs.
 *
 * `attestation.alias` is what the backend says it is serving, so residency is
 * read from the same observation that decides identity — not from a second one
 * that could disagree with it.
 *
 * It reports and never acts. One caller's routing preference must not evict
 * another caller's working deployment, so there is no path here that unloads
 * anything.
 */
function preferResident(
  mode: 'AUTO' | 'PROFILE',
  ranked: InternalArtifact,
  attestation: Attestation,
  candidates: readonly InternalArtifact[],
  eligible: InternalArtifact[],
  assessments: CandidateAssessment[],
): { chosen: InternalArtifact; reuseAttestation: boolean } | { escalation: RouteOutcome } {
  const residentAlias = attestation.alias ?? null;
  const resident = residentAlias === null
    ? null
    : candidates.find((a) => a.runtimeAlias === residentAlias) ?? null;
  const residentEligible = resident !== null && eligible.some((a) => a.modelId === resident.modelId);

  if (residentEligible) {
    const chosen = resident as InternalArtifact;
    return { chosen, reuseAttestation: chosen.modelId === ranked.modelId };
  }

  // An unreachable runtime is a different statement with its own reason. Do not
  // relabel an outage as a swap.
  if (!attestation.reachable) {
    return { escalation: runtimeUnhealthy(mode, attestation.reasons, assessments) };
  }

  const ordered = [ranked, ...eligible.filter((a) => a.modelId !== ranked.modelId)];
  const residentAssessment = resident === null
    ? null
    : assessments.find((c) => c.modelId === resident.modelId) ?? null;

  const base = escalate(
    mode,
    'LOCAL_MODEL_SWAP_REQUIRED',
    resident === null
      ? `no catalogued artifact is loaded; ${ordered.length} installed artifact(s) satisfy this ` +
        'request and one must be started before it can be served.'
      : `the loaded artifact "${resident.modelId}" does not satisfy this request, and ` +
        `${ordered.length} installed artifact(s) do. Bokahli serves one model at a time and does ` +
        "not unload the resident model on a request's behalf.",
    residentAssessment?.unmet ?? [],
    assessments,
  );
  return {
    escalation: {
      ...base,
      swap: {
        residentModelId: resident?.modelId ?? null,
        residentUnmet: residentAssessment?.unmet ?? [],
        candidates: ordered.map((a) => ({
          modelId: a.modelId,
          digest: a.digest,
          coldLoadSeconds: a.operational.coldLoadSeconds ?? null,
          vramMiB: a.operational.vramMiB ?? null,
        })),
      },
    } as RouteOutcome,
  };
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

  // One attestation, of the top-ranked eligible artifact. Residency is read from
  // it, and a second round-trip happens only when the resident artifact is not
  // the one ranking would have named.
  const ranked = pickBest(eligible, ctx, taskClass, assessments);
  const probe = await ctx.backend.attest(ranked);
  const pick = preferResident('AUTO', ranked, probe, candidates, eligible, assessments);
  if ('escalation' in pick) return pick.escalation;
  const chosen = pick.chosen;
  const attestation = pick.reuseAttestation ? probe : await ctx.backend.attest(chosen);
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

  return await routed('AUTO', chosen, attestation, assessments, rationale,
    ctx, requireQualified || taskClass ? (decisions.get(chosen.modelId) ?? null) : null);
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

function servedIdentityOf(
  a: InternalArtifact,
  at: Attestation,
  facts: QualificationFacts,
): ServedIdentity {
  return {
    modelId: a.modelId,
    digest: a.digest,
    runtime: {
      engine: 'llama.cpp',
      build: at.build ?? 'unknown',
      // Populated from the same observation the facts carry, so the summary
      // field and the detailed one can never disagree. Both were hardcoded
      // null before Phase B2.
      executableDigest: facts.runtime.imageDigest,
      cuda: facts.runtime.processCudaRuntime,
      driver: facts.runtime.driverVersion,
    },
    servedContextTokens: at.servedContextTokens ?? a.operational.servedContextTokens,
    qualification: a.qualification,
    attested: at.attested,
    attestationMethod: at.attested ? 'backend-props-match' : 'unverified',
    qualificationFacts: facts,
  };
}

async function routed(
  mode: RouteDecision['mode'],
  a: InternalArtifact,
  at: Attestation,
  considered: readonly CandidateAssessment[],
  rationale: string,
  ctx: RouteContext,
  qualification: QualificationDecision | null = null,
): Promise<RouteDecision> {
  return {
    kind: 'ROUTED',
    mode,
    selected: servedIdentityOf(a, at, await ctx.qualificationFacts(a, at)),
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
    unmet: dedupeUnmet(unmet),
    considered,
    authorityNote: AUTHORITY_NOTE,
    retryableLocal,
  };
}

/**
 * Collapse identical unmet requirements.
 *
 * The top-level `unmet` list summarises why the request could not be served.
 * When every candidate fails the same requirement — which is what happens for a
 * whole-catalog condition like "nothing here is qualified" — it accumulated one
 * identical entry per artifact. With one artifact installed that was invisible;
 * at five it is the same sentence five times, and it grows with the catalog,
 * so the summary gets less readable exactly as it covers more.
 *
 * Nothing is lost by collapsing it. The per-artifact truth is in `considered`,
 * where each assessment carries its own `unmet`, its `qualification.status` and
 * a `qualificationDecision.detail` naming the artifact — strictly more than the
 * duplicates held. A caller wanting per-artifact reasons reads `considered`; a
 * caller wanting the summary gets a summary.
 *
 * Order is preserved: the first occurrence of each distinct requirement stays
 * where it was, so `unmet[0]` remains the primary reason.
 */
function dedupeUnmet(unmet: readonly UnmetRequirement[]): UnmetRequirement[] {
  const seen = new Set<string>();
  const out: UnmetRequirement[] = [];
  for (const u of unmet) {
    const k = `${u.requirement}\u0000${u.required}\u0000${u.actual}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
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
