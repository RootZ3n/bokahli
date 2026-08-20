/**
 * Route-shape attacks against the real HTTP handler.
 *
 * The parser is where a safety flag is most easily lost. `requireQualified`
 * used to be read as `=== true`, so `"true"`, `1`, and `{}` all fell through to
 * *false* — a caller who asked for a qualification check was served without one
 * and told nothing. That is the worst available reading of a malformed request:
 * it resolves ambiguity in the caller's disfavour, silently.
 *
 * These tests drive the assembled server over real HTTP, so they cover the
 * native envelope, the OpenAI-compatible route, and the streaming path together
 * — the three shapes a bypass could hide in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AdmissionQueue, LlamaBackend } from '@bokahli/runtime';
import { createHandler } from '../dist/http.js';
import { QualificationGate } from '../dist/qualification.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOKEN = 't'.repeat(43);
const MODEL = 'm.q4-k';

const ARTIFACT = {
  modelId: MODEL,
  displayName: MODEL,
  digest: DIGEST,
  artifactPath: '/models/m.gguf',
  runtimeAlias: MODEL,
  backend: 'primary',
  facts: {
    format: 'gguf', architecture: 'testarch', quantization: 'Q4_K', sizeBytes: 1,
    parameterCount: 1, activeParameterCount: null, expertCount: null, expertUsedCount: null,
    contextTrainTokens: 65536, vocabSize: 1, embeddingLength: 1,
  },
  capabilities: {
    chat: true, completion: true, tools: false, vision: false,
    audio: false, embedding: false, reasoningEffort: false,
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

let backend;
let api;
let base;

before(async () => {
  backend = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        build_info: 'b1', model_path: '/models/m.gguf', model_alias: MODEL,
        model_ftype: 'Q4_K - Medium', total_slots: 1,
        default_generation_settings: { n_ctx: 32768 },
      }));
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404).end();
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
    // Deny-everything, exactly as a deployment starts.
    qualification: QualificationGate.empty('llama.cpp', 'b1'),
    queue: new AdmissionQueue({ maxConcurrent: 1, maxQueueDepth: 8, queueTimeoutMs: 5_000 }),
    gpu: { read: async () => ({ snapshot: null, foreignHolders: [], leaseAvailable: true, error: null }) },
    telemetry: {
      log() {}, record() {}, recordAuthFailure() {}, logPromptBody() {},
      summary: () => ({}), recent: () => [],
    },
    startedAt: new Date().toISOString(),
  };
  api = createServer(createHandler(deps));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
});

after(async () => {
  backend.closeAllConnections?.();
  api.closeAllConnections?.();
  await new Promise((r) => backend.close(r));
  await new Promise((r) => api.close(r));
});

const MESSAGES = [{ role: 'user', content: 'hi' }];

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* streaming responses are not JSON */ }
  return { status: res.status, outcome: json.outcome ?? json.error?.code, text };
}

// ---------------------------------------------------------------------------

test('a well-formed requireQualified is honoured', async () => {
  const r = await post('/v1/bokahli/chat', {
    route: { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    messages: MESSAGES,
  });
  assert.equal(r.status, 200);
  assert.equal(r.outcome, 'ESCALATE', 'nothing is qualified, so it escalates');
});

test('a malformed requireQualified is an error, never a silent false', async () => {
  for (const value of ['true', 'yes', 1, 0, {}, [], null]) {
    for (const route of [
      { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: value },
      { mode: 'EXACT', modelId: MODEL, artifactDigest: DIGEST, taskClass: 'test_log_triage', requireQualified: value },
      { mode: 'PROFILE', requirements: { requireQualified: value } },
    ]) {
      const r = await post('/v1/bokahli/chat', { route, messages: MESSAGES });
      assert.equal(
        r.status, 400,
        `${route.mode} with requireQualified=${JSON.stringify(value)} must be refused, not served`,
      );
      assert.equal(r.outcome, 'BAD_REQUEST');
    }
  }
});

test('a malformed taskClass is an error', async () => {
  for (const value of [42, {}, '', null]) {
    const r = await post('/v1/bokahli/chat', {
      route: { mode: 'AUTO', taskClass: value, requireQualified: true },
      messages: MESSAGES,
    });
    assert.equal(r.status, 400, `taskClass=${JSON.stringify(value)} must be refused`);
  }
});

test('profile requirements are validated instead of cast through', async () => {
  for (const [label, requirements] of [
    ['array where a number belongs', { minContextTokens: [1] }],
    ['string where an array belongs', { quantizationAllowList: 'Q8' }],
    ['string where a number belongs', { minContextTokens: 'a lot' }],
    ['non-string in a string array', { requiredCapabilities: ['chat', 7] }],
    ['unknown constraint', { minVibes: 5 }],
  ]) {
    const r = await post('/v1/bokahli/chat', {
      route: { mode: 'PROFILE', requirements },
      messages: MESSAGES,
    });
    assert.equal(r.status, 400, `${label} must be a caller-visible error`);
    assert.equal(r.outcome, 'BAD_REQUEST');
  }
});

test('a valid profile still works', async () => {
  const r = await post('/v1/bokahli/chat', {
    route: { mode: 'PROFILE', requirements: { minContextTokens: 1024, requiredCapabilities: ['chat'] } },
    messages: MESSAGES,
  });
  assert.equal(r.status, 200);
  assert.equal(r.outcome, 'ROUTED');
});

test('the OpenAI-compatible route cannot bypass the check either', async () => {
  const bad = await post('/v1/chat/completions', {
    model: MODEL,
    messages: MESSAGES,
    bokahli: { route: { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: 'true' } },
  });
  assert.equal(bad.status, 400);

  const good = await post('/v1/chat/completions', {
    model: MODEL,
    messages: MESSAGES,
    bokahli: { route: { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true } },
  });
  assert.equal(good.status, 200);
  assert.equal(good.outcome, 'ESCALATE');
});

test('the streaming path is refused at parse time, before any headers go out', async () => {
  const r = await post('/v1/chat/completions', {
    model: MODEL,
    messages: MESSAGES,
    stream: true,
    bokahli: { route: { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: 'true' } },
  });
  assert.equal(r.status, 400, 'a malformed flag must not become a 200 stream');
  assert.ok(!r.text.includes('data:'), 'and no SSE frame should have been emitted');
});

test('a request that asks for no qualification keeps its Phase 1 behaviour', async () => {
  for (const body of [
    { route: { mode: 'AUTO' }, messages: MESSAGES },
    { route: { mode: 'EXACT', modelId: MODEL, artifactDigest: DIGEST }, messages: MESSAGES },
    { model: MODEL, messages: MESSAGES },
  ]) {
    const path = 'route' in body ? '/v1/bokahli/chat' : '/v1/chat/completions';
    const r = await post(path, body);
    assert.equal(r.status, 200, 'unchanged from Phase 1');
  }
});

test('EXACT with a wrong digest is still refused before anything else', async () => {
  const r = await post('/v1/bokahli/chat', {
    route: { mode: 'EXACT', modelId: MODEL, artifactDigest: `sha256:${'b'.repeat(64)}` },
    messages: MESSAGES,
  });
  assert.equal(r.status, 409);
  assert.equal(r.outcome, 'REFUSED');
});
