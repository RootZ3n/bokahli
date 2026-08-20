/**
 * Qualification import.
 *
 * The importer is a gate, and a gate is only worth having if it is tested on
 * what it refuses. Most of what follows is rejection: evidence that describes a
 * different artifact, a different runtime, a different machine, or a payload
 * that has been edited since it was issued. Each of those, accepted, would let
 * Bokahli claim a model was tested when it was not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHash, canonicalJson, luakCompatBundleHash } from '../dist/canonical.js';
import { importQualificationBundle } from '../dist/importer.js';
import {
  DIGEST_B,
  MODEL_A,
  NOW,
  aggregateOf,
  attempt,
  bundle,
  bundleWithBadHash,
  codesOf,
  importContext,
  unknownCompliance,
} from './fixtures.js';

// ---------------------------------------------------------------------------
// canonicalisation
// ---------------------------------------------------------------------------

test('canonical form is independent of key order', () => {
  const a = { b: 1, a: { d: [3, 2, 1], c: 'x' } };
  const b = { a: { c: 'x', d: [3, 2, 1] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalHash(a), canonicalHash(b));
});

test('array order is preserved, because array order is data', () => {
  assert.notEqual(canonicalHash({ x: [1, 2] }), canonicalHash({ x: [2, 1] }));
});

test('undefined is refused rather than silently dropped', () => {
  // JSON.stringify would omit the key, making a bundle missing a required
  // field hash identically to one that never had it.
  assert.throws(() => canonicalJson({ a: 1, b: undefined }), /undefined/);
});

test("Luak's own hash is order-dependent where the canonical one is not", () => {
  // This is not a criticism of Luak so much as the reason Bokahli cannot adopt
  // its hash as an identity: the same bundle, reserialised, hashes differently.
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  assert.notEqual(luakCompatBundleHash(a), luakCompatBundleHash(b));
  assert.equal(canonicalHash(a), canonicalHash(b));
});

// ---------------------------------------------------------------------------
// the happy path
// ---------------------------------------------------------------------------

test('valid canonical evidence imports', () => {
  const result = importQualificationBundle(bundle(), importContext());
  assert.equal(result.ok, true, JSON.stringify(codesOf(result)));
  assert.equal(result.bundle.key.modelId, MODEL_A);
  assert.equal(result.bundle.verdict, 'QUALIFIED');
  assert.equal(result.bundle.provenance.authority, 'luak');
});

test('accepted evidence is frozen against later edits', () => {
  const result = importQualificationBundle(bundle(), importContext());
  assert.equal(result.ok, true);
  assert.throws(() => {
    result.bundle.aggregate.passRate = 1;
  }, TypeError);
});

test("Luak's signature status is carried through, never upgraded", () => {
  const result = importQualificationBundle(bundle(), importContext());
  assert.equal(result.ok, true);
  // The fixture is unsigned. Import must not turn that into anything better.
  assert.equal(result.bundle.provenance.luakSignatureStatus, 'unsigned_key_missing');
});

// ---------------------------------------------------------------------------
// integrity
// ---------------------------------------------------------------------------

test('a content-hash mismatch is rejected', () => {
  const result = importQualificationBundle(bundleWithBadHash(), importContext());
  assert.deepEqual(codesOf(result), ['CONTENT_HASH_MISMATCH']);
});

test('editing any field after sealing invalidates the hash', () => {
  const b = bundle();
  const tampered = { ...b, verdict: 'QUALIFIED', aggregate: { ...b.aggregate, passRate: 1 } };
  const result = importQualificationBundle(tampered, importContext());
  assert.ok(codesOf(result).includes('CONTENT_HASH_MISMATCH'));
});

test('reordering keys does not invalidate the hash', () => {
  const b = bundle();
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  const result = importQualificationBundle(reordered, importContext());
  assert.equal(result.ok, true, JSON.stringify(codesOf(result)));
});

// ---------------------------------------------------------------------------
// key mismatches
// ---------------------------------------------------------------------------

test('evidence for a different artifact digest is rejected', () => {
  const result = importQualificationBundle(
    bundle({ key: { artifactDigest: DIGEST_B } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('ARTIFACT_MISMATCH'));
});

test('evidence for a different quantisation is rejected', () => {
  const result = importQualificationBundle(bundle({ key: { quantization: 'Q2_K' } }), importContext());
  assert.ok(codesOf(result).includes('ARTIFACT_MISMATCH'));
});

test('evidence for a different runtime build is rejected', () => {
  const result = importQualificationBundle(
    bundle({ key: { runtimeBuild: 'b99999-other' } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('RUNTIME_MISMATCH'));
});

test('evidence for a different hardware profile is rejected', () => {
  const result = importQualificationBundle(
    bundle({ key: { hardwareProfileId: 'someone-elses-box' } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('HARDWARE_MISMATCH'));
});

test('a filesystem path is never accepted as a model identity', () => {
  const result = importQualificationBundle(
    bundle({ key: { modelId: '/home/zen/models/thing.gguf' } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('MALFORMED_BUNDLE'));
});

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

test('an unsupported bundle version is rejected without further guessing', () => {
  const b = { ...bundle(), bundleVersion: '99.0.0' };
  const result = importQualificationBundle(b, importContext());
  assert.deepEqual(codesOf(result), ['UNSUPPORTED_BUNDLE_VERSION']);
});

test('an unknown task class is rejected', () => {
  const result = importQualificationBundle(
    bundle({ key: { taskClass: 'vibes_assessment' } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('UNKNOWN_TASK_CLASS'));
});

test('evidence produced against an older task contract does not carry over', () => {
  const result = importQualificationBundle(
    bundle({ key: { taskClassContractVersion: '0.9.0' } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('TASK_CONTRACT_VERSION_MISMATCH'));
});

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

test('evidence the issuer marked expired is rejected', () => {
  const result = importQualificationBundle(
    bundle({ expiresAt: '2026-08-01T00:00:00.000Z' }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('STALE_EVIDENCE'));
});

test('future-dated evidence is rejected', () => {
  const result = importQualificationBundle(
    bundle({ generatedAt: '2027-01-01T00:00:00.000Z' }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('STALE_EVIDENCE'));
});

test('an unexpired expiry is accepted', () => {
  const result = importQualificationBundle(
    bundle({ expiresAt: '2027-01-01T00:00:00.000Z' }),
    importContext(),
  );
  assert.equal(result.ok, true, JSON.stringify(codesOf(result)));
});

// ---------------------------------------------------------------------------
// aggregates
// ---------------------------------------------------------------------------

test('an aggregate that flatters its attempts is rejected', () => {
  // Four attempts, one of which failed. The bundle claims a perfect pass rate.
  const result = importQualificationBundle(
    bundle({ aggregate: { passRate: 1, meanScore: 1 } }),
    importContext(),
  );
  const codes = codesOf(result);
  assert.ok(codes.includes('CONTRADICTORY_AGGREGATE'));
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('aggregate.passRate'));
  assert.ok(fields.includes('aggregate.meanScore'));
});

test('a miscounted outcome is rejected', () => {
  const b = bundle();
  const broken = {
    ...b,
    aggregate: { ...b.aggregate, outcomeCounts: { ...b.aggregate.outcomeCounts, FAIL: 0, PASS: 4 } },
  };
  const result = importQualificationBundle(broken, importContext());
  assert.ok(codesOf(result).includes('CONTRADICTORY_AGGREGATE'));
});

test('a wrong sample count is rejected', () => {
  const result = importQualificationBundle(bundle({ aggregate: { sampleCount: 40 } }), importContext());
  assert.ok(codesOf(result).includes('CONTRADICTORY_AGGREGATE'));
});

test('infrastructure failures cannot be hidden from the pass rate', () => {
  // Two provider failures and two passes. Counting the provider failures as
  // model-attributable would drop the pass rate; dropping them from the
  // denominator entirely would flatter it. The contract does neither: they are
  // excluded from passRate and counted in infrastructureFailureRate.
  const attempts = [
    attempt({ attemptId: 'a1', fixtureId: 'fx-1' }),
    attempt({ attemptId: 'a2', fixtureId: 'fx-2' }),
    attempt({ attemptId: 'a3', fixtureId: 'fx-3', outcome: 'PROVIDER_FAILURE', score: null, failureOrigin: 'PROVIDER', failureReasonCode: 'provider_timeout', compliance: unknownCompliance() }),
    attempt({ attemptId: 'a4', fixtureId: 'fx-4', outcome: 'HARNESS_FAILURE', score: null, failureOrigin: 'HARNESS', failureReasonCode: 'harness_runtime_failure', compliance: unknownCompliance() }),
  ];
  const b = bundle({ attempts, aggregate: aggregateOf(attempts) });
  const result = importQualificationBundle(b, importContext());
  assert.equal(result.ok, true, JSON.stringify(codesOf(result)));
  assert.equal(result.bundle.aggregate.passRate, 1);
  assert.equal(result.bundle.aggregate.infrastructureFailureRate, 0.5);
});

test('claiming zero repeat-disagreement without any repeats is rejected', () => {
  // No fixture was attempted twice, so repeatability was never measured. 0
  // would assert a stability nothing here demonstrates; null is the truth.
  const result = importQualificationBundle(
    bundle({ aggregate: { repeatabilityDisagreementRate: 0 } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('CONTRADICTORY_AGGREGATE'));
  const err = result.errors.find((e) => e.field === 'aggregate.repeatabilityDisagreementRate');
  assert.match(err.detail, /never measured/);
});

test('measured repeats are accepted and their disagreement computed', () => {
  const attempts = [
    attempt({ attemptId: 'a1', fixtureId: 'fx-1' }),
    attempt({ attemptId: 'a2', fixtureId: 'fx-1', outcome: 'FAIL', score: 0 }),
    attempt({ attemptId: 'a3', fixtureId: 'fx-2' }),
    attempt({ attemptId: 'a4', fixtureId: 'fx-2' }),
  ];
  const b = bundle({ attempts, aggregate: aggregateOf(attempts) });
  const result = importQualificationBundle(b, importContext());
  assert.equal(result.ok, true, JSON.stringify(codesOf(result)));
  assert.equal(result.bundle.aggregate.repeatabilityDisagreementRate, 0.5);
});

// ---------------------------------------------------------------------------
// structure and provenance
// ---------------------------------------------------------------------------

test('a verdict with no attempts behind it is not evidence', () => {
  const attempts = [];
  const b = bundle({ attempts, aggregate: aggregateOf(attempts) });
  const result = importQualificationBundle(b, importContext());
  assert.ok(codesOf(result).includes('MALFORMED_BUNDLE'));
});

test('an omitted timing key is rejected, because omission reads as zero', () => {
  const bad = attempt({ attemptId: 'a1', fixtureId: 'fx-1' });
  delete bad.timings.timeToFirstTokenMs;
  const b = bundle({ attempts: [bad], aggregate: aggregateOf([bad]) });
  const result = importQualificationBundle(b, importContext());
  assert.ok(codesOf(result).includes('MALFORMED_BUNDLE'));
});

test('an explicitly unknown timing is accepted', () => {
  const a = attempt({
    attemptId: 'a1',
    fixtureId: 'fx-1',
    timings: {
      timeToFirstTokenMs: null,
      prefillTokensPerSecond: null,
      decodeTokensPerSecond: null,
      wallTimeMs: null,
    },
  });
  const b = bundle({ attempts: [a], aggregate: aggregateOf([a]) });
  const result = importQualificationBundle(b, importContext());
  assert.equal(result.ok, true, JSON.stringify(codesOf(result)));
  assert.equal(result.bundle.attempts[0].timings.timeToFirstTokenMs, null);
});

test('evidence claiming an authority other than Luak is rejected', () => {
  const result = importQualificationBundle(
    bundle({ provenance: { authority: 'bokahli' } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('PROVENANCE_INVALID'));
});

test('evidence with no traceable source bundle is rejected', () => {
  const result = importQualificationBundle(
    bundle({ provenance: { luakBundleIds: [] } }),
    importContext(),
  );
  assert.ok(codesOf(result).includes('PROVENANCE_INVALID'));
});

test('a duplicate key is rejected rather than silently replacing', () => {
  const b = bundle();
  const first = importQualificationBundle(b, importContext());
  assert.equal(first.ok, true);
  const ks = [
    'modelId', 'artifactDigest', 'quantization', 'runtimeName', 'runtimeBuild',
    'hardwareProfileId', 'taskClass', 'taskClassContractVersion', 'fixtureSuiteId',
    'fixtureSuiteVersion', 'verificationRegimeVersion',
  ].map((f) => b.key[f]).join('|');
  const second = importQualificationBundle(b, importContext({ existingKeys: new Set([ks]) }));
  assert.ok(codesOf(second).includes('DUPLICATE_KEY'));
});

test('every reason is reported at once, not one per round trip', () => {
  const result = importQualificationBundle(
    bundle({ key: { artifactDigest: DIGEST_B, runtimeBuild: 'b99999-other', hardwareProfileId: 'elsewhere' } }),
    importContext(),
  );
  const codes = codesOf(result);
  assert.ok(codes.includes('ARTIFACT_MISMATCH'));
  assert.ok(codes.includes('RUNTIME_MISMATCH'));
  assert.ok(codes.includes('HARDWARE_MISMATCH'));
});

test('the importer never mutates the evidence it was handed', () => {
  const b = bundle({ key: { artifactDigest: DIGEST_B } });
  const before = JSON.stringify(b);
  importQualificationBundle(b, importContext());
  assert.equal(JSON.stringify(b), before, 'rejected evidence must come back untouched');
  assert.equal(NOW.toISOString(), '2026-08-20T12:00:00.000Z');
});
