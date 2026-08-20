import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import {
  DIGEST_PATTERN,
  EMPTY_LUAK_EVIDENCE,
  isPathLike,
  isValidDigest,
  isValidModelId,
  type ArtifactCapabilities,
  type ArtifactDigest,
  type ArtifactFacts,
  type CatalogEntry,
  type LuakEvidenceSet,
  type ModelId,
  type Qualification,
} from '@bokahli/contracts';

/**
 * Internal artifact record. Carries the filesystem path, which is why it is
 * never returned from a public method. `toPublic()` is the only way out, and it
 * structurally cannot emit the path.
 */
export interface InternalArtifact {
  readonly modelId: ModelId;
  readonly displayName: string;
  readonly digest: ArtifactDigest;
  /** INTERNAL ONLY. Must never be serialised to an API response. */
  readonly artifactPath: string;
  /** Alias the backend is started with; used to attest served identity. */
  readonly runtimeAlias: string;
  readonly backend: string;
  readonly facts: ArtifactFacts;
  readonly capabilities: ArtifactCapabilities;
  readonly qualification: Qualification;
  readonly operational: CatalogEntry['operational'];
}

export interface BackendDescriptor {
  readonly engine: 'llama.cpp';
  readonly pinnedBuild: string;
  readonly baseUrl: string;
}

export interface DigestVerification {
  readonly modelId: ModelId;
  readonly expected: ArtifactDigest;
  readonly actual: ArtifactDigest | null;
  readonly sizeBytes: number | null;
  readonly match: boolean;
  readonly durationMs: number;
  readonly error: string | null;
}

export class CatalogError extends Error {}

export class Catalog {
  readonly #artifacts: ReadonlyMap<ModelId, InternalArtifact>;
  readonly #backends: ReadonlyMap<string, BackendDescriptor>;
  readonly #luak: LuakEvidenceSet;

  private constructor(
    artifacts: ReadonlyMap<ModelId, InternalArtifact>,
    backends: ReadonlyMap<string, BackendDescriptor>,
    luak: LuakEvidenceSet,
  ) {
    this.#artifacts = artifacts;
    this.#backends = backends;
    this.#luak = luak;
  }

  static async load(catalogPath: string): Promise<Catalog> {
    const raw = await readFile(catalogPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CatalogError(`catalog is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new CatalogError('catalog root must be an object');
    }
    const doc = parsed as Record<string, unknown>;

    const backends = new Map<string, BackendDescriptor>();
    const backendDoc = (doc['backends'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, b] of Object.entries(backendDoc)) {
      const baseUrl = String(b['baseUrl'] ?? '');
      assertLoopback(baseUrl, name);
      backends.set(name, {
        engine: 'llama.cpp',
        pinnedBuild: String(b['pinnedBuild'] ?? ''),
        baseUrl,
      });
    }
    if (backends.size === 0) throw new CatalogError('catalog defines no backends');

    const artifacts = new Map<ModelId, InternalArtifact>();
    const list = doc['artifacts'];
    if (!Array.isArray(list) || list.length === 0) {
      throw new CatalogError('catalog defines no artifacts');
    }
    for (const item of list as Record<string, unknown>[]) {
      const entry = parseArtifact(item);
      if (!backends.has(entry.backend)) {
        throw new CatalogError(`artifact ${entry.modelId} names unknown backend ${entry.backend}`);
      }
      if (artifacts.has(entry.modelId)) {
        throw new CatalogError(`duplicate modelId in catalog: ${entry.modelId}`);
      }
      artifacts.set(entry.modelId, entry);
    }

    // Luak is not integrated in Phase 1. The evidence set is empty by
    // construction, which forces every artifact to remain unqualified.
    return new Catalog(artifacts, backends, EMPTY_LUAK_EVIDENCE);
  }

  get luakEvidence(): LuakEvidenceSet {
    return this.#luak;
  }

  backend(name: string): BackendDescriptor {
    const b = this.#backends.get(name);
    if (!b) throw new CatalogError(`unknown backend: ${name}`);
    return b;
  }

  /** Internal lookup. Callers must not serialise the result directly. */
  internal(modelId: string): InternalArtifact | undefined {
    return this.#artifacts.get(modelId);
  }

  internalAll(): readonly InternalArtifact[] {
    return [...this.#artifacts.values()];
  }

  /** Public projection. Structurally cannot contain artifactPath. */
  toPublic(a: InternalArtifact): CatalogEntry {
    return {
      modelId: a.modelId,
      displayName: a.displayName,
      digest: a.digest,
      facts: a.facts,
      capabilities: a.capabilities,
      qualification: a.qualification,
      operational: a.operational,
    };
  }

  publicEntries(): readonly CatalogEntry[] {
    return this.internalAll().map((a) => this.toPublic(a));
  }

  /** Resolve by digest, for EXACT verification. */
  byDigest(digest: string): InternalArtifact | undefined {
    return this.internalAll().find((a) => a.digest === digest);
  }

  /**
   * Recompute the artifact digest from disk and compare with the catalog.
   * Expensive (full file read); call at startup or on demand, not per request.
   */
  async verifyDigest(modelId: string): Promise<DigestVerification> {
    const a = this.#artifacts.get(modelId);
    if (!a) throw new CatalogError(`unknown modelId: ${modelId}`);
    const started = Date.now();
    try {
      const st = await stat(a.artifactPath);
      const hash = createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(a.artifactPath, { highWaterMark: 8 * 1024 * 1024 });
        stream.on('data', (c) => hash.update(c));
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      const actual = `sha256:${hash.digest('hex')}` as ArtifactDigest;
      return {
        modelId: a.modelId,
        expected: a.digest,
        actual,
        sizeBytes: st.size,
        match: actual === a.digest && st.size === a.facts.sizeBytes,
        durationMs: Date.now() - started,
        error: null,
      };
    } catch (err) {
      return {
        modelId: a.modelId,
        expected: a.digest,
        actual: null,
        sizeBytes: null,
        match: false,
        durationMs: Date.now() - started,
        error: (err as Error).message,
      };
    }
  }
}

function assertLoopback(baseUrl: string, name: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new CatalogError(`backend ${name} has an invalid baseUrl`);
  }
  const host = u.hostname;
  const ok = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!ok) {
    throw new CatalogError(
      `backend ${name} baseUrl must be loopback (got ${host}). ` +
        'The inference backend is never permitted to be routable.',
    );
  }
}

function parseArtifact(item: Record<string, unknown>): InternalArtifact {
  const modelId = item['modelId'];
  if (!isValidModelId(modelId)) {
    throw new CatalogError(
      `invalid modelId ${JSON.stringify(modelId)}: must be a stable path-free identifier ` +
        `matching ${String(MODEL_ID_HINT)}`,
    );
  }
  const digest = item['digest'];
  if (!isValidDigest(digest)) {
    throw new CatalogError(`artifact ${modelId} has an invalid digest; expected ${DIGEST_PATTERN}`);
  }
  const artifactPath = item['artifactPath'];
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    throw new CatalogError(`artifact ${modelId} is missing artifactPath`);
  }
  const runtimeAlias = String(item['runtimeAlias'] ?? modelId);
  if (isPathLike(runtimeAlias)) {
    throw new CatalogError(
      `artifact ${modelId} has a path-like runtimeAlias; the backend alias must be a stable name`,
    );
  }
  const facts = item['facts'] as ArtifactFacts;
  const capabilities = item['capabilities'] as ArtifactCapabilities;
  const qualification = item['qualification'] as Qualification;
  // The catalog is an operator-editable file, and qualification is not the
  // catalog's to grant. Bokahli issues none, and no import path writes one here:
  // evidence lives in the qualification store, keyed to the exact artifact,
  // runtime and hardware it was measured on. A QUALIFIED status in this file
  // could therefore only ever be a hand edit, and it would still be reported in
  // every served identity even though routing correctly refuses to honour it.
  // Refusing at load keeps the API's answer and the router's answer the same.
  if (qualification.status === 'QUALIFIED') {
    throw new CatalogError(
      `artifact ${modelId} declares qualification.status QUALIFIED. The catalog cannot ` +
        'confer qualification: it is issued by Luak, imported as evidence, and authorised ' +
        'by the operator. Set INSTALLED_UNQUALIFIED here and import evidence instead.',
    );
  }
  const operational = item['operational'] as CatalogEntry['operational'];
  return {
    modelId,
    displayName: String(item['displayName'] ?? modelId),
    digest,
    artifactPath,
    runtimeAlias,
    backend: String(item['backend'] ?? 'primary'),
    facts,
    capabilities,
    qualification,
    operational,
  };
}

const MODEL_ID_HINT = '/^[a-z0-9][a-z0-9._-]{0,127}$/ and not path-like';
