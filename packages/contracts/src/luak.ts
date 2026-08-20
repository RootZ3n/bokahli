/**
 * Luak import contract — versioned placeholder.
 *
 * Luak is the independent qualification authority. Bokahli consumes its
 * evidence; Bokahli never produces it. Phase 1 ships the shape only: there is
 * no Luak integration, no transport, and no evidence store. The loader in
 * @bokahli/catalog returns an empty evidence set, which is why every installed
 * artifact resolves to INSTALLED_UNQUALIFIED.
 *
 * This file exists so the boundary is typed and versioned before anything
 * crosses it. Changing LUAK_CONTRACT_VERSION is a breaking change.
 */
import type { ArtifactDigest, ModelId } from './identity.js';

export const LUAK_CONTRACT_VERSION = '0.1.0-placeholder' as const;

/** A single qualification verdict issued by Luak for one artifact + task class. */
export interface LuakQualificationRecord {
  readonly contractVersion: typeof LUAK_CONTRACT_VERSION;
  readonly modelId: ModelId;
  readonly artifactDigest: ArtifactDigest;
  readonly taskClass: string;
  readonly verdict: 'QUALIFIED' | 'DISQUALIFIED';
  /** Opaque reference to the Luak-side evidence. Bokahli does not interpret it. */
  readonly evidenceRef: string;
  readonly issuedAt: string;
  /** Runtime build the evidence was produced against. Evidence is build-scoped. */
  readonly runtimeBuild: string;
}

export interface LuakEvidenceSet {
  readonly contractVersion: typeof LUAK_CONTRACT_VERSION;
  readonly source: 'none' | 'file' | 'service';
  readonly loadedAt: string;
  readonly records: readonly LuakQualificationRecord[];
}

export const EMPTY_LUAK_EVIDENCE: LuakEvidenceSet = {
  contractVersion: LUAK_CONTRACT_VERSION,
  source: 'none',
  loadedAt: '1970-01-01T00:00:00.000Z',
  records: [],
};
