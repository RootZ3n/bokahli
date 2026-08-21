/**
 * The Phase B2 API surface: sampler validation, attestation binding, and the
 * boundary that keeps internal paths internal.
 *
 * Two properties dominate. First, that a Phase 1 client is untouched — the
 * request it sent before produces the same bytes on the wire and the same
 * behaviour, because a compatibility promise that is only documented is a
 * compatibility promise that is already broken. Second, that the attestation
 * digest moves when identity moves and holds still when only the weather does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AdmissionQueue, LlamaBackend } from '@bokahli/runtime';
import { QualificationGate } from '../dist/qualification.js';
import { attestationFor, bindingDigest, unavailableFacts } from '../dist/facts.js';
import { createHandler } from '../dist/http.js';
import { ScanCapacity } from '@bokahli/server/velum-capacity';
import { ScanPool } from '@bokahli/server/scan-pool';

let scanPool;

/**
 * A facts stub for a deployment that *was* reached.
 *
 * `unavailableFacts` describes the opposite — no backend contacted — and using
 * it as the stub for a healthy backend produced an incoherent deployment: the
 * router attested an identity while the facts said none existed. Strict routes
 * now refuse that combination, correctly, so the stub has to model a coherent
 * one: an instance that is known, and an attestation that is present, partial,
 * and fresh.
 */
const TEST_INSTANCE = 'test-instance-1';
function attestedFacts(a, o = {}) {
  const f = unavailableFacts(a);
  const observedAt = new Date().toISOString();
  return {
    ...f,
    backendInstance: { ...f.backendInstance, instanceId: o.instanceId ?? TEST_INSTANCE },
    attestation: {
      ...f.attestation,
      completeness: 'partial',
      missing: ['stubbed'],
      backendInstanceId: o.instanceId ?? TEST_INSTANCE,
      observedAt,
      expiresAt: new Date(Date.now() + (o.lifetimeMs ?? 60_000)).toISOString(),
    },
  };
}


const TOKEN = 'a'.repeat(48);
const MODEL = 'test-model.q2-k';
const DIGEST = `sha256:${'4'.repeat(64)}`;

const ARTIFACT = {
  modelId: MODEL,
  displayName: 'Test Model',
  digest: DIGEST,
  artifactPath: '/models/secret-location/test-model.gguf',
  runtimeAlias: MODEL,
  backend: 'primary',
  facts: {
    format: 'gguf', architecture: 'qwen35moe', quantization: 'Q2_K', sizeBytes: 1,
    parameterCount: 1, activeParameterCount: 1, expertCount: 256, expertUsedCount: 8,
    contextTrainTokens: 262144, vocabSize: 248320, embeddingLength: 2048,
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

const CATALOG = {
  internal: (id) => (id === MODEL ? ARTIFACT : undefined),
  internalAll: () => [ARTIFACT],
  publicEntries: () => [{ modelId: MODEL, digest: DIGEST }],
  luakEvidence: { contractVersion: 'placeholder', source: 'none', records: [] },
};

/** Every body llama-server received, so request compatibility can be asserted. */
let received = [];
let backend;
let api;
let base;

async function start() {
  received = [];
  backend = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        build_info: 'b1', model_path: ARTIFACT.artifactPath, model_alias: MODEL,
        model_ftype: 'Q2_K - Medium', total_slots: 1,
        default_generation_settings: { n_ctx: 32768 },
        chat_template: '{{ messages }}',
      }));
    }
    if (req.url === '/slots') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{
        id: 0, n_ctx: 32768, is_processing: false,
        params: { seed: 4294967295, temperature: 0, top_p: 1, top_k: 20, max_tokens: 512,
          chat_format: 'peg-native', reasoning_format: 'deepseek' },
      }]));
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        data: [{ id: MODEL, meta: { vocab_type: 2, n_vocab: 248320, n_ctx_train: 262144 } }],
      }));
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return undefined;
    }
    return res.writeHead(404).end();
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));

  const deps = {
    config: {
      maxRequestBytes: 1_048_576, publicDir: '/nonexistent', gpuForeignHolderThresholdMiB: 512,
      maxConcurrent: 1, maxQueueDepth: 8, queueTimeoutMs: 5_000, port: 0,
      bindAddresses: ['127.0.0.1'],
    },
    token: TOKEN,
    catalog: CATALOG,
    backend: new LlamaBackend(`http://127.0.0.1:${backend.address().port}`, 'b1', null, 2_000),
    qualification: QualificationGate.empty('llama.cpp', 'b1'),
    queue: new AdmissionQueue({ maxConcurrent: 1, maxQueueDepth: 8, queueTimeoutMs: 5_000 }),
    gpu: { read: async () => ({ snapshot: null, foreignHolders: [], leaseAvailable: true, error: null }) },
    telemetry: {
      log() {}, record() {}, recordAuthFailure() {}, logPromptBody() {},
      summary: () => ({}), recent: () => [],
    },
    facts: {
      collect: async (a) => attestedFacts(a),
      currentInstanceId: async () => TEST_INSTANCE,
    },
    // Required, not optional: a budget that a caller can omit is a budget that
    // is unenforced wherever somebody forgot it.
    scanCapacity: new ScanCapacity(8 * 1024 * 1024, 1024 * 1024),
    // A real pool with one worker: the request path is the thing under test,
    // and a stub would test a path production does not take.
    scanPool: (scanPool = new ScanPool({ workers: 1, jobTimeoutMs: 20_000 })),
    startedAt: new Date().toISOString(),
  };
  api = createServer(createHandler(deps));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
}

async function stop() {
  await new Promise((r) => api.close(r));
  await new Promise((r) => backend.close(r));
  // A harness that starts inspection workers has to stop them. Closing the
  // server alone leaves a worker per test, and a test file that leaks threads
  // eventually stops being a test of anything.
  await scanPool.close();
}

async function chat(body) {
  const res = await fetch(`${base}/v1/bokahli/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      route: { mode: 'EXACT', modelId: MODEL, artifactDigest: DIGEST, requireQualified: false },
      messages: [{ role: 'user', content: 'hi' }],
      ...body,
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// compatibility
// ---------------------------------------------------------------------------

test('a Phase 1 request produces byte-identical upstream request bytes', async () => {
  await start();
  try {
    const r = await chat({ max_tokens: 64, temperature: 0.7, top_p: 0.95 });
    assert.equal(r.status, 200);
    const sent = received.at(-1);
    // The exact Phase 1 body. No new key appears, because a new key would
    // change sampling for every existing caller.
    assert.deepEqual(Object.keys(sent).sort(), [
      'max_tokens', 'messages', 'model', 'stream', 'stream_options', 'temperature',
      'timings_per_token', 'top_p',
    ]);
    assert.equal('top_k' in sent, false);
    assert.equal('seed' in sent, false);
  } finally {
    await stop();
  }
});

test('a request omitting every sampler field keeps the Phase 1 defaults', async () => {
  await start();
  try {
    await chat({});
    const sent = received.at(-1);
    assert.equal(sent.max_tokens, 512);
    assert.equal(sent.temperature, 0.7);
    assert.equal(sent.top_p, 0.95);
  } finally {
    await stop();
  }
});

test('legacy string coercion is preserved: a Phase 1 client is not newly rejected', async () => {
  await start();
  try {
    // Phase 1 parsed this with Number(). Tightening it would break a client
    // that has been working since Phase 1, which is not this phase's business.
    const r = await chat({ temperature: '0.3' });
    assert.equal(r.status, 200);
    assert.equal(received.at(-1).temperature, 0.3);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// sampler validation
// ---------------------------------------------------------------------------

test('the native sampler object reaches the runtime', async () => {
  await start();
  try {
    const r = await chat({ sampler: { temperature: 0, topP: 1, topK: 20, seed: 7, maxTokens: 64 } });
    assert.equal(r.status, 200);
    const sent = received.at(-1);
    assert.equal(sent.temperature, 0);
    assert.equal(sent.top_p, 1);
    assert.equal(sent.top_k, 20);
    assert.equal(sent.seed, 7);
    assert.equal(sent.max_tokens, 64);
  } finally {
    await stop();
  }
});

test('malformed sampler values are refused, never coerced', async () => {
  await start();
  try {
    for (const [sampler, why] of [
      [{ temperature: 'hot' }, 'a string is not a number'],
      [{ temperature: 3 }, 'out of range'],
      [{ temperature: -1 }, 'out of range'],
      [{ topP: 1.5 }, 'out of range'],
      [{ topK: 2.5 }, 'not an integer'],
      [{ topK: -1 }, 'out of range'],
      [{ seed: 1.5 }, 'not an integer'],
      [{ seed: -1 }, 'out of range'],
      [{ maxTokens: 0 }, 'below the floor'],
      [{ maxTokens: 99999 }, 'above the ceiling'],
      [{ temperature: null }, 'null is not a number'],
      [{ temperature: Infinity }, 'not finite'],
    ]) {
      const r = await chat({ sampler });
      assert.equal(r.status, 400, `${JSON.stringify(sampler)}: ${why}`);
    }
  } finally {
    await stop();
  }
});

test('an unknown sampler field is refused rather than silently ignored', async () => {
  await start();
  try {
    // Ignoring this would let a caller believe it set top_k when it set topk
    // and got the default.
    const r = await chat({ sampler: { topk: 20 } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /unknown sampler field/);
  } finally {
    await stop();
  }
});

test('a non-object sampler is refused', async () => {
  await start();
  try {
    for (const sampler of ['0.5', 5, [1, 2]]) {
      assert.equal((await chat({ sampler })).status, 400);
    }
  } finally {
    await stop();
  }
});

test('the seed sentinel is refused so seedSupport cannot be made to lie', async () => {
  await start();
  try {
    const r = await chat({ sampler: { seed: 4294967295 } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /sentinel/);
  } finally {
    await stop();
  }
});

test('setting a value twice is a refusal, not a silent precedence rule', async () => {
  await start();
  try {
    const r = await chat({ temperature: 0.7, sampler: { temperature: 0 } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /set one/);
  } finally {
    await stop();
  }
});

test('an empty sampler object changes nothing', async () => {
  await start();
  try {
    assert.equal((await chat({ sampler: {} })).status, 200);
    const sent = received.at(-1);
    assert.equal('top_k' in sent, false);
    assert.equal(sent.temperature, 0.7);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// telemetry provenance on the wire
// ---------------------------------------------------------------------------

test('token counts arrive with their provenance, and the bare counts are unchanged', async () => {
  await start();
  try {
    const r = await chat({ sampler: { temperature: 0, seed: 7 } });
    const t = r.body.telemetry;
    assert.equal(t.promptTokens, 9, 'the Phase 1 field is untouched');
    assert.equal(t.completionTokens, 2);
    assert.ok(t.tokenCounts, 'provenance travels alongside');
    // The stub facts source supplies no tokenizer, so the honest verdict is the
    // weaker one — which is the entire point of the field.
    assert.equal(t.tokenCounts.source, 'runtime_reported_unknown_tokenizer');
    assert.equal(t.tokenCounts.promptTokens, 9);
  } finally {
    await stop();
  }
});

test('a sent seed is reported as requested, not honoured, when nothing echoes it', async () => {
  await start();
  try {
    const r = await chat({ sampler: { seed: 7 } });
    const s = r.body.telemetry.sampler;
    // The stub slot reports the unset sentinel, so nothing confirms the seed.
    assert.equal(s.seedSupport, 'requested');
    assert.equal(s.sent.seed, 7);
    assert.equal(s.deterministicOutputGuaranteed, false);
  } finally {
    await stop();
  }
});

test('a slot echoing our seed is still not honoured over this API', async () => {
  await start();
  try {
    // Make the slot echo the seed we are about to send. Before the audit this
    // was reported as `honoured`; nothing ties the reading to this generation,
    // so a matching number is a coincidence with good odds.
    const original = backend.listeners('request')[0];
    backend.removeAllListeners('request');
    backend.on('request', (req, res) => {
      if (req.url === '/slots') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify([{
          id: 0, n_ctx: 32768, is_processing: false,
          params: { seed: 7, temperature: 0, top_p: 1, top_k: 20, max_tokens: 512,
            chat_format: 'peg-native', reasoning_format: 'deepseek' },
        }]));
      }
      return original(req, res);
    });
    const r = await chat({ sampler: { seed: 7 } });
    const sampler = r.body.telemetry.sampler;
    assert.equal(sampler.seedSupport, 'requested');
    assert.equal(sampler.effectiveScope, 'backend-instance');
    assert.equal(sampler.effectiveSource, 'runtime-slots-uncorrelated');
  } finally {
    await stop();
  }
});

test('the requested sampler stays separate from the defaults that filled it', async () => {
  await start();
  try {
    const r = await chat({ sampler: { seed: 7 } });
    const s = r.body.telemetry.sampler;
    assert.deepEqual(s.requested, { seed: 7 }, 'only what was asked');
    assert.equal(s.sent.temperature, 0.7, 'the default is recorded as sent, not as requested');
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// attestation binding
// ---------------------------------------------------------------------------

const BINDING = {
  modelId: MODEL,
  artifactDigest: DIGEST,
  runtimeBuild: 'b10505-ee4c505a4',
  imageDigest: `sha256:${'1'.repeat(64)}`,
  tokenizerDigest: `sha256:${'2'.repeat(64)}`,
  effectiveTemplateDigest: `sha256:${'3'.repeat(64)}`,
  backendInstanceId: '5'.repeat(64),
  devicePlacement: { backendHoldsDevice: true, cpuOffloadEnabled: true, requestedGpuLayers: 999 },
  servedContextTokens: 32768,
  maxConcurrentRequests: 1,
  confirmedSampler: { temperature: 0, topP: 1 },
};

test('the binding digest is stable for identical input', () => {
  assert.equal(bindingDigest(BINDING), bindingDigest({ ...BINDING }));
});

test('every bound component changes the digest when it changes', () => {
  const base = bindingDigest(BINDING);
  const variants = {
    modelId: 'other-model',
    artifactDigest: `sha256:${'9'.repeat(64)}`,
    runtimeBuild: 'b10506',
    imageDigest: `sha256:${'8'.repeat(64)}`,
    tokenizerDigest: `sha256:${'7'.repeat(64)}`,
    effectiveTemplateDigest: `sha256:${'6'.repeat(64)}`,
    backendInstanceId: '0'.repeat(64),
    servedContextTokens: 16384,
    maxConcurrentRequests: 2,
  };
  for (const [k, v] of Object.entries(variants)) {
    assert.notEqual(bindingDigest({ ...BINDING, [k]: v }), base, `${k} must be bound`);
  }
  assert.notEqual(
    bindingDigest({ ...BINDING, devicePlacement: { ...BINDING.devicePlacement, backendHoldsDevice: false } }),
    base,
    'a placement verdict change must be visible',
  );
  assert.notEqual(
    bindingDigest({ ...BINDING, confirmedSampler: { temperature: 0.7 } }),
    base,
  );
});

test('a backend restart invalidates the attestation by construction', () => {
  const before = bindingDigest(BINDING);
  const after = bindingDigest({ ...BINDING, backendInstanceId: 'f'.repeat(64) });
  assert.notEqual(before, after, 'the instance is bound, so a new process is a new attestation');
});

test('volatile GPU telemetry is not part of immutable identity', () => {
  // There is deliberately no place to put utilisation or temperature in the
  // binding. If one is ever added, this test is where it should fail.
  assert.equal('gpu' in BINDING, false);
  assert.equal('utilisationPct' in BINDING.devicePlacement, false);
  assert.equal('temperatureC' in BINDING.devicePlacement, false);
  assert.equal('backendVramMiB' in BINDING.devicePlacement, false);
});

// ---------------------------------------------------------------------------
// leakage
// ---------------------------------------------------------------------------

test('no internal path reaches any response body', async () => {
  await start();
  try {
    const chatRes = await chat({ sampler: { seed: 7 } });
    const ready = await fetch(`${base}/health/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const models = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const bodies = [
      JSON.stringify(chatRes.body),
      await ready.text(),
      await models.text(),
    ].join('\n');

    for (const secret of [ARTIFACT.artifactPath, '/models/', 'llama.cpp/build', TOKEN]) {
      assert.equal(bodies.includes(secret), false, `"${secret}" leaked into a response`);
    }
  } finally {
    await stop();
  }
});

test('health/ready separates whole-device telemetry from process placement', async () => {
  await start();
  try {
    const res = await fetch(`${base}/health/ready`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();
    assert.ok('gpuLease' in body, 'appliance telemetry keeps its own key');
    assert.ok('devicePlacement' in body, 'process placement is a separate key');
    assert.ok('backendInstance' in body);
    assert.ok('attestation' in body);
    // They must not be the same object, or one would be read as the other.
    assert.notDeepEqual(body.gpuLease, body.devicePlacement);
  } finally {
    await stop();
  }
});

// ---------------------------------------------------------------------------
// completeness
// ---------------------------------------------------------------------------

const PROVEN_TOKENIZER = {
  provenance: 'observed', observedAt: 'x', family: 'gpt2', pretokenizer: 'qwen35',
  vocabSize: 248320, runtimeVocabSize: 248320, vocabSizeMatch: true,
  metadataDigest: `sha256:${'2'.repeat(64)}`, tokenizedBy: 'runtime',
  runtimeBuild: 'b1', unprovenReasons: [], pretokenizerVerified: false,
  runtimeProof: {
    method: 'runtime-vocab-probe', matches: true, samplesChecked: 24, samplesMatched: 24,
    segmentationDigest: null, backendInstanceId: '5'.repeat(64),
    observedAt: '2026-08-20T12:00:00.000Z', detail: null,
  },
};

test('a configured-tree image digest cannot reach complete', () => {
  // It proves what is on disk, not what the process mapped. Letting it through
  // would upgrade a weaker observation to full strength by omission.
  const a = attestationFor(BINDING, true, PROVEN_TOKENIZER, '2026-08-20T12:00:00.000Z', 'configured-tree');
  assert.equal(a.completeness, 'partial');
  assert.ok(a.missing.some((m) => m.includes('imageDigestBinding')));
});

test('an attestation carries a generation, a lifetime, and its instance', () => {
  const a = attestationFor(BINDING, true, PROVEN_TOKENIZER, '2026-08-20T12:00:00.000Z', 'process-mapped', 3);
  assert.equal(a.generation, 3);
  assert.ok(Date.parse(a.expiresAt) > Date.parse(a.observedAt), 'a cached attestation must expire');
  assert.equal(a.backendInstanceId, BINDING.backendInstanceId);
});

test('complete requires attestation and every bound component', () => {
  const a = attestationFor(BINDING, true, PROVEN_TOKENIZER, '2026-08-20T12:00:00.000Z', 'process-mapped');
  assert.equal(a.completeness, 'complete');
  assert.deepEqual(a.missing, []);
});

test('an unattested backend is unattested, whatever else is present', () => {
  const a = attestationFor(BINDING, false, PROVEN_TOKENIZER, '2026-08-20T12:00:00.000Z', 'process-mapped');
  assert.equal(a.completeness, 'unattested');
});

test('a missing observation is partial, not unattested', () => {
  // These are different claims. "Partial" says an observation is absent;
  // "unattested" says the served identity was not proven, which would send an
  // operator looking for a substitution that did not happen.
  const a = attestationFor({ ...BINDING, imageDigest: null }, true, PROVEN_TOKENIZER, '2026-08-20T12:00:00.000Z', 'process-mapped');
  assert.equal(a.completeness, 'partial');
  assert.deepEqual(a.missing, ['imageDigest']);
});

test('unknown placement is not a pass', () => {
  for (const v of [null, false]) {
    const a = attestationFor(
      { ...BINDING, devicePlacement: { ...BINDING.devicePlacement, backendHoldsDevice: v } },
      true, PROVEN_TOKENIZER, '2026-08-20T12:00:00.000Z', 'process-mapped',
    );
    assert.equal(a.completeness, 'partial');
    assert.ok(a.missing.includes('devicePlacement.backendHoldsDevice'));
  }
});

test('an unproven tokenizer is named in missing even when its digest is present', () => {
  const a = attestationFor(
    BINDING, true,
    { ...PROVEN_TOKENIZER, unprovenReasons: ['vocabulary size mismatch'] },
    '2026-08-20T12:00:00.000Z', 'process-mapped',
  );
  assert.equal(a.completeness, 'partial');
  assert.ok(a.missing.includes('tokenizer.proof'));
});

test('a null tokenizer is missing proof, not silently complete', () => {
  const a = attestationFor(BINDING, true, null, '2026-08-20T12:00:00.000Z', 'process-mapped');
  assert.ok(a.missing.includes('tokenizer.proof'));
});

test('facts for a deployment with no backend claim nothing', () => {
  const f = unavailableFacts({ modelId: MODEL, digest: DIGEST });
  assert.equal(f.attestation.completeness, 'unattested');
  assert.equal(f.tokenizer, null);
  assert.equal(f.placement.backendHoldsDevice, null);
  assert.equal(f.runtime.imageDigestBinding, 'unavailable');
  assert.ok(f.attestation.bindingDigest, 'even an empty binding gets a digest');
});

test('an unparseable observation time yields an expired attestation, not a crash', () => {
  const a = attestationFor(BINDING, true, PROVEN_TOKENIZER, 'not-a-date', 'process-mapped');
  assert.ok(Date.parse(a.expiresAt) < Date.now(), 'already expired is the fail-closed answer');
});
