/**
 * Does Bokahli's new telemetry actually unblock Luak?
 *
 * This is the only test that can answer the question the phase was opened for,
 * and it answers it by running Luak's *real* exporter — the one at
 * `feature/local-qualification-v1`, commit 50bd71f — against records built from
 * Bokahli's actual response shape. A lookalike schema kept in sync by hand
 * would prove that two files agree with each other, which is not the claim.
 *
 * The six-attempt pilot on 2026-08-20 refused with seven refusals: six
 * `TOKEN_COUNTS_NOT_MEASURED`, one per attempt, and one
 * `CONTEXT_TIER_NOT_MEASURED` on the identity. Both had the same root cause —
 * Bokahli returned counts without naming a tokenizer. The assertions below are
 * that a fully proven Bokahli response clears all seven, and that removing any
 * single proof puts them back.
 *
 * Skips rather than fails when Luak is not checked out beside this repo. A
 * cross-repo test that hard-fails on a missing sibling stops being a signal and
 * becomes noise someone routes around.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTokenCounts, resolveTokenizerIdentity } from '@bokahli/runtime';

const LUAK = join(homedir(), 'repos/luak/dist/core/local');
const AVAILABLE = existsSync(join(LUAK, 'bokahli-export.js'));

const NOW = () => new Date('2026-08-20T12:00:00.000Z');

/** Exactly what Bokahli reports when every proof is present. */
const PROVEN = {
  artifactTokenizer: {
    family: 'gpt2',
    pretokenizer: 'qwen35',
    vocabSize: 248320,
    metadataDigest: `sha256:${'1f'.repeat(32)}`,
    chatTemplateDigest: `sha256:${'a4'.repeat(32)}`,
  },
  runtimeVocabSize: 248320,
  runtimeBuild: 'b10505-ee4c505a4',
  artifactAttested: true,
  // The behavioural binding, both directions. The decode half alone reads the
  // token table, which a load-time override of merges or the pre-tokenizer
  // leaves untouched while changing every count — so the encode canary is the
  // half that actually unblocks an export.
  backendInstanceId: 'instance-1',
  runtimeTokenizerProof: {
    method: 'runtime-canary-probe', matches: true,
    samplesChecked: 24, samplesMatched: 24,
    segmentationDigest: `sha256:${'7c'.repeat(32)}`,
    backendInstanceId: 'instance-1',
    observedAt: '2026-08-20T12:00:00.000Z', detail: null,
    canary: {
      schemaVersion: 'bokahli.tokenizer-canary.v1',
      canarySuiteId: 'qwen35-broad.v1', canarySuiteHash: `sha256:${'3a'.repeat(32)}`,
      decodeCanaryVerified: true, encodeCanaryVerified: true,
      encodeChecked: 40, encodeMatched: 40, decodeChecked: 54, decodeMatched: 54,
      failedCaseIds: [], encodeReferenceMethod: 'llama-tokenize-vocab-only',
      decodeReferenceMethod: 'gguf-token-table',
      verifiedBackendInstanceId: 'instance-1', verifiedAt: '2026-08-20T12:00:00.000Z',
      reasons: [], coverageNote: 'behavioural canary coverage, not proof of equivalence',
    },
  },
  now: NOW,
};

const IDENTITY = (tokenCountSource) => ({
  identityVersion: 'local-identity-1.1.0',
  artifact: {
    modelId: 'qwen3.5-35b-a3b.q2-k',
    artifactDigest: `sha256:${'49'.repeat(32)}`,
    quantization: 'Q2_K', format: 'gguf',
    sizeBytes: null, parameterCount: null, activeParameterCount: null,
  },
  runtime: { name: 'llama.cpp', build: 'b10505-ee4c505a4', binaryDigest: null, apiFlavour: 'native' },
  promptTemplate: {
    templateId: 'peg-native', templateDigest: `sha256:${'a4'.repeat(32)}`,
    appliedBy: 'runtime', bosTokenId: null, eosTokenId: 248046,
  },
  sampler: { temperature: 0, topP: 1, topK: 20, repeatPenalty: null, seed: 7, seedHonoured: true },
  hardware: {
    profileId: 'mushin-rtx4070-12g', gpuModel: 'NVIDIA GeForce RTX 4070',
    gpuMemoryMiB: 12282, gpuDriver: '595.91.07', cudaVersion: '13.2.51',
    cpuModel: 'i7-13700K', systemMemoryMiB: 31798,
  },
  placement: {
    requestedGpuLayers: 999, observedGpuLayers: null, cpuOffloadEnabled: true,
    observedVramBytes: 2430 * 1024 * 1024, observedHostRamBytes: null, gpuConfirmed: true,
  },
  context: { configuredTokens: 32768, effectiveMaxTokens: 32768, tierLabel: 'control', tokenCountSource },
  concurrency: { slots: 1, maxConcurrentRequests: 1, batchSize: null },
  // Luak identity 1.1.0. A result that cannot say which generation regime
  // produced it is not evidence about either of them, and Luak's own identity
  // check refuses the bundle rather than letting the omission travel — which is
  // what this compatibility suite exists to catch on Bokahli's side of the wire.
  generation: {
    regime: 'unconstrained',
    contractVersion: 'bokahli.structured-output/1',
    outputSchemaDigest: null,
    enforcementRequested: false,
    enforcementConfirmed: null,
    evidencePolicyVersion: 'bokahli.evidence-policy/1',
    evidencePolicyDigest: `sha256:${'f2'.repeat(32)}`,
    reasoningMode: 'off',
  },
  fixtureSuiteId: 'local-test-log-triage',
  fixtureSuiteVersion: '1.0.0',
  verificationRegimeVersion: 'local-regime-1.0.0',
});

/** One Luak attempt record whose token provenance comes from Bokahli's verdict. */
function record(i, counts) {
  return {
    attemptId: `att_0000000${i}-0000-4000-8000-000000000000`,
    // Luak's exporter refuses a campaign that cannot show untrusted material
    // travelled through Bokahli's evidence[] contract. These fixtures describe
    // a correct campaign, so they carry the block the boundary would have
    // produced: packets sent, inspected, and fenced.
    evidenceTransport: {
      transportVersion: 'luak.evidence-transport/1',
      packetCount: 1,
      evidenceSetDigest: `sha256:${'1'.repeat(64)}`,
      packetIds: ['fx/log'],
      scannedAll: true,
      fencedPacketCount: 1,
      findingsByPacket: [{
        packetId: 'fx/log', zone: 'evidence',
        findingCount: 0, peakSeverity: null, disposition: 'fenced',
      }],
      modelOutputFindingCount: 0,
      boundaryDecision: 'allow',
      detectorVersion: 'velum.a32-detector/1.0.0+abaiya-velum-mvp-1',
      registryPayloadSha256: `sha256:${'2'.repeat(64)}`,
    },
    fixtureId: i % 2 === 0 ? 'tlt-008-abstention-required' : 'tlt-009-injection-in-log',
    suiteId: 'local-test-log-triage',
    suiteVersion: '1.0.0',
    split: 'evaluation',
    applicability: 'APPLICABLE',
    lanes: [{
      lane: 'abstention', scorerVersion: 'local-scorers-1.0.0',
      measurements: [{ name: 'abstention.correct', value: 1, unit: 'count', detail: '' }],
      failureCodes: [], attribution: 'MODEL', notes: [],
    }],
    contextPosition: null,
    contextTier: 'control',
    promptTokens: counts.promptTokens,
    completionTokens: counts.completionTokens,
    // The field the whole phase exists to populate.
    tokenCountSource: counts.source,
    timeToFirstTokenMs: 170,
    decodeTokensPerSecond: 64,
    wallTimeMs: 1200,
    seed: 7,
  };
}

async function runExport(tokenizerInputs, identityTokenSource) {
  const { exportBokahliBundle } = await import(pathToFileURL(join(LUAK, 'bokahli-export.js')).href);
  const { scoreAttempt } = await import(pathToFileURL(join(LUAK, 'regime.js')).href);

  const tokenizer = resolveTokenizerIdentity(tokenizerInputs);
  const counts = resolveTokenCounts({
    promptTokens: 189, completionTokens: 68, fromRuntimeUsage: true, tokenizer,
  });
  const records = [0, 1, 2, 3, 4, 5].map((i) => record(i, counts));

  return {
    counts,
    result: exportBokahliBundle({
      taskClass: 'test_log_triage',
      taskClassContractVersion: '1.0.0',
      identity: IDENTITY(identityTokenSource),
      records,
      scored: records.map(scoreAttempt),
      luakBundleIds: records.map((r) => r.attemptId),
      luakBundleHashes: [],
      luakSignatureStatus: null,
      luakRepoCommit: null,
      requireEvaluationSplit: true,
      now: NOW(),
    }),
  };
}

const codes = (r) => [...new Set(r.refusals.map((x) => x.code))].sort();

test('a fully proven Bokahli response permits qualification export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');

  const { counts, result } = await runExport(PROVEN, 'runtime_tokenizer');
  assert.equal(counts.source, 'runtime_tokenizer');
  assert.equal(
    result.ok, true,
    `export still refused: ${JSON.stringify(result.refusals ?? [], null, 1)}`,
  );
  assert.ok(result.bundle.contentHash);
  assert.equal(result.bundle.attempts.length, 6);
});

test('the exported bundle still claims no Bokahli trust', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { result } = await runExport(PROVEN, 'runtime_tokenizer');
  const json = JSON.stringify(result.bundle);
  // Bokahli grants trust by an operator pinning a digest, never by a bundle
  // saying it is trusted. Populating telemetry must not have changed that.
  assert.equal(/"importTrust"/.test(json), false);
  assert.equal(/"verifiedByBokahli"\s*:\s*true/.test(json), false);
});

test('removing the tokenizer digest restores exactly the pilot refusal', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');

  const { counts, result } = await runExport(
    { ...PROVEN, artifactTokenizer: { ...PROVEN.artifactTokenizer, metadataDigest: null } },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['CONTEXT_TIER_NOT_MEASURED', 'TOKEN_COUNTS_NOT_MEASURED']);
  assert.equal(
    result.refusals.filter((r) => r.code === 'TOKEN_COUNTS_NOT_MEASURED').length, 6,
    'one per attempt, exactly as the 2026-08-20 pilot produced',
  );
});

test('removing the runtime vocabulary probe restores the pilot refusal', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  // The file facts are all present and the vocabulary size still agrees. Only
  // the binding to the running process is gone, and that alone must be enough
  // to block export.
  const { counts, result } = await runExport(
    { ...PROVEN, runtimeTokenizerProof: null },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['CONTEXT_TIER_NOT_MEASURED', 'TOKEN_COUNTS_NOT_MEASURED']);
});

test('a probe from a different backend instance does not permit export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { counts, result } = await runExport(
    { ...PROVEN, backendInstanceId: 'instance-2' },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('a disagreeing probe does not permit export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { counts, result } = await runExport(
    {
      ...PROVEN,
      runtimeTokenizerProof: { ...PROVEN.runtimeTokenizerProof, matches: false, samplesMatched: 21 },
    },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('an encode-only proof does not export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  // The mirror image of the decode-only case. Encoding is the direction the
  // counts come from and it is still not the whole claim: without the decode
  // side nothing has confirmed that the ids the runtime produced name the
  // entries this artifact declares.
  const { counts, result } = await runExport(
    {
      ...PROVEN,
      runtimeTokenizerProof: {
        ...PROVEN.runtimeTokenizerProof,
        canary: { ...PROVEN.runtimeTokenizerProof.canary, decodeCanaryVerified: false,
          decodeMatched: 51,
          reasons: ['runtime decoding disagrees with the artifact token table (51/54 matched)'] },
      },
    },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('a canary from the wrong suite does not export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  // A suite that failed its binding checks reports its reasons and verifies
  // nothing; the identity must carry that through to the exporter rather than
  // presenting a suite id as if it had passed.
  const { counts, result } = await runExport(
    {
      ...PROVEN,
      runtimeTokenizerProof: {
        ...PROVEN.runtimeTokenizerProof,
        canary: {
          ...PROVEN.runtimeTokenizerProof.canary,
          canarySuiteId: 'someone-elses.v1',
          decodeCanaryVerified: false, encodeCanaryVerified: false,
          reasons: ['canary was generated for a different artifact digest; a canary is not portable'],
        },
      },
    },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('removing the encode canary alone restores the pilot refusal', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  // Everything else is intact and passing: the artifact is attested, the
  // metadata digest is present, the vocabulary sizes agree, the sampled probe
  // matches, and every decode case matches. Only the direction that produces
  // the counts is unverified — which is exactly the state f270ee9 shipped in,
  // and it must not export.
  const { counts, result } = await runExport(
    {
      ...PROVEN,
      runtimeTokenizerProof: {
        ...PROVEN.runtimeTokenizerProof,
        canary: { ...PROVEN.runtimeTokenizerProof.canary, encodeCanaryVerified: false,
          encodeMatched: 39, failedCaseIds: ['merge-run'],
          reasons: ['runtime encoding disagrees with the pinned canary (39/40 cases matched)'] },
      },
    },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ['CONTEXT_TIER_NOT_MEASURED', 'TOKEN_COUNTS_NOT_MEASURED']);
});

test('a decode-only proof does not export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  // The shape f270ee9 would have produced: no canary at all, a matching
  // sampled decode probe, and counts presented as proven.
  const { counts, result } = await runExport(
    {
      ...PROVEN,
      runtimeTokenizerProof: {
        ...PROVEN.runtimeTokenizerProof, method: 'runtime-vocab-probe', canary: null,
      },
    },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('a canary verified against another backend instance does not export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { counts, result } = await runExport(
    {
      ...PROVEN,
      runtimeTokenizerProof: {
        ...PROVEN.runtimeTokenizerProof,
        canary: { ...PROVEN.runtimeTokenizerProof.canary, verifiedBackendInstanceId: 'instance-0' },
      },
    },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('an unattested backend blocks export even with a tokenizer digest present', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { counts, result } = await runExport(
    { ...PROVEN, artifactAttested: false },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('a vocabulary mismatch blocks export: the tokenizer is not bound to the loaded model', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { counts, result } = await runExport(
    { ...PROVEN, runtimeVocabSize: 32000 },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test('a backend reporting no vocabulary size blocks export', async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { counts, result } = await runExport(
    { ...PROVEN, runtimeVocabSize: null },
    'runtime_reported_unknown_tokenizer',
  );
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.equal(result.ok, false);
});

test("Luak's exportable set is still exactly one value", async (t) => {
  if (!AVAILABLE) return t.skip('Luak is not checked out at ~/repos/luak');
  const { EXPORTABLE_TOKEN_SOURCES } = await import(pathToFileURL(join(LUAK, 'regime.js')).href);
  // If this ever grows, Bokahli's proof requirements have been relaxed on the
  // other side of the boundary and this repo needs to know.
  assert.deepEqual([...EXPORTABLE_TOKEN_SOURCES], ['runtime_tokenizer']);
});
