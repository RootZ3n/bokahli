/**
 * Routing prefers what is loaded, and says so when nothing loaded fits.
 *
 * Bokahli serves one model at a time and cannot swap: starting a different
 * artifact is an operator action through `bokahli-runtime.service`. Before
 * `preferResident` existed, AUTO and PROFILE both ranked the whole catalog,
 * picked a winner, and then failed `attest()` when the winner was not the
 * resident artifact. The refusal was correct and the *reason* was wrong: the
 * artifact met every stated requirement and was simply not loaded, which is a
 * completely different thing from "nothing installed can serve this".
 *
 * That difference is the difference between "give up" and "load this and
 * retry", and no caller can act on it unless the two are told apart. ikbi and
 * Hermes both need to distinguish them to decide whether to fall back to a
 * remote provider or to ask an operator for a swap.
 *
 * Two properties are pinned here:
 *
 *   1. An eligible resident artifact wins outright, whatever the ranking says
 *      about the rest. Residency decides *whether* the request can be served
 *      now; ranking only decides *which* name to report when it cannot.
 *   2. When the resident is ineligible and something else is not, the answer is
 *      `LOCAL_MODEL_SWAP_REQUIRED`, carrying the resident artifact, what it
 *      failed, the artifacts that would satisfy, and each one's measured
 *      cold-load cost — so the decision to swap is made against a number.
 *
 * And the property that must NOT hold: nothing here proposes an unload. One
 * caller's routing preference must never evict another caller's working
 * deployment, so the request path can report a swap and can never perform one.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LlamaBackend } from '@bokahli/runtime';
import { unavailableFacts } from '../dist/facts.js';
import { QualificationGate } from '../dist/qualification.js';
import { route } from '../dist/router.js';

const INSTANCE = 'resident-test-1';
const DIGEST_SMALL = `sha256:${'11'.repeat(32)}`;
const DIGEST_BIG = `sha256:${'22'.repeat(32)}`;

function artifact(modelId, digest, { ctx, coldLoadSeconds, vramMiB }) {
  return {
    modelId,
    displayName: modelId,
    digest,
    artifactPath: `/models/${modelId}.gguf`,
    tokenizerCanaryPath: null,
    runtimeAlias: modelId,
    backend: 'primary',
    facts: {
      format: 'gguf', architecture: 'testarch', quantization: 'Q6_K', sizeBytes: 1,
      parameterCount: 1, activeParameterCount: null, expertCount: null, expertUsedCount: null,
      contextTrainTokens: 262144, vocabSize: 1, embeddingLength: 1,
    },
    capabilities: {
      chat: true, completion: true, tools: false, vision: false,
      audio: false, embedding: false, reasoningEffort: false,
    },
    qualification: {
      status: 'INSTALLED_UNQUALIFIED', authority: 'none', evidenceRef: null,
      qualifiedTaskClasses: [], note: 'synthetic',
    },
    operational: {
      servedContextTokens: ctx, maxConcurrentRequests: 1, measuredAt: '2026-08-21T16:00:00Z',
      coldLoadSeconds, vramMiB,
    },
  };
}

// Two artifacts that differ in exactly one routable way: served context. That
// is the only discriminator the profile evaluator has, and it is enough to make
// the resident one ineligible without touching anything else.
const SMALL = artifact('small.q6-k', DIGEST_SMALL, { ctx: 8192, coldLoadSeconds: 2.45, vramMiB: 7918 });
const BIG = artifact('big.q6-k', DIGEST_BIG, { ctx: 65536, coldLoadSeconds: 7.54, vramMiB: 10026 });

function attestedFacts(a) {
  const f = unavailableFacts(a);
  const observedAt = new Date().toISOString();
  return {
    ...f,
    backendInstance: { ...f.backendInstance, instanceId: INSTANCE },
    attestation: {
      ...f.attestation, completeness: 'partial', missing: ['stubbed'],
      backendInstanceId: INSTANCE, observedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

let upstream;
let backend;
/** Which artifact the fake runtime claims to be serving. Flipped per test. */
let serving = SMALL;

before(async () => {
  upstream = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        build_info: 'b1',
        model_path: serving.artifactPath,
        model_alias: serving.runtimeAlias,
        model_ftype: 'Q6_K',
        total_slots: 1,
        default_generation_settings: { n_ctx: serving.operational.servedContextTokens },
      }));
    }
    return res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  backend = new LlamaBackend(`http://127.0.0.1:${upstream.address().port}`, 'b1', null, 2000);
});

after(async () => {
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
});

function ctx(artifacts, { estimatedPromptTokens = 10, requestedMaxTokens = 10 } = {}) {
  return {
    catalog: {
      internal: (id) => artifacts.find((a) => a.modelId === id),
      internalAll: () => artifacts,
      publicEntries: () => artifacts.map((a) => ({ modelId: a.modelId, digest: a.digest })),
    },
    backend,
    qualification: QualificationGate.empty('llama.cpp', 'b1'),
    queueDepth: 0,
    estimatedPromptTokens,
    requestedMaxTokens,
    qualificationFacts: async (a) => attestedFacts(a),
  };
}

// ---------------------------------------------------------------------------

test('AUTO serves the resident artifact when it is eligible', async () => {
  serving = SMALL;
  const r = await route({ mode: 'AUTO', requireQualified: false }, ctx([SMALL, BIG]));
  assert.equal(r.outcome.kind, 'ROUTED');
  assert.equal(r.outcome.selected.modelId, SMALL.modelId);
});

test('AUTO still serves the resident one when a differently-ranked artifact is also eligible', async () => {
  // BIG is listed first and has the larger context, so any ranking that ignored
  // residency could plausibly prefer it. Residency is not a tiebreak; it is the
  // question of whether the request can be served at all right now.
  serving = SMALL;
  const r = await route({ mode: 'AUTO', requireQualified: false }, ctx([BIG, SMALL]));
  assert.equal(r.outcome.kind, 'ROUTED');
  assert.equal(r.outcome.selected.modelId, SMALL.modelId,
    'the loaded artifact wins over a catalog-order or rank preference');
});

test('a request the resident cannot fit escalates LOCAL_MODEL_SWAP_REQUIRED, not REQUIREMENTS_UNMET', async () => {
  serving = SMALL; // 8192 context
  const r = await route(
    { mode: 'AUTO', requireQualified: false },
    ctx([SMALL, BIG], { estimatedPromptTokens: 20_000, requestedMaxTokens: 1000 }),
  );
  assert.equal(r.outcome.kind, 'ESCALATE');
  assert.equal(r.outcome.reason, 'LOCAL_MODEL_SWAP_REQUIRED');
  assert.notEqual(r.outcome.reason, 'REQUIREMENTS_UNMET',
    'something installed does satisfy this; saying otherwise sends the caller to a remote provider');
});

test('the escalation carries the resident artifact, why it failed, and the measured swap cost', async () => {
  serving = SMALL;
  const r = await route(
    { mode: 'AUTO', requireQualified: false },
    ctx([SMALL, BIG], { estimatedPromptTokens: 20_000, requestedMaxTokens: 1000 }),
  );
  const swap = r.outcome.swap;
  assert.ok(swap, 'a swap escalation without swap facts is an escalation nobody can act on');
  assert.equal(swap.residentModelId, SMALL.modelId);
  assert.ok(swap.residentUnmet.some((u) => u.requirement.startsWith('context')),
    'it must say why the loaded artifact does not fit');
  assert.deepEqual(swap.candidates.map((c) => c.modelId), [BIG.modelId]);
  assert.equal(swap.candidates[0].coldLoadSeconds, 7.54, 'measured, from the operational profile');
  assert.equal(swap.candidates[0].vramMiB, 10026);
  assert.equal(swap.candidates[0].digest, DIGEST_BIG);
});

test('an artifact nobody has timed reports null cost, and null is not "cheap"', async () => {
  const untimed = artifact('untimed.q6-k', `sha256:${'33'.repeat(32)}`,
    { ctx: 65536, coldLoadSeconds: undefined, vramMiB: undefined });
  serving = SMALL;
  const r = await route(
    { mode: 'AUTO', requireQualified: false },
    ctx([SMALL, untimed], { estimatedPromptTokens: 20_000, requestedMaxTokens: 1000 }),
  );
  assert.equal(r.outcome.reason, 'LOCAL_MODEL_SWAP_REQUIRED');
  assert.equal(r.outcome.swap.candidates[0].coldLoadSeconds, null);
  assert.equal(r.outcome.swap.candidates[0].vramMiB, null);
});

test('when nothing installed fits, the reason stays REQUIREMENTS_UNMET', async () => {
  // The swap reason must not swallow the genuine "give up" case. Here both
  // artifacts are too small, so there is nothing to load and no swap to suggest.
  serving = SMALL;
  const r = await route(
    { mode: 'AUTO', requireQualified: false },
    ctx([SMALL, BIG], { estimatedPromptTokens: 200_000, requestedMaxTokens: 1000 }),
  );
  assert.equal(r.outcome.kind, 'ESCALATE');
  assert.equal(r.outcome.reason, 'CONTEXT_EXCEEDS_LOCAL_CAPABILITY');
  assert.equal(r.outcome.swap, undefined);
});

test('PROFILE gets the same treatment: it never weakens a constraint to avoid a swap', async () => {
  serving = SMALL;
  const r = await route(
    { mode: 'PROFILE', requirements: { minContextTokens: 65536 } },
    ctx([SMALL, BIG]),
  );
  assert.equal(r.outcome.kind, 'ESCALATE');
  assert.equal(r.outcome.reason, 'LOCAL_MODEL_SWAP_REQUIRED');
  assert.equal(r.outcome.swap.residentModelId, SMALL.modelId);
  assert.deepEqual(r.outcome.swap.candidates.map((c) => c.modelId), [BIG.modelId]);
});

test('PROFILE serves the resident artifact when it satisfies the profile', async () => {
  serving = BIG;
  const r = await route(
    { mode: 'PROFILE', requirements: { minContextTokens: 65536 } },
    ctx([SMALL, BIG]),
  );
  assert.equal(r.outcome.kind, 'ROUTED');
  assert.equal(r.outcome.selected.modelId, BIG.modelId);
});

test('routing never proposes an unload', async () => {
  // The whole point of reporting rather than acting. There is no field, on any
  // outcome, that instructs anything to stop the resident model — a swap is an
  // operator action, and one caller's preference must not evict another's
  // working deployment.
  serving = SMALL;
  const r = await route(
    { mode: 'AUTO', requireQualified: false },
    ctx([SMALL, BIG], { estimatedPromptTokens: 20_000, requestedMaxTokens: 1000 }),
  );
  // Asserted on the *structure*, not on the prose. The detail text explains that
  // Bokahli does not unload the resident model, so a substring search over the
  // serialised outcome matches its own explanation — which measures the wording
  // rather than the behaviour, the exact mistake the injection scorer makes.
  assert.equal(r.outcome.kind, 'ESCALATE');
  assert.deepEqual(Object.keys(r.outcome.swap).sort(),
    ['candidates', 'residentModelId', 'residentUnmet']);
  for (const c of r.outcome.swap.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['coldLoadSeconds', 'digest', 'modelId', 'vramMiB']);
  }
  // Nothing on the outcome is an imperative: every field is a noun describing
  // state, and there is no action, command, or lifecycle field anywhere on it.
  for (const k of Object.keys(r.outcome)) {
    assert.equal(/^(action|command|do[A-Z]|perform|apply)/.test(k), false,
      `outcome field "${k}" reads as an instruction; routing reports, it does not act`);
  }
});
