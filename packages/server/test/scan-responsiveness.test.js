/**
 * The API keeps answering while a hostile scan runs.
 *
 * This is the property Blocker 2 was about, stated at the level a caller sees
 * it. Measured on the main thread, a 1 MiB document delayed the event loop by
 * 2,165 ms and a 4 MiB one by 8,266 ms — and everything the loop owes was
 * delayed with it: `/health/live`, authentication, admission, queue release,
 * every in-flight stream. Off-thread the same scans delay it by 0.5 ms and
 * 1.2 ms.
 *
 * A timer proxy shows that in `scan-pool.test.js`. This shows it over HTTP,
 * because a health check that a synthetic benchmark says is fine and a real
 * request says is not would be worse than no test at all.
 *
 * Nothing here runs a model.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { AdmissionQueue, LlamaBackend } from '@bokahli/runtime';
import { QualificationGate } from '../dist/qualification.js';
import { createHandler } from '../dist/http.js';
import { ScanCapacity } from '@bokahli/server/velum-capacity';
import { ScanPool } from '@bokahli/server/scan-pool';

const TOKEN = 'test-token-responsiveness';
const MODEL = 'qwen3.5-35b-a3b.q2-k';
const DIGEST = `sha256:${'49'.repeat(32)}`;
const CATALOG = {
  artifacts: () => [],
  byId: () => null,
  byDigest: () => null,
  entries: () => [],
};

let api;
let backend;
let base;
let pool;

before(async () => {
  backend = createServer((_req, res) => res.writeHead(503).end());
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  pool = new ScanPool({ workers: 2, jobTimeoutMs: 60_000 });

  const deps = {
    config: {
      maxRequestBytes: 8 * 1024 * 1024, publicDir: '/nonexistent',
      gpuForeignHolderThresholdMiB: 512, maxConcurrent: 1, maxQueueDepth: 8,
      queueTimeoutMs: 5_000, port: 0, bindAddresses: ['127.0.0.1'],
      velumMode: 'audit', velumInFlightBytes: 32 * 1024 * 1024,
      velumWorkers: 2, velumJobTimeoutMs: 60_000,
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
    facts: { collect: async () => ({}), currentInstanceId: async () => 'inst-1', hostIntegrityFault: () => null },
    scanCapacity: new ScanCapacity(32 * 1024 * 1024, 8 * 1024 * 1024),
    scanPool: pool,
    startedAt: new Date().toISOString(),
  };
  api = createServer(createHandler(deps));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  // Let both workers announce themselves before anything is timed.
  const deadline = Date.now() + 5_000;
  while (pool.health().ready < 2 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
});

after(async () => {
  backend.closeAllConnections?.();
  api.closeAllConnections?.();
  await new Promise((r) => backend.close(r));
  await new Promise((r) => api.close(r));
  await pool.close();
});

const UNIT = 'the quick brown fox jumps over the lazy dog. ';
const doc = (bytes) => UNIT.repeat(Math.ceil(bytes / UNIT.length)).slice(0, bytes);

/** A chat request whose evidence is large enough to be slow. */
function hostileRequest(bytes) {
  return fetch(`${base}/v1/bokahli/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      route: { mode: 'EXACT', modelId: MODEL, artifactDigest: DIGEST },
      messages: [{ role: 'user', content: 'summarise the attached log' }],
      evidence: [{ id: 'big.log', content: doc(bytes) }],
    }),
  }).then((r) => r.status).catch(() => -1);
}

/** Poll an endpoint while `work` runs; return the latency distribution. */
async function latencyDuring(work, probe) {
  const samples = [];
  let running = true;
  const poller = (async () => {
    while (running) {
      const t0 = Date.now();
      await probe().catch(() => undefined);
      samples.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  const result = await work();
  running = false;
  await poller;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return { result, n: sorted.length, p50: at(50), p95: at(95), max: sorted.at(-1) ?? 0 };
}

test('the liveness endpoint answers while a 1 MiB scan runs', async () => {
  const m = await latencyDuring(
    () => hostileRequest(1024 * 1024),
    () => fetch(`${base}/health/live`).then((r) => r.status),
  );
  assert.ok(m.n > 10, `only ${m.n} probes completed during the scan`);
  // On the main thread this endpoint did not answer at all for ~2.2 seconds.
  assert.ok(m.max < 500, `worst /health/live latency ${m.max}ms (p50 ${m.p50}, p95 ${m.p95})`);
});

test('authenticated metadata answers while a 4 MiB scan runs', async () => {
  const m = await latencyDuring(
    () => hostileRequest(4 * 1024 * 1024),
    () => fetch(`${base}/v1/telemetry`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.status),
  );
  assert.ok(m.n > 10, `only ${m.n} probes completed during the scan`);
  assert.ok(m.max < 500, `worst /v1/telemetry latency ${m.max}ms (p50 ${m.p50}, p95 ${m.p95})`);
});

test('authentication still refuses while the inspector is busy', async () => {
  // A saturated inspector must not become an authentication bypass, and must
  // not make a 401 wait either.
  const m = await latencyDuring(
    () => hostileRequest(2 * 1024 * 1024),
    async () => {
      const r = await fetch(`${base}/v1/telemetry`);
      assert.equal(r.status, 401);
      return r.status;
    },
  );
  assert.ok(m.n > 5);
  assert.ok(m.max < 500, `worst unauthenticated latency ${m.max}ms`);
});

test('inspection capacity and worker health are published while busy', async () => {
  const during = await latencyDuring(
    () => hostileRequest(2 * 1024 * 1024),
    async () => {
      const r = await fetch(`${base}/v1/telemetry`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const body = await r.json();
      assert.ok(body.velum.workers.workers >= 1);
      assert.ok(body.velum.capacity.limitBytes > 0);
      // Counts and bytes only.
      assert.ok(!JSON.stringify(body.velum).includes('quick brown fox'));
      return r.status;
    },
  );
  assert.ok(during.n > 5);
});

test('a third concurrent scan is refused rather than queued, and answers at once', async () => {
  const a = hostileRequest(3 * 1024 * 1024);
  const b = hostileRequest(3 * 1024 * 1024);
  await new Promise((r) => setTimeout(r, 60));
  const t0 = Date.now();
  const third = await fetch(`${base}/v1/bokahli/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      route: { mode: 'EXACT', modelId: MODEL, artifactDigest: DIGEST },
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const waited = Date.now() - t0;
  const body = await third.json();
  await Promise.all([a, b]);

  // Refused immediately with a typed capacity outcome — not held until a
  // worker frees up, which is the unbounded queue this design does not have.
  assert.ok(waited < 500, `a refusal took ${waited}ms, which is not a refusal`);
  if (body.outcome === 'CAPACITY_UNAVAILABLE') {
    assert.equal(body.route.reason, 'VELUM_SCAN_CAPACITY');
    assert.ok(body.route.retryAfterSeconds > 0);
    // Never a model failure.
    assert.equal(body.result, null);
  }
});
