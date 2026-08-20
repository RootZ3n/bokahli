/**
 * Turn probes into provenance verdicts.
 *
 * The modules beside this one gather facts. This one decides what those facts
 * are *sufficient to claim*, which is the whole substance of the phase: Luak
 * refused to export the pilot not because Bokahli's token counts were wrong —
 * they almost certainly were not — but because nothing established where they
 * came from. "Almost certainly" is not provenance, and the only way to stop it
 * becoming provenance is to make the claim conditional on proof that a test can
 * take away.
 *
 * Every verdict here is deny-by-default. The strong value is returned when
 * specific conditions hold, and every other path falls through to the weak one
 * carrying a reason. There is no branch that reaches `runtime_tokenizer`
 * without having checked all three of its preconditions.
 */
import type {
  ArtifactDigest,
  DevicePlacement,
  SamplerConfig,
  SamplerFacts,
  SeedSupport,
  TemplateFacts,
  TemplateIdentity,
  TokenCountFacts,
  TokenCountSource,
  TokenizerIdentity,
} from '@bokahli/contracts';
import type { BackendSlotParams } from './backend.js';
import type { GgufTokenizerMetadata } from './gguf.js';

export interface TokenizerInputs {
  /** Parsed from the artifact whose digest Bokahli verified. Null when unread. */
  readonly artifactTokenizer: GgufTokenizerMetadata | null;
  /** Vocabulary size the running backend reports for the loaded model. */
  readonly runtimeVocabSize: number | null;
  readonly runtimeBuild: string | null;
  /** Whether the backend was attested to be serving this exact artifact. */
  readonly artifactAttested: boolean;
  readonly now: () => Date;
}

/**
 * Decide what may be claimed about the tokenizer.
 *
 * Three conditions, each covering a distinct way the claim could be false:
 *
 *   - `artifactAttested` — without it we may be describing the tokenizer of a
 *     file that is not the one loaded. This is the substitution case.
 *   - `metadataDigest` — without it we have a family name, and a family name is
 *     not an identity: two Qwen quantisations can share one and still split
 *     text differently through a different pre-tokenizer.
 *   - `vocabSizeMatch` — the binding. It is the one cheap number the runtime
 *     reports that the artifact also determines, so disagreement means the
 *     loaded vocabulary is not the one we hashed.
 */
export function resolveTokenizerIdentity(inputs: TokenizerInputs): TokenizerIdentity {
  const observedAt = inputs.now().toISOString();
  const t = inputs.artifactTokenizer;
  const fileVocab = t?.vocabSize ?? null;
  const vocabMatch =
    fileVocab !== null && inputs.runtimeVocabSize !== null
      ? fileVocab === inputs.runtimeVocabSize
      : null;

  const reasons: string[] = [];
  if (!inputs.artifactAttested) {
    reasons.push('backend was not attested to be serving this artifact');
  }
  if (t === null) {
    reasons.push('artifact tokenizer metadata was not read');
  } else if (t.metadataDigest === null) {
    reasons.push('artifact carries no tokenizer metadata to hash');
  }
  if (inputs.runtimeVocabSize === null) {
    reasons.push('backend did not report a vocabulary size to bind against');
  } else if (vocabMatch === false) {
    reasons.push(
      `vocabulary size mismatch: artifact has ${String(fileVocab)}, ` +
        `backend reports ${String(inputs.runtimeVocabSize)}`,
    );
  }

  return {
    provenance: 'observed',
    observedAt,
    family: t?.family ?? null,
    pretokenizer: t?.pretokenizer ?? null,
    vocabSize: fileVocab,
    runtimeVocabSize: inputs.runtimeVocabSize,
    vocabSizeMatch: vocabMatch,
    metadataDigest: (t?.metadataDigest ?? null) as ArtifactDigest | null,
    // llama.cpp produces the counts in its `usage` block. Nothing else in this
    // path tokenizes, so when we have counts at all they came from the runtime.
    tokenizedBy: 'runtime',
    runtimeBuild: inputs.runtimeBuild,
    unprovenReasons: reasons,
  };
}

/** True only when every precondition for a runtime-tokenizer claim holds. */
export function tokenizerFullyProven(t: TokenizerIdentity): boolean {
  return (
    t.unprovenReasons.length === 0 &&
    t.metadataDigest !== null &&
    t.vocabSizeMatch === true &&
    t.tokenizedBy === 'runtime'
  );
}

export interface TokenCountInputs {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** Whether the counts came from the backend's own `usage` block. */
  readonly fromRuntimeUsage: boolean;
  readonly tokenizer: TokenizerIdentity | null;
}

/**
 * Attach provenance to token counts.
 *
 * A count with no tokenizer identity is `runtime_reported_unknown_tokenizer`,
 * never `estimated`: the runtime really did count, and calling that an estimate
 * would understate it as badly as calling it a measurement overstates it. An
 * absent count is `unknown`. Nothing in this path ever produces `estimated`,
 * because Bokahli never counts characters — if that ever changes, the value
 * exists for it and the change will be visible here.
 */
export function resolveTokenCounts(inputs: TokenCountInputs): TokenCountFacts {
  const proven = inputs.tokenizer !== null && tokenizerFullyProven(inputs.tokenizer);
  const sourceFor = (v: number | null): TokenCountSource => {
    if (v === null) return 'unknown';
    if (!inputs.fromRuntimeUsage) return 'unknown';
    return proven ? 'runtime_tokenizer' : 'runtime_reported_unknown_tokenizer';
  };

  const promptTokenSource = sourceFor(inputs.promptTokens);
  const completionTokenSource = sourceFor(inputs.completionTokens);

  // The overall verdict is the weaker of the two. A prompt count that could not
  // be established must not be hidden behind a completion count that could.
  const rank: Record<TokenCountSource, number> = {
    runtime_tokenizer: 3,
    runtime_reported_unknown_tokenizer: 2,
    estimated: 1,
    unknown: 0,
  };
  const source =
    rank[promptTokenSource] <= rank[completionTokenSource] ? promptTokenSource : completionTokenSource;

  return {
    source,
    promptTokens: inputs.promptTokens,
    completionTokens: inputs.completionTokens,
    promptTokenSource,
    completionTokenSource,
    tokenizer: inputs.tokenizer,
  };
}

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

export interface TemplateInputs {
  /** Template text the runtime reports holding for this model. */
  readonly runtimeTemplate: string | null;
  /** Digest of the template carried in the verified artifact. */
  readonly artifactTemplateDigest: string | null;
  /** Runtime's name for the format it selected, from a live slot. */
  readonly effectiveChatFormat: string | null;
  readonly effectiveReasoningFormat: string | null;
  /** Format Bokahli asked for, when it asked. Null means it took the default. */
  readonly requestedChatFormat: string | null;
  readonly digestOf: (text: string) => string;
  readonly now: () => Date;
}

/**
 * Report requested and effective template separately.
 *
 * They are not the same on this deployment. The unit starts llama-server with
 * `--reasoning off`, `/props` reports `reasoning_format: "none"`, and a live
 * slot reports `"deepseek"` with a generation prompt that injects an empty
 * thinking block. A single field would have had to choose one of those to
 * report, and would have reported the wrong one.
 *
 * `matchesArtifactTemplate` is the substantive check: the runtime's template
 * text hashed against the template inside the artifact Bokahli verified. Equal
 * means the model's own template was applied rather than one the runtime
 * substituted. A name would not have caught a substitution; the bytes do.
 */
export function resolveTemplateFacts(inputs: TemplateInputs): TemplateFacts {
  const observedAt = inputs.now().toISOString();
  const runtimeDigest = inputs.runtimeTemplate === null ? null : inputs.digestOf(inputs.runtimeTemplate);
  const matches =
    runtimeDigest !== null && inputs.artifactTemplateDigest !== null
      ? runtimeDigest === inputs.artifactTemplateDigest
      : null;

  const effective: TemplateIdentity = {
    provenance: 'runtime-reported',
    observedAt,
    // llama.cpp applies the template server-side for /v1/chat/completions;
    // Bokahli sends messages, never a rendered prompt.
    appliedBy: inputs.runtimeTemplate === null ? 'unknown' : 'runtime',
    templateId: inputs.effectiveChatFormat,
    templateDigest: runtimeDigest as ArtifactDigest | null,
    runtimeTemplateName: inputs.effectiveChatFormat,
    reasoningFormat: inputs.effectiveReasoningFormat,
    matchesArtifactTemplate: matches,
    applied: inputs.runtimeTemplate === null ? null : true,
  };

  const requested: TemplateIdentity | null =
    inputs.requestedChatFormat === null
      ? null
      : {
          provenance: 'requested',
          observedAt,
          appliedBy: 'bokahli',
          templateId: inputs.requestedChatFormat,
          templateDigest: null,
          runtimeTemplateName: null,
          reasoningFormat: null,
          matchesArtifactTemplate: null,
          applied: null,
        };

  const mismatch =
    requested === null || requested.templateId === null || effective.templateId === null
      ? null
      : requested.templateId !== effective.templateId;

  return { requested, effective, mismatch };
}

// ---------------------------------------------------------------------------
// sampler
// ---------------------------------------------------------------------------

export interface SamplerInputs {
  readonly requested: SamplerConfig;
  readonly sent: SamplerConfig;
  readonly slot: BackendSlotParams | null;
  /** llama.cpp's sentinel for "no seed given". Anything else is a real seed. */
  readonly unsetSeedSentinel: number;
}

/**
 * llama.cpp reports an unset seed as `LLAMA_DEFAULT_SEED`, 0xFFFFFFFF.
 *
 * Treating that as a seed value would be a quiet lie: it would let a request
 * that supplied no seed come back reporting a seed, which is the exact shape of
 * error this file exists to prevent.
 */
export const LLAMA_UNSET_SEED = 0xffffffff;

/**
 * Reconcile the three sampler records.
 *
 * The only interesting judgement is `seedSupport`, and its rule is that sending
 * is not honouring. `requested` means Bokahli put a seed on the wire and
 * nothing confirmed it landed; `honoured` requires the runtime to echo the same
 * value back. If the runtime echoes a different one, that is `overridden` — a
 * state worth having, because a silently substituted seed makes repeatability
 * measurements meaningless while looking fine.
 */
export function resolveSamplerFacts(inputs: SamplerInputs): SamplerFacts {
  const slot = inputs.slot;
  const effective: SamplerConfig | null =
    slot === null
      ? null
      : {
          ...(slot.temperature !== null ? { temperature: slot.temperature } : {}),
          ...(slot.topP !== null ? { topP: slot.topP } : {}),
          ...(slot.topK !== null ? { topK: slot.topK } : {}),
          ...(slot.maxTokens !== null ? { maxTokens: slot.maxTokens } : {}),
          ...(slot.seed !== null && slot.seed !== inputs.unsetSeedSentinel
            ? { seed: slot.seed }
            : {}),
        };

  // The sentinel is checked before the comparison, and that ordering is the
  // whole correctness of this function. llama.cpp reports 0xFFFFFFFF when no
  // seed was given; comparing it against a seed we sent yields "not equal" and
  // would report `overridden` — telling an operator the runtime substituted a
  // different seed when in fact it echoed none at all. That is a false
  // accusation, and it would send someone looking for a bug that is not there.
  const reportedSeed =
    slot === null || slot.seed === null || slot.seed === inputs.unsetSeedSentinel ? null : slot.seed;

  let seedSupport: SeedSupport;
  if (inputs.sent.seed === undefined) {
    seedSupport = 'not_requested';
  } else if (reportedSeed === null) {
    seedSupport = 'requested';
  } else if (reportedSeed === inputs.sent.seed) {
    seedSupport = 'honoured';
  } else {
    seedSupport = 'overridden';
  }

  return {
    requested: inputs.requested,
    sent: inputs.sent,
    effective,
    effectiveSource: slot === null ? 'unavailable' : 'runtime-slots',
    seedSupport,
    deterministicOutputGuaranteed: false,
  };
}

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------

/**
 * Whether placement is established well enough to support qualification.
 *
 * Only an affirmative driver observation counts. `null` — the driver could not
 * be read — is not a pass, because "we could not check" and "we checked and it
 * is on the GPU" are the two things this whole file exists to keep apart.
 */
export function placementProven(p: DevicePlacement): boolean {
  return p.method === 'nvidia-smi-compute-apps' && p.backendHoldsDevice === true;
}
