/**
 * Backend lifecycle regression tests.
 *
 * These exist because of a specific defect: `Requires=bokahli-runtime.service`
 * made a backend crash take Bokahli's API down with it. Callers got a refused
 * connection instead of an answer, and the authority for runtime health was the
 * one thing that disappeared when the runtime failed.
 *
 * Every test here drives the real router against a real HTTP backend on a
 * loopback port, and the backend is stopped and restarted for real. Nothing is
 * mocked at the boundary that broke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LlamaBackend } from '@bokahli/runtime';
import { unavailableFacts } from '../dist/facts.js';
import { route } from '../dist/router.js';

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


const PINNED_BUILD = 'b10505-testpin';
const ALIAS = 'test-model.q2-k';
const DIGEST = `sha256:${'4'.repeat(64)}`;
const ARTIFACT_PATH = '/models/test-model.gguf';

const ARTIFACT = {
  modelId: ALIAS,
  displayName: 'Test Model',
  digest: DIGEST,
  artifactPath: ARTIFACT_PATH,
  runtimeAlias: ALIAS,
  backend: 'primary',
  facts: {
    architecture: 'testarch',
    quantization: 'Q2_K',
    parameterCount: 1,
    contextTrainTokens: 65536,
    sizeBytes: 1,
  },
  capabilities: { chat: true, completion: true, tools: false, vision: false, audio: false, embedding: false, reasoningEffort: false },
  qualification: { status: 'INSTALLED_UNQUALIFIED', authority: 'luak', qualifiedTaskClasses: [], evidence: [] },
  operational: { servedContextTokens: 32768 },
};

const CATALOG = {
  internal: (id) => (id === ALIAS ? ARTIFACT : undefined),
  internalAll: () => [ARTIFACT],
  publicEntries: () => [{ modelId: ALIAS, digest: DIGEST }],
};

/**
 * A stand-in llama-server. `identity` is swappable so a restarted backend can
 * come back serving something else — the case that must never route.
 */
function startBackend({ identity = {}, port = 0 } = {}) {
  const props = {
    build_info: PINNED_BUILD,
    model_path: ARTIFACT_PATH,
    model_alias: ALIAS,
    model_ftype: 'Q2_K - Medium',
    total_slots: 1,
    default_generation_settings: { n_ctx: 32768 },
    ...identity,
  };
  let propsRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/props') {
      propsRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(props));
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok"}');
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        propsRequests: () => propsRequests,
        stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

/**
 * A gate that qualifies nothing, which is the deployed state: no evidence
 * imported, no policy configured. These tests are about runtime health, and the
 * qualification answer must stay constant across every one of them so a health
 * failure can never be mistaken for a fitness failure.
 */
const DENY_ALL_GATE = {
  decide: (_artifact, taskClass) => ({
    qualified: false,
    reason: 'NO_POLICY_CONFIGURED',
    taskClass: taskClass ?? '(unspecified)',
    key: null,
    shortfalls: [],
    evidenceHash: null,
    evidenceGeneratedAt: null,
    authority: 'none',
    detail: 'no policy configured in this test fixture',
  }),
  rankable: (artifact, taskClass) => ({
    modelId: artifact.modelId,
    decision: DENY_ALL_GATE.decide(artifact, taskClass),
    passRate: null,
    meanScore: null,
    sampleCount: null,
  }),
};

function ctxFor(port) {
  return {
    catalog: CATALOG,
    backend: new LlamaBackend(`http://127.0.0.1:${port}`, PINNED_BUILD, null, 2000),
    qualification: DENY_ALL_GATE,
    queueDepth: 0,
    estimatedPromptTokens: 10,
    // Provenance facts have their own suite; routing only needs them present.
    qualificationFacts: async (a) => attestedFacts(a),
    requestedMaxTokens: 64,
  };
}

const EXACT = { mode: 'EXACT', modelId: ALIAS, artifactDigest: DIGEST };

// ---------------------------------------------------------------------------

test('backend loss while the API is healthy yields a typed terminal escalation', async () => {
  const be = await startBackend();
  const ctx = ctxFor(be.port);

  const healthy = await route(EXACT, ctx);
  assert.equal(healthy.outcome.kind, 'ROUTED', 'sanity: routes while the backend is up');

  await be.stop();

  // The API is still running — this call returns, and returns a contract value.
  const lost = await route(EXACT, ctx);
  assert.equal(lost.outcome.kind, 'ESCALATE');
  assert.equal(lost.outcome.reason, 'RUNTIME_UNHEALTHY');
  assert.equal(lost.artifact, null, 'nothing may be handed to execution');
});

test('the terminal result carries exactly the agreed typed shape', async () => {
  const be = await startBackend();
  const ctx = ctxFor(be.port);
  await be.stop();

  for (const spec of [EXACT, { mode: 'AUTO' }, { mode: 'PROFILE', requirements: {} }]) {
    const { outcome } = await route(spec, ctx);
    assert.deepEqual(
      { outcome: outcome.kind, reason_code: outcome.reason, retryable_local: outcome.retryableLocal },
      { outcome: 'ESCALATE', reason_code: 'RUNTIME_UNHEALTHY', retryable_local: true },
      `${spec.mode} must report the runtime as unhealthy and locally retryable`,
    );
    assert.ok(outcome.detail.length > 0, 'an escalation must say why');
    assert.deepEqual(
      outcome.unmet.map((u) => u.requirement),
      ['runtime.reachable'],
      'the unmet requirement names the runtime, not the caller',
    );
  }
});

test('an unhealthy runtime is never reported as a capability or qualification failure', async () => {
  const be = await startBackend();
  const ctx = ctxFor(be.port);
  await be.stop();
  const { outcome } = await route({ mode: 'AUTO' }, ctx);
  assert.notEqual(outcome.reason, 'REQUIREMENTS_UNMET');
  assert.notEqual(outcome.reason, 'NO_QUALIFIED_LOCAL_ROUTE');
  assert.equal(outcome.retryableLocal, true, 'health problems are retryable; capability problems are not');
});

test('the backend restarting under a new pid does not require an API restart', async () => {
  const be = await startBackend();
  const ctx = ctxFor(be.port);          // one backend client, kept for the whole test
  const port = be.port;

  assert.equal((await route(EXACT, ctx)).outcome.kind, 'ROUTED');

  await be.stop();
  assert.equal((await route(EXACT, ctx)).outcome.reason, 'RUNTIME_UNHEALTHY');

  // A genuinely different server object on the same address: the restarted
  // backend is a new process, not a resumed one.
  const restarted = await startBackend({ port });
  assert.notEqual(restarted.server, be.server);

  const after = await route(EXACT, ctx);
  assert.equal(after.outcome.kind, 'ROUTED', 'routing resumes with no API restart');
  assert.equal(after.outcome.selected.attested, true);
  await restarted.stop();
});

test('routing resumes only after the restarted runtime re-attests its exact identity', async () => {
  const be = await startBackend();
  const ctx = ctxFor(be.port);
  const port = be.port;
  await be.stop();

  // Same port, same alias, different artifact underneath.
  const impostor = await startBackend({ port, identity: { model_path: '/models/something-else.gguf' } });
  const wrong = await route(EXACT, ctx);
  assert.equal(wrong.outcome.kind, 'REFUSED', 'a reachable-but-wrong runtime is an identity problem');
  assert.equal(wrong.outcome.reason, 'EXACT_NOT_ATTESTED');
  assert.notEqual(wrong.outcome.kind, 'ROUTED');
  await impostor.stop();

  // And a wrong *build* is refused too: recovery must not relax the pin.
  const stale = await startBackend({ port, identity: { build_info: 'b00000-different' } });
  const staleOutcome = await route(EXACT, ctx);
  assert.equal(staleOutcome.outcome.kind, 'REFUSED');
  assert.equal(staleOutcome.outcome.reason, 'EXACT_NOT_ATTESTED');
  await stale.stop();

  // Only the correct identity resumes service.
  const correct = await startBackend({ port });
  assert.equal((await route(EXACT, ctx)).outcome.kind, 'ROUTED');
  await correct.stop();
});

test('identity is re-attested on every request, not cached across an outage', async () => {
  const be = await startBackend();
  const ctx = ctxFor(be.port);
  const port = be.port;

  await route(EXACT, ctx);
  const beforeOutage = be.propsRequests();
  assert.ok(beforeOutage >= 1, 'the healthy path attests against the live runtime');
  await be.stop();

  await route(EXACT, ctx);
  const restarted = await startBackend({ port });
  await route(EXACT, ctx);
  assert.ok(
    restarted.propsRequests() >= 1,
    'the restarted backend is asked to prove its identity before it is used again',
  );
  await restarted.stop();
});

test('a backend that accepts connections but never answers fails terminally, not indefinitely', async () => {
  // The nastiest case: the socket is alive, so a naive client waits forever.
  const black = createServer(() => { /* accept and say nothing */ });
  await new Promise((r) => black.listen(0, '127.0.0.1', r));
  const ctx = {
    catalog: CATALOG,
    backend: new LlamaBackend(`http://127.0.0.1:${black.address().port}`, PINNED_BUILD, null, 750),
    qualification: DENY_ALL_GATE,
    queueDepth: 0,
    estimatedPromptTokens: 10,
    // Provenance facts have their own suite; routing only needs them present.
    qualificationFacts: async (a) => attestedFacts(a),
    requestedMaxTokens: 64,
  };

  const started = Date.now();
  const { outcome } = await route(EXACT, ctx);
  const elapsed = Date.now() - started;

  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'RUNTIME_UNHEALTHY');
  assert.ok(elapsed < 5000, `must give up on its own deadline, took ${elapsed} ms`);
  black.closeAllConnections?.();
  await new Promise((r) => black.close(r));
});
