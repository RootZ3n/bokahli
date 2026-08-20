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
  RuntimeTokenizerProof,
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
  /** The instance the facts are being assembled for. */
  readonly backendInstanceId?: string | null;
  /** The behavioural binding. Absent means no probe was taken. */
  readonly runtimeTokenizerProof?: RuntimeTokenizerProof | null;
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
  const proof = inputs.runtimeTokenizerProof ?? null;
  const instanceId = inputs.backendInstanceId ?? null;

  const reasons: string[] = [];
  if (!inputs.artifactAttested) {
    reasons.push('backend was not attested to be serving this artifact');
  }
  if (t === null) {
    reasons.push('artifact tokenizer metadata was not read');
  } else {
    if (t.metadataDigest === null) reasons.push('artifact carries no tokenizer metadata to hash');
    if (t.family === null) reasons.push('artifact declares no tokenizer family');
    // Without a named pre-tokenizer the segmentation rule is unnamed, and two
    // artifacts with identical vocabularies and different pre-tokenizers are
    // exactly the collision the content digest exists to prevent.
    if (t.pretokenizer === null) reasons.push('artifact declares no pre-tokenizer');
  }

  // Supporting evidence. A mismatch refuses; agreement is not a proof, which is
  // why it no longer appears in the sufficiency test below.
  if (inputs.runtimeVocabSize === null) {
    reasons.push('backend did not report a vocabulary size to cross-check');
  } else if (vocabMatch === false) {
    reasons.push(
      `vocabulary size mismatch: artifact has ${String(fileVocab)}, ` +
        `backend reports ${String(inputs.runtimeVocabSize)}`,
    );
  }

  // The binding. Everything above describes a file; only this describes the
  // process that is serving.
  if (proof === null) {
    reasons.push(
      'no runtime vocabulary probe: the tokenizer the process loaded was never read, ' +
        'so a load-time metadata override would be invisible',
    );
  } else if (!proof.matches) {
    reasons.push(
      `runtime vocabulary probe disagrees with the artifact ` +
        `(${proof.samplesMatched}/${proof.samplesChecked} samples matched)` +
        (proof.detail === null ? '' : `: ${proof.detail}`),
    );
  } else if (proof.backendInstanceId === null || instanceId === null) {
    reasons.push('runtime vocabulary probe is not bound to a known backend instance');
  } else if (proof.backendInstanceId !== instanceId) {
    reasons.push(
      'runtime vocabulary probe was taken against a different backend instance; ' +
        'a probe describes one process and does not survive a restart',
    );
  }

  const bound = proof !== null && proof.matches && proof.backendInstanceId !== null &&
    instanceId !== null && proof.backendInstanceId === instanceId;

  return {
    provenance: 'observed',
    observedAt,
    family: t?.family ?? null,
    pretokenizer: t?.pretokenizer ?? null,
    vocabSize: fileVocab,
    runtimeVocabSize: inputs.runtimeVocabSize,
    vocabSizeMatch: vocabMatch,
    runtimeProof: proof,
    // Declared in the artifact and reported; never confirmed in the runtime.
    // Confirming it would require a second BPE implementation here, which is a
    // second thing that can be wrong.
    pretokenizerVerified: false,
    metadataDigest: (t?.metadataDigest ?? null) as ArtifactDigest | null,
    // Derived, not asserted. llama.cpp returning integer usage fields says a
    // count happened; it says nothing about which vocabulary produced it.
    tokenizedBy: bound ? 'runtime' : 'unknown',
    runtimeBuild: inputs.runtimeBuild,
    unprovenReasons: reasons,
  };
}

/**
 * True only when every precondition for a runtime-tokenizer claim holds.
 *
 * `vocabSizeMatch` is deliberately absent: it is checked above, where a
 * mismatch adds a refusal reason, but agreement is not listed here because
 * agreement is not evidence. Two tokenizers can have the same vocabulary size.
 */
export function tokenizerFullyProven(t: TokenizerIdentity): boolean {
  return (
    t.unprovenReasons.length === 0 &&
    t.metadataDigest !== null &&
    t.family !== null &&
    t.pretokenizer !== null &&
    t.tokenizedBy === 'runtime' &&
    t.runtimeProof !== null &&
    t.runtimeProof.matches
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
  /**
   * Whether the slot reading can be tied to a specific request. Null means it
   * cannot, which is the only value the current llama.cpp API can produce.
   */
  readonly slotCorrelation?: { readonly backendInstanceId: string; readonly requestInstanceId: string } | null;
  /** Reasoning format the backend was started with, when known. */
  readonly configuredReasoningFormat?: string | null;
  readonly digestOf: (text: string) => string;
  readonly now: () => Date;
}

/**
 * Cap a string a backend controls before it reaches a response.
 *
 * `/props` and `/slots` are trusted to be our own loopback backend, but a field
 * whose length is decided elsewhere is a field that can inflate every response,
 * and "our backend would never" is not a bound.
 */
const MAX_RUNTIME_LABEL = 128;
function boundedLabel(v: string | null): string | null {
  return v === null ? null : v.slice(0, MAX_RUNTIME_LABEL);
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

  const correlated =
    inputs.slotCorrelation != null &&
    inputs.slotCorrelation.backendInstanceId === inputs.slotCorrelation.requestInstanceId;

  // What the backend HOLDS. Not what any request used: a client that
  // pre-formats its own prompt bypasses templating and /props does not change,
  // so `applied` here is null, never true.
  const configured: TemplateIdentity = {
    provenance: 'runtime-reported',
    observedAt,
    appliedBy: inputs.runtimeTemplate === null ? 'unknown' : 'runtime',
    templateId: boundedLabel(inputs.effectiveChatFormat),
    templateDigest: runtimeDigest as ArtifactDigest | null,
    runtimeTemplateName: boundedLabel(inputs.effectiveChatFormat),
    reasoningFormat: boundedLabel(inputs.effectiveReasoningFormat),
    matchesArtifactTemplate: matches,
    applied: null,
  };

  // An uncorrelated slot reading. Backend-instance scope; discarded outright
  // when the instance it was taken against is not the one that served.
  const effective: TemplateIdentity | null =
    inputs.slotCorrelation != null && !correlated
      ? null
      : { ...configured, applied: null };

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
    requested === null || requested.templateId === null || effective?.templateId == null
      ? null
      : requested.templateId !== effective.templateId;

  const cfgReasoning = inputs.configuredReasoningFormat ?? null;
  const reasoningFormatOverridden =
    cfgReasoning === null || inputs.effectiveReasoningFormat === null
      ? null
      : cfgReasoning !== inputs.effectiveReasoningFormat;

  return {
    requested,
    configured,
    effective,
    // llama.cpp's chat response carries no slot or task id, so nothing can be
    // confirmed for a specific request. Null is the honest value, and it is a
    // separate field precisely so it cannot be filled by the configured one.
    requestConfirmed: null,
    mismatch,
    reasoningFormatOverridden,
  };
}

// ---------------------------------------------------------------------------
// sampler
// ---------------------------------------------------------------------------

export interface SamplerInputs {
  readonly requested: SamplerConfig;
  readonly sent: SamplerConfig;
  readonly slot: BackendSlotParams | null;
  /**
   * Whether the slot reading can be tied to this request.
   *
   * Null means it cannot. llama.cpp's OpenAI-compatible response returns no
   * slot or task id, so on the pinned build this is always null and every
   * effective fact stays at backend-instance scope.
   */
  readonly slotCorrelation?: { readonly backendInstanceId: string; readonly requestInstanceId: string } | null;
  /**
   * A handle tying this slot reading to this generation.
   *
   * Null on the pinned llama.cpp build: the OpenAI-compatible chat response
   * carries no slot or task id, so nothing identifies which generation the slot
   * we just read belongs to. The parameter exists rather than being hardcoded
   * so the `honoured` and `overridden` states stay reachable and testable — the
   * day the runtime returns a handle this becomes a wiring change, not a
   * redesign, and until then the tests document what it would take.
   */
  readonly requestCorrelation?: { readonly slotId: number; readonly taskId: number } | null;
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
  // A reading taken against another instance is not weak evidence about this
  // one; it is evidence about a different process, and keeping it would let a
  // restart mid-request carry the old process's configuration forward.
  const sameInstance =
    inputs.slotCorrelation == null ||
    inputs.slotCorrelation.backendInstanceId === inputs.slotCorrelation.requestInstanceId;
  const requestCorrelated = sameInstance && (inputs.requestCorrelation ?? null) !== null;
  const slot = sameInstance ? inputs.slot : null;
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
  } else if (!requestCorrelated) {
    // The decisive rule. Without a handle tying the reading to this generation,
    // a slot showing our seed is a coincidence with good odds — the slot may
    // have been read before the request started, after it reset, or once the
    // next queued request had already claimed it. `requested` is where an
    // unconfirmable seed stops.
    seedSupport = 'requested';
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
    effectiveSource: slot === null ? 'unavailable' : 'runtime-slots-uncorrelated',
    effectiveScope: requestCorrelated ? 'request' : 'backend-instance',
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
