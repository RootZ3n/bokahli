/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/base64.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — a base64 codec that does not use the platform's.
 * ============================================================
 * Written out, in plain arithmetic, and used everywhere Velum touches base64.
 * There are two reasons, and the second one arrived after the first.
 *
 * ## Node's decoder is permissive
 *
 * `Buffer.from(s, "base64")` skips characters it does not recognise and accepts
 * a final group whose unused bits are non-zero, so `QQ==` and `QR==` both yield
 * `A`. For a detector that is a hole: one payload can be spelled several ways,
 * and the defence — re-encode and compare strings — is a second conversion
 * standing behind the first. Here canonicality is structural. The alphabet is
 * checked per character, the padding arithmetic is checked, and the unused bits
 * of a final group are required to be zero, so a non-canonical spelling is a
 * rejection rather than a decode.
 *
 * ## Node's encoder is wrong on this host
 *
 * Measured on Mushin, 2026-08-20: `Buffer.prototype.toString("base64")` returns
 * a wrong character roughly once in a thousand calls **on one physical core**
 * (core 4, logical CPUs 8 and 9 — its two SMT siblings), and never on the other
 * twenty-two. The source bytes are provably unchanged before and after; a
 * plain-JavaScript encoder over the same buffer is correct; coreutils, OpenSSL
 * and Python are correct; no machine-check exception is raised. It is silent
 * data corruption from one degraded core, and it survives across processes,
 * threads and worker threads because it follows the core rather than the
 * program.
 *
 * That is a host fault and not Velum's to fix. What is Velum's to fix is
 * *depending* on the faulty instruction path at all. Nothing in this file uses
 * `Buffer`, `atob`, `btoa`, or any platform base64 routine, in either
 * direction, so a detector's verdict does not vary with which core the
 * scheduler happened to pick.
 *
 * `IMPLEMENTATION` is bound into identities that record which codec produced a
 * value, so "encoded with the audited implementation" is a checkable claim
 * rather than an assumption.
 */

/** Identity of this codec. Bound into schemas that record how bytes were encoded. */
export const IMPLEMENTATION = "velum.base64/1" as const;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Value of an ASCII code unit in the base64 alphabet, or -1.
 *
 * A table rather than arithmetic so the alphabet is visible and total: anything
 * not in it decodes to nothing rather than to a plausible byte.
 */
const VALUE: readonly number[] = (() => {
  const t = new Array<number>(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export type Base64Failure =
  | "not-canonical-length"
  | "bad-padding"
  | "bad-character"
  | "non-zero-tail-bits";

export class Base64Error extends Error {
  readonly failure: Base64Failure;
  constructor(failure: Base64Failure, message: string) {
    super(message);
    this.name = "Base64Error";
    this.failure = failure;
  }
}

/** Encode bytes as canonical base64. Total: every byte sequence has one spelling. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2] as string;
    out += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)] as string;
    out += b === undefined ? "=" : (ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)] as string);
    out += c === undefined ? "=" : (ALPHABET[c & 0x3f] as string);
  }
  return out;
}

/**
 * Decode canonical base64 from ASCII code units, or return null.
 *
 * Null on anything that is not exactly one canonical spelling: an unknown
 * character, padding that does not agree with the length, a length one past a
 * multiple of four, or a final group carrying bits with nowhere to land.
 *
 * Takes code units rather than a string on purpose. Assembling a candidate
 * character by character while walking a cell table builds a rope, and passing
 * ropes to platform decoders is how the first version of this went wrong.
 */
export function decodeBase64Codes(codes: readonly number[]): Uint8Array | null {
  let n = codes.length;
  let padding = 0;
  while (n > 0 && codes[n - 1] === 0x3d) { padding += 1; n -= 1; }
  if (padding > 2 || n === 0) return null;

  const rem = n % 4;
  if (rem === 1) return null;
  if (padding > 0 && (n + padding) % 4 !== 0) return null;
  if (padding > 0 && rem !== (4 - padding) % 4) return null;

  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    let acc = 0;
    for (let k = 0; k < 4; k++) {
      const v = valueAt(codes, i + k);
      if (v < 0) return null;
      acc = (acc << 6) | v;
    }
    out[o++] = (acc >>> 16) & 0xff;
    out[o++] = (acc >>> 8) & 0xff;
    out[o++] = acc & 0xff;
  }
  if (rem === 2) {
    const a = valueAt(codes, i);
    const b = valueAt(codes, i + 1);
    if (a < 0 || b < 0) return null;
    // The low four bits of the second character have no byte to land in. A
    // non-zero value there is a different spelling of the same bytes.
    if ((b & 0x0f) !== 0) return null;
    out[o++] = ((a << 2) | (b >> 4)) & 0xff;
  } else if (rem === 3) {
    const a = valueAt(codes, i);
    const b = valueAt(codes, i + 1);
    const c = valueAt(codes, i + 2);
    if (a < 0 || b < 0 || c < 0) return null;
    if ((c & 0x03) !== 0) return null;
    out[o++] = ((a << 2) | (b >> 4)) & 0xff;
    out[o++] = ((b << 4) | (c >> 2)) & 0xff;
  }
  return out.subarray(0, o);
}

/** Decode a base64 string, or throw a typed `Base64Error`. */
export function decodeBase64(text: string): Uint8Array {
  const codes: number[] = [];
  for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i));
  const out = decodeBase64Codes(codes);
  if (out === null) {
    // The specific reason, for a caller that has to report one. Recomputed
    // rather than threaded out of the hot path.
    let body = text;
    let pad = 0;
    while (body.endsWith("=")) { body = body.slice(0, -1); pad += 1; }
    if (pad > 2) throw new Base64Error("bad-padding", `${pad} padding characters`);
    if (body.length % 4 === 1) throw new Base64Error("not-canonical-length", `length ${text.length} is not canonical`);
    for (const ch of body) {
      if (ch.charCodeAt(0) >= 128 || VALUE[ch.charCodeAt(0)] === -1) {
        throw new Base64Error("bad-character", `${JSON.stringify(ch)} is not in the base64 alphabet`);
      }
    }
    throw new Base64Error("non-zero-tail-bits", "the final group carries bits with nowhere to land");
  }
  return out;
}

function valueAt(codes: readonly number[], i: number): number {
  const c = codes[i];
  if (c === undefined || c < 0 || c >= 128) return -1;
  return VALUE[c] as number;
}

/** Lowercase hex. The comparison form for byte identity: one spelling, no SIMD. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
  return out;
}

/** Parse lowercase or uppercase hex, or return null. */
export function fromHex(text: string): Uint8Array | null {
  if (text.length % 2 !== 0) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexVal(text.charCodeAt(i * 2));
    const lo = hexVal(text.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

/** Constant-shape byte equality. Returns false on any difference, including length. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Is the platform converting bytes faithfully, right now?
 *
 * A probe, not a dependency. Callers on an integrity path use the audited codec
 * for their actual work and call this to find out whether the host is
 * miscomputing — so a disagreement becomes a typed host fault instead of a
 * mysterious mismatch attributed to whatever was being measured.
 *
 * Two ways to fail. The encoder can disagree with this implementation, which is
 * what one degraded core on the audited machine does. Or the input can change
 * underneath the conversion, which would mean the bytes a result describes are
 * not the bytes that were read — checked by hashing the input to hex before and
 * after, since hex uses no vectorised path.
 *
 * Returns null when the host looks sound.
 */
export interface PlatformFault {
  readonly kind: "encoder-disagreement" | "source-mutated";
  readonly audited: string;
  readonly platform: string;
  readonly hexBefore: string;
  readonly hexAfter: string;
}

export function platformBase64Disagrees(bytes: Uint8Array): PlatformFault | null {
  const hexBefore = toHex(bytes);
  const audited = encodeBase64(bytes);
  let platform: string;
  try {
    // The one deliberate call to the platform encoder in this codebase, and its
    // only purpose is to catch it being wrong.
    platform = Buffer.from(bytes).toString("base64");
  } catch {
    platform = "(threw)";
  }
  const hexAfter = toHex(bytes);
  if (hexBefore !== hexAfter) {
    return { kind: "source-mutated", audited, platform, hexBefore, hexAfter };
  }
  if (platform !== audited) {
    return { kind: "encoder-disagreement", audited, platform, hexBefore, hexAfter };
  }
  return null;
}
