/**
 * The audited base64 codec, as a separate entry point.
 *
 * Split from the detector surface deliberately. `packages/server/src/trust.ts`
 * is the only file allowed to reach the detector — a boundary that exists in
 * several places is not a boundary — but this is a byte codec with no policy in
 * it, and `packages/runtime` needs the same one on the tokenizer canary path.
 * Importing it does not import a second detector, and the invariant test knows
 * the difference.
 *
 * Why not the platform's: Node's base64 *encoder* returns a wrong character
 * roughly once in a thousand calls on one physical core of this machine, and
 * its decoder is permissive enough that one payload has several spellings. See
 * `vendor/core/base64.ts` for the measurements.
 */
export {
  IMPLEMENTATION as BASE64_IMPLEMENTATION,
  Base64Error,
  encodeBase64,
  decodeBase64,
  decodeBase64Codes,
  toHex,
  fromHex,
  bytesEqual,
  platformBase64Disagrees,
  type Base64Failure,
  type PlatformFault,
} from './vendor/core/base64.js';
