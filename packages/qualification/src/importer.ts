/**
 * Qualification evidence importer.
 *
 * The importer is the only door through which Luak evidence becomes usable by
 * Bokahli, and it is closed by default. Everything it accepts must survive
 * structural validation, a recomputed content hash, and a set of checks that
 * the evidence is about *this* artifact on *this* runtime on *this* machine —
 * because a verdict earned elsewhere is not a verdict about here.
 *
 * Two things it deliberately does not do:
 *
 *   - It never repairs. A bundle with a wrong aggregate is rejected, not
 *     recomputed into something acceptable. Silently fixing evidence would make
 *     Bokahli a second, unaccountable scoring authority.
 *   - It never calls Luak. Import is an offline, operator-initiated act. Luak
 *     is not in the request path, so a Luak outage can never change what
 *     Bokahli will route.
 *
 * Every rejection is typed and cites the field, what was expected, and what was
 * found. All checks that can run do run, so an operator fixing an export sees
 * the whole list rather than one error per round trip.
 */
import {
  ATTEMPT_OUTCOMES,
  EMPTY_TRUST_ANCHOR,
  FAILURE_ORIGINS,
  INFRASTRUCTURE_OUTCOMES,
  MODEL_ATTRIBUTABLE_OUTCOMES,
  OUTCOME_ORIGIN_RULES,
  QUALIFICATION_CONTENT_HASH_FIELD,
  QUALIFICATION_KEY_FIELDS,
  SUPPORTED_QUALIFICATION_BUNDLE_VERSIONS,
  TASK_CLASS_CONTRACT_VERSIONS,
  isTaskClass,
  isValidDigest,
  isValidModelId,
  type AttemptOutcome,
  type QualificationAggregate,
  type QualificationAttempt,
  type QualificationBundle,
  type QualificationImportError,
  type QualificationImportErrorCode,
  type QualificationImportResult,
  type ImportTrust,
  type QualificationKey,
  type TrustAnchor,
} from '@bokahli/contracts';
import { CanonicalizationError, canonicalHashExcluding } from './canonical.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Explicit limits on attacker-shaped input.
 *
 * Evidence is a file, and a file is the easiest thing in this system for
 * someone to make enormous. None of these are tuning knobs: they are the point
 * past which an import stops being evidence and starts being a workload.
 */
export const IMPORT_LIMITS = Object.freeze({
  maxBundlesPerLoad: 1_000,
  maxAttemptsPerBundle: 10_000,
  maxKnownFailureModes: 256,
  maxIdentifierLength: 512,
  maxNoteLength: 4_096,
  maxProvenanceRefs: 10_000,
});

/** Top-level fields a bundle may carry. Anything else is refused. */
const ALLOWED_BUNDLE_FIELDS: readonly string[] = [
  'bundleVersion', 'key', 'hardwareProfile', 'verdict', 'attempts',
  'aggregate', 'provenance', 'generatedAt', 'expiresAt', 'contentHash',
];
const ALLOWED_ATTEMPT_FIELDS: readonly string[] = [
  'attemptId', 'fixtureId', 'outcome', 'failureOrigin', 'failureReasonCode',
  'score', 'contextTierTokens', 'tokens', 'timings', 'compliance', 'sourceRef',
];
const ALLOWED_AGGREGATE_FIELDS: readonly string[] = [
  'attemptCount', 'sampleCount', 'outcomeCounts', 'meanScore', 'passRate',
  'infrastructureFailureRate', 'schemaViolationRate', 'citationViolationRate',
  'scoreStdDev', 'repeatabilityDisagreementRate', 'contextTierTokens', 'knownFailureModes',
];
const ALLOWED_PROVENANCE_FIELDS: readonly string[] = [
  'claimedAuthority', 'sourceContractVersion', 'luakBundleIds', 'luakBundleHashes',
  'claimedSignatureStatus', 'luakRepoCommit', 'note', 'verifiedByBokahli',
];

/** Floating-point aggregates are compared to this tolerance, not for equality. */
const RATE_EPSILON = 1e-6;

/**
 * Clock skew allowed on `generatedAt` before evidence is called future-dated.
 * Small on purpose: evidence stamped meaningfully in the future is either a
 * misconfigured clock or a forgery, and both deserve a rejection.
 */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * What the importing machine actually is.
 *
 * Supplied by the caller rather than probed, so import is deterministic and
 * testable, and so an operator can validate an export against a machine profile
 * without standing on that machine.
 */
export interface ImportContext {
  /** The artifacts installed here, from the catalog. */
  readonly installedArtifacts: readonly {
    readonly modelId: string;
    readonly digest: string;
    readonly quantization: string;
  }[];
  readonly runtimeName: string;
  readonly runtimeBuild: string;
  readonly hardwareProfileId: string;
  /** Context length this deployment actually serves, in tokens. */
  readonly servedContextTokens: number;
  /** Evaluation time. Injected so staleness is testable. */
  readonly now: Date;
  /**
   * The operator's trust anchor.
   *
   * Optional in the type and empty when omitted, so forgetting it fails closed:
   * an import with no anchor produces evidence marked untrusted, which the
   * policy layer then refuses to qualify on. There is no configuration mistake
   * that turns arbitrary local JSON into authority.
   */
  readonly trustAnchor?: TrustAnchor;
  /** Keys already accepted, for duplicate detection. */
  readonly existingKeys?: ReadonlySet<string>;
}

export class ErrorBag {
  readonly #errors: QualificationImportError[] = [];

  add(
    code: QualificationImportErrorCode,
    detail: string,
    field: string | null = null,
    expected: string | null = null,
    actual: string | null = null,
  ): void {
    this.#errors.push({ code, detail, field, expected, actual });
  }

  get list(): readonly QualificationImportError[] {
    return this.#errors;
  }

  get empty(): boolean {
    return this.#errors.length === 0;
  }
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** `null` is a legitimate value everywhere a measurement may be unknown. */
function numOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

function strOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function boolOrNull(v: unknown): v is boolean | null {
  return v === null || typeof v === 'boolean';
}

function validateKey(raw: unknown, bag: ErrorBag): raw is QualificationKey {
  if (!isObject(raw)) {
    bag.add('MALFORMED_BUNDLE', 'key must be an object', 'key');
    return false;
  }
  let ok = true;
  for (const f of QUALIFICATION_KEY_FIELDS) {
    if (!str(raw[f])) {
      bag.add('MALFORMED_BUNDLE', `key.${f} must be a non-empty string`, `key.${f}`);
      ok = false;
    }
  }
  for (const f of QUALIFICATION_KEY_FIELDS) {
    const v = raw[f];
    if (typeof v !== 'string') continue;
    if (v.length > IMPORT_LIMITS.maxIdentifierLength) {
      bag.add('MALFORMED_BUNDLE',
        `key.${f} exceeds ${IMPORT_LIMITS.maxIdentifierLength} characters`, `key.${f}`);
      ok = false;
    }
    // Leading/trailing whitespace and control characters make two identifiers
    // that look identical to an operator compare unequal — or, worse, let one
    // masquerade as another in a log. Refused rather than trimmed: silently
    // rewriting an identifier is how a key stops meaning what it says.
    if (v !== v.trim() || /[\u0000-\u001f\u007f]/.test(v)) {
      bag.add('MALFORMED_BUNDLE',
        `key.${f} must not carry surrounding whitespace or control characters`,
        `key.${f}`, 'trimmed, printable', JSON.stringify(v).slice(0, 60));
      ok = false;
    }
  }
  if (ok) {
    if (!isValidModelId(raw['modelId'])) {
      bag.add(
        'MALFORMED_BUNDLE',
        'key.modelId must be a stable public catalog identity; filesystem paths and ' +
          'artifact filenames are never accepted as identity',
        'key.modelId',
        'stable catalog id',
        String(raw['modelId']),
      );
      ok = false;
    }
    if (!isValidDigest(raw['artifactDigest'])) {
      bag.add(
        'MALFORMED_BUNDLE',
        'key.artifactDigest must be sha256:<64 hex>',
        'key.artifactDigest',
        'sha256:<64 hex>',
        String(raw['artifactDigest']),
      );
      ok = false;
    }
  }
  return ok;
}

function validateAttempt(raw: unknown, i: number, bag: ErrorBag): boolean {
  const at = `attempts[${i}]`;
  if (!isObject(raw)) {
    bag.add('MALFORMED_BUNDLE', `${at} must be an object`, at);
    return false;
  }
  let ok = true;
  const need = (cond: boolean, field: string, why: string): void => {
    if (!cond) {
      bag.add('MALFORMED_BUNDLE', `${at}.${field} ${why}`, `${at}.${field}`);
      ok = false;
    }
  };

  need(str(raw['attemptId']), 'attemptId', 'must be a non-empty string');
  need(str(raw['fixtureId']), 'fixtureId', 'must be a non-empty string');
  need(
    (ATTEMPT_OUTCOMES as readonly string[]).includes(raw['outcome'] as string),
    'outcome',
    `must be one of ${ATTEMPT_OUTCOMES.join(', ')}`,
  );
  need(
    raw['failureOrigin'] === null ||
      (FAILURE_ORIGINS as readonly string[]).includes(raw['failureOrigin'] as string),
    'failureOrigin',
    `must be null or one of ${FAILURE_ORIGINS.join(', ')} — an origin outside the ` +
      'versioned vocabulary is one this build has no rule for, and a rule-less origin ' +
      'is one that gets silently ignored',
  );
  need(strOrNull(raw['failureReasonCode']), 'failureReasonCode', 'must be a string or null');
  need(numOrNull(raw['score']), 'score', 'must be a finite number or null');
  need(numOrNull(raw['contextTierTokens']), 'contextTierTokens', 'must be a number or null');
  need(strOrNull(raw['sourceRef']), 'sourceRef', 'must be a string or null');

  // Attribution is a scoring rule, not raw evidence, so it is derived from the
  // outcome here rather than taken from the exporter. This check refuses the
  // combination that would let a bundle author move their own failures out of
  // the pass-rate denominator by relabelling the origin.
  const outcome = raw['outcome'] as AttemptOutcome;
  const origin = raw['failureOrigin'];
  if ((ATTEMPT_OUTCOMES as readonly string[]).includes(outcome)) {
    const allowed = OUTCOME_ORIGIN_RULES[outcome];
    if (outcome === 'PASS') {
      if (origin !== null) {
        bag.add('CONTRADICTORY_AGGREGATE',
          `${at} is a PASS with a failure origin`, `${at}.failureOrigin`, 'null', String(origin));
        ok = false;
      }
    } else if (origin === null || !(allowed as readonly string[]).includes(origin as string)) {
      bag.add('CONTRADICTORY_AGGREGATE',
        `${at} declares outcome ${outcome}, which requires a failure origin in ` +
          `[${allowed.join(', ')}]. Infrastructure outcomes are excluded from the pass rate, ` +
          'so the label cannot be chosen independently of the origin.',
        `${at}.failureOrigin`, `one of [${allowed.join(', ')}]`, String(origin));
      ok = false;
    }
  }

  const unknown = Object.keys(raw).filter((k) => !ALLOWED_ATTEMPT_FIELDS.includes(k));
  if (unknown.length > 0) {
    bag.add('MALFORMED_BUNDLE',
      `${at} carries unrecognised field(s): ${unknown.join(', ')}. Unknown fields are ` +
        'refused rather than ignored, so a payload cannot smuggle in something that ' +
        'looks authoritative to a later reader.',
      at, 'no unrecognised fields', unknown.join(','));
    ok = false;
  }

  const score = raw['score'];
  if (typeof score === 'number' && (score < 0 || score > 1)) {
    bag.add(
      'MALFORMED_BUNDLE',
      `${at}.score must be normalised to 0..1`,
      `${at}.score`,
      '0..1',
      String(score),
    );
    ok = false;
  }

  const tokens = raw['tokens'];
  if (!isObject(tokens) || !numOrNull(tokens['promptTokens']) || !numOrNull(tokens['completionTokens'])) {
    bag.add(
      'MALFORMED_BUNDLE',
      `${at}.tokens must carry promptTokens and completionTokens, each a number or null`,
      `${at}.tokens`,
    );
    ok = false;
  }

  const timings = raw['timings'];
  if (
    !isObject(timings) ||
    !numOrNull(timings['timeToFirstTokenMs']) ||
    !numOrNull(timings['prefillTokensPerSecond']) ||
    !numOrNull(timings['decodeTokensPerSecond']) ||
    !numOrNull(timings['wallTimeMs'])
  ) {
    bag.add(
      'MALFORMED_BUNDLE',
      `${at}.timings must carry timeToFirstTokenMs, prefillTokensPerSecond, ` +
        'decodeTokensPerSecond and wallTimeMs, each a number or null. A measurement ' +
        'that was not taken is null; the key is never omitted, because an omitted ' +
        'key reads as zero to a careless consumer',
      `${at}.timings`,
    );
    ok = false;
  }

  const compliance = raw['compliance'];
  if (
    !isObject(compliance) ||
    !boolOrNull(compliance['outputSchemaValid']) ||
    !boolOrNull(compliance['citationsValid']) ||
    !boolOrNull(compliance['toolCallsValid'])
  ) {
    bag.add(
      'MALFORMED_BUNDLE',
      `${at}.compliance must carry outputSchemaValid, citationsValid and toolCallsValid, ` +
        'each a boolean or null',
      `${at}.compliance`,
    );
    ok = false;
  }

  return ok;
}

function validateAggregate(raw: unknown, bag: ErrorBag): boolean {
  if (!isObject(raw)) {
    bag.add('MALFORMED_BUNDLE', 'aggregate must be an object', 'aggregate');
    return false;
  }
  let ok = true;
  const needNum = (field: string): void => {
    if (typeof raw[field] !== 'number' || !Number.isFinite(raw[field])) {
      bag.add('MALFORMED_BUNDLE', `aggregate.${field} must be a finite number`, `aggregate.${field}`);
      ok = false;
    }
  };
  const needNumOrNull = (field: string): void => {
    if (!numOrNull(raw[field])) {
      bag.add('MALFORMED_BUNDLE', `aggregate.${field} must be a number or null`, `aggregate.${field}`);
      ok = false;
    }
  };
  needNum('attemptCount');
  needNum('sampleCount');
  for (const f of [
    'meanScore',
    'passRate',
    'infrastructureFailureRate',
    'schemaViolationRate',
    'citationViolationRate',
    'scoreStdDev',
    'repeatabilityDisagreementRate',
    'contextTierTokens',
  ]) {
    needNumOrNull(f);
  }

  const counts = raw['outcomeCounts'];
  if (!isObject(counts)) {
    bag.add('MALFORMED_BUNDLE', 'aggregate.outcomeCounts must be an object', 'aggregate.outcomeCounts');
    ok = false;
  } else {
    for (const o of ATTEMPT_OUTCOMES) {
      if (typeof counts[o] !== 'number' || !Number.isFinite(counts[o])) {
        bag.add(
          'MALFORMED_BUNDLE',
          `aggregate.outcomeCounts.${o} must be a number — every outcome is counted, ` +
            'including the ones that make a run look worse',
          `aggregate.outcomeCounts.${o}`,
        );
        ok = false;
      }
    }
  }

  const unknownAgg = Object.keys(raw).filter((k) => !ALLOWED_AGGREGATE_FIELDS.includes(k));
  if (unknownAgg.length > 0) {
    bag.add('MALFORMED_BUNDLE',
      `aggregate carries unrecognised field(s): ${unknownAgg.join(', ')}`,
      'aggregate', 'no unrecognised fields', unknownAgg.join(','));
    ok = false;
  }
  if (Array.isArray(raw['knownFailureModes']) &&
      raw['knownFailureModes'].length > IMPORT_LIMITS.maxKnownFailureModes) {
    bag.add('MALFORMED_BUNDLE',
      `aggregate.knownFailureModes exceeds ${IMPORT_LIMITS.maxKnownFailureModes} entries`,
      'aggregate.knownFailureModes');
    ok = false;
  }
  if (!Array.isArray(raw['knownFailureModes']) || raw['knownFailureModes'].some((m) => typeof m !== 'string')) {
    bag.add(
      'MALFORMED_BUNDLE',
      'aggregate.knownFailureModes must be an array of strings (empty is allowed)',
      'aggregate.knownFailureModes',
    );
    ok = false;
  }
  return ok;
}

function validateStructure(raw: unknown, bag: ErrorBag): raw is QualificationBundle {
  if (!isObject(raw)) {
    bag.add('MALFORMED_BUNDLE', 'bundle must be a JSON object', '$');
    return false;
  }
  let ok = true;

  if (!str(raw['bundleVersion'])) {
    bag.add('MALFORMED_BUNDLE', 'bundleVersion must be a non-empty string', 'bundleVersion');
    ok = false;
  }
  if (raw['verdict'] !== 'QUALIFIED' && raw['verdict'] !== 'DISQUALIFIED') {
    bag.add(
      'MALFORMED_BUNDLE',
      'verdict must be QUALIFIED or DISQUALIFIED — Luak issues it, Bokahli only reads it',
      'verdict',
      'QUALIFIED | DISQUALIFIED',
      String(raw['verdict']),
    );
    ok = false;
  }
  if (!str(raw['generatedAt']) || Number.isNaN(Date.parse(raw['generatedAt'] as string))) {
    bag.add('MALFORMED_BUNDLE', 'generatedAt must be an ISO-8601 timestamp', 'generatedAt');
    ok = false;
  }
  if (!strOrNull(raw['expiresAt'])) {
    bag.add('MALFORMED_BUNDLE', 'expiresAt must be an ISO-8601 timestamp or null', 'expiresAt');
    ok = false;
  } else if (typeof raw['expiresAt'] === 'string' && Number.isNaN(Date.parse(raw['expiresAt']))) {
    bag.add('MALFORMED_BUNDLE', 'expiresAt is not a parseable timestamp', 'expiresAt');
    ok = false;
  }
  if (!str(raw['contentHash'])) {
    bag.add('MALFORMED_BUNDLE', 'contentHash must be a non-empty string', 'contentHash');
    ok = false;
  }

  if (!validateKey(raw['key'], bag)) ok = false;

  if (!isObject(raw['hardwareProfile']) || !str((raw['hardwareProfile'] as Record<string, unknown>)['id'])) {
    bag.add('MALFORMED_BUNDLE', 'hardwareProfile.id must be a non-empty string', 'hardwareProfile.id');
    ok = false;
  }

  const unknownTop = Object.keys(raw).filter((k) => !ALLOWED_BUNDLE_FIELDS.includes(k));
  if (unknownTop.length > 0) {
    bag.add(
      'MALFORMED_BUNDLE',
      `bundle carries unrecognised top-level field(s): ${unknownTop.join(', ')}. ` +
        'Unknown fields are refused, not ignored: a payload must not be able to carry ' +
        'something that reads as a trust marker to a later consumer.',
      '$',
      `only [${ALLOWED_BUNDLE_FIELDS.join(', ')}]`,
      unknownTop.join(','),
    );
    ok = false;
  }

  if (!Array.isArray(raw['attempts'])) {
    bag.add('MALFORMED_BUNDLE', 'attempts must be an array', 'attempts');
    ok = false;
  } else if (raw['attempts'].length > IMPORT_LIMITS.maxAttemptsPerBundle) {
    bag.add(
      'MALFORMED_BUNDLE',
      `attempts exceeds ${IMPORT_LIMITS.maxAttemptsPerBundle}; an import is evidence, not a workload`,
      'attempts',
      `<= ${IMPORT_LIMITS.maxAttemptsPerBundle}`,
      String(raw['attempts'].length),
    );
    ok = false;
  } else {
    if (raw['attempts'].length === 0) {
      bag.add(
        'MALFORMED_BUNDLE',
        'attempts must not be empty — a verdict with no attempts behind it is an assertion, not evidence',
        'attempts',
      );
      ok = false;
    }
    raw['attempts'].forEach((a, i) => {
      if (!validateAttempt(a, i, bag)) ok = false;
    });
  }

  if (!validateAggregate(raw['aggregate'], bag)) ok = false;

  const prov = raw['provenance'];
  if (!isObject(prov)) {
    bag.add('PROVENANCE_INVALID', 'provenance must be an object', 'provenance');
    ok = false;
  } else {
    // The payload names an authority. That is a claim, recorded as one; it is
    // not what authorises anything (see ImportTrust). Requiring the literal
    // "luak" here only rejects evidence that does not even claim the right
    // origin — it grants nothing to evidence that does.
    if (prov['claimedAuthority'] !== 'luak') {
      bag.add(
        'PROVENANCE_INVALID',
        'provenance.claimedAuthority must be "luak". Note this is a claim the payload ' +
          'makes about itself and confers no trust; authorisation comes from the ' +
          "operator's trust anchor.",
        'provenance.claimedAuthority',
        'luak',
        String(prov['claimedAuthority']),
      );
      ok = false;
    }
    if (prov['verifiedByBokahli'] !== false) {
      bag.add(
        'PROVENANCE_INVALID',
        'provenance.verifiedByBokahli must be present and literally false. Bokahli holds ' +
          'no Luak key and cannot verify a Luak signature; a payload asserting otherwise ' +
          'is asserting something about Bokahli that Bokahli knows to be untrue.',
        'provenance.verifiedByBokahli',
        'false',
        String(prov['verifiedByBokahli']),
      );
      ok = false;
    }
    const unknownProv = Object.keys(prov).filter((k) => !ALLOWED_PROVENANCE_FIELDS.includes(k));
    if (unknownProv.length > 0) {
      bag.add('PROVENANCE_INVALID',
        `provenance carries unrecognised field(s): ${unknownProv.join(', ')}`,
        'provenance', 'no unrecognised fields', unknownProv.join(','));
      ok = false;
    }
    for (const arr of ['luakBundleIds', 'luakBundleHashes'] as const) {
      const v = prov[arr];
      if (Array.isArray(v) && v.length > IMPORT_LIMITS.maxProvenanceRefs) {
        bag.add('PROVENANCE_INVALID',
          `provenance.${arr} exceeds ${IMPORT_LIMITS.maxProvenanceRefs} entries`, `provenance.${arr}`);
        ok = false;
      }
    }
    if (typeof prov['note'] === 'string' && prov['note'].length > IMPORT_LIMITS.maxNoteLength) {
      bag.add('PROVENANCE_INVALID',
        `provenance.note exceeds ${IMPORT_LIMITS.maxNoteLength} characters`, 'provenance.note');
      ok = false;
    }
    if (!str(prov['sourceContractVersion'])) {
      bag.add('PROVENANCE_INVALID', 'provenance.sourceContractVersion is required', 'provenance.sourceContractVersion');
      ok = false;
    }
    if (!Array.isArray(prov['luakBundleIds']) || prov['luakBundleIds'].length === 0) {
      bag.add(
        'PROVENANCE_INVALID',
        'provenance.luakBundleIds must name at least one source bundle, so any claim here can be traced back',
        'provenance.luakBundleIds',
      );
      ok = false;
    }
    if (!Array.isArray(prov['luakBundleHashes'])) {
      bag.add('PROVENANCE_INVALID', 'provenance.luakBundleHashes must be an array', 'provenance.luakBundleHashes');
      ok = false;
    }
  }

  return ok;
}

// ---------------------------------------------------------------------------
// Aggregate consistency
// ---------------------------------------------------------------------------

function close(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= RATE_EPSILON;
}

function fmt(v: number | null): string {
  return v === null ? 'null' : String(Math.round(v * 1e6) / 1e6);
}

/**
 * Recompute every aggregate from the attempts and compare.
 *
 * This is the check that catches a bundle whose summary flatters its detail —
 * the failure mode where no single field is a lie but the whole is. It is a
 * comparison, never a correction: a mismatch is rejected, not overwritten.
 */
export function checkAggregateConsistency(
  attempts: readonly QualificationAttempt[],
  aggregate: QualificationAggregate,
  bag: ErrorBag,
): void {
  const counts = Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, 0])) as Record<AttemptOutcome, number>;
  for (const a of attempts) counts[a.outcome] += 1;

  if (aggregate.attemptCount !== attempts.length) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.attemptCount does not match the number of attempts supplied',
      'aggregate.attemptCount',
      String(attempts.length),
      String(aggregate.attemptCount),
    );
  }

  const distinctFixtures = new Set(attempts.map((a) => a.fixtureId)).size;
  if (aggregate.sampleCount !== distinctFixtures) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.sampleCount does not match the number of distinct fixtures attempted',
      'aggregate.sampleCount',
      String(distinctFixtures),
      String(aggregate.sampleCount),
    );
  }

  for (const o of ATTEMPT_OUTCOMES) {
    if (aggregate.outcomeCounts[o] !== counts[o]) {
      bag.add(
        'CONTRADICTORY_AGGREGATE',
        `aggregate.outcomeCounts.${o} does not match the attempts`,
        `aggregate.outcomeCounts.${o}`,
        String(counts[o]),
        String(aggregate.outcomeCounts[o]),
      );
    }
  }

  const scored = attempts.filter((a) => a.score !== null).map((a) => a.score as number);
  const mean = scored.length > 0 ? scored.reduce((s, v) => s + v, 0) / scored.length : null;
  if (!close(aggregate.meanScore, mean)) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.meanScore does not match the mean of the scored attempts',
      'aggregate.meanScore',
      fmt(mean),
      fmt(aggregate.meanScore),
    );
  }

  if (aggregate.scoreStdDev !== null) {
    const sd =
      scored.length > 0 && mean !== null
        ? Math.sqrt(scored.reduce((s, v) => s + (v - mean) ** 2, 0) / scored.length)
        : null;
    if (!close(aggregate.scoreStdDev, sd)) {
      bag.add(
        'CONTRADICTORY_AGGREGATE',
        'aggregate.scoreStdDev does not match the population standard deviation of the scored attempts',
        'aggregate.scoreStdDev',
        fmt(sd),
        fmt(aggregate.scoreStdDev),
      );
    }
  }

  const modelAttributable = attempts.filter((a) =>
    (MODEL_ATTRIBUTABLE_OUTCOMES as readonly string[]).includes(a.outcome),
  );
  const passRate =
    modelAttributable.length > 0
      ? modelAttributable.filter((a) => a.outcome === 'PASS').length / modelAttributable.length
      : null;
  if (!close(aggregate.passRate, passRate)) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.passRate does not match passes over model-attributable attempts',
      'aggregate.passRate',
      fmt(passRate),
      fmt(aggregate.passRate),
    );
  }

  const infra =
    attempts.length > 0
      ? attempts.filter((a) => (INFRASTRUCTURE_OUTCOMES as readonly string[]).includes(a.outcome)).length /
        attempts.length
      : null;
  if (!close(aggregate.infrastructureFailureRate, infra)) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.infrastructureFailureRate does not match provider/harness failures over all attempts',
      'aggregate.infrastructureFailureRate',
      fmt(infra),
      fmt(aggregate.infrastructureFailureRate),
    );
  }

  const schemaChecked = attempts.filter((a) => a.compliance.outputSchemaValid !== null);
  const schemaRate =
    schemaChecked.length > 0
      ? schemaChecked.filter((a) => a.compliance.outputSchemaValid === false).length / schemaChecked.length
      : null;
  if (!close(aggregate.schemaViolationRate, schemaRate)) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.schemaViolationRate does not match the attempts where the schema was checked',
      'aggregate.schemaViolationRate',
      fmt(schemaRate),
      fmt(aggregate.schemaViolationRate),
    );
  }

  const citeChecked = attempts.filter((a) => a.compliance.citationsValid !== null);
  const citeRate =
    citeChecked.length > 0
      ? citeChecked.filter((a) => a.compliance.citationsValid === false).length / citeChecked.length
      : null;
  if (!close(aggregate.citationViolationRate, citeRate)) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      'aggregate.citationViolationRate does not match the attempts where citations were checked',
      'aggregate.citationViolationRate',
      fmt(citeRate),
      fmt(aggregate.citationViolationRate),
    );
  }

  // Repeatability is only defined where a fixture was attempted more than once.
  // With no repeats the honest value is null, and 0 would be a claim of proven
  // stability that nothing here supports.
  const byFixture = new Map<string, AttemptOutcome[]>();
  for (const a of attempts) {
    const list = byFixture.get(a.fixtureId) ?? [];
    list.push(a.outcome);
    byFixture.set(a.fixtureId, list);
  }
  const repeated = [...byFixture.values()].filter((o) => o.length > 1);
  const disagreement =
    repeated.length > 0 ? repeated.filter((o) => new Set(o).size > 1).length / repeated.length : null;
  if (!close(aggregate.repeatabilityDisagreementRate, disagreement)) {
    bag.add(
      'CONTRADICTORY_AGGREGATE',
      repeated.length === 0
        ? 'aggregate.repeatabilityDisagreementRate must be null when no fixture was attempted twice — ' +
          '0 would assert a stability that was never measured'
        : 'aggregate.repeatabilityDisagreementRate does not match the repeated fixtures',
      'aggregate.repeatabilityDisagreementRate',
      fmt(disagreement),
      fmt(aggregate.repeatabilityDisagreementRate),
    );
  }

  if (aggregate.contextTierTokens !== null) {
    const tiers = new Set(attempts.map((a) => a.contextTierTokens).filter((t) => t !== null));
    if (tiers.size === 1 && !tiers.has(aggregate.contextTierTokens)) {
      bag.add(
        'CONTRADICTORY_AGGREGATE',
        'aggregate.contextTierTokens disagrees with the tier every attempt reports',
        'aggregate.contextTierTokens',
        String([...tiers][0]),
        String(aggregate.contextTierTokens),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Validate and accept one qualification bundle.
 *
 * Returns the frozen bundle on success, or every reason it was refused. Nothing
 * partial is ever returned: a bundle is usable or it is not.
 */
export function importQualificationBundle(raw: unknown, ctx: ImportContext): QualificationImportResult {
  const bag = new ErrorBag();

  if (!validateStructure(raw, bag)) {
    return { ok: false, errors: bag.list };
  }
  const bundle = raw;

  // 1. Version. Checked early because every later check assumes this layout.
  if (!SUPPORTED_QUALIFICATION_BUNDLE_VERSIONS.includes(bundle.bundleVersion)) {
    bag.add(
      'UNSUPPORTED_BUNDLE_VERSION',
      'this build does not implement that bundle version, and will not guess which fields moved',
      'bundleVersion',
      SUPPORTED_QUALIFICATION_BUNDLE_VERSIONS.join(' | '),
      bundle.bundleVersion,
    );
    // A bundle of an unknown shape cannot be meaningfully checked further.
    return { ok: false, errors: bag.list };
  }

  // 2. Payload integrity: the canonical hash Bokahli computes for itself.
  //
  //    This is integrity and only integrity. The hash is unkeyed, so anyone who
  //    can write the file can recompute it after editing; a match proves the
  //    payload is intact as received, never that Luak produced it. Authorship
  //    is settled at step 10, by the operator, not here.
  let recomputed: string;
  try {
    recomputed = canonicalHashExcluding(bundle, QUALIFICATION_CONTENT_HASH_FIELD);
  } catch (err) {
    bag.add(
      'UNCANONICALISABLE',
      `the payload cannot be canonicalised, so no hash can be computed over it: ${
        (err as Error).message
      }`,
      '$',
    );
    return { ok: false, errors: bag.list };
  }
  const hashVerified = recomputed === bundle.contentHash;
  if (!hashVerified) {
    bag.add(
      'CONTENT_HASH_MISMATCH',
      'the recomputed canonical hash does not match the stated contentHash: this payload ' +
        'is not the payload that was sealed',
      'contentHash',
      recomputed,
      bundle.contentHash,
    );
  }

  // 3. Task class and its contract version.
  const { key } = bundle;
  if (!isTaskClass(key.taskClass)) {
    bag.add(
      'UNKNOWN_TASK_CLASS',
      'no task-class contract is defined for that name in this build',
      'key.taskClass',
      Object.keys(TASK_CLASS_CONTRACT_VERSIONS).join(' | '),
      key.taskClass,
    );
  } else {
    const expected = TASK_CLASS_CONTRACT_VERSIONS[key.taskClass];
    if (key.taskClassContractVersion !== expected) {
      bag.add(
        'TASK_CONTRACT_VERSION_MISMATCH',
        'the evidence was produced against a different version of this task class. ' +
          'Changing the contract changes the question, so the old answer does not carry over',
        'key.taskClassContractVersion',
        expected,
        key.taskClassContractVersion,
      );
    }
  }

  // 4. Artifact. Identity, digest and quantisation must all match one installed
  //    artifact — not any two of the three.
  const artifact = ctx.installedArtifacts.find((a) => a.modelId === key.modelId);
  if (!artifact) {
    bag.add(
      'ARTIFACT_MISMATCH',
      'no installed artifact carries that identity',
      'key.modelId',
      ctx.installedArtifacts.map((a) => a.modelId).join(' | ') || '(none installed)',
      key.modelId,
    );
  } else {
    if (artifact.digest !== key.artifactDigest) {
      bag.add(
        'ARTIFACT_MISMATCH',
        'the evidence was produced against a different artifact than the one installed ' +
          'under this identity. Accepting it would qualify a model that was never tested',
        'key.artifactDigest',
        artifact.digest,
        key.artifactDigest,
      );
    }
    if (artifact.quantization !== key.quantization) {
      bag.add(
        'ARTIFACT_MISMATCH',
        'quantisation differs from the installed artifact; a different quantisation is a ' +
          'different model for every purpose qualification exists to serve',
        'key.quantization',
        artifact.quantization,
        key.quantization,
      );
    }
  }

  // 5. Runtime.
  if (key.runtimeName !== ctx.runtimeName || key.runtimeBuild !== ctx.runtimeBuild) {
    bag.add(
      'RUNTIME_MISMATCH',
      'the evidence was produced on a different runtime build than the one pinned here',
      'key.runtimeBuild',
      `${ctx.runtimeName}/${ctx.runtimeBuild}`,
      `${key.runtimeName}/${key.runtimeBuild}`,
    );
  }

  // 6. Hardware.
  if (key.hardwareProfileId !== ctx.hardwareProfileId) {
    bag.add(
      'HARDWARE_MISMATCH',
      'the evidence was produced on a different hardware profile',
      'key.hardwareProfileId',
      ctx.hardwareProfileId,
      key.hardwareProfileId,
    );
  }

  // 7. Staleness. Issuer expiry is enforced here; policy age limits are applied
  //    later, at decision time, because they can change without the evidence
  //    changing.
  const generated = Date.parse(bundle.generatedAt);
  if (generated - ctx.now.getTime() > FUTURE_SKEW_MS) {
    bag.add(
      'STALE_EVIDENCE',
      'generatedAt is in the future; either a clock is wrong or this was not generated when it claims',
      'generatedAt',
      `<= ${new Date(ctx.now.getTime() + FUTURE_SKEW_MS).toISOString()}`,
      bundle.generatedAt,
    );
  }
  if (bundle.expiresAt !== null) {
    const expires = Date.parse(bundle.expiresAt);
    if (expires <= ctx.now.getTime()) {
      bag.add(
        'STALE_EVIDENCE',
        'the issuer marked this evidence expired',
        'expiresAt',
        `> ${ctx.now.toISOString()}`,
        bundle.expiresAt,
      );
    }
  }

  // 8. Aggregates must agree with the attempts they summarise.
  checkAggregateConsistency(bundle.attempts, bundle.aggregate, bag);

  // 8b. Duplicate key.
  if (ctx.existingKeys) {
    const ks = QUALIFICATION_KEY_FIELDS.map((f) => String(key[f])).join('|');
    if (ctx.existingKeys.has(ks)) {
      bag.add(
        'DUPLICATE_KEY',
        'evidence for this exact key is already loaded; replacing it is an explicit operator act, not an import side effect',
        'key',
        'unique key',
        ks,
      );
    }
  }

  // 9. Context tier. Measurements taken at one context length are not
  //    measurements of another, so the tier is bound to the deployment rather
  //    than left to a policy line an operator might not write.
  if (bundle.aggregate.contextTierTokens === null) {
    bag.add(
      'CONTEXT_TIER_MISMATCH',
      'aggregate.contextTierTokens is unknown. A verdict that does not record the context ' +
        'it was earned at cannot be bound to a deployment that serves a specific one.',
      'aggregate.contextTierTokens',
      String(ctx.servedContextTokens),
      'null',
    );
  } else if (bundle.aggregate.contextTierTokens !== ctx.servedContextTokens) {
    bag.add(
      'CONTEXT_TIER_MISMATCH',
      'the evidence was produced at a different context tier than this deployment serves',
      'aggregate.contextTierTokens',
      String(ctx.servedContextTokens),
      String(bundle.aggregate.contextTierTokens),
    );
  }

  // 10. Import trust. The only step whose input comes from the operator rather
  //     than from the payload, and therefore the only step that can authorise
  //     anything. Everything above establishes what the evidence says and that
  //     it is internally consistent; none of it establishes who wrote it.
  const anchor = ctx.trustAnchor ?? EMPTY_TRUST_ANCHOR;
  const pinned = hashVerified && anchor.pinnedEvidenceDigests.includes(bundle.contentHash);
  const importTrust: ImportTrust = pinned
    ? { accepted: true, basis: 'OPERATOR_PINNED_DIGEST', anchorRef: anchor.anchorRef }
    : { accepted: false, basis: 'NONE', anchorRef: anchor.anchorRef };

  if (!bag.empty) return { ok: false, errors: bag.list };

  const frozen = deepFreeze(bundle);
  return {
    ok: true,
    accepted: Object.freeze({
      bundle: frozen,
      payloadIntegrity: Object.freeze({
        algorithm: 'bokahli-canonical-json-sha256-v1' as const,
        contentHash: recomputed,
        verified: hashVerified,
      }),
      upstreamProvenance: frozen.provenance,
      importTrust: Object.freeze(importTrust),
    }),
  };
}

/**
 * Freeze accepted evidence.
 *
 * Imported evidence is a record of what someone else measured. Nothing
 * downstream has any business editing it, and a frozen object turns an attempt
 * to do so into an immediate failure rather than a quiet divergence between
 * what Bokahli reports and what Luak issued.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value);
}
