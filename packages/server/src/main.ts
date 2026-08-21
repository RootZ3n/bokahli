import { createServer, type Server } from 'node:http';
import { ScanCapacity } from './velum-capacity.js';
import { ScanPool } from './scan-pool.js';
import { readFile } from 'node:fs/promises';
import { Catalog } from '@bokahli/catalog';
import type { TokenizerCanarySuite } from '@bokahli/contracts';
import {
  AdmissionQueue,
  findBackendPids,
  GpuMonitor,
  LlamaBackend,
  validateCanarySuite,
} from '@bokahli/runtime';
import { loadConfig, loadOrCreateToken } from './config.js';
import { resolveServedArtifact } from './served-artifact.js';
import { QualificationFactsProvider } from './facts.js';
import { QualificationGate } from './qualification.js';
import { createHandler, type AppDeps } from './http.js';
import { Telemetry } from './telemetry.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = new Telemetry(config.logPrompts);
  const startedAt = new Date().toISOString();

  telemetry.log('info', 'startup.begin', {
    version: '2.0.0-phase1',
    node: process.version,
    pid: process.pid,
    bind: config.bindAddresses.join(','),
    port: config.port,
    logPrompts: config.logPrompts,
  });

  const catalog = await Catalog.load(config.catalogPath);
  const artifacts = catalog.internalAll();
  telemetry.log('info', 'catalog.loaded', {
    path: config.catalogPath,
    artifacts: artifacts.length,
    // modelIds only. Artifact paths are internal and are not logged.
    modelIds: artifacts.map((a) => a.modelId).join(','),
    unqualified: artifacts.filter((a) => a.qualification.status !== 'QUALIFIED').length,
  });

  if (config.verifyDigestOnStart) {
    for (const a of artifacts) {
      const v = await catalog.verifyDigest(a.modelId);
      telemetry.log(v.match ? 'info' : 'error', 'catalog.digestVerified', {
        modelId: v.modelId,
        match: v.match,
        durationMs: v.durationMs,
        error: v.error,
      });
      if (!v.match) {
        throw new Error(
          `artifact ${v.modelId} failed digest verification; refusing to serve an ` +
            'artifact whose identity cannot be attested',
        );
      }
    }
  }

  const backendName = artifacts[0]?.backend ?? 'primary';
  const descriptor = catalog.backend(backendName);
  const runtimeKey = process.env['BOKAHLI_RUNTIME_API_KEY'] ?? null;
  if (!runtimeKey) {
    telemetry.log('warn', 'runtime.noApiKey', {
      note: 'BOKAHLI_RUNTIME_API_KEY is unset; the loopback backend is reachable ' +
        'without a key by any local process or browser page.',
    });
  }
  const backend = new LlamaBackend(descriptor.baseUrl, descriptor.pinnedBuild, runtimeKey);
  const queue = new AdmissionQueue({
    maxConcurrent: config.maxConcurrent,
    maxQueueDepth: config.maxQueueDepth,
    queueTimeoutMs: config.queueTimeoutMs,
  });
  const gpu = new GpuMonitor({
    foreignHolderThresholdMiB: config.gpuForeignHolderThresholdMiB,
  });

  // Learn our own backend pids, and keep a resolver so the lease monitor can
  // re-discover them if the backend restarts underneath us.
  const resolver = (): Promise<readonly number[]> => findBackendPids(descriptor.baseUrl);
  gpu.setOwnPidResolver(resolver);
  await adoptBackendPids(gpu, descriptor.baseUrl, telemetry);

  const token = await loadOrCreateToken(config.tokenPath);
  telemetry.log('info', 'auth.tokenReady', {
    source: process.env['BOKAHLI_TOKEN'] ? 'env' : config.tokenPath,
    length: token.length,
  });

  const live = await backend.live();
  // Resolved from the backend's reported alias, not catalog position: with
  // several artifacts installed, position attests whichever happens to be first.
  const servedAtBoot = await resolveServedArtifact(backend, catalog);
  const attestation = servedAtBoot.artifact ? await backend.attest(servedAtBoot.artifact) : null;
  telemetry.log(live ? 'info' : 'warn', 'runtime.probe', {
    baseUrl: descriptor.baseUrl,
    reachable: live,
    build: attestation?.build ?? null,
    attested: attestation?.attested ?? false,
    failures: attestation?.reasons.join('; ') ?? null,
    servedContextTokens: attestation?.servedContextTokens ?? null,
    totalSlots: attestation?.totalSlots ?? null,
  });

  // Qualification starts empty and denies everything. Phase 2A ships the
  // boundary, not a qualified model: no evidence has been imported, no policy
  // has been configured, and the honest answer to "is this qualified" is no.
  const qualification = QualificationGate.empty('llama.cpp', descriptor.pinnedBuild);
  telemetry.log('info', 'qualification.loaded', {
    authority: 'luak',
    evidenceBundles: qualification.store.size,
    hardwareProfileId: qualification.hardwareProfileId,
    policiesConfigured: qualification.configuredTaskClasses.join(',') || '(none)',
    note: 'No Luak evidence is imported and no policy is configured. Every ' +
      'qualification-required request escalates.',
  });

  // Provenance probes. The executable is normally located from the running
  // process's own argv; the env var is a fallback for a deployment where that
  // cannot be read, and is a path, so it never reaches a response.
  // Pinned tokenizer canaries, loaded and validated once.
  //
  // At startup rather than per request, and refused rather than tolerated: a
  // suite that does not parse, does not hash to its own contents, or names a
  // different artifact is an operator error, and letting it through would show
  // up months later as `encodeCanaryVerified: false` that reads like a
  // tokenizer problem. An artifact with *no* canary is a different thing
  // entirely — an artifact that was installed but never prepared — and starts
  // normally with its token counts unproven.
  const canaries = new Map<string, TokenizerCanarySuite>();
  for (const a of catalog.internalAll()) {
    if (a.tokenizerCanaryPath === null) {
      telemetry.log('warn', 'canary.absent', {
        modelId: a.modelId,
        note:
          'no tokenizer canary is pinned for this artifact, so its token counts will ' +
          'stay runtime_reported_unknown_tokenizer. Run scripts/generate-tokenizer-canary.mjs.',
      });
      continue;
    }
    let suite: TokenizerCanarySuite;
    try {
      suite = JSON.parse(await readFile(a.tokenizerCanaryPath, 'utf8')) as TokenizerCanarySuite;
    } catch (err) {
      throw new Error(
        `tokenizer canary for ${a.modelId} could not be read: ${(err as Error).name}`,
      );
    }
    const errs = validateCanarySuite(suite);
    if (errs.length > 0) {
      throw new Error(`tokenizer canary for ${a.modelId} is invalid: ${errs.join('; ')}`);
    }
    if (suite.artifactDigest !== a.digest) {
      throw new Error(
        `tokenizer canary for ${a.modelId} was generated for a different artifact ` +
          '(a canary is expectations about one set of bytes and is not portable)',
      );
    }
    canaries.set(a.digest, suite);
    telemetry.log('info', 'canary.loaded', {
      modelId: a.modelId,
      suiteId: suite.suiteId,
      suiteHash: suite.payloadHash,
      encodeCases: suite.encode.length,
      decodeCases: suite.decode.length,
      encodeReference: suite.encodeReference.method,
    });
  }

  const facts = new QualificationFactsProvider({
    backend,
    runtimeExecutablePathFallback: process.env['BOKAHLI_RUNTIME_EXECUTABLE'] ?? null,
    resolveBackendPids: resolver,
    // The token table, read once per artifact from the file whose digest was
    // verified. Held only long enough to run the probe.
    artifactTokens: async (a) => {
      try {
        const { readGgufTokenTable } = await import('@bokahli/runtime');
        return await readGgufTokenTable(a.artifactPath);
      } catch {
        return null;
      }
    },
    artifactTokenTypes: async (a) => {
      try {
        const { readGgufTokenTypes } = await import('@bokahli/runtime');
        return await readGgufTokenTypes(a.artifactPath);
      } catch {
        return null;
      }
    },
    canarySuite: (a) => canaries.get(a.digest) ?? null,
    // Two short generations, once per backend instance, proving that
    // `response_format` is actually applied on this process. llama-server
    // exposes no field that says so, and a runtime that silently dropped it
    // would credit a *model* with output a grammar produced — the same shape of
    // error as the placement bug, aimed at the thing being qualified. Failures
    // leave the claim unproven rather than false: a probe that could not run has
    // said nothing about the runtime.
    probeGenerate: async (alias, prompt, schema) => {
      try {
        return await backend.chatOnce(
          alias,
          {
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 48,
            temperature: 0,
            ...(schema === null
              ? {}
              : {
                responseFormat: {
                  type: 'json_schema',
                  json_schema: { name: 'bokahli_grammar_probe', strict: true, schema },
                },
              }),
          },
          20_000,
        );
      } catch {
        return null;
      }
    },
  });

  // Started before the server binds, so the first request meets a pool that has
  // already handshaken rather than one that is still deciding whether its
  // workers agree with it about the registry.
  const scanPool = new ScanPool({
    workers: config.velumWorkers,
    jobTimeoutMs: config.velumJobTimeoutMs,
  });

  const deps: AppDeps = {
    config, token, catalog, backend, qualification, queue, gpu, telemetry, facts, startedAt,
    // Per-request ceiling is the HTTP body limit: two numbers that could drift
    // apart would let one of them be the real limit and the other a comment.
    scanCapacity: new ScanCapacity(config.velumInFlightBytes, config.maxRequestBytes),
    scanPool,
  };
  const handler = createHandler(deps);
  const servers: Server[] = [];

  for (const address of config.bindAddresses) {
    const server = createServer(handler);
    server.headersTimeout = 30_000;
    server.requestTimeout = 0; // long generations must not be cut by the HTTP layer
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, address, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    servers.push(server);
    telemetry.log('info', 'listen.bound', { address, port: config.port });
  }

  telemetry.log('info', 'startup.ready', {
    listeners: servers.length,
    unauthenticatedRoutes: '/health/live',
  });

  const shutdown = (signal: string): void => {
    telemetry.log('info', 'shutdown.begin', { signal });
    let remaining = servers.length;
    for (const s of servers) {
      s.close(() => {
        if (--remaining === 0) {
          // Listeners are closed, so no new scan can be dispatched. In-flight
          // ones settle as a typed worker-lost escalation rather than hanging,
          // which is what lets the process exit instead of waiting on promises
          // nobody will resolve.
          void scanPool.close().then(() => {
            telemetry.log('info', 'shutdown.complete', { scanWorkers: 0 });
            process.exit(0);
          });
        }
      });
    }
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function adoptBackendPids(
  gpu: GpuMonitor,
  baseUrl: string,
  telemetry: Telemetry,
): Promise<void> {
  try {
    const port = new URL(baseUrl).port;
    const pids = await findBackendPids(baseUrl);
    gpu.setOwnPids(pids);
    if (pids.length === 0) {
      telemetry.log('warn', 'gpu.ownPidsNotFound', {
        port,
        note: 'no llama-server process matched this port; the backend may be ' +
          'counted as a foreign GPU lease holder until it is re-resolved',
      });
    } else {
      telemetry.log('info', 'gpu.ownPidsAdopted', { port, pids: pids.join(',') });
    }
  } catch (err) {
    telemetry.log('warn', 'gpu.ownPidsUnknown', { message: (err as Error).message });
  }
}

main().catch((err: Error) => {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      svc: 'bokahli',
      event: 'startup.failed',
      message: err.message,
    })}\n`,
  );
  process.exit(1);
});
