/**
 * Minimal GGUF metadata reader — enough to identify a tokenizer, no more.
 *
 * This exists because the serving runtime will not tell us which tokenizer it
 * loaded. `/props` gives a build string and a model path; `/v1/models` gives a
 * vocabulary size and a numeric vocab type. None of that identifies a
 * tokenizer: two Qwen quantisations can share a family name and a vocab size
 * and still split text differently, because the pre-tokenizer differs.
 *
 * The artifact itself does know. GGUF carries `tokenizer.ggml.model`,
 * `tokenizer.ggml.pre`, the full token list, the merge table and the special
 * token ids, and Bokahli has already verified that file's digest. Hashing those
 * fields gives a content-derived identity that is bound to bytes we checked
 * rather than to a name someone chose.
 *
 * Only the header is read — tensor data is never touched. The metadata block on
 * the served artifact is about 11 MB, dominated by 248,320 token strings and
 * 247,587 merges. Reading it takes tens of milliseconds from page cache and
 * happens once per artifact, not once per request.
 *
 * Deliberately not a general GGUF library. It reads the key-value block and
 * stops. Numeric arrays are kept as raw bytes rather than decoded because the
 * only thing done with them is hashing, and decoding 248,320 int32s to
 * re-encode them would be slower and no more correct.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export class GgufReadError extends Error {}

const MAGIC = 'GGUF';

/** GGUF value type tags, from the format specification. */
const enum Ty {
  U8 = 0, I8 = 1, U16 = 2, I16 = 3, U32 = 4, I32 = 5, F32 = 6,
  BOOL = 7, STR = 8, ARR = 9, U64 = 10, I64 = 11, F64 = 12,
}

const WIDTH: Readonly<Record<number, number>> = {
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
};

/** A numeric array left undecoded: only its bytes are ever needed. */
interface RawArray {
  readonly kind: 'raw-array';
  readonly elementType: number;
  readonly count: number;
  readonly bytes: Buffer;
}

type GgufValue = string | number | boolean | readonly string[] | RawArray;

/**
 * How much of the file to read looking for the key-value block.
 *
 * 64 MiB is roughly six times the largest metadata block observed on this host
 * and still a rounding error against a 12.6 GiB artifact. A bound is required
 * rather than optional: without one, a corrupt length prefix turns a metadata
 * read into an attempt to allocate the whole file.
 */
const HEADER_WINDOW_BYTES = 64 * 1024 * 1024;

/** Refuse absurd lengths before allocating anything, not after. */
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const MAX_ARRAY_ELEMENTS = 8 * 1024 * 1024;

class Cursor {
  #b: Buffer;
  #o = 0;

  constructor(b: Buffer) {
    this.#b = b;
  }

  get offset(): number {
    return this.#o;
  }

  #need(n: number): void {
    if (n < 0 || this.#o + n > this.#b.length) {
      throw new GgufReadError(
        `metadata extends past the ${HEADER_WINDOW_BYTES}-byte header window; ` +
          'the file is truncated, is not GGUF, or declares a length it does not have',
      );
    }
  }

  u32(): number {
    this.#need(4);
    const v = this.#b.readUInt32LE(this.#o);
    this.#o += 4;
    return v;
  }

  u64(): number {
    this.#need(8);
    const v = this.#b.readBigUInt64LE(this.#o);
    // Lengths and counts must survive as exact integers. A value past 2^53 is
    // either corruption or a file this reader has no business parsing.
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GgufReadError('length field exceeds the safe integer range');
    }
    this.#o += 8;
    return Number(v);
  }

  str(): string {
    const n = this.u64();
    if (n > MAX_STRING_BYTES) {
      throw new GgufReadError(`string field declares ${n} bytes, past the ${MAX_STRING_BYTES} cap`);
    }
    this.#need(n);
    const s = this.#b.subarray(this.#o, this.#o + n).toString('utf8');
    this.#o += n;
    return s;
  }

  value(t: number): GgufValue {
    switch (t) {
      case Ty.STR:
        return this.str();
      case Ty.BOOL: {
        this.#need(1);
        const v = this.#b.readUInt8(this.#o) !== 0;
        this.#o += 1;
        return v;
      }
      case Ty.ARR: {
        const et = this.u32();
        const n = this.u64();
        if (n > MAX_ARRAY_ELEMENTS) {
          throw new GgufReadError(`array declares ${n} elements, past the ${MAX_ARRAY_ELEMENTS} cap`);
        }
        if (et === Ty.STR) {
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(this.str());
          return out;
        }
        const w = WIDTH[et];
        if (w === undefined) throw new GgufReadError(`array of unknown element type ${et}`);
        this.#need(w * n);
        const bytes = this.#b.subarray(this.#o, this.#o + w * n);
        this.#o += w * n;
        return { kind: 'raw-array', elementType: et, count: n, bytes };
      }
      default: {
        const w = WIDTH[t];
        if (w === undefined) throw new GgufReadError(`unknown value type ${t}`);
        this.#need(w);
        let v: number;
        switch (t) {
          case Ty.U8: v = this.#b.readUInt8(this.#o); break;
          case Ty.I8: v = this.#b.readInt8(this.#o); break;
          case Ty.U16: v = this.#b.readUInt16LE(this.#o); break;
          case Ty.I16: v = this.#b.readInt16LE(this.#o); break;
          case Ty.U32: v = this.#b.readUInt32LE(this.#o); break;
          case Ty.I32: v = this.#b.readInt32LE(this.#o); break;
          case Ty.F32: v = this.#b.readFloatLE(this.#o); break;
          case Ty.U64: v = Number(this.#b.readBigUInt64LE(this.#o)); break;
          case Ty.I64: v = Number(this.#b.readBigInt64LE(this.#o)); break;
          case Ty.F64: v = this.#b.readDoubleLE(this.#o); break;
          default: throw new GgufReadError(`unhandled value type ${t}`);
        }
        this.#o += w;
        return v;
      }
    }
  }
}

/** The subset of GGUF metadata this module reports on. */
export interface GgufTokenizerMetadata {
  /** `tokenizer.ggml.model`, e.g. "gpt2" for byte-level BPE. */
  readonly family: string | null;
  /** `tokenizer.ggml.pre`, the pre-tokenizer variant. */
  readonly pretokenizer: string | null;
  readonly vocabSize: number | null;
  readonly eosTokenId: number | null;
  readonly bosTokenId: number | null;
  readonly paddingTokenId: number | null;
  readonly addBosToken: boolean | null;
  /**
   * sha256 over the fields that determine how text is split.
   *
   * Formatted `sha256:<hex>`. Null when the artifact carries no tokenizer
   * metadata at all, which is a fact worth reporting rather than a hash worth
   * inventing.
   */
  readonly metadataDigest: string | null;
  /** The model's own chat template, verbatim. */
  readonly chatTemplate: string | null;
  /** sha256 of that template text. */
  readonly chatTemplateDigest: string | null;
  /** Bytes of metadata read. Diagnostic. */
  readonly metadataBytes: number;
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Read tokenizer identity out of a GGUF artifact.
 *
 * Throws `GgufReadError` on anything malformed. Callers treat that as "identity
 * unavailable" and fall back to `runtime_reported_unknown_tokenizer`; they must
 * not treat it as a reason to guess.
 */
export async function readGgufTokenizerMetadata(path: string): Promise<GgufTokenizerMetadata> {
  const fh = await open(path, 'r');
  let window: Buffer;
  try {
    const buf = Buffer.allocUnsafe(HEADER_WINDOW_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_WINDOW_BYTES, 0);
    window = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }

  if (window.length < 24 || window.subarray(0, 4).toString('ascii') !== MAGIC) {
    throw new GgufReadError('not a GGUF file: magic mismatch');
  }

  const c = new Cursor(window);
  // magic
  void c.u32();
  const version = c.u32();
  if (version < 2 || version > 3) {
    throw new GgufReadError(`unsupported GGUF version ${version}`);
  }
  void c.u64(); // tensor count — tensor data is never read
  const kvCount = c.u64();

  const kv = new Map<string, GgufValue>();
  for (let i = 0; i < kvCount; i++) {
    const key = c.str();
    const type = c.u32();
    kv.set(key, c.value(type));
  }

  const str = (k: string): string | null => {
    const v = kv.get(k);
    return typeof v === 'string' ? v : null;
  };
  const num = (k: string): number | null => {
    const v = kv.get(k);
    return typeof v === 'number' ? v : null;
  };
  const bool = (k: string): boolean | null => {
    const v = kv.get(k);
    return typeof v === 'boolean' ? v : null;
  };
  const strArr = (k: string): readonly string[] | null => {
    const v = kv.get(k);
    return Array.isArray(v) ? (v as readonly string[]) : null;
  };
  const rawArr = (k: string): RawArray | null => {
    const v = kv.get(k);
    return v !== null && typeof v === 'object' && 'kind' in v ? (v as RawArray) : null;
  };

  const family = str('tokenizer.ggml.model');
  const pre = str('tokenizer.ggml.pre');
  const tokens = strArr('tokenizer.ggml.tokens');
  const merges = strArr('tokenizer.ggml.merges');
  const types = rawArr('tokenizer.ggml.token_type');

  // The digest covers everything that changes how text becomes tokens, in a
  // fixed order, with each component named. Naming matters: without the labels,
  // a vocabulary and a merge list that happened to hash alike could be
  // transposed without changing the result.
  let metadataDigest: string | null = null;
  if (family !== null || tokens !== null) {
    const parts = [
      `family=${family ?? ''}`,
      `pretokenizer=${pre ?? ''}`,
      `vocabSize=${tokens?.length ?? 0}`,
      `tokens=${tokens ? sha256(tokens.join(' ')) : ''}`,
      `merges=${merges ? sha256(merges.join(' ')) : ''}`,
      `tokenTypes=${types ? sha256(types.bytes) : ''}`,
      `bos=${num('tokenizer.ggml.bos_token_id') ?? ''}`,
      `eos=${num('tokenizer.ggml.eos_token_id') ?? ''}`,
      `pad=${num('tokenizer.ggml.padding_token_id') ?? ''}`,
      `addBos=${String(bool('tokenizer.ggml.add_bos_token') ?? '')}`,
    ];
    metadataDigest = `sha256:${sha256(parts.join('\n'))}`;
  }

  const chatTemplate = str('tokenizer.chat_template');

  return {
    family,
    pretokenizer: pre,
    vocabSize: tokens?.length ?? null,
    eosTokenId: num('tokenizer.ggml.eos_token_id'),
    bosTokenId: num('tokenizer.ggml.bos_token_id'),
    paddingTokenId: num('tokenizer.ggml.padding_token_id'),
    addBosToken: bool('tokenizer.ggml.add_bos_token'),
    metadataDigest,
    chatTemplate,
    chatTemplateDigest: chatTemplate === null ? null : `sha256:${sha256(chatTemplate)}`,
    metadataBytes: c.offset,
  };
}

/** Hash arbitrary template text the same way, for comparing runtime against artifact. */
export function templateDigest(text: string): string {
  return `sha256:${sha256(text)}`;
}
