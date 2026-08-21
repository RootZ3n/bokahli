/**
 * A canary may not name a tokenizer family that is not its own.
 *
 * ## What was wrong
 *
 * `scripts/generate-tokenizer-canary.mjs` carried
 * `const SUITE_ID = 'qwen35-broad.v1'` and stamped it on every suite it
 * produced. Four artifacts were pinned with it — two Qwen quantisations, two
 * Gemma — so both Gemma canaries announced a Qwen tokenizer. That id is not
 * decoration: it appears in `/health/ready`, in `attestation`, and in every
 * qualification record a Gemma-served request produced.
 *
 * Nothing underneath was wrong. `verifyTokenizerCanary` compared artifact
 * digest, tokenizer metadata digest and backend instance exactly, and a Qwen
 * suite could never have verified against a Gemma artifact — the metadata
 * digests differ and the binding check refuses. The machine was never fooled.
 * The *label* was false, and the label is the part a person reads when deciding
 * whether evidence describes what they think it describes.
 *
 * ## Why a better constant would not have fixed it
 *
 * A name that can be typed can be typed wrongly, and the next artifact added to
 * the catalog would have inherited whatever the previous one said. So the id is
 * derived from three facts the suite already carries and cannot misreport — the
 * tokenizer family read out of the artifact whose digest was verified, a digest
 * over the corpus, and a prefix of the tokenizer metadata digest — and
 * `validateCanarySuite` recomputes it. An untruthful label is now a refusal at
 * load time rather than a display bug that survives a campaign.
 *
 * These tests hold four things at once: the labels are truthful, the exact
 * bindings are unchanged, a canary still cannot replay, and none of the
 * verification strength that already existed was traded for the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canaryPayloadHash,
  canarySuiteIdentity,
  canaryCorpusDigest,
  validateCanarySuite,
  verifyTokenizerCanary,
} from '@bokahli/runtime';
import { Catalog } from '@bokahli/catalog';

const CATALOG = new URL('../../../catalog/artifacts.json', import.meta.url).pathname;

async function committedSuites() {
  const catalog = await Catalog.load(CATALOG);
  const out = [];
  for (const a of catalog.internalAll()) {
    out.push({ artifact: a, suite: JSON.parse(await readFile(a.tokenizerCanaryPath, 'utf8')) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A. the labels the committed canaries actually carry
// ---------------------------------------------------------------------------

test('A1: no committed canary names a tokenizer family other than its own', async () => {
  for (const { artifact, suite } of await committedSuites()) {
    assert.equal(
      suite.suiteId,
      canarySuiteIdentity(suite),
      `${artifact.modelId}: the declared id is not the one its contents produce`,
    );
    assert.ok(
      suite.suiteId.includes(suite.tokenizerFamily),
      `${artifact.modelId}: the id does not name the family the artifact declares`,
    );
  }
});

test('A2: the Gemma canaries say Gemma and the Qwen canaries say Qwen', async () => {
  // The regression, stated in the plainest possible terms. Before this change
  // every one of these four returned `qwen35-broad.v1`.
  const byModel = new Map(
    (await committedSuites()).map(({ artifact, suite }) => [artifact.modelId, suite]),
  );

  for (const id of ['qwen3.5-35b-a3b.q2-k', 'qwen3.5-35b-a3b.iq3-xxs']) {
    const s = byModel.get(id);
    assert.equal(s.tokenizerFamily, 'gpt2');
    assert.equal(s.tokenizerPre, 'qwen35');
    assert.match(s.suiteId, /^tokcanary\.v1\.gpt2-qwen35\./);
  }
  for (const id of ['gemma4-26b-a4b.q4-k-m', 'gemma4-12b.q6-k']) {
    const s = byModel.get(id);
    assert.equal(s.tokenizerFamily, 'gemma4');
    assert.match(s.suiteId, /^tokcanary\.v1\.gemma4\./);
    assert.equal(
      s.suiteId.includes('qwen'), false,
      'a Gemma canary announcing a Qwen tokenizer is the defect this file exists for',
    );
  }
});

test('A3: the id carries no marketing name — only what the file itself declares', async () => {
  // `gpt2` and `gemma4` are `tokenizer.ggml.model` values read out of the
  // artifacts. Nothing here is chosen, and nothing claims a product name the
  // GGUF does not carry: "Qwen3.5 35B A3B" appears nowhere in an identity.
  for (const { artifact, suite } of await committedSuites()) {
    assert.match(suite.suiteId, /^tokcanary\.v1\.[a-z0-9-]+\.c[0-9a-f]{8}\.t[0-9a-f]{12}$/);
    assert.equal(
      suite.suiteId.includes('35b') || suite.suiteId.includes('26b') || suite.suiteId.includes('12b'),
      false,
      `${artifact.modelId}: parameter counts are catalog facts, not tokenizer identity`,
    );
  }
});

test('A4: two artifacts sharing a tokenizer share an identity, and that is not a collision', async () => {
  const byModel = new Map(
    (await committedSuites()).map(({ artifact, suite }) => [artifact.modelId, suite]),
  );
  const q2 = byModel.get('qwen3.5-35b-a3b.q2-k');
  const iq3 = byModel.get('qwen3.5-35b-a3b.iq3-xxs');

  // Same corpus put to the same tokenizer, so the same identity. The two are
  // different *artifacts*, and that is `artifactDigest`, checked separately and
  // exactly — which A2 of the binding section below proves still refuses.
  assert.equal(q2.tokenizerMetadataDigest, iq3.tokenizerMetadataDigest);
  assert.equal(q2.suiteId, iq3.suiteId);
  assert.notEqual(q2.artifactDigest, iq3.artifactDigest);

  const gemma26 = byModel.get('gemma4-26b-a4b.q4-k-m');
  assert.notEqual(q2.suiteId, gemma26.suiteId, 'different tokenizers, different identity');
});

test('A5: the same corpus is recognisable across tokenizer families', async () => {
  // The corpus component hashes the questions, not the answers. Expected ids
  // differ between tokenizers by design; hashing them would have made every
  // artifact look like a different corpus and destroyed the one thing this
  // component is for.
  const suites = await committedSuites();
  const corpora = new Set(suites.map(({ suite }) => canaryCorpusDigest(suite.encode)));
  assert.equal(corpora.size, 1, 'all four artifacts are canaried against one corpus');

  const families = new Set(suites.map(({ suite }) => suite.tokenizerFamily));
  assert.equal(families.size, 2, 'and two tokenizer families are represented');
});

// ---------------------------------------------------------------------------
// B. the label is a checked claim, not a decoration
// ---------------------------------------------------------------------------

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ARTIFACT = `sha256:${'49'.repeat(32)}`;
const META = `sha256:${'1f'.repeat(32)}`;
const OTHER_META = `sha256:${'2e'.repeat(32)}`;

const REF_ENCODE = {
  method: 'llama-tokenize-vocab-only',
  generatorComponents: ['llama-tokenize:aa'],
  generatorDigest: `sha256:${'cc'.repeat(32)}`,
  generatorBuild: 'build 10505',
  producedByBackendInstanceId: null,
  note: 'separate vocab_only process',
};
const REF_DECODE = {
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
    suiteId: '',
    tokenizerFamily: 'gemma4',
    tokenizerPre: null,
    artifactDigest: ARTIFACT,
    tokenizerMetadataDigest: META,
    vocabSize: 1000,
    encodeSettings: { addSpecial: false, parseSpecial: true },
    encodeReference: REF_ENCODE,
    decodeReference: REF_DECODE,
    encode: [{ id: 'plain', note: 'ascii', inputBase64: b64('hello'), expectedIds: [10] }],
    decode: [{ id: 'vocab-10', note: 'ordinary', tokenId: 10, expectedBytesBase64: b64('hello') }],
    payloadHash: '',
    generatedAt: '2026-08-21T11:00:00.000Z',
    coverage: ['ascii'],
    note: 'identity test corpus',
    ...o,
  };
  if (o.suiteId === undefined) s.suiteId = canarySuiteIdentity(s);
  if (o.payloadHash === undefined) s.payloadHash = canaryPayloadHash(s);
  return s;
}

test('B1: a Gemma suite relabelled as Qwen is refused, not displayed', async () => {
  // The exact shape of the defect: correct expectations, correct bindings, a
  // false name. Before the derived id this validated cleanly and served the lie
  // to every reader of an attestation.
  const forged = suite({ suiteId: 'qwen35-broad.v1' });
  const errs = validateCanarySuite(forged);
  assert.ok(errs.length > 0);
  assert.ok(
    errs.some((e) => e.includes('is not the identity this suite') && e.includes('qwen35-broad.v1')),
    `expected an identity refusal, got: ${errs.join('; ')}`,
  );
});

test('B2: rewriting the family without regenerating fails the payload hash too', () => {
  // Two independent refusals, because a single check is a single thing to
  // forget. The family claim is inside the hash preimage, so an editor that
  // "fixes" the label by hand breaks the seal as well as the identity.
  const s = suite();
  const tampered = { ...s, tokenizerFamily: 'gpt2' };
  const errs = validateCanarySuite(tampered);
  assert.ok(errs.some((e) => e.includes('is not the identity this suite')));
  assert.ok(errs.some((e) => e.includes('payload hash does not match')));
});

test('B3: a suite whose family and metadata disagree cannot be given a consistent id', () => {
  // Changing the metadata digest changes the derived id, so a suite cannot
  // carry one tokenizer's expectations under another tokenizer's identity even
  // if every field is rewritten together — the id would then name the metadata
  // it actually has, which is the truthful outcome.
  const a = suite();
  const b = suite({ tokenizerMetadataDigest: OTHER_META });
  assert.notEqual(a.suiteId, b.suiteId);
  assert.deepEqual(validateCanarySuite(b), []);
  assert.ok(b.suiteId.endsWith(`.t${OTHER_META.replace('sha256:', '').slice(0, 12)}`));
});

test('B4: an artifact declaring no tokenizer family gets an honest placeholder, not a borrowed one', () => {
  const s = suite({ tokenizerFamily: null });
  assert.deepEqual(validateCanarySuite(s), []);
  assert.match(s.suiteId, /^tokcanary\.v1\.unknown-family\./);
});

// ---------------------------------------------------------------------------
// C. nothing that already refused a canary stopped refusing it
// ---------------------------------------------------------------------------

const runtime = () => ({
  tokenize: async () => [10],
  detokenize: async () => 'hello',
  now: () => new Date('2026-08-21T12:00:00.000Z'),
});

const binding = (o = {}) => ({
  artifactDigest: ARTIFACT,
  tokenizerMetadataDigest: META,
  backendInstanceId: 'inst-1',
  ...o,
});

test('C1: an intact suite still verifies both directions', async () => {
  const r = await verifyTokenizerCanary(suite(), binding(), runtime());
  assert.deepEqual(r.reasons, []);
  assert.equal(r.encodeCanaryVerified, true);
  assert.equal(r.decodeCanaryVerified, true);
  assert.equal(r.verifiedBackendInstanceId, 'inst-1');
});

test('C2: a canary still cannot replay across artifacts', async () => {
  const r = await verifyTokenizerCanary(
    suite(), binding({ artifactDigest: `sha256:${'ab'.repeat(32)}` }), runtime(),
  );
  assert.equal(r.encodeCanaryVerified, false);
  assert.ok(r.reasons.some((x) => x.includes('different artifact digest')));
});

test('C3: a canary still cannot replay across tokenizer metadata', async () => {
  // A truthful id makes this *more* visible, not less: the suite's own id now
  // ends in the metadata prefix it was built against, so the mismatch is
  // legible in the record as well as refused in the check.
  const s = suite();
  const r = await verifyTokenizerCanary(s, binding({ tokenizerMetadataDigest: OTHER_META }), runtime());
  assert.equal(r.encodeCanaryVerified, false);
  assert.ok(r.reasons.some((x) => x.includes('different tokenizer metadata')));
  assert.ok(s.suiteId.endsWith(`.t${META.replace('sha256:', '').slice(0, 12)}`));
});

test('C4: a canary still cannot be verified without a backend instance to bind to', async () => {
  const r = await verifyTokenizerCanary(suite(), binding({ backendInstanceId: null }), runtime());
  assert.equal(r.encodeCanaryVerified, false);
  assert.ok(r.reasons.some((x) => x.includes('backend instance is unknown')));
});

test('C5: expectations produced by the backend under test are still refused', async () => {
  const s = suite({
    encodeReference: { ...REF_ENCODE, method: 'live-backend', producedByBackendInstanceId: 'inst-1' },
  });
  const r = await verifyTokenizerCanary(s, binding(), runtime());
  assert.equal(r.encodeCanaryVerified, false);
  assert.ok(r.reasons.some((x) => x.includes('evidence cannot authorise itself')));
});

test('C6: a runtime that segments differently still fails, and says which case', async () => {
  const r = await verifyTokenizerCanary(suite(), binding(), {
    ...runtime(),
    tokenize: async () => [10, 11],
  });
  assert.equal(r.encodeCanaryVerified, false);
  assert.deepEqual([...r.failedCaseIds], ['plain']);
  // Decode is untouched by a segmentation substitution — the separation the
  // two-sided canary exists for, and it still holds.
  assert.equal(r.decodeCanaryVerified, true);
});

test('C7: the reported id is the suite\'s own, so a result names the tokenizer it tested', async () => {
  const s = suite();
  const r = await verifyTokenizerCanary(s, binding(), runtime());
  assert.equal(r.canarySuiteId, s.suiteId);
  assert.equal(r.canarySuiteHash, s.payloadHash);
  assert.match(r.canarySuiteId, /^tokcanary\.v1\.gemma4\./);
});
