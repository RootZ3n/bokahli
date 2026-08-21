/**
 * Which catalogued artifact is the backend actually serving?
 *
 * Bokahli used to answer this with `artifacts[0]`. That was correct for exactly
 * as long as the catalog held one entry. The moment a second artifact was
 * installed, every readiness probe attested the first one regardless of what
 * the runtime had loaded, and a correctly-swapped runtime reported itself
 * unattested with three confident, wrong reasons:
 *
 *     backend is not serving the catalogued artifact path
 *     backend alias mismatch: expected qwen3.5-35b-a3b.q2-k, got qwen3.5-35b-a3b.iq3-xxs
 *     quantisation mismatch: expected Q2_K, got IQ3_XXS
 *
 * The runtime was right and Bokahli was asking the wrong question. Attestation
 * compares the backend against an expectation; picking that expectation by
 * position rather than by what the backend says it is loaded makes the
 * comparison meaningless as soon as there is a choice.
 *
 * So the expectation is resolved from the backend's own `/props` alias. That is
 * not trusting the backend about its identity — the attestation still checks
 * path, alias, quantisation and build against the catalogued facts, and still
 * fails if any disagree. It only decides *which* catalogue row that check is
 * run against. A backend claiming an alias it is not serving still fails
 * attestation on every other field.
 *
 * When the alias matches nothing catalogued, this reports that as its own
 * condition rather than silently falling back: an unknown artifact being served
 * is a fact an operator needs, and quietly attesting it against an unrelated
 * row would hide it.
 */

import type { Catalog, InternalArtifact } from '@bokahli/catalog';
import type { LlamaBackend } from '@bokahli/runtime';

export interface ServedArtifactResolution {
  /** The artifact attestation should be run against, if one could be chosen. */
  readonly artifact: InternalArtifact | undefined;
  /** The alias the backend reported, or null if it could not be asked. */
  readonly reportedAlias: string | null;
  /**
   * How the choice was made. Recorded so a readiness view can distinguish
   * "attested the served artifact" from "guessed, because nothing matched".
   */
  readonly basis: 'backend-alias' | 'unmatched-alias' | 'backend-unreachable' | 'empty-catalog';
}

export async function resolveServedArtifact(
  backend: Pick<LlamaBackend, 'props'>,
  catalog: Pick<Catalog, 'internalAll'>,
): Promise<ServedArtifactResolution> {
  const artifacts = catalog.internalAll();
  if (artifacts.length === 0) {
    return { artifact: undefined, reportedAlias: null, basis: 'empty-catalog' };
  }

  let alias: string | null = null;
  try {
    alias = (await backend.props()).model_alias ?? null;
  } catch {
    // A backend that cannot be asked is a backend that cannot be attested. The
    // first entry is returned so the caller still produces an attestation
    // object, and that attestation will fail on its own terms.
    return { artifact: artifacts[0], reportedAlias: null, basis: 'backend-unreachable' };
  }

  if (alias === null) {
    return { artifact: artifacts[0], reportedAlias: null, basis: 'unmatched-alias' };
  }

  const match = artifacts.find((a) => a.runtimeAlias === alias);
  if (match) return { artifact: match, reportedAlias: alias, basis: 'backend-alias' };

  // Serving something this deployment does not know about. Attesting it against
  // the first row would manufacture a mismatch report about the wrong artifact,
  // so the first row is returned only to keep the shape, and the basis says
  // plainly that nothing matched.
  return { artifact: artifacts[0], reportedAlias: alias, basis: 'unmatched-alias' };
}
