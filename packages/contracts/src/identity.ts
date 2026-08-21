/**
 * Artifact and runtime identity.
 *
 * Bokahli is the authority for exact served identity. The public identity of a
 * model is ALWAYS a stable catalog id — never a filesystem path. The backend
 * (llama-server) reports its model as a path; that value is an internal
 * implementation detail and must never cross the Bokahli API boundary.
 */
import type { StructuredOutputConfirmation } from './structured-output.js';


import type {
  BackendInstanceIdentity, DevicePlacement, QualificationAttestation, RuntimeInvocation,
  RuntimeFacts, TemplateFacts, TokenizerIdentity,
} from './attestation.js';

/** Stable, public, path-free model identity. Example: "qwen3.5-35b-a3b.q2_k". */
export type ModelId = string;

/** Content digest of the on-disk artifact, formatted "sha256:<64 hex>". */
export type ArtifactDigest = string;

export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * A model id is rejected if it looks like a filesystem path or an artifact
 * filename. This is a hard boundary, not a style preference: accepting a path
 * as public identity is the exact defect Bokahli exists to correct.
 */
export function isPathLike(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    /\.(gguf|safetensors|bin|pt|onnx)$/i.test(value)
  );
}

export function isValidModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && !isPathLike(value) && MODEL_ID_PATTERN.test(value);
}

export function isValidDigest(value: unknown): value is ArtifactDigest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/**
 * Qualification is Luak's authority, not Bokahli's. Phase 1 ships exactly one
 * state. Bokahli must never synthesise a qualification, a score, or a task-class
 * claim; absence of Luak evidence means UNQUALIFIED, full stop.
 */
export type QualificationStatus = 'INSTALLED_UNQUALIFIED' | 'QUALIFIED' | 'DISQUALIFIED';

export interface Qualification {
  readonly status: QualificationStatus;
  /** Authority that issued the state. Only Luak may issue QUALIFIED. */
  readonly authority: 'luak' | 'none';
  /** Reference to the Luak evidence record. Null while unqualified. */
  readonly evidenceRef: string | null;
  /** Task classes the artifact is qualified for. Always empty unless QUALIFIED. */
  readonly qualifiedTaskClasses: readonly string[];
  readonly note: string;
}

/** Immutable facts about the artifact on disk. */
export interface ArtifactFacts {
  readonly format: 'gguf';
  readonly architecture: string;
  readonly quantization: string;
  readonly sizeBytes: number;
  readonly parameterCount: number;
  /** Active parameters per token for MoE architectures; null for dense. */
  readonly activeParameterCount: number | null;
  readonly expertCount: number | null;
  readonly expertUsedCount: number | null;
  readonly contextTrainTokens: number;
  readonly vocabSize: number;
  readonly embeddingLength: number;
}

/** Capabilities the artifact structurally supports, as measured — not as advertised. */
export interface ArtifactCapabilities {
  readonly chat: boolean;
  readonly completion: boolean;
  readonly tools: boolean;
  readonly vision: boolean;
  readonly audio: boolean;
  readonly embedding: boolean;
  readonly reasoningEffort: boolean;
}

/** A catalog entry: the public, stable description of one installed artifact. */
export interface CatalogEntry {
  readonly modelId: ModelId;
  readonly displayName: string;
  readonly digest: ArtifactDigest;
  readonly facts: ArtifactFacts;
  readonly capabilities: ArtifactCapabilities;
  readonly qualification: Qualification;
  /** Operational limits proven by measurement, not by specification. */
  readonly operational: {
    readonly servedContextTokens: number;
    readonly maxConcurrentRequests: number;
    readonly measuredAt: string | null;
    /**
     * What loading this artifact costs, measured.
     *
     * Null means nobody has timed it, and null means *unknown* rather than
     * cheap. A `LOCAL_MODEL_SWAP_REQUIRED` escalation carries these so the
     * decision to swap is made against a number instead of a guess.
     */
    readonly coldLoadSeconds?: number | null;
    readonly vramMiB?: number | null;
    readonly hostRssGiB?: number | null;
    readonly decodeTokensPerSecond?: number | null;
    readonly prefillTokensPerSecond?: number | null;
  };
}

/**
 * The operational facts a qualification authority needs, with their provenance.
 *
 * Added in Phase B2 and required, not optional. Optional would have meant the
 * server could forget to populate it and nothing would notice until an export
 * failed months later; required means the type system asks the question at
 * every construction site — of which there is exactly one.
 */
export interface QualificationFacts {
  readonly contractVersion: 'bokahli.qualification-telemetry.v1';
  readonly runtime: RuntimeFacts;
  /** Null when tokenizer identity could not be established at all. */
  readonly tokenizer: TokenizerIdentity | null;
  readonly template: TemplateFacts;
  readonly backendInstance: BackendInstanceIdentity;
  readonly placement: DevicePlacement;
  /**
   * Whether this instance genuinely constrains generation when asked to.
   *
   * Null when the confirmation probe has not run. `response_format` is a
   * request and llama-server exposes no field saying it applied one, so this is
   * behavioural — see `confirmStructuredOutput`. It belongs to the *instance*,
   * not to a request: a deployment either constrains or it does not, and a
   * per-request claim would be the same fact re-asserted with no new evidence.
   */
  readonly structuredOutput: StructuredOutputConfirmation | null;
  /**
   * The flags the backend process was started with, read from its own argv.
   *
   * Requested, never observed. A placement profile is exactly this set, and a
   * throughput number with no configuration attached is a number about nothing.
   */
  readonly runtimeInvocation: RuntimeInvocation;
  readonly attestation: QualificationAttestation;
}

/** What was actually served, attested by Bokahli against the live backend. */
export interface ServedIdentity {
  readonly modelId: ModelId;
  readonly digest: ArtifactDigest;
  readonly runtime: RuntimeIdentity;
  readonly servedContextTokens: number;
  readonly qualification: Qualification;
  /** True only if the live backend was verified to be serving this exact artifact. */
  readonly attested: boolean;
  readonly attestationMethod: 'backend-props-match' | 'unverified';
  /** Phase B2. Tokenizer, template, sampler, instance and placement provenance. */
  readonly qualificationFacts: QualificationFacts;
}

export interface RuntimeIdentity {
  readonly engine: 'llama.cpp';
  /** Pinned build, e.g. "b10505-ee4c505a4". */
  readonly build: string;
  /**
   * Digest of the serving image.
   *
   * Composite over the executable and the build tree's shared objects, because
   * `llama-server` on this host is a 12 KB stub and the CUDA backend that does
   * the work is a separate 44 MB object — a digest of the stub alone would
   * survive a full rebuild and prove nothing while looking like proof.
   *
   * Populated in Phase B2. Was hardcoded null before, which is why the field
   * existed in the type and never in fact.
   */
  readonly executableDigest: ArtifactDigest | null;
  /**
   * CUDA runtime the serving process has loaded — not the version the driver
   * advertises it could support. Those are different facts and this is the one
   * that describes the inference. See `RuntimeFacts` for both.
   */
  readonly cuda: string | null;
  readonly driver: string | null;
}
