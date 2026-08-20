/**
 * Artifact and runtime identity.
 *
 * Bokahli is the authority for exact served identity. The public identity of a
 * model is ALWAYS a stable catalog id — never a filesystem path. The backend
 * (llama-server) reports its model as a path; that value is an internal
 * implementation detail and must never cross the Bokahli API boundary.
 */

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
  };
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
}

export interface RuntimeIdentity {
  readonly engine: 'llama.cpp';
  /** Pinned build, e.g. "b10505-ee4c505a4". */
  readonly build: string;
  readonly executableDigest: ArtifactDigest | null;
  readonly cuda: string | null;
  readonly driver: string | null;
}
