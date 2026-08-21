/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/a32/normalize.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — normalization with provenance.
 * ============================================================
 * The A32 normative pipeline, ported from the operator-owned ABAIYA
 * implementation (`abaiya-policy/normalize.rs`, `RootZ3n/abaiya` at `a471252`):
 *
 *   1. zero-width removal
 *   2. leetspeak folding
 *   3. base64 segment decoding, **appended** rather than substituted
 *
 * ## Why this is a contract and not an implementation detail
 *
 * ARCH-003 originally listed normalization as an allowed implementation
 * difference while requiring identical classification. A32 found that
 * unsatisfiable: fixture `encoded-001` classifies as an injection under the
 * TypeScript reference and as `safe` under Python purely because of
 * normalization. Two engines cannot agree on findings while disagreeing on what
 * they scanned.
 *
 * ## What V1 adds: segments
 *
 * The Rust original returns a normalized *string*. A string cannot answer "which
 * bytes of the caller's evidence does this finding point at", and Velum's
 * consumers need exactly that. So normalization here returns an ordered list of
 * **segments**, each recording where its normalized bytes came from and how
 * exactly that mapping holds:
 *
 *   `exact`     one-to-one; the raw range and the normalized range correspond
 *   `deletion`  raw bytes with no normalized image (zero-width removal)
 *   `derived`   normalized bytes with no per-character raw image, but a known
 *               *parent* raw span (base64 decoding)
 *
 * A finding in a `derived` segment reports the parent span — the encoded source
 * — and marks itself derived. It does **not** get a fabricated offset into the
 * decoded text, because those bytes do not exist in the caller's evidence.
 *
 * ## Leetspeak folds injections only
 *
 * `0→o 1→i 3→e 4→a 5→s 7→t` is applied for injection matching and never for
 * credentials: folding a real secret corrupts it, and a corrupted secret both
 * fails to match its own pattern and stops being suppressible.
 */
import { decodeUtf8, endOf, toUtf8, type ByteSpan, type DecodedText } from "../bytes.js";
import { decodeBase64Codes } from "../base64.js";

export const NORMALIZATION_VERSION = "velum.normalize.a32-1" as const;

export type TransformationKind =
  | "identity"
  | "zero-width-removal"
  | "leetspeak-fold"
  | "base64-decode";

export type MappingFidelity = "exact" | "deletion" | "derived";

export interface NormalizedSegment {
  /** Range in the normalized bytes. Empty for a deletion. */
  readonly normalized: ByteSpan;
  /**
   * Range in the raw source bytes. For `derived` segments this is the *parent*
   * span — the encoded region the material came from — not a per-character map.
   */
  readonly raw: ByteSpan;
  readonly transformation: TransformationKind;
  readonly fidelity: MappingFidelity;
  /** Decoder identity, for derived material. */
  readonly decoder: string | null;
}

export interface NormalizedText {
  readonly version: typeof NORMALIZATION_VERSION;
  /** The normalized bytes the detector scans. */
  readonly bytes: Uint8Array;
  readonly decoded: DecodedText;
  readonly segments: readonly NormalizedSegment[];
  /** Stages actually applied, in order. */
  readonly stages: readonly TransformationKind[];
}

/** Zero-width and bidi-control code points removed before matching. */
const ZERO_WIDTH = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069, 0x00ad,
]);

const LEET: ReadonlyMap<number, number> = new Map([
  [0x30, 0x6f], [0x31, 0x69], [0x33, 0x65], [0x34, 0x61], [0x35, 0x73], [0x37, 0x74],
]);

/**
 * Deterministic ceilings for one `normalize()` call.
 *
 * Every one of these bounds a collection that an attacker can grow by supplying
 * more evidence. They are stated here, checked in `normalize`, and reported on
 * the result, because "linear in the input" is a rate and not a limit: an
 * inspection path that can be made to allocate four hundred megabytes needs a
 * number, not a slope.
 */
export const NORMALIZE_LIMITS = Object.freeze({
  /** Raw bytes accepted. Matches the VM's own scan limit. */
  maxRawBytes: 4 * 1024 * 1024,
  /** Normalized bytes produced, raw plus every appended decode. */
  maxNormalizedBytes: 8 * 1024 * 1024,
  /** Segments retained. Runs are coalesced, so this is reached by structure. */
  maxSegments: 200_000,
  /** Base64 candidates examined, whether or not they decode. */
  maxBase64Candidates: 4_096,
  /** Bytes of decoded material appended across all candidates. */
  maxDecodedBytes: 1024 * 1024,
});

export class NormalizeLimitExceeded extends Error {
  readonly limit: string;
  constructor(limit: string, message: string) {
    super(message);
    this.name = "NormalizeLimitExceeded";
    this.limit = limit;
  }
}

function isBase64Alphabet(cp: number): boolean {
  return (
    (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) ||
    (cp >= 0x30 && cp <= 0x39) || cp === 0x2b || cp === 0x2f || cp === 0x3d
  );
}

/**
 * Decode a base64 candidate from its character codes.
 *
 * The arithmetic lives in `core/base64.ts` and is shared with every other
 * base64 site in this package, for two reasons recorded there: Node's decoder
 * is permissive enough that one payload has several spellings, and on the
 * machine this was audited on Node's *encoder* returns a wrong character
 * roughly once in a thousand calls on one degraded CPU core. A detector whose
 * normalization stage varies with which core the scheduler picked is not a
 * detector.
 *
 * Returns null when the run is not canonical base64, decodes to invalid UTF-8,
 * or decodes to something with no printable content. "Fails safely" here means
 * the material is simply not appended: an ambiguous decode must not become
 * evidence that an injection was present, and must not become evidence that one
 * was absent either — the raw text is still scanned exactly as it arrived.
 */
function decodeBase64Run(codes: readonly number[]): string | null {
  const bytes = decodeBase64Codes(codes);
  if (bytes === null || bytes.length === 0) return null;

  // Decoded bytes must themselves be well-formed UTF-8. `decodeUtf8` is the
  // same decoder the rest of the pipeline uses, so "valid" means one thing.
  const decoded = decodeUtf8(bytes);
  if (!decoded.wellFormed) return null;
  const text = new TextDecoder().decode(bytes);

  // Control-heavy output is binary, not smuggled instructions.
  let printable = 0;
  const total = decoded.length;
  for (let k = 0; k < total; k++) {
    const c = decoded.cp[k] as number;
    if (c === 0x09 || c === 0x0a || c === 0x0d || c >= 0x20) printable += 1;
  }
  if (total === 0 || printable / total < 0.9) return null;
  return text;
}


export interface NormalizeOptions {
  /** Injection matching folds leetspeak; credential matching must not. */
  readonly foldLeetspeak?: boolean;
  readonly decodeBase64?: boolean;
  readonly removeZeroWidth?: boolean;
}

/**
 * Normalize raw bytes, recording where every normalized byte came from.
 *
 * Linear in the input. The segment list is built as the scan proceeds, so no
 * mapping is ever reconstructed after the fact — a reconstructed mapping is a
 * second implementation of the transformation, and the two would eventually
 * disagree about exactly the inputs that matter.
 */
export function normalize(rawBytes: Uint8Array, opts: NormalizeOptions = {}): NormalizedText {
  const foldLeet = opts.foldLeetspeak ?? true;
  const decodeB64 = opts.decodeBase64 ?? true;
  const stripZw = opts.removeZeroWidth ?? true;

  if (rawBytes.length > NORMALIZE_LIMITS.maxRawBytes) {
    throw new NormalizeLimitExceeded(
      "maxRawBytes",
      `input of ${rawBytes.length} bytes exceeds the ${NORMALIZE_LIMITS.maxRawBytes}-byte normalization limit`,
    );
  }

  const raw = decodeUtf8(rawBytes);
  const stages: TransformationKind[] = [];
  const segments: NormalizedSegment[] = [];
  // A byte array sized once, not a `number[]` grown element by element. The
  // array-of-numbers form cost roughly a hundred megabytes of heap per megabyte
  // of evidence, and `Detector.scan` normalizes twice.
  const out = new Uint8Array(Math.min(
    NORMALIZE_LIMITS.maxNormalizedBytes,
    rawBytes.length * 2 + NORMALIZE_LIMITS.maxDecodedBytes + 64,
  ));
  let normLen = 0;

  const pushSegment = (seg: NormalizedSegment): void => {
    if (segments.length >= NORMALIZE_LIMITS.maxSegments) {
      throw new NormalizeLimitExceeded(
        "maxSegments",
        `normalization produced more than ${NORMALIZE_LIMITS.maxSegments} segments`,
      );
    }
    segments.push(seg);
  };

  const writeBytes = (bytes: Uint8Array): void => {
    if (normLen + bytes.length > NORMALIZE_LIMITS.maxNormalizedBytes) {
      throw new NormalizeLimitExceeded(
        "maxNormalizedBytes",
        `normalization exceeded ${NORMALIZE_LIMITS.maxNormalizedBytes} normalized bytes`,
      );
    }
    out.set(bytes, normLen);
    normLen += bytes.length;
  };

  const pushBytes = (
    bytes: Uint8Array,
    rawSpan: ByteSpan,
    transformation: TransformationKind,
    fidelity: MappingFidelity,
    decoder: string | null,
  ): void => {
    const start = normLen;
    writeBytes(bytes);
    pushSegment({
      normalized: { startByte: start, endByte: normLen },
      raw: rawSpan,
      transformation,
      fidelity,
      decoder,
    });
  };

  // ── stage 1 and 2: zero-width removal and leetspeak folding ──────────────
  //
  // Identity runs are coalesced. One segment per code point is the same
  // information at a million times the cost, and `projectToRaw` walks the list
  // once per finding, so the list's length is a term in the citation path too.
  // A run is contiguous in both coordinate systems, so an offset inside it maps
  // one-to-one and no precision is lost by merging.
  let runRawStart = -1;
  let runRawEnd = -1;
  let runNormStart = -1;

  const flushRun = (): void => {
    if (runRawStart < 0) return;
    pushSegment({
      normalized: { startByte: runNormStart, endByte: normLen },
      raw: { startByte: runRawStart, endByte: runRawEnd },
      transformation: "identity",
      fidelity: "exact",
      decoder: null,
    });
    runRawStart = -1;
  };

  for (let ci = 0; ci < raw.length; ci++) {
    const cellCp = raw.cp[ci] as number;
    const cellStart = raw.start[ci] as number;
    const cellEnd = endOf(raw, ci);
    const rawSpan = { startByte: cellStart, endByte: cellEnd };

    if (stripZw && ZERO_WIDTH.has(cellCp)) {
      flushRun();
      if (!stages.includes("zero-width-removal")) stages.push("zero-width-removal");
      pushSegment({
        normalized: { startByte: normLen, endByte: normLen },
        raw: rawSpan,
        transformation: "zero-width-removal",
        fidelity: "deletion",
        decoder: null,
      });
      continue;
    }

    const folded = foldLeet ? LEET.get(cellCp) : undefined;
    if (folded !== undefined) {
      flushRun();
      if (!stages.includes("leetspeak-fold")) stages.push("leetspeak-fold");
      pushBytes(toUtf8(String.fromCodePoint(folded)), rawSpan, "leetspeak-fold", "exact", null);
      continue;
    }

    if (runRawStart < 0) {
      runRawStart = cellStart;
      runNormStart = normLen;
    }
    runRawEnd = cellEnd;
    writeBytes(rawBytes.subarray(cellStart, cellEnd));
  }
  flushRun();

  // ── stage 3: base64 ──────────────────────────────────────────────────────
  if (decodeB64) {
    for (const c of base64Candidates(raw, rawBytes, stripZw)) {
      const text = decodeBase64Run(c.codes);
      if (text === null) continue;
      if (!stages.includes("base64-decode")) stages.push("base64-decode");
      // Decoded material goes through the same folding the raw text got.
      // Appending it unfolded left an obvious hole: `1gn0r3 all pr3v10us
      // 1nstruct10ns` was detected in plain text and missed the moment it was
      // base64-encoded, because the leetspeak stage had already run.
      const folded = foldLeet ? foldLeetspeakText(text) : text;
      const decodedBytes = toUtf8(folded);
      if (decodedBytes.length > NORMALIZE_LIMITS.maxDecodedBytes) {
        throw new NormalizeLimitExceeded(
          "maxDecodedBytes",
          `a base64 candidate decoded to ${decodedBytes.length} bytes, past the ${NORMALIZE_LIMITS.maxDecodedBytes}-byte cap`,
        );
      }
      const parent: ByteSpan = { startByte: c.startByte, endByte: c.endByte };
      // A separator so a decoded run cannot form a match by abutting its
      // neighbour, which would be a finding in text that never existed.
      pushBytes(toUtf8("\n"), parent, "base64-decode", "derived", "base64");
      pushBytes(decodedBytes, parent, "base64-decode", "derived", "base64");
    }
  }

  if (stages.length === 0) stages.push("identity");
  const bytes = out.slice(0, normLen);
  return {
    version: NORMALIZATION_VERSION,
    bytes,
    decoded: decodeUtf8(bytes),
    segments: Object.freeze(segments),
    stages: Object.freeze(stages),
  };
}

function foldLeetspeakText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const folded = LEET.get(cp);
    out += folded === undefined ? ch : String.fromCodePoint(folded);
  }
  return out;
}

interface Base64Candidate {
  /**
   * The candidate's ASCII code units, with any interleaved zero-width code
   * points removed.
   *
   * Code units rather than a string: assembling one with `+=` while stepping
   * the cell table builds a cons string, and Node's base64 fast path
   * mis-decoded those intermittently. See `decodeBase64Run`.
   */
  readonly codes: readonly number[];
  /** Parent span in the caller's raw bytes, inclusive of the removed ones. */
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * Locate base64 candidates over the decoded cell table.
 *
 * Two things this does not do, both of which the previous implementation did.
 *
 * It does not re-decode the raw bytes into a JavaScript string and convert
 * UTF-16 match indices with `toUtf8(text.slice(0, i)).length`. That call is
 * linear in the input and ran once per candidate, so a document full of
 * base64-looking words was quadratic: half a megabyte took a second, and the
 * four-megabyte scan limit would have taken the better part of a minute before
 * a single pattern ran. Cells already carry their byte offsets.
 *
 * It also does not read those offsets out of a lossy decode. `TextDecoder`
 * turns each ill-formed byte into U+FFFD, which re-encodes to three bytes, so
 * one stray `0x80` ahead of a payload shifted every derived parent span by two
 * and the citation named the wrong bytes. Offsets come from the cell table,
 * which tiles the original bytes exactly.
 *
 * And it looks *through* zero-width characters. Base64 runs used to be found in
 * the raw text before zero-width removal, and the normalized text was never
 * rescanned — so a single U+200B inside a payload split the run below the
 * sixteen-character threshold and the decode stage never fired. That is
 * precisely the evasion zero-width removal exists to stop.
 */
function* base64Candidates(
  raw: DecodedText,
  rawBytes: Uint8Array,
  skipZeroWidth: boolean,
): Generator<Base64Candidate> {
  const n = raw.length;
  let issued = 0;
  let i = 0;
  while (i < n) {
    if (!isBase64Alphabet(raw.cp[i] as number)) { i += 1; continue; }
    const startByte = raw.start[i] as number;

    const codes: number[] = [];
    let end = i;
    let j = i;
    while (j < n) {
      const c = raw.cp[j] as number;
      if (skipZeroWidth && ZERO_WIDTH.has(c)) { j += 1; continue; }
      if (!isBase64Alphabet(c)) break;
      codes.push(c);
      end = j;
      j += 1;
    }
    i = j === i ? i + 1 : j;

    // `{16,}={0,2}` in prose: at least sixteen alphabet characters, and any
    // padding only at the end.
    let pad = 0;
    while (pad < codes.length && codes[codes.length - 1 - pad] === 0x3d) pad += 1;
    const bodyLen = codes.length - pad;
    if (bodyLen < 16 || pad > 2) continue;
    let embeddedPad = false;
    for (let k = 0; k < bodyLen; k++) if (codes[k] === 0x3d) { embeddedPad = true; break; }
    if (embeddedPad) continue;

    if (++issued > NORMALIZE_LIMITS.maxBase64Candidates) {
      throw new NormalizeLimitExceeded(
        "maxBase64Candidates",
        `input contains more than ${NORMALIZE_LIMITS.maxBase64Candidates} base64 candidates`,
      );
    }
    void rawBytes;
    yield { codes, startByte, endByte: endOf(raw, end) };
  }
}

export interface RawProjection {
  /** The raw span this normalized span maps back to, or null. */
  readonly raw: ByteSpan | null;
  readonly fidelity: MappingFidelity | "unavailable";
  readonly transformation: TransformationKind | null;
  readonly decoder: string | null;
}

/**
 * Project a span in the normalized bytes back onto raw source bytes.
 *
 * Exact when every segment it touches is `exact`. An `exact` segment has the
 * same length in both coordinate systems — an identity run is copied byte for
 * byte, and each of the six leetspeak folds replaces one ASCII byte with
 * another — so an offset inside one maps one to one, and the result is a real
 * range in the caller's evidence rather than the whole segment. That precision
 * matters now that runs are coalesced: without it, a finding in a document with
 * no zero-width characters would cite the entire document, because the entire
 * document is one segment.
 *
 * `derived` when it touches decoded material: the result is the **parent** span
 * — the encoded run — and the caller is told the mapping is derived. Fabricating
 * a per-character offset into text that only exists after decoding would give a
 * citation that resolves to the wrong bytes, which is worse than one that
 * declares itself underived.
 *
 * A span that touches **both** raw and derived material is `unavailable`. There
 * is no single range that honestly describes it: the earlier implementation
 * returned the first segment's start paired with the last segment's end, which
 * for a span crossing from a document into its own decoded payload produced an
 * interval belonging to neither region. Two provenances need two findings, or
 * none.
 */
export function projectToRaw(norm: NormalizedText, span: ByteSpan): RawProjection {
  const unavailable: RawProjection = {
    raw: null, fidelity: "unavailable", transformation: null, decoder: null,
  };
  if (span.endByte <= span.startByte) return unavailable;

  let lo: number | null = null;
  let hi: number | null = null;
  let sawDerived = false;
  let sawExact = false;
  let transformation: TransformationKind | null = null;
  let decoder: string | null = null;

  for (const seg of norm.segments) {
    if (seg.normalized.endByte <= span.startByte) continue;
    if (seg.normalized.startByte >= span.endByte) break;
    if (seg.fidelity === "deletion") continue;

    let segLo = seg.raw.startByte;
    let segHi = seg.raw.endByte;
    if (seg.fidelity === "exact") {
      sawExact = true;
      transformation ??= seg.transformation;
      const overlapStart = Math.max(seg.normalized.startByte, span.startByte);
      const overlapEnd = Math.min(seg.normalized.endByte, span.endByte);
      segLo = seg.raw.startByte + (overlapStart - seg.normalized.startByte);
      segHi = seg.raw.startByte + (overlapEnd - seg.normalized.startByte);
    } else {
      sawDerived = true;
      decoder = seg.decoder;
    }
    lo = lo === null ? segLo : Math.min(lo, segLo);
    hi = hi === null ? segHi : Math.max(hi, segHi);
  }

  if (lo === null || hi === null) return unavailable;
  if (sawDerived && sawExact) return unavailable;
  if (sawDerived) {
    return { raw: { startByte: lo, endByte: hi }, fidelity: "derived", transformation: "base64-decode", decoder };
  }
  return { raw: { startByte: lo, endByte: hi }, fidelity: "exact", transformation, decoder: null };
}
