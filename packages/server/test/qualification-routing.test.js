/**
 * Qualification in the routing path.
 *
 * Phase 1 could only say "nothing is qualified" because the catalog said so.
 * These tests check the stronger property: that the answer comes from imported
 * evidence measured against an operator policy, that it is *no* whenever either
 * is missing, and that a caller cannot get to a qualified route by being more
 * specific — an EXACT request names an artifact, which is not the same as
 * earning one.
 *
 * The router runs for real against a real HTTP backend. Only the artifacts are
 * synthetic, and deliberately so: nothing here can accidentally qualify the
 * model actually installed on this machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LlamaBackend } from '@bokahli/runtime';
import { QualificationStore } from '@bokahli/qualification';
import { unavailableFacts } from '../dist/facts.js';
import { QualificationGate } from '../dist/qualification.js';
import { route } from '../dist/router.js';
import {
  DIGEST_A,
  DIGEST_B,
  HARDWARE_PROFILE,
  MODEL_A,
  MODEL_B,
  NOW,
  QUANT,
  RUNTIME_BUILD,
  RUNTIME_NAME,
  bundle,
  completePolicy,
  importContext,
  trustedImportContext,
} from '../../qualification/test/fixtures.js';

const PATH_A = '/models/testmodel-a.gguf';
const PATH_B = '/models/testmodel-b.gguf';

function artifact(modelId, digest, artifactPath) {
  return {
    modelId,
    displayName: modelId,
    digest,
    artifactPath,
    runtimeAlias: modelId,
    backend: 'primary',
    facts: {
      format: 'gguf',
      architecture: 'testarch',
      quantization: QUANT,
      sizeBytes: 1,
      parameterCount: 1,
      activeParameterCount: null,
      expertCount: null,
      expertUsedCount: null,
      contextTrainTokens: 65536,
      vocabSize: 1,
      embeddingLength: 1,
    },
    capabilities: {
      chat: true, completion: true, tools: false, vision: false,
      audio: false, embedding: false, reasoningEffort: false,
    },
    qualification: {
      status: 'INSTALLED_UNQUALIFIED',
      authority: 'none',
      evidenceRef: null,
      qualifiedTaskClasses: [],
      note: 'synthetic test artifact',
    },
    operational: { servedContextTokens: 32768, maxConcurrentRequests: 1, measuredAt: null },
  };
}

const ARTIFACT_A = artifact(MODEL_A, DIGEST_A, PATH_A);
const ARTIFACT_B = artifact(MODEL_B, DIGEST_B, PATH_B);

function catalogOf(...artifacts) {
  return {
    internal: (id) => artifacts.find((a) => a.modelId === id),
    internalAll: () => artifacts,
    publicEntries: () => artifacts.map((a) => ({ modelId: a.modelId, digest: a.digest })),
  };
}

/** A backend serving exactly one of the synthetic artifacts. */
function startBackend(serving) {
  const props = {
    build_info: RUNTIME_BUILD,
    model_path: serving.artifactPath,
    model_alias: serving.runtimeAlias,
    model_ftype: 'Q4_K - Medium',
    total_slots: 1,
    default_generation_settings: { n_ctx: 32768 },
  };
  const server = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(props));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      }),
    );
  });
}

/**
 * `trusted` defaults to true so a test that wants a qualification says so once.
 * The untrusted case gets its own test below rather than being the ambient
 * default nobody reads — "present but unauthorised" is its own outcome.
 */
function gateWith({ bundles = [], policies = {}, trusted = true } = {}) {
  const store = QualificationStore.empty();
  if (bundles.length > 0) {
    const report = store.load(bundles, trusted ? trustedImportContext(bundles) : importContext());
    assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected, null, 2));
  }
  return new QualificationGate({
    store,
    runtimeName: RUNTIME_NAME,
    runtimeBuild: RUNTIME_BUILD,
    hardwareProfileId: HARDWARE_PROFILE,
    policies,
    now: () => NOW,
  });
}

function ctx(port, gate, catalog) {
  return {
    catalog,
    backend: new LlamaBackend(`http://127.0.0.1:${port}`, RUNTIME_BUILD, null, 2000),
    qualification: gate,
    queueDepth: 0,
    estimatedPromptTokens: 10,
    // Provenance facts have their own suite; routing only needs them present.
    qualificationFacts: async (a) => unavailableFacts(a),
    requestedMaxTokens: 64,
  };
}

const LOOSE_POLICY = { test_log_triage: completePolicy() };
const EXACT_A = { mode: 'EXACT', modelId: MODEL_A, artifactDigest: DIGEST_A };

// ---------------------------------------------------------------------------
// the deployed default: nothing is qualified
// ---------------------------------------------------------------------------

test('AUTO with requireQualified escalates when no evidence exists', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  assert.ok(outcome.unmet.some((u) => u.actual === 'NO_EVIDENCE_FOR_KEY'));
  await be.stop();
});

test('AUTO with requireQualified escalates when evidence exists but no policy does', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gateWith({ bundles: [bundle()] }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  assert.ok(outcome.unmet.some((u) => u.actual === 'NO_POLICY_CONFIGURED'));
  await be.stop();
});

test('requiring qualification without naming a task class is answered, not defaulted', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO', requireQualified: true },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  // No task class was named, so the broader reason is the accurate one.
  assert.equal(outcome.reason, 'NO_QUALIFIED_LOCAL_ROUTE');
  assert.match(outcome.unmet[0].actual, /MODEL_NOT_QUALIFIED_FOR_TASK/);
  await be.stop();
});

test('an unknown task class cannot be qualified for', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'vibes_assessment', requireQualified: true },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  await be.stop();
});

test('AUTO without requireQualified still routes, and still says it is unqualified', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage' },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ROUTED');
  assert.equal(outcome.qualification.qualified, false);
  assert.equal(outcome.selected.qualification.status, 'INSTALLED_UNQUALIFIED');
  await be.stop();
});

// ---------------------------------------------------------------------------
// EXACT does not confer fitness
// ---------------------------------------------------------------------------

test('EXACT routes an unqualified artifact when qualification was not required', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(EXACT_A, ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)));
  assert.equal(outcome.kind, 'ROUTED');
  await be.stop();
});

test('EXACT plus requireQualified escalates rather than serving', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { ...EXACT_A, taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  assert.match(outcome.detail, /EXACT selects an artifact; it does not confer fitness/);
  await be.stop();
});

test('EXACT with qualification required and satisfied routes', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { ...EXACT_A, taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gateWith({ bundles: [bundle()], policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ROUTED', JSON.stringify(outcome.unmet ?? outcome.detail));
  assert.equal(outcome.qualification.qualified, true);
  assert.equal(outcome.qualification.authority, 'luak');
  await be.stop();
});

test('a wrong digest is still refused before qualification is even consulted', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'EXACT', modelId: MODEL_A, artifactDigest: DIGEST_B, taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gateWith({ bundles: [bundle()], policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.reason, 'EXACT_DIGEST_MISMATCH');
  await be.stop();
});

// ---------------------------------------------------------------------------
// PROFILE
// ---------------------------------------------------------------------------

test('PROFILE rejects a profile that evidence does not support', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'PROFILE', requirements: { requireQualified: true, requiredTaskClass: 'test_log_triage' } },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  assert.match(outcome.detail, /refused, not approximated/);
  await be.stop();
});

test('PROFILE accepts a profile the evidence does support', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'PROFILE', requirements: { requireQualified: true, requiredTaskClass: 'test_log_triage' } },
    ctx(be.port, gateWith({ bundles: [bundle()], policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ROUTED');
  assert.equal(outcome.qualification.reason, 'QUALIFIED');
  await be.stop();
});

test('PROFILE reports the specific shortfall, not a generic refusal', async () => {
  const be = await startBackend(ARTIFACT_A);
  const strict = { test_log_triage: completePolicy({ minSampleCount: 500 }) };
  const { outcome } = await route(
    { mode: 'PROFILE', requirements: { requireQualified: true, requiredTaskClass: 'test_log_triage' } },
    ctx(be.port, gateWith({ bundles: [bundle()], policies: strict }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  const shortfall = outcome.unmet.find((u) => u.requirement === 'evidence.sampleCount');
  assert.deepEqual(shortfall, { requirement: 'evidence.sampleCount', required: '>= 500', actual: '4' });
  await be.stop();
});

test('a non-qualification profile constraint is unaffected by the gate', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'PROFILE', requirements: { minContextTokens: 1_000_000 } },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.notEqual(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  await be.stop();
});

// ---------------------------------------------------------------------------
// deterministic ranking
// ---------------------------------------------------------------------------

test('the chosen artifact does not depend on catalog order', async () => {
  const be = await startBackend(ARTIFACT_A);
  const gate = gateWith({ policies: LOOSE_POLICY });

  const forward = await route({ mode: 'AUTO' }, ctx(be.port, gate, catalogOf(ARTIFACT_A, ARTIFACT_B)));
  const reverse = await route({ mode: 'AUTO' }, ctx(be.port, gate, catalogOf(ARTIFACT_B, ARTIFACT_A)));

  assert.equal(forward.outcome.kind, 'ROUTED');
  assert.equal(reverse.outcome.kind, 'ROUTED');
  assert.equal(forward.outcome.selected.modelId, reverse.outcome.selected.modelId);
  await be.stop();
});

test('with nothing qualified, the rationale admits the order means nothing', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO' },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A, ARTIFACT_B)),
  );
  assert.match(outcome.rationale, /asserts nothing about fitness/);
  const chosen = outcome.considered.find((c) => c.modelId === outcome.selected.modelId);
  assert.equal(chosen.rankBasis, 'IDENTITY_TIEBREAK');
  await be.stop();
});

test('evidence, not identity order, decides when evidence exists', async () => {
  // B sorts after A alphabetically, and wins anyway because it is the one the
  // evidence qualifies. If identity order could beat evidence, this would fail.
  const be = await startBackend(ARTIFACT_B);
  const evidenceForB = bundle({ key: { modelId: MODEL_B, artifactDigest: DIGEST_B } });
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    ctx(
      be.port,
      gateWith({ bundles: [evidenceForB], policies: LOOSE_POLICY }),
      catalogOf(ARTIFACT_A, ARTIFACT_B),
    ),
  );
  assert.equal(outcome.kind, 'ROUTED');
  assert.equal(outcome.selected.modelId, MODEL_B);
  const chosen = outcome.considered.find((c) => c.modelId === MODEL_B);
  assert.equal(chosen.rankBasis, 'QUALIFICATION');
  await be.stop();
});

test('routing reads no meaning from a model name', async () => {
  // The same catalog under two identities that differ only in name: the
  // decision must be structurally identical, and must not prefer a familiar
  // family, vendor, or size string.
  const be = await startBackend(ARTIFACT_A);
  const gate = gateWith({ policies: LOOSE_POLICY });
  const renamed = { ...ARTIFACT_A, modelId: 'zzz-unfamiliar.q4-k', runtimeAlias: 'zzz-unfamiliar.q4-k' };
  const beRenamed = await startBackend(renamed);

  const a = await route({ mode: 'AUTO' }, ctx(be.port, gate, catalogOf(ARTIFACT_A)));
  const b = await route({ mode: 'AUTO' }, ctx(beRenamed.port, gate, catalogOf(renamed)));

  assert.equal(a.outcome.kind, b.outcome.kind);
  assert.equal(
    a.outcome.considered[0].qualificationDecision.reason,
    b.outcome.considered[0].qualificationDecision.reason,
  );
  await be.stop();
  await beRenamed.stop();
});

// ---------------------------------------------------------------------------
// the declared status never confers fitness
// ---------------------------------------------------------------------------

test('a catalog that declares itself QUALIFIED does not become qualified', async () => {
  // The catalog is operator-editable. If editing it were enough to pass a
  // qualification gate, the gate would be decorative.
  const lying = {
    ...ARTIFACT_A,
    qualification: {
      status: 'QUALIFIED',
      authority: 'luak',
      evidenceRef: 'trust-me',
      qualifiedTaskClasses: ['test_log_triage'],
      note: 'a catalog edit, not evidence',
    },
  };
  const be = await startBackend(lying);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gateWith({ policies: LOOSE_POLICY }), catalogOf(lying)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  await be.stop();
});

test('the assessment reports declared status and evidence decision separately', async () => {
  const be = await startBackend(ARTIFACT_A);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage' },
    ctx(be.port, gateWith({ bundles: [bundle()], policies: LOOSE_POLICY }), catalogOf(ARTIFACT_A)),
  );
  const assessment = outcome.considered[0];
  assert.equal(assessment.qualification.status, 'INSTALLED_UNQUALIFIED', 'the catalog still says unqualified');
  assert.equal(assessment.qualificationDecision.qualified, true, 'the evidence says qualified');
  // Both are reported. Nothing silently reconciles them.
  await be.stop();
});

// ---------------------------------------------------------------------------
// the empty gate
// ---------------------------------------------------------------------------

test('the default gate a deployment starts with qualifies nothing', async () => {
  const be = await startBackend(ARTIFACT_A);
  const empty = QualificationGate.empty(RUNTIME_NAME, RUNTIME_BUILD);
  assert.equal(empty.store.size, 0);
  assert.equal(empty.hardwareProfileId, 'unset');
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, empty, catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.equal(outcome.reason, 'MODEL_NOT_QUALIFIED_FOR_TASK');
  await be.stop();
});

test('an unset hardware profile matches no evidence, even correct evidence', async () => {
  const be = await startBackend(ARTIFACT_A);
  const store = QualificationStore.empty();
  store.load([bundle()], importContext());
  const gate = new QualificationGate({
    store,
    runtimeName: RUNTIME_NAME,
    runtimeBuild: RUNTIME_BUILD,
    hardwareProfileId: 'unset',
    policies: LOOSE_POLICY,
    now: () => NOW,
  });
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    ctx(be.port, gate, catalogOf(ARTIFACT_A)),
  );
  assert.equal(outcome.kind, 'ESCALATE');
  assert.ok(outcome.unmet.some((u) => u.actual === 'NO_EVIDENCE_FOR_KEY'));
  await be.stop();
});
