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
  TokenizerIdentity,
} from '@bokahli/contracts';
import {
  type GgufTokenizerMetadata,
  type LlamaBackend,
  probeBackendInstance,
  probeDevicePlacement,
  probeExecutablePath,
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

export interface FactsProviderOptions {
  readonly backend: LlamaBackend;
  /**
   * INTERNAL ONLY. Fallback path to the llama-server executable, used when it
   * cannot be observed from the running process. Never serialised.
   */
  readonly runtimeExecutablePathFallback: string | null;
  readonly resolveBackendPids: () => Promise<readonly number[]>;
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
export function attestationFor(
  binding: AttestedIdentityBinding,
  attested: boolean,
  tokenizer: TokenizerIdentity | null,
  observedAt: string,
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

  const completeness: AttestationCompleteness = !attested
    ? 'unattested'
    : missing.length === 0
      ? 'complete'
      : 'partial';

  return { binding, bindingDigest: bindingDigest(binding), completeness, missing, observedAt };
}

export class QualificationFactsProvider implements FactsSource {
  readonly #opts: FactsProviderOptions;
  readonly #now: () => Date;
  readonly #artifactCache = new Map<string, ArtifactFactsCache>();
  #instanceCache: InstanceFactsCache | null = null;
  #placement: { at: number; value: DevicePlacement } | null = null;

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
    let entry: ArtifactFactsCache;
    try {
      entry = { tokenizerMetadata: await readGgufTokenizerMetadata(artifact.artifactPath), readFailure: null };
    } catch (err) {
      // The message may name a path, and paths never leave this process. Only
      // the failure class is kept.
      entry = {
        tokenizerMetadata: null,
        readFailure: `artifact tokenizer metadata unreadable (${(err as Error).name})`,
      };
    }
    this.#artifactCache.set(artifact.digest, entry);
    return entry;
  }

  async #currentPlacement(
    pid: number | null,
    flags: { requestedGpuLayers: number | null; cpuOffloadEnabled: boolean | null },
  ): Promise<DevicePlacement> {
    const nowMs = this.#now().getTime();
    if (this.#placement && nowMs - this.#placement.at < PLACEMENT_TTL_MS) {
      return this.#placement.value;
    }
    const value = await probeDevicePlacement(
      { backendPid: pid, requestedGpuLayers: flags.requestedGpuLayers, cpuOffloadEnabled: flags.cpuOffloadEnabled },
      { now: this.#now },
    );
    this.#placement = { at: nowMs, value };
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
    const pid = pids[0] ?? null;

    const instance = await probeBackendInstance(pid);
    const flags = await probeGpuFlags(pid);

    // Runtime facts are cached against the instance, because the serving image
    // cannot change without the process changing.
    if (this.#instanceCache === null || this.#instanceCache.instanceId !== instance.instanceId) {
      const exe = (await probeExecutablePath(pid)) ?? this.#opts.runtimeExecutablePathFallback;
      this.#instanceCache = {
        instanceId: instance.instanceId,
        runtime:
          exe === null
            ? {
                provenance: 'observed', observedAt: this.#now().toISOString(),
                engine: 'llama.cpp', build, imageDigest: null,
                imageDigestBinding: 'unavailable', imageComponents: [],
                driverVersion: null, driverSupportedCuda: null,
                processCudaRuntime: null, cublasVersion: null,
                limitation: 'backend executable could not be located, so no image digest was computed',
              }
            : await probeRuntimeFacts({ executablePath: exe, backendPid: pid, build }),
      };
    }
    const runtime = this.#instanceCache.runtime;

    const placement = await this.#currentPlacement(pid, flags);
    const art = await this.#artifactFacts(artifact);

    const meta = await this.#opts.backend.modelMeta(artifact.runtimeAlias);
    const slot = await this.#opts.backend.slotParams().catch(() => null);
    let props: { chat_template?: string } = {};
    try {
      props = await this.#opts.backend.props();
    } catch {
      // Template identity degrades; nothing else depends on it here.
    }

    const tokenizer: TokenizerIdentity = resolveTokenizerIdentity({
      artifactTokenizer: art.tokenizerMetadata,
      runtimeVocabSize: meta.vocabSize,
      runtimeBuild: build,
      artifactAttested: attested,
      now,
    });
    const tokenizerWithReadFailure: TokenizerIdentity =
      art.readFailure === null
        ? tokenizer
        : { ...tokenizer, unprovenReasons: [...tokenizer.unprovenReasons, art.readFailure] };

    const template: TemplateFacts = resolveTemplateFacts({
      runtimeTemplate: props.chat_template ?? null,
      artifactTemplateDigest: art.tokenizerMetadata?.chatTemplateDigest ?? null,
      effectiveChatFormat: slot?.chatFormat ?? null,
      effectiveReasoningFormat: slot?.reasoningFormat ?? null,
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

    const attestation = attestationFor(binding, attested, tokenizerWithReadFailure, now().toISOString());

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
      imageDigest: null, imageDigestBinding: 'unavailable', imageComponents: [],
      driverVersion: null, driverSupportedCuda: null, processCudaRuntime: null,
      cublasVersion: null, limitation: 'no backend was contacted',
    },
    tokenizer: null,
    template: { requested: null, effective: null, mismatch: null },
    backendInstance: {
      provenance: 'observed', observedAt, pid: null, bootId: null,
      kernelStartTicks: null, startedAt: null, instanceId: null,
      unavailableReasons: ['no backend was contacted'],
    },
    placement: {
      provenance: 'observed', observedAt, method: 'unavailable',
      backendPid: null, backendHoldsDevice: null, backendVramMiB: null,
      requestedGpuLayers: null, cpuOffloadEnabled: null,
      limitation: 'no backend was contacted',
    },
    attestation: {
      binding,
      bindingDigest: bindingDigest(binding),
      completeness: 'unattested',
      missing: ['everything: no backend was contacted'],
      observedAt,
    },
  };
}
