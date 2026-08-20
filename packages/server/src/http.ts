import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Catalog } from '@bokahli/catalog';
import { AdmissionQueue, BackendUnavailableError, GpuMonitor, LlamaBackend } from '@bokahli/runtime';
import {
  bokahliError,
  ERROR_STATUS,
  isPathLike,
  type BokahliChatMessage,
  type BokahliRequest,
  type BokahliResponse,
  type CapacityUnavailable,
  type Escalation,
  type GpuSnapshot,
  type ProfileRequirements,
  type RequestTelemetry,
  type RouteOutcome,
  type RouteSpec,
  type ServedIdentity,
} from '@bokahli/contracts';
import { authenticate, AUTH_COOKIE } from './auth.js';
import type { BokahliConfig } from './config.js';
import type { QualificationGate } from './qualification.js';
import { route, type RouteContext } from './router.js';
import { estimateTokens, Telemetry } from './telemetry.js';

export interface AppDeps {
  readonly config: BokahliConfig;
  readonly token: string;
  readonly catalog: Catalog;
  readonly backend: LlamaBackend;
  readonly qualification: QualificationGate;
  readonly queue: AdmissionQueue;
  readonly gpu: GpuMonitor;
  readonly telemetry: Telemetry;
  readonly startedAt: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createHandler(deps: AppDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    res.setHeader('x-bokahli-request-id', requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    try {
      // The single unauthenticated route. Reveals liveness and nothing else:
      // no model identity, no build, no paths, no capacity.
      if (path === '/health/live') {
        return json(res, 200, { status: 'live', service: 'bokahli', requestId });
      }

      const auth = authenticate(req, deps.token, url);
      if (!auth.ok) {
        deps.telemetry.recordAuthFailure(path, remoteOf(req));
        res.setHeader('www-authenticate', 'Bearer realm="bokahli"');
        return json(res, 401, bokahliError('UNAUTHORIZED', 'authentication required', requestId));
      }

      // Browser bootstrap: a valid ?token= is exchanged for an HttpOnly cookie
      // and the token is removed from the URL by redirect.
      if (auth.source === 'query') {
        res.setHeader(
          'set-cookie',
          `${AUTH_COOKIE}=${encodeURIComponent(deps.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
        );
        url.searchParams.delete('token');
        res.writeHead(302, { location: `${url.pathname}${url.search}` });
        return void res.end();
      }

      if (path === '/health/ready') return await handleReady(deps, res, requestId);
      if (path === '/v1/models') return await handleModels(deps, res, requestId);
      if (path === '/v1/catalog') return handleCatalog(deps, res, requestId);
      if (path === '/v1/telemetry') return handleTelemetry(deps, res, requestId);
      if (path === '/v1/chat/completions') return await handleChat(deps, req, res, requestId, 'openai');
      if (path === '/v1/bokahli/chat') return await handleChat(deps, req, res, requestId, 'native');
      if (req.method === 'GET') return await serveStatic(deps, path, res, requestId);

      return json(res, 404, bokahliError('NOT_FOUND', 'no such route', requestId));
    } catch (err) {
      deps.telemetry.log('error', 'request.unhandled', {
        requestId,
        path,
        message: (err as Error).message,
      });
      if (!res.headersSent) {
        return json(res, 500, bokahliError('INTERNAL', 'internal error', requestId));
      }
      res.end();
    }
  };
}

// ---------------------------------------------------------------------------
// health / inventory / telemetry
// ---------------------------------------------------------------------------

async function handleReady(deps: AppDeps, res: ServerResponse, requestId: string): Promise<void> {
  const [live, gpuState] = await Promise.all([deps.backend.live(), deps.gpu.read()]);
  const artifacts = deps.catalog.internalAll();
  const first = artifacts[0];
  const attestation = first ? await deps.backend.attest(first) : null;
  const slots = live ? await deps.backend.slots() : [];

  const ready = live && attestation?.attested === true && gpuState.leaseAvailable;
  // Three distinguishable runtime states, because they call for different
  // operator actions: absent (restart it), present-but-wrong (investigate what
  // it is serving), healthy.
  const runtimeHealth = !live || attestation?.reachable === false
    ? 'unavailable'
    : attestation?.attested === true
      ? 'healthy'
      : 'unattested';
  return json(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'not-ready',
    requestId,
    startedAt: deps.startedAt,
    runtime: {
      health: runtimeHealth,
      reachable: live,
      build: attestation?.build ?? null,
      pinnedBuildMatches: attestation ? attestation.reasons.length === 0 : false,
      attested: attestation?.attested ?? false,
      attestationFailures: attestation?.reasons ?? [],
      servedContextTokens: attestation?.servedContextTokens ?? null,
      totalSlots: attestation?.totalSlots ?? null,
      busySlots: slots.filter((s) => s.is_processing).length,
    },
    capacity: { ...deps.queue.stats() },
    gpuLease: {
      available: gpuState.leaseAvailable,
      foreignHolders: gpuState.foreignHolders,
      thresholdMiB: deps.config.gpuForeignHolderThresholdMiB,
      snapshot: gpuState.snapshot,
      error: gpuState.error,
    },
    qualification: {
      authority: 'luak',
      integrated: false,
      contract: 'placeholder',
      note: 'No Luak evidence is installed. Every artifact is INSTALLED_UNQUALIFIED.',
    },
  });
}

async function handleModels(deps: AppDeps, res: ServerResponse, requestId: string): Promise<void> {
  const entries = deps.catalog.publicEntries();
  const attestations = await Promise.all(
    deps.catalog.internalAll().map((a) => deps.backend.attest(a)),
  );
  return json(res, 200, {
    object: 'list',
    requestId,
    data: entries.map((e, i) => ({
      // OpenAI-compatible surface. `id` is the stable Bokahli identity.
      // It is never a filesystem path.
      id: e.modelId,
      object: 'model',
      created: 0,
      owned_by: 'bokahli',
      bokahli: {
        digest: e.digest,
        displayName: e.displayName,
        architecture: e.facts.architecture,
        quantization: e.facts.quantization,
        servedContextTokens: attestations[i]?.servedContextTokens ?? e.operational.servedContextTokens,
        contextTrainTokens: e.facts.contextTrainTokens,
        capabilities: e.capabilities,
        qualification: e.qualification,
        attested: attestations[i]?.attested ?? false,
      },
    })),
  });
}

function handleCatalog(deps: AppDeps, res: ServerResponse, requestId: string): void {
  json(res, 200, {
    requestId,
    catalog: deps.catalog.publicEntries(),
    luak: {
      contractVersion: deps.catalog.luakEvidence.contractVersion,
      source: deps.catalog.luakEvidence.source,
      recordCount: deps.catalog.luakEvidence.records.length,
      note: 'Placeholder import contract only. No Luak integration in Phase 1.',
    },
  });
}

function handleTelemetry(deps: AppDeps, res: ServerResponse, requestId: string): void {
  json(res, 200, {
    requestId,
    summary: deps.telemetry.summary(),
    queue: deps.queue.stats(),
    recent: deps.telemetry.recent(25),
  });
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

type Dialect = 'openai' | 'native';

async function handleChat(
  deps: AppDeps,
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  dialect: Dialect,
): Promise<void> {
  if (req.method !== 'POST') {
    return json(res, 405, bokahliError('METHOD_NOT_ALLOWED', 'POST required', requestId));
  }
  const receivedAt = new Date().toISOString();
  const t0 = Date.now();

  let body: Record<string, unknown>;
  try {
    body = await readJson(req, deps.config.maxRequestBytes);
  } catch (err) {
    const msg = (err as Error).message;
    const code = msg === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST';
    return json(res, ERROR_STATUS[code], bokahliError(code, msg, requestId));
  }
  deps.telemetry.logPromptBody(requestId, body);

  const parsed = parseChatRequest(body, dialect, deps);
  if ('error' in parsed) {
    return json(res, 400, bokahliError('BAD_REQUEST', parsed.error, requestId));
  }
  const { spec, messages, maxTokens, temperature, topP, stream, pinnedModelId } = parsed;

  const promptText = messages.map((m) => m.content).join('\n');
  const estimated = estimateTokens(promptText);

  // GPU lease check precedes routing: a correct route that cannot execute is a
  // capacity outcome, not an escalation.
  const gpuState = await deps.gpu.read();
  if (!gpuState.leaseAvailable) {
    const holder = gpuState.foreignHolders[0] ?? null;
    const cap: CapacityUnavailable = {
      kind: 'CAPACITY_UNAVAILABLE',
      mode: spec.mode,
      reason: 'GPU_LEASE_HELD_BY_OTHER',
      detail:
        `another process holds the GPU lease (${holder?.processName ?? 'unknown'}, ` +
        `${holder?.usedMiB ?? 0} MiB). Bokahli and other GPU consumers are treated as ` +
        'mutually exclusive lease holders; Bokahli will not contend for VRAM.',
      queueDepth: deps.queue.depth,
      retryAfterSeconds: 30,
      leaseHolder: holder,
    };
    return finishNonRouted(deps, res, requestId, receivedAt, t0, spec, cap, 0, gpuState.snapshot, dialect);
  }

  const admission = await deps.queue.acquire();
  if (!admission.admitted) {
    const cap: CapacityUnavailable = {
      kind: 'CAPACITY_UNAVAILABLE',
      mode: spec.mode,
      reason: admission.reason,
      detail:
        admission.reason === 'QUEUE_FULL'
          ? `queue is full at depth ${admission.depth}. Phase 1 serves one active request.`
          : `queued request exceeded ${deps.config.queueTimeoutMs} ms without admission.`,
      queueDepth: admission.depth,
      retryAfterSeconds: 15,
      leaseHolder: null,
    };
    return finishNonRouted(deps, res, requestId, receivedAt, t0, spec, cap, 0, gpuState.snapshot, dialect);
  }

  try {
    const ctx: RouteContext = {
      catalog: deps.catalog,
      backend: deps.backend,
      qualification: deps.qualification,
      queueDepth: deps.queue.depth,
      estimatedPromptTokens: estimated,
      requestedMaxTokens: maxTokens,
    };
    const decision = await route(spec, ctx);
    let outcome: RouteOutcome = decision.outcome;

    // Pin enforcement for the OpenAI dialect: `model` names an identity but
    // carries no digest, so it cannot express EXACT. Bokahli honours it as a
    // hard pin and refuses rather than substituting.
    if (outcome.kind === 'ROUTED' && pinnedModelId && outcome.selected.modelId !== pinnedModelId) {
      outcome = {
        kind: 'REFUSED',
        mode: spec.mode,
        reason: 'EXACT_IDENTITY_UNKNOWN',
        detail:
          `request pinned model "${pinnedModelId}" but routing selected ` +
          `"${outcome.selected.modelId}". Refusing to substitute.`,
        requested: { modelId: pinnedModelId },
        available: deps.catalog.publicEntries().map((e) => ({ modelId: e.modelId, digest: e.digest })),
      };
    }

    if (outcome.kind !== 'ROUTED' || !decision.artifact) {
      return finishNonRouted(
        deps, res, requestId, receivedAt, t0, spec, outcome,
        decision.routeMs, gpuState.snapshot, dialect,
      );
    }

    const artifact = decision.artifact;
    const served: ServedIdentity = outcome.selected;
    const ac = new AbortController();
    // Abort the upstream generation only on a genuine client disconnect.
    //
    // NOT req.on('close'): for a request whose body we have already fully
    // consumed, Node closes the request stream as a normal part of its
    // lifecycle, so that listener fires on healthy requests too and cancels
    // the backend fetch mid-generation. The response is the honest signal —
    // if it closed without finishing, the client really did go away.
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });

    if (stream) {
      await streamChat(deps, res, {
        requestId, receivedAt, t0, admission, spec, outcome, served, artifact,
        messages, maxTokens, temperature, topP, routeMs: decision.routeMs,
        gpu: gpuState.snapshot, dialect, signal: ac.signal,
      });
    } else {
      await bufferChat(deps, res, {
        requestId, receivedAt, t0, admission, spec, outcome, served, artifact,
        messages, maxTokens, temperature, topP, routeMs: decision.routeMs,
        gpu: gpuState.snapshot, dialect, signal: ac.signal,
      });
    }
  } finally {
    admission.release();
  }
}

interface ExecArgs {
  requestId: string;
  receivedAt: string;
  t0: number;
  admission: { waitMs: number; depthAtAdmission: number };
  spec: RouteSpec;
  outcome: RouteOutcome;
  served: ServedIdentity;
  artifact: { runtimeAlias: string };
  messages: readonly BokahliChatMessage[];
  maxTokens: number;
  temperature: number | undefined;
  topP: number | undefined;
  routeMs: number;
  gpu: GpuSnapshot | null;
  dialect: Dialect;
  signal: AbortSignal;
}

async function streamChat(deps: AppDeps, res: ServerResponse, a: ExecArgs): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-bokahli-request-id': a.requestId,
    'x-bokahli-model-id': a.served.modelId,
    'x-bokahli-attested': String(a.served.attested),
  });

  // Identity is emitted before the first token so a client can reject a stream
  // it does not want before consuming any of it.
  sse(res, 'bokahli.identity', {
    requestId: a.requestId,
    route: a.outcome,
    servedIdentity: a.served,
  });

  let firstTokenAt: number | null = null;
  let text = '';
  let finishReason = 'stop';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let promptTps: number | null = null;
  let completionTps: number | null = null;

  try {
    for await (const ev of deps.backend.chatStream(
      a.artifact.runtimeAlias,
      { messages: a.messages, maxTokens: a.maxTokens, temperature: a.temperature, topP: a.topP },
      a.signal,
    )) {
      if (ev.type === 'delta') {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        text += ev.text;
        if (a.dialect === 'openai') {
          sseRaw(res, {
            id: a.requestId,
            object: 'chat.completion.chunk',
            model: a.served.modelId,
            choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
          });
        } else {
          sse(res, 'bokahli.delta', { text: ev.text });
        }
      } else {
        finishReason = ev.finishReason ?? 'stop';
        promptTokens = ev.usage?.prompt_tokens ?? ev.timings?.prompt_n ?? null;
        completionTokens = ev.usage?.completion_tokens ?? ev.timings?.predicted_n ?? null;
        promptTps = ev.timings?.prompt_per_second ?? null;
        completionTps = ev.timings?.predicted_per_second ?? null;
      }
    }
  } catch (err) {
    if (a.signal.aborted) {
      res.end();
      return;
    }
    // Headers are already on the wire, so the terminal signal has to travel in
    // the stream. It carries the same typed escalation a buffered caller would
    // have received, and explicitly marks the partial text as not a completion.
    const escalation = runtimeUnhealthyEscalation(a.spec.mode, err as Error);
    deps.telemetry.log('warn', 'runtime.lostDuringExecution', {
      requestId: a.requestId,
      modelId: a.served.modelId,
      partialChars: text.length,
      message: (err as Error).message,
    });
    const telemetry = buildTelemetry(a, {
      firstTokenAt, promptTokens, completionTokens, promptTps, completionTps,
    });
    if (a.dialect === 'openai') {
      sseRaw(res, {
        id: a.requestId,
        object: 'chat.completion.chunk',
        model: a.served.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'runtime_unhealthy' }],
        bokahli: { outcome: 'ESCALATE', route: escalation, telemetry },
      });
      res.write('data: [DONE]\n\n');
    } else {
      sse(res, 'bokahli.done', {
        requestId: a.requestId,
        outcome: 'ESCALATE',
        route: escalation,
        result: null,
        partialTextDiscarded: text.length > 0,
        telemetry,
      });
    }
    res.end();
    deps.telemetry.record(telemetry, 'ESCALATE');
    return;
  }

  const telemetry = buildTelemetry(a, {
    firstTokenAt, promptTokens, completionTokens, promptTps, completionTps,
  });

  if (a.dialect === 'openai') {
    sseRaw(res, {
      id: a.requestId,
      object: 'chat.completion.chunk',
      model: a.served.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      bokahli: { servedIdentity: a.served, telemetry },
    });
    res.write('data: [DONE]\n\n');
  } else {
    sse(res, 'bokahli.done', {
      requestId: a.requestId,
      outcome: 'ROUTED',
      result: { content: text, finishReason, servedIdentity: a.served },
      telemetry,
    });
  }
  res.end();
  deps.telemetry.record(telemetry, 'ROUTED');
}

async function bufferChat(deps: AppDeps, res: ServerResponse, a: ExecArgs): Promise<void> {
  let firstTokenAt: number | null = null;
  let text = '';
  let finishReason = 'stop';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let promptTps: number | null = null;
  let completionTps: number | null = null;

  try {
    for await (const ev of deps.backend.chatStream(
      a.artifact.runtimeAlias,
      { messages: a.messages, maxTokens: a.maxTokens, temperature: a.temperature, topP: a.topP },
      a.signal,
    )) {
      if (ev.type === 'delta') {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        text += ev.text;
      } else {
        finishReason = ev.finishReason ?? 'stop';
        promptTokens = ev.usage?.prompt_tokens ?? ev.timings?.prompt_n ?? null;
        completionTokens = ev.usage?.completion_tokens ?? ev.timings?.predicted_n ?? null;
        promptTps = ev.timings?.prompt_per_second ?? null;
        completionTps = ev.timings?.predicted_per_second ?? null;
      }
    }
  } catch (err) {
    if (a.signal.aborted) throw err; // the client left; nothing to report to
    // The runtime died between attestation and completion. Whatever partial
    // text arrived is discarded rather than returned: a truncated answer with
    // no terminal event from an attested runtime is exactly the "plausible
    // model output" this path must never emit.
    deps.telemetry.log('warn', 'runtime.lostDuringExecution', {
      requestId: a.requestId,
      modelId: a.served.modelId,
      partialChars: text.length,
      message: (err as Error).message,
    });
    return finishNonRouted(
      deps, res, a.requestId, a.receivedAt, a.t0, a.spec,
      runtimeUnhealthyEscalation(a.spec.mode, err as Error),
      a.routeMs, a.gpu, a.dialect,
    );
  }

  const telemetry = buildTelemetry(a, {
    firstTokenAt, promptTokens, completionTokens, promptTps, completionTps,
  });
  deps.telemetry.record(telemetry, 'ROUTED');

  if (a.dialect === 'openai') {
    return json(res, 200, {
      id: a.requestId,
      object: 'chat.completion',
      model: a.served.modelId,
      choices: [
        { index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      },
      bokahli: { servedIdentity: a.served, route: a.outcome, telemetry },
    });
  }

  const payload: BokahliResponse = {
    requestId: a.requestId,
    outcome: 'ROUTED',
    requested: a.spec,
    route: a.outcome,
    result: { content: text, finishReason, servedIdentity: a.served },
    telemetry,
  };
  return json(res, 200, payload);
}

function buildTelemetry(
  a: ExecArgs,
  m: {
    firstTokenAt: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    promptTps: number | null;
    completionTps: number | null;
  },
): RequestTelemetry {
  const served = a.served.servedContextTokens;
  const used = (m.promptTokens ?? 0) + (m.completionTokens ?? 0);
  return {
    requestId: a.requestId,
    receivedAt: a.receivedAt,
    completedAt: new Date().toISOString(),
    queueWaitMs: a.admission.waitMs,
    queueDepthAtAdmission: a.admission.depthAtAdmission,
    routeMs: a.routeMs,
    timeToFirstTokenMs: m.firstTokenAt ? m.firstTokenAt - a.t0 : null,
    totalMs: Date.now() - a.t0,
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    promptTokensPerSecond: m.promptTps,
    completionTokensPerSecond: m.completionTps,
    servedContextTokens: served,
    contextUtilisation: served > 0 ? used / served : null,
    runtimeBuild: a.served.runtime.build,
    gpu: a.gpu,
  };
}

/**
 * Mid-execution loss of the runtime, expressed in the same contract the router
 * uses when the runtime is already gone at routing time. A caller cannot tell —
 * and should not have to tell — which side of that line their request fell on.
 */
function runtimeUnhealthyEscalation(mode: RouteSpec['mode'], err: Error): Escalation {
  const cause =
    err instanceof BackendUnavailableError ? err.message : `inference stream failed: ${err.message}`;
  return {
    kind: 'ESCALATE',
    mode,
    reason: 'RUNTIME_UNHEALTHY',
    detail:
      'the local inference runtime stopped answering while this request was ' +
      `executing, so no attested completion exists: ${cause}. Any partial output ` +
      'was discarded rather than returned as an answer.',
    unmet: [{ requirement: 'runtime.reachable', required: 'true', actual: 'false' }],
    considered: [],
    authorityNote:
      'Bokahli emits a typed escalation and stops. Bokahli holds no cloud-routing ' +
      'authority; where this request goes next is the calling system\u2019s decision.',
    retryableLocal: true,
  };
}

function finishNonRouted(
  deps: AppDeps,
  res: ServerResponse,
  requestId: string,
  receivedAt: string,
  t0: number,
  spec: RouteSpec,
  outcome: RouteOutcome,
  routeMs: number,
  gpu: GpuSnapshot | null,
  dialect: Dialect,
): void {
  const telemetry: RequestTelemetry = {
    requestId,
    receivedAt,
    completedAt: new Date().toISOString(),
    queueWaitMs: 0,
    queueDepthAtAdmission: deps.queue.depth,
    routeMs,
    timeToFirstTokenMs: null,
    totalMs: Date.now() - t0,
    promptTokens: null,
    completionTokens: null,
    promptTokensPerSecond: null,
    completionTokensPerSecond: null,
    servedContextTokens: null,
    contextUtilisation: null,
    runtimeBuild: null,
    gpu,
  };
  const kind = outcome.kind;
  deps.telemetry.record(telemetry, kind);

  const payload: BokahliResponse = {
    requestId,
    outcome: kind,
    requested: spec,
    route: outcome,
    result: null,
    telemetry,
  };
  // Every non-routed outcome is a first-class typed result, not an error:
  // 200 for ESCALATE (the caller must act on it), 409 for REFUSED,
  // 503 for capacity. The OpenAI dialect gets the same body.
  const status =
    kind === 'ESCALATE' ? 200 : kind === 'REFUSED' ? 409 : 503;
  if (kind === 'CAPACITY_UNAVAILABLE') {
    const c = outcome as CapacityUnavailable;
    if (c.retryAfterSeconds) res.setHeader('retry-after', String(c.retryAfterSeconds));
  }
  res.setHeader('x-bokahli-outcome', kind);
  void dialect;
  json(res, status, payload);
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

interface ParsedChat {
  spec: RouteSpec;
  messages: readonly BokahliChatMessage[];
  maxTokens: number;
  temperature: number | undefined;
  topP: number | undefined;
  stream: boolean;
  pinnedModelId: string | null;
}

function parseChatRequest(
  body: Record<string, unknown>,
  dialect: Dialect,
  deps: AppDeps,
): ParsedChat | { error: string } {
  const rawMessages = body['messages'];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }
  const messages: BokahliChatMessage[] = [];
  for (const m of rawMessages as Record<string, unknown>[]) {
    const role = m['role'];
    const content = m['content'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return { error: `unsupported message role: ${String(role)}` };
    }
    if (typeof content !== 'string') {
      return { error: 'message content must be a string in Phase 1' };
    }
    messages.push({ role, content });
  }

  const maxTokens = clampInt(body['max_tokens'] ?? body['maxTokens'], 512, 1, 32768);
  const temperature = optNumber(body['temperature']);
  const topP = optNumber(body['top_p'] ?? body['topP']);
  const stream = body['stream'] === true;

  if (dialect === 'native') {
    const r = body['route'];
    const spec = parseRouteSpec(r);
    if ('error' in spec) return spec;
    return { spec: spec.spec, messages, maxTokens, temperature, topP, stream, pinnedModelId: null };
  }

  // OpenAI dialect. An explicit `bokahli.route` extension wins if present.
  const ext = body['bokahli'] as Record<string, unknown> | undefined;
  if (ext && ext['route']) {
    const spec = parseRouteSpec(ext['route']);
    if ('error' in spec) return spec;
    return { spec: spec.spec, messages, maxTokens, temperature, topP, stream, pinnedModelId: null };
  }

  const model = body['model'];
  if (model == null || model === '' || model === 'auto' || model === 'bokahli:auto') {
    return {
      spec: { mode: 'AUTO' },
      messages, maxTokens, temperature, topP, stream, pinnedModelId: null,
    };
  }
  if (typeof model !== 'string') return { error: 'model must be a string' };

  // "<modelId>@sha256:<hex>" expresses EXACT through the OpenAI model field.
  const at = model.indexOf('@');
  if (at > 0) {
    const id = model.slice(0, at);
    const digest = model.slice(at + 1);
    return {
      spec: { mode: 'EXACT', modelId: id, artifactDigest: digest },
      messages, maxTokens, temperature, topP, stream, pinnedModelId: null,
    };
  }

  // A bare model name. This is a hard pin, not an EXACT route: the OpenAI
  // model field carries no digest, so it cannot satisfy EXACT's contract.
  if (isPathLike(model)) {
    return {
      error:
        'model must be a stable Bokahli identity. Filesystem paths and artifact ' +
        'filenames are never accepted as model identity.',
    };
  }
  void deps;
  return {
    spec: { mode: 'AUTO' },
    messages, maxTokens, temperature, topP, stream, pinnedModelId: model,
  };
}

/**
 * Read a safety-bearing flag strictly.
 *
 * `requireQualified: "true"` used to fall through to `false`, because only the
 * literal `true` was recognised. A caller who asked to be protected was served
 * anyway, silently — the worst possible reading of a malformed request. Anything
 * that is not a real boolean is now an error, so the failure is visible to the
 * caller rather than resolved in their disfavour behind their back.
 */
function strictBool(
  v: unknown,
  field: string,
): { value: boolean | undefined } | { error: string } {
  if (v === undefined) return { value: undefined };
  if (typeof v === 'boolean') return { value: v };
  return {
    error:
      `${field} must be a boolean. It was ${JSON.stringify(v)}, and this field decides ` +
      'whether a qualification check runs, so it is not defaulted.',
  };
}

function strictString(v: unknown, field: string): { value: string | undefined } | { error: string } {
  if (v === undefined) return { value: undefined };
  if (typeof v === 'string' && v.length > 0) return { value: v };
  return { error: `${field} must be a non-empty string when present` };
}

function parseRouteSpec(r: unknown): { spec: RouteSpec } | { error: string } {
  if (typeof r !== 'object' || r === null) {
    return { error: 'route must be an object with a mode of AUTO, PROFILE, or EXACT' };
  }
  const o = r as Record<string, unknown>;
  const mode = o['mode'];
  if (mode === 'AUTO') {
    const rq = strictBool(o['requireQualified'], 'route.requireQualified');
    if ('error' in rq) return rq;
    const tc = strictString(o['taskClass'], 'route.taskClass');
    if ('error' in tc) return tc;
    const spec: RouteSpec = {
      mode: 'AUTO',
      ...(tc.value !== undefined ? { taskClass: tc.value } : {}),
      ...(rq.value === true ? { requireQualified: true } : {}),
    };
    return { spec };
  }
  if (mode === 'PROFILE') {
    const req = o['requirements'];
    if (typeof req !== 'object' || req === null || Array.isArray(req)) {
      return { error: 'PROFILE requires a requirements object' };
    }
    const validated = validateProfileRequirements(req as Record<string, unknown>);
    if ('error' in validated) return validated;
    return { spec: { mode: 'PROFILE', requirements: validated.requirements } };
  }
  if (mode === 'EXACT') {
    const modelId = o['modelId'];
    const digest = o['artifactDigest'];
    if (typeof modelId !== 'string') return { error: 'EXACT requires modelId' };
    if (typeof digest !== 'string') {
      return { error: 'EXACT requires artifactDigest; a route without a digest is not exact' };
    }
    const rq = strictBool(o['requireQualified'], 'route.requireQualified');
    if ('error' in rq) return rq;
    const tc = strictString(o['taskClass'], 'route.taskClass');
    if ('error' in tc) return tc;
    return {
      spec: {
        mode: 'EXACT',
        modelId,
        artifactDigest: digest,
        ...(tc.value !== undefined ? { taskClass: tc.value } : {}),
        ...(rq.value === true ? { requireQualified: true } : {}),
      },
    };
  }
  return { error: `unknown route mode: ${String(mode)}` };
}

/**
 * Validate a caller-supplied profile.
 *
 * Previously the requirements object was cast straight through unchecked, which
 * had two consequences: a string where an array was expected crashed the router
 * mid-evaluation, and a malformed `requireQualified` silently disabled the
 * qualification check. Both are now caller-visible errors. A constraint the
 * caller wrote must either be enforced or refused — never quietly dropped,
 * because a dropped constraint reads to the caller exactly like a satisfied one.
 */
function validateProfileRequirements(
  raw: Record<string, unknown>,
): { requirements: ProfileRequirements } | { error: string } {
  const numeric = [
    'minContextTokens', 'maxContextTokens', 'minParameterCount', 'maxQueueDepth',
  ] as const;
  const stringy = ['architecture', 'requiredTaskClass'] as const;
  const stringArrays = ['quantizationAllowList', 'quantizationDenyList'] as const;
  const known = new Set<string>([
    ...numeric, ...stringy, ...stringArrays, 'requiredCapabilities', 'requireQualified',
  ]);

  for (const k of Object.keys(raw)) {
    if (!known.has(k)) {
      return { error: `unknown profile requirement "${k}". Unknown constraints are refused rather than ignored.` };
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of numeric) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { error: `requirements.${k} must be a finite number` };
    }
    out[k] = v;
  }
  for (const k of stringy) {
    const r = strictString(raw[k], `requirements.${k}`);
    if ('error' in r) return r;
    if (r.value !== undefined) out[k] = r.value;
  }
  for (const k of [...stringArrays, 'requiredCapabilities'] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      return { error: `requirements.${k} must be an array of strings` };
    }
    out[k] = v;
  }
  const rq = strictBool(raw['requireQualified'], 'requirements.requireQualified');
  if ('error' in rq) return rq;
  if (rq.value !== undefined) out['requireQualified'] = rq.value;

  return { requirements: out as ProfileRequirements };
}

// ---------------------------------------------------------------------------
// static UI
// ---------------------------------------------------------------------------

async function serveStatic(
  deps: AppDeps,
  path: string,
  res: ServerResponse,
  requestId: string,
): Promise<void> {
  const rel = path === '/' ? '/index.html' : path;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  if (safe.includes('..')) {
    return json(res, 404, bokahliError('NOT_FOUND', 'no such route', requestId));
  }
  const file = join(deps.config.publicDir, safe);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    json(res, 404, bokahliError('NOT_FOUND', 'no such route', requestId));
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseRaw(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(buf);
  }
  if (total === 0) throw new Error('request body is empty');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).message === 'PAYLOAD_TOO_LARGE') throw err;
    throw new Error('request body is not valid JSON');
  }
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function optNumber(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function remoteOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}
