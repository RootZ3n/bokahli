/**
 * Canonical JSON and content hashing.
 *
 * A content hash is only an identity if two parties can independently arrive at
 * the same bytes. That requires a canonical form — the same value must always
 * serialise identically, whatever route it took to get here. Round-tripping
 * through a database, a message queue, or a `jq` filter must not change the
 * hash of evidence that has not changed.
 *
 * The form used here is the familiar JCS-style one: object keys sorted by their
 * UTF-16 code units, no insignificant whitespace, arrays left in order because
 * their order is meaningful.
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
 * Serialise a value to canonical JSON.
 *
 * Rejects what JSON cannot represent losslessly rather than silently dropping
 * it. `undefined` in particular is refused: JSON.stringify would omit the key,
 * which would make a bundle missing a required field hash the same as one that
 * never had it.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set(), '$');
}

function write(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`${path}: ${String(n)} has no JSON representation`);
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
  if (seen.has(obj)) throw new CanonicalizationError(`${path}: circular reference`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Array order is data, not presentation. It is never sorted.
      const parts = obj.map((v, i) => write(v, seen, `${path}[${i}]`));
      return `[${parts.join(',')}]`;
    }

    const keys = Object.keys(obj as Record<string, unknown>).sort(compareCodeUnits);
    const parts: string[] = [];
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      parts.push(`${JSON.stringify(k)}:${write(v, seen, `${path}.${k}`)}`);
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

/** sha256 over the canonical form, prefixed the way every digest here is. */
export function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/**
 * Hash a value with one key omitted at the top level.
 *
 * Used for self-describing payloads: a bundle cannot contain a hash of itself
 * including that hash, so the hash field is excluded from its own input.
 */
export function canonicalHashExcluding<T extends object>(value: T, omit: keyof T & string): string {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy[omit];
  return canonicalHash(copy);
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
