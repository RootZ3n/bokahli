/**
 * Bokahli — the vendored Velum A32 engine.
 *
 * This package is a copy, not a fork. Everything under `vendor/` is Velum's
 * source verbatim, pinned by `velum.lock.json` and re-checked by
 * `node scripts/sync-velum.mjs --check`, which the test suite runs. Nothing in
 * this package may be edited to change behaviour: a Bokahli-shaped change to
 * the detector belongs upstream, where it has a corpus and an audit, and a
 * local edit here would be a second implementation of a security boundary that
 * agrees with the first only until it does not.
 *
 * What this file adds is the identity the boundary reports. `VELUM_ENGINE` is
 * read out of the vendored registry's own provenance block rather than restated
 * here, so the version Bokahli publishes in telemetry is the version Bokahli
 * actually compiled — not a constant beside it that a sync could leave behind.
 *
 * ## What is deliberately not vendored
 *
 * Velum's PII and redaction path. Bokahli is a single-operator local system;
 * there is no third party whose data needs masking, and the only thing a
 * redactor could act on here is the operator's own evidence. Vendoring it would
 * put code in the tree whose sole possible effect is to modify the bytes a
 * citation resolves against. See `scripts/sync-velum.mjs` for the allowlist.
 */
export {
  // vocabulary — four layers, never collapsed
  VELUM_CATEGORIES, VELUM_SEVERITIES, POSITIVE_CATEGORIES,
  VelumFindingSet, isPositiveCategory, isCredentialCategory,
  isVelumCategory, isVelumSeverity,
  type VelumCategory, type VelumSeverity, type VelumFinding, type FindingSetFailure,
  type PolicyDecision, type TransformationApplied, type ExportBoundary,
} from './vendor/core/a32/categories.js';

export {
  A32_PATTERNS, DETECTOR_CONTRACT_VERSION, REGISTRY_VERSION, patternById,
  REGISTRY_PROVENANCE, REGISTRY_CORRECTIONS,
  type PatternDefinition, type RegistryCorrection,
} from './vendor/core/a32/registry.js';

export {
  NORMALIZATION_VERSION, normalize, projectToRaw,
  NORMALIZE_LIMITS, NormalizeLimitExceeded,
  type NormalizedText, type NormalizedSegment, type MappingFidelity,
  type TransformationKind, type RawProjection,
} from './vendor/core/a32/normalize.js';

export {
  Detector, DETECTOR_VERSION, DEFAULT_MAX_TOTAL_STEPS, DetectorRegistryError,
  type Detection, type VelumFindingRecord, type DetectorOptions,
} from './vendor/core/a32/detect.js';

export {
  FENCE_VERSION, neutralize, resolveToRaw, resolveToRendered,
  FENCE_LIMITS, FenceLimitExceeded, isInvisible,
  type NeutralizedContent, type TransformationMap, type RenderedSegment,
  type RenderedSegmentKind, type NeutralizeContext, type RawResolution, type MapFailure,
} from './vendor/core/a32/fence.js';

export {
  INSPECTION_CONTRACT_VERSION, UNTRUSTED_ZONES, inspect, citationFor, isTrustZone,
  type TrustZone, type PolicyMode, type Destination,
  type InspectionPacket, type InspectionOptions, type InspectionResult, type PacketResult,
} from './vendor/core/a32/inspect.js';

export {
  Matcher, MatchLimitExceeded, PatternError, PATTERN_LIMITS, VM_LIMITS,
  compile as compilePattern, parsePattern, findAllInText,
  type Match, type MatchStats, type FindOptions, type Program, type PatternErrorKind,
} from './vendor/core/pike/index.js';

export {
  decodeText, decodeUtf8, toUtf8, sliceBytes, sliceBytesExact, lineColumnOf,
  type ByteSpan, type DecodedText, type CodePointCell, type LineColumn,
} from './vendor/core/bytes.js';

import { REGISTRY_PROVENANCE, REGISTRY_VERSION, DETECTOR_CONTRACT_VERSION } from './vendor/core/a32/registry.js';
import { DETECTOR_VERSION } from './vendor/core/a32/detect.js';
import { FENCE_VERSION } from './vendor/core/a32/fence.js';
import { NORMALIZATION_VERSION } from './vendor/core/a32/normalize.js';
import { INSPECTION_CONTRACT_VERSION } from './vendor/core/a32/inspect.js';

/**
 * The identity of the engine Bokahli compiled.
 *
 * Every field is read from the vendored sources at module load, so it cannot
 * describe a version that is not the one running. `registryPayloadSha256` is
 * Velum's own digest over its pattern rows: two Bokahli instances reporting the
 * same value scanned with the same forty-five patterns, and an operator can
 * check that against Velum without trusting Bokahli's summary of it.
 */
export const VELUM_ENGINE = Object.freeze({
  detectorVersion: DETECTOR_VERSION,
  registryVersion: REGISTRY_VERSION,
  contractVersion: DETECTOR_CONTRACT_VERSION,
  inspectionContractVersion: INSPECTION_CONTRACT_VERSION,
  normalizationVersion: NORMALIZATION_VERSION,
  fenceVersion: FENCE_VERSION,
  registryPayloadSha256: REGISTRY_PROVENANCE.payloadSha256,
  registryGeneratorVersion: REGISTRY_PROVENANCE.generatorVersion,
  patternCount: REGISTRY_PROVENANCE.patternCount,
  correctionCount: REGISTRY_PROVENANCE.correctionCount,
});
