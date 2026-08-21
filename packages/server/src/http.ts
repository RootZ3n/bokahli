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
  type AttemptLifetime,
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
  type SamplerConfig,
  type ServedIdentity,
  type VelumTelemetry,
} from '@bokahli/contracts';
import { authenticate, AUTH_COOKIE, type AuthSource } from './auth.js';
import { engineIdentity, type EvidenceItem, type TrustMode } from './trust.js';
import { inspectionBytes, type ScanCapacity } from './velum-capacity.js';
import type { ScanPool } from './scan-pool.js';
import type { BokahliConfig } from './config.js';
import {
  LLAMA_UNSET_SEED, resolveSamplerFacts, resolveTokenCounts,
  type BackendSlotParams,
} from '@bokahli/runtime';
import type { FactsSource } from './facts.js';
import type { QualificationGate } from './qualification.js';
import { route, type RouteContext } from './router.js';
import { estimateTokens, Telemetry } from './telemetry.js';
import { attemptInvalidDetail, evaluateAttemptLifetime } from './lifetime.js';

export interface AppDeps {
  readonly config: BokahliConfig;
  readonly token: string;
  readonly catalog: Catalog;
  readonly backend: LlamaBackend;
  readonly qualification: QualificationGate;
  readonly queue: AdmissionQueue;
  readonly gpu: GpuMonitor;
  readonly telemetry: Telemetry;
  /** Phase B2 provenance probes, cached against the live backend instance. */
  readonly facts: FactsSource;
  /** Process-wide budget for prompt-injection inspection. */
  readonly scanCapacity: ScanCapacity;
  /** Where inspection actually runs. Off the event loop, bounded, no queue. */
  readonly scanPool: ScanPool;
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
      if (!auth.ok || auth.source === null) {
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
      if (path === '/v1/chat/completions') return await handleChat(deps, req, res, requestId, 'openai', auth.source);
      if (path === '/v1/bokahli/chat') return await handleChat(deps, req, res, requestId, 'native', auth.source);
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
  // Provenance facts for the readiness view. Collected here rather than only on
  // the chat path because the question an operator asks before a campaign — is
  // this backend on the GPU, which process is it, what image is it running — is
  // a readiness question, and answering it should not require sending a prompt.
  const facts =
    first && attestation
      ? await deps.facts
          .collect(
            first,
            attestation.attested,
            attestation.build,
            attestation.servedContextTokens,
            attestation.totalSlots,
          )
          .catch(() => null)
      : null;

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
    /**
     * Whole-device telemetry. It says whether the GPU is busy; it does not say
     * whether *our* backend is on it. `devicePlacement` below answers that, and
     * the two are separate keys so neither can be read as the other.
     */
    gpuLease: {
      available: gpuState.leaseAvailable,
      foreignHolders: gpuState.foreignHolders,
      thresholdMiB: deps.config.gpuForeignHolderThresholdMiB,
      snapshot: gpuState.snapshot,
      error: gpuState.error,
    },
    /** Phase B2. Which process is serving, and whether it holds the device. */
    backendInstance: facts?.backendInstance ?? null,
    devicePlacement: facts?.placement ?? null,
    runtimeFacts: facts?.runtime ?? null,
    tokenizer: facts?.tokenizer ?? null,
    promptTemplate: facts?.template ?? null,
    attestation: facts?.attestation ?? null,
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
    // Byte counts and request counts. An operator needs to see whether
    // inspection is the thing refusing requests; nothing here is content, and
    // no field can be traced to what any request contained.
    velum: {
      mode: deps.config.velumMode,
      engine: engineIdentity(),
      capacity: deps.scanCapacity.usage(),
      // Worker counts, byte counts and timestamps. An operator needs to see
      // whether inspection is the thing refusing requests, and whether its
      // workers are crashing; nothing here is content.
      workers: deps.scanPool.health(),
    },
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
  /**
   * How the caller authenticated.
   *
   * The trust boundary uses it to tell the operator's own browser session from
   * a programmatic client. Both are trusted speakers; the distinction is
   * reported, never enforced. It is passed in rather than re-derived because
   * re-deriving it would mean a second reading of the request's credentials.
   */
  authSource: AuthSource,
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
  const { spec, maxTokens, temperature, topP, topK, seed, requestedSampler, stream, pinnedModelId } = parsed;

  // ── inspection capacity ──────────────────────────────────────────────────
  //
  // Reserved before anything is inspected, and for every zone at once: a
  // per-request budget spent once per evidence item would be no budget. Held
  // until the response ends, because what a scan leaves behind — raw evidence,
  // the fenced rendering, the transformation map — is retained that long so a
  // citation stays resolvable.
  const scanBytes = inspectionBytes(parsed.messages, parsed.evidence);
  const reserved = deps.scanCapacity.reserve(scanBytes);
  if (!reserved.ok) {
    const cap: CapacityUnavailable = {
      kind: 'CAPACITY_UNAVAILABLE',
      mode: spec.mode,
      reason: 'VELUM_SCAN_CAPACITY',
      detail:
        reserved.reason === 'PER_REQUEST'
          ? `this request carries ${reserved.requestedBytes} bytes of content to inspect, past the ` +
            `${reserved.limitBytes}-byte per-request limit. Send less, or split it across requests.`
          : `${reserved.requestedBytes} bytes need inspecting and ${reserved.availableBytes} of the ` +
            `${reserved.limitBytes}-byte process budget are free. Inspection is not queued: a waiter ` +
            'holds the memory it is waiting for.',
      queueDepth: deps.queue.depth,
      retryAfterSeconds: reserved.reason === 'PER_REQUEST' ? null : 5,
      leaseHolder: null,
    };
    return finishNonRouted(deps, res, requestId, receivedAt, t0, spec, cap, 0, null, dialect);
  }

  try {
  // ── the trust boundary ───────────────────────────────────────────────────
  //
  // Before routing, before capacity, before anything reaches a backend. Two
  // reasons for the position. A request whose evidence is refused must not
  // consume a queue slot or a GPU lease to find that out; and inspection has to
  // happen while the caller's bytes are still the caller's bytes, because the
  // fenced rendering is what goes onward and the raw is what a citation
  // resolves against.
  const admitted = await deps.scanPool.inspect({
    requestId,
    authSource,
    messages: parsed.messages,
    evidence: parsed.evidence,
    mode: deps.config.velumMode,
  });
  if (admitted.kind === 'SATURATED') {
    // Every worker is busy and there is no queue: a waiter would hold the
    // evidence it is waiting to have inspected, which is the unbounded memory
    // the byte reservation exists to prevent, one layer down.
    const cap: CapacityUnavailable = {
      kind: 'CAPACITY_UNAVAILABLE',
      mode: spec.mode,
      reason: 'VELUM_SCAN_CAPACITY',
      detail:
        `all ${admitted.workers} inspection workers are busy (${admitted.busy} in flight). ` +
        'Inspection is not queued; retry shortly.',
      queueDepth: deps.queue.depth,
      retryAfterSeconds: 5,
      leaseHolder: null,
    };
    return finishNonRouted(deps, res, requestId, receivedAt, t0, spec, cap, 0, null, dialect);
  }
  if (admitted.kind === 'ESCALATE') {
    // Not a verdict about the content: a statement that no verdict was reached.
    // The alternative — proceeding with inspection skipped — is the failure
    // mode this whole boundary exists to prevent.
    const esc: Escalation = {
      kind: 'ESCALATE',
      mode: spec.mode,
      reason: admitted.reason,
      detail: admitted.detail,
      unmet: [],
      considered: [],
      authorityNote:
        'Bokahli inspects caller-supplied evidence before it can reach the model. ' +
        'This request was not inspected to completion, so it was not executed. ' +
        'Nothing about this outcome is a statement about the model or the content.',
      retryableLocal: true,
    };
    return finishNonRouted(deps, res, requestId, receivedAt, t0, spec, esc, 0, null, dialect);
  }
  if (admitted.kind === 'BLOCKED') {
    const esc: Escalation = {
      kind: 'ESCALATE',
      mode: spec.mode,
      reason: 'VELUM_EVIDENCE_BLOCKED',
      detail: admitted.reason,
      unmet: [],
      considered: [],
      authorityNote:
        'A block-severity pattern matched inside caller-supplied evidence under enforce ' +
        'mode. The evidence was not sent to the model. This is a statement about the ' +
        'content of the evidence, not about the model or the requested route.',
      retryableLocal: false,
    };
    return finishNonRouted(
      deps, res, requestId, receivedAt, t0, spec, esc, 0, null, dialect, null, admitted.telemetry,
    );
  }
  const messages = admitted.messages;
  const velumTelemetry = admitted.telemetry;

  // A host that cannot convert bytes reliably cannot produce evidence about
  // anything. Refused here rather than served with quietly degraded token
  // provenance, which is where a base64 fault used to land: as a tokenizer that
  // "disagrees with the artifact token table", discarding a valid attempt and
  // pointing the investigation at the wrong component.
  const hostFault = deps.facts.hostIntegrityFault?.() ?? null;
  if (hostFault !== null) {
    const esc: Escalation = {
      kind: 'ESCALATE',
      mode: spec.mode,
      reason: 'HOST_INTEGRITY_FAULT',
      detail:
        `${hostFault}. No measurement taken on this machine can be attributed to the ` +
        'runtime or the model until it is resolved.',
      unmet: [{ requirement: 'host.byteConversionFaithful', required: 'true', actual: 'false' }],
      considered: [],
      authorityNote:
        'This is a statement about the deployment machine, not about the model and not ' +
        'about the served artifact. It must never be recorded as qualification evidence.',
      // Not retryable. The fault is intermittent, so a retry may well succeed —
      // and that is exactly the wrong thing to do: it samples a machine that is
      // known to compute wrong answers until one of them looks right. A
      // deployment reaching this needs investigation, not another attempt.
      retryableLocal: false,
    };
    return finishNonRouted(
      deps, res, requestId, receivedAt, t0, spec, esc, 0, null, dialect, null, velumTelemetry,
    );
  }

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

  // When the request became this backend's problem. Everything about whether
  // its evidence survived is measured from here, not from receipt: queue time
  // is not time spent on stale evidence, it is time spent before any was used.
  const admittedAt = new Date().toISOString();

  try {
    const ctx: RouteContext = {
      catalog: deps.catalog,
      backend: deps.backend,
      qualification: deps.qualification,
      queueDepth: deps.queue.depth,
      estimatedPromptTokens: estimated,
      requestedMaxTokens: maxTokens,
      qualificationFacts: (artifact, at) =>
        deps.facts.collect(
          artifact,
          at.attested,
          at.build,
          at.servedContextTokens,
          at.totalSlots,
        ),
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

    // Refuse stale evidence before spending a GPU-minute on it. An attestation
    // that had already lapsed at admission cannot be repaired by anything the
    // request does afterwards, and executing first would mean discarding a
    // completed generation for a fact that was knowable up front.
    const attestation = served.qualificationFacts.attestation;
    const instanceAtAdmission = served.qualificationFacts.backendInstance.instanceId;
    const expiresMs = Date.parse(attestation.expiresAt);
    // Only where something is actually being claimed.
    //
    // An unattested response already says, in every field a caller reads, that
    // the served identity was not proven: `attested: false`, completeness
    // `unattested`, tokenizer unproven, and no export downstream. There is no
    // expired attestation being *used*, because there is no attestation. Gating
    // it anyway would turn a degraded provenance probe into a total outage —
    // an evidence feature taking the service down is how evidence features get
    // switched off.
    // `unattested` is the state where no attestation exists at all — the facts
    // probe could not reach the backend. There is nothing stale to refuse, and
    // in a healthy deployment the two conditions coincide: the real provider
    // derives completeness from the same attested flag.
    const claimsAttestation = served.attested && attestation.completeness !== 'unattested';

    // Strict paths do not get the permissive reading.
    //
    // Ordinary chat may be served explicitly unattested when policy allows a
    // degraded answer — the response says so in every field and nothing
    // downstream can build on it. A request that asks for qualification, names
    // a task class, or pins an exact identity is asking a different question,
    // and "we could not establish the evidence" must be an answer to it rather
    // than a footnote on a completion. So for those, an absent attestation or
    // an unknown backend instance refuses exactly as a stale one does.
    const strict = isStrictRequest(spec);
    const strictUnmet: string[] = strict
      ? [
          ...(attestation.completeness === 'unattested'
            ? ['the served identity carries no attestation at all']
            : []),
          ...(instanceAtAdmission === null
            ? ['the backend instance could not be established, so nothing can be bound to it']
            : []),
        ]
      : [];
    const stale = !Number.isFinite(expiresMs) || Date.parse(admittedAt) > expiresMs;
    if (strictUnmet.length > 0 || ((claimsAttestation || strict) && stale)) {
      return finishNonRouted(
        deps, res, requestId, receivedAt, t0, spec,
        {
          kind: 'ESCALATE',
          mode: spec.mode,
          reason: 'ATTESTATION_STALE',
          detail:
            strictUnmet.length > 0
              ? `this request requires attested evidence and ${strictUnmet.join('; ')}. ` +
                'Bokahli refuses rather than answering a question about qualification with ' +
                'a completion it cannot stand behind.'
              : `the attestation for ${served.modelId} was observed at ${attestation.observedAt} ` +
                `and expired at ${attestation.expiresAt}; this request was admitted at ` +
                `${admittedAt}. Serving it would attach evidence to a completion that the ` +
                'evidence no longer describes.',
          unmet:
            strictUnmet.length > 0
              ? [
                  {
                    requirement: 'attestation.presentAtAdmission',
                    required: 'true',
                    actual: 'false',
                  },
                ]
              : [
                  {
                    requirement: 'attestation.freshAtAdmission',
                    required: 'true',
                    actual: 'false',
                  },
                ],
          considered: [],
          authorityNote:
            'Bokahli emits a typed escalation and stops. Re-attestation happens on the ' +
            'next request; nothing about this outcome is a statement about the model.',
          retryableLocal: true,
        },
        decision.routeMs, gpuState.snapshot, dialect,
      );
    }

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
        requestId, receivedAt, admittedAt, instanceAtAdmission,
        t0, admission, spec, outcome, served, artifact,
        messages, maxTokens, temperature, topP, topK, seed, requestedSampler,
        routeMs: decision.routeMs, velum: velumTelemetry,
        gpu: gpuState.snapshot, dialect, signal: ac.signal,
      });
    } else {
      await bufferChat(deps, res, {
        requestId, receivedAt, admittedAt, instanceAtAdmission,
        t0, admission, spec, outcome, served, artifact,
        messages, maxTokens, temperature, topP, topK, seed, requestedSampler,
        routeMs: decision.routeMs, velum: velumTelemetry,
        gpu: gpuState.snapshot, dialect, signal: ac.signal,
      });
    }
  } finally {
      admission.release();
    }
  } finally {
    // Released here and only here: every early return above — escalation,
    // block, capacity, refusal — leaves through it, and `release` is idempotent
    // so a nested `finally` cannot hand the budget capacity twice.
    reserved.reservation.release();
  }
}

interface ExecArgs {
  /**
   * What the trust boundary decided about this request's content.
   *
   * Carried rather than recomputed: inspection happened once, before anything
   * reached the backend, and re-running it here would be a second boundary
   * whose answer could differ from the one that actually gated the request.
   */
  velum: VelumTelemetry | null;
  requestId: string;
  receivedAt: string;
  /** When the queue admitted this request; the start of its evidence window. */
  admittedAt: string;
  /** The backend process the routing decision and its attestation describe. */
  instanceAtAdmission: string | null;
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
  topK: number | undefined;
  seed: number | undefined;
  /** Exactly what the client asked for, before any default filled a gap. */
  requestedSampler: SamplerConfig;
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
      {
        messages: a.messages, maxTokens: a.maxTokens,
        temperature: a.temperature, topP: a.topP,
        // Spread, not assigned: an explicit `undefined` property would still
        // be an own property and would change the request body shape.
        ...(a.topK !== undefined ? { topK: a.topK } : {}),
        ...(a.seed !== undefined ? { seed: a.seed } : {}),
      },
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
    const telemetry = await buildTelemetry(deps, a, {
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

  const telemetry = await buildTelemetry(deps, a, {
    firstTokenAt, promptTokens, completionTokens, promptTps, completionTps,
    completionText: text,
  });

  // Headers and deltas are already on the wire, so the terminal event carries
  // the verdict. A client that consumed the text learns, in the same stream,
  // that it must not be treated as an attested completion.
  if (enforcesAttribution(a) && telemetry.attemptLifetime?.verdict === 'infrastructure-invalid') {
    const escalation = attemptNotAttributableEscalation(a.spec.mode, telemetry);
    deps.telemetry.log('warn', 'attempt.notAttributable', {
      requestId: a.requestId,
      modelId: a.served.modelId,
      streamedChars: text.length,
      reasons: telemetry.attemptLifetime.reasons.join('; '),
    });
    if (a.dialect === 'openai') {
      sseRaw(res, {
        id: a.requestId,
        object: 'chat.completion.chunk',
        model: a.served.modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'attempt_not_attributable' }],
        bokahli: { outcome: 'ESCALATE', route: escalation, telemetry },
      });
      res.write('data: [DONE]\n\n');
    } else {
      sse(res, 'bokahli.done', {
        requestId: a.requestId,
        outcome: 'ESCALATE',
        route: escalation,
        result: null,
        streamedTextNotAttributable: true,
        telemetry,
      });
    }
    res.end();
    deps.telemetry.record(telemetry, 'ESCALATE');
    return;
  }

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
      {
        messages: a.messages, maxTokens: a.maxTokens,
        temperature: a.temperature, topP: a.topP,
        // Spread, not assigned: an explicit `undefined` property would still
        // be an own property and would change the request body shape.
        ...(a.topK !== undefined ? { topK: a.topK } : {}),
        ...(a.seed !== undefined ? { seed: a.seed } : {}),
      },
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

  const telemetry = await buildTelemetry(deps, a, {
    firstTokenAt, promptTokens, completionTokens, promptTps, completionTps,
    completionText: text,
  });

  // The completion exists. Whether it can be attributed is a separate question,
  // and it is answered before the text is handed over rather than annotated
  // beside it — an unattributable answer that ships with a warning field is an
  // answer that will be read without the field.
  //
  // The verdict is computed and published for every routed request; it is
  // *enforced* where the response would otherwise present an attested identity.
  // An unattested response claims nothing to begin with.
  if (
    enforcesAttribution(a) &&
    telemetry.attemptLifetime?.verdict === 'infrastructure-invalid'
  ) {
    deps.telemetry.log('warn', 'attempt.notAttributable', {
      requestId: a.requestId,
      modelId: a.served.modelId,
      discardedChars: text.length,
      reasons: telemetry.attemptLifetime.reasons.join('; '),
    });
    deps.telemetry.record(telemetry, 'ESCALATE');
    return finishNonRouted(
      deps, res, a.requestId, a.receivedAt, a.t0, a.spec,
      attemptNotAttributableEscalation(a.spec.mode, telemetry),
      a.routeMs, a.gpu, a.dialect, telemetry.attemptLifetime,
    );
  }

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

/**
 * Read back the sampler the runtime actually applied.
 *
 * `/slots` reflects the most recent request a slot handled, so this is only
 * attributable to *our* request when nothing else could have taken the slot in
 * between. On a deployment that serves one request at a time that holds; above
 * that it does not, and the honest answer is to report no effective sampler
 * rather than one that might belong to somebody else's request.
 *
 * This is why the check is on `maxConcurrentRequests` rather than on observed
 * traffic: a race that is currently not happening is still a race, and evidence
 * gathered under one is not distinguishable afterwards from evidence gathered
 * without one.
 */
async function readEffectiveSampler(deps: AppDeps, a: ExecArgs): Promise<BackendSlotParams | null> {
  const concurrency = a.served.qualificationFacts.attestation.binding.maxConcurrentRequests;
  if (concurrency !== null && concurrency > 1) return null;
  try {
    return await deps.backend.slotParams();
  } catch {
    return null;
  }
}

/**
 * Does this request depend on attested evidence being established?
 *
 * PROFILE carries its qualification demand inside `requirements`, AUTO and
 * EXACT carry it at the top level, and EXACT is strict by construction: pinning
 * an identity is a claim about identity. Reading only one of those shapes would
 * have left PROFILE requests with `requireQualified: true` on the permissive
 * path, which is the exact request that must not be.
 */
function isStrictRequest(spec: RouteSpec): boolean {
  if (spec.mode === 'EXACT') return true;
  if (spec.mode === 'PROFILE') {
    return spec.requirements.requireQualified === true ||
      spec.requirements.requiredTaskClass !== undefined;
  }
  return spec.requireQualified === true || spec.taskClass !== undefined;
}

/**
 * Whether an unattributable completion must be refused rather than annotated.
 *
 * Strict requests — EXACT, qualification-required, or task-class-scoped — always
 * enforce: they asked a question that a completion from an unattested process
 * does not answer. Ordinary chat enforces whenever the response would otherwise
 * present an attested identity, and stays available when it would not.
 */
function enforcesAttribution(a: ExecArgs): boolean {
  return (
    isStrictRequest(a.spec) ||
    (a.served.attested &&
      a.served.qualificationFacts.attestation.completeness !== 'unattested')
  );
}

/**
 * Append a model-output packet to the request's inspection report.
 *
 * Returns the report unchanged when there is nothing to add. The completion is
 * never modified, and a finding here never changes the outcome: the packet's
 * `disposition` is always `passed`.
 */
async function withModelOutput(
  deps: AppDeps,
  requestId: string,
  base: VelumTelemetry | null,
  completion: string | undefined,
  mode: TrustMode,
): Promise<VelumTelemetry | null> {
  if (base === null || completion === undefined || mode === 'off') return base;
  // Off the event loop like every other scan. Observation only: a saturated
  // pool or a failed worker degrades to no packet rather than affecting a
  // request that has already run.
  const packet = await deps.scanPool.inspectModelOutput(requestId, 'completion', completion, mode);
  if (packet === null) return base;
  const packets = [...base.packets, packet];
  return {
    ...base,
    packets,
    // The overall decision is deliberately not raised by model output. A
    // completion that echoes an injection is a fact worth publishing, not a
    // reason to retroactively refuse a request that already ran.
    clean: packets.every((p) => p.scanned && p.findingCount === 0),
    scannedAll: packets.every((p) => p.scanned),
    receipt: `${base.receipt} model-output=${packet.findingCount === 0 ? 'clean' : `${packet.findingCount} finding(s)`}`,
  };
}

async function buildTelemetry(
  deps: AppDeps,
  a: ExecArgs,
  m: {
    firstTokenAt: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    promptTps: number | null;
    completionTps: number | null;
    /**
     * The completion, for observation only.
     *
     * Inspecting model output answers "did the model do what the injected text
     * asked" — useful telemetry, and the reason it is worth scanning. It does
     * **not** gate the response and it never edits it. Rewriting a completion
     * would make every downstream measurement of the model a measurement of
     * Bokahli's editor instead, and measuring the model is what Luak is for.
     */
    completionText?: string;
  },
): Promise<RequestTelemetry> {
  const slot = await readEffectiveSampler(deps, a);
  // The instance the request was routed against. If the backend restarted since
  // then, the slot we just read belongs to a different process and is dropped
  // rather than reported at reduced confidence.
  const routedInstance = a.instanceAtAdmission;
  // Re-read, and do not fall back to the admission value. A fallback would make
  // "we could not tell" indistinguishable from "it did not change", which is
  // the one distinction the completion check exists to make.
  const nowInstance = (await deps.facts.currentInstanceId?.()) ?? null;
  const sampler = resolveSamplerFacts({
    requested: a.requestedSampler,
    // What actually went on the wire: the requested value where there was one,
    // the Phase 1 default where there was not. Recording only the request would
    // hide the defaults, and recording only the defaults would hide the ask.
    sent: {
      maxTokens: a.maxTokens,
      ...(a.temperature !== undefined ? { temperature: a.temperature } : { temperature: 0.7 }),
      ...(a.topP !== undefined ? { topP: a.topP } : { topP: 0.95 }),
      ...(a.topK !== undefined ? { topK: a.topK } : {}),
      ...(a.seed !== undefined ? { seed: a.seed } : {}),
    },
    slot,
    slotCorrelation:
      routedInstance === null || nowInstance === null
        ? null
        : { backendInstanceId: nowInstance, requestInstanceId: routedInstance },
    unsetSeedSentinel: LLAMA_UNSET_SEED,
  });
  const tokenCounts = resolveTokenCounts({
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    // llama.cpp's `usage` block is the only source these numbers have; Bokahli
    // never counts anything itself.
    fromRuntimeUsage: true,
    tokenizer: a.served.qualificationFacts.tokenizer,
  });
  const served = a.served.servedContextTokens;
  const used = (m.promptTokens ?? 0) + (m.completionTokens ?? 0);
  const completedAt = new Date().toISOString();
  const attestation = a.served.qualificationFacts.attestation;
  const attemptLifetime = evaluateAttemptLifetime({
    admittedAt: a.admittedAt,
    completedAt,
    attestationObservedAt: attestation.observedAt,
    attestationExpiresAt: attestation.expiresAt,
    instanceAtAdmission: routedInstance,
    instanceAtCompletion: nowInstance,
  });
  return {
    requestId: a.requestId,
    receivedAt: a.receivedAt,
    completedAt,
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
    velum: await withModelOutput(deps, a.requestId, a.velum, m.completionText, deps.config.velumMode),
    tokenCounts,
    sampler,
    attemptLifetime,
  };
}

/**
 * The escalation for a completion nobody can stand behind.
 *
 * Distinct from `runtimeUnhealthyEscalation`, which says the runtime stopped
 * answering. Here it answered — and a different process did, so the answer is
 * unattributable rather than absent. Collapsing the two would tell an operator
 * to investigate an outage that did not happen, and would let a qualification
 * campaign score a restart as a model failure.
 */
function attemptNotAttributableEscalation(
  mode: RouteSpec['mode'],
  telemetry: RequestTelemetry,
): Escalation {
  const l = telemetry.attemptLifetime;
  return {
    kind: 'ESCALATE',
    mode,
    reason: 'ATTEMPT_NOT_ATTRIBUTABLE',
    detail: l === null ? 'this attempt has no lifetime record' : attemptInvalidDetail(l),
    unmet: [
      {
        requirement: 'backendInstance.continuousAcrossRequest',
        required: 'true',
        actual: String(l?.instanceContinuous ?? false),
      },
    ],
    considered: [],
    authorityNote:
      'Bokahli emits a typed escalation and stops. This is an infrastructure outcome: ' +
      'a qualification campaign must discard the attempt rather than score it against ' +
      'the model.',
    retryableLocal: true,
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
  lifetime: AttemptLifetime | null = null,
  velum: VelumTelemetry | null = null,
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
    // No model ran, so there is nothing to attribute. `unknown` rather than a
    // zero count: a refused or escalated request produced no tokens, and a zero
    // would aggregate as a measurement of zero rather than as an absence.
    tokenCounts: {
      source: 'unknown',
      promptTokens: null,
      completionTokens: null,
      promptTokenSource: 'unknown',
      completionTokenSource: 'unknown',
      tokenizer: null,
    },
    sampler: {
      requested: {},
      sent: {},
      effective: null,
      effectiveSource: 'unavailable',
      effectiveScope: 'backend-instance',
      seedSupport: 'not_requested',
      deterministicOutputGuaranteed: false,
    },
    // Null when no backend was reached — there is no attempt whose lifetime
    // could be bounded, and a synthetic 'valid' would claim an attestation
    // survived a request that never had one. Non-null when a request *did*
    // execute and was then refused for its lifetime: the verdict has to travel
    // in telemetry, or a consumer reading only telemetry sees an escalation
    // with no record of why the attempt was dropped.
    attemptLifetime: lifetime ?? null,
    velum,
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
  /**
   * Caller-supplied evidence: logs, files, documents.
   *
   * A separate channel from `messages`, and that separation is the point. The
   * same sentence is a request in a message and an attack in a log, and nothing
   * in the bytes distinguishes them — only the channel does. A caller that
   * pastes a hostile document into a `user` message gets it treated as their own
   * instruction, which is correct: they said it. A caller that submits it as
   * evidence gets it fenced and scanned, which is also correct.
   */
  evidence: readonly EvidenceItem[];
  maxTokens: number;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  seed: number | undefined;
  /** What the client actually asked for, before defaults. Never inferred. */
  requestedSampler: SamplerConfig;
  stream: boolean;
  pinnedModelId: string | null;
}

/**
 * Bounds for the native `sampler` object.
 *
 * Every field is bounded, and out of range is a refusal rather than a clamp. A
 * clamp silently changes what was asked for, and a response produced under
 * settings the caller did not choose is not attributable to any configuration —
 * which is the failure this whole phase exists to remove.
 */
const SAMPLER_BOUNDS = {
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false },
  topK: { min: 0, max: 1000, integer: true },
  maxTokens: { min: 1, max: 32768, integer: true },
  seed: { min: 0, max: 0xfffffffe, integer: true },
} as const;

/**
 * Parse the native `sampler` object.
 *
 * Deliberately separate from the Phase 1 top-level `temperature`/`top_p`/
 * `max_tokens` fields, which keep their original coercing behaviour untouched.
 * That split is the compatibility guarantee: a Phase 1 client's request is
 * parsed by exactly the code that parsed it before, and strictness applies only
 * to a key that did not exist until now, so no existing request can change
 * meaning.
 *
 * `0xFFFFFFFF` is refused as a seed because llama.cpp uses it as the sentinel
 * for "no seed given". Accepting it would produce a request that asked for a
 * seed and a runtime that reports none, and the resulting `seedSupport` verdict
 * would be wrong in a way nothing downstream could detect.
 */
function parseSamplerObject(raw: unknown): SamplerConfig | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'sampler must be an object' };
  }
  const o = raw as Record<string, unknown>;
  const known = new Set(Object.keys(SAMPLER_BOUNDS));
  for (const k of Object.keys(o)) {
    // An unknown key is a refusal, not something to ignore. Ignoring it would
    // let a caller believe it set `top_k` when it set `topk` and got defaults.
    if (!known.has(k)) return { error: `unknown sampler field "${k}"` };
  }

  // Checked before the range test so the refusal explains *why* this
  // particular value is excluded. "must be within [0, 4294967294]" is a true
  // message and a useless one: it leaves the caller to discover on their own
  // that the excluded value is the runtime's "no seed" marker.
  if (o['seed'] === 0xffffffff) {
    return { error: 'sampler.seed 4294967295 is the runtime sentinel for "no seed"; choose another' };
  }

  const out: Record<string, number> = {};
  for (const [key, bound] of Object.entries(SAMPLER_BOUNDS)) {
    const v = o[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { error: `sampler.${key} must be a finite number, not ${typeof v}` };
    }
    if (bound.integer && !Number.isInteger(v)) {
      return { error: `sampler.${key} must be an integer` };
    }
    if (v < bound.min || v > bound.max) {
      return { error: `sampler.${key} must be within [${bound.min}, ${bound.max}]` };
    }
    out[key] = v;
  }
  return out as SamplerConfig;
}

/**
 * Parse the optional `evidence` array.
 *
 * Strict, and strict in the fail-closed direction: an evidence item that cannot
 * be read is a refusal, never a silently dropped one. Dropping it would mean
 * the model answers a question about a document it was never given, and the
 * caller has no way to tell that from an answer about the document.
 *
 * Ids are bounded and required to be distinct because they are what a finding
 * and a citation are reported against; two items sharing an id would make a
 * span ambiguous between them.
 */
function parseEvidence(raw: unknown, maxRequestBytes: number): { items: EvidenceItem[] } | { error: string } {
  if (raw === undefined || raw === null) return { items: [] };
  if (!Array.isArray(raw)) return { error: 'evidence must be an array' };
  if (raw.length > MAX_EVIDENCE_ITEMS) {
    return { error: `evidence has ${raw.length} items, past the ${MAX_EVIDENCE_ITEMS} cap` };
  }
  const items: EvidenceItem[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [i, e] of (raw as unknown[]).entries()) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      return { error: `evidence[${i}] must be an object` };
    }
    const o = e as Record<string, unknown>;
    const id = o['id'];
    const content = o['content'];
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_EVIDENCE_ID_CHARS) {
      return { error: `evidence[${i}].id must be a string of 1..${MAX_EVIDENCE_ID_CHARS} characters` };
    }
    if (seen.has(id)) return { error: `evidence[${i}].id ${JSON.stringify(id)} is not unique` };
    seen.add(id);
    if (typeof content !== 'string') return { error: `evidence[${i}].content must be a string` };
    total += Buffer.byteLength(content, 'utf8');
    if (total > maxRequestBytes) {
      return { error: `evidence exceeds ${maxRequestBytes} bytes in total` };
    }
    items.push({ id, content });
  }
  return { items };
}

/** Bounds on the evidence channel. Both are enforced before any scan runs. */
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_ID_CHARS = 128;

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

  const evidence = parseEvidence(body['evidence'], deps.config.maxRequestBytes);
  if ('error' in evidence) return { error: evidence.error };

  // Phase 1 parsing, byte for byte. Do not tighten: a client that has been
  // sending `temperature: "0.7"` since Phase 1 must keep getting 0.7.
  const legacyMaxTokens = clampInt(body['max_tokens'] ?? body['maxTokens'], 512, 1, 32768);
  const legacyTemperature = optNumber(body['temperature']);
  const legacyTopP = optNumber(body['top_p'] ?? body['topP']);
  const stream = body['stream'] === true;

  const sampler = parseSamplerObject(body['sampler']);
  if ('error' in sampler) return { error: sampler.error };
  const usingSampler = Object.keys(sampler).length > 0;

  // Both surfaces present is a refusal, never a silent precedence rule. A
  // caller who set `temperature` in two places has a bug, and picking one for
  // them hides it behind a plausible number.
  if (usingSampler) {
    const clash: string[] = [];
    if (sampler.temperature !== undefined && body['temperature'] !== undefined) clash.push('temperature');
    if (sampler.topP !== undefined && (body['top_p'] ?? body['topP']) !== undefined) clash.push('top_p');
    if (sampler.maxTokens !== undefined && (body['max_tokens'] ?? body['maxTokens']) !== undefined) {
      clash.push('max_tokens');
    }
    if (clash.length > 0) {
      return { error: `${clash.join(', ')} set both at top level and in sampler; set one` };
    }
  }

  const maxTokens = sampler.maxTokens ?? legacyMaxTokens;
  const temperature = sampler.temperature ?? legacyTemperature;
  const topP = sampler.topP ?? legacyTopP;
  const topK = sampler.topK;
  const seed = sampler.seed;
  const requestedSampler: SamplerConfig = sampler;

  if (dialect === 'native') {
    const r = body['route'];
    const spec = parseRouteSpec(r);
    if ('error' in spec) return spec;
    return { spec: spec.spec, messages, evidence: evidence.items, maxTokens, temperature, topP, topK, seed, requestedSampler, stream, pinnedModelId: null };
  }

  // OpenAI dialect. An explicit `bokahli.route` extension wins if present.
  const ext = body['bokahli'] as Record<string, unknown> | undefined;
  if (ext && ext['route']) {
    const spec = parseRouteSpec(ext['route']);
    if ('error' in spec) return spec;
    return { spec: spec.spec, messages, evidence: evidence.items, maxTokens, temperature, topP, topK, seed, requestedSampler, stream, pinnedModelId: null };
  }

  const model = body['model'];
  if (model == null || model === '' || model === 'auto' || model === 'bokahli:auto') {
    return {
      spec: { mode: 'AUTO' },
      messages, evidence: evidence.items, maxTokens, temperature, topP, topK, seed, requestedSampler, stream, pinnedModelId: null,
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
      messages, evidence: evidence.items, maxTokens, temperature, topP, topK, seed, requestedSampler, stream, pinnedModelId: null,
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
    messages, evidence: evidence.items, maxTokens, temperature, topP, topK, seed, requestedSampler, stream, pinnedModelId: model,
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
