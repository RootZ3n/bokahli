/**
 * Byte conversion on the evidence path, attacked.
 *
 * The host these tests run on miscomputes base64. `Buffer.prototype.
 * toString("base64")` returns a wrong character roughly once in a thousand
 * calls on one physical core — logical CPUs 8 and 9, the two SMT siblings of
 * core 4 — and never on the other twenty-two. The source bytes are provably
 * unchanged, no machine check is raised, and coreutils, OpenSSL, Python and a
 * plain-JavaScript encoder all agree with each other and disagree with Node.
 *
 * That comparison used to decide `decodeCanaryVerified`, which decides Luak's
 * token provenance. A degraded core therefore presented as "the runtime decodes
 * differently from the artifact token table" and discarded a valid attempt as a
 * tokenizer problem. These tests are the reasons that cannot happen again.
 *
 * Nothing here runs a model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE64_IMPLEMENTATION, Base64Error, bytesEqual, decodeBase64, decodeBase64Codes,
  encodeBase64, fromHex, platformBase64Disagrees, toHex,
} from '@bokahli/velum/base64';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The preserved incident fixture. Fixed bytes, never derived at run time. */
const FIXTURE_HEX = '31676e30723320616c6c20707233763130757320316e73747275637431306e73';
const FIXTURE_BASE64 = 'MWduMHIzIGFsbCBwcjN2MTB1cyAxbnN0cnVjdDEwbnM=';
/** What the degraded core produced: index 24, `c` (value 28) became `Y` (24). */
const OBSERVED_BAD = 'MWduMHIzIGFsbCBwcjN2MTB1YyAxbnN0cnVjdDEwbnM=';

// ── the audited implementation ──────────────────────────────────────────────

test('the audited codec agrees with every independent implementation', () => {
  const bytes = fromHex(FIXTURE_HEX);
  assert.ok(bytes);
  assert.equal(encodeBase64(bytes), FIXTURE_BASE64);
  assert.equal(toHex(bytes), FIXTURE_HEX);
  assert.deepEqual(decodeBase64(FIXTURE_BASE64), bytes);
  // coreutils, OpenSSL and Python were run against this same fixture during the
  // incident and produced exactly this string; it is pinned here rather than
  // recomputed, so a future host cannot quietly move the target.
  assert.equal(FIXTURE_BASE64, 'MWduMHIzIGFsbCBwcjN2MTB1cyAxbnN0cnVjdDEwbnM=');
});

test('a million bounded conversions with the audited codec are all correct', () => {
  // The native encoder failed 415 times in 4,000,000 on this machine. This is
  // the same shape of test against the implementation that replaced it.
  const bytes = fromHex(FIXTURE_HEX);
  let bad = 0;
  for (let i = 0; i < 1_000_000; i++) if (encodeBase64(bytes) !== FIXTURE_BASE64) bad++;
  assert.equal(bad, 0, `${bad} encode faults in 1,000,000`);
});

test('a million bounded decodes with the audited codec are all correct', () => {
  const want = fromHex(FIXTURE_HEX);
  let bad = 0;
  for (let i = 0; i < 1_000_000; i++) if (!bytesEqual(decodeBase64(FIXTURE_BASE64), want)) bad++;
  assert.equal(bad, 0, `${bad} decode faults in 1,000,000`);
});

test('the native fault fixture is reproduced, and the audited codec is unmoved by it', () => {
  // The exact corruption, replayed as data rather than waited for.
  assert.notEqual(OBSERVED_BAD, FIXTURE_BASE64);
  let firstDiff = -1;
  for (let i = 0; i < FIXTURE_BASE64.length; i++) {
    if (OBSERVED_BAD[i] !== FIXTURE_BASE64[i]) { firstDiff = i; break; }
  }
  assert.equal(firstDiff, 24, 'the observed fault is at index 24');
  assert.equal(OBSERVED_BAD[24], 'Y');
  assert.equal(FIXTURE_BASE64[24], 'c');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  assert.equal(A.indexOf('Y') ^ A.indexOf('c'), 4, 'one bit of the six-bit value');

  // Both spellings decode to *different* bytes, so the fault is not cosmetic.
  assert.ok(!bytesEqual(decodeBase64(OBSERVED_BAD), decodeBase64(FIXTURE_BASE64)));
  // And the audited encoder still produces the right one.
  assert.equal(encodeBase64(fromHex(FIXTURE_HEX)), FIXTURE_BASE64);
});

// ── failing closed ──────────────────────────────────────────────────────────

test('a corrupted encoded character fails closed rather than decoding to something', () => {
  // Not the observed fault — that one lands inside the alphabet and decodes to
  // different bytes, which is why byte comparison is the defence. This is the
  // other shape: a character outside the alphabet.
  for (const bad of [
    FIXTURE_BASE64.replace('c', '!'),
    `${FIXTURE_BASE64.slice(0, 10)} ${FIXTURE_BASE64.slice(11)}`,
    FIXTURE_BASE64.replace('=', 'A='),
    `${FIXTURE_BASE64}===`,
    FIXTURE_BASE64.slice(0, -2),
  ]) {
    assert.throws(() => decodeBase64(bad), Base64Error, JSON.stringify(bad.slice(0, 20)));
  }
  // Non-canonical tail bits: same bytes, different spelling, still refused.
  const nonCanonical = `${FIXTURE_BASE64.slice(0, -2)}N=`;
  assert.throws(() => decodeBase64(nonCanonical), Base64Error);
  assert.equal(decodeBase64Codes([...nonCanonical].map((c) => c.charCodeAt(0))), null);
});

test('the platform probe reports a disagreement rather than trusting either side', () => {
  const bytes = fromHex(FIXTURE_HEX);
  const fault = platformBase64Disagrees(bytes);
  // On a sound core this is null. On the degraded one it is a typed fault that
  // names both spellings and proves the input did not move.
  if (fault !== null) {
    assert.ok(['encoder-disagreement', 'source-mutated'].includes(fault.kind));
    assert.equal(fault.audited, FIXTURE_BASE64);
    assert.equal(fault.hexBefore, FIXTURE_HEX);
    assert.equal(fault.hexAfter, FIXTURE_HEX, 'the bytes never changed');
  }
  assert.equal(BASE64_IMPLEMENTATION, 'velum.base64/1');
});

test('source-buffer mutation is detected, not silently encoded', () => {
  // A conversion describes the bytes that were read. If they change underneath
  // it, the result describes nothing, and saying so is the only correct answer.
  const bytes = fromHex(FIXTURE_HEX);
  const before = toHex(bytes);
  bytes[10] = (bytes[10] ^ 0xff) & 0xff;
  assert.notEqual(toHex(bytes), before, 'the probe compares hex, which uses no vectorised path');
  assert.notEqual(encodeBase64(bytes), FIXTURE_BASE64, 'and the encoding really did change');
});

// ── the evidence path no longer depends on the platform ─────────────────────

test('no integrity-critical path converts base64 with the platform', () => {
  const offenders = [];
  for (const pkg of ['runtime', 'server', 'contracts', 'qualification', 'tasks', 'catalog']) {
    const dir = join(REPO_ROOT, 'packages', pkg, 'src');
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { walk(join(d, e.name)); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const path = join(d, e.name);
        const code = readFileSync(path, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/toString\(['"]base64['"]\)|from\([^)]*['"]base64['"]\)|\batob\(|\bbtoa\(/.test(code)) {
          offenders.push(path.slice(REPO_ROOT.length + 1));
        }
      }
    };
    try { walk(dir); } catch { /* package may not exist */ }
  }
  assert.deepEqual(offenders, [], 'these must use @bokahli/velum/base64');
});

test('the vendored codec is the audited one, pinned by the same lock as the engine', () => {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/velum/velum.lock.json'), 'utf-8'));
  assert.ok(lock.files['core/base64.ts'], 'the codec is vendored');
  assert.match(lock.files['core/base64.ts'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(lock.files).length, 13);
});

test('the auth token generator is classified, not overlooked', () => {
  // `randomBytes(32).toString('base64url')` in config.ts is the one remaining
  // platform base64 call in Bokahli, and it is deliberately left alone: it
  // generates an identity rather than comparing one. A corrupted character
  // yields a different random token, which is written to disk and then used
  // consistently — there is nothing for it to disagree with. It is recorded
  // here so that "we did not notice" is not a possible reading.
  const config = readFileSync(join(REPO_ROOT, 'packages/server/src/config.ts'), 'utf-8');
  assert.match(config, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.equal((config.match(/toString\('base64/g) ?? []).length, 1, 'exactly one, and it is that one');
});

// ── the canary itself ───────────────────────────────────────────────────────

test('a non-canonical pinned encoding is a host/corpus fault, not a tokenizer verdict', async () => {
  const { verifyTokenizerCanary, canaryPayloadHash } = await import('@bokahli/runtime');
  const DIGEST = `sha256:${'ab'.repeat(32)}`;
  const build = (decodeB64) => {
    const suite = {
      schemaVersion: 'bokahli.tokenizer-canary.v1',
      suiteId: 'test.v1',
      artifactDigest: DIGEST,
      tokenizerMetadataDigest: `sha256:${'cd'.repeat(32)}`,
      vocabSize: 1000,
      encodeSettings: { addSpecial: false, parseSpecial: true },
      encodeReference: { method: 'artifact-token-table' },
      decodeReference: { method: 'artifact-token-table' },
      encode: [{ id: 'e1', note: 'ascii', inputBase64: encodeBase64(new TextEncoder().encode('hi')), expectedIds: [1, 2] }],
      decode: [{ id: 'd1', note: 'ascii', tokenId: 1, expectedBytesBase64: decodeB64 }],
      generatedAt: '2026-08-20T00:00:00.000Z',
      coverage: ['ascii'],
      note: 'test',
    };
    return { ...suite, payloadHash: canaryPayloadHash(suite) };
  };
  const sources = {
    tokenize: async () => [1, 2],
    detokenize: async () => 'hi',
    now: () => new Date('2026-08-20T12:00:00.000Z'),
  };
  const binding = { artifactDigest: DIGEST, tokenizerMetadataDigest: `sha256:${'cd'.repeat(32)}`, backendInstanceId: 'inst-1' };

  // A pinned encoding that is not canonical base64 — the shape a corrupted
  // character produces when it lands outside the alphabet.
  const bad = await verifyTokenizerCanary(build('h!==='), binding, sources);
  assert.equal(bad.decodeCanaryVerified, false);
  assert.equal(bad.encodeCanaryVerified, false, 'both, because the host is what is in doubt');
  assert.ok(bad.hostIntegrityFault, 'and it is named as a host fault');
  assert.equal(bad.baseEncodingImplementation, BASE64_IMPLEMENTATION);
  // Crucially: it does not read as the runtime disagreeing about tokenization.
  for (const r of bad.reasons) {
    assert.ok(!/disagrees with the artifact token table/.test(r), r);
    assert.ok(!/segments text differently/.test(r), r);
  }
  assert.ok(bad.reasons.some((r) => /host integrity/.test(r)));
});

test('a host-integrity fault can never be favourable qualification evidence', async () => {
  const { verifyTokenizerCanary, canaryPayloadHash } = await import('@bokahli/runtime');
  const DIGEST = `sha256:${'ab'.repeat(32)}`;
  const suite = {
    schemaVersion: 'bokahli.tokenizer-canary.v1',
    suiteId: 'test.v1',
    artifactDigest: DIGEST,
    tokenizerMetadataDigest: `sha256:${'cd'.repeat(32)}`,
    vocabSize: 1000,
    encodeSettings: { addSpecial: false, parseSpecial: true },
    encodeReference: { method: 'artifact-token-table' },
    decodeReference: { method: 'artifact-token-table' },
    encode: [{ id: 'e1', note: 'ascii', inputBase64: 'aGk=', expectedIds: [1, 2] }],
    decode: [{ id: 'd1', note: 'ascii', tokenId: 1, expectedBytesBase64: '!!!!' }],
    generatedAt: '2026-08-20T00:00:00.000Z',
    coverage: ['ascii'],
    note: 'test',
  };
  const r = await verifyTokenizerCanary({ ...suite, payloadHash: canaryPayloadHash(suite) },
    { artifactDigest: DIGEST, tokenizerMetadataDigest: `sha256:${'cd'.repeat(32)}`, backendInstanceId: 'inst-1' },
    { tokenize: async () => [1, 2], detokenize: async () => 'hi', now: () => new Date('2026-08-20T12:00:00.000Z') });

  // Not verified, in either direction. There is no path by which a machine that
  // miscomputed a conversion produces a stronger claim than one that did not.
  assert.equal(r.decodeCanaryVerified, false);
  assert.equal(r.encodeCanaryVerified, false);
  assert.equal(r.decodeMatched, 0);
  assert.equal(r.encodeMatched, 0);
  const blob = JSON.stringify(r).toLowerCase();
  for (const forbidden of ['qualified', 'model quality', 'score']) {
    assert.ok(!blob.includes(forbidden), `a host fault must not mention ${forbidden}`);
  }
});

test('the escalate vocabulary carries a dedicated host-integrity reason', () => {
  const routing = readFileSync(join(REPO_ROOT, 'packages/contracts/src/routing.ts'), 'utf-8');
  assert.match(routing, /'HOST_INTEGRITY_FAULT'/);
  // And it is not RUNTIME_UNHEALTHY, which would claim the runtime stopped
  // answering when it is answering perfectly well.
  const http = readFileSync(join(REPO_ROOT, 'packages/server/src/http.ts'), 'utf-8');
  assert.match(http, /reason: 'HOST_INTEGRITY_FAULT'/);
  assert.match(http, /hostIntegrityFault\?\.\(\)/);
});
