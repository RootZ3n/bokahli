/**
 * Final hostile audit of the B2 tokenizer attestation.
 *
 * The canary answered the question f270ee9 could not: does the runtime *encode*
 * the way the artifact says it does. This file attacks everything the canary
 * itself rests on — the file reader that produces its expectations, the
 * transport that carries its answers, the hash that binds its contents, the
 * instance identity that scopes it, the cache that avoids re-running it, and
 * the request paths that are supposed to fail closed when it does not pass.
 *
 * Every test here failed, or would have passed for the wrong reason, before the
 * remediation it guards. The comments say which.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canaryPayloadHash,
  decodeByteLevel,
  decodeByteLevelBytes,
  isComparableTokenType,
  isSelfContainedUtf8,
  LlamaBackend,
  probeRuntimeTokenizer,
  readGgufTokenizerMetadata,
  readGgufTokenTable,
  readGgufTokenTypes,
  resolveTemplateFacts,
  templateDigest,
  validateCanarySuite,
  verifyTokenizerCanary,
} from '@bokahli/runtime';
import { QualificationFactsProvider } from '../dist/facts.js';

const NOW = () => new Date('2026-08-20T12:00:00.000Z');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------------------
// G. the GGUF reader: expectations are only as good as the file read
// ---------------------------------------------------------------------------

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const gstr = (v) => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([u64(b.length), b]); };
function gguf(kv, o = {}) {
  const parts = [
    Buffer.from(o.magic ?? 'GGUF', 'ascii'), u32(o.version ?? 3), u64(0),
    o.kvCount ?? u64(kv.length),
  ];
  for (const [key, type, value] of kv) {
    parts.push(gstr(key), u32(type));
    if (type === 8) parts.push(gstr(value));
    else if (type === 5) parts.push(u32(value));
    else if (type === 7) parts.push(Buffer.from([value ? 1 : 0]));
    else if (type === 9) {
      const [et, items, declared] = value;
      parts.push(u32(et), declared ?? u64(items.length));
      for (const it of items) parts.push(et === 8 ? gstr(it) : u32(it));
    }
  }
  return Buffer.concat(parts);
}

let ggufDir;
test('setup gguf fixtures', async () => {
  ggufDir = await mkdtemp(join(tmpdir(), 'b2audit-'));
});

async function ggufFile(kv, o) {
  const p = join(ggufDir, `f${Math.abs(JSON.stringify(kv).length + (o?.version ?? 3))}-${kv.length}-${Object.keys(o ?? {}).join('')}.gguf`);
  await writeFile(p, gguf(kv, o));
  return p;
}

const V4 = ['a', 'b', 'c', 'd'];
const BASE_KV = [
  ['tokenizer.ggml.model', 8, 'gpt2'],
  ['tokenizer.ggml.pre', 8, 'qwen35'],
  ['tokenizer.ggml.tokens', 9, [8, V4]],
  ['tokenizer.ggml.token_type', 9, [5, [1, 1, 1, 1]]],
];

test('G1: a duplicated metadata key is refused by every reader, not resolved differently', async () => {
  // The exploit. This reader kept the LAST occurrence for the digest while the
  // key-selective reader stopped at the FIRST, so one file produced a metadata
  // digest over one vocabulary and a token table — which is what decode
  // expectations and the sampled probe read — from another. Two readers
  // disagreeing about the same bytes is exactly what a content digest exists to
  // prevent, so neither picks a winner now.
  const p = await ggufFile([
    ['tokenizer.ggml.model', 8, 'gpt2'], ['tokenizer.ggml.pre', 8, 'qwen35'],
    ['tokenizer.ggml.tokens', 9, [8, ['HONEST0', 'HONEST1', 'HONEST2', 'HONEST3']]],
    ['tokenizer.ggml.token_type', 9, [5, [1, 1, 1, 1]]],
    ['tokenizer.ggml.tokens', 9, [8, ['EVIL0', 'EVIL1', 'EVIL2', 'EVIL3']]],
  ]);
  await assert.rejects(() => readGgufTokenizerMetadata(p), /duplicate metadata key/);
  await assert.rejects(() => readGgufTokenTable(p), /duplicate metadata key/);
  await assert.rejects(() => readGgufTokenTypes(p), /duplicate metadata key/);
});

test('G2: a token-type array that is not parallel to the vocabulary is not a type table', async () => {
  // A short array left types[id] undefined past its end, which silently changed
  // which entries a canary pins; a long one described entries that do not exist.
  for (const types of [[1, 1], [1, 1, 1, 1, 1, 1, 1, 1]]) {
    const p = await ggufFile([...BASE_KV.slice(0, 3), ['tokenizer.ggml.token_type', 9, [5, types]]]);
    assert.equal(await readGgufTokenTypes(p), null, `${types.length} types for 4 tokens`);
  }
  const ok = await ggufFile(BASE_KV);
  assert.equal((await readGgufTokenTypes(ok)).length, 4);
});

test('G3: an unknown token-type code is not assumed to behave like a normal token', () => {
  for (const ty of [1, 2, 3, 4, 6]) assert.equal(isComparableTokenType(ty), true, `type ${ty}`);
  for (const ty of [0, 5, 7, 99, -1, null, undefined]) {
    assert.equal(isComparableTokenType(ty), false, `type ${String(ty)}`);
  }
});

test('G4: malformed headers fail closed in every reader', async () => {
  const cases = {
    truncated: [gguf(BASE_KV).subarray(0, 40), null],
    badMagic: [gguf(BASE_KV, { magic: 'XXXX' }), null],
    badVersion: [gguf(BASE_KV, { version: 99 }), null],
    unsafeKvCount: [gguf(BASE_KV, { kvCount: (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(2n ** 63n); return b; })() }), null],
    arrayCountPastCap: [gguf([...BASE_KV.slice(0, 2), ['tokenizer.ggml.tokens', 9, [8, V4, u64(9_000_000)]]]), null],
    arrayCountInflated: [gguf([...BASE_KV.slice(0, 2), ['tokenizer.ggml.tokens', 9, [8, V4, u64(1000)]]]), null],
  };
  for (const [name, [buf]] of Object.entries(cases)) {
    const p = join(ggufDir, `${name}.gguf`);
    await writeFile(p, buf);
    for (const fn of [readGgufTokenizerMetadata, readGgufTokenTable, readGgufTokenTypes]) {
      const r = await fn(p).catch((e) => ({ threw: e.constructor.name }));
      const failedClosed = r === null || (r && r.threw) || (r && r.vocabSize === null);
      assert.ok(failedClosed, `${name}/${fn.name} produced ${JSON.stringify(r)?.slice(0, 80)}`);
    }
  }
});

test('G5: a corrupt tail is not survivable by reading only the keys you want', async () => {
  // Stopping at the last wanted key let a file the metadata reader rejects still
  // yield a usable token table. The whole block is parsed now, so a file is
  // either well formed for every reader or for none.
  const p = await ggufFile(BASE_KV, { kvCount: u64(1_000_000) });
  await assert.rejects(() => readGgufTokenizerMetadata(p));
  await assert.rejects(() => readGgufTokenTable(p));
});

// ---------------------------------------------------------------------------
// T. the probe transport: an answer that is not comparable is not an answer
// ---------------------------------------------------------------------------

async function hostileBackend(handler) {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const out = handler(req.url, body === '' ? {} : JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    backend: new LlamaBackend(`http://127.0.0.1:${srv.address().port}`, 'b1', null, 3000),
    close: () => new Promise((r) => srv.close(r)),
  };
}

test('T1: junk padding in a token list is refused, never filtered away', async (t) => {
  // The exploit. `Number.isInteger` filtering turned [10, null, 11] and
  // [10, "JUNK", 11] into [10, 11], so a runtime returning an element the JSON
  // layer could not express as an id passed a check whose entire premise is
  // exact agreement. Both cases were measured passing before this.
  for (const tokens of [[10, null, 11], [10, 'JUNK', 11], [10, 11.5], [10, -1], [10, {}]]) {
    const h = await hostileBackend(() => ({ tokens }));
    t.after(() => h.close());
    await assert.rejects(
      () => h.backend.tokenize('hello world', { addSpecial: false, parseSpecial: true }),
      /not a token id/,
      JSON.stringify(tokens),
    );
  }
});

test('T2: an id outside the declared vocabulary is refused', async (t) => {
  const h = await hostileBackend(() => ({ tokens: [10, 999_999] }));
  t.after(() => h.close());
  await assert.rejects(
    () => h.backend.tokenize('x', { addSpecial: false, parseSpecial: true, vocabSize: 1000 }),
    /outside the 1000-entry vocabulary/,
  );
});

test('T3: a padded response cannot satisfy the canary', async (t) => {
  const h = await hostileBackend((url) =>
    url === '/tokenize' ? { tokens: [10, 'JUNK', 11] } : { content: 'hello' });
  t.after(() => h.close());
  const s = auditSuite();
  const r = await verifyTokenizerCanary(s, auditBinding(s), {
    tokenize: (x, o) => h.backend.tokenize(x, o),
    detokenize: (i) => h.backend.detokenize(i),
    now: NOW,
  });
  assert.equal(r.encodeCanaryVerified, false, 'a filtered answer used to verify');
  assert.match(r.reasons.join(' '), /tokenize failed/);
});

test('T4: an oversized probe body is refused rather than buffered', async (t) => {
  // Measured before the bound: 50 MB accepted in 192 ms, once per probe, and
  // the sequence makes ninety-four of them.
  const h = await hostileBackend(() => ({ content: 'x'.repeat(2 * 1024 * 1024) }));
  t.after(() => h.close());
  await assert.rejects(() => h.backend.detokenize([1]), /exceeded 1048576 bytes/);
});

test('T5: a non-JSON or shapeless response is refused, not coerced to empty', async (t) => {
  const h = await hostileBackend((url) => (url === '/detokenize' ? { notContent: 1 } : { notTokens: 1 }));
  t.after(() => h.close());
  await assert.rejects(() => h.backend.detokenize([1]), /did not return text/);
  await assert.rejects(
    () => h.backend.tokenize('x', { addSpecial: false, parseSpecial: true }),
    /did not return a token array/,
  );
});

test('T6: the encode settings are sent exactly, and are part of the canary identity', async (t) => {
  let seen = null;
  const h = await hostileBackend((url, body) => { seen = body; return { tokens: [1] }; });
  t.after(() => h.close());
  await h.backend.tokenize('x', { addSpecial: false, parseSpecial: true });
  assert.equal(seen.add_special, false);
  assert.equal(seen.parse_special, true);
  // And a suite generated under other settings is a different suite.
  const a = auditSuite();
  const b = auditSuite({ encodeSettings: { addSpecial: true, parseSpecial: true } });
  assert.notEqual(canaryPayloadHash(a), canaryPayloadHash(b));
});

// ---------------------------------------------------------------------------
// V. the suite: what the hash covers, and what cannot ride along beside it
// ---------------------------------------------------------------------------

const ART_DIGEST = `sha256:${'1'.repeat(64)}`;
const META_DIGEST = `sha256:${'2'.repeat(64)}`;
const REF_IN = {
  method: 'llama-tokenize-vocab-only', generatorComponents: ['llama-tokenize:aa'],
  generatorDigest: `sha256:${'c'.repeat(64)}`, generatorBuild: 'build 10505',
  producedByBackendInstanceId: null, note: '',
};
const REF_DE = { ...REF_IN, method: 'gguf-token-table' };

function auditSuite(o = {}) {
  const s = {
    schemaVersion: 'bokahli.tokenizer-canary.v1', suiteId: 'audit.v1',
    artifactDigest: ART_DIGEST, tokenizerMetadataDigest: META_DIGEST, vocabSize: 1000,
    encodeSettings: { addSpecial: false, parseSpecial: true },
    encodeReference: REF_IN, decodeReference: REF_DE,
    encode: [
      { id: 'e1', note: '', inputBase64: b64('hello world'), expectedIds: [10, 11] },
      { id: 'e2', note: '', inputBase64: b64('aaaa'), expectedIds: [20] },
    ],
    decode: [{ id: 'd1', note: '', tokenId: 10, expectedBytesBase64: b64('hello') }],
    payloadHash: '', generatedAt: '2026-08-20T11:00:00.000Z', coverage: [], note: '',
    ...o,
  };
  if (o.payloadHash === undefined) s.payloadHash = canaryPayloadHash(s);
  return s;
}
const auditBinding = (s) => ({
  artifactDigest: s.artifactDigest, tokenizerMetadataDigest: s.tokenizerMetadataDigest,
  backendInstanceId: 'i1',
});

test('V1: a field nobody listed cannot ride along outside the hash', () => {
  // The canonical payload names its fields explicitly, which is what makes it
  // stable against key reordering — and the cost is that an unlisted field
  // would be invisible to the hash. Unknown keys are refused so that adding a
  // field to this contract forces adding it to the preimage.
  const s = auditSuite();
  for (const [obj, key] of [
    [s, 'sneakyTopLevel'],
    [s.encode[0], 'sneakyCase'],
    [s.encodeReference, 'sneakyRef'],
  ]) {
    const mutated = structuredClone(s);
    const target = obj === s ? mutated : obj === s.encode[0] ? mutated.encode[0] : mutated.encodeReference;
    target[key] = 'anything';
    assert.match(validateCanarySuite(mutated).join(' '), /unknown field/, key);
  }
});

test('V2: mutating any bound value fails the hash', () => {
  const base = auditSuite();
  const mutations = {
    'one input byte': (s) => { s.encode[0].inputBase64 = b64('hello worlD'); },
    'one expected id': (s) => { s.encode[0].expectedIds = [10, 12]; },
    'one expected byte': (s) => { s.decode[0].expectedBytesBase64 = b64('hellp'); },
    'a decode id': (s) => { s.decode[0].tokenId = 11; },
    'an encode setting': (s) => { s.encodeSettings.parseSpecial = false; },
    'the generator digest': (s) => { s.encodeReference.generatorDigest = `sha256:${'d'.repeat(64)}`; },
    'the generator build': (s) => { s.encodeReference.generatorBuild = 'build 1'; },
    'the artifact digest': (s) => { s.artifactDigest = `sha256:${'9'.repeat(64)}`; },
    'the metadata digest': (s) => { s.tokenizerMetadataDigest = `sha256:${'9'.repeat(64)}`; },
    'the vocab size': (s) => { s.vocabSize = 999; },
    'the schema version': (s) => { s.schemaVersion = 'bokahli.tokenizer-canary.v2'; },
    'the suite id': (s) => { s.suiteId = 'other.v1'; },
    'the reference method': (s) => { s.encodeReference.method = 'live-backend'; },
    'case order': (s) => { s.encode.reverse(); },
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const s = structuredClone(base);
    mutate(s);
    assert.notEqual(canaryPayloadHash(s), base.payloadHash, `${what} must move the hash`);
    assert.ok(validateCanarySuite(s).length > 0, `${what} must be refused`);
  }
});

test('V3: reordering cases does not preserve identity', () => {
  const a = auditSuite();
  const b = structuredClone(a);
  b.encode.reverse();
  b.payloadHash = canaryPayloadHash(b);
  assert.notEqual(b.payloadHash, a.payloadHash, 'order is part of the payload, not canonicalised away');
  assert.deepEqual(validateCanarySuite(b), [], 'and a reordered suite is internally consistent');
});

test('V4: a corpus that contradicts itself is a corpus defect, caught at load', () => {
  // Two cases over the same bytes expecting different ids: one fails for ever,
  // which reads as a tokenizer problem and is not one. Permanent red gets
  // checks disabled.
  const s = auditSuite({
    encode: [
      { id: 'e1', note: '', inputBase64: b64('x'), expectedIds: [1] },
      { id: 'e2', note: '', inputBase64: b64('x'), expectedIds: [2] },
    ],
  });
  assert.match(validateCanarySuite(s).join(' '), /different ids for an input already pinned/);
});

test('V5: duplicate case ids and out-of-vocabulary ids are refused', () => {
  assert.match(
    validateCanarySuite(auditSuite({
      encode: [
        { id: 'dup', note: '', inputBase64: b64('x'), expectedIds: [1] },
        { id: 'dup', note: '', inputBase64: b64('y'), expectedIds: [2] },
      ],
    })).join(' '),
    /duplicate canary case id/,
  );
  assert.match(
    validateCanarySuite(auditSuite({
      encode: [{ id: 'e', note: '', inputBase64: b64('x'), expectedIds: [5000] }],
    })).join(' '),
    /not an id in this vocabulary/,
  );
  assert.match(
    validateCanarySuite(auditSuite({
      decode: [{ id: 'd', note: '', tokenId: -1, expectedBytesBase64: b64('x') }],
    })).join(' '),
    /not an id in this vocabulary/,
  );
});

// ---------------------------------------------------------------------------
// I. instance binding across the probe sequence
// ---------------------------------------------------------------------------

const TOKENS64 = Array.from({ length: 64 }, (_, i) => `tok${i}`);
const TYPES64 = TOKENS64.map(() => 1);

function probeSources(o = {}) {
  return {
    tokenize: o.tokenize ?? (async () => [1]),
    detokenize: o.detokenize ?? (async ([i]) => TOKENS64[i]),
    ...(o.readBackendInstanceId ? { readBackendInstanceId: o.readBackendInstanceId } : {}),
    now: NOW,
  };
}

test('I1: a restart during the probe sequence unbinds everything it produced', async () => {
  // Ninety-four calls happen between the first instance reading and the last
  // answer. Stamping the result with the reading taken before them assumes
  // nothing happened in between, which is precisely what a restart breaks.
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS64, artifactTokenTypes: TYPES64, backendInstanceId: 'i1' },
    probeSources({ readBackendInstanceId: async () => 'i2' }),
  );
  assert.equal(p.matches, false);
  assert.match(p.detail, /restarted during the probe sequence/);
  assert.equal(p.canary.decodeCanaryVerified, false);
  assert.equal(p.canary.encodeCanaryVerified, false);
});

test('I2: an unknown instance after the sequence is not a passing instance', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS64, artifactTokenTypes: TYPES64, backendInstanceId: 'i1' },
    probeSources({ readBackendInstanceId: async () => null }),
  );
  assert.equal(p.matches, false);
  assert.match(p.detail, /could not be established on both sides/);
});

test('I3: an unchanged instance across the sequence passes', async () => {
  const p = await probeRuntimeTokenizer(
    { artifactTokens: TOKENS64, artifactTokenTypes: TYPES64, backendInstanceId: 'i1' },
    probeSources({ readBackendInstanceId: async () => 'i1' }),
  );
  assert.equal(p.matches, true);
});

// ---------------------------------------------------------------------------
// C. probe cost: ninety-four calls must not happen per request
// ---------------------------------------------------------------------------

function e2eFixtureKv() {
  return [
    ['tokenizer.ggml.model', 8, 'gpt2'], ['tokenizer.ggml.pre', 8, 'qwen35'],
    ['tokenizer.ggml.tokens', 9, [8, TOKENS64]],
    ['tokenizer.ggml.token_type', 9, [5, TYPES64]],
  ];
}

async function costProvider(o = {}) {
  const path = join(ggufDir, `cost-${o.tag ?? 'a'}.gguf`);
  await writeFile(path, gguf(e2eFixtureKv()));
  const meta = await readGgufTokenizerMetadata(path);
  const suite = auditSuite({
    artifactDigest: ART_DIGEST, tokenizerMetadataDigest: meta.metadataDigest, vocabSize: 64,
    encode: [{ id: 'e', note: '', inputBase64: b64('hello'), expectedIds: [7, 8] }],
    decode: [{ id: 'd', note: '', tokenId: 7, expectedBytesBase64: b64('tok7') }],
  });
  const artifact = {
    modelId: 'c', digest: ART_DIGEST, artifactPath: path, runtimeAlias: 'c',
    tokenizerCanaryPath: null, backend: 'primary', facts: {}, capabilities: {}, qualification: {},
    operational: { servedContextTokens: 32768, maxConcurrentRequests: 1, measuredAt: null },
  };
  const counter = { sequences: 0, calls: 0, healthy: true };
  let clock = 2_000_000_000_000;
  const provider = new QualificationFactsProvider({
    backend: {
      modelMeta: async () => ({ vocabType: 2, vocabSize: 64, contextTrain: 1, paramCount: 1 }),
      slotParams: async () => null, props: async () => ({}),
      tokenize: async (text) => {
        counter.calls += 1;
        if (!counter.healthy) throw new Error('down');
        return text === 'hello' ? [7, 8] : [1];
      },
      detokenize: async (ids) => {
        counter.calls += 1;
        if (ids[0] === 0) counter.sequences += 1;
        if (!counter.healthy) throw new Error('down');
        return ids.map((i) => TOKENS64[i]).join('');
      },
    },
    runtimeExecutablePathFallback: null,
    resolveBackendPids: async () => [process.pid],
    artifactTokens: async () => TOKENS64,
    artifactTokenTypes: async () => TYPES64,
    canarySuite: () => suite,
    now: () => new Date(clock),
  });
  return { provider, artifact, counter, advance: (ms) => { clock += ms; } };
}

test('C1: concurrent requests share one probe sequence', async () => {
  // Measured before the fix: twelve concurrent collects launched two sequences,
  // because the cache was filled after the first await rather than before it.
  // Checking a cache, awaiting, then filling it is not caching.
  const { provider, artifact, counter } = await costProvider({ tag: 'conc' });
  await Promise.all(Array.from({ length: 12 }, () => provider.collect(artifact, true, 'b1', 32768, 1)));
  assert.equal(counter.sequences, 1, `12 concurrent collects ran ${counter.sequences} sequences`);
});

test('C2: a verified probe is not repeated for the same instance', async () => {
  const { provider, artifact, counter } = await costProvider({ tag: 'reuse' });
  await provider.collect(artifact, true, 'b1', 32768, 1);
  const before = counter.calls;
  for (let i = 0; i < 5; i++) await provider.collect(artifact, true, 'b1', 32768, 1);
  assert.equal(counter.calls, before, 'five further requests must cost nothing');
});

test('C3: a transient outage does not leave the deployment unproven for ever', async () => {
  // Before the TTL, a probe that failed because the backend was briefly
  // unreachable was cached on the same terms as a success: a two-second outage
  // left token counts unproven until the next restart, with nothing retrying.
  const { provider, artifact, counter, advance } = await costProvider({ tag: 'ttl' });
  counter.healthy = false;
  const down = await provider.collect(artifact, true, 'b1', 32768, 1);
  assert.equal(down.tokenizer.encodeCanaryVerified, false);

  counter.healthy = true;
  const tooSoon = await provider.collect(artifact, true, 'b1', 32768, 1);
  assert.equal(tooSoon.tokenizer.encodeCanaryVerified, false, 'within the TTL, no probe storm');

  advance(31_000);
  const recovered = await provider.collect(artifact, true, 'b1', 32768, 1);
  assert.equal(recovered.tokenizer.encodeCanaryVerified, true, 'and it does retry, once');
});

// ---------------------------------------------------------------------------
// B. byte-level decoding, checked against an independent construction
// ---------------------------------------------------------------------------

/** GPT-2 `bytes_to_unicode`, rebuilt here rather than assumed. */
function bytesToUnicode() {
  const bs = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  }
  const map = new Map();
  bs.forEach((b, i) => map.set(b, String.fromCodePoint(cs[i])));
  return map;
}

test('B1: every one of the 256 byte mappings round-trips', () => {
  // The defect this replaces sent U+00E4 to the two bytes c3 a4 instead of the
  // one byte e4, so every multi-byte token decoded to mojibake — 20 of 33
  // sampled entries failed against a healthy backend.
  const map = bytesToUnicode();
  for (let b = 0; b < 256; b++) {
    const encoded = map.get(b);
    const decoded = decodeByteLevelBytes(encoded);
    assert.deepEqual([...decoded], [b], `byte ${b} via U+${map.get(b).codePointAt(0).toString(16)}`);
  }
});

test('B2: real multi-byte text survives the round trip', () => {
  const map = bytesToUnicode();
  const encode = (s) => [...Buffer.from(s, 'utf8')].map((b) => map.get(b)).join('');
  for (const text of ['hello', ' hello', '\nline', 'café', 'Ångström', '日本語', 'नमस्ते', '🚀', 'é']) {
    assert.equal(decodeByteLevel(encode(text)), text, JSON.stringify(text));
  }
});

test('B3: a fragment that is not standalone UTF-8 is excluded, not silently matched', () => {
  const map = bytesToUnicode();
  const cjk = Buffer.from('乾', 'utf8');
  assert.equal(isSelfContainedUtf8(cjk), true);
  for (const b of cjk) {
    assert.equal(isSelfContainedUtf8(Buffer.from([b])), false, `lone byte ${b}`);
  }
  // And the exclusion is narrow: it removes fragments, not whole characters.
  assert.equal(decodeByteLevel(map.get(0xe4) + map.get(0xb9) + map.get(0xbe)), '乾');
});

test('B4: a codepoint outside the byte-level alphabet is refused, not guessed at', () => {
  assert.equal(decodeByteLevelBytes('\u{1F680}'), null, 'a raw emoji is not a byte-level token');
  assert.equal(decodeByteLevel('\u{1F680}'), '');
});

// ---------------------------------------------------------------------------
// P. template and tokenizer stay separate claims
// ---------------------------------------------------------------------------

test('P1: a passing tokenizer canary does not upgrade template identity', () => {
  // Different questions. The canary says how the runtime turns bytes into ids;
  // it says nothing about which template rendered a request, and llama.cpp's
  // chat response still returns no correlation handle.
  const f = resolveTemplateFacts({
    runtimeTemplate: '{{ messages }}',
    artifactTemplateDigest: templateDigest('{{ messages }}'),
    effectiveChatFormat: 'peg-native',
    effectiveReasoningFormat: 'deepseek',
    configuredReasoningFormat: 'none',
    requestedChatFormat: null,
    slotCorrelation: null,
    digestOf: templateDigest,
    now: NOW,
  });
  assert.equal(f.requestConfirmed, null, 'nothing confirms a template for a request');
  assert.equal(f.configured.applied, null, 'holding a template is not applying one');
  assert.equal(f.effective.applied, null);
  assert.equal(f.configured.matchesArtifactTemplate, true, 'and that claim is separately true');
  assert.equal(f.reasoningFormatOverridden, true);
  // The five tiers stay five: artifact (matchesArtifactTemplate), runtime
  // configuration, client formatting (appliedBy), uncorrelated slot, and
  // request-confirmed.
  assert.equal(f.configured.appliedBy, 'runtime');
  assert.notEqual(f.configured, f.requestConfirmed);
});

test('cleanup gguf fixtures', async () => {
  await rm(ggufDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// S. strict paths fail closed; permissive chat stays available
// ---------------------------------------------------------------------------
//
// The judgement call under audit. Ordinary chat may return an explicitly
// unattested answer when policy allows a degraded one — the response says so in
// every field and nothing downstream can build on it. A request that asks for
// qualification, names a task class, or pins an exact identity is asking a
// different question, and "the evidence could not be established" has to be an
// answer to it rather than a footnote on a completion.

import { AdmissionQueue } from '@bokahli/runtime';
import { QualificationGate } from '../dist/qualification.js';
import { unavailableFacts } from '../dist/facts.js';
import { createHandler } from '../dist/http.js';
import { ScanCapacity } from '@bokahli/server/velum-capacity';
import { ScanPool } from '@bokahli/server/scan-pool';

const S_TOKEN = 'a'.repeat(48);
const S_MODEL = 'strict-model.q2-k';
const S_DIGEST = `sha256:${'4'.repeat(64)}`;
const S_ARTIFACT = {
  modelId: S_MODEL, displayName: 'Strict', digest: S_DIGEST,
  artifactPath: '/models/internal/strict.gguf', runtimeAlias: S_MODEL,
  tokenizerCanaryPath: null, backend: 'primary',
  facts: {
    format: 'gguf', architecture: 'testarch', quantization: 'Q2_K', sizeBytes: 1,
    parameterCount: 1, activeParameterCount: 1, expertCount: 1, expertUsedCount: 1,
    contextTrainTokens: 262144, vocabSize: 64, embeddingLength: 1,
  },
  capabilities: {
    chat: true, completion: true, tools: false, vision: false, audio: false,
    embedding: false, reasoningEffort: false,
  },
  qualification: {
    status: 'INSTALLED_UNQUALIFIED', authority: 'none', evidenceRef: null,
    qualifiedTaskClasses: [], note: 'synthetic',
  },
  operational: { servedContextTokens: 32768, maxConcurrentRequests: 1, measuredAt: null },
};

/** Facts for a coherent, reachable deployment. `o` bends exactly one thing. */
function strictFacts(a, o = {}) {
  const f = unavailableFacts(a);
  const observedAt = o.observedAt ?? new Date().toISOString();
  return {
    ...f,
    backendInstance: { ...f.backendInstance, instanceId: o.instanceId ?? 'inst-1' },
    attestation: {
      ...f.attestation,
      completeness: o.completeness ?? 'partial',
      missing: ['stubbed'],
      backendInstanceId: o.instanceId ?? 'inst-1',
      observedAt,
      expiresAt: o.expiresAt ?? new Date(Date.parse(observedAt) + 60_000).toISOString(),
    },
  };
}

async function strictServer(factsOpts = {}, completionInstance = 'inst-1', upstreamDelayMs = 0) {
  const upstream = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        build_info: 'b1', model_path: S_ARTIFACT.artifactPath, model_alias: S_MODEL,
        model_ftype: 'Q2_K - Medium', total_slots: 1,
        default_generation_settings: { n_ctx: 32768 }, chat_template: '{{ messages }}',
      }));
    }
    if (req.url === '/slots') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ id: 0, n_ctx: 32768, is_processing: false, params: {} }]));
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: [{ id: S_MODEL, meta: { vocab_type: 2, n_vocab: 64, n_ctx_train: 262144 } }],
      }));
    }
    if (req.url === '/v1/chat/completions') {
      req.on('data', () => {});
      req.on('end', () => setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, upstreamDelayMs));
      return undefined;
    }
    return res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const scanPool = new ScanPool({ workers: 1, jobTimeoutMs: 20_000 });
  const deps = {
    config: {
      maxRequestBytes: 1_048_576, publicDir: '/nonexistent', gpuForeignHolderThresholdMiB: 512,
      maxConcurrent: 1, maxQueueDepth: 8, queueTimeoutMs: 5_000, port: 0,
      bindAddresses: ['127.0.0.1'],
    },
    token: S_TOKEN,
    catalog: {
      internal: (id) => (id === S_MODEL ? S_ARTIFACT : undefined),
      internalAll: () => [S_ARTIFACT],
      publicEntries: () => [{ modelId: S_MODEL, digest: S_DIGEST }],
      luakEvidence: { contractVersion: 'placeholder', source: 'none', records: [] },
    },
    backend: new LlamaBackend(`http://127.0.0.1:${upstream.address().port}`, 'b1', null, 2_000),
    qualification: QualificationGate.empty('llama.cpp', 'b1'),
    queue: new AdmissionQueue({ maxConcurrent: 1, maxQueueDepth: 8, queueTimeoutMs: 5_000 }),
    gpu: { read: async () => ({ snapshot: null, foreignHolders: [], leaseAvailable: true, error: null }) },
    telemetry: {
      log() {}, record() {}, recordAuthFailure() {}, logPromptBody() {},
      summary: () => ({}), recent: () => [],
    },
    facts: {
      collect: async (a) => strictFacts(a, factsOpts),
      currentInstanceId: async () => completionInstance,
    },
    // Required, not optional: a budget that a caller can omit is a budget that
    // is unenforced wherever somebody forgot it.
    scanCapacity: new ScanCapacity(8 * 1024 * 1024, 1024 * 1024),
    // A real pool with one worker: the request path is the thing under test,
    // and a stub would test a path production does not take.
    scanPool,
    startedAt: new Date().toISOString(),
  };
  const api = createServer(createHandler(deps));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  return {
    async chat(route) {
      const res = await fetch(`${base}/v1/bokahli/chat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${S_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ route, messages: [{ role: 'user', content: 'hi' }] }),
      });
      return res.json();
    },
    close: async () => {
      await new Promise((r) => api.close(r));
      await new Promise((r) => upstream.close(r));
      // Workers are threads; a harness that starts them stops them.
      await scanPool.close();
    },
  };
}

const EXACT_ROUTE = { mode: 'EXACT', modelId: S_MODEL, artifactDigest: S_DIGEST };

test('S1: an EXACT request refuses when no attestation was established', async (t) => {
  const s = await strictServer({ completeness: 'unattested' });
  t.after(() => s.close());
  const r = await s.chat(EXACT_ROUTE);
  assert.equal(r.outcome, 'ESCALATE');
  assert.equal(r.route.reason, 'ATTESTATION_STALE');
  assert.match(r.route.detail, /requires attested evidence/);
});

test('S2: requireQualified refuses on the same evidence, in AUTO and in PROFILE', async (t) => {
  const s = await strictServer({ completeness: 'unattested' });
  t.after(() => s.close());
  for (const route of [
    { mode: 'AUTO', requireQualified: true },
    { mode: 'AUTO', taskClass: 'test_log_triage' },
    { mode: 'PROFILE', requirements: { requireQualified: true } },
    { mode: 'PROFILE', requirements: { requiredTaskClass: 'test_log_triage' } },
  ]) {
    const r = await s.chat(route);
    assert.equal(r.outcome, 'ESCALATE', JSON.stringify(route));
    // PROFILE carries its demand inside `requirements`; reading only the
    // top-level shape left exactly that request on the permissive path.
    assert.ok(
      ['ATTESTATION_STALE', 'NO_QUALIFIED_LOCAL_ROUTE', 'MODEL_NOT_QUALIFIED_FOR_TASK'].includes(r.route.reason),
      `${JSON.stringify(route)} -> ${r.route.reason}`,
    );
  }
});

test('S3: an unattested request that claims nothing is still served', async (t) => {
  // Availability is the other half. An evidence feature that takes the service
  // down when a /proc read degrades is an evidence feature that gets switched
  // off, and this response asserts nothing it cannot support.
  const s = await strictServer({ completeness: 'unattested' });
  t.after(() => s.close());
  const r = await s.chat({ mode: 'AUTO' });
  assert.equal(r.outcome, 'ROUTED');
  assert.equal(r.result.servedIdentity.qualificationFacts.attestation.completeness, 'unattested');
});

test('S4: a strict request whose backend changed mid-flight returns no completion', async (t) => {
  const s = await strictServer({}, 'inst-2');
  t.after(() => s.close());
  const r = await s.chat(EXACT_ROUTE);
  assert.equal(r.outcome, 'ESCALATE');
  assert.equal(r.route.reason, 'ATTEMPT_NOT_ATTRIBUTABLE');
  assert.equal(r.result, null, 'the text is discarded, not returned with a caveat');
  assert.equal(r.telemetry.attemptLifetime.verdict, 'infrastructure-invalid');
});

test('S5: a strict request whose backend instance is unknown at completion refuses', async (t) => {
  const s = await strictServer({}, null);
  t.after(() => s.close());
  const r = await s.chat(EXACT_ROUTE);
  assert.equal(r.outcome, 'ESCALATE');
  assert.equal(r.route.reason, 'ATTEMPT_NOT_ATTRIBUTABLE');
  assert.match(r.telemetry.attemptLifetime.reasons.join(' '), /unknown continuity is not continuity/);
});

test('S6: an attestation already expired at admission refuses before any work', async (t) => {
  const past = new Date(Date.now() - 120_000).toISOString();
  const s = await strictServer({ observedAt: past, expiresAt: new Date(Date.now() - 60_000).toISOString() });
  t.after(() => s.close());
  const r = await s.chat(EXACT_ROUTE);
  assert.equal(r.outcome, 'ESCALATE');
  assert.equal(r.route.reason, 'ATTESTATION_STALE');
  assert.equal(r.telemetry.promptTokens, null, 'nothing was generated');
});

test('S7: a request that outlives its attestation keeps attribution when nothing restarted', async (t) => {
  // The lifetime rule at the API surface: the window lapsed, the process did
  // not change, and the completion is still attributable.
  // Valid when admitted, lapsed by the time the backend finishes: the shape of
  // every long prefill on this deployment.
  const s = await strictServer(
    { expiresAt: new Date(Date.now() + 60).toISOString() }, 'inst-1', 200,
  );
  t.after(() => s.close());
  const r = await s.chat(EXACT_ROUTE);
  assert.equal(r.outcome, 'ROUTED');
  assert.equal(r.telemetry.attemptLifetime.crossedAttestationTtl, true);
  assert.equal(r.telemetry.attemptLifetime.revalidation, 'instance-continuity');
  assert.equal(r.telemetry.attemptLifetime.verdict, 'valid');
});

test('S8: a healthy strict request is served and marked valid', async (t) => {
  const s = await strictServer();
  t.after(() => s.close());
  const r = await s.chat(EXACT_ROUTE);
  assert.equal(r.outcome, 'ROUTED');
  assert.equal(r.result.content, 'hi');
  assert.equal(r.telemetry.attemptLifetime.verdict, 'valid');
});
