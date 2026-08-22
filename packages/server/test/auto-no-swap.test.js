/**
 * AUTO may not activate, evict, or swap a runtime.
 *
 * The Qwen3.8 campaign produced a second installed model that is genuinely useful and genuinely
 * worse to route to automatically: it matched the control's quality only under constrained
 * generation, at 2.4x the task latency and 4.5x the VRAM, and a swap to reach it costs an
 * unavailability window on a host that can hold exactly one model. Manual activation was made
 * possible in the same change. Nothing about that may leak into the inference path.
 *
 * These tests run the real router. They assert the negative directly: whatever an AUTO caller
 * asks for, and however specific they make it, the outcome is either the resident model or a
 * typed escalation — never an instruction to start something.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LlamaBackend } from '@bokahli/runtime';
import { QualificationStore } from '@bokahli/qualification';
import { QualificationGate } from '../dist/qualification.js';
import { unavailableFacts } from '../dist/facts.js';
import { route } from '../dist/router.js';
import {
  DIGEST_A, DIGEST_B, HARDWARE_PROFILE, MODEL_A, MODEL_B, NOW,
  QUANT, RUNTIME_BUILD, RUNTIME_NAME, completePolicy,
} from '../../qualification/test/fixtures.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function artifact(modelId, digest, path) {
  return {
    modelId, displayName: modelId, digest, artifactPath: path,
    tokenizerCanaryPath: null, runtimeAlias: modelId, backend: 'primary',
    facts: {
      format: 'gguf', architecture: 'qwen35', quantization: QUANT, sizeBytes: 1,
      parameterCount: 1, activeParameterCount: 1, expertCount: null, expertUsedCount: null,
      contextTrainTokens: 262144, vocabSize: 248320, embeddingLength: 5120,
    },
    capabilities: { chat: true, completion: true, tools: true, vision: false, audio: false, embedding: false, reasoningEffort: false },
    qualification: { status: 'INSTALLED_UNQUALIFIED', authority: 'none', evidenceRef: null, qualifiedTaskClasses: [], note: 'synthetic' },
    operational: { servedContextTokens: 32768, maxConcurrentRequests: 1, measuredAt: null },
  };
}

const RESIDENT = artifact(MODEL_A, DIGEST_A, '/models/resident.gguf');
const INSTALLED_NOT_LOADED = artifact(MODEL_B, DIGEST_B, '/models/other.gguf');

function catalogOf(...arts) {
  return {
    internal: (id) => arts.find((a) => a.modelId === id),
    internalAll: () => arts,
    publicEntries: () => arts.map((a) => ({ modelId: a.modelId, digest: a.digest })),
  };
}

function startBackend(serving) {
  const props = {
    build_info: RUNTIME_BUILD, model_path: serving.artifactPath, model_alias: serving.runtimeAlias,
    model_ftype: 'Q4_K - Medium', total_slots: 1, default_generation_settings: { n_ctx: 32768 },
  };
  const server = createServer((req, res) => {
    if (req.url === '/props') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(props));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      stop: () => new Promise((r) => server.close(r)),
    }));
  });
}

function ctx(port, catalog) {
  return {
    catalog,
    backend: new LlamaBackend(`http://127.0.0.1:${port}`, RUNTIME_BUILD, null, 2000),
    qualification: new QualificationGate({
      store: QualificationStore.empty(), runtimeName: RUNTIME_NAME, runtimeBuild: RUNTIME_BUILD,
      hardwareProfileId: HARDWARE_PROFILE, policies: { test_log_triage: completePolicy() }, now: () => NOW,
    }),
    queueDepth: 0,
    estimatedPromptTokens: 10,
    // The real facts shape. A thin stub reached servedIdentityOf() and threw on a missing
    // imageDigest, which is the router telling the truth about what it needs.
    qualificationFacts: async (a) => {
      const f = unavailableFacts(a);
      return {
        ...f,
        backendInstance: { ...f.backendInstance, instanceId: 'test-instance' },
        attestation: {
          ...f.attestation, completeness: 'partial', missing: ['stubbed'],
          backendInstanceId: 'test-instance',
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      };
    },
    requestedMaxTokens: 64,
  };
}

test('AUTO routes to the RESIDENT model when it satisfies the request', async () => {
  const be = await startBackend(RESIDENT);
  const { outcome } = await route(
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: false },
    ctx(be.port, catalogOf(RESIDENT, INSTALLED_NOT_LOADED)),
  );
  assert.equal(outcome.kind, 'ROUTED');
  assert.equal(outcome.selected.modelId, RESIDENT.modelId, 'AUTO must prefer what is already loaded');
  await be.stop();
});

test('an unloaded artifact is REFUSED, never activated', async () => {
  // The whole no-swap guarantee in one assertion: another artifact is catalogued, installed and
  // would satisfy the request, and naming it exactly still does not reach it. The router refuses
  // on attestation — the live runtime cannot be attested as serving it — which is a stronger
  // answer than escalating, because it is a statement about what IS rather than about what could
  // be arranged.
  const be = await startBackend(RESIDENT);
  const { outcome } = await route(
    { mode: 'EXACT', modelId: INSTALLED_NOT_LOADED.modelId, artifactDigest: INSTALLED_NOT_LOADED.digest,
      taskClass: 'test_log_triage', requireQualified: false },
    ctx(be.port, catalogOf(RESIDENT, INSTALLED_NOT_LOADED)),
  );
  assert.notEqual(outcome.kind, 'ROUTED', 'an unloaded artifact must never be ROUTED to');
  assert.equal(outcome.kind, 'REFUSED');
  assert.equal(outcome.reason, 'EXACT_NOT_ATTESTED');
  assert.match(outcome.detail, /not serving the catalogued artifact|alias mismatch/);
  await be.stop();
});

test('a refusal changes nothing about what is loaded', async () => {
  const be = await startBackend(RESIDENT);
  const c = () => ctx(be.port, catalogOf(RESIDENT, INSTALLED_NOT_LOADED));
  await route({ mode: 'EXACT', modelId: INSTALLED_NOT_LOADED.modelId,
                artifactDigest: INSTALLED_NOT_LOADED.digest, taskClass: 'test_log_triage' }, c());
  // The resident model is still the resident model: routing returned a decision, not an act.
  const after = await route({ mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: false }, c());
  assert.equal(after.outcome.kind, 'ROUTED');
  assert.equal(after.outcome.selected.modelId, RESIDENT.modelId,
    'the previous refusal must not have changed what is loaded');
  await be.stop();
});

test('no routing outcome carries an activation instruction a caller could execute', async () => {
  const be = await startBackend(RESIDENT);
  for (const req of [
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: false },
    { mode: 'AUTO', taskClass: 'test_log_triage', requireQualified: true },
    { mode: 'EXACT', modelId: INSTALLED_NOT_LOADED.modelId, artifactDigest: INSTALLED_NOT_LOADED.digest, taskClass: 'test_log_triage' },
  ]) {
    const { outcome } = await route(req, ctx(be.port, catalogOf(RESIDENT, INSTALLED_NOT_LOADED)));
    const blob = JSON.stringify(outcome);
    // A profile id or a unit name in a routing outcome would be the first step toward a caller —
    // or a helpful future patch — turning a refusal into an activation.
    assert.ok(!/systemctl|\.service\b|profileId|activate/i.test(blob),
      `routing outcome leaked an activation handle: ${blob.slice(0, 200)}`);
  }
  await be.stop();
});

test('the router source contains no activation path at all', () => {
  // Structural. The guarantee should not depend on every future outcome shape being audited.
  const src = readFileSync(REPO + 'packages/server/src/router.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const forbidden of [/systemctl/, /child_process/, /\bspawn\(/, /\bexec\(/, /activateProfile/]) {
    assert.ok(!forbidden.test(src), `router must not be able to start anything: matched ${forbidden}`);
  }
});

test('Qwen3.8 profiles exist but are not reachable from routing', () => {
  // Manual activation shipped in the same change as these profiles. The profiles file is data;
  // routing must have no import path to it.
  const profiles = JSON.parse(readFileSync(REPO + 'catalog/profiles.json', 'utf8'));
  assert.ok(profiles.profiles.length >= 2, 'the profiles this test is about should exist');
  const src = readFileSync(REPO + 'packages/server/src/router.ts', 'utf8');
  assert.ok(!/profiles\.json|parseProfile|profileEnv/.test(src),
    'the router must not read operational profiles');
});
