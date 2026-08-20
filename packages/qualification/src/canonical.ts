/**
 * Canonical JSON and content hashing.
 *
 * A content hash is only an identity if two parties can independently arrive at
 * the same bytes. That requires a canonical form — the same value must always
 * serialise identically, whatever route it took to get here. Round-tripping
 * through a database, a message queue, or a `jq` filter must not change the
 * hash of evidence that has not changed.
 *
 * ## What this is, precisely
 *
 * Object keys sorted by UTF-16 code unit, no insignificant whitespace, arrays
 * left in order because their order is meaningful, `-0` normalised to `0`, and
 * numbers emitted by ECMAScript `Number::toString` via `JSON.stringify`.
 *
 * That is close to RFC 8785 (JCS) and is **not** claimed to be it. Two
 * differences are deliberate and one is a limit worth stating:
 *
 *   - Non-finite numbers and `undefined` are rejected outright rather than
 *     serialised as `null`, so a missing required field can never hash the same
 *     as a present one.
 *   - Integers outside the safe range are rejected. `JSON.parse` silently
 *     rounds `9007199254740993` to `…992`, so two different documents would
 *     otherwise reach the same digest; refusing them keeps "same digest implies
 *     same document" true.
 *   - No Unicode normalisation is performed, matching JCS. `"e\u0301"` and
 *     `"\u00e9"` are different strings and hash differently. Callers who need
 *     them to compare equal must normalise before hashing; Bokahli does not,
 *     because silently rewriting someone else's evidence text is worse than
 *     making them identical on purpose.
 *
 * ## Why this is not simply Luak's hash
 *
 * Luak computes `sha256:hex(JSON.stringify(bundle, null, 0))` (see
 * `utils/hashing.ts` in RootZ3n/luak). That is insertion-order dependent: it
 * happens to be stable while a bundle stays inside the process that built it,
 * and stops being stable the moment anything reorders keys — which JSON
 * explicitly permits and many tools do. Two byte-identical-in-meaning bundles
 * can hash differently.
 *
 * Bokahli therefore hashes its own import bundles canonically, and carries
 * Luak's `bundle_hash` alongside as provenance rather than adopting it as
 * identity. `luakCompatBundleHash` reproduces Luak's algorithm exactly, so the
 * difference stays demonstrable instead of asserted; it is a compatibility
 * shim, not a recommendation.
 */
import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {}

/**
 * Domain tag mixed into every digest.
 *
 * Without it, a digest is a hash of a shape, and any other structure with the
 * same canonical form produces the same value. With it, a digest means "this
 * exact algorithm, over this exact kind of thing", and a hash computed for one
 * purpose cannot be replayed as a hash for another.
 */
export const CANONICAL_HASH_DOMAIN = 'bokahli.canonical-json.sha256.v1' as const;

/**
 * Maximum object/array nesting the canonicaliser will walk.
 *
 * The walk is recursive, and the input is attacker-controlled in exactly the
 * case that matters: an evidence file. Without a bound, a payload nested a few
 * tens of thousands deep exhausts the JS stack and raises RangeError from
 * somewhere far from the call, which is a crash rather than a rejection. A
 * bounded depth turns it into a typed refusal.
 */
export const MAX_CANONICAL_DEPTH = 64;

/**
 * Serialise a value to canonical JSON.
 *
 * Rejects what JSON cannot represent losslessly rather than silently dropping
 * it. `undefined` in particular is refused: JSON.stringify would omit the key,
 * which would make a bundle missing a required field hash the same as one that
 * never had it.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set(), '$', 0);
}

function write(value: unknown, seen: Set<object>, path: string, depth: number): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`${path}: ${String(n)} has no JSON representation`);
    }
    // An integer past 2^53 cannot survive a JSON round trip: JSON.parse rounds
    // it, so two distinct documents would reach the same digest. Refusing keeps
    // "same digest implies same document" true rather than nearly true.
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
      throw new CanonicalizationError(
        `${path}: ${String(n)} is outside the safe integer range and cannot round-trip through JSON`,
      );
    }
    // -0 and 0 are the same number and must produce the same bytes.
    return JSON.stringify(n === 0 ? 0 : n);
  }

  if (t === 'string') return JSON.stringify(value);

  if (t === 'undefined') {
    throw new CanonicalizationError(
      `${path}: undefined is not canonicalisable — use null for an explicitly unknown value`,
    );
  }

  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new CanonicalizationError(`${path}: ${t} has no JSON representation`);
  }

  const obj = value as object;
  if (depth >= MAX_CANONICAL_DEPTH) {
    throw new CanonicalizationError(
      `${path}: nesting deeper than ${MAX_CANONICAL_DEPTH} levels is refused`,
    );
  }
  if (seen.has(obj)) throw new CanonicalizationError(`${path}: circular reference`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Array order is data, not presentation. It is never sorted.
      const parts = obj.map((v, i) => write(v, seen, `${path}[${i}]`, depth + 1));
      return `[${parts.join(',')}]`;
    }

    const keys = Object.keys(obj as Record<string, unknown>).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      parts.push(`${JSON.stringify(k)}:${write(v, seen, `${path}.${k}`, depth + 1)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Sort by UTF-16 code unit, which is what JCS specifies. `localeCompare` and
 * the default `Array.sort` comparator are both wrong here: the first is
 * locale-dependent, and the second stringifies but is otherwise fine — being
 * explicit costs nothing and removes the question.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * sha256 over the canonical form, under an explicit domain tag.
 *
 * The preimage is `<domain>\n<canonical json>`. The tag is inside the hashed
 * bytes rather than alongside them, so a digest cannot be lifted from one
 * context and presented as valid in another.
 */
export function canonicalHash(value: unknown): string {
  return digest(`${CANONICAL_HASH_DOMAIN}\n${canonicalJson(value)}`);
}

/**
 * Hash a value with one top-level key omitted.
 *
 * Used for self-describing payloads: a bundle cannot contain a hash of itself
 * including that hash, so the hash field is excluded from its own preimage. The
 * *name* of the excluded field is written into the preimage, so "hashed with
 * contentHash removed" and "hashed with nothing removed, and there happened to
 * be no contentHash" are different inputs and cannot collide.
 */
export function canonicalHashExcluding<T extends object>(value: T, omit: keyof T & string): string {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy[omit];
  return digest(
    `${CANONICAL_HASH_DOMAIN}\nexcluding:${JSON.stringify(omit)}\n${canonicalJson(copy)}`,
  );
}

function digest(preimage: string): string {
  return `sha256:${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

/**
 * Luak's hash algorithm, reproduced exactly for compatibility checks.
 *
 * `sha256Object(obj) = sha256Hex(JSON.stringify(obj, null, 0))`. Insertion-order
 * dependent by construction. Present so the divergence from `canonicalHash` can
 * be tested rather than taken on trust; do not use it as an identity.
 */
export function luakCompatBundleHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value, null, 0), 'utf8').digest('hex')}`;
}
