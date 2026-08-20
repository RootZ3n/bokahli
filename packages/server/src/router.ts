import type { Catalog, InternalArtifact } from '@bokahli/catalog';
import type { Attestation, LlamaBackend } from '@bokahli/runtime';
import {
  isPathLike,
  isValidDigest,
  type CandidateAssessment,
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
  readonly queueDepth: number;
  /** Approximate prompt size, used only for context-capability checks. */
  readonly estimatedPromptTokens: number;
  readonly requestedMaxTokens: number;
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
      return decideExact(spec.modelId, spec.artifactDigest, ctx);
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

  return routed('EXACT', artifact, attestation, [assess(artifact, true, [])],
    `EXACT match on catalog identity and artifact digest, attested against the live runtime ` +
    `(build ${attestation.build}).`);
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

  const assessments: CandidateAssessment[] = [];
  const eligible: InternalArtifact[] = [];

  for (const a of candidates) {
    const unmet = evaluateProfile(a, req, ctx);
    assessments.push(assess(a, unmet.length === 0, unmet));
    if (unmet.length === 0) eligible.push(a);
  }

  if (eligible.length === 0) {
    const allUnmet = assessments.flatMap((c) => c.unmet);
    const contextOnly =
      allUnmet.length > 0 && allUnmet.every((u) => u.requirement.startsWith('context'));
    return escalate(
      'PROFILE',
      contextOnly ? 'CONTEXT_EXCEEDS_LOCAL_CAPABILITY' : 'REQUIREMENTS_UNMET',
      'no installed artifact satisfies the caller-defined profile. Bokahli will ' +
        'not substitute a model that fails the stated constraints.',
      allUnmet,
      assessments,
    );
  }

  const chosen = eligible[0] as InternalArtifact;
  const attestation = await ctx.backend.attest(chosen);
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
    `Selected the single installed artifact that satisfies every stated requirement. ` +
    `${assessments.length - eligible.length} candidate(s) were excluded for unmet constraints.`);
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
  if (req.requireQualified === true && a.qualification.status !== 'QUALIFIED') {
    unmet.push({
      requirement: 'qualification.status',
      required: 'QUALIFIED (issued by Luak)',
      actual: a.qualification.status,
    });
  }
  if (req.requiredTaskClass) {
    if (!a.qualification.qualifiedTaskClasses.includes(req.requiredTaskClass)) {
      unmet.push({
        requirement: 'qualification.qualifiedTaskClasses',
        required: `includes "${req.requiredTaskClass}"`,
        actual:
          a.qualification.qualifiedTaskClasses.length === 0
            ? '[] (no Luak evidence installed)'
            : `[${a.qualification.qualifiedTaskClasses.join(', ')}]`,
      });
    }
  }
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
    // AUTO does not invent qualification. With no Luak evidence installed, a
    // caller that demands a qualified route gets an escalation, not a guess.
    if (requireQualified && a.qualification.status !== 'QUALIFIED') {
      unmet.push({
        requirement: 'qualification.status',
        required: 'QUALIFIED (issued by Luak)',
        actual: a.qualification.status,
      });
    }
    if (taskClass && requireQualified &&
        !a.qualification.qualifiedTaskClasses.includes(taskClass)) {
      unmet.push({
        requirement: `qualification.taskClass.${taskClass}`,
        required: 'qualified',
        actual: 'no Luak evidence installed',
      });
    }
    assessments.push(assess(a, unmet.length === 0, unmet));
    if (unmet.length === 0) eligible.push(a);
  }

  if (eligible.length === 0) {
    const allUnmet = assessments.flatMap((c) => c.unmet);
    const qualificationBlocked = allUnmet.some((u) => u.requirement.startsWith('qualification'));
    const contextBlocked = allUnmet.some((u) => u.requirement.startsWith('context'));
    return escalate(
      'AUTO',
      qualificationBlocked
        ? 'NO_QUALIFIED_LOCAL_ROUTE'
        : contextBlocked
          ? 'CONTEXT_EXCEEDS_LOCAL_CAPABILITY'
          : 'REQUIREMENTS_UNMET',
      qualificationBlocked
        ? 'no installed artifact carries Luak qualification. Bokahli does not ' +
          'assert fitness it has no evidence for.'
        : 'no installed artifact can serve this request.',
      allUnmet,
      assessments,
    );
  }

  // Phase 1: exactly one artifact is installed, so selection is deterministic.
  // It still passes through the contract, and the rationale says plainly that
  // this is a single-candidate selection rather than a ranked judgement.
  const chosen = eligible[0] as InternalArtifact;
  const attestation = await ctx.backend.attest(chosen);
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

  const rationale =
    eligible.length === 1
      ? `Deterministic selection: exactly one installed artifact is eligible. No ` +
        `qualification evidence exists, so no fitness ranking was performed or implied.`
      : `Deterministic selection over ${eligible.length} eligible artifacts in catalog order. ` +
        `No qualification evidence exists, so no fitness ranking was performed.`;

  return routed('AUTO', chosen, attestation, assessments, rationale);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assess(
  a: InternalArtifact,
  eligible: boolean,
  unmet: readonly UnmetRequirement[],
): CandidateAssessment {
  return {
    modelId: a.modelId,
    digest: a.digest,
    eligible,
    unmet,
    qualification: a.qualification,
  };
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
): RouteDecision {
  return { kind: 'ROUTED', mode, selected: servedIdentityOf(a, at), considered, rationale };
}

function escalate(
  mode: Escalation['mode'],
  reason: Escalation['reason'],
  detail: string,
  unmet: readonly UnmetRequirement[],
  considered: readonly CandidateAssessment[],
): Escalation {
  return { kind: 'ESCALATE', mode, reason, detail, unmet, considered, authorityNote: AUTHORITY_NOTE };
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
