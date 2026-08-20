/**
 * Hostile audit of f270ee9's tokenizer proof, and of the attestation lifetime.
 *
 * f270ee9 asked the runtime to decode sampled ids and called the result the
 * behavioural binding. It is a real check and it reads the token *table*. The
 * table is not what turns text into ids — merges, the pre-tokenizer, and
 * added-token handling do that, and `--override-kv` reaches all three at load
 * time without touching a byte of the file. So every attack in section A below
 * leaves the token table intact, passes every decode sample f270ee9 would have
 * taken, and changes every `usage.prompt_tokens`.
 *
 * Each test is an attack. The comments record what the attack was, because a
 * defence whose reason is forgotten is removed by the next person who finds it
 * inconvenient.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canaryPayloadHash,
  decodeByteLevel,
  decodeByteLevelBytes,
  isSelfContainedUtf8,
  probeRuntimeTokenizer,
  resolveTokenCounts,
  resolveTokenizerIdentity,
  tokenizerFullyProven,
  verifyTokenizerCanary,
} from '@bokahli/runtime';
import { evaluateAttemptLifetime } from '../dist/lifetime.js';

const NOW = () => new Date('2026-08-20T12:00:00.000Z');
const ARTIFACT = `sha256:${'49'.repeat(32)}`;
const META = `sha256:${'1f'.repeat(32)}`;
const OTHER_ARTIFACT = `sha256:${'aa'.repeat(32)}`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/**
 * The corpus, in miniature. Three encode cases and two decode cases, chosen so
 * that each attack below can be aimed at exactly one of them.
 */
const ENCODE = [
  { id: 'plain', note: 'ascii words', inputBase64: b64('hello world'), expectedIds: [10, 11] },
  { id: 'merge-run', note: 'a repeated substring the merge table collapses', inputBase64: b64('aaaa'), expectedIds: [20] },
  { id: 'ws-lead', note: 'leading whitespace, a pre-tokenizer boundary', inputBase64: b64('  x'), expectedIds: [30, 31] },
  { id: 'special', note: 'a chat special token literal', inputBase64: b64('<|im_end|>'), expectedIds: [999] },
];
const DECODE = [
  { id: 'vocab-10', note: 'ordinary entry', tokenId: 10, expectedBytesBase64: b64('hello') },
  { id: 'vocab-999', note: 'added-token region', tokenId: 999, expectedBytesBase64: b64('<|im_end|>') },
];

const INDEPENDENT_ENCODE_REF = {
  method: 'llama-tokenize-vocab-only',
  generatorComponents: ['llama-tokenize:aa', 'libllama.so.0.1.2:bb'],
  generatorDigest: `sha256:${'cc'.repeat(32)}`,
  generatorBuild: 'version: 0.1.2-dev (build 10505, commit ee4c505a4)',
  producedByBackendInstanceId: null,
  note: 'separate vocab_only process',
};
const INDEPENDENT_DECODE_REF = {
  method: 'gguf-token-table',
  generatorComponents: [`tokenizer.ggml.tokens:${'dd'.repeat(32)}`],
  generatorDigest: META,
  generatorBuild: null,
  producedByBackendInstanceId: null,
  note: 'the artifact’s own table',
};

function suite(o = {}) {
  const s = {
    schemaVersion: 'bokahli.tokenizer-canary.v1',
    suiteId: 'test-corpus.v1',
    artifactDigest: ARTIFACT,
    tokenizerMetadataDigest: META,
    vocabSize: 1000,
    encodeSettings: { addSpecial: false, parseSpecial: true },
    encodeReference: INDEPENDENT_ENCODE_REF,
    decodeReference: INDEPENDENT_DECODE_REF,
    encode: ENCODE,
    decode: DECODE,
    payloadHash: '',
    generatedAt: '2026-08-20T11:00:00.000Z',
    coverage: ['ascii', 'whitespace', 'merges', 'special tokens'],
    note: 'test corpus',
    ...o,
  };
  // Regenerated rather than copied, so a suite built by a test is as internally
  // consistent as one built by the generator — otherwise every test would fail
  // on the hash and none of them would be testing what it claims to.
  if (o.payloadHash === undefined) s.payloadHash = canaryPayloadHash(s);
  return s;
}

const BINDING = { artifactDigest: ARTIFACT, tokenizerMetadataDigest: META, backendInstanceId: 'i1' };

/**
 * A runtime. `overrides` names cases the runtime answers differently, which is
 * how a substituted tokenizer is expressed here: the token table is untouched
 * and the segmentation is not.
 */
function runtime({ encodeOverrides = {}, decodeOverrides = {} } = {}) {
  const byInput = new Map(ENCODE.map((c) => [Buffer.from(c.inputBase64, 'base64').toString('utf8'), c]));
  const byId = new Map(DECODE.map((c) => [c.tokenId, c]));
  return {
    tokenize: async (text) => {
      const c = byInput.get(text);
      if (c === undefined) return [];
      return encodeOverrides[c.id] ?? c.expectedIds;
    },
    detokenize: async ([id]) => {
      const c = byId.get(id);
      if (c === undefined) return '';
      return (
        decodeOverrides[c.id] ?? Buffer.from(c.expectedBytesBase64, 'base64').toString('utf8')
      );
    },
    now: NOW,
  };
}

// ---------------------------------------------------------------------------
// A. the encode direction: what a decode-only proof cannot see
// ---------------------------------------------------------------------------

test('A1: same vocabulary table, changed merges — decode passes and encode catches it', async () => {
  // --override-kv on tokenizer.ggml.merges. Every token still decodes to the
  // same bytes, because the table is the table; `aaaa` now costs two tokens
  // instead of one, because the merge that collapsed it is gone. f270ee9's
  // probe reads only the table and reports a clean match.
  const r = await verifyTokenizerCanary(
    suite(), BINDING, runtime({ encodeOverrides: { 'merge-run': [21, 21] } }),
  );
  assert.equal(r.decodeCanaryVerified, true, 'the table is untouched: this is the blind spot');
  assert.equal(r.encodeCanaryVerified, false);
  assert.deepEqual(r.failedCaseIds, ['merge-run']);
});

test('A2: same vocabulary size, changed pre-tokenizer', async () => {
  // tokenizer.ggml.pre swapped for a variant that splits leading whitespace
  // differently. Same table, same size, same digest on the file.
  const r = await verifyTokenizerCanary(
    suite(), BINDING, runtime({ encodeOverrides: { 'ws-lead': [32, 33, 34] } }),
  );
  assert.equal(r.decodeCanaryVerified, true);
  assert.equal(r.encodeCanaryVerified, false);
});

test('A3: identical decode behaviour, different encode sequences, no claim survives', () => {
  // The composite assertion: a tokenizer identity built on a passing decode
  // side and a failing encode side must not reach runtime_tokenizer, and the
  // counts that come with it must stay unproven.
  const t = resolveTokenizerIdentity({
    artifactTokenizer: { family: 'gpt2', pretokenizer: 'qwen35', vocabSize: 1000, metadataDigest: META },
    runtimeVocabSize: 1000,
    runtimeBuild: 'b1',
    artifactAttested: true,
    backendInstanceId: 'i1',
    runtimeTokenizerProof: {
      method: 'runtime-canary-probe', matches: true, samplesChecked: 24, samplesMatched: 24,
      segmentationDigest: null, backendInstanceId: 'i1',
      observedAt: '2026-08-20T12:00:00.000Z', detail: null,
      canary: {
        schemaVersion: 'bokahli.tokenizer-canary.v1',
        canarySuiteId: 'test-corpus.v1', canarySuiteHash: `sha256:${'3a'.repeat(32)}`,
        decodeCanaryVerified: true, encodeCanaryVerified: false,
        encodeChecked: 4, encodeMatched: 3, decodeChecked: 2, decodeMatched: 2,
        failedCaseIds: ['merge-run'],
        encodeReferenceMethod: 'llama-tokenize-vocab-only',
        decodeReferenceMethod: 'gguf-token-table',
        verifiedBackendInstanceId: 'i1', verifiedAt: '2026-08-20T12:00:00.000Z',
        reasons: ['runtime encoding disagrees with the pinned canary (3/4 cases matched)'],
        coverageNote: 'bounded',
      },
    },
    now: NOW,
  });
  assert.equal(t.decodeCanaryVerified, true);
  assert.equal(t.encodeCanaryVerified, false);
  assert.equal(t.pretokenizerVerified, false);
  assert.equal(tokenizerFullyProven(t), false, 'decode alone is not tokenizer identity');
  assert.equal(t.tokenizedBy, 'unknown');
  const c = resolveTokenCounts({
    promptTokens: 189, completionTokens: 68, fromRuntimeUsage: true, tokenizer: t,
  });
  assert.equal(c.source, 'runtime_reported_unknown_tokenizer');
});

test('A4: a canary generated by the very backend it verifies proves nothing', async () => {
  // The tautology. Expectations read off the live server and then compared back
  // to it pass whatever that server does — including the substitution. Refused
  // on two independent grounds so removing either one does not open it.
  const selfMade = suite({
    encodeReference: {
      ...INDEPENDENT_ENCODE_REF,
      method: 'live-backend',
      producedByBackendInstanceId: 'i1',
    },
  });
  const r = await verifyTokenizerCanary(selfMade, BINDING, runtime());
  assert.equal(r.encodeCanaryVerified, false);
  assert.equal(r.decodeCanaryVerified, false);
  assert.match(r.reasons.join(' '), /not independent|cannot authorise itself/i);
});

test('A4b: a canary from a *different* live backend is still not an independent authority', async () => {
  const r = await verifyTokenizerCanary(
    suite({
      encodeReference: {
        ...INDEPENDENT_ENCODE_REF, method: 'live-backend', producedByBackendInstanceId: 'i-other',
      },
    }),
    BINDING,
    runtime(),
  );
  assert.equal(r.encodeCanaryVerified, false, 'another server is another server, not a reference');
});

test('A5: a canary copied from another artifact is refused', async () => {
  // A suite is expectations about one set of bytes. Accepting one generated for
  // a different artifact imports that model's segmentation as proof of this one.
  const r = await verifyTokenizerCanary(
    suite({ artifactDigest: OTHER_ARTIFACT }), BINDING, runtime(),
  );
  assert.equal(r.encodeCanaryVerified, false);
  assert.match(r.reasons.join(' '), /different artifact/i);
});

test('A5b: a canary whose tokenizer metadata drifted from the artifact is refused', async () => {
  const r = await verifyTokenizerCanary(
    suite({ tokenizerMetadataDigest: `sha256:${'99'.repeat(32)}` }), BINDING, runtime(),
  );
  assert.equal(r.encodeCanaryVerified, false);
  assert.match(r.reasons.join(' '), /tokenizer metadata/i);
});

test('A6: a canary result carried over from another backend instance proves nothing', () => {
  // A verification describes one process. This is the same rule the sampled
  // probe already carried, applied to the thing that now carries the stronger
  // claim — otherwise a restart would be survivable by the better evidence and
  // not the weaker, which is exactly backwards.
  const t = resolveTokenizerIdentity({
    artifactTokenizer: { family: 'gpt2', pretokenizer: 'qwen35', vocabSize: 1000, metadataDigest: META },
    runtimeVocabSize: 1000, runtimeBuild: 'b1', artifactAttested: true,
    backendInstanceId: 'i2',
    runtimeTokenizerProof: {
      method: 'runtime-canary-probe', matches: true, samplesChecked: 24, samplesMatched: 24,
      segmentationDigest: null, backendInstanceId: 'i2',
      observedAt: '2026-08-20T12:00:00.000Z', detail: null,
      canary: {
        schemaVersion: 'bokahli.tokenizer-canary.v1',
        canarySuiteId: 'test-corpus.v1', canarySuiteHash: `sha256:${'3a'.repeat(32)}`,
        decodeCanaryVerified: true, encodeCanaryVerified: true,
        encodeChecked: 4, encodeMatched: 4, decodeChecked: 2, decodeMatched: 2,
        failedCaseIds: [], encodeReferenceMethod: 'llama-tokenize-vocab-only',
        decodeReferenceMethod: 'gguf-token-table',
        // Verified against the process that came before this one.
        verifiedBackendInstanceId: 'i1', verifiedAt: '2026-08-20T11:59:00.000Z',
        reasons: [], coverageNote: 'bounded',
      },
    },
    now: NOW,
  });
  assert.equal(t.encodeCanaryVerified, false);
  assert.equal(tokenizerFullyProven(t), false);
  assert.match(t.unprovenReasons.join(' '), /different backend instance/i);
});

test('A7: one failing encode case is not outvoted by passing decode cases', async () => {
  // No partial credit, and no averaging across directions. Twenty-nine passes
  // and one failure describes a runtime that segments text differently; the
  // failure is the finding.
  const r = await verifyTokenizerCanary(
    suite(), BINDING, runtime({ encodeOverrides: { special: [40, 41, 42] } }),
  );
  assert.equal(r.decodeMatched, r.decodeChecked);
  assert.equal(r.decodeCanaryVerified, true);
  assert.equal(r.encodeMatched, 3);
  assert.equal(r.encodeChecked, 4);
  assert.equal(r.encodeCanaryVerified, false, 'three quarters of a proof is not a proof');
});

test('A8: an intact runtime passes both directions and the claim is allowed', async () => {
  const r = await verifyTokenizerCanary(suite(), BINDING, runtime());
  assert.equal(r.encodeCanaryVerified, true);
  assert.equal(r.decodeCanaryVerified, true);
  assert.deepEqual(r.failedCaseIds, []);
  assert.match(r.coverageNote, /not a proof of tokenizer equivalence/i);
});

test('A9: an edited suite fails its own hash before any probe runs', async () => {
  // Someone widens an expectation to make a failing deployment pass. The hash
  // is over the cases, so the edit is visible without needing to know what the
  // right answer was.
  const s = suite();
  const tampered = {
    ...s,
    encode: s.encode.map((c) => (c.id === 'merge-run' ? { ...c, expectedIds: [21, 21] } : c)),
  };
  const r = await verifyTokenizerCanary(tampered, BINDING, runtime());
  assert.equal(r.encodeCanaryVerified, false);
  assert.match(r.reasons.join(' '), /payload hash/i);
});

test('A10: no canary at all is unproven, not quietly proven', async () => {
  const r = await verifyTokenizerCanary(null, BINDING, runtime());
  assert.equal(r.encodeCanaryVerified, false);
  assert.equal(r.decodeCanaryVerified, false);
  assert.match(r.reasons.join(' '), /never asked to encode/i);
});

test('A11: a decode-only probe cannot present itself as the two-sided one', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: ['a', 'b'], backendInstanceId: 'i1' },
    { tokenize: async () => [1], detokenize: async ([i]) => ['a', 'b'][i], now: NOW },
  );
  assert.equal(p.method, 'runtime-vocab-probe', 'the name reports what was actually done');
  assert.equal(p.canary.encodeCanaryVerified, false);
});

// ---------------------------------------------------------------------------
// B. the byte-level decoder, which was wrong and would have failed a healthy
//    backend rather than a substituted one
// ---------------------------------------------------------------------------

test('B1: multi-byte tokens decode to their own bytes, not to a UTF-8 re-encoding', () => {
  // f270ee9 fell through to Buffer.from(ch, 'utf8') for any codepoint outside
  // the displaced block, which is correct only for ASCII. U+00E4 became the two
  // bytes c3 a4 instead of the one byte e4, so every CJK and accented token
  // decoded to mojibake. A live run of the canary found it: 20 of 33 sampled
  // entries failed against a completely healthy backend.
  //
  // 乾 is e4 b9 be, which byte-level BPE stores as U+00E4 U+00B9 U+00BE.
  assert.deepEqual([...decodeByteLevelBytes('ä¹¾')], [0xe4, 0xb9, 0xbe]);
  assert.equal(decodeByteLevel('ä¹¾'), '乾');
});

test('B2: the displaced whitespace block still decodes', () => {
  assert.equal(decodeByteLevel('Ġhello'), ' hello');
  assert.equal(decodeByteLevel('Ċline'), '\nline');
  assert.equal(decodeByteLevel('plain'), 'plain');
});

test('B3: a byte fragment is not self-contained UTF-8 and must not count as a match', () => {
  // Both sides render a lone continuation byte as U+FFFD, so they agree — a
  // match produced by two independent failures. Such ids are excluded.
  assert.equal(isSelfContainedUtf8(Buffer.from([0xe4, 0xb9, 0xbe])), true);
  assert.equal(isSelfContainedUtf8(Buffer.from([0xb9])), false);
});

test('B4: vocabulary padding is skipped rather than reported as a mismatch', async () => {
  // llama.cpp renders UNUSED entries as the empty string. Pinning the stored
  // text for one produces a case that fails against a healthy backend, and a
  // check that fails when nothing is wrong gets switched off.
  const tokens = ['a', 'b', '[PAD2]', '[PAD3]'];
  const types = [1, 1, 5, 5];
  const p = await probeRuntimeTokenizer(
    { artifactTokens: tokens, artifactTokenTypes: types, backendInstanceId: 'i1' },
    { tokenize: async () => [1], detokenize: async ([i]) => (types[i] === 5 ? '' : tokens[i]), now: NOW },
  );
  assert.equal(p.matches, true, 'padding is not a vocabulary entry');
  assert.equal(p.samplesChecked, 2);
});

test('B5: without token types the padding is not silently forgiven', async () => {
  const tokens = ['a', 'b', '[PAD2]', '[PAD3]'];
  const p = await probeRuntimeTokenizer(
    { artifactTokens: tokens, backendInstanceId: 'i1' },
    { tokenize: async () => [1], detokenize: async ([i]) => (i >= 2 ? '' : tokens[i]), now: NOW },
  );
  assert.equal(p.matches, false, 'unknown types means the mismatch is reported, not assumed benign');
});

// ---------------------------------------------------------------------------
// C. attempt lifetime: does the evidence survive the request?
// ---------------------------------------------------------------------------

const LIFETIME = {
  admittedAt: '2026-08-20T12:00:00.000Z',
  attestationObservedAt: '2026-08-20T11:59:59.000Z',
  attestationExpiresAt: '2026-08-20T12:00:59.000Z',
  instanceAtAdmission: 'i1',
  instanceAtCompletion: 'i1',
  completedAt: '2026-08-20T12:00:30.000Z',
};

test('C1: a request that crosses the TTL without a restart keeps its attribution', () => {
  // The case that made a plain expiry unusable. A 32K prefill measures tens of
  // seconds here and the 65536 tier measured 88.5 s worst case, so requests
  // that outlive a 60-second attestation are ordinary. Discarding them would
  // lose exactly the longest and most context-heavy attempts in a campaign.
  const l = evaluateAttemptLifetime({ ...LIFETIME, completedAt: '2026-08-20T12:02:30.000Z' });
  assert.equal(l.crossedAttestationTtl, true);
  assert.equal(l.instanceContinuous, true);
  assert.equal(l.revalidation, 'instance-continuity');
  assert.equal(l.verdict, 'valid', 'elapsed time is not the question; identity is');
});

test('C2: a request that crosses the TTL with a restart is infrastructure-invalid', () => {
  const l = evaluateAttemptLifetime({
    ...LIFETIME, completedAt: '2026-08-20T12:02:30.000Z', instanceAtCompletion: 'i2',
  });
  assert.equal(l.verdict, 'infrastructure-invalid');
  assert.match(l.reasons.join(' '), /restarted while this request was executing/i);
});

test('C3: a restart inside the TTL is just as invalid', () => {
  // The window is irrelevant. A completion from a process that was never
  // attested for this request is unattributable whether it took 2 seconds or
  // 2 minutes.
  const l = evaluateAttemptLifetime({ ...LIFETIME, instanceAtCompletion: 'i2' });
  assert.equal(l.crossedAttestationTtl, false);
  assert.equal(l.verdict, 'infrastructure-invalid');
});

test('C4: an attestation already expired at admission is refused, not carried', () => {
  const l = evaluateAttemptLifetime({
    ...LIFETIME,
    attestationExpiresAt: '2026-08-20T11:59:00.000Z',
  });
  assert.equal(l.attestationValidAtAdmission, false);
  assert.equal(l.verdict, 'infrastructure-invalid');
  assert.match(l.reasons.join(' '), /already expired when this request was admitted/i);
});

test('C5: unknown continuity is not continuity', () => {
  for (const [a, b] of [[null, 'i1'], ['i1', null], [null, null]]) {
    const l = evaluateAttemptLifetime({
      ...LIFETIME, instanceAtAdmission: a, instanceAtCompletion: b,
    });
    assert.equal(l.verdict, 'infrastructure-invalid', `${String(a)}/${String(b)} must not pass`);
    assert.match(l.reasons.join(' '), /unknown continuity is not continuity/i);
  }
});

test('C6: an unparseable timestamp fails closed rather than comparing NaN', () => {
  const l = evaluateAttemptLifetime({ ...LIFETIME, completedAt: 'not-a-date' });
  assert.equal(l.verdict, 'infrastructure-invalid');
});

test('C7: the ordinary case is valid and says nothing dramatic', () => {
  const l = evaluateAttemptLifetime(LIFETIME);
  assert.equal(l.verdict, 'valid');
  assert.equal(l.crossedAttestationTtl, false);
  assert.equal(l.revalidation, 'none');
  assert.deepEqual(l.reasons, []);
});

// ---------------------------------------------------------------------------
// D. end to end, through the real facts provider and a real GGUF
// ---------------------------------------------------------------------------
//
// The sections above test the rules. This one tests the wiring, because a rule
// that is never reached is not a defence. It writes a minimal but genuine GGUF
// — parsed by the same reader production uses — and runs the whole path:
// metadata read, token table read, sampled probe, canary, tokenizer identity,
// token-count provenance, attestation.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufTokenizerMetadata } from '@bokahli/runtime';
import { QualificationFactsProvider } from '../dist/facts.js';

/** Minimal GGUF v3 writer: enough to carry a tokenizer, and nothing else. */
function gguf(kv) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (v) => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u64(b.length), b]); };
  parts.push(Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(kv.length));
  for (const [key, type, value] of kv) {
    parts.push(str(key), u32(type));
    if (type === 8) parts.push(str(value));
    else if (type === 5) parts.push(u32(value >>> 0));
    else if (type === 7) parts.push(Buffer.from([value ? 1 : 0]));
    else if (type === 9) {
      const [elemType, items] = value;
      parts.push(u32(elemType), u64(items.length));
      for (const it of items) parts.push(elemType === 8 ? str(it) : u32(it >>> 0));
    } else throw new Error(`unsupported test kv type ${type}`);
  }
  return Buffer.concat(parts);
}

const VOCAB = Array.from({ length: 256 }, (_, i) => `tok${i}`);
const TYPES = VOCAB.map((_, i) => (i >= 250 ? 5 : 1)); // the top six are UNUSED padding

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bokahli-canary-'));
  const path = join(dir, 'model.gguf');
  await writeFile(path, gguf([
    ['general.architecture', 8, 'qwen35moe'],
    ['tokenizer.ggml.model', 8, 'gpt2'],
    ['tokenizer.ggml.pre', 8, 'qwen35'],
    ['tokenizer.ggml.tokens', 9, [8, VOCAB]],
    ['tokenizer.ggml.token_type', 9, [5, TYPES]],
    ['tokenizer.ggml.eos_token_id', 5, 249],
    ['tokenizer.ggml.add_bos_token', 7, false],
    ['tokenizer.chat_template', 8, '{{ messages }}'],
  ]));
  return { dir, path };
}

const E2E_ENCODE = [
  { id: 'plain', note: 'ascii', inputBase64: b64('hello world'), expectedIds: [7, 8] },
  { id: 'merge', note: 'merge-sensitive run', inputBase64: b64('aaaa'), expectedIds: [9] },
];
const E2E_DECODE = [
  { id: 'vocab-7', note: 'ordinary', tokenId: 7, expectedBytesBase64: b64('tok7') },
  { id: 'vocab-249', note: 'added token', tokenId: 249, expectedBytesBase64: b64('tok249') },
];

function e2eBackend({ encodeOverrides = {} } = {}) {
  const byInput = new Map(E2E_ENCODE.map((c) => [Buffer.from(c.inputBase64, 'base64').toString('utf8'), c]));
  return {
    modelMeta: async () => ({ vocabType: 2, vocabSize: VOCAB.length, contextTrain: 1, paramCount: 1 }),
    slotParams: async () => null,
    props: async () => ({}),
    // The token table is intact in every scenario below. That is the point:
    // a substitution that changes segmentation leaves decoding untouched.
    detokenize: async (ids) => ids.map((i) => (TYPES[i] === 5 ? '' : VOCAB[i])).join(''),
    tokenize: async (text) => {
      const c = byInput.get(text);
      if (c === undefined) return [1];
      return encodeOverrides[c.id] ?? c.expectedIds;
    },
  };
}

async function e2eProvider(path, digest, { suiteOverrides = {}, encodeOverrides = {} } = {}) {
  const meta = await readGgufTokenizerMetadata(path);
  const s = {
    schemaVersion: 'bokahli.tokenizer-canary.v1',
    suiteId: 'e2e.v1',
    artifactDigest: digest,
    tokenizerMetadataDigest: meta.metadataDigest,
    vocabSize: VOCAB.length,
    encodeSettings: { addSpecial: false, parseSpecial: true },
    encodeReference: INDEPENDENT_ENCODE_REF,
    decodeReference: INDEPENDENT_DECODE_REF,
    encode: E2E_ENCODE,
    decode: E2E_DECODE,
    payloadHash: '',
    generatedAt: '2026-08-20T11:00:00.000Z',
    coverage: ['ascii', 'merges'],
    note: 'e2e',
    ...suiteOverrides,
  };
  if (suiteOverrides.payloadHash === undefined) s.payloadHash = canaryPayloadHash(s);

  const artifact = {
    modelId: 'e2e-model', digest, artifactPath: path, runtimeAlias: 'e2e-model',
    tokenizerCanaryPath: null, backend: 'primary', facts: {}, capabilities: {}, qualification: {},
    operational: { servedContextTokens: 32768, maxConcurrentRequests: 1, measuredAt: null },
  };
  const provider = new QualificationFactsProvider({
    backend: e2eBackend({ encodeOverrides }),
    runtimeExecutablePathFallback: null,
    // This process: a real pid with a real /proc entry, so the instance id is
    // genuinely observed rather than stubbed. The binding rules under test are
    // all about instance identity, and stubbing it would test nothing.
    resolveBackendPids: async () => [process.pid],
    artifactTokens: async () => VOCAB,
    artifactTokenTypes: async () => TYPES,
    canarySuite: () => s,
  });
  return { provider, artifact };
}

test('D1: an intact runtime, end to end, reaches runtime_tokenizer', async (t) => {
  const { dir, path } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { provider, artifact } = await e2eProvider(path, `sha256:${'1'.repeat(64)}`);
  const f = await provider.collect(artifact, true, 'b1', 32768, 1);

  assert.deepEqual(f.tokenizer.unprovenReasons, []);
  assert.equal(f.tokenizer.metadataBound, true);
  assert.equal(f.tokenizer.decodeCanaryVerified, true);
  assert.equal(f.tokenizer.encodeCanaryVerified, true);
  assert.equal(f.tokenizer.pretokenizerVerified, true);
  assert.equal(f.tokenizer.canarySuiteId, 'e2e.v1');
  assert.equal(f.tokenizer.verifiedBackendInstanceId, f.backendInstance.instanceId);
  assert.ok(f.tokenizer.verifiedAt);
  assert.equal(f.tokenizer.tokenizedBy, 'runtime');
  const c = resolveTokenCounts({
    promptTokens: 11, completionTokens: 2, fromRuntimeUsage: true, tokenizer: f.tokenizer,
  });
  assert.equal(c.source, 'runtime_tokenizer');
});

test('D2: end to end, a changed merge table is caught while decoding still passes', async (t) => {
  const { dir, path } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { provider, artifact } = await e2eProvider(path, `sha256:${'1'.repeat(64)}`, {
    encodeOverrides: { merge: [9, 9] },
  });
  const f = await provider.collect(artifact, true, 'b1', 32768, 1);

  // The vocabulary probe f270ee9 relied on is clean. Only the encode direction
  // notices, and it is the direction the counts come from.
  assert.equal(f.tokenizer.runtimeProof.matches, true);
  assert.equal(f.tokenizer.decodeCanaryVerified, true);
  assert.equal(f.tokenizer.encodeCanaryVerified, false);
  assert.equal(f.tokenizer.tokenizedBy, 'unknown');
  assert.equal(tokenizerFullyProven(f.tokenizer), false);
  assert.ok(f.attestation.missing.includes('tokenizer.proof'));
  const c = resolveTokenCounts({
    promptTokens: 11, completionTokens: 2, fromRuntimeUsage: true, tokenizer: f.tokenizer,
  });
  assert.equal(c.source, 'runtime_reported_unknown_tokenizer');
});

test('D3: end to end, a canary for another artifact does not unlock this one', async (t) => {
  const { dir, path } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { provider, artifact } = await e2eProvider(path, `sha256:${'1'.repeat(64)}`, {
    suiteOverrides: { artifactDigest: `sha256:${'2'.repeat(64)}` },
  });
  const f = await provider.collect(artifact, true, 'b1', 32768, 1);
  assert.equal(f.tokenizer.encodeCanaryVerified, false);
  assert.match(f.tokenizer.unprovenReasons.join(' '), /different artifact/i);
});

test('D4: end to end, no canary means the counts stay unproven', async (t) => {
  const { dir, path } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { provider, artifact } = await e2eProvider(path, `sha256:${'1'.repeat(64)}`);
  // Same fixture, canary withheld: an artifact installed but never prepared.
  const bare = new QualificationFactsProvider({
    backend: e2eBackend(),
    runtimeExecutablePathFallback: null,
    resolveBackendPids: async () => [process.pid],
    artifactTokens: async () => VOCAB,
    artifactTokenTypes: async () => TYPES,
    canarySuite: () => null,
  });
  void provider;
  const f = await bare.collect(artifact, true, 'b1', 32768, 1);
  assert.equal(f.tokenizer.encodeCanaryVerified, false);
  assert.equal(f.tokenizer.canarySuiteId, null);
  assert.match(f.tokenizer.unprovenReasons.join(' '), /never asked to encode/i);
  assert.equal(f.tokenizer.tokenizedBy, 'unknown');
});

test('D5: the pinned production canary is internally consistent', async () => {
  // Not a live check — it never contacts a backend. It asserts that the suite
  // committed for the installed artifact still hashes to its own contents and
  // still names an independent reference, so an edit to that file is a test
  // failure rather than a silent weakening.
  const { readFile } = await import('node:fs/promises');
  const { validateCanarySuite } = await import('@bokahli/runtime');
  const { canaryReferenceIsIndependent } = await import('@bokahli/contracts');
  const raw = await readFile(
    new URL('../../../catalog/canaries/qwen3.5-35b-a3b.q2-k.canary.json', import.meta.url),
    'utf8',
  );
  const s = JSON.parse(raw);
  assert.deepEqual(validateCanarySuite(s), []);
  assert.equal(canaryReferenceIsIndependent(s.encodeReference.method), true);
  assert.equal(canaryReferenceIsIndependent(s.decodeReference.method), true);
  assert.equal(s.encodeReference.producedByBackendInstanceId, null);
  assert.ok(s.encode.length >= 30, 'the corpus must be broad enough to catch a substitution');
  assert.ok(s.decode.length >= 20);
  // Every dimension the audit asked for, present by construction.
  for (const dimension of ['whitespace', 'JSON', 'emoji', 'special tokens', 'digit']) {
    assert.ok(
      s.coverage.some((c) => c.toLowerCase().includes(dimension.toLowerCase().split(' ')[0])),
      `coverage must include ${dimension}`,
    );
  }
});

test('D6: the catalog resolves its canary and the pinned suite matches that artifact', async () => {
  // The startup contract, asserted offline. main.ts refuses to start when a
  // declared canary is unreadable, fails its own hash, or names a different
  // artifact; this is the same three checks against the committed files, so a
  // catalog edit that breaks them is a test failure rather than a boot failure
  // discovered on a deployment day.
  const { Catalog } = await import('@bokahli/catalog');
  const { readFile } = await import('node:fs/promises');
  const { validateCanarySuite } = await import('@bokahli/runtime');
  const catalog = await Catalog.load(
    new URL('../../../catalog/artifacts.json', import.meta.url).pathname,
  );
  for (const a of catalog.internalAll()) {
    assert.ok(a.tokenizerCanaryPath, `${a.modelId} declares no tokenizer canary`);
    const s = JSON.parse(await readFile(a.tokenizerCanaryPath, 'utf8'));
    assert.deepEqual(validateCanarySuite(s), [], `${a.modelId} canary is invalid`);
    assert.equal(s.artifactDigest, a.digest, 'a canary is not portable between artifacts');
    assert.equal(s.vocabSize, a.facts.vocabSize, 'the canary and the catalog disagree on the vocabulary');
  }
  // And the path never escapes: it is internal, like artifactPath.
  const pub = JSON.stringify(catalog.publicEntries());
  assert.equal(pub.includes('canary'), false, 'canary paths must not cross the API boundary');
  assert.equal(pub.includes('.gguf'), false);
});
