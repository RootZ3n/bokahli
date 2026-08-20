/**
 * Provenance probes: what may be claimed, and what may not.
 *
 * The defect this phase exists to fix was not a wrong number. Bokahli's token
 * counts were almost certainly exact — they come from llama.cpp's own `usage`
 * block. The defect was that nothing said so, and "almost certainly" cannot be
 * distinguished afterwards from "we assumed". So every test here is about the
 * boundary between a fact and an assumption, and most of them check that the
 * weaker verdict is returned when a proof is taken away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LLAMA_UNSET_SEED,
  parseGpuFlags,
  parseStartTicks,
  probeBackendInstance,
  probeDevicePlacement,
  probeRuntimeFacts,
  readGgufTokenizerMetadata,
  resolveSamplerFacts,
  resolveTemplateFacts,
  resolveTokenCounts,
  resolveTokenizerIdentity,
  templateDigest,
  tokenizerFullyProven,
  probeRuntimeTokenizer,
  sampleIds,
  decodeByteLevel,
} from '../dist/index.js';

const NOW = () => new Date('2026-08-20T12:00:00.000Z');

// ---------------------------------------------------------------------------
// a real GGUF file, built byte by byte
// ---------------------------------------------------------------------------

/**
 * Build a minimal but genuine GGUF header.
 *
 * A hand-built fixture rather than a mocked reader, because the reader's whole
 * job is to parse bytes correctly and a mock would test the mock. The layout
 * follows the GGUF specification: magic, version, tensor count, kv count, then
 * length-prefixed keys with tagged values.
 */
function buildGguf(kv) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([u64(t.length), t]); };

  parts.push(Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(Object.keys(kv).length));
  for (const [k, v] of Object.entries(kv)) {
    parts.push(str(k));
    if (typeof v === 'string') parts.push(u32(8), str(v));
    else if (typeof v === 'boolean') parts.push(u32(7), Buffer.from([v ? 1 : 0]));
    else if (typeof v === 'number') parts.push(u32(4), u32(v));
    else if (Array.isArray(v)) {
      parts.push(u32(9), u32(8), u64(v.length));
      for (const s of v) parts.push(str(s));
    } else if (v && v.int32Array) {
      parts.push(u32(9), u32(5), u64(v.int32Array.length));
      for (const n of v.int32Array) parts.push(u32(n));
    }
  }
  return Buffer.concat(parts);
}

const FULL_KV = {
  'general.architecture': 'qwen35moe',
  'tokenizer.ggml.model': 'gpt2',
  'tokenizer.ggml.pre': 'qwen35',
  'tokenizer.ggml.tokens': ['a', 'b', 'c', 'd'],
  'tokenizer.ggml.merges': ['a b', 'c d'],
  'tokenizer.ggml.token_type': { int32Array: [1, 1, 1, 3] },
  'tokenizer.ggml.eos_token_id': 3,
  'tokenizer.ggml.add_bos_token': false,
  'tokenizer.chat_template': '{{ messages }}',
};

async function writeGguf(kv) {
  const dir = await mkdtemp(join(tmpdir(), 'bokahli-gguf-'));
  const p = join(dir, 'a.gguf');
  await writeFile(p, buildGguf(kv));
  return p;
}

test('gguf: tokenizer identity is read from the artifact bytes', async () => {
  const meta = await readGgufTokenizerMetadata(await writeGguf(FULL_KV));
  assert.equal(meta.family, 'gpt2');
  assert.equal(meta.pretokenizer, 'qwen35');
  assert.equal(meta.vocabSize, 4);
  assert.equal(meta.addBosToken, false);
  assert.match(meta.metadataDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(meta.chatTemplate, '{{ messages }}');
  assert.equal(meta.chatTemplateDigest, templateDigest('{{ messages }}'));
});

test('gguf: the digest is content-derived, so a changed pre-tokenizer changes it', async () => {
  const a = await readGgufTokenizerMetadata(await writeGguf(FULL_KV));
  const b = await readGgufTokenizerMetadata(
    await writeGguf({ ...FULL_KV, 'tokenizer.ggml.pre': 'qwen2' }),
  );
  assert.notEqual(a.metadataDigest, b.metadataDigest);
  // Same family and same vocab size: a name-based identity would have collided
  // here, which is exactly the case this digest exists to catch.
  assert.equal(a.family, b.family);
  assert.equal(a.vocabSize, b.vocabSize);
});

test('gguf: a changed vocabulary changes the digest', async () => {
  const a = await readGgufTokenizerMetadata(await writeGguf(FULL_KV));
  const b = await readGgufTokenizerMetadata(
    await writeGguf({ ...FULL_KV, 'tokenizer.ggml.tokens': ['a', 'b', 'c', 'e'] }),
  );
  assert.notEqual(a.metadataDigest, b.metadataDigest);
});

test('gguf: identical metadata produces an identical digest', async () => {
  const a = await readGgufTokenizerMetadata(await writeGguf(FULL_KV));
  const b = await readGgufTokenizerMetadata(await writeGguf(FULL_KV));
  assert.equal(a.metadataDigest, b.metadataDigest);
});

test('gguf: a non-GGUF file is refused, not guessed at', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bokahli-gguf-'));
  const p = join(dir, 'not.gguf');
  await writeFile(p, Buffer.from('this is not a model'));
  await assert.rejects(() => readGgufTokenizerMetadata(p), /not a GGUF file/);
});

test('gguf: an artifact with no tokenizer metadata yields a null digest, not a hash of nothing', async () => {
  const meta = await readGgufTokenizerMetadata(await writeGguf({ 'general.architecture': 'x' }));
  assert.equal(meta.metadataDigest, null);
  assert.equal(meta.family, null);
});

// ---------------------------------------------------------------------------
// tokenizer provenance verdict
// ---------------------------------------------------------------------------

const PROVEN_TOKENIZER = {
  artifactTokenizer: {
    family: 'gpt2', pretokenizer: 'qwen35', vocabSize: 248320,
    metadataDigest: `sha256:${'a'.repeat(64)}`,
    chatTemplateDigest: `sha256:${'b'.repeat(64)}`,
  },
  runtimeVocabSize: 248320,
  runtimeBuild: 'b10505',
  artifactAttested: true,
  backendInstanceId: 'i1',
  runtimeTokenizerProof: {
    matches: true, samplesChecked: 24, samplesMatched: 24,
    segmentationDigest: `sha256:${'7c'.repeat(32)}`, backendInstanceId: 'i1',
    observedAt: '2026-08-20T12:00:00.000Z', detail: null,
    canary: {
      schemaVersion: 'bokahli.tokenizer-canary.v1',
      canarySuiteId: 'qwen35-broad.v1', canarySuiteHash: `sha256:${'3a'.repeat(32)}`,
      decodeCanaryVerified: true, encodeCanaryVerified: true,
      encodeChecked: 40, encodeMatched: 40, decodeChecked: 54, decodeMatched: 54,
      failedCaseIds: [], encodeReferenceMethod: 'llama-tokenize-vocab-only',
      decodeReferenceMethod: 'gguf-token-table',
      verifiedBackendInstanceId: 'i1', verifiedAt: '2026-08-20T12:00:00.000Z',
      reasons: [], coverageNote: 'behavioural canary coverage, not proof of equivalence',
    },
    method: 'runtime-canary-probe',
  },
  now: NOW,
};

test('runtime_tokenizer is claimable only with every proof, binding included', () => {
  const t = resolveTokenizerIdentity(PROVEN_TOKENIZER);
  assert.deepEqual(t.unprovenReasons, []);
  assert.equal(tokenizerFullyProven(t), true);
  assert.equal(t.vocabSizeMatch, true);

  const counts = resolveTokenCounts({
    promptTokens: 189, completionTokens: 68, fromRuntimeUsage: true, tokenizer: t,
  });
  assert.equal(counts.source, 'runtime_tokenizer');
});

test('an unattested backend cannot yield a runtime-tokenizer claim', () => {
  const t = resolveTokenizerIdentity({ ...PROVEN_TOKENIZER, artifactAttested: false });
  assert.equal(tokenizerFullyProven(t), false);
  assert.match(t.unprovenReasons.join(' '), /not attested/);
  const counts = resolveTokenCounts({
    promptTokens: 189, completionTokens: 68, fromRuntimeUsage: true, tokenizer: t,
  });
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
});

test('a family name without a content digest is not an identity', () => {
  const t = resolveTokenizerIdentity({
    ...PROVEN_TOKENIZER,
    artifactTokenizer: { ...PROVEN_TOKENIZER.artifactTokenizer, metadataDigest: null },
  });
  assert.equal(tokenizerFullyProven(t), false);
  assert.equal(t.family, 'gpt2', 'the family is still reported, just not treated as proof');
  assert.match(t.unprovenReasons.join(' '), /no tokenizer metadata to hash/);
});

test('a vocabulary-size mismatch is a refusal, and says both numbers', () => {
  const t = resolveTokenizerIdentity({ ...PROVEN_TOKENIZER, runtimeVocabSize: 32000 });
  assert.equal(t.vocabSizeMatch, false);
  assert.equal(tokenizerFullyProven(t), false);
  assert.match(t.unprovenReasons.join(' '), /248320/);
  assert.match(t.unprovenReasons.join(' '), /32000/);
});

test('a backend that reports no vocabulary size leaves the binding unproven', () => {
  const t = resolveTokenizerIdentity({ ...PROVEN_TOKENIZER, runtimeVocabSize: null });
  assert.equal(t.vocabSizeMatch, null);
  assert.equal(tokenizerFullyProven(t), false);
  assert.match(t.unprovenReasons.join(' '), /did not report a vocabulary size/);
});

test('missing tokenizer identity blocks qualification rather than degrading to an estimate', () => {
  const counts = resolveTokenCounts({
    promptTokens: 10, completionTokens: 5, fromRuntimeUsage: true, tokenizer: null,
  });
  assert.equal(counts.source, 'runtime_reported_unknown_tokenizer');
  assert.notEqual(counts.source, 'estimated', 'the runtime did count; that is not an estimate');
});

test('an absent count is unknown, never zero', () => {
  const t = resolveTokenizerIdentity(PROVEN_TOKENIZER);
  const counts = resolveTokenCounts({
    promptTokens: null, completionTokens: 68, fromRuntimeUsage: true, tokenizer: t,
  });
  assert.equal(counts.promptTokenSource, 'unknown');
  assert.equal(counts.completionTokenSource, 'runtime_tokenizer');
  assert.equal(counts.source, 'unknown', 'the weaker of the two governs the verdict');
});

test('counts not taken from the runtime are never a runtime-tokenizer measurement', () => {
  const t = resolveTokenizerIdentity(PROVEN_TOKENIZER);
  const counts = resolveTokenCounts({
    promptTokens: 189, completionTokens: 68, fromRuntimeUsage: false, tokenizer: t,
  });
  assert.equal(counts.source, 'unknown');
});

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

test('a runtime template matching the artifact proves the model own template was applied', () => {
  const text = '{{ messages }}';
  const f = resolveTemplateFacts({
    runtimeTemplate: text,
    artifactTemplateDigest: templateDigest(text),
    effectiveChatFormat: 'peg-native',
    effectiveReasoningFormat: 'deepseek',
    requestedChatFormat: null,
    digestOf: templateDigest,
    now: NOW,
  });
  assert.equal(f.configured.matchesArtifactTemplate, true);
  assert.equal(f.configured.appliedBy, 'runtime');
  assert.equal(f.configured.applied, null, 'configuration is not application');
  assert.equal(f.configured.templateId, 'peg-native');
});

test('a substituted template is caught by bytes even when the name is unchanged', () => {
  const f = resolveTemplateFacts({
    runtimeTemplate: '{{ something else }}',
    artifactTemplateDigest: templateDigest('{{ messages }}'),
    effectiveChatFormat: 'peg-native',
    effectiveReasoningFormat: 'none',
    requestedChatFormat: null,
    digestOf: templateDigest,
    now: NOW,
  });
  assert.equal(f.configured.matchesArtifactTemplate, false);
});

test('requested and effective template are separate, and a mismatch is reported', () => {
  const f = resolveTemplateFacts({
    runtimeTemplate: '{{ messages }}',
    artifactTemplateDigest: templateDigest('{{ messages }}'),
    effectiveChatFormat: 'peg-native',
    effectiveReasoningFormat: 'deepseek',
    requestedChatFormat: 'content-only',
    digestOf: templateDigest,
    now: NOW,
  });
  assert.equal(f.requested.templateId, 'content-only');
  assert.equal(f.configured.templateId, 'peg-native');
  assert.equal(f.mismatch, true);
  assert.equal(f.requested.provenance, 'requested');
  assert.equal(f.configured.provenance, 'runtime-reported');
});

test('asking for nothing is not the same as not knowing what was asked', () => {
  const f = resolveTemplateFacts({
    runtimeTemplate: '{{ messages }}',
    artifactTemplateDigest: templateDigest('{{ messages }}'),
    effectiveChatFormat: 'peg-native',
    effectiveReasoningFormat: 'none',
    requestedChatFormat: null,
    digestOf: templateDigest,
    now: NOW,
  });
  assert.equal(f.requested, null);
  assert.equal(f.mismatch, null, 'no request means no mismatch, not a false one');
});

test('a runtime that reports no template yields unknown authority, not an assumed one', () => {
  const f = resolveTemplateFacts({
    runtimeTemplate: null,
    artifactTemplateDigest: templateDigest('{{ messages }}'),
    effectiveChatFormat: null,
    effectiveReasoningFormat: null,
    requestedChatFormat: null,
    digestOf: templateDigest,
    now: NOW,
  });
  assert.equal(f.configured.appliedBy, 'unknown');
  assert.equal(f.configured.applied, null);
  assert.equal(f.configured.matchesArtifactTemplate, null);
});

// ---------------------------------------------------------------------------
// sampler and seed
// ---------------------------------------------------------------------------

const slot = (o) => ({
  seed: null, temperature: null, topP: null, topK: null, maxTokens: null,
  chatFormat: null, reasoningFormat: null, ...o,
});

test('seed: not requested', () => {
  const f = resolveSamplerFacts({
    requested: {}, sent: { temperature: 0 }, slot: slot({ seed: LLAMA_UNSET_SEED }),
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'not_requested');
  assert.equal(f.effective.seed, undefined, 'the sentinel is not a seed value');
});

test('seed: requested but unconfirmed — sending is not honouring', () => {
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 }, slot: null,
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'requested');
  assert.equal(f.effectiveSource, 'unavailable');
});

test('seed: an echo without a correlation handle is not honoured', () => {
  // This is the state on the pinned llama.cpp build. The slot shows our seed
  // and that is not evidence: the reading could predate the request, follow its
  // reset, or belong to the next queued one.
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 }, slot: slot({ seed: 7 }),
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'requested');
  assert.equal(f.effectiveScope, 'backend-instance');
});

test('seed: honoured once a correlation handle ties the reading to this generation', () => {
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 }, slot: slot({ seed: 7 }),
    requestCorrelation: { slotId: 0, taskId: 635 },
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'honoured');
  assert.equal(f.effective.seed, 7);
  assert.equal(f.effectiveScope, 'request');
});

test('seed: a correlated echo of a different value is overridden', () => {
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 }, slot: slot({ seed: 99 }),
    requestCorrelation: { slotId: 0, taskId: 635 },
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'overridden');
});

test('seed: a correlation handle from a restarted instance is discarded', () => {
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 }, slot: slot({ seed: 7 }),
    requestCorrelation: { slotId: 0, taskId: 635 },
    slotCorrelation: { backendInstanceId: 'i-new', requestInstanceId: 'i-old' },
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'requested');
  assert.equal(f.effective, null);
});

test('seed: unavailable when the runtime reports no seed at all', () => {
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 }, slot: slot({ seed: null }),
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'requested');
});

test('deterministic settings never claim deterministic output', () => {
  const f = resolveSamplerFacts({
    requested: { temperature: 0, seed: 1 }, sent: { temperature: 0, seed: 1 },
    slot: slot({ temperature: 0, seed: 1 }),
    requestCorrelation: { slotId: 0, taskId: 1 },
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'honoured');
  assert.equal(f.deterministicOutputGuaranteed, false);
});

test('requested and sent stay distinct so defaults do not masquerade as asks', () => {
  const f = resolveSamplerFacts({
    requested: {}, sent: { temperature: 0.7, topP: 0.95, maxTokens: 512 },
    slot: null, unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.deepEqual(f.requested, {});
  assert.equal(f.sent.temperature, 0.7);
});

// ---------------------------------------------------------------------------
// backend instance
// ---------------------------------------------------------------------------

function instanceSources(o) {
  return {
    readStat: async () => o.stat ?? '20348 (llama-server) S 1 2 3 4 -1 0 0 0 0 0 0 0 0 0 20 0 30 0 132307 1 2',
    readBootId: async () => o.bootId ?? '040fac33-0000-0000-0000-000000000000',
    readBtime: async () => o.btime ?? 1787224720,
    readCmdline: async () => o.cmdline ?? '/opt/bin/llama-server\x00--n-gpu-layers\x00999\x00--cpu-moe\x00',
    now: NOW,
  };
}

test('stat parsing survives a process name containing spaces and parentheses', () => {
  assert.equal(parseStartTicks('1 (llama-server) S 1 2 3 4 -1 0 0 0 0 0 0 0 0 0 20 0 30 0 132307 1'), 132307);
  assert.equal(parseStartTicks('1 (weird (name) here) S 1 2 3 4 -1 0 0 0 0 0 0 0 0 0 20 0 30 0 999 1'), 999);
});

test('a backend restart with a new pid is a different instance', async () => {
  const a = await probeBackendInstance(20348, instanceSources({}));
  const b = await probeBackendInstance(20999, instanceSources({}));
  assert.ok(a.instanceId);
  assert.notEqual(a.instanceId, b.instanceId);
});

test('pid reuse with a changed kernel start time is a different instance', async () => {
  const a = await probeBackendInstance(20348, instanceSources({}));
  const b = await probeBackendInstance(
    20348,
    instanceSources({ stat: '20348 (llama-server) S 1 2 3 4 -1 0 0 0 0 0 0 0 0 0 20 0 30 0 999999 1' }),
  );
  assert.notEqual(a.instanceId, b.instanceId, 'a recycled pid must not look like continuity');
});

test('the same process yields a stable instance id', async () => {
  const a = await probeBackendInstance(20348, instanceSources({}));
  const b = await probeBackendInstance(20348, instanceSources({}));
  assert.equal(a.instanceId, b.instanceId);
});

test('a reboot changes the instance id even at the same pid and tick count', async () => {
  const a = await probeBackendInstance(20348, instanceSources({}));
  const b = await probeBackendInstance(
    20348,
    instanceSources({ bootId: 'ffffffff-0000-0000-0000-000000000000' }),
  );
  assert.notEqual(a.instanceId, b.instanceId);
});

test('start time comes from the kernel, not from wall-clock', async () => {
  const a = await probeBackendInstance(20348, instanceSources({}));
  assert.equal(a.kernelStartTicks, 132307);
  assert.equal(a.startedAt, new Date((1787224720 + 132307 / 100) * 1000).toISOString());
});

test('an unreadable stat leaves no instance id and says why', async () => {
  const a = await probeBackendInstance(20348, {
    ...instanceSources({}),
    readStat: async () => { throw new Error('Permission denied'); },
  });
  assert.equal(a.instanceId, null);
  assert.match(a.unavailableReasons.join(' '), /stat unreadable/);
});

test('gpu flags are parsed from argv without keeping argv', () => {
  const f = parseGpuFlags('/opt/bin/llama-server\x00--n-gpu-layers\x00999\x00--cpu-moe\x00--api-key\x00hunter2\x00');
  assert.deepEqual(f, { requestedGpuLayers: 999, cpuOffloadEnabled: true });
  assert.equal(Object.values(f).includes('hunter2'), false);
});

test('gpu flags: absent flags are null and false, not defaults that look measured', () => {
  assert.deepEqual(parseGpuFlags('/opt/bin/llama-server\x00'), {
    requestedGpuLayers: null, cpuOffloadEnabled: false,
  });
});

// ---------------------------------------------------------------------------
// device placement
// ---------------------------------------------------------------------------

const placementInputs = { backendPid: 20348, requestedGpuLayers: 999, cpuOffloadEnabled: true };

test('placement is proven when the driver lists our exact pid', async () => {
  const p = await probeDevicePlacement(placementInputs, {
    now: NOW,
    queryComputeApps: async () => [{ pid: 20348, usedMiB: 2430 }],
  });
  assert.equal(p.backendHoldsDevice, true);
  assert.equal(p.backendVramMiB, 2430);
  assert.equal(p.method, 'nvidia-smi-compute-apps');
  assert.equal(p.limitation, null);
});

test('another process holding the GPU does not prove our placement', async () => {
  const p = await probeDevicePlacement(placementInputs, {
    now: NOW,
    // A ComfyUI-sized allocation, and none of it ours.
    queryComputeApps: async () => [{ pid: 4242, usedMiB: 9000 }],
  });
  assert.equal(p.backendHoldsDevice, false);
  assert.equal(p.backendVramMiB, null);
});

test('an unreadable driver table is unknown placement, not absent placement', async () => {
  const p = await probeDevicePlacement(placementInputs, {
    now: NOW,
    queryComputeApps: async () => { throw new Error('nvidia-smi not found'); },
  });
  assert.equal(p.backendHoldsDevice, null, 'null, never false: we did not check');
  assert.equal(p.method, 'unavailable');
  assert.match(p.limitation, /not the same as absent/);
});

test('placement without a pid cannot be attributed to a process', async () => {
  const p = await probeDevicePlacement({ ...placementInputs, backendPid: null }, {
    now: NOW,
    queryComputeApps: async () => [{ pid: 20348, usedMiB: 2430 }],
  });
  assert.equal(p.backendHoldsDevice, null);
  assert.match(p.limitation, /pid unresolved/);
});

test('requested gpu layers are carried as a request, never as an observation', async () => {
  const p = await probeDevicePlacement(placementInputs, {
    now: NOW, queryComputeApps: async () => [],
  });
  assert.equal(p.requestedGpuLayers, 999);
  assert.equal(p.cpuOffloadEnabled, true);
  assert.equal(p.backendHoldsDevice, false, '999 requested layers proves nothing about placement');
});

// ---------------------------------------------------------------------------
// runtime facts
// ---------------------------------------------------------------------------

function hostSources(o = {}) {
  const files = o.files ?? {
    'llama-server': 'stub', 'libggml-cuda.so.0': 'cuda',
    'libggml-base.so.0': 'base', 'libggml-cpu.so.0': 'cpu',
    'libggml.so.0': 'ggml', 'libllama.so.0': 'llama',
  };
  return {
    readProcMaps: o.readProcMaps ?? (async () =>
      '7f00-7f01 r-xp /usr/lib64/libcudart.so.13.2.51\n' +
      '7f02-7f03 r-xp /usr/lib64/libcublas.so.13.3.0.5\n' +
      '7f04-7f05 r-xp /opt/bin/libggml-cuda.so.0\n' +
      '7f08-7f09 r-xp /opt/bin/libggml-base.so.0\n' +
      '7f0a-7f0b r-xp /opt/bin/libggml-cpu.so.0\n' +
      '7f0c-7f0d r-xp /opt/bin/libggml.so.0\n' +
      '7f0e-7f0f r-xp /opt/bin/libllama.so.0\n' +
      '7f06-7f07 r-xp /opt/bin/llama-server\n'),
    listDir: async () => Object.keys(files),
    isSymlink: o.isSymlink ?? (async () => false),
    hashFile: async (p) => {
      const name = p.slice(p.lastIndexOf('/') + 1);
      if (!(name in files)) throw new Error('unreadable');
      return Buffer.from(files[name]).toString('hex').padEnd(64, '0');
    },
    fileSize: async () => 1000,
    nvidiaSmi: o.nvidiaSmi ?? (async (args) =>
      args.length === 0 ? 'blah CUDA Version: 13.2 blah' : '595.91.07\n'),
    now: NOW,
  };
}

const hostInputs = { executablePath: '/opt/bin/llama-server', backendPid: 20348, build: 'b10505' };

test('the image digest covers the shared objects, not just the stub executable', async () => {
  const a = await probeRuntimeFacts(hostInputs, hostSources());
  const b = await probeRuntimeFacts(
    hostInputs,
    hostSources({ files: {
      'llama-server': 'stub', 'libggml-cuda.so.0': 'REBUILT',
      'libggml-base.so.0': 'base', 'libggml-cpu.so.0': 'cpu',
      'libggml.so.0': 'ggml', 'libllama.so.0': 'llama',
    } }),
  );
  assert.notEqual(
    a.imageDigest, b.imageDigest,
    'the stub is unchanged; a stub-only digest would have missed this entirely',
  );
});

test('the image digest is bound to the process when /proc/<pid>/maps can be read', async () => {
  const f = await probeRuntimeFacts(hostInputs, hostSources());
  assert.equal(f.imageDigestBinding, 'process-mapped');
  assert.equal(f.limitation, null);
});

test('a denied /proc/<pid>/maps falls back and announces that it fell back', async () => {
  const f = await probeRuntimeFacts(hostInputs, hostSources({
    readProcMaps: async () => { throw new Error('Permission denied'); },
  }));
  assert.equal(f.imageDigestBinding, 'configured-tree');
  assert.match(f.limitation, /proves what is on disk rather than what this process mapped/);
  assert.ok(f.imageDigest, 'a weaker binding is still a digest');
});

test('the two CUDA versions are kept apart', async () => {
  const f = await probeRuntimeFacts(hostInputs, hostSources());
  assert.equal(f.driverSupportedCuda, '13.2', 'what the driver could support');
  assert.equal(f.processCudaRuntime, '13.2.51', 'what the process actually loaded');
  assert.equal(f.cublasVersion, '13.3.0.5');
  assert.equal(f.driverVersion, '595.91.07');
});

test('no driver means null, not a copied version string', async () => {
  const f = await probeRuntimeFacts(hostInputs, hostSources({
    nvidiaSmi: async () => { throw new Error('nvidia-smi: not found'); },
  }));
  assert.equal(f.driverVersion, null);
  assert.equal(f.driverSupportedCuda, null);
  assert.match(f.limitation, /driver version unavailable/);
});

test('the CUDA the process uses is unknown when maps is denied, and is not filled from the driver', async () => {
  const f = await probeRuntimeFacts(hostInputs, hostSources({
    readProcMaps: async () => { throw new Error('Permission denied'); },
  }));
  assert.equal(f.processCudaRuntime, null);
  assert.equal(f.driverSupportedCuda, '13.2', 'the driver capability is still known');
  assert.match(f.limitation, /only the driver-supported version is known/);
});

test('image components are basenames, so no path can be reconstructed', async () => {
  const f = await probeRuntimeFacts(hostInputs, hostSources());
  for (const c of f.imageComponents) {
    assert.equal(c.includes('/'), false, `"${c}" leaks a path`);
  }
  assert.ok(f.imageComponents.includes('llama-server'));
});

test('the unset sentinel is not a substituted seed', () => {
  // Found by test: comparing the sentinel against a sent seed yields "not
  // equal" and reported `overridden`, which accuses the runtime of swapping a
  // seed it never echoed. The sentinel means "no seed reported", so the honest
  // verdict is that the request is unconfirmed.
  const f = resolveSamplerFacts({
    requested: { seed: 7 }, sent: { seed: 7 },
    slot: slot({ seed: LLAMA_UNSET_SEED }),
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  assert.equal(f.seedSupport, 'requested');
  assert.notEqual(f.seedSupport, 'overridden');
  assert.equal(f.effective.seed, undefined);
});

// ---------------------------------------------------------------------------
// the runtime vocabulary probe
// ---------------------------------------------------------------------------

const TOKENS = Array.from({ length: 1000 }, (_, i) => `tok${i}`);

function probeSources(o = {}) {
  return {
    tokenize: o.tokenize ?? (async () => [1, 2, 3]),
    detokenize: o.detokenize ?? (async ([id]) => TOKENS[id]),
    now: NOW,
  };
}

test('probe: sampled ids are deterministic and cover both ends of the vocabulary', () => {
  const a = sampleIds(248320);
  const b = sampleIds(248320);
  assert.deepEqual(a, b, 'two runs must check the same entries or results are not comparable');
  assert.equal(a[0], 0);
  assert.equal(a.at(-1), 248319, 'the added-token region is where a substitution shows up');
  assert.ok(a.length > 1 && a.length <= 24);
});

test('probe: a matching vocabulary proves the binding', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' }, probeSources(),
  );
  assert.equal(p.matches, true);
  assert.equal(p.samplesMatched, p.samplesChecked);
  assert.equal(p.backendInstanceId, 'i1');
  assert.match(p.segmentationDigest, /^sha256:/);
});

test('probe: one substituted entry is caught', async () => {
  // The case the whole probe exists for: an --override-kv replacing the token
  // table, invisible to the artifact digest and to the vocabulary size.
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' },
    probeSources({ detokenize: async ([id]) => (id === 999 ? 'TAMPERED' : TOKENS[id]) }),
  );
  assert.equal(p.matches, false);
  assert.equal(p.detail.includes('999'), true);
});

test('probe: ids are compared one at a time so differences cannot cancel out', async () => {
  const seen = [];
  await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' },
    probeSources({ detokenize: async (ids) => { seen.push(ids.length); return TOKENS[ids[0]]; } }),
  );
  assert.ok(seen.every((n) => n === 1), 'batching would let an offsetting pair pass');
});

test('probe: a failing runtime is unproven, not silently matched', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' },
    probeSources({ detokenize: async () => { throw new TypeError('connection reset'); } }),
  );
  assert.equal(p.matches, false);
  assert.match(p.detail, /detokenize failed/);
});

test('probe: no artifact token table means nothing to compare against', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: null, backendInstanceId: 'i1' }, probeSources(),
  );
  assert.equal(p.matches, false);
  assert.equal(p.samplesChecked, 0);
});

test('probe: a failed tokenize costs the segmentation record, not the binding', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' },
    probeSources({ tokenize: async () => { throw new Error('nope'); } }),
  );
  assert.equal(p.matches, true, 'the vocabulary comparison is what binds');
  assert.equal(p.segmentationDigest, null);
});

test('probe: segmentation digest changes when the runtime segments differently', async () => {
  const a = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' },
    probeSources({ tokenize: async () => [1, 2, 3] }),
  );
  const b = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS, backendInstanceId: 'i1' },
    probeSources({ tokenize: async () => [1, 2, 4] }),
  );
  assert.notEqual(a.segmentationDigest, b.segmentationDigest);
});

test('probe: byte-level encoded tokens decode before comparison', () => {
  // GGUF stores a leading space as U+0120. Comparing the encoded form against
  // the runtime's decoded text would fail on every whitespace-bearing token and
  // the probe would be switched off as broken.
  assert.equal(decodeByteLevel('Ġhello'), ' hello');
  assert.equal(decodeByteLevel('Ċline'), '\nline');
  assert.equal(decodeByteLevel('plain'), 'plain');
});
