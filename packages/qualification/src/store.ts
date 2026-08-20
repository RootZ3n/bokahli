/**
 * The qualification evidence store.
 *
 * Imported evidence lives here, and only here. It is deliberately kept apart
 * from three things it is often confused with:
 *
 *   - **Declared model facts** (the catalog): what the artifact *is*.
 *   - **Live operational state** (readiness, GPU lease, queue): what the system
 *     *can do right now*.
 *   - **Qualification evidence** (this store): what someone else *measured*,
 *     under conditions they recorded.
 *
 * Keeping them separate is what stops a catalog edit from conferring
 * qualification, and what stops a healthy runtime from being mistaken for a
 * capable one. The store is read-only after load: there is no method here that
 * mutates an accepted bundle, and the bundles themselves are frozen.
 */
import {
  qualificationKeyString,
  type AcceptedQualificationBundle,
  type QualificationImportError,
  type QualificationKey,
  type TaskClass,
} from '@bokahli/contracts';
import { importQualificationBundle, IMPORT_LIMITS, type ImportContext } from './importer.js';

export interface RejectedBundle {
  /** Best-effort identification of what was rejected, for the operator's log. */
  readonly index: number;
  readonly modelId: string | null;
  readonly taskClass: string | null;
  readonly errors: readonly QualificationImportError[];
}

export interface StoreLoadReport {
  readonly accepted: number;
  readonly rejected: readonly RejectedBundle[];
  readonly loadedAt: string;
}

/**
 * A partial key: everything except the task class.
 *
 * Lookups happen per task class against a fixed deployment, so the deployment
 * half of the key is supplied once and the task half varies.
 */
export interface DeploymentKey {
  readonly modelId: string;
  readonly artifactDigest: string;
  readonly quantization: string;
  readonly runtimeName: string;
  readonly runtimeBuild: string;
  readonly hardwareProfileId: string;
}

export class QualificationStore {
  readonly #byKey = new Map<string, AcceptedQualificationBundle>();
  #loadedAt = '1970-01-01T00:00:00.000Z';

  /** An empty store. This is the state Phase 1 shipped, and the default. */
  static empty(): QualificationStore {
    return new QualificationStore();
  }

  /**
   * Import a batch. Every bundle is validated independently: one bad bundle
   * does not poison the batch, and one good bundle does not excuse the rest.
   *
   * Accepted keys accumulate as the batch proceeds, so a duplicate within a
   * single batch is caught the same way a duplicate against an earlier load is.
   */
  load(raws: readonly unknown[], ctx: ImportContext): StoreLoadReport {
    const rejected: RejectedBundle[] = [];
    let accepted = 0;

    if (raws.length > IMPORT_LIMITS.maxBundlesPerLoad) {
      throw new RangeError(
        `refusing to import ${raws.length} bundles in one load; the limit is ` +
          `${IMPORT_LIMITS.maxBundlesPerLoad}`,
      );
    }

    for (const [index, raw] of raws.entries()) {
      const existingKeys = new Set(this.#byKey.keys());
      // The importer is handed input someone else wrote. It is written to
      // return typed rejections rather than throw, and this catch is the
      // guarantee that a bug in that promise degrades into a rejection rather
      // than taking down whatever called us.
      let result;
      try {
        result = importQualificationBundle(raw, { ...ctx, existingKeys });
      } catch (err) {
        result = {
          ok: false as const,
          errors: [
            {
              code: 'MALFORMED_BUNDLE' as const,
              detail: `import threw while validating this bundle: ${(err as Error).message}`,
              field: null,
              expected: null,
              actual: null,
            },
          ],
        };
      }
      if (result.ok) {
        this.#byKey.set(qualificationKeyString(result.accepted.bundle.key), result.accepted);
        accepted += 1;
        continue;
      }
      const probe = raw as { key?: { modelId?: unknown; taskClass?: unknown } } | null;
      rejected.push({
        index,
        modelId: typeof probe?.key?.modelId === 'string' ? probe.key.modelId : null,
        taskClass: typeof probe?.key?.taskClass === 'string' ? probe.key.taskClass : null,
        errors: result.errors,
      });
    }

    this.#loadedAt = ctx.now.toISOString();
    return { accepted, rejected, loadedAt: this.#loadedAt };
  }

  get size(): number {
    return this.#byKey.size;
  }

  get loadedAt(): string {
    return this.#loadedAt;
  }

  /**
   * How many held bundles the operator has actually authorised.
   *
   * Reported separately from `size` because the difference is the interesting
   * number: evidence can be present, intact, and still authorise nothing.
   */
  get trustedSize(): number {
    let n = 0;
    for (const e of this.#byKey.values()) if (e.importTrust.accepted) n += 1;
    return n;
  }

  /**
   * Exact lookup. A miss on any key element is a miss — there is no nearest
   * match, no fallback to a different quantisation, and no "close enough"
   * runtime build.
   */
  find(key: QualificationKey): AcceptedQualificationBundle | null {
    return this.#byKey.get(qualificationKeyString(key)) ?? null;
  }

  /**
   * Find evidence for one task class against one deployment.
   *
   * The fixture suite and regime versions are not part of what the caller
   * supplies: the caller asks "is this deployment qualified for this task", and
   * which suite answered that is a property of the evidence, not of the
   * question. Where several bundles match, the newest is returned — and if the
   * operator's policy demands a particular suite version, the policy rejects
   * the wrong one rather than the lookup silently preferring it.
   */
  findForTask(
    deployment: DeploymentKey,
    taskClass: TaskClass,
    taskClassContractVersion: string,
  ): readonly AcceptedQualificationBundle[] {
    const matches: AcceptedQualificationBundle[] = [];
    for (const entry of this.#byKey.values()) {
      const k = entry.bundle.key;
      if (
        k.modelId === deployment.modelId &&
        k.artifactDigest === deployment.artifactDigest &&
        k.quantization === deployment.quantization &&
        k.runtimeName === deployment.runtimeName &&
        k.runtimeBuild === deployment.runtimeBuild &&
        k.hardwareProfileId === deployment.hardwareProfileId &&
        k.taskClass === taskClass &&
        k.taskClassContractVersion === taskClassContractVersion
      ) {
        matches.push(entry);
      }
    }
    // Deterministic: newest first, then by key string so equal timestamps never
    // depend on Map insertion order.
    return matches.sort((a, b) => {
      const t = Date.parse(b.bundle.generatedAt) - Date.parse(a.bundle.generatedAt);
      if (t !== 0) return t;
      const ka = qualificationKeyString(a.bundle.key);
      const kb = qualificationKeyString(b.bundle.key);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  /** Everything held, in a stable order. For operator inspection only. */
  all(): readonly AcceptedQualificationBundle[] {
    return [...this.#byKey.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, b]) => b);
  }

  /** Task classes any evidence exists for, whatever its verdict. */
  taskClassesWithEvidence(): readonly string[] {
    return [...new Set([...this.#byKey.values()].map((e) => e.bundle.key.taskClass))].sort();
  }
}
