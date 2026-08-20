/**
 * Synthetic qualification evidence.
 *
 * Everything here is fabricated on purpose, and nothing here describes a real
 * model. The identities are deliberately invented — `testmodel-a.q4-k` on a
 * `fakeruntime` build on a `test-rig-1` profile — so that no test can pass by
 * accidentally matching the artifact actually installed on this machine, and so
 * that nothing in this directory could ever be mistaken for a real verdict
 * about the deployed model. The installed Q2_K artifact is unqualified, and no
 * fixture here says otherwise.
 */
import { canonicalHashExcluding } from '../dist/canonical.js';

export const RUNTIME_NAME = 'fakeruntime';
export const RUNTIME_BUILD = 'b00001-testpin';
export const HARDWARE_PROFILE = 'test-rig-1';
export const MODEL_A = 'testmodel-a.q4-k';
export const MODEL_B = 'testmodel-b.q4-k';
export const DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `sha256:${'b'.repeat(64)}`;
export const QUANT = 'Q4_K';

export const INSTALLED = [
  { modelId: MODEL_A, digest: DIGEST_A, quantization: QUANT },
  { modelId: MODEL_B, digest: DIGEST_B, quantization: QUANT },
];

export const NOW = new Date('2026-08-20T12:00:00.000Z');

export function key(overrides = {}) {
  return {
    modelId: MODEL_A,
    artifactDigest: DIGEST_A,
    quantization: QUANT,
    runtimeName: RUNTIME_NAME,
    runtimeBuild: RUNTIME_BUILD,
    hardwareProfileId: HARDWARE_PROFILE,
    taskClass: 'test_log_triage',
    taskClassContractVersion: '1.0.0',
    fixtureSuiteId: 'triage-suite',
    fixtureSuiteVersion: '1.0.0',
    verificationRegimeVersion: 'deterministic-1',
    ...overrides,
  };
}

export function hardwareProfile(id = HARDWARE_PROFILE) {
  return {
    id,
    gpuModel: 'Fake GPU 9000',
    gpuMemoryMiB: 12288,
    gpuDriver: '000.00.00',
    cudaVersion: '13.2',
    cpuModel: 'Fake CPU',
    systemMemoryMiB: 65536,
    partialOffload: true,
    note: null,
  };
}

/**
 * One attempt. Timings and compliance default to measured values; pass
 * `{ timings: unknownTimings() }` or `compliance: unknownCompliance()` to model
 * a harness that did not measure them.
 */
export function attempt(overrides = {}) {
  return {
    attemptId: 'att-1',
    fixtureId: 'fx-1',
    outcome: 'PASS',
    failureOrigin: null,
    failureReasonCode: null,
    score: 1,
    contextTierTokens: 32768,
    tokens: { promptTokens: 100, completionTokens: 50 },
    timings: {
      timeToFirstTokenMs: 200,
      prefillTokensPerSecond: 500,
      decodeTokensPerSecond: 60,
      wallTimeMs: 1000,
    },
    compliance: { outputSchemaValid: true, citationsValid: true, toolCallsValid: null },
    sourceRef: 'run_2026-08-19_fx-1_testmodel-a_0000',
    ...overrides,
  };
}

export function unknownTimings() {
  return {
    timeToFirstTokenMs: null,
    prefillTokensPerSecond: null,
    decodeTokensPerSecond: null,
    wallTimeMs: null,
  };
}

export function unknownCompliance() {
  return { outputSchemaValid: null, citationsValid: null, toolCallsValid: null };
}

/**
 * Compute the aggregate the importer will compute, so a fixture is consistent
 * by construction. A test that wants a contradiction states it explicitly by
 * overriding a field, which keeps the contradiction visible in the test.
 */
export function aggregateOf(attempts, overrides = {}) {
  const outcomes = [
    'PASS',
    'PARTIAL',
    'FAIL',
    'INCOMPLETE',
    'PROVIDER_FAILURE',
    'HARNESS_FAILURE',
  ];
  const counts = Object.fromEntries(outcomes.map((o) => [o, 0]));
  for (const a of attempts) counts[a.outcome] += 1;

  const scored = attempts.filter((a) => a.score !== null).map((a) => a.score);
  const mean = scored.length ? scored.reduce((s, v) => s + v, 0) / scored.length : null;
  const sd = scored.length && mean !== null
    ? Math.sqrt(scored.reduce((s, v) => s + (v - mean) ** 2, 0) / scored.length)
    : null;

  const modelAttr = attempts.filter((a) =>
    ['PASS', 'PARTIAL', 'FAIL', 'INCOMPLETE'].includes(a.outcome),
  );
  const passRate = modelAttr.length
    ? modelAttr.filter((a) => a.outcome === 'PASS').length / modelAttr.length
    : null;
  const infra = attempts.length
    ? attempts.filter((a) => ['PROVIDER_FAILURE', 'HARNESS_FAILURE'].includes(a.outcome)).length /
      attempts.length
    : null;

  const schemaChecked = attempts.filter((a) => a.compliance.outputSchemaValid !== null);
  const schemaRate = schemaChecked.length
    ? schemaChecked.filter((a) => a.compliance.outputSchemaValid === false).length / schemaChecked.length
    : null;
  const citeChecked = attempts.filter((a) => a.compliance.citationsValid !== null);
  const citeRate = citeChecked.length
    ? citeChecked.filter((a) => a.compliance.citationsValid === false).length / citeChecked.length
    : null;

  const byFixture = new Map();
  for (const a of attempts) {
    const l = byFixture.get(a.fixtureId) ?? [];
    l.push(a.outcome);
    byFixture.set(a.fixtureId, l);
  }
  const repeated = [...byFixture.values()].filter((o) => o.length > 1);
  const disagreement = repeated.length
    ? repeated.filter((o) => new Set(o).size > 1).length / repeated.length
    : null;

  const tiers = new Set(attempts.map((a) => a.contextTierTokens).filter((t) => t !== null));

  return {
    attemptCount: attempts.length,
    sampleCount: byFixture.size,
    outcomeCounts: counts,
    meanScore: mean,
    passRate,
    infrastructureFailureRate: infra,
    schemaViolationRate: schemaRate,
    citationViolationRate: citeRate,
    scoreStdDev: sd,
    repeatabilityDisagreementRate: disagreement,
    contextTierTokens: tiers.size === 1 ? [...tiers][0] : null,
    knownFailureModes: [],
    ...overrides,
  };
}

export function provenance(overrides = {}) {
  return {
    claimedAuthority: 'luak',
    sourceContractVersion: 'luak-evidence-bundle-1.0.0',
    luakBundleIds: ['run_2026-08-19_fx-1_testmodel-a_0000'],
    luakBundleHashes: [`sha256:${'c'.repeat(64)}`],
    claimedSignatureStatus: 'unsigned_key_missing',
    luakRepoCommit: '46e99cf920cf40e932720bb65d3f1b13bce6f1dc',
    note: 'synthetic fixture',
    verifiedByBokahli: false,
    ...overrides,
  };
}

/** Build a bundle and seal it with a correct canonical content hash. */
export function bundle(overrides = {}) {
  const attempts = overrides.attempts ?? [
    attempt({ attemptId: 'a1', fixtureId: 'fx-1' }),
    attempt({ attemptId: 'a2', fixtureId: 'fx-2' }),
    attempt({ attemptId: 'a3', fixtureId: 'fx-3' }),
    attempt({ attemptId: 'a4', fixtureId: 'fx-4', outcome: 'FAIL', score: 0.2, failureOrigin: 'MODEL', failureReasonCode: 'low_score' }),
  ];
  const unhashed = {
    bundleVersion: '2.0.0-phase2a',
    key: key(overrides.key ?? {}),
    hardwareProfile: hardwareProfile(overrides.hardwareProfileId),
    verdict: 'QUALIFIED',
    attempts,
    aggregate: aggregateOf(attempts, overrides.aggregate ?? {}),
    provenance: provenance(overrides.provenance ?? {}),
    generatedAt: '2026-08-19T12:00:00.000Z',
    expiresAt: null,
    ...stripFixtureKeys(overrides),
  };
  return seal(unhashed);
}

/**
 * Seal a bundle the way a legitimate exporter would: the same domain-tagged,
 * field-labelled preimage the importer recomputes.
 */
export function seal(unhashed) {
  return {
    ...unhashed,
    contentHash: canonicalHashExcluding({ ...unhashed, contentHash: '' }, 'contentHash'),
  };
}

/** Build a bundle whose stated hash is deliberately wrong. */
export function bundleWithBadHash(overrides = {}) {
  return { ...bundle(overrides), contentHash: `sha256:${'0'.repeat(64)}` };
}

/**
 * A trust anchor pinning exactly the given bundles.
 *
 * Written out at every call site on purpose. Trust is the one thing in this
 * system that must never be acquired by default, and a test fixture that
 * granted it implicitly would hide the very step under audit.
 */
export function anchorFor(...bundles) {
  return {
    pinnedEvidenceDigests: bundles.map((b) => b.contentHash),
    anchorRef: 'test-operator-anchor',
  };
}

function stripFixtureKeys(o) {
  const { key: _k, aggregate: _a, provenance: _p, attempts: _at, hardwareProfileId: _h, ...rest } = o;
  return rest;
}

export const SERVED_CONTEXT_TOKENS = 32768;

/**
 * An import context with **no trust anchor**: evidence loads and authorises
 * nothing. This is the default so that any test which expects qualification has
 * to ask for trust in so many words.
 */
export function importContext(overrides = {}) {
  return {
    installedArtifacts: INSTALLED,
    runtimeName: RUNTIME_NAME,
    runtimeBuild: RUNTIME_BUILD,
    hardwareProfileId: HARDWARE_PROFILE,
    servedContextTokens: SERVED_CONTEXT_TOKENS,
    now: NOW,
    ...overrides,
  };
}

/** An import context in which the operator has pinned the given bundles. */
export function trustedImportContext(bundles, overrides = {}) {
  return importContext({ trustAnchor: anchorFor(...bundles), ...overrides });
}

/**
 * A policy that states every requirement this build insists an operator state.
 * The values are arbitrary test values, not recommendations.
 */
export function completePolicy(overrides = {}) {
  return {
    minSampleCount: 1,
    minPassRate: 0.5,
    requiredFixtureSuiteId: 'triage-suite',
    requiredFixtureSuiteVersion: '1.0.0',
    requiredVerificationRegimeVersion: 'deterministic-1',
    ...overrides,
  };
}

export function codesOf(result) {
  return result.ok ? [] : result.errors.map((e) => e.code);
}
