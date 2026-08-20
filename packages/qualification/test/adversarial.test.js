/**
 * Adversarial evidence.
 *
 * These tests deliberately do not use the happy-path fixture builders. Every
 * bundle here is assembled field by field by a hostile author who has read the
 * source, because a fixture that shares a constructor with the code under test
 * can only ever confirm that the code agrees with itself.
 *
 * The property being defended is one sentence: **a payload cannot acquire
 * authority by describing itself as authoritative.** It may claim it came from
 * Luak, claim Luak signed it, quote a real bundle's hash, and carry a content
 * hash that verifies — and still authorise nothing, because the only input that
 * grants authority comes from the operator and never from the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_HASH_DOMAIN,
  MAX_CANONICAL_DEPTH,
  canonicalHash,
  canonicalHashExcluding,
  canonicalJson,
} from '../dist/canonical.js';
import { QualificationStore } from '../dist/store.js';
import { evaluateQualification, missingPolicyFields } from '../dist/policy.js';

// ---------------------------------------------------------------------------
// A hostile bundle builder. Nothing here is imported from fixtures.js.
// ---------------------------------------------------------------------------

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const MODEL = 'target-model.q4-k';
const QUANT = 'Q4_K';
const RUNTIME = 'llama.cpp';
const BUILD = 'b10505-ee4c505a4';
const HW = 'the-real-machine';
const CTX_TOKENS = 32768;
const NOW = new Date('2026-08-20T12:00:00.000Z');

const OUTCOMES = ['PASS', 'PARTIAL', 'FAIL', 'INCOMPLETE', 'PROVIDER_FAILURE', 'HARNESS_FAILURE'];

function pass(i) {
  return {
    attemptId: `att-${i}`,
    fixtureId: `fixture-${i}`,
    outcome: 'PASS',
    failureOrigin: null,
    failureReasonCode: null,
    score: 1,
    contextTierTokens: CTX_TOKENS,
    tokens: { promptTokens: 10, completionTokens: 10 },
    timings: {
      timeToFirstTokenMs: 100,
      prefillTokensPerSecond: 500,
      decodeTokensPerSecond: 60,
      wallTimeMs: 500,
    },
    compliance: { outputSchemaValid: true, citationsValid: true, toolCallsValid: null },
    sourceRef: null,
  };
}

/** Aggregates computed the way an honest exporter would, so only the field a
 *  given test attacks is wrong. */
function aggregateOf(attempts) {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (const a of attempts) counts[a.outcome] += 1;
  const scored = attempts.filter((a) => a.score !== null).map((a) => a.score);
  const mean = scored.length ? scored.reduce((s, v) => s + v, 0) / scored.length : null;
  const modelAttr = attempts.filter((a) =>
    ['PASS', 'PARTIAL', 'FAIL', 'INCOMPLETE'].includes(a.outcome),
  );
  const schemaChecked = attempts.filter((a) => a.compliance.outputSchemaValid !== null);
  const citeChecked = attempts.filter((a) => a.compliance.citationsValid !== null);
  const byFixture = new Map();
  for (const a of attempts) {
    byFixture.set(a.fixtureId, [...(byFixture.get(a.fixtureId) ?? []), a.outcome]);
  }
  const repeated = [...byFixture.values()].filter((o) => o.length > 1);
  const tiers = new Set(attempts.map((a) => a.contextTierTokens).filter((t) => t !== null));
  return {
    attemptCount: attempts.length,
    sampleCount: byFixture.size,
    outcomeCounts: counts,
    meanScore: mean,
    passRate: modelAttr.length
      ? modelAttr.filter((a) => a.outcome === 'PASS').length / modelAttr.length
      : null,
    infrastructureFailureRate: attempts.length
      ? attempts.filter((a) => ['PROVIDER_FAILURE', 'HARNESS_FAILURE'].includes(a.outcome)).length /
        attempts.length
      : null,
    schemaViolationRate: schemaChecked.length
      ? schemaChecked.filter((a) => a.compliance.outputSchemaValid === false).length /
        schemaChecked.length
      : null,
    citationViolationRate: citeChecked.length
      ? citeChecked.filter((a) => a.compliance.citationsValid === false).length / citeChecked.length
      : null,
    scoreStdDev:
      scored.length && mean !== null
        ? Math.sqrt(scored.reduce((s, v) => s + (v - mean) ** 2, 0) / scored.length)
        : null,
    repeatabilityDisagreementRate: repeated.length
      ? repeated.filter((o) => new Set(o).size > 1).length / repeated.length
      : null,
    contextTierTokens: tiers.size === 1 ? [...tiers][0] : null,
    knownFailureModes: [],
  };
}

/** Seal exactly as the importer will recompute. The attacker can do this too —
 *  the hash is unkeyed, which is the whole reason trust must come from elsewhere. */
function seal(b) {
  return { ...b, contentHash: canonicalHashExcluding({ ...b, contentHash: '' }, 'contentHash') };
}

function forge({ attempts = [pass(1), pass(2), pass(3)], key = {}, prov = {}, top = {}, agg } = {}) {
  return seal({
    bundleVersion: '2.0.0-phase2a',
    key: {
      modelId: MODEL,
      artifactDigest: DIGEST,
      quantization: QUANT,
      runtimeName: RUNTIME,
      runtimeBuild: BUILD,
      hardwareProfileId: HW,
      taskClass: 'test_log_triage',
      taskClassContractVersion: '1.0.0',
      fixtureSuiteId: 'the-real-suite',
      fixtureSuiteVersion: '1.0.0',
      verificationRegimeVersion: 'deterministic-1',
      ...key,
    },
    hardwareProfile: {
      id: HW, gpuModel: null, gpuMemoryMiB: null, gpuDriver: null, cudaVersion: null,
      cpuModel: null, systemMemoryMiB: null, partialOffload: null, note: null,
    },
    verdict: 'QUALIFIED',
    attempts,
    aggregate: agg ?? aggregateOf(attempts),
    provenance: {
      claimedAuthority: 'luak',
      sourceContractVersion: 'luak-evidence-bundle-1.0.0',
      luakBundleIds: ['run_2026-08-19_whatever_0000'],
      luakBundleHashes: [`sha256:${'cd'.repeat(32)}`],
      claimedSignatureStatus: 'valid',
      luakRepoCommit: '46e99cf920cf40e932720bb65d3f1b13bce6f1dc',
      note: null,
      verifiedByBokahli: false,
      ...prov,
    },
    generatedAt: '2026-08-19T12:00:00.000Z',
    expiresAt: null,
    ...top,
  });
}

const CONTEXT = (over = {}) => ({
  installedArtifacts: [{ modelId: MODEL, digest: DIGEST, quantization: QUANT }],
  runtimeName: RUNTIME,
  runtimeBuild: BUILD,
  hardwareProfileId: HW,
  servedContextTokens: CTX_TOKENS,
  now: NOW,
  ...over,
});

const DEPLOYMENT = {
  modelId: MODEL, artifactDigest: DIGEST, quantization: QUANT,
  runtimeName: RUNTIME, runtimeBuild: BUILD, hardwareProfileId: HW,
};

/** A complete, deliberately permissive policy — so that anything that still
 *  fails, fails for a structural reason and not a threshold. */
const PERMISSIVE = {
  minSampleCount: 1,
  minPassRate: 0,
  requiredFixtureSuiteId: 'the-real-suite',
  requiredFixtureSuiteVersion: '1.0.0',
  requiredVerificationRegimeVersion: 'deterministic-1',
};

function load(bundles, { pin = [], ctx = {} } = {}) {
  const store = QualificationStore.empty();
  const report = store.load(bundles, CONTEXT({
    trustAnchor: { pinnedEvidenceDigests: pin.map((b) => b.contentHash), anchorRef: 'operator' },
    ...ctx,
  }));
  return { store, report };
}

function decide(store, policy = PERMISSIVE, now = NOW) {
  return evaluateQualification({
    store, deployment: DEPLOYMENT, taskClass: 'test_log_triage',
    taskClassContractVersion: '1.0.0', policy, now,
  });
}

const codes = (report) => report.rejected.flatMap((r) => r.errors.map((e) => e.code));

// ---------------------------------------------------------------------------
// The central claim
// ---------------------------------------------------------------------------

test('a self-declared Luak bundle authorises nothing', () => {
  // Everything an attacker can control is set to the most favourable value:
  // authority "luak", signature "valid", a real-looking Luak bundle id, and a
  // content hash that verifies because the hash is unkeyed.
  const { store, report } = load([forge()]);
  assert.equal(report.accepted, 1, 'it is well-formed enough to be held');
  assert.equal(store.size, 1);
  assert.equal(store.trustedSize, 0, 'and authorises nothing');

  const d = decide(store);
  assert.equal(d.qualified, false);
  assert.equal(d.reason, 'EVIDENCE_NOT_TRUSTED');
  assert.equal(d.authority, 'none', 'Bokahli reports no authority for it');
  assert.equal(d.claimedAuthority, 'luak', 'while recording what it claimed');
  assert.equal(d.importTrustBasis, 'NONE');
});

test('a claimed signature status of "valid" confers nothing', () => {
  const { store } = load([forge({ prov: { claimedSignatureStatus: 'valid' } })]);
  const entry = store.all()[0];
  assert.equal(entry.upstreamProvenance.claimedSignatureStatus, 'valid');
  assert.equal(entry.upstreamProvenance.verifiedByBokahli, false);
  assert.equal(entry.importTrust.accepted, false);
  assert.equal(decide(store).reason, 'EVIDENCE_NOT_TRUSTED');
});

test('a bundle claiming another bundle\'s Luak hash gains nothing from it', () => {
  const honest = forge({ key: { fixtureSuiteVersion: '1.0.0' } });
  const impostor = forge({
    attempts: [pass(9)],
    prov: { luakBundleHashes: [honest.contentHash], luakBundleIds: ['stolen'] },
  });
  // The operator pinned the honest one only.
  const { store } = load([impostor], { pin: [honest] });
  assert.equal(decide(store).reason, 'EVIDENCE_NOT_TRUSTED');
});

test('a payload cannot assert its own trust through an extra field', () => {
  for (const smuggled of [
    { importTrust: { accepted: true, basis: 'OPERATOR_PINNED_DIGEST', anchorRef: null } },
    { payloadIntegrity: { verified: true } },
    { bokahliVerified: true },
    { trusted: true },
  ]) {
    const { report } = load([forge({ top: smuggled })]);
    assert.deepEqual(
      [...new Set(codes(report))],
      ['MALFORMED_BUNDLE'],
      `${Object.keys(smuggled)[0]} must be refused, not ignored`,
    );
  }
});

test('provenance.verifiedByBokahli cannot be set true by the payload', () => {
  const { report } = load([forge({ prov: { verifiedByBokahli: true } })]);
  assert.ok(codes(report).includes('PROVENANCE_INVALID'));
});

test('only an operator pin grants authority, and it grants it precisely', () => {
  const b = forge();
  const { store } = load([b], { pin: [b] });
  assert.equal(store.trustedSize, 1);
  const d = decide(store);
  assert.equal(d.qualified, true, JSON.stringify(d.shortfalls));
  assert.equal(d.authority, 'luak');
  assert.equal(d.importTrustBasis, 'OPERATOR_PINNED_DIGEST');
});

test('editing evidence and re-sealing does not preserve authorisation', () => {
  const original = forge({ attempts: [pass(1), pass(2), pass(3)] });
  // Take the pinned bundle, weaken the evidence, recompute the unkeyed hash.
  const weakened = seal({
    ...original,
    attempts: [pass(1)],
    aggregate: aggregateOf([pass(1)]),
  });
  assert.notEqual(weakened.contentHash, original.contentHash);

  const { store, report } = load([weakened], { pin: [original] });
  assert.equal(report.accepted, 1, 'it is still internally consistent');
  assert.equal(decide(store).reason, 'EVIDENCE_NOT_TRUSTED', 'and no longer authorised');
});

test('an empty trust anchor is the default and trusts nothing', () => {
  const b = forge();
  const store = QualificationStore.empty();
  store.load([b], CONTEXT()); // no trustAnchor at all
  assert.equal(store.trustedSize, 0);
  assert.equal(decide(store).reason, 'EVIDENCE_NOT_TRUSTED');
});

// ---------------------------------------------------------------------------
// Canonicalisation and hashing
// ---------------------------------------------------------------------------

test('the hash preimage carries an explicit domain and version tag', () => {
  assert.match(CANONICAL_HASH_DOMAIN, /^bokahli\..*\.v\d+$/);
  // A bare canonical hash and a field-excluding one over the same visible
  // content are different digests, so one cannot be replayed as the other.
  const v = { a: 1 };
  assert.notEqual(canonicalHash(v), canonicalHashExcluding({ ...v, contentHash: '' }, 'contentHash'));
});

test('the excluded field is named in the preimage', () => {
  // "hashed with contentHash removed" must differ from "hashed with some other
  // field removed", even when the remaining content is identical.
  const a = canonicalHashExcluding({ x: 1, contentHash: 'z' }, 'contentHash');
  const b = canonicalHashExcluding({ x: 1, other: 'z' }, 'other');
  assert.notEqual(a, b);
});

test('unsafe integers are refused rather than silently rounded', () => {
  // JSON.parse turns 9007199254740993 into ...992, so two different documents
  // would otherwise reach one digest.
  assert.throws(() => canonicalJson({ n: 9007199254740993 }), /safe integer/);
  assert.throws(() => canonicalJson({ n: -9007199254740993 }), /safe integer/);
  assert.doesNotThrow(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER }));
});

test('non-finite numbers and -0 are handled explicitly', () => {
  assert.throws(() => canonicalJson({ n: NaN }));
  assert.throws(() => canonicalJson({ n: Infinity }));
  assert.equal(canonicalHash({ n: -0 }), canonicalHash({ n: 0 }));
});

test('deep nesting is a typed refusal, not a stack overflow', () => {
  let deep = {};
  let cur = deep;
  for (let i = 0; i < MAX_CANONICAL_DEPTH + 50; i++) {
    cur.n = {};
    cur = cur.n;
  }
  assert.throws(() => canonicalJson(deep), /nesting deeper/);

  // And through the store, where the input is an untrusted file.
  const b = forge();
  const { report } = load([{ ...b, attempts: [{ ...b.attempts[0], sourceRef: null, deep }] }]);
  assert.ok(report.rejected.length === 1, 'rejected rather than thrown');
  assert.ok(codes(report).length > 0);
});

test('array order stays meaningful and key order stays irrelevant', () => {
  assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
});

// ---------------------------------------------------------------------------
// Identity replay
// ---------------------------------------------------------------------------

test('no qualification replays across any key dimension', () => {
  const dimensions = [
    ['modelId', 'other-model.q4-k'],
    ['artifactDigest', `sha256:${'ef'.repeat(32)}`],
    ['quantization', 'Q8_0'],
    ['runtimeName', 'vllm'],
    ['runtimeBuild', 'b99999-other'],
    ['hardwareProfileId', 'someone-elses-box'],
    ['taskClass', 'repo_reconnaissance'],
    ['taskClassContractVersion', '0.9.0'],
    ['fixtureSuiteId', 'trivial-suite'],
    ['fixtureSuiteVersion', '0.0.1'],
    ['verificationRegimeVersion', 'lenient'],
  ];
  for (const [field, value] of dimensions) {
    const b = forge({ key: { [field]: value } });
    const { store, report } = load([b], { pin: [b] });
    if (report.accepted === 0) continue; // refused at import: also a pass
    const d = decide(store);
    assert.equal(d.qualified, false, `changing ${field} must not still qualify`);
  }
});

test('identifiers with surrounding whitespace or control characters are refused', () => {
  for (const bad of [' the-real-suite', 'the-real-suite ', 'the-real suite']) {
    const b = forge({ key: { fixtureSuiteId: bad } });
    const { report } = load([b], { pin: [b] });
    assert.ok(report.rejected.length === 1, `"${bad}" must be refused`);
  }
});

test('the context tier is bound to what the deployment serves', () => {
  const small = forge({ attempts: [{ ...pass(1), contextTierTokens: 512 }] });
  assert.ok(codes(load([small], { pin: [small] }).report).includes('CONTEXT_TIER_MISMATCH'));

  const unknown = forge({ attempts: [{ ...pass(1), contextTierTokens: null }] });
  assert.ok(codes(load([unknown], { pin: [unknown] }).report).includes('CONTEXT_TIER_MISMATCH'));
});

// ---------------------------------------------------------------------------
// Attribution laundering
// ---------------------------------------------------------------------------

test('a model failure cannot be relabelled as infrastructure', () => {
  // Nineteen real model failures marked PROVIDER_FAILURE would leave a pass
  // rate of 1.0 over the one attempt that remains model-attributable.
  const laundered = [
    pass(0),
    ...Array.from({ length: 19 }, (_, i) => ({
      ...pass(i + 1),
      outcome: 'PROVIDER_FAILURE',
      score: null,
      failureOrigin: 'MODEL',
      failureReasonCode: 'low_score',
      compliance: { outputSchemaValid: null, citationsValid: null, toolCallsValid: null },
    })),
  ];
  const b = forge({ attempts: laundered });
  const { report } = load([b], { pin: [b] });
  assert.ok(codes(report).includes('CONTRADICTORY_AGGREGATE'));
});

test('honest infrastructure failures are counted, and a policy can bound them', () => {
  const attempts = [
    pass(0),
    ...Array.from({ length: 19 }, (_, i) => ({
      ...pass(i + 1),
      outcome: 'PROVIDER_FAILURE',
      score: null,
      failureOrigin: 'PROVIDER',
      failureReasonCode: 'provider_timeout',
      compliance: { outputSchemaValid: null, citationsValid: null, toolCallsValid: null },
    })),
  ];
  const b = forge({ attempts });
  const { store, report } = load([b], { pin: [b] });
  assert.equal(report.accepted, 1);
  assert.equal(store.all()[0].bundle.aggregate.passRate, 1, 'passRate excludes infrastructure');
  assert.equal(store.all()[0].bundle.aggregate.infrastructureFailureRate, 0.95, 'and it is reported');
  const d = decide(store, { ...PERMISSIVE, maxInfrastructureFailureRate: 0.1 });
  assert.equal(d.qualified, false, 'a policy that bounds it catches the run');
});

test('a PASS may not carry a failure origin', () => {
  const b = forge({ attempts: [{ ...pass(1), failureOrigin: 'PROVIDER' }] });
  assert.ok(codes(load([b], { pin: [b] }).report).includes('CONTRADICTORY_AGGREGATE'));
});

test('the failure-origin vocabulary is closed', () => {
  const b = forge({
    attempts: [{ ...pass(1), outcome: 'FAIL', score: 0, failureOrigin: 'ACTS_OF_GOD' }],
  });
  assert.ok(codes(load([b], { pin: [b] }).report).includes('MALFORMED_BUNDLE'));
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test('a partially written policy is refused, not partially applied', () => {
  const b = forge();
  const { store } = load([b], { pin: [b] });
  for (const omit of Object.keys(PERMISSIVE)) {
    const partial = { ...PERMISSIVE };
    delete partial[omit];
    const d = decide(store, partial);
    assert.equal(d.reason, 'POLICY_INCOMPLETE', `omitting ${omit} must not be silently allowed`);
    assert.ok(d.shortfalls.some((s) => s.requirement === `policy.${omit}`));
  }
  assert.deepEqual(missingPolicyFields(PERMISSIVE), []);
});

test('issuer expiry is enforced at decision time, not only at import', () => {
  const b = forge({ top: { expiresAt: '2026-08-21T00:00:00.000Z' } });
  const { store, report } = load([b], { pin: [b] });
  assert.equal(report.accepted, 1, 'unexpired at import');
  assert.equal(decide(store, PERMISSIVE, NOW).qualified, true);
  const later = decide(store, PERMISSIVE, new Date('2027-06-01T00:00:00.000Z'));
  assert.equal(later.qualified, false);
  assert.equal(later.reason, 'EVIDENCE_STALE');
});

test('thresholds are compared at their exact boundary', () => {
  // Four attempts, three passing: passRate is exactly 0.75, sampleCount is 4.
  const attempts = [
    pass(1), pass(2), pass(3),
    { ...pass(4), outcome: 'FAIL', score: 0, failureOrigin: 'MODEL', failureReasonCode: 'low_score' },
  ];
  const b = forge({ attempts });
  const { store } = load([b], { pin: [b] });

  assert.equal(decide(store, { ...PERMISSIVE, minPassRate: 0.75 }).qualified, true, 'equal passes');
  assert.equal(decide(store, { ...PERMISSIVE, minPassRate: 0.7500001 }).qualified, false);
  assert.equal(decide(store, { ...PERMISSIVE, minSampleCount: 4 }).qualified, true, 'equal passes');
  assert.equal(decide(store, { ...PERMISSIVE, minSampleCount: 5 }).qualified, false);
  assert.equal(decide(store, { ...PERMISSIVE, maxFailureRate: 0.25 }).qualified, true, 'equal passes');
  assert.equal(decide(store, { ...PERMISSIVE, maxFailureRate: 0.2499999 }).qualified, false);
});

test('null never compares as zero, false, passing, recent, or well-sampled', () => {
  const attempts = [
    { ...pass(1), compliance: { outputSchemaValid: null, citationsValid: null, toolCallsValid: null } },
    { ...pass(2), compliance: { outputSchemaValid: null, citationsValid: null, toolCallsValid: null } },
  ];
  const b = forge({ attempts });
  const { store } = load([b], { pin: [b] });
  for (const [field, policy] of [
    ['schemaViolationRate', { maxSchemaViolationRate: 0 }],
    ['citationViolationRate', { maxCitationViolationRate: 0 }],
    ['repeatabilityDisagreementRate', { maxRepeatabilityDisagreementRate: 0 }],
  ]) {
    const d = decide(store, { ...PERMISSIVE, ...policy });
    assert.equal(d.qualified, false, `${field} unknown must not satisfy a bound on it`);
    assert.equal(d.reason, 'EVIDENCE_INCOMPLETE');
    assert.ok(d.shortfalls.some((s) => s.actual === 'unknown (not measured)'));
  }
});

test('an import limit refuses an oversized batch rather than working through it', () => {
  const store = QualificationStore.empty();
  assert.throws(() => store.load(new Array(1001).fill({}), CONTEXT()), RangeError);
});

test('the store never mutates what it was handed, accepted or rejected', () => {
  const good = forge();
  const bad = forge({ key: { runtimeBuild: 'wrong' } });
  const before = [JSON.stringify(good), JSON.stringify(bad)];
  load([good, bad], { pin: [good] });
  assert.deepEqual([JSON.stringify(good), JSON.stringify(bad)], before);
});
