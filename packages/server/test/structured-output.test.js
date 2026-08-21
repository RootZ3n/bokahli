/**
 * Two regimes, and the wall between them.
 *
 * `unconstrained` measures whether a model can hold an output contract on its
 * own. `json_schema` measures whether a deployment can be relied on to produce
 * parseable output in production. A model can fail the first and pass the
 * second, and that is a perfectly reasonable thing to ship — but a report that
 * pools the two numbers has said neither thing.
 *
 * The failure this file guards against is subtler than mixing them up in a
 * table. It is crediting a *model* with output a grammar produced, or blaming
 * one for output no grammar prevented. Both follow from the same root: treating
 * a request for constrained generation as though it were a confirmation of one.
 *
 * `--n-gpu-layers 999` was a request too, and the runtime that ignored it
 * served the right artifact, attested perfectly, and ran at a third of the rate
 * for hours. `response_format` is worse in one specific way: nothing downstream
 * of a wrong answer here is about infrastructure, it is about a model's
 * measured capability.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  structuredOutputSchemaDigest,
  unconstrainedFacts,
  isGenerationRegime,
  GENERATION_REGIMES,
  STRUCTURED_OUTPUT_CONTRACT_VERSION,
} from '@bokahli/contracts';
import {
  confirmStructuredOutput,
  STRUCTURED_OUTPUT_PROBE_MARKER,
  STRUCTURED_OUTPUT_PROBE_PROMPT,
  STRUCTURED_OUTPUT_PROBE_SCHEMA,
} from '@bokahli/runtime';

const NOW = () => new Date('2026-08-21T12:00:00.000Z');
const INSTANCE = 'inst-abc';

/**
 * A runtime, described by what it does with `response_format`.
 *
 * `honours` is a real deployment. `ignores` is the failure mode that has no
 * observable signature in `/slots` and must therefore be caught behaviourally.
 */
function runtime(kind, { constrainedText, controlText } = {}) {
  return async (_prompt, schema) => {
    if (kind === 'honours') return schema === null ? 'NO' : `{"v":"${STRUCTURED_OUTPUT_PROBE_MARKER}"}`;
    if (kind === 'ignores') return 'NO';
    if (kind === 'explicit') return schema === null ? controlText : constrainedText;
    if (kind === 'dead') return null;
    throw new Error('probe transport failed');
  };
}

const confirm = (generate, instanceId = INSTANCE) =>
  confirmStructuredOutput({ generate, backendInstanceId: () => instanceId, now: NOW });

// ---------------------------------------------------------------------------
// A. the confirmation probe
// ---------------------------------------------------------------------------

test('A1: a runtime that honours the schema is confirmed, bound to its instance', async () => {
  const r = await confirm(runtime('honours'));
  assert.equal(r.constrained, true);
  assert.equal(r.controlDiffered, true);
  assert.deepEqual([...r.reasons], []);
  assert.equal(r.backendInstanceId, INSTANCE);
  assert.equal(r.method, 'grammar-negative-control-probe');
  assert.equal(r.contractVersion, STRUCTURED_OUTPUT_CONTRACT_VERSION);
});

test('A2: a runtime that silently ignores response_format is caught', async () => {
  // The whole reason this probe exists. `/slots` reports the sampler chain and
  // `chat_format`, and neither changes when a schema is supplied — so by
  // inspection this deployment is indistinguishable from A1.
  const r = await confirm(runtime('ignores'));
  assert.equal(r.constrained, false);
  assert.equal(r.controlDiffered, false);
  assert.ok(r.reasons.some((x) => x.includes('did not return JSON')));
});

test('A3: the constrained arm alone is not a confirmation', async () => {
  // A model that emits the marker whatever it is asked would satisfy the
  // constrained arm on its own. Without the control, the probe would confirm
  // enforcement on a runtime that has none.
  const r = await confirm(runtime('explicit', {
    constrainedText: `{"v":"${STRUCTURED_OUTPUT_PROBE_MARKER}"}`,
    controlText: `{"v":"${STRUCTURED_OUTPUT_PROBE_MARKER}"}`,
  }));
  assert.equal(r.constrained, false, 'both arms identical: the marker is not the grammar’s work');
  assert.equal(r.controlDiffered, false);
  assert.ok(r.reasons.some((x) => x.includes('same text')));
});

test('A4: JSON that the schema does not allow is not enforcement', async () => {
  const r = await confirm(runtime('explicit', {
    constrainedText: '{"v":"something else"}',
    controlText: 'NO',
  }));
  assert.equal(r.constrained, false);
  assert.ok(r.reasons.some((x) => x.includes('the schema does not allow')));
});

test('A5: a probe that cannot run leaves the claim unproven and says why', async () => {
  for (const kind of ['dead', 'throws']) {
    const r = await confirm(runtime(kind));
    assert.equal(r.constrained, false);
    assert.ok(r.reasons.length > 0, kind);
  }
});

test('A6: with no instance to bind to, there is no confirmation', async () => {
  // Same rule the tokenizer canary follows: a behavioural result that cannot
  // name the process it describes describes nothing.
  const r = await confirm(runtime('honours'), null);
  assert.equal(r.constrained, false);
  assert.equal(r.backendInstanceId, null);
  assert.ok(r.reasons.some((x) => x.includes('backend instance is unknown')));
});

test('A7: the probe prompt is answerable without JSON, and says so', () => {
  // If the prompt were ambiguous, "the control differed" would stop being
  // evidence: a model that might have emitted JSON anyway makes the two arms
  // indistinguishable for a reason that has nothing to do with the grammar.
  assert.match(STRUCTURED_OUTPUT_PROBE_PROMPT, /single word/);
  assert.match(STRUCTURED_OUTPUT_PROBE_PROMPT, /Do not output JSON/);
  // And the marker is not a word a model reaches for unprompted.
  assert.equal(/^[A-Z0-9]{5}$/.test(STRUCTURED_OUTPUT_PROBE_MARKER), true);
  assert.deepEqual(STRUCTURED_OUTPUT_PROBE_SCHEMA.properties.v.enum, [STRUCTURED_OUTPUT_PROBE_MARKER]);
  assert.equal(STRUCTURED_OUTPUT_PROBE_SCHEMA.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// B. schema identity
// ---------------------------------------------------------------------------

test('B1: key order does not change a schema’s identity; content does', () => {
  const a = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } };
  const b = { properties: { x: { type: 'string' } }, required: ['x'], type: 'object' };
  assert.equal(structuredOutputSchemaDigest(a), structuredOutputSchemaDigest(b));

  const c = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };
  assert.notEqual(structuredOutputSchemaDigest(a), structuredOutputSchemaDigest(c));
});

test('B2: array order is preserved, because some arrays are positional', () => {
  // `required: ["a","b"]` and `required: ["b","a"]` are the same schema; a
  // canonicaliser that sorted arrays would also have to sort `prefixItems`,
  // which is positional, and would then call two different schemas one.
  const a = { prefixItems: [{ type: 'string' }, { type: 'number' }] };
  const b = { prefixItems: [{ type: 'number' }, { type: 'string' }] };
  assert.notEqual(structuredOutputSchemaDigest(a), structuredOutputSchemaDigest(b));
});

test('B3: the digest is a digest, and it is stable across calls', () => {
  const s = { type: 'object' };
  assert.match(structuredOutputSchemaDigest(s), /^sha256:[0-9a-f]{64}$/);
  assert.equal(structuredOutputSchemaDigest(s), structuredOutputSchemaDigest({ type: 'object' }));
});

// ---------------------------------------------------------------------------
// C. the regime vocabulary and its defaults
// ---------------------------------------------------------------------------

test('C1: an unconstrained request claims nothing about enforcement', () => {
  const f = unconstrainedFacts();
  assert.equal(f.regime, 'unconstrained');
  assert.equal(f.enforcementRequested, false);
  assert.equal(f.schemaDigest, null);
  // Null, not false. "We did not ask" and "we asked and it does not work" send
  // an operator to different places.
  assert.equal(f.enforcementConfirmed, null);
});

test('C2: the regime vocabulary is closed, and both members are named', () => {
  assert.deepEqual([...GENERATION_REGIMES], ['unconstrained', 'json_schema']);
  assert.equal(isGenerationRegime('json_schema'), true);
  assert.equal(isGenerationRegime('grammar'), false);
  assert.equal(isGenerationRegime(undefined), false);
});

// ---------------------------------------------------------------------------
// D. the request envelope, over real HTTP
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { AdmissionQueue, LlamaBackend } from '@bokahli/runtime';
import { unavailableFacts } from '../dist/facts.js';
import { createHandler } from '../dist/http.js';
import { QualificationGate } from '../dist/qualification.js';
import { ScanCapacity } from '@bokahli/server/velum-capacity';
import { ScanPool } from '@bokahli/server/scan-pool';
import { before, after } from 'node:test';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const TOKEN = 't'.repeat(43);
const MODEL = 'm.q4-k';
const TEST_INSTANCE = 'test-instance-1';

const ARTIFACT = {
  modelId: MODEL, displayName: MODEL, digest: DIGEST,
  artifactPath: '/models/m.gguf', runtimeAlias: MODEL, backend: 'primary',
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

function attestedFacts(a, confirmation) {
  const f = unavailableFacts(a);
  const observedAt = new Date().toISOString();
  return {
    ...f,
    structuredOutput: confirmation,
    backendInstance: { ...f.backendInstance, instanceId: TEST_INSTANCE },
    attestation: {
      ...f.attestation,
      completeness: 'partial', missing: ['stubbed'],
      backendInstanceId: TEST_INSTANCE, observedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

let upstream;
let api;
let base;
/** Every body the backend was sent, so the wire form can be asserted on. */
let seen = [];
let confirmation = {
  method: 'grammar-negative-control-probe',
  contractVersion: STRUCTURED_OUTPUT_CONTRACT_VERSION,
  backendInstanceId: TEST_INSTANCE,
  probedAt: '2026-08-21T12:00:00.000Z',
  constrained: true, controlDiffered: true, reasons: [],
};

before(async () => {
  upstream = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        build_info: 'b1', model_path: '/models/m.gguf', model_alias: MODEL,
        model_ftype: 'Q4_K - Medium', total_slots: 1,
        default_generation_settings: { n_ctx: 32768 },
      }));
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return undefined;
    }
    return res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  api = createServer(createHandler({
    config: {
      maxRequestBytes: 1_048_576, publicDir: '/nonexistent', gpuForeignHolderThresholdMiB: 512,
      maxConcurrent: 1, maxQueueDepth: 8, queueTimeoutMs: 5_000, port: 0,
      bindAddresses: ['127.0.0.1'], velumMode: 'enforce',
    },
    token: TOKEN,
    catalog: {
      internal: (id) => (id === MODEL ? ARTIFACT : undefined),
      internalAll: () => [ARTIFACT],
      publicEntries: () => [{ modelId: MODEL, digest: DIGEST }],
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
      collect: async (a) => attestedFacts(a, confirmation),
      currentInstanceId: async () => TEST_INSTANCE,
    },
    scanCapacity: new ScanCapacity(8 * 1024 * 1024, 1024 * 1024),
    scanPool: new ScanPool({ workers: 1, jobTimeoutMs: 20_000 }),
    startedAt: new Date().toISOString(),
  }));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
});

after(async () => {
  upstream.closeAllConnections?.();
  api.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
  await new Promise((r) => api.close(r));
});

async function post(body) {
  seen = [];
  const res = await fetch(`${base}/v1/bokahli/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const ROUTE = { mode: 'EXACT', modelId: MODEL, artifactDigest: DIGEST, requireQualified: false };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['outcome'],
  properties: { outcome: { type: 'string', enum: ['ANSWERED', 'ABSTAINED'] } },
};

test('D1: a schema reaches the runtime as strict json_schema, verbatim', async () => {
  const r = await post({
    route: ROUTE, messages: [{ role: 'user', content: 'hi' }],
    structuredOutput: { schema: SCHEMA, name: 'triage' },
  });
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].response_format, {
    type: 'json_schema',
    json_schema: { name: 'triage', strict: true, schema: SCHEMA },
  });
});

test('D2: an unconstrained request sends no response_format at all', async () => {
  // Byte-for-byte compatibility: a Phase 1 client's body must not gain a key.
  const r = await post({ route: ROUTE, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal('response_format' in seen[0], false);
  assert.equal(r.json.telemetry.structuredOutput.regime, 'unconstrained');
  assert.equal(r.json.telemetry.structuredOutput.enforcementRequested, false);
});

test('D3: the record carries the regime, the schema digest, and the confirmation', async () => {
  const r = await post({
    route: ROUTE, messages: [{ role: 'user', content: 'hi' }],
    structuredOutput: { schema: SCHEMA, name: 'triage' },
  });
  const so = r.json.telemetry.structuredOutput;
  assert.equal(so.regime, 'json_schema');
  assert.equal(so.schemaName, 'triage');
  assert.equal(so.schemaDigest, structuredOutputSchemaDigest(SCHEMA));
  assert.equal(so.enforcementRequested, true);
  assert.equal(so.enforcementConfirmed, true);
  assert.equal(so.confirmation.backendInstanceId, TEST_INSTANCE);
});

test('D4: asked-for and confirmed are separate, and an unconfirmed runtime says so', async () => {
  // The state that must never read as a model result: Bokahli asked for a
  // grammar and this instance was proven not to apply one. Any invalid output
  // under it is a runtime contract failure.
  const saved = confirmation;
  confirmation = { ...saved, constrained: false, controlDiffered: false, reasons: ['ignored'] };
  try {
    const r = await post({
      route: ROUTE, messages: [{ role: 'user', content: 'hi' }],
      structuredOutput: { schema: SCHEMA, name: 'triage' },
    });
    const so = r.json.telemetry.structuredOutput;
    assert.equal(so.enforcementRequested, true);
    assert.equal(so.enforcementConfirmed, false);
    assert.notEqual(so.enforcementRequested, so.enforcementConfirmed);
  } finally {
    confirmation = saved;
  }
});

test('D5: an unprobed instance reports null, which is not false', async () => {
  const saved = confirmation;
  confirmation = null;
  try {
    const r = await post({
      route: ROUTE, messages: [{ role: 'user', content: 'hi' }],
      structuredOutput: { schema: SCHEMA, name: 'triage' },
    });
    assert.equal(r.json.telemetry.structuredOutput.enforcementConfirmed, null);
  } finally {
    confirmation = saved;
  }
});

test('D6: an unreadable structuredOutput is refused, never silently unconstrained', async () => {
  // The one outcome that would poison every record downstream: a request the
  // caller believes is constrained, served without a grammar, and labelled
  // accordingly. A refusal is loud and recoverable; this would not be.
  for (const bad of [
    { schema: 'not an object' },
    { schema: [] },
    { schema: SCHEMA, name: '' },
    { schema: SCHEMA, extra: 1 },
    { name: 'x' },
    'a string',
    42,
  ]) {
    const r = await post({ route: ROUTE, messages: [{ role: 'user', content: 'hi' }], structuredOutput: bad });
    assert.equal(r.status, 400, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(r.json.error.code, 'BAD_REQUEST');
  }
});

test('D7: a schema past the size cap is refused rather than compiled', async () => {
  const huge = { type: 'object', properties: {} };
  for (let i = 0; i < 4000; i++) huge.properties[`field_${i}`] = { type: 'string', description: 'x'.repeat(16) };
  const r = await post({
    route: ROUTE, messages: [{ role: 'user', content: 'hi' }],
    structuredOutput: { schema: huge, name: 'huge' },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /past the \d+ cap/);
});

test('D8: the OpenAI dialect does not gain a second way to ask for the same thing', async () => {
  // One deployment with two spellings of one request is one deployment that can
  // disagree with itself about what was asked.
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: 'user', content: 'hi' }],
      structuredOutput: { schema: SCHEMA },
    }),
  });
  assert.equal(res.status, 200, 'the field is ignored on this dialect, not an error');
  await res.text();
  assert.equal('response_format' in seen[0], false, 'and it certainly does not reach the runtime');
});
