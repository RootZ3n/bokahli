/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/a32/index.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — the A32 injection engine.
 * ============================================================
 * Injection detection, policy and fencing, callable without any privacy
 * transformation. Ported from the operator-owned ABAIYA implementation
 * (`abaiya-policy` / `abaiya-types`, `RootZ3n/abaiya` at `a471252`) under the
 * operator's reuse and MIT-publication authorization.
 */
export {
  VELUM_CATEGORIES, VELUM_SEVERITIES, POSITIVE_CATEGORIES,
  VelumFindingSet, isPositiveCategory, isCredentialCategory,
  isVelumCategory, isVelumSeverity,
  type VelumCategory, type VelumSeverity, type VelumFinding, type FindingSetFailure,
  type PolicyDecision, type TransformationApplied, type ExportBoundary,
} from "./categories.js";
export {
  A32_PATTERNS, DETECTOR_CONTRACT_VERSION, REGISTRY_VERSION, patternById,
  REGISTRY_PROVENANCE, REGISTRY_CORRECTIONS,
  type PatternDefinition, type RegistryCorrection,
} from "./registry.js";
export {
  NORMALIZATION_VERSION, normalize, projectToRaw,
  NORMALIZE_LIMITS, NormalizeLimitExceeded,
  type NormalizedText, type NormalizedSegment, type MappingFidelity,
  type TransformationKind, type RawProjection,
} from "./normalize.js";
export {
  Detector, DETECTOR_VERSION, DEFAULT_MAX_TOTAL_STEPS, DetectorRegistryError,
  type Detection, type VelumFindingRecord, type DetectorOptions,
} from "./detect.js";
export {
  FENCE_VERSION, neutralize, resolveToRaw, resolveToRendered,
  FENCE_LIMITS, FenceLimitExceeded, isInvisible,
  type NeutralizedContent, type TransformationMap, type RenderedSegment,
  type RenderedSegmentKind, type NeutralizeContext, type RawResolution, type MapFailure,
} from "./fence.js";
export {
  INSPECTION_CONTRACT_VERSION, UNTRUSTED_ZONES, inspect, citationFor, isTrustZone,
  type TrustZone, type PolicyMode, type Destination,
  type InspectionPacket, type InspectionOptions, type InspectionResult, type PacketResult,
} from "./inspect.js";
