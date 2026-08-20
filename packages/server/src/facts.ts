/**
 * Assemble qualification facts, and cache them against the backend instance.
 *
 * Two forces pull in opposite directions here. The facts are expensive —
 * reading 11 MB of GGUF metadata, hashing 66 MB of shared objects — and doing
 * that per request would be absurd. But caching them is exactly how a stale
 * fact outlives the thing it described: the backend restarts, comes back on the
 * same build, and every subsequent response reports the previous process's
 * placement observation as though it were current.
 *
 * The cache key resolves that. It is the backend *instance* id — boot id, pid
 * and kernel start time — so a restart invalidates everything derived from the
 * old process by construction, not by anyone remembering to call an
 * invalidation function. Facts that are genuinely immutable for an artifact
 * (its tokenizer, its template) are cached against the artifact digest instead,
 * because those do not change when a process does.
 *
 * Placement is deliberately *not* cached with the rest. A backend can lose the
 * GPU without restarting, and a placement observation is only as good as its
 * age; it is re-measured on a short TTL and carries the timestamp of the
 * measurement rather than of the response.
 */
import { canonicalHash } from '@bokahli/qualification';
import type { InternalArtifact } from '@bokahli/catalog';
import type {
  ArtifactDigest,
  AttestationCompleteness,
  AttestedIdentityBinding,
  DevicePlacement,
  QualificationAttestation,
  QualificationFacts,
  RuntimeFacts,
  SamplerConfig,
  TemplateFacts,
  RuntimeTokenizerProof,
  TokenizerCanarySuite,
  TokenizerIdentity,
} from '@bokahli/contracts';
import {
  type GgufTokenizerMetadata,
  type LlamaBackend,
  probeBackendInstance,
  DEFAULT_PLACEMENT_FLOOR_MIB,
  probeDevicePlacement,
  probeExecutablePath,
  probeRuntimeTokenizer,
  probeGpuFlags,
  probeRuntimeFacts,
  readGgufTokenizerMetadata,
  resolveTemplateFacts,
  resolveTokenizerIdentity,
  templateDigest,
} from '@bokahli/runtime';

/**
 * How long a placement observation may be reused.
 *
 * Short, because the fact it records can change without any other signal: a
 * backend can be evicted from the device by a driver reset while its pid, build
 * and attestation all stay identical. Five seconds keeps a burst of requests
 * from spawning an nvidia-smi each without letting an observation describe a
 * state that is a minute old.
 */
const PLACEMENT_TTL_MS = 5000;

/**
 * How long an assembled attestation may be presented before it must be redone.
 *
 * Bounded so a cached observation cannot outlive the state it describes without
 * saying so. `expiresAt` is published, so a consumer can refuse a stale
 * attestation rather than having to trust that Bokahli refreshed it.
 */
const ATTESTATION_LIFETIME_MS = 60_000;

/**
 * How long an *unverified* tokenizer probe result may be reused.
 *
 * A verified probe is cached for the life of the backend instance: it describes
 * bytes and a process, and neither changes without the instance changing. A
 * failed one is different. A probe that failed because the backend was briefly
 * unreachable used to be cached on the same terms, so a two-second outage left
 * the deployment reporting unproven token counts until the next restart —
 * permanent damage from a transient fault, and invisible, because nothing
 * retried. Failures expire; successes do not.
 */
const FAILED_PROBE_TTL_MS = 30_000;

export interface FactsProviderOptions {
  readonly backend: LlamaBackend;
  /**
   * INTERNAL ONLY. Fallback path to the llama-server executable, used when it
   * cannot be observed from the running process. Never serialised.
   */
  readonly runtimeExecutablePathFallback: string | null;
  readonly resolveBackendPids: () => Promise<readonly number[]>;
  /** The artifact's own token table, for the runtime vocabulary probe. */
  readonly artifactTokens: (a: InternalArtifact) => Promise<readonly string[] | null>;
  /**
   * `tokenizer.ggml.token_type`, so the probe can tell a vocabulary entry from
   * the UNUSED padding that fills a vocabulary out to a round size. Without it
   * the sampled probe reports a mismatch against a healthy backend, because the
   * runtime renders padding as the empty string.
   */
  readonly artifactTokenTypes: (a: InternalArtifact) => Promise<Int32Array | null>;
  /**
   * The pinned two-sided canary for this artifact.
   *
   * Supplied, never produced: nothing at request time may generate an
   * expectation. Loaded and validated once at startup, so a malformed suite is
   * a startup failure rather than a permanent silent `encodeCanaryVerified:
   * false` that looks like a tokenizer problem.
   */
  readonly canarySuite: (a: InternalArtifact) => TokenizerCanarySuite | null;
  readonly now?: () => Date;
}

interface ArtifactFactsCache {
  readonly tokenizerMetadata: GgufTokenizerMetadata | null;
  readonly readFailure: string | null;
}

interface InstanceFactsCache {
  readonly instanceId: string | null;
  readonly runtime: RuntimeFacts;
}

/**
 * Compute the binding digest.
 *
 * Domain-separated and canonical, reusing the qualification package's hashing
 * rather than a second implementation — a digest with two implementations has
 * two definitions, and the day they diverge is the day an attestation silently
 * stops matching itself.
 */
export function bindingDigest(binding: AttestedIdentityBinding): ArtifactDigest {
  return `sha256:${canonicalHash({ domain: 'bokahli.attestation-binding.v1', binding })}`;
}

/**
 * What the HTTP layer needs from a facts provider.
 *
 * An interface rather than the class so a test can supply facts without an
 * nvidia-smi, a /proc, or a real artifact on disk — and so a test that wants to
 * assert on a particular provenance state can construct that state directly
 * instead of arranging for the world to produce it.
 */
export interface FactsSource {
  /** The instance id observed most recently, for post-response correlation. */
  currentInstanceId?(): Promise<string | null>;
  collect(
    artifact: InternalArtifact,
    attested: boolean,
    build: string | null,
    servedContextTokens: number | null,
    maxConcurrentRequests: number | null,
  ): Promise<QualificationFacts>;
}

/**
 * Decide how complete an attestation is.
 *
 * Exported because the verdict is the load-bearing part and burying it inside a
 * method that needs a GPU, a /proc and an artifact on disk would have made it
 * the one piece nothing could test.
 *
 * `unattested` is reserved for identity failure — the backend was not proven to
 * be serving this artifact. A deployment can be perfectly attested and still
 * `partial`, and collapsing the two would report a missing observation as a
 * possible substitution, which is a much louder claim than the facts support.
 */
function expiryFrom(observedAt: string): string {
  const base = Date.parse(observedAt);
  if (!Number.isFinite(base)) return new Date(0).toISOString();
  return new Date(base + ATTESTATION_LIFETIME_MS).toISOString();
}

export function attestationFor(
  binding: AttestedIdentityBinding,
  attested: boolean,
  tokenizer: TokenizerIdentity | null,
  observedAt: string,
  imageBinding: RuntimeFacts['imageDigestBinding'] = 'unavailable',
  generation = 0,
): QualificationAttestation {
  const missing: string[] = [];
  if (binding.imageDigest === null) missing.push('imageDigest');
  if (binding.tokenizerDigest === null) missing.push('tokenizerDigest');
  if (binding.effectiveTemplateDigest === null) missing.push('effectiveTemplateDigest');
  if (binding.backendInstanceId === null) missing.push('backendInstanceId');
  // Only an affirmative driver observation counts. `null` means the check could
  // not be made, and "we could not check" is not a pass.
  if (binding.devicePlacement.backendHoldsDevice !== true) {
    missing.push('devicePlacement.backendHoldsDevice');
  }
  if (tokenizer === null || tokenizer.unprovenReasons.length > 0) missing.push('tokenizer.proof');
  // A configured-tree digest proves what is on disk, not what the process
  // mapped. Letting it reach `complete` would upgrade a weaker observation to
  // full strength by omission, which is exactly the move this audit forbids.
  if (imageBinding !== 'process-mapped') missing.push(`runtime.imageDigestBinding=${imageBinding}`);

  const completeness: AttestationCompleteness = !attested
    ? 'unattested'
    : missing.length === 0
      ? 'complete'
      : 'partial';

  return {
    binding,
    bindingDigest: bindingDigest(binding),
    completeness,
    missing,
    observedAt,
    generation,
    // Guarded: `new Date(NaN).toISOString()` throws, and an unparseable
    // timestamp reaching here would take down the response rather than
    // degrading the attestation. An expiry that has already passed is the
    // fail-closed answer — a consumer refuses it rather than trusting it.
    expiresAt: expiryFrom(observedAt),
    backendInstanceId: binding.backendInstanceId,
  };
}

interface ProbeCacheEntry {
  readonly at: number;
  /** Null means "keep for the life of this instance". */
  expiresAt: number | null;
  readonly probe: Promise<RuntimeTokenizerProof>;
}

export class QualificationFactsProvider implements FactsSource {
  readonly #opts: FactsProviderOptions;
  readonly #now: () => Date;
  readonly #artifactCache = new Map<string, Promise<ArtifactFactsCache>>();
  /**
   * Tokenizer probes, keyed by (artifact digest, backend instance).
   *
   * The value is a Promise, not a result. Five concurrent `collect()` calls
   * against a cold cache each saw `null` and each launched the full sequence —
   * measured at 27 backend calls for a five-case suite, and the production
   * suite is ninety-four. Storing the in-flight promise makes the second caller
   * wait for the first instead of racing it.
   */
  readonly #probeCache = new Map<string, ProbeCacheEntry>();
  #instanceCache: InstanceFactsCache | null = null;
  #placement: { at: number; instanceId: string | null; value: DevicePlacement } | null = null;
  #generation = 0;

  constructor(opts: FactsProviderOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? ((): Date => new Date());
  }

  /**
   * Read tokenizer and template identity out of the artifact.
   *
   * Cached by digest, which is the right key: the digest *is* the content, so a
   * hit means the bytes are the same bytes. Failure is cached too, so a
   * permission problem does not turn every request into an 11 MB read that
   * fails again.
   */
  async #artifactFacts(artifact: InternalArtifact): Promise<ArtifactFactsCache> {
    const hit = this.#artifactCache.get(artifact.digest);
    if (hit) return hit;
    // The promise is installed before the first await, so concurrent callers
    // join this read instead of starting their own. Checking a cache, awaiting,
    // and then filling it is not caching — every caller that arrives during the
    // await misses.
    const pending = (async (): Promise<ArtifactFactsCache> => {
      try {
        return {
          tokenizerMetadata: await readGgufTokenizerMetadata(artifact.artifactPath),
          readFailure: null,
        };
      } catch (err) {
        // The message may name a path, and paths never leave this process. Only
        // the failure class is kept.
        return {
          tokenizerMetadata: null,
          readFailure: `artifact tokenizer metadata unreadable (${(err as Error).name})`,
        };
      }
    })();
    this.#artifactCache.set(artifact.digest, pending);
    return pending;
  }

  /** Re-read the instance so a restart during a request is detectable after it. */
  async currentInstanceId(): Promise<string | null> {
    const pids = await this.#opts.resolveBackendPids().catch(() => [] as readonly number[]);
    if (pids.length !== 1) return null;
    return (await probeBackendInstance(pids[0] as number)).instanceId;
  }

  async #currentPlacement(
    pid: number | null,
    instanceId: string | null,
    flags: { requestedGpuLayers: number | null; cpuOffloadEnabled: boolean | null },
  ): Promise<DevicePlacement> {
    const nowMs = this.#now().getTime();
    // Keyed by instance, not only by age. A five-second TTL alone let a restart
    // inside the window serve the previous process's placement observation
    // under the new process's identity. An unknown instance never hits cache.
    if (
      this.#placement &&
      instanceId !== null &&
      this.#placement.instanceId === instanceId &&
      nowMs - this.#placement.at < PLACEMENT_TTL_MS
    ) {
      return this.#placement.value;
    }
    const value = await probeDevicePlacement(
      { backendPid: pid, requestedGpuLayers: flags.requestedGpuLayers, cpuOffloadEnabled: flags.cpuOffloadEnabled },
      { now: this.#now },
    );
    this.#placement = { at: nowMs, instanceId, value };
    return value;
  }

  /**
   * Gather everything for one artifact against the current backend instance.
   *
   * Never throws. A probe that fails contributes a null and a reason, because
   * the alternative — letting a telemetry failure take down a chat request — is
   * a worse outcome than a response whose provenance is honestly incomplete.
   */
  async collect(
    artifact: InternalArtifact,
    attested: boolean,
    build: string | null,
    servedContextTokens: number | null,
    maxConcurrentRequests: number | null,
  ): Promise<QualificationFacts> {
    const now = this.#now;
    const pids = await this.#opts.resolveBackendPids().catch(() => [] as readonly number[]);
    // Exactly one, or none. Taking the first of several was arbitrary and the
    // order comes from a readdir, so two matching processes — a wrapper and the
    // server, or a leftover from a restart — could make identity flip between
    // requests with nothing to indicate it had.
    const pid = pids.length === 1 ? (pids[0] as number) : null;

    const instance = await probeBackendInstance(pid);
    const ambiguousPid = pids.length > 1;
    const flags = await probeGpuFlags(pid);

    // Runtime facts are cached against the instance, because the serving image
    // cannot change without the process changing.
    // A null instance id means "we could not tell". Two nulls are not the same
    // process, and comparing them with !== retained the previous instance's
    // runtime facts across a restart that happened while /proc reads were
    // failing — the exact window in which a restart is most likely.
    const instanceUnknown = instance.instanceId === null;
    if (
      this.#instanceCache === null ||
      instanceUnknown ||
      this.#instanceCache.instanceId === null ||
      this.#instanceCache.instanceId !== instance.instanceId
    ) {
      if (this.#instanceCache !== null) this.#generation += 1;
      const exe = (await probeExecutablePath(pid)) ?? this.#opts.runtimeExecutablePathFallback;
      this.#instanceCache = {
        instanceId: instance.instanceId,
        runtime:
          exe === null
            ? {
                provenance: 'observed', observedAt: this.#now().toISOString(),
                engine: 'llama.cpp', build, imageDigest: null,
                imageDigestBinding: 'unavailable' as const, imageDigestAlgorithm: null,
                imageComponents: [],
                driverVersion: null, driverSupportedCuda: null,
                processCudaRuntime: null, cublasVersion: null,
                limitation: 'backend executable could not be located, so no image digest was computed',
              }
            : await probeRuntimeFacts({ executablePath: exe, backendPid: pid, build }),
      };
    }
    const runtime = (this.#instanceCache as InstanceFactsCache).runtime;

    const placement = await this.#currentPlacement(pid, instance.instanceId, flags);
    const art = await this.#artifactFacts(artifact);

    const meta = await this.#opts.backend.modelMeta(artifact.runtimeAlias);
    const slot = await this.#opts.backend.slotParams().catch(() => null);
    let props: {
      chat_template?: string;
      default_generation_settings?: { params?: Record<string, unknown> };
    } = {};
    try {
      props = await this.#opts.backend.props();
    } catch {
      // Template identity degrades; nothing else depends on it here.
    }
    const cfgParams = props.default_generation_settings?.params;
    const propsReasoningFormat =
      cfgParams && typeof cfgParams['reasoning_format'] === 'string'
        ? (cfgParams['reasoning_format'] as string)
        : null;

    // The behavioural binding. Cached per artifact AND per backend instance: a
    // probe describes one process reading one vocabulary, and it does not
    // survive either changing.
    const probeKey = `${artifact.digest}\u0000${instance.instanceId ?? ''}`;
    let proof: RuntimeTokenizerProof | null = null;
    if (instance.instanceId !== null && art.tokenizerMetadata !== null) {
      const nowMs = this.#now().getTime();
      let entry = this.#probeCache.get(probeKey);
      // Expiry is decided at lookup, so a stale failure is never served once
      // and then evicted — it is evicted and re-probed.
      if (entry !== undefined && entry.expiresAt !== null && nowMs >= entry.expiresAt) {
        this.#probeCache.delete(probeKey);
        entry = undefined;
      }
      if (entry === undefined) {
        const instanceId = instance.instanceId;
        const metadataDigest = art.tokenizerMetadata?.metadataDigest ?? null;
        // Every await lives inside the promise, and the promise is installed in
        // the same synchronous turn as the lookup above. Awaiting the token
        // table first and *then* filling the cache meant five concurrent
        // callers all missed and all launched the sequence — measured at 27
        // backend calls for a five-case suite, and the production suite is 94.
        const created: ProbeCacheEntry = {
          at: nowMs,
          expiresAt: null,
          probe: (async () =>
            probeRuntimeTokenizer(
              {
                artifactTokens: await this.#opts.artifactTokens(artifact),
                artifactTokenTypes: await this.#opts.artifactTokenTypes(artifact),
                backendInstanceId: instanceId,
                canarySuite: this.#opts.canarySuite(artifact),
                artifactDigest: artifact.digest,
                tokenizerMetadataDigest: metadataDigest,
              },
              {
                tokenize: (text, o) => this.#opts.backend.tokenize(text, o),
                detokenize: (ids) => this.#opts.backend.detokenize(ids),
                // The second instance reading, taken after the sequence. A
                // restart in the middle of ninety-four calls must not produce a
                // proof stamped with the process that was there at the start.
                readBackendInstanceId: () => this.currentInstanceId(),
                now,
              },
            ))(),
        };
        this.#probeCache.set(probeKey, created);
        entry = created;
      }
      proof = await entry.probe;
      // Successes are permanent for this instance — they describe bytes and a
      // process, and neither changes without the instance changing. Failures
      // expire, so a transient outage cannot leave the deployment unproven for
      // ever with nothing retrying.
      const verified =
        proof.matches &&
        proof.canary?.encodeCanaryVerified === true &&
        proof.canary?.decodeCanaryVerified === true;
      entry.expiresAt = verified ? null : entry.at + FAILED_PROBE_TTL_MS;
    }

    const tokenizer: TokenizerIdentity = resolveTokenizerIdentity({
      artifactTokenizer: art.tokenizerMetadata,
      runtimeVocabSize: meta.vocabSize,
      runtimeBuild: build,
      artifactAttested: attested,
      backendInstanceId: instance.instanceId,
      runtimeTokenizerProof: proof,
      now,
    });
    const extraReasons = [
      ...(art.readFailure === null ? [] : [art.readFailure]),
      ...(ambiguousPid
        ? [`${pids.length} candidate backend processes match this port; identity is ambiguous`]
        : []),
    ];
    const tokenizerWithReadFailure: TokenizerIdentity =
      extraReasons.length === 0
        ? tokenizer
        : { ...tokenizer, unprovenReasons: [...tokenizer.unprovenReasons, ...extraReasons] };

    const template: TemplateFacts = resolveTemplateFacts({
      runtimeTemplate: props.chat_template ?? null,
      artifactTemplateDigest: art.tokenizerMetadata?.chatTemplateDigest ?? null,
      effectiveChatFormat: slot?.chatFormat ?? null,
      effectiveReasoningFormat: slot?.reasoningFormat ?? null,
      configuredReasoningFormat: propsReasoningFormat,
      // Bokahli asks for no chat format: it sends messages and lets the runtime
      // apply the model's own template. Recording that as an explicit "none"
      // rather than as a null keeps "we did not ask" distinct from "we do not
      // know what we asked".
      requestedChatFormat: null,
      digestOf: templateDigest,
      now,
    });

    const confirmedSampler: SamplerConfig | null =
      slot === null
        ? null
        : {
            ...(slot.temperature !== null ? { temperature: slot.temperature } : {}),
            ...(slot.topP !== null ? { topP: slot.topP } : {}),
            ...(slot.topK !== null ? { topK: slot.topK } : {}),
          };

    const binding: AttestedIdentityBinding = {
      modelId: artifact.modelId,
      artifactDigest: artifact.digest,
      runtimeBuild: build,
      imageDigest: runtime.imageDigest,
      tokenizerDigest: tokenizerWithReadFailure.metadataDigest,
      effectiveTemplateDigest: template.effective?.templateDigest ?? null,
      backendInstanceId: instance.instanceId,
      devicePlacement: {
        backendHoldsDevice: placement.backendHoldsDevice,
        cpuOffloadEnabled: placement.cpuOffloadEnabled,
        requestedGpuLayers: placement.requestedGpuLayers,
      },
      servedContextTokens,
      maxConcurrentRequests,
      confirmedSampler,
    };

    const attestation = attestationFor(
      binding, attested, tokenizerWithReadFailure, now().toISOString(),
      runtime.imageDigestBinding, this.#generation,
    );

    return {
      contractVersion: 'bokahli.qualification-telemetry.v1',
      runtime,
      tokenizer: tokenizerWithReadFailure,
      template,
      backendInstance: instance,
      placement,
      attestation,
    };
  }
}

/**
 * Facts for a deployment with no live backend behind it.
 *
 * Used where a response must be produced without having reached a runtime.
 * Everything is null with a stated reason; nothing here is a default that could
 * be mistaken for an observation.
 */
export function unavailableFacts(
  artifact: { modelId: string; digest: string },
  now: () => Date = () => new Date(),
): QualificationFacts {
  const observedAt = now().toISOString();
  const binding: AttestedIdentityBinding = {
    modelId: artifact.modelId,
    artifactDigest: artifact.digest,
    runtimeBuild: null,
    imageDigest: null,
    tokenizerDigest: null,
    effectiveTemplateDigest: null,
    backendInstanceId: null,
    devicePlacement: { backendHoldsDevice: null, cpuOffloadEnabled: null, requestedGpuLayers: null },
    servedContextTokens: null,
    maxConcurrentRequests: null,
    confirmedSampler: null,
  };
  return {
    contractVersion: 'bokahli.qualification-telemetry.v1',
    runtime: {
      provenance: 'observed', observedAt, engine: 'llama.cpp', build: null,
      imageDigest: null, imageDigestBinding: 'unavailable', imageDigestAlgorithm: null,
      imageComponents: [],
      driverVersion: null, driverSupportedCuda: null, processCudaRuntime: null,
      cublasVersion: null, limitation: 'no backend was contacted',
    },
    tokenizer: null,
    template: {
      requested: null, configured: null, effective: null,
      requestConfirmed: null, mismatch: null, reasoningFormatOverridden: null,
    },
    backendInstance: {
      provenance: 'observed', observedAt, pid: null, bootId: null,
      kernelStartTicks: null, startedAt: null, instanceId: null,
      unavailableReasons: ['no backend was contacted'],
    },
    placement: {
      provenance: 'observed', observedAt, method: 'unavailable',
      backendPid: null, backendHoldsDevice: null, backendVramMiB: null,
      floorMiB: DEFAULT_PLACEMENT_FLOOR_MIB,
      requestedGpuLayers: null, cpuOffloadEnabled: null,
      limitation: 'no backend was contacted',
    },
    attestation: {
      binding,
      bindingDigest: bindingDigest(binding),
      completeness: 'unattested',
      missing: ['everything: no backend was contacted'],
      observedAt,
      generation: 0,
      expiresAt: observedAt,
      backendInstanceId: null,
    },
  };
}
