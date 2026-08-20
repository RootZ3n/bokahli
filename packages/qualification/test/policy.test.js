/**
 * Qualification policy.
 *
 * The property under test throughout is that nothing is granted by default.
 * An unconfigured policy, missing evidence, evidence for a different key, and
 * an unmeasured value all produce the same answer — not qualified — with four
 * different reasons, so an operator can tell which problem they have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QualificationStore } from '../dist/store.js';
import { evaluateQualification, evaluateBundle, isEmptyPolicy } from '../dist/policy.js';
import {
  DIGEST_A,
  DIGEST_B,
  HARDWARE_PROFILE,
  MODEL_A,
  MODEL_B,
  NOW,
  QUANT,
  RUNTIME_BUILD,
  RUNTIME_NAME,
  aggregateOf,
  attempt,
  bundle,
  completePolicy,
  importContext,
  trustedImportContext,
  unknownCompliance,
} from './fixtures.js';

const DEPLOYMENT = {
  modelId: MODEL_A,
  artifactDigest: DIGEST_A,
  quantization: QUANT,
  runtimeName: RUNTIME_NAME,
  runtimeBuild: RUNTIME_BUILD,
  hardwareProfileId: HARDWARE_PROFILE,
};

/**
 * A store whose contents the operator has pinned. Every test that expects a
 * qualification has to go through here, which keeps the trust step visible
 * rather than ambient.
 */
function storeWith(...bundles) {
  const store = QualificationStore.empty();
  const report = store.load(bundles, trustedImportContext(bundles));
  assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected, null, 2));
  return store;
}

/** A store holding the same evidence with no operator authorisation. */
function untrustedStoreWith(...bundles) {
  const store = QualificationStore.empty();
  const report = store.load(bundles, importContext());
  assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected, null, 2));
  return store;
}

function evaluate(store, policy, overrides = {}) {
  return evaluateQualification({
    store,
    deployment: DEPLOYMENT,
    taskClass: 'test_log_triage',
    taskClassContractVersion: '1.0.0',
    policy,
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// the default is no
// ---------------------------------------------------------------------------

test('an empty policy is recognised as stating nothing', () => {
  assert.equal(isEmptyPolicy({}), true);
  assert.equal(isEmptyPolicy({ minSampleCount: 1 }), false);
});

test('no policy configured qualifies nothing, even with perfect evidence', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, {});
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'NO_POLICY_CONFIGURED');
  assert.match(d.detail, /operator decision/);
});

test('an empty store qualifies nothing', () => {
  const d = evaluate(QualificationStore.empty(), completePolicy());
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'NO_EVIDENCE_FOR_KEY');
  assert.match(d.detail, /Absence of evidence is not evidence of capability/);
});

test('evidence for a different artifact does not qualify this one', () => {
  const store = storeWith(bundle({ key: { modelId: MODEL_B, artifactDigest: DIGEST_B } }));
  const d = evaluate(store, completePolicy({ minSampleCount: 1 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'NO_EVIDENCE_FOR_KEY');
});

test('evidence for a different task class does not qualify this one', () => {
  const store = storeWith(bundle({ key: { taskClass: 'repo_reconnaissance' } }));
  const d = evaluate(store, completePolicy({ minSampleCount: 1 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'NO_EVIDENCE_FOR_KEY');
});

test('the authority is never reported as bokahli', () => {
  const store = storeWith(bundle());
  assert.equal(evaluate(store, {}).authority, 'none');
  assert.equal(evaluate(store, completePolicy({ minSampleCount: 1 })).authority, 'luak');
});

// ---------------------------------------------------------------------------
// satisfaction
// ---------------------------------------------------------------------------

test('evidence that satisfies a stated policy qualifies', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ minSampleCount: 4, minPassRate: 0.7, maxAgeDays: 30 }));
  assert.equal(d.qualified, true, JSON.stringify(d.shortfalls));
  assert.equal(d.reason, 'QUALIFIED');
  assert.equal(d.authority, 'luak');
  assert.ok(d.evidenceHash.startsWith('sha256:'));
});

test('the decision names the evidence it relied on', () => {
  const b = bundle();
  const store = storeWith(b);
  const d = evaluate(store, completePolicy({ minSampleCount: 1 }));
  assert.equal(d.evidenceHash, b.contentHash);
  assert.equal(d.evidenceGeneratedAt, b.generatedAt);
});

// ---------------------------------------------------------------------------
// thresholds
// ---------------------------------------------------------------------------

test('insufficient sample count blocks qualification', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ minSampleCount: 30 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  assert.deepEqual(d.shortfalls, [
    { requirement: 'evidence.sampleCount', required: '>= 30', actual: '4' },
  ]);
});

test('a pass-rate threshold that is not met blocks qualification', () => {
  const store = storeWith(bundle()); // 3 of 4 pass
  const d = evaluate(store, completePolicy({ minPassRate: 0.9 }));
  assert.equal(d.qualified, false);
  assert.equal(d.shortfalls[0].requirement, 'evidence.passRate');
  assert.equal(d.shortfalls[0].actual, '0.75');
});

test('a maximum failure rate is enforced', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ maxFailureRate: 0.1 }));
  assert.equal(d.qualified, false);
  assert.equal(d.shortfalls[0].requirement, 'evidence.failureRate');
});

test('a required fixture suite version is enforced', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ requiredFixtureSuiteVersion: '2.0.0' }));
  assert.equal(d.qualified, false);
  assert.ok(d.shortfalls.some((s) => s.requirement === 'fixtureSuite.version'));
});

test('a required verification regime is enforced', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ requiredVerificationRegimeVersion: 'judged-2' }));
  assert.equal(d.qualified, false);
  assert.ok(d.shortfalls.some((s) => s.requirement === 'verificationRegime.version'));
});

test('a minimum context tier is enforced', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ minContextTierTokens: 65536 }));
  assert.equal(d.qualified, false);
  assert.ok(d.shortfalls.some((s) => s.requirement === 'evidence.contextTierTokens'));
});

test('a blocking failure mode disqualifies regardless of scores', () => {
  const store = storeWith(bundle({ aggregate: { knownFailureModes: ['FABRICATED_EVIDENCE'] } }));
  const d = evaluate(store, completePolicy({
    minPassRate: 0,
    blockingFailureModes: ['FABRICATED_EVIDENCE'],
  }));
  assert.equal(d.qualified, false);
  assert.ok(d.shortfalls.some((s) => s.requirement === 'evidence.knownFailureModes'));
});

test('every unmet requirement is reported, not just the first', () => {
  const store = storeWith(bundle());
  const d = evaluate(store, completePolicy({ minSampleCount: 30, minPassRate: 0.99, minMeanScore: 0.99 }));
  const names = d.shortfalls.map((s) => s.requirement);
  assert.ok(names.includes('evidence.sampleCount'));
  assert.ok(names.includes('evidence.passRate'));
  assert.ok(names.includes('evidence.meanScore'));
});

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

test('evidence older than the policy allows is stale, not merely unqualified', () => {
  const store = storeWith(bundle({ generatedAt: '2026-01-01T00:00:00.000Z' }));
  const d = evaluate(store, completePolicy({ maxAgeDays: 30 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'EVIDENCE_STALE');
  assert.equal(d.shortfalls[0].requirement, 'evidence.ageDays');
});

test('a policy with no age limit does not make old evidence fresh', () => {
  // It qualifies, but only because the operator declined to set a limit. The
  // decision still names the age of what it relied on.
  const store = storeWith(bundle({ generatedAt: '2026-01-01T00:00:00.000Z' }));
  const d = evaluate(store, completePolicy({ minSampleCount: 1 }));
  assert.equal(d.qualified, true);
  assert.equal(d.evidenceGeneratedAt, '2026-01-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// unknown is not favourable
// ---------------------------------------------------------------------------

test('an unmeasured value does not satisfy a requirement about it', () => {
  const attempts = [
    attempt({ attemptId: 'a1', fixtureId: 'fx-1', compliance: unknownCompliance() }),
    attempt({ attemptId: 'a2', fixtureId: 'fx-2', compliance: unknownCompliance() }),
  ];
  const store = storeWith(bundle({ attempts, aggregate: aggregateOf(attempts) }));
  const d = evaluate(store, completePolicy({ maxSchemaViolationRate: 0 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'EVIDENCE_INCOMPLETE');
  assert.equal(d.shortfalls[0].actual, 'unknown (not measured)');
});

test('an operator may accept unknowns, but must say so explicitly', () => {
  const attempts = [
    attempt({ attemptId: 'a1', fixtureId: 'fx-1', compliance: unknownCompliance() }),
    attempt({ attemptId: 'a2', fixtureId: 'fx-2', compliance: unknownCompliance() }),
  ];
  const store = storeWith(bundle({ attempts, aggregate: aggregateOf(attempts) }));
  const d = evaluate(store, completePolicy({
    maxSchemaViolationRate: 0,
    treatUnknownAsFailure: false,
  }));
  assert.equal(d.qualified, true);
});

test('unmeasured repeatability does not read as perfect repeatability', () => {
  const store = storeWith(bundle()); // no repeated fixtures => null
  const d = evaluate(store, completePolicy({ maxRepeatabilityDisagreementRate: 0 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'EVIDENCE_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// the authority floor
// ---------------------------------------------------------------------------

test('a DISQUALIFIED verdict cannot be overridden by any policy', () => {
  const b = bundle({ verdict: 'DISQUALIFIED' });
  const store = storeWith(b);
  const entry = store.findForTask(DEPLOYMENT, 'test_log_triage', '1.0.0')[0];
  const d = evaluateBundle(entry, completePolicy({ minSampleCount: 0, minPassRate: 0 }), 'test_log_triage', NOW);
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'DISQUALIFIED_BY_AUTHORITY');
  assert.match(d.detail, /does not overrule the qualification authority/);
});

test('a loose policy cannot promote disqualified evidence via the store either', () => {
  const store = storeWith(bundle({ verdict: 'DISQUALIFIED' }));
  const d = evaluate(store, completePolicy({ minSampleCount: 0 }));
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'DISQUALIFIED_BY_AUTHORITY');
});

// ---------------------------------------------------------------------------
// store behaviour
// ---------------------------------------------------------------------------

test('rejected bundles are reported per bundle, and do not poison the batch', () => {
  const store = QualificationStore.empty();
  const report = store.load([bundle(), { nonsense: true }], importContext());
  assert.equal(report.accepted, 1);
  assert.equal(report.rejected.length, 1);
  assert.equal(report.rejected[0].index, 1);
});

test('a duplicate within one batch is caught', () => {
  const store = QualificationStore.empty();
  const b = bundle();
  const report = store.load([b, b], importContext());
  assert.equal(report.accepted, 1);
  assert.equal(report.rejected[0].errors[0].code, 'DUPLICATE_KEY');
});

test('lookup is exact: one wrong key element is a miss', () => {
  const store = storeWith(bundle());
  assert.equal(store.findForTask(DEPLOYMENT, 'test_log_triage', '1.0.0').length, 1);
  assert.equal(
    store.findForTask({ ...DEPLOYMENT, runtimeBuild: 'b00002-other' }, 'test_log_triage', '1.0.0').length,
    0,
  );
  assert.equal(store.findForTask(DEPLOYMENT, 'test_log_triage', '0.9.0').length, 0);
});
