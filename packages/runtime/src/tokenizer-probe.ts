/**
 * Ask the running server what tokenizer it actually loaded.
 *
 * Every other tokenizer fact Bokahli has describes a *file*. That was the hole
 * the audit of 4d8ced6 opened: llama.cpp's `--override-kv` replaces GGUF
 * metadata at load time without touching the artifact, so the digest matches,
 * the path matches, attestation passes, the vocabulary size is unchanged — and
 * the tokenizer splitting text is not the one Bokahli described. Vocabulary-size
 * equality is *consistent* with the runtime having loaded our file. It is not
 * evidence of it, and the previous version treated it as the binding.
 *
 * The fix is behavioural. `/detokenize` returns the text for a list of ids,
 * which reads the vocabulary table the process actually holds. Comparing that
 * against the artifact's own token table, at sampled indices, catches a
 * substituted vocabulary in a way no metadata comparison can.
 *
 * Two deliberate limits, stated rather than papered over:
 *
 *   - This binds the *vocabulary*, not the pre-tokenizer. Confirming the
 *     pre-tokenizer would need a byte-level BPE implementation here, and a
 *     second tokenizer implementation is a second thing that can be wrong.
 *     `segmentationDigest` records how this deployment actually segments a fixed
 *     probe, which does not prove the rule but does make any change in the rule
 *     visible between runs — which is the property evidence comparability
 *     actually needs.
 *   - It is about one process. The proof carries the backend instance id, and a
 *     probe from a previous instance proves nothing about the current one.
 *
 * Neither endpoint runs the model: no decode, no slot, no GPU work.
 */
import { createHash } from 'node:crypto';
import type { RuntimeTokenizerProof } from '@bokahli/contracts';

/**
 * A fixed probe whose segmentation exercises the parts of a pre-tokenizer that
 * differ between variants: repeated leading whitespace, a special-token
 * literal, non-Latin script, and digit grouping.
 */
export const PROBE_TEXT = 'Bokahli probe:  \t 日本語 0123456789 <|im_end|> end';

/** Bumped whenever the probe text or the sampling rule changes. */
export const PROBE_ID = 'bokahli.tokenizer-probe.v1';

/** How many vocabulary entries to check. */
const SAMPLE_COUNT = 24;

export interface TokenizerProbeSources {
  /** POST /tokenize. Returns token ids. */
  readonly tokenize: (text: string) => Promise<readonly number[]>;
  /** POST /detokenize. Returns the concatenated text for those ids. */
  readonly detokenize: (ids: readonly number[]) => Promise<string>;
  readonly now: () => Date;
}

/**
 * Which vocabulary indices to sample.
 *
 * Deterministic from the vocabulary size so two runs against the same artifact
 * check the same entries and their results are comparable. Spread across the
 * range and anchored at both ends, because a substituted vocabulary is most
 * likely to differ in the added-token region near the top rather than in the
 * ASCII entries near the bottom — sampling only the start would miss exactly
 * the case worth catching.
 */
export function sampleIds(vocabSize: number, count = SAMPLE_COUNT): readonly number[] {
  if (vocabSize <= 0) return [];
  const ids = new Set<number>();
  ids.add(0);
  ids.add(vocabSize - 1);
  const step = Math.max(1, Math.floor(vocabSize / Math.max(1, count - 2)));
  for (let i = step; i < vocabSize - 1 && ids.size < count; i += step) ids.add(i);
  return [...ids].sort((a, b) => a - b);
}

export interface ProbeInputs {
  /** The artifact's own token table, from GGUF. */
  readonly artifactTokens: readonly string[] | null;
  readonly backendInstanceId: string | null;
}

/**
 * Run the probe. Never throws: a probe that could not run leaves the claim
 * unproven, which is the correct outcome and not an error the caller must
 * handle.
 */
export async function probeRuntimeTokenizer(
  inputs: ProbeInputs,
  sources: TokenizerProbeSources,
): Promise<RuntimeTokenizerProof> {
  const observedAt = sources.now().toISOString();
  const base = {
    method: 'runtime-vocab-probe' as const,
    backendInstanceId: inputs.backendInstanceId,
    observedAt,
  };

  if (inputs.artifactTokens === null || inputs.artifactTokens.length === 0) {
    return {
      ...base, matches: false, samplesChecked: 0, samplesMatched: 0,
      segmentationDigest: null,
      detail: 'artifact token table unavailable, so there is nothing to compare against',
    };
  }

  const ids = sampleIds(inputs.artifactTokens.length);
  let matched = 0;
  let firstMismatch: number | null = null;

  // One id at a time. Detokenizing the batch would concatenate the pieces and
  // an offsetting pair of differences could cancel out; per-id comparison
  // cannot be fooled that way.
  for (const id of ids) {
    let got: string;
    try {
      got = await sources.detokenize([id]);
    } catch (err) {
      return {
        ...base, matches: false, samplesChecked: ids.length, samplesMatched: matched,
        segmentationDigest: null,
        detail: `runtime detokenize failed (${(err as Error).name})`,
      };
    }
    // GGUF stores byte-level BPE tokens in their encoded form; the runtime
    // returns decoded text. Compare on the decoded form of our own entry so the
    // two are in the same representation, and treat an unrepresentable byte
    // sequence as a match only when both sides agree it is unrepresentable.
    const want = decodeByteLevel(inputs.artifactTokens[id] as string);
    if (got === want) matched += 1;
    else if (firstMismatch === null) firstMismatch = id;
  }

  let segmentationDigest: string | null = null;
  try {
    const tokens = await sources.tokenize(PROBE_TEXT);
    segmentationDigest = `sha256:${createHash('sha256')
      .update(`${PROBE_ID}\n${tokens.join(',')}`)
      .digest('hex')}`;
  } catch {
    // The vocabulary comparison is the binding; segmentation is comparability
    // metadata. Losing it weakens the record without invalidating the proof.
  }

  const matches = matched === ids.length;
  return {
    ...base,
    matches,
    samplesChecked: ids.length,
    samplesMatched: matched,
    segmentationDigest,
    detail: matches
      ? null
      : `runtime vocabulary differs from the artifact at id ${String(firstMismatch)} ` +
        `(${matched}/${ids.length} sampled entries matched)`,
  };
}

/**
 * GPT-2 byte-level BPE reverses a fixed printable mapping.
 *
 * `Ġ` is a space, `Ċ` a newline, and the rest of the C0/C1 range is displaced
 * into a printable block. The runtime returns decoded text, the artifact stores
 * the encoded form, and comparing them without this would report every token
 * containing whitespace as a mismatch — which would make the probe fail on a
 * correct deployment and get switched off.
 */
export function decodeByteLevel(token: string): string {
  const bytes: number[] = [];
  for (const ch of token) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0100 && c <= 0x0120) bytes.push(c - 0x0100);          // C0 block
    else if (c >= 0x0121 && c <= 0x0142) bytes.push(c - 0x0121 + 0x7f); // DEL + C1
    else if (c === 0x0143) bytes.push(0xad);
    else {
      const buf = Buffer.from(ch, 'utf8');
      for (const b of buf) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
