#!/usr/bin/env node
/**
 * Generate a pinned two-sided tokenizer canary for one installed artifact.
 *
 * This is a *preparation* step, not part of serving. It runs at artifact
 * registration or qualification preparation and writes a file the operator
 * commits; nothing at request time can produce or refresh a canary, because a
 * system that can generate its own expectations can generate the ones that pass.
 *
 * Expected-value authority:
 *
 *   encode  bytes -> ids   `llama-tokenize` with `vocab_only = true`
 *   decode  id -> bytes    `tokenizer.ggml.tokens` from the verified artifact
 *
 * Neither is the running server. That is the whole point: expectations produced
 * by the backend under test and then compared back to it pass whatever that
 * backend does, including the substitution the canary exists to catch.
 *
 * Live-stack isolation, which is asserted here rather than assumed:
 *
 *   - no HTTP client is imported and no backend URL is read, so this cannot
 *     contact llama-server;
 *   - each reference invocation is a separate short-lived process;
 *   - the child is spawned with CUDA_VISIBLE_DEVICES emptied, so it physically
 *     cannot allocate VRAM and cannot contend with the serving process for the
 *     device;
 *   - `llama-tokenize` sets `vocab_only`, so no tensor data is read and no
 *     inference is possible;
 *   - nothing signals, restarts, or reconfigures anything.
 *
 * Usage:
 *   node scripts/generate-tokenizer-canary.mjs <modelId> [--out <path>]
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Catalog } from '../packages/catalog/dist/index.js';
import {
  canaryPayloadHash,
  canarySuiteIdentity,
  decodeByteLevelBytes,
  isSelfContainedUtf8,
  readGgufTokenizerMetadata,
  readGgufTokenTable,
  readGgufTokenTypes,
  isComparableTokenType,
  validateCanarySuite,
} from '../packages/runtime/dist/index.js';

const run = promisify(execFile);
const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..');
const TOKENIZER_BIN =
  process.env['BOKAHLI_LLAMA_TOKENIZE'] ?? '/home/zen/llama.cpp/build/bin/llama-tokenize';

/**
 * The objects that implement tokenization in the reference generator.
 *
 * Explicit, for the same reason the serving image digest is explicit: "every
 * shared object beside the binary" makes the identity of the generator change
 * when something unrelated is rebuilt.
 */
const GENERATOR_OBJECTS = ['libllama.so', 'libggml.so', 'libggml-base.so', 'libggml-cpu.so'];

/**
 * There is no SUITE_ID constant any more, and that is the point.
 *
 * There used to be: `const SUITE_ID = 'qwen35-broad.v1'`, stamped onto every
 * suite this script produced. Both Gemma artifacts therefore shipped canaries
 * announcing a Qwen tokenizer, and that label travelled into the catalog, into
 * `/health/ready` and into every attestation a Gemma-served request produced.
 *
 * The bindings underneath were never wrong — artifact digest, tokenizer
 * metadata digest and backend instance were all checked exactly, and a Qwen
 * suite could not have verified against a Gemma artifact. What was wrong was
 * the name, which is the part a person reads. Replacing one hand-written name
 * with a better hand-written name would have left the same defect one artifact
 * away, so the id is derived instead: see `canarySuiteIdentity`, which computes
 * it from the tokenizer family read out of the artifact, a digest over the
 * corpus, and a prefix of the tokenizer metadata digest. `validateCanarySuite`
 * recomputes and refuses a mismatch, so an untruthful label is now a refusal.
 */

/**
 * The corpus.
 *
 * Every case names the property it exercises, because a corpus whose reasons
 * are forgotten gets trimmed by the next person who finds it slow. Nothing here
 * is a secret, a user prompt, or a machine path: this file is committed and
 * every case travels inside an attestation.
 *
 * The corpus is deliberately weighted toward *boundaries*. A tokenizer
 * substitution rarely changes how `hello` splits; it changes what happens at
 * the edge of a whitespace run, at a digit group, at a combining mark, at a
 * special-token literal, and in the added-token region near the top of the
 * vocabulary.
 */
const CORPUS = [
  ['ascii-words', 'plain ASCII words: the base case that must not move', 'The quick brown fox jumps over the lazy dog'],
  ['ascii-punct', 'punctuation clusters and quoting', 'Hello, world! "Yes" -- (no); [maybe] {perhaps}: 100%?'],
  ['ascii-mixed-case', 'case boundaries inside a word', 'CamelCaseIdentifier snake_case_name SCREAMING_CASE'],
  ['ws-leading', 'leading whitespace, where byte-level BPE and SPM disagree most', '   leading spaces'],
  ['ws-trailing', 'trailing whitespace, routinely dropped by a normalising tokenizer', 'trailing spaces   '],
  ['ws-repeated', 'a long space run: merge tables encode these as single tokens', 'a' + ' '.repeat(16) + 'b'],
  ['ws-newlines', 'repeated newlines', 'line one\n\nline two\n\n\nline three'],
  ['ws-tabs', 'tabs, alone and mixed with spaces', 'col1\tcol2\t\tcol3\n \t mixed'],
  ['ws-crlf', 'CRLF, which a normaliser may rewrite to LF', 'first\r\nsecond\r\n\r\nthird'],
  ['ws-only', 'whitespace with no anchor text at all', ' \t\n\r\n  '],
  ['code-js', 'source syntax: arrows, braces, semicolons', 'const f = (x) => { return x?.y ?? [1, 2]; };'],
  ['code-py', 'indentation-significant source', 'def f(x):\n    if x > 0:\n        return -x\n    return x'],
  ['code-shell', 'shell metacharacters', 'grep -rn "foo|bar" . | awk \'{print $1}\' && echo $?'],
  ['json-compact', 'compact JSON: no whitespace to hide a boundary', '{"a":1,"b":[true,false,null],"c":"x"}'],
  ['json-pretty', 'indented JSON', '{\n  "key": "value",\n  "n": -12.5e3\n}'],
  ['unicode-accents', 'precomposed accented Latin', 'café naïve über Ångström'],
  ['unicode-combining', 'the same text as base + combining marks, which NFC would fold', 'café naïve über Ångström'],
  ['unicode-nbsp', 'non-breaking space and thin space against ordinary space', 'a b c d'],
  ['unicode-zwj', 'zero-width joiner outside an emoji sequence', 'A‍B‌C'],
  ['emoji-simple', 'single-codepoint emoji', 'ship it 🚀 done ✅'],
  ['emoji-zwj-family', 'a ZWJ sequence: one grapheme, many codepoints, many tokens', '👩‍👩‍👧‍👦 family'],
  ['emoji-skin-tone', 'emoji with a modifier', '👍🏽 thumbs'],
  ['script-cjk', 'Han and kana', '日本語のテキストとひらがな'],
  ['script-cyrillic', 'Cyrillic', 'Проверка токенизатора'],
  ['script-arabic', 'right-to-left script', 'اختبار المحلل اللغوي'],
  ['script-devanagari', 'Devanagari, where combining marks are structural', 'टोकनाइज़र परीक्षण'],
  ['num-digits', 'digit grouping: tokenizers differ on 1/2/3-digit chunks', '1234567890'],
  ['num-boundaries', 'leading zeros, decimals, exponents, signs', '007 3.14159 -42 1e10 0.0001'],
  ['num-mixed', 'digits fused to letters and symbols', 'v2 x86_64 100% $1,234.56 2026-08-20'],
  ['merge-repeat', 'a long run of one character, which merges collapse geometrically', 'a'.repeat(32)],
  ['merge-repeat-pair', 'a repeated bigram', 'abababababababab'],
  ['merge-word-repeat', 'a repeated word with separators', 'test test test test test'],
  ['special-im-start', 'a real chat special token literal', '<|im_start|>'],
  ['special-im-end', 'the terminating special token literal', '<|im_end|>'],
  ['special-chatml-turn', 'a full chat turn as the template renders it', '<|im_start|>system\nYou are a tool.<|im_end|>\n<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\n'],
  ['special-lookalike', 'a special-token lookalike that is NOT in the vocabulary', '<|not_a_real_special_token|>'],
  ['special-partial', 'a truncated special-token literal, which must not match', '<|im_star'],
  ['special-adjacent', 'a special token with no whitespace around it', 'before<|im_end|>after'],
  ['boundary-mixed', 'script, digit and punctuation boundaries with no spaces', 'abc日本語123!@#です456'],
  ['boundary-empty-ish', 'a single space, the smallest input with a boundary', ' '],
];

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function hashObject(path) {
  const real = await realpath(path);
  const bytes = await readFile(real);
  return { component: `${basename(real)}:${sha256(bytes)}`, size: bytes.length };
}

/**
 * Identity of the thing that produced the expectations.
 *
 * Without it, "generated offline" is an unverifiable claim in a comment. With
 * it, a suite generated by a different build is visible as a different
 * reference digest.
 */
async function generatorIdentity() {
  const dir = dirname(TOKENIZER_BIN);
  const components = [];
  for (const p of [TOKENIZER_BIN, ...GENERATOR_OBJECTS.map((o) => join(dir, o))]) {
    const { component } = await hashObject(p);
    components.push(component);
  }
  components.sort();
  const v = await run(TOKENIZER_BIN, ['--version'], { timeout: 10_000 }).catch((e) => ({
    stdout: '', stderr: String(e.stderr ?? ''),
  }));
  const version = `${v.stdout}${v.stderr}`.split('\n').find((l) => l.startsWith('version:'))?.trim() ?? null;
  return {
    method: 'llama-tokenize-vocab-only',
    generatorComponents: components,
    generatorDigest: `sha256:${sha256(components.join('\n'))}`,
    generatorBuild: version,
    producedByBackendInstanceId: null,
    note:
      'llama-tokenize with vocab_only=true, one short-lived process per case, ' +
      'CUDA_VISIBLE_DEVICES emptied so the child cannot allocate VRAM. No server contact.',
  };
}

/** One reference tokenization. Separate process, no GPU, no server. */
async function referenceTokenize(modelPath, text) {
  const stdout = await new Promise((res, rej) => {
    const child = spawn(TOKENIZER_BIN, ['-m', modelPath, '--stdin', '--ids', '--no-bos', '--no-escape'], {
      // Emptied, not unset: an unset variable inherits nothing but also asserts
      // nothing. Emptied is a positive statement that no device is visible, so
      // the child cannot allocate VRAM and cannot contend with the serving
      // process for the device.
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let outBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { outBuf += c; });
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res(outBuf) : rej(new Error(`reference tokenizer exited ${code}`)),
    );
    child.stdin.end(Buffer.from(text, 'utf8'));
  });
  const m = stdout.match(/\[([^\]]*)\]/);
  if (m === null) throw new Error('reference tokenizer produced no id list');
  const inner = (m[1] ?? '').trim();
  if (inner === '') return [];
  return inner.split(',').map((v) => {
    const n = Number(v.trim());
    if (!Number.isInteger(n)) throw new Error(`reference tokenizer produced a non-integer id: ${v}`);
    return n;
  });
}

/**
 * Which vocabulary ids to pin for the decode side.
 *
 * Deterministic from the vocabulary size, anchored at both ends, and weighted
 * toward the added-token region near the top — that is where a substituted
 * vocabulary differs, and where sampling only the ASCII entries near the bottom
 * would find nothing.
 */
function decodeIds(vocabSize, types, special) {
  const ids = new Set([0, 1, vocabSize - 1, vocabSize - 2]);
  const step = Math.max(1, Math.floor(vocabSize / 20));
  for (let i = step; i < vocabSize - 1; i += step) ids.add(i);
  // Every CONTROL and USER_DEFINED entry: this is the real added-token region,
  // and it is where a substituted vocabulary differs first. Sampling the top of
  // the id range instead would have sampled padding, which is not a token.
  if (types !== null) {
    for (let i = 0; i < types.length; i++) if (types[i] === 3 || types[i] === 4) ids.add(i);
  }
  for (const s of special) if (Number.isInteger(s) && s >= 0 && s < vocabSize) ids.add(s);
  return [...ids].filter((i) => i >= 0 && i < vocabSize).sort((a, b) => a - b);
}


/**
 * The artifact's own bytes for one id, or null when the id is not comparable
 * through `/detokenize`.
 *
 * Two exclusions, both discovered by running the canary against the live
 * backend before shipping it. UNUSED and UNDEFINED entries are vocabulary
 * padding that llama.cpp renders as the empty string. Byte fragments that are
 * not valid UTF-8 alone become U+FFFD on both sides, so they "match" by mutual
 * failure. Pinning either would produce a case that fails, or passes, for
 * reasons unrelated to tokenizer identity.
 */
function expectedDecodeBytes(tokens, types, tokenId) {
  const ty = types === null ? null : types[tokenId];
  if (types !== null && !isComparableTokenType(ty)) return null;
  const bytes = decodeByteLevelBytes(tokens[tokenId]);
  if (bytes === null || !isSelfContainedUtf8(bytes)) return null;
  return bytes;
}

/**
 * Re-derive every expectation from the file as written, and refuse on any
 * disagreement.
 *
 * This exists because the first generated suite on this host differed from its
 * own corpus by a single bit — `fox` became `foh` in one stored input while the
 * ids beside it were the ids for `fox`. The payload hash did not catch it: the
 * hash was computed from the same in-memory object that carried the flip, so it
 * certified the corruption. A hash proves a file has not changed since it was
 * hashed; it proves nothing about whether the thing hashed was right.
 *
 * So the loop is closed here instead: read the file back from disk, re-run the
 * independent reference against the *stored* bytes, and compare with the
 * *stored* ids. Anything that went wrong between the corpus and the file —
 * memory, serialisation, or storage — shows up as a mismatch. Cheap insurance
 * on a step that runs once per artifact.
 */
async function reverify(path, artifact, tokens, tokenTypes, meta) {
  const suite = JSON.parse(await readFile(path, 'utf8'));
  const structural = validateCanarySuite(suite);
  if (structural.length > 0) return structural;
  const errs = [];
  // Everything the suite claims about the artifact is re-checked against the
  // artifact, not against the values the suite carries. A binding that is only
  // ever compared with itself is not a binding.
  if (suite.artifactDigest !== artifact.digest) errs.push('artifact digest drifted');
  if (suite.tokenizerMetadataDigest !== meta.metadataDigest) {
    errs.push('tokenizer metadata digest drifted from the artifact');
  }
  // Re-read from the file rather than trusting the suite's own copy. A family
  // name compared only with itself is the defect this whole change is about.
  if ((suite.tokenizerFamily ?? null) !== (meta.family ?? null)) {
    errs.push(
      `suite names tokenizer family ${JSON.stringify(suite.tokenizerFamily)} but the ` +
        `artifact declares ${JSON.stringify(meta.family)}`,
    );
  }
  if ((suite.tokenizerPre ?? null) !== (meta.pretokenizer ?? null)) {
    errs.push(
      `suite names pre-tokenizer ${JSON.stringify(suite.tokenizerPre)} but the ` +
        `artifact declares ${JSON.stringify(meta.pretokenizer)}`,
    );
  }
  if (suite.vocabSize !== tokens.length) errs.push('vocabSize drifted from the artifact');
  if (suite.encodeSettings.addSpecial !== false || suite.encodeSettings.parseSpecial !== true) {
    errs.push('encode settings are not the ones the reference was invoked with');
  }
  for (const c of suite.encode) {
    const text = Buffer.from(c.inputBase64, 'base64').toString('utf8');
    const ids = await referenceTokenize(artifact.artifactPath, text);
    if (JSON.stringify(ids) !== JSON.stringify(c.expectedIds)) {
      errs.push(
        `encode case ${c.id}: stored input tokenizes to [${ids.join(',')}] but the file ` +
          `pins [${c.expectedIds.join(',')}]`,
      );
    }
  }
  for (const c of suite.decode) {
    const bytes = expectedDecodeBytes(tokens, tokenTypes, c.tokenId);
    if (bytes === null || bytes.toString('base64') !== c.expectedBytesBase64) {
      errs.push(`decode case ${c.id}: stored bytes disagree with the artifact token table`);
    }
  }
  return errs;
}

async function main() {
  const modelId = process.argv[2];
  if (!modelId || modelId.startsWith('-')) {
    console.error('usage: generate-tokenizer-canary.mjs <modelId> [--out <path>]');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  const verifyIdx = process.argv.indexOf('--verify-only');
  const catalog = await Catalog.load(join(REPO, 'catalog/artifacts.json'));
  const artifact = catalog.internal(modelId);
  if (!artifact) {
    console.error(`unknown modelId: ${modelId}`);
    process.exit(2);
  }
  const out =
    outIdx > 0 ? process.argv[outIdx + 1] : join(REPO, 'catalog/canaries', `${modelId}.canary.json`);

  // Expectations are pinned to a digest, so the digest is confirmed here rather
  // than trusted. A canary generated against a file that is not the file the
  // catalog names would bind the wrong segmentation to the right identity.
  process.stderr.write(`verifying artifact digest (${(await stat(artifact.artifactPath)).size} bytes)…\n`);
  const v = await catalog.verifyDigest(modelId);
  if (!v.match) {
    console.error(`artifact digest does not match the catalog: expected ${v.expected}, got ${v.actual}`);
    process.exit(1);
  }

  const meta = await readGgufTokenizerMetadata(artifact.artifactPath);
  const tokens = await readGgufTokenTable(artifact.artifactPath);
  const tokenTypes = await readGgufTokenTypes(artifact.artifactPath);
  // Generating without types is possible and produces a weaker corpus: every
  // padding slot would have to be pinned or guessed at. Refuse instead — this
  // step runs once, and a canary generated blind is a canary that fails later
  // for reasons nobody can attribute.
  if (tokenTypes === null) {
    console.error(
      'artifact carries no usable tokenizer.ggml.token_type array (absent, wrong element ' +
        'type, or not the same length as the token table); refusing to pin a corpus blind',
    );
    process.exit(1);
  }
  if (tokens === null) {
    console.error('artifact carries no token table; a canary cannot be generated');
    process.exit(1);
  }
  if (meta.metadataDigest === null) {
    console.error('artifact carries no tokenizer metadata to bind against');
    process.exit(1);
  }

  if (verifyIdx > 0) {
    // Re-check a committed canary without rewriting it. Same independent
    // references, same comparison; nothing is generated and nothing is served.
    const errs = await reverify(process.argv[verifyIdx + 1], artifact, tokens, tokenTypes, meta);
    if (errs.length > 0) {
      console.error(`canary does not re-derive:\n  ${errs.join('\n  ')}`);
      process.exit(1);
    }
    process.stderr.write('canary re-derives exactly from its independent references\n');
    return;
  }

  const encodeReference = await generatorIdentity();
  process.stderr.write(`reference: ${encodeReference.generatorBuild}\n`);

  const encode = [];
  for (const [id, note, text] of CORPUS) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text) {
      console.error(`case ${id} does not round-trip through UTF-8; refusing to pin it`);
      process.exit(1);
    }
    const expectedIds = await referenceTokenize(artifact.artifactPath, text);
    if (expectedIds.length === 0 && text.length > 0) {
      console.error(`case ${id} produced no tokens; refusing to pin an empty expectation`);
      process.exit(1);
    }
    encode.push({ id, note, inputBase64: bytes.toString('base64'), expectedIds });
    process.stderr.write(`  encode ${id}: ${expectedIds.length} tokens\n`);
  }

  const decode = [];
  let skippedNonUtf8 = 0;
  for (const tokenId of decodeIds(tokens.length, tokenTypes, [
    meta.bosTokenId, meta.eosTokenId, meta.paddingTokenId,
  ])) {
    const bytes = expectedDecodeBytes(tokens, tokenTypes, tokenId);
    // A token whose bytes are not valid UTF-8 on their own cannot survive the
    // JSON transport /detokenize answers with: both sides render it as U+FFFD
    // and therefore agree, which is a false positive rather than evidence.
    // Skipped and counted, not hidden.
    if (bytes === null) {
      skippedNonUtf8 += 1;
      continue;
    }
    decode.push({
      id: `vocab-${tokenId}`,
      note:
        tokenTypes !== null && (tokenTypes[tokenId] === 3 || tokenTypes[tokenId] === 4)
          ? 'added / control token, where a substituted vocabulary differs first'
          : 'vocabulary entry sampled deterministically from the token table',
      tokenId,
      expectedBytesBase64: bytes.toString('base64'),
    });
  }

  const suite = {
    schemaVersion: 'bokahli.tokenizer-canary.v1',
    // Filled in below, once the encode corpus exists: the id is derived from
    // the suite, so it cannot be written before the suite is.
    suiteId: '',
    // Read from the artifact whose digest was verified above, never chosen.
    tokenizerFamily: meta.family,
    tokenizerPre: meta.pretokenizer,
    artifactDigest: artifact.digest,
    tokenizerMetadataDigest: meta.metadataDigest,
    vocabSize: tokens.length,
    // Matched to what llama-server does by default and to what the reference
    // was invoked with: --no-bos is add_special=false, and llama-tokenize
    // parses special tokens unless told not to.
    encodeSettings: { addSpecial: false, parseSpecial: true },
    encodeReference,
    decodeReference: {
      method: 'gguf-token-table',
      generatorComponents: [`tokenizer.ggml.tokens:${sha256(tokens.join(' '))}`],
      generatorDigest: meta.metadataDigest,
      generatorBuild: null,
      producedByBackendInstanceId: null,
      note:
        'Decoded from the artifact’s own token table, byte-level BPE encoding reversed. ' +
        'Entries whose bytes are not valid UTF-8 alone are excluded: the JSON transport ' +
        'cannot carry them faithfully, so pinning them would fail a correct deployment.',
    },
    encode,
    decode,
    payloadHash: '',
    generatedAt: new Date().toISOString(),
    coverage: [
      'ascii words and punctuation', 'leading/trailing/repeated whitespace', 'newlines, tabs, CRLF',
      'source-code syntax', 'JSON', 'combining marks and normalisation-sensitive text',
      'emoji including ZWJ sequences and modifiers', 'CJK, Cyrillic, Arabic, Devanagari',
      'digit grouping and numeric boundaries', 'merge-sensitive repeated substrings',
      'chat special tokens, lookalikes and partials', 'added-token region of the vocabulary',
    ],
    note:
      'Behavioural canary, both directions. Not a proof of tokenizer equivalence: it ' +
      'establishes that these inputs produce these ids and these ids produce these bytes. ' +
      `${skippedNonUtf8} sampled vocabulary entries were excluded: UNUSED padding, which the ` +
      'runtime renders as the empty string, and byte fragments that are not valid UTF-8 alone.',
  };
  suite.suiteId = canarySuiteIdentity(suite);
  suite.payloadHash = canaryPayloadHash(suite);
  process.stderr.write(
    `identity: ${suite.suiteId}\n` +
      `  tokenizer family: ${meta.family ?? '(none declared)'}` +
      `${meta.pretokenizer === null ? '' : ` / pre ${meta.pretokenizer}`}\n`,
  );

  await writeFile(out, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');

  process.stderr.write('re-deriving every expectation from the file as written…\n');
  const errs = await reverify(out, artifact, tokens, tokenTypes, meta);
  if (errs.length > 0) {
    console.error(`the written canary does not survive re-derivation:\n  ${errs.join('\n  ')}`);
    console.error('the file was written; do NOT commit it. Re-run generation.');
    process.exit(1);
  }

  process.stderr.write(
    `wrote and re-verified ${out}: ${encode.length} encode cases, ${decode.length} decode ` +
      `cases, ${skippedNonUtf8} vocabulary entries skipped as not self-contained UTF-8\n` +
      `${suite.payloadHash}\n`,
  );
}

await main();
