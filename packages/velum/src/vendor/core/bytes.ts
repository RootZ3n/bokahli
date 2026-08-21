/**
 * VENDORED FROM VELUM — DO NOT EDIT.
 *
 *   source: src/core/bytes.ts
 *   commit: 5f6738b1e9a6b6ae4e4d54c269f460323bb72254
 *   sync:   node scripts/sync-velum.mjs --sync
 *   verify: node scripts/sync-velum.mjs --check
 *
 * Edits here are erased by the next sync and fail `--check` before then. The
 * boundary that uses this engine is packages/server/src/trust.ts; the contract
 * it reports against is packages/contracts/src/velum.ts.
 */
/**
 * Velum — UTF-8 byte coordinates.
 * ============================================================
 * Every public source offset in Velum is a **UTF-8 byte offset**:
 * `startByte` inclusive, `endByte` exclusive. Line and column are derived for
 * display and are never authoritative.
 *
 * ## Why not JavaScript string indices
 *
 * A JavaScript string index is a UTF-16 code-unit index. `"🚀".length` is 2, and
 * a span of `[0, 1)` names half a surrogate pair — a position that does not
 * exist in the source bytes. Every consumer of a finding has to resolve it back
 * into the original evidence: a file, a log, an HTTP body. Those are byte
 * sequences. Handing them a UTF-16 index means every consumer re-derives the
 * conversion, and they will not all do it the same way.
 *
 * So the matcher runs over a decoded table that carries both: the code point
 * (so matching semantics are Unicode-correct, `.` is one character rather than
 * one byte) and the byte range that code point occupies (so every reported span
 * is a byte span). Decoding happens once per input, in linear time.
 *
 * Ported from the operator-owned ABAIYA implementation
 * (`abaiya-policy`, repository `RootZ3n/abaiya` at `a471252`) under the reuse
 * and MIT-publication authorization recorded in that project. The Rust original
 * works over `&str`, where byte offsets are the native coordinate; this module
 * exists because in TypeScript they are not.
 */

/**
 * One decoded code point and the bytes it occupies.
 *
 * A materialised view, produced on demand by `cellAt`. The table itself does
 * not hold these: see `DecodedText`.
 */
export interface CodePointCell {
  /** The code point value. */
  readonly cp: number;
  /** Inclusive UTF-8 byte offset of this code point. */
  readonly startByte: number;
  /** Exclusive UTF-8 byte offset. */
  readonly endByte: number;
}

/** A byte range in some representation. `end` is exclusive. */
export interface ByteSpan {
  readonly startByte: number;
  readonly endByte: number;
}

/**
 * A decoded code-point table, in two typed arrays.
 *
 * It was an array of objects — one `{cp, startByte, endByte}` per code point —
 * and that cost **62.5 bytes per cell**, measured: a megabyte of ASCII evidence
 * became 62.5 MiB of table, a `normalize()` call 141.8 MiB because it decodes
 * twice, and one 4 MiB scan drove peak RSS past 770 MiB before the step budget
 * refused it. Three numbers per code point do not need an object each.
 *
 * Two parallel typed arrays hold the same information in **8 bytes per cell**,
 * and `endByte` is not stored at all: cells tile the byte range exactly, so a
 * cell's end is the next cell's start, and the last cell's end is the length.
 * That invariant is not an assumption — `decodeUtf8` maintains it for valid and
 * invalid input alike, and a test asserts the tiling over hostile byte
 * sequences.
 */
export interface DecodedText {
  /** The exact bytes decoded. Authoritative. */
  readonly bytes: Uint8Array;
  /** Number of code points. */
  readonly length: number;
  /** Code point per cell. `INVALID_BYTE` for a byte that decodes to nothing. */
  readonly cp: Int32Array;
  /** Inclusive UTF-8 byte offset per cell. */
  readonly start: Uint32Array;
  /** True when the input contained no invalid UTF-8 sequence. */
  readonly wellFormed: boolean;
}

/** Exclusive byte offset of cell `i`. */
export function endOf(d: DecodedText, i: number): number {
  return i + 1 < d.length ? (d.start[i + 1] as number) : d.bytes.length;
}

/** Materialise one cell. For callers that want the record rather than the table. */
export function cellAt(d: DecodedText, i: number): CodePointCell {
  return { cp: d.cp[i] as number, startByte: d.start[i] as number, endByte: endOf(d, i) };
}

/** Encode a JavaScript string to UTF-8 bytes. */
export function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Decode UTF-8 bytes into a code-point table.
 *
 * Invalid sequences are **not** silently repaired into U+FFFD and then matched
 * as if they were text: a replacement character occupies one code point and an
 * unknown number of source bytes, so any span crossing it would be a guess. An
 * invalid byte is emitted as a single one-byte cell carrying the sentinel
 * `INVALID_BYTE`, which no pattern can match, and `wellFormed` records that the
 * input was not clean. Callers that require well-formed input check the flag;
 * callers that do not still get exact offsets for the parts that are valid.
 */
export const INVALID_BYTE = -1;

export function decodeUtf8(bytes: Uint8Array): DecodedText {
  const n = bytes.length;
  // At most one cell per byte, which is exactly the count for ASCII and for
  // wholly invalid input. Sized once and trimmed at the end rather than grown.
  const cp = new Int32Array(n);
  const start = new Uint32Array(n);
  let count = 0;
  let wellFormed = true;
  let i = 0;

  const push = (value: number, at: number): void => {
    cp[count] = value;
    start[count] = at;
    count += 1;
  };

  while (i < n) {
    const b0 = bytes[i] as number;
    let size = 0;
    let value = 0;

    if (b0 < 0x80) {
      size = 1;
      value = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      size = 2;
      value = b0 & 0x1f;
    } else if ((b0 & 0xf0) === 0xe0) {
      size = 3;
      value = b0 & 0x0f;
    } else if ((b0 & 0xf8) === 0xf0) {
      size = 4;
      value = b0 & 0x07;
    } else {
      push(INVALID_BYTE, i);
      wellFormed = false;
      i += 1;
      continue;
    }

    if (i + size > n) {
      push(INVALID_BYTE, i);
      wellFormed = false;
      i += 1;
      continue;
    }

    let ok = true;
    for (let k = 1; k < size; k++) {
      const bk = bytes[i + k] as number;
      if ((bk & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      value = (value << 6) | (bk & 0x3f);
    }
    // Overlong encodings, surrogates and out-of-range values are rejected: they
    // are distinct byte sequences that would otherwise decode to a code point
    // some other decoder produces differently, which is an obfuscation channel.
    const overlong =
      (size === 2 && value < 0x80) ||
      (size === 3 && value < 0x800) ||
      (size === 4 && value < 0x10000);
    if (!ok || overlong || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      push(INVALID_BYTE, i);
      wellFormed = false;
      i += 1;
      continue;
    }

    push(value, i);
    i += size;
  }

  return {
    bytes,
    length: count,
    cp: cp.subarray(0, count),
    start: start.subarray(0, count),
    wellFormed,
  };
}

export function decodeText(text: string): DecodedText {
  return decodeUtf8(toUtf8(text));
}

/**
 * Slice the original bytes for a span, as a string.
 *
 * **Lossy across invalid UTF-8**, and says so rather than claiming otherwise.
 * `TextDecoder` substitutes U+FFFD for every ill-formed sequence, so three raw
 * bytes can come back as five: the returned string is a *rendering* of the
 * span, not the span. Anything that has to be exact — a citation, a hash, a
 * comparison against the caller's evidence — uses `sliceBytesExact`, which
 * refuses instead of substituting, or works on the bytes directly.
 */
export function sliceBytes(bytes: Uint8Array, span: ByteSpan): string {
  return new TextDecoder().decode(bytes.subarray(span.startByte, span.endByte));
}

/**
 * Slice the original bytes for a span, or return null when they are not text.
 *
 * Null means the span is out of range, splits a multi-byte character, or covers
 * a byte sequence that is not well-formed UTF-8. A caller that needs to quote
 * evidence needs to know that, and a replacement character is the one answer
 * that looks like success.
 */
export function sliceBytesExact(bytes: Uint8Array, span: ByteSpan): string | null {
  if (span.startByte < 0 || span.endByte > bytes.length || span.endByte < span.startByte) return null;
  const slice = bytes.subarray(span.startByte, span.endByte);
  const decoded = decodeUtf8(slice);
  if (!decoded.wellFormed) return null;
  const text = new TextDecoder().decode(slice);
  // Round-trip: equal lengths prove no substitution happened.
  return toUtf8(text).length === slice.length ? text : null;
}

/** One-based line and column, derived for display only. */
export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/**
 * Derive a line/column for a byte offset.
 *
 * Columns count **code points**, not bytes and not UTF-16 units, because a
 * column is a thing a human counts by looking. CRLF is one line break: the
 * `\r` belongs to the line it terminates, so a span pointing at `\n` in a CRLF
 * pair reports the line it ends rather than the one it starts.
 */
export function lineColumnOf(decoded: DecodedText, byteOffset: number): LineColumn {
  let line = 1;
  let column = 1;
  // Indexed, not `for…of`. The lone-CR rule needs the following cell, and an
  // earlier revision found it with `cells.indexOf(cell)` — a linear scan from
  // the front, inside a loop that is already linear. That made a display helper
  // quadratic in the number of carriage returns: 16 KiB of CR cost 25 ms, and a
  // 4 MiB evidence file the better part of half an hour. The index is right
  // here; there was never a reason to search for it.
  for (let i = 0; i < decoded.length; i++) {
    if ((decoded.start[i] as number) >= byteOffset) break;
    const c = decoded.cp[i] as number;
    if (c === 0x0a) {
      line += 1;
      column = 1;
    } else if (c === 0x0d) {
      // A lone CR is a line break too; a CR followed by LF is handled by the
      // LF branch, so the CR must not advance the counter twice.
      if (decoded.cp[i + 1] !== 0x0a) {
        line += 1;
        column = 1;
      }
    } else {
      column += 1;
    }
  }
  return { line, column };
}
