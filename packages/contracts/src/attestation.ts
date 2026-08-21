/**
 * Operational facts a qualification authority needs, and their provenance.
 *
 * Phase 1 attested *which artifact* was served. That is necessary and not
 * sufficient: Luak refused to export the six-attempt pilot because Bokahli
 * returned token counts without saying which tokenizer produced them, and a
 * count whose tokenizer is unknown is a number, not a measurement.
 *
 * The rule every type here follows is that a fact carries how it was obtained.
 * Four provenance classes, and the difference between them is the difference
 * between evidence and decoration:
 *
 *   declared          Configuration says so. Bokahli was told.
 *   requested         Bokahli asked for it. Nothing confirms it took effect.
 *   runtime-reported  The serving process said so, in response to a query.
 *   observed          Bokahli measured it from an independent source — the
 *                     kernel, the driver, or the artifact's own bytes.
 *
 * `declared` and `requested` are the weak ones, and they are exactly the ones
 * that look strongest in a report. `--n-gpu-layers 999` is a request; a driver
 * that lists our pid holding VRAM is an observation. A field that cannot say
 * which of those it is will eventually be read as the stronger one.
 *
 * Nothing here is ever guessed. Where a fact cannot be established the field is
 * null and a sibling explains why, because a null with a reason is diagnosable
 * and a plausible default is not.
 */
import type { TokenizerCanaryResult } from './canary.js';
import type { ArtifactDigest, ModelId } from './identity.js';

/** How a fact was obtained. See the module comment. */
export type FactProvenance = 'declared' | 'requested' | 'runtime-reported' | 'observed';

/** Present on every observation that can go stale. */
export interface Observed {
  readonly provenance: FactProvenance;
  /** ISO-8601. When the observation was taken, not when it was serialised. */
  readonly observedAt: string;
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

/**
 * Where a token count came from.
 *
 * Shared verbatim with Luak's ladder. Only the first supports a qualification
 * export, and the second exists so that "the runtime counted but would not say
 * with what" is a distinct, visible state rather than being rounded up to a
 * measurement or down to an estimate.
 */
export type TokenCountSource =
  | 'runtime_tokenizer'
  | 'runtime_reported_unknown_tokenizer'
  | 'estimated'
  | 'unknown';

/**
 * What the runtime itself said about the tokenizer it loaded.
 *
 * This exists because the audit of 4d8ced6 broke the previous proof. That
 * version established tokenizer identity entirely from the artifact's bytes and
 * bound it to the runtime with one number: vocabulary size. Equal sizes are
 * *consistent* with the runtime having loaded the file we hashed. They are not
 * evidence of it, and llama.cpp's `--override-kv` makes the gap concrete —
 * it replaces GGUF metadata at load time without touching the file, so the
 * digest matches, the path matches, attestation passes, the size is unchanged,
 * and the tokenizer actually splitting text is not the one we described.
 *
 * So the binding is now behavioural. Bokahli asks the running server to
 * detokenize a fixed set of ids and compares what comes back, byte for byte,
 * against the token table in the artifact it verified. That reads the
 * vocabulary the process actually loaded rather than the one the file declares.
 */
export interface RuntimeTokenizerProof {
  /**
   * `runtime-vocab-probe` is the decode-only form f270ee9 shipped. It is
   * retained as a value, not as an acceptable one: it proves ids decode to the
   * expected bytes and says nothing about how text is encoded into ids, so it
   * can never reach `encodeCanaryVerified` and therefore never supports a
   * `runtime_tokenizer` claim. `runtime-canary-probe` is the two-sided form.
   */
  readonly method: 'runtime-vocab-probe' | 'runtime-canary-probe';
  /** Whether every sampled id round-tripped to the artifact's own token text. */
  readonly matches: boolean;
  readonly samplesChecked: number;
  readonly samplesMatched: number;
  /**
   * sha256 of the token ids the runtime produced for a fixed probe string.
   *
   * Not a proof that the pre-tokenizer equals the one the file declares —
   * confirming that would need a byte-level BPE implementation here, and a
   * second implementation of a tokenizer is a second thing that can be wrong.
   * What it does give is comparability: any change in how this deployment
   * segments text shows up as an identity change between runs, which is the
   * property qualification evidence actually depends on.
   */
  readonly segmentationDigest: string | null;
  /** The backend instance the probe ran against. A probe is about one process. */
  readonly backendInstanceId: string | null;
  readonly observedAt: string;
  readonly detail: string | null;
  /**
   * The two-sided canary. Null when no suite is pinned for this artifact.
   *
   * A null here is the honest state of an artifact that has been installed but
   * not prepared: the decode probe above may still have run and matched, and
   * that is still not tokenizer identity.
   */
  readonly canary: TokenizerCanaryResult | null;
}

/**
 * Identity of the tokenizer that produced the counts.
 *
 * `runtime_tokenizer` is claimable only when every one of these holds:
 *
 *   1. the backend was attested to be serving this artifact,
 *   2. the tokenizer is identified by content — `metadataDigest` hashes the
 *      vocabulary, merges, token types, pre-tokenizer and special ids, so two
 *      builds that both call themselves "gpt2" and split differently cannot
 *      collide,
 *   3. the file's declared pre-tokenizer is present, since without it the
 *      segmentation rule is unnamed,
 *   4. the runtime **decoded** the sampled ids to the artifact's own bytes,
 *   5. the runtime **encoded** the pinned canary corpus to the pinned ids, and
 *   6. both were observed against *this* backend instance.
 *
 * 5 is the condition f270ee9 lacked. Its proof ran only in the decode
 * direction, and the direction that produces `usage.prompt_tokens` is the other
 * one. A load-time override of merges, of the pre-tokenizer, or of added-token
 * handling leaves every decode sample passing and changes every count.
 *
 * `vocabSizeMatch` is retained as supporting evidence and is not sufficient on
 * its own; a disagreement still refuses, but agreement no longer proves.
 */
export interface TokenizerIdentity extends Observed {
  /** `tokenizer.ggml.model` from the artifact, e.g. "gpt2" for byte-level BPE. */
  readonly family: string | null;
  /** `tokenizer.ggml.pre`, the pre-tokenizer variant, e.g. "qwen35". */
  readonly pretokenizer: string | null;
  /** Vocabulary size as counted in the verified artifact. */
  readonly vocabSize: number | null;
  /** Vocabulary size the running backend reports for the loaded model. */
  readonly runtimeVocabSize: number | null;
  /**
   * Whether those two agree. Supporting evidence only.
   *
   * Disagreement refuses; agreement proves nothing, because two different
   * tokenizers can have identical vocabulary sizes and one of them is exactly
   * what a substitution would look like.
   */
  readonly vocabSizeMatch: boolean | null;
  /** The behavioural binding. Null when no probe was taken. */
  readonly runtimeProof: RuntimeTokenizerProof | null;
  /**
   * Whether the pre-tokenizer the artifact declares was confirmed in the
   * runtime.
   *
   * True when the encode canary passed: a changed pre-tokenizer changes where
   * text splits, and the corpus is chosen so that it does. This is a
   * *behavioural* confirmation over a finite corpus, not a proof that the two
   * implementations are the same function — see `TokenizerCanaryResult`.
   */
  readonly pretokenizerVerified: boolean;
  // -- the seven distinguished attestation facts --------------------------
  //
  // Kept as separate top-level booleans rather than folded into one verdict,
  // because every collapse in this file's history has been a downgrade
  // presented as a simplification. A reader asking "was encoding checked?"
  // must not have to infer it from a composite.
  /**
   * The file-side identity is bound to the artifact the backend was attested to
   * be serving: content digest, family and pre-tokenizer all present, on an
   * attested artifact. Necessary, and on its own worth nothing — every
   * `--override-kv` attack in the audit passes this.
   */
  readonly metadataBound: boolean;
  /** Sampled `token id -> bytes` matched the artifact's own table. */
  readonly decodeCanaryVerified: boolean;
  /**
   * Every pinned `bytes -> token ids` case matched.
   *
   * This is the direction `usage.prompt_tokens` comes from, and the one
   * f270ee9 never checked.
   */
  readonly encodeCanaryVerified: boolean;
  readonly canarySuiteId: string | null;
  readonly canarySuiteHash: string | null;
  /** The backend instance the canary ran against. */
  readonly verifiedBackendInstanceId: string | null;
  readonly verifiedAt: string | null;
  /**
   * sha256 over the tokenizer-defining metadata: family, pre-tokenizer, the
   * full token list, the merge list, token types, and the special token ids.
   * Content-derived, so it is stable across renames and sensitive to any change
   * that would alter how text is split.
   */
  readonly metadataDigest: ArtifactDigest | null;
  /**
   * Which component tokenized.
   *
   * Derived from `runtimeProof`, never asserted. It was a hardcoded literal in
   * 4d8ced6, which made the condition that checked it unfalsifiable — a test
   * that cannot fail is not a check.
   */
  readonly tokenizedBy: 'runtime' | 'unknown';
  /** Build of the process that did the tokenizing. */
  readonly runtimeBuild: string | null;
  /** Why the provenance verdict is what it is. Empty when fully proven. */
  readonly unprovenReasons: readonly string[];
}

/**
 * Per-count provenance.
 *
 * Prompt and completion counts are separate because they can have different
 * provenance: a runtime may report generated tokens exactly while the prompt
 * count is affected by cache reuse. Collapsing them would let the weaker of the
 * two hide behind the stronger.
 */
export interface TokenCountFacts {
  readonly source: TokenCountSource;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly promptTokenSource: TokenCountSource;
  readonly completionTokenSource: TokenCountSource;
  readonly tokenizer: TokenizerIdentity | null;
}

// ---------------------------------------------------------------------------
// prompt template
// ---------------------------------------------------------------------------

/**
 * Which chat template turned messages into a prompt, and who applied it.
 *
 * Requested and effective are separate fields because on this deployment they
 * genuinely differ: the unit starts llama-server with `--reasoning off`, and
 * the running slot reports `reasoning_format: "deepseek"` with a generation
 * prompt that injects an empty thinking block. Whatever the cause, a contract
 * that had only one field would have had to pick one to report, and would have
 * reported the wrong one.
 *
 * `templateDigest` hashes the template text. `templateId` is the runtime's name
 * for the format it selected. The digest is the identity; the name is a label,
 * and labels are reused across incompatible templates.
 */
export interface TemplateIdentity extends Observed {
  /** Who turned messages into a prompt string. */
  readonly appliedBy: 'runtime' | 'bokahli' | 'client' | 'none' | 'unknown';
  /** Runtime's name for the chat format it selected, e.g. "peg-native". */
  readonly templateId: string | null;
  /** sha256 of the template text, when the text is available. */
  readonly templateDigest: ArtifactDigest | null;
  /** Template name the runtime reports, when it reports one. */
  readonly runtimeTemplateName: string | null;
  /** Reasoning format in effect, e.g. "none", "deepseek". */
  readonly reasoningFormat: string | null;
  /**
   * Whether the template in the artifact is byte-identical to the one the
   * runtime reports. This is the proof that the model's own template was
   * applied rather than a substitute the runtime chose.
   */
  readonly matchesArtifactTemplate: boolean | null;
  /** Whether a template was actually applied to this request. */
  readonly applied: boolean | null;
}

/**
 * Four template tiers, kept apart because they are four different claims.
 *
 * 4d8ced6 had two and set `applied: true` whenever the runtime reported a
 * template at all. That is a configuration fact wearing an application claim: a
 * client that pre-formats its own prompt bypasses templating entirely and
 * `/props` does not change, so "the runtime holds this template" and "this
 * template was applied to this request" are independent.
 */
export interface TemplateFacts {
  /** What Bokahli asked for. Null when it asked for nothing and took the default. */
  readonly requested: TemplateIdentity | null;
  /** What the backend is configured with, from `/props`. Not per-request. */
  readonly configured: TemplateIdentity | null;
  /**
   * What an uncorrelated `/slots` reading reports. Backend-instance scope, for
   * the same reason the sampler's effective reading is.
   */
  readonly effective: TemplateIdentity | null;
  /**
   * What was confirmed for *this* request. Always null on the current
   * llama.cpp API, which offers no correlation handle.
   */
  readonly requestConfirmed: TemplateIdentity | null;
  /** True only when a requested and an effective identity are known and differ. */
  readonly mismatch: boolean | null;
  /**
   * The runtime is applying a reasoning format other than the one it was
   * started with. Observed on this deployment: the unit passes `--reasoning off`
   * and a live slot reports `deepseek`. Kept as its own flag so it cannot be
   * flattened into the template-matches verdict, which is separately true.
   */
  readonly reasoningFormatOverridden: boolean | null;
}

// ---------------------------------------------------------------------------
// sampler
// ---------------------------------------------------------------------------

/**
 * Sampler settings, bounded.
 *
 * Every field optional so that a client that sends none behaves exactly as it
 * did in Phase 1. Malformed values are rejected rather than coerced: a
 * `temperature` of "hot" is a 400, because silently substituting a default
 * would make the response unattributable to any requested configuration.
 */
export interface SamplerConfig {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly seed?: number;
  readonly maxTokens?: number;
}

/** Whether a seed reached the runtime, and whether anything confirms it. */
export type SeedSupport =
  /** The runtime has no seed parameter Bokahli can use. */
  | 'unavailable'
  /**
   * Bokahli sent one and nothing authoritative confirmed it for this request.
   *
   * This is the honest terminal state on the current llama.cpp API. `honoured`
   * needs an echo that is provably about *this* generation, and no field in the
   * chat response identifies the slot or task that served it. An uncorrelated
   * `/slots` reading that happens to show the same number is a coincidence with
   * good odds, not a confirmation.
   */
  | 'requested'
  /** The runtime echoed this request's seed, correlated to this generation. */
  | 'honoured'
  /** The runtime echoed a different seed for this generation. */
  | 'overridden'
  /** No seed was requested. */
  | 'not_requested';

/**
 * The three sampler records, kept apart on purpose.
 *
 * `requested` is the client's ask. `sent` is what Bokahli put on the wire —
 * which differs from `requested` whenever a Phase 1 default fills a gap.
 * `effective` is what the runtime says it used, and it is the only one that is
 * evidence. A sampler is never reported as honoured because Bokahli sent it;
 * sending is a request, and the whole point of this file is that requests are
 * not observations.
 */
export interface SamplerFacts {
  readonly requested: SamplerConfig;
  readonly sent: SamplerConfig;
  /**
   * What the runtime reports it used — for the *backend*, not for this request.
   *
   * `/slots` reports whatever the slot last held, and llama.cpp's
   * OpenAI-compatible response returns no slot or task id, so there is no handle
   * to correlate an observation to a generation. A one-slot configuration
   * narrows the window; it does not create a correlation, and 4d8ced6 treated
   * narrowing as correlating.
   */
  readonly effective: SamplerConfig | null;
  readonly effectiveSource: 'runtime-slots-uncorrelated' | 'unavailable';
  /**
   * What the effective reading actually describes.
   *
   * `backend-instance` until llama.cpp exposes a correlation handle. Nothing may
   * label these facts `request` without one.
   */
  readonly effectiveScope: 'backend-instance' | 'request';
  readonly seedSupport: SeedSupport;
  /**
   * Deterministic settings are not a promise of identical output.
   *
   * Measured on this deployment: at temperature 0 the same prompt produced 68,
   * 53 and 68 completion tokens across three attempts. The artifact is a
   * 256-expert MoE served with `--cpu-moe`, and expert routing, batching and
   * kernel reduction order are all free to vary between runs. Bokahli states
   * the configuration; only repeated execution can measure repeatability, and
   * that is Luak's job.
   */
  readonly deterministicOutputGuaranteed: false;
}

// ---------------------------------------------------------------------------
// backend instance
// ---------------------------------------------------------------------------

/**
 * Which backend *process* served this, not merely which build.
 *
 * A restart that comes back on the same build is invisible to build-level
 * identity, and it must not be: attempts either side of it ran against
 * different loaded weights, different KV cache, and possibly different device
 * placement, while claiming one identity.
 *
 * `instanceId` hashes boot id, pid and the kernel's own process start time.
 * Pid alone is not enough — pids are reused, and a reused pid would make a
 * fresh process look like the original. The kernel start time is in ticks since
 * boot and is not wall-clock, so it does not move when the clock is adjusted;
 * the boot id makes it meaningful across reboots.
 */
export interface BackendInstanceIdentity extends Observed {
  readonly pid: number | null;
  /** Kernel boot identifier. Changes on every boot. */
  readonly bootId: string | null;
  /** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
  readonly kernelStartTicks: number | null;
  /** Start time as an instant, derived from boot time plus ticks. Never guessed. */
  readonly startedAt: string | null;
  /** sha256 of bootId, pid and kernelStartTicks. Stable for one process only. */
  readonly instanceId: string | null;
  /** Why identity could not be established. Empty when it could. */
  readonly unavailableReasons: readonly string[];
}

/**
 * How the backend process was started, read from its own argv.
 *
 * Requested, never observed — that distinction is the whole reason this exists
 * separately from everything else. `--n-gpu-layers 999` is what was asked for;
 * `DevicePlacement.backendHoldsDevice` is what happened, and Phase 1 learned the
 * hard way that they can disagree for hours without anything noticing.
 *
 * Reasoning mode is here for the same reason and a sharper one. `--reasoning
 * off` changes the *generation prompt* — on Qwen3.5 it injects an empty think
 * block — so a model measured with reasoning suppressed has not been measured
 * with it available. The runtime does not report the flag back: `/slots` shows
 * `reasoning_format: "deepseek"`, which is the parser that would extract think
 * tags, not a statement about whether thinking was enabled. Reading the flag
 * from argv is the only way to know what was asked for, and a campaign that
 * recorded the parser name instead would be recording a different fact under
 * the right label.
 *
 * Values only, never strings lifted from the process. A raw command line can
 * carry an API key or a model path, and none of that may reach a response; the
 * reasoning mode is admitted as a string because it is drawn from a closed set
 * of three known values and anything else is reported as unrecognised.
 */
export interface RuntimeInvocation extends Observed {
  readonly requestedGpuLayers: number | null;
  readonly cpuOffloadEnabled: boolean | null;
  /** `--n-cpu-moe N`: how many layers' experts were held off-device. */
  readonly cpuMoeLayers: number | null;
  /** `--reasoning on|off|auto`, or null when the flag was absent. */
  readonly requestedReasoning: 'on' | 'off' | 'auto' | null;
  /** `--flash-attn on|off|auto`, or null when absent. */
  readonly flashAttention: string | null;
  /** `--ctx-size`. The configured window, distinct from what a request used. */
  readonly requestedContextTokens: number | null;
  /** `--parallel`. Slots the process was started with. */
  readonly requestedSlots: number | null;
  /** Why the argv could not be read, when it could not. */
  readonly limitation: string | null;
}

// ---------------------------------------------------------------------------
// device placement
// ---------------------------------------------------------------------------

/**
 * Where *our backend* is resident — not what the GPU as a whole is doing.
 *
 * Whole-GPU utilisation is appliance telemetry. It cannot answer the question
 * qualification actually asks, because a busy GPU says nothing about whether
 * our process is on it: a CPU-only llama-server serving the correct artifact
 * attests perfectly and runs at roughly a third of the decode rate, while some
 * other process lights up the utilisation graph. That was a real Phase 1
 * failure mode, and it is why these fields are separate from `GpuSnapshot`.
 *
 * The authoritative question is whether the driver lists our exact pid as
 * holding a compute allocation. That is the same check
 * `scripts/assert-gpu-placement.sh` makes at service start, deliberately, so
 * there is one definition of "placed" rather than two that can disagree.
 */
export interface DevicePlacement extends Observed {
  /** How the observation was made. */
  readonly method: 'nvidia-smi-compute-apps' | 'unavailable';
  readonly backendPid: number | null;
  /** True only when the driver lists this exact pid holding a compute allocation. */
  readonly backendHoldsDevice: boolean | null;
  /** VRAM the driver attributes to this pid. Null when not authoritative. */
  readonly backendVramMiB: number | null;
  /**
   * Floor a listing must clear to count as placement, in MiB.
   *
   * Shared with `scripts/assert-gpu-placement.sh`. A process can appear in the
   * driver's compute table holding almost nothing; the service assertion has
   * always required a real allocation, and the API accepting a bare listing
   * meant the two could disagree about the same backend while the API decided
   * whether evidence was valid.
   */
  readonly floorMiB: number;
  /** `--n-gpu-layers` as started. A request, never a measurement. */
  readonly requestedGpuLayers: number | null;
  /** `--cpu-moe`: expert tensors deliberately kept in system RAM. */
  readonly cpuOffloadEnabled: boolean | null;
  /**
   * What could not be established, stated rather than estimated. On this host
   * the driver reports per-process VRAM, so this is usually empty; when the
   * driver stops reporting it, this says so instead of a plausible number
   * appearing.
   */
  readonly limitation: string | null;
}

// ---------------------------------------------------------------------------
// runtime facts
// ---------------------------------------------------------------------------

/**
 * What the serving binary actually is, and what CUDA it actually uses.
 *
 * Two CUDA versions, because they are two different facts and reporting one as
 * the other is how a driver capability becomes a false claim about the running
 * process. `driverSupportedCuda` is the highest the installed driver could
 * support. `processCudaRuntime` is the CUDA runtime library the serving process
 * has actually loaded. On this host they differ, and the second is the one that
 * describes the inference.
 *
 * `imageDigest` is not the digest of `llama-server`. That file is a 12 KB stub;
 * the entire CUDA backend lives in shared objects beside it, so hashing the
 * stub alone would be a digest that survives a full rebuild of the code that
 * does the work. The digest covers the stub and every build-tree object the
 * runtime loads, identified by basename so no path is disclosed.
 */
/**
 * How strongly an image digest is tied to the process that is serving.
 *
 * Ordered, and the order matters: nothing may present a weaker binding as a
 * stronger one. The binding is mixed into the digest itself, so a
 * `configured-tree` digest and a `process-mapped` digest over the same files do
 * not collide — in 4d8ced6 they did, which meant the strength label could be
 * dropped without the value changing and nobody would notice.
 */
export type ImageDigestBinding =
  /** The object list came from the process. The strong form. */
  | 'process-mapped'
  /** The build tree the process names in its argv. Proves what is on disk. */
  | 'configured-tree'
  /** Only the executable could be hashed; the shared objects could not. */
  | 'executable-only'
  | 'unavailable';

export interface RuntimeFacts extends Observed {
  readonly engine: 'llama.cpp';
  readonly build: string | null;
  /** Composite digest over the serving image. See above for why it is composite. */
  readonly imageDigest: ArtifactDigest | null;
  /**
   * How the image digest was bound to the running process.
   *
   * `process-mapped` reads the object list from the process itself and is the
   * strong form. `configured-tree` hashes the build tree Bokahli is configured
   * to use, which proves what is on disk but not what this process mapped —
   * measured: under the API's own systemd sandbox `/proc/<pid>/maps` and
   * `/proc/<pid>/exe` are both denied while `cmdline` and `stat` are readable,
   * so the strong form is unavailable in production and the weaker one must
   * announce itself.
   */
  readonly imageDigestBinding: ImageDigestBinding;
  /** Algorithm version, so a change in how the digest is computed is visible. */
  readonly imageDigestAlgorithm: 'bokahli.runtime-image.v2' | null;
  /** Basenames of the hashed objects. Never paths. */
  readonly imageComponents: readonly string[];
  readonly driverVersion: string | null;
  /** Highest CUDA the driver supports. A capability, not a usage. */
  readonly driverSupportedCuda: string | null;
  /** CUDA runtime the serving process has loaded. The one that matters. */
  readonly processCudaRuntime: string | null;
  readonly cublasVersion: string | null;
  readonly limitation: string | null;
}

// ---------------------------------------------------------------------------
// attestation
// ---------------------------------------------------------------------------

/**
 * The immutable half of served identity.
 *
 * Everything bound here is a property of *what was serving*, and none of it
 * varies between two requests to the same backend instance. GPU utilisation and
 * temperature are deliberately absent: they change second to second, and
 * including them would make the attestation digest change constantly, which
 * trains a reader to ignore changes — the opposite of what a digest is for.
 *
 * The digest is over this object alone. It changes when the model, the artifact
 * bytes, the build, the serving image, the tokenizer, the effective template,
 * the backend process, or the placement observation changes — and a backend
 * restart changes `backendInstance`, so prior attestation is invalidated by
 * construction rather than by anyone remembering to invalidate it.
 */
export interface AttestedIdentityBinding {
  readonly modelId: ModelId;
  readonly artifactDigest: ArtifactDigest;
  readonly runtimeBuild: string | null;
  readonly imageDigest: ArtifactDigest | null;
  readonly tokenizerDigest: ArtifactDigest | null;
  readonly effectiveTemplateDigest: ArtifactDigest | null;
  readonly backendInstanceId: string | null;
  /** The placement *verdict*, not the volatile numbers behind it. */
  readonly devicePlacement: {
    readonly backendHoldsDevice: boolean | null;
    readonly cpuOffloadEnabled: boolean | null;
    readonly requestedGpuLayers: number | null;
  };
  readonly servedContextTokens: number | null;
  readonly maxConcurrentRequests: number | null;
  /**
   * Only sampler settings the runtime confirmed. A requested-but-unconfirmed
   * sampler is not part of identity, because binding it would attest to
   * something no one checked.
   */
  readonly confirmedSampler: SamplerConfig | null;
}

/** How complete the attestation is, and therefore what may be built on it. */
export type AttestationCompleteness =
  /** Every bound component established. Sufficient for qualification evidence. */
  | 'complete'
  /** Identity proven, some operational facts unavailable. Usable, not exportable. */
  | 'partial'
  /** Identity itself unproven. */
  | 'unattested';

export interface QualificationAttestation {
  readonly binding: AttestedIdentityBinding;
  /** sha256 over the canonical form of `binding`. */
  readonly bindingDigest: ArtifactDigest;
  readonly completeness: AttestationCompleteness;
  /** Components that are null and why. Empty when complete. */
  readonly missing: readonly string[];
  readonly observedAt: string;
  /**
   * Monotonic counter, incremented whenever the backend instance changes.
   *
   * Makes "this attestation is from a later observation" answerable without
   * comparing timestamps, and makes a stale attestation reused across instances
   * detectable rather than merely unlikely.
   */
  readonly generation: number;
  /** After this instant the observations behind it must be refreshed. */
  readonly expiresAt: string;
  /**
   * The backend instance every observation here was taken against.
   *
   * Telemetry from one instance must never be presented for another. This is
   * the field that makes copying detectable.
   */
  readonly backendInstanceId: string | null;
}

// ---------------------------------------------------------------------------
// attempt lifetime
// ---------------------------------------------------------------------------

/**
 * Whether the evidence behind one request survived the request.
 *
 * An attestation is a photograph. f270ee9 gave it a 60-second expiry, which
 * made staleness visible and left two questions unanswered: what happens when a
 * request that was admitted under valid evidence takes longer than 60 seconds,
 * and what happens when the backend restarts while it runs.
 *
 * Both matter here rather than in theory. A 32K prefill on this deployment
 * measures 88.5 seconds at the 65536 tier and tens of seconds at 32768; long
 * requests are the normal case, not the edge. Two wrong answers were available:
 *
 *   - refuse anything that crosses the TTL, which discards a correct answer
 *     because a clock advanced, and loses attribution for exactly the longest
 *     and most expensive requests;
 *   - ignore the TTL at completion, which accepts an answer produced by a
 *     process that is no longer the process that was attested.
 *
 * The distinction that resolves it is not elapsed time but *continuity*. A
 * backend that never restarted is still the backend that was attested, however
 * long the request took. A backend that restarted is a different process, and
 * an answer it produced is infrastructure-invalid no matter how good it looks —
 * a restart mid-request means a fresh context, an unattested load, and an
 * unknown placement.
 */
export type AttemptValidity =
  /** Admitted under valid evidence, completed by the same backend instance. */
  | 'valid'
  /**
   * The output may be perfectly good and it cannot be attributed. Not a model
   * failure and not an error the caller caused: qualification must be able to
   * discard it without scoring it against the model.
   */
  | 'infrastructure-invalid';

export interface AttemptLifetime {
  readonly admittedAt: string;
  readonly completedAt: string;
  /** When the evidence behind this attempt was observed, and when it lapses. */
  readonly attestationObservedAt: string;
  readonly attestationExpiresAt: string;
  readonly instanceAtAdmission: string | null;
  readonly instanceAtCompletion: string | null;
  /** Evidence had not already lapsed when the request was admitted. */
  readonly attestationValidAtAdmission: boolean;
  /**
   * The request outlived its attestation's TTL. Not a fault on its own — see
   * `revalidation` for what carries it across.
   */
  readonly crossedAttestationTtl: boolean;
  /** Same backend process at admission and at completion, both known. */
  readonly instanceContinuous: boolean;
  /**
   * How evidence was carried past the TTL.
   *
   * `instance-continuity` is the cheap proof and the sufficient one: the
   * process that was attested is the process that answered. `none` means the
   * TTL was never crossed and nothing needed carrying.
   */
  readonly revalidation: 'none' | 'instance-continuity';
  readonly verdict: AttemptValidity;
  readonly reasons: readonly string[];
}
