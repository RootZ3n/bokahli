/**
 * Qualification policy evaluation.
 *
 * Evidence says what happened. Policy says what is good enough. Bokahli owns
 * neither: Luak produces the first, an operator decides the second, and this
 * module only applies one to the other and reports the result with its
 * reasoning attached.
 *
 * There are **no default thresholds** here, and that is a deliberate refusal
 * rather than an omission. A minimum pass rate of 0.8, a sample size of 30, a
 * maximum age of 90 days — every one of those numbers would be invented, and
 * an invented threshold that happens to be met is indistinguishable from a real
 * one that was. So an unconfigured policy accepts nothing, and says so with the
 * reason NO_POLICY_CONFIGURED.
 *
 * The other half of the same principle: an unknown measurement is not a passing
 * one. If a policy demands a maximum schema-violation rate and the evidence
 * never measured it, that is a failure to demonstrate compliance, not a
 * demonstration of it.
 */
import {
  notQualified,
  qualificationKeyString,
  type PolicyShortfall,
  type QualificationBundle,
  type QualificationDecision,
  type QualificationPolicy,
  type TaskClass,
} from '@bokahli/contracts';
import type { DeploymentKey, QualificationStore } from './store.js';

const MS_PER_DAY = 86_400_000;

/** True when a policy states no requirement at all. */
export function isEmptyPolicy(policy: QualificationPolicy): boolean {
  return Object.values(policy).every((v) => v === undefined);
}

export interface PolicyEvaluationInput {
  readonly store: QualificationStore;
  readonly deployment: DeploymentKey;
  readonly taskClass: TaskClass;
  readonly taskClassContractVersion: string;
  readonly policy: QualificationPolicy;
  readonly now: Date;
}

/**
 * Decide whether a deployment is qualified for a task class.
 *
 * Order matters and is chosen so the reason returned is the most actionable
 * one: no policy is a configuration problem, no evidence is a testing problem,
 * a DISQUALIFIED verdict is final, and only then are thresholds compared.
 */
export function evaluateQualification(input: PolicyEvaluationInput): QualificationDecision {
  const { store, deployment, taskClass, taskClassContractVersion, policy, now } = input;

  if (isEmptyPolicy(policy)) {
    return notQualified(
      taskClass,
      'NO_POLICY_CONFIGURED',
      `no qualification policy is configured for "${taskClass}". Bokahli will not invent ` +
        'a threshold: choosing what counts as good enough is an operator decision, and ' +
        'until one is made nothing is qualified.',
    );
  }

  const candidates = store.findForTask(deployment, taskClass, taskClassContractVersion);
  if (candidates.length === 0) {
    return notQualified(
      taskClass,
      'NO_EVIDENCE_FOR_KEY',
      `no qualification evidence has been imported for "${taskClass}" against this exact ` +
        `artifact, quantisation, runtime build and hardware profile ` +
        `(${deployment.modelId} @ ${deployment.artifactDigest.slice(0, 19)}…, ` +
        `${deployment.runtimeName}/${deployment.runtimeBuild}, ${deployment.hardwareProfileId}). ` +
        'Absence of evidence is not evidence of capability.',
    );
  }

  // Evaluate each candidate; return the first that qualifies. If none does,
  // report the shortfalls of the newest, which is the one an operator is most
  // likely to be trying to make pass.
  let firstFailure: QualificationDecision | null = null;

  for (const bundle of candidates) {
    const decision = evaluateBundle(bundle, policy, taskClass, now);
    if (decision.qualified) return decision;
    firstFailure ??= decision;
  }

  return (
    firstFailure ??
    notQualified(
      taskClass,
      'MODEL_NOT_QUALIFIED_FOR_TASK',
      'no imported evidence satisfies the configured policy.',
    )
  );
}

/** Apply one policy to one bundle. Exported so a single bundle can be checked. */
export function evaluateBundle(
  bundle: QualificationBundle,
  policy: QualificationPolicy,
  taskClass: string,
  now: Date,
): QualificationDecision {
  const key = bundle.key;
  const agg = bundle.aggregate;
  const shortfalls: PolicyShortfall[] = [];
  // Unknown blocks by default. An operator may opt out per policy, but the
  // opt-out has to be written down.
  const unknownFails = policy.treatUnknownAsFailure !== false;

  const base = {
    taskClass,
    key,
    evidenceHash: bundle.contentHash,
    evidenceGeneratedAt: bundle.generatedAt,
    authority: 'luak' as const,
  };

  // Luak's own verdict is a floor, not a suggestion. No operator policy can
  // promote a DISQUALIFIED artifact, because the policy governs how much
  // evidence Bokahli demands — not what the evidence says.
  if (bundle.verdict === 'DISQUALIFIED') {
    return {
      ...base,
      qualified: false,
      reason: 'DISQUALIFIED_BY_AUTHORITY',
      shortfalls: [{ requirement: 'luak.verdict', required: 'QUALIFIED', actual: 'DISQUALIFIED' }],
      detail:
        'Luak issued DISQUALIFIED for this exact key. Bokahli does not overrule the ' +
        'qualification authority, and no policy setting can.',
    };
  }

  // Staleness first: age is the one input that changes without the evidence
  // changing, so it deserves its own reason code rather than being buried in a
  // list of threshold misses.
  if (policy.maxAgeDays !== undefined) {
    const ageDays = (now.getTime() - Date.parse(bundle.generatedAt)) / MS_PER_DAY;
    if (ageDays > policy.maxAgeDays) {
      return {
        ...base,
        qualified: false,
        reason: 'EVIDENCE_STALE',
        shortfalls: [
          {
            requirement: 'evidence.ageDays',
            required: `<= ${policy.maxAgeDays}`,
            actual: (Math.round(ageDays * 100) / 100).toString(),
          },
        ],
        detail:
          `the newest matching evidence is ${Math.round(ageDays)} days old, past the ` +
          `${policy.maxAgeDays}-day limit this policy sets. It is not wrong, it is simply ` +
          'no longer current enough to rely on.',
      };
    }
  }

  // Identity requirements on the evidence itself.
  if (policy.requiredFixtureSuiteId !== undefined && key.fixtureSuiteId !== policy.requiredFixtureSuiteId) {
    shortfalls.push({
      requirement: 'fixtureSuite.id',
      required: policy.requiredFixtureSuiteId,
      actual: key.fixtureSuiteId,
    });
  }
  if (
    policy.requiredFixtureSuiteVersion !== undefined &&
    key.fixtureSuiteVersion !== policy.requiredFixtureSuiteVersion
  ) {
    shortfalls.push({
      requirement: 'fixtureSuite.version',
      required: policy.requiredFixtureSuiteVersion,
      actual: key.fixtureSuiteVersion,
    });
  }
  if (
    policy.requiredVerificationRegimeVersion !== undefined &&
    key.verificationRegimeVersion !== policy.requiredVerificationRegimeVersion
  ) {
    shortfalls.push({
      requirement: 'verificationRegime.version',
      required: policy.requiredVerificationRegimeVersion,
      actual: key.verificationRegimeVersion,
    });
  }

  // Volume.
  atLeast(shortfalls, 'evidence.sampleCount', agg.sampleCount, policy.minSampleCount);
  atLeast(shortfalls, 'evidence.attemptCount', agg.attemptCount, policy.minAttemptCount);

  // Quality. Each of these is "required but possibly unmeasured", so each
  // routes through a helper that treats null as a shortfall by default.
  let incomplete = false;
  incomplete = atLeastMaybe(shortfalls, 'evidence.passRate', agg.passRate, policy.minPassRate, unknownFails) || incomplete;
  incomplete = atLeastMaybe(shortfalls, 'evidence.meanScore', agg.meanScore, policy.minMeanScore, unknownFails) || incomplete;
  incomplete =
    atLeastMaybe(
      shortfalls,
      'evidence.contextTierTokens',
      agg.contextTierTokens,
      policy.minContextTierTokens,
      unknownFails,
    ) || incomplete;

  const failureRate = agg.passRate === null ? null : 1 - agg.passRate;
  incomplete = atMostMaybe(shortfalls, 'evidence.failureRate', failureRate, policy.maxFailureRate, unknownFails) || incomplete;
  incomplete =
    atMostMaybe(
      shortfalls,
      'evidence.schemaViolationRate',
      agg.schemaViolationRate,
      policy.maxSchemaViolationRate,
      unknownFails,
    ) || incomplete;
  incomplete =
    atMostMaybe(
      shortfalls,
      'evidence.citationViolationRate',
      agg.citationViolationRate,
      policy.maxCitationViolationRate,
      unknownFails,
    ) || incomplete;
  incomplete =
    atMostMaybe(
      shortfalls,
      'evidence.infrastructureFailureRate',
      agg.infrastructureFailureRate,
      policy.maxInfrastructureFailureRate,
      unknownFails,
    ) || incomplete;
  incomplete =
    atMostMaybe(
      shortfalls,
      'evidence.repeatabilityDisagreementRate',
      agg.repeatabilityDisagreementRate,
      policy.maxRepeatabilityDisagreementRate,
      unknownFails,
    ) || incomplete;

  // Blocking failure modes disqualify regardless of every score above them.
  if (policy.blockingFailureModes && policy.blockingFailureModes.length > 0) {
    const hit = agg.knownFailureModes.filter((m) => policy.blockingFailureModes?.includes(m));
    if (hit.length > 0) {
      shortfalls.push({
        requirement: 'evidence.knownFailureModes',
        required: `none of [${policy.blockingFailureModes.join(', ')}]`,
        actual: `[${hit.join(', ')}]`,
      });
    }
  }

  if (shortfalls.length === 0) {
    return {
      ...base,
      qualified: true,
      reason: 'QUALIFIED',
      shortfalls: [],
      detail:
        `Luak issued QUALIFIED for this exact key, and the evidence satisfies every ` +
        `requirement in the configured policy. Key: ${qualificationKeyString(key)}`,
    };
  }

  return {
    ...base,
    qualified: false,
    reason: incomplete ? 'EVIDENCE_INCOMPLETE' : 'MODEL_NOT_QUALIFIED_FOR_TASK',
    shortfalls,
    detail: incomplete
      ? 'the imported evidence does not measure something this policy requires. An ' +
        'unmeasured value is not a passing one; re-run the suite with that measurement ' +
        'enabled, or state explicitly in the policy that unknowns are acceptable.'
      : 'the imported evidence does not meet the configured policy for this task class.',
  };
}

function atLeast(
  out: PolicyShortfall[],
  requirement: string,
  actual: number,
  required: number | undefined,
): void {
  if (required === undefined) return;
  if (actual < required) {
    out.push({ requirement, required: `>= ${required}`, actual: String(actual) });
  }
}

/** Returns true when the shortfall was caused by an unknown rather than a miss. */
function atLeastMaybe(
  out: PolicyShortfall[],
  requirement: string,
  actual: number | null,
  required: number | undefined,
  unknownFails: boolean,
): boolean {
  if (required === undefined) return false;
  if (actual === null) {
    if (!unknownFails) return false;
    out.push({ requirement, required: `>= ${required}`, actual: 'unknown (not measured)' });
    return true;
  }
  if (actual < required) {
    out.push({ requirement, required: `>= ${required}`, actual: fmt(actual) });
  }
  return false;
}

function atMostMaybe(
  out: PolicyShortfall[],
  requirement: string,
  actual: number | null,
  required: number | undefined,
  unknownFails: boolean,
): boolean {
  if (required === undefined) return false;
  if (actual === null) {
    if (!unknownFails) return false;
    out.push({ requirement, required: `<= ${required}`, actual: 'unknown (not measured)' });
    return true;
  }
  if (actual > required) {
    out.push({ requirement, required: `<= ${required}`, actual: fmt(actual) });
  }
  return false;
}

function fmt(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}
