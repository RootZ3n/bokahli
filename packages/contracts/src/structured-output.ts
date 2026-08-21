/**
 * Constrained generation, and the difference between asking for it and getting
 * it.
 * ===========================================================================
 * Two regimes exist, they measure different capabilities, and their results
 * must never be pooled.
 *
 *   unconstrained  The model is responsible for emitting valid JSON itself.
 *                  Invalid output is the model's failure. Nothing repairs it,
 *                  and nothing retries in a way that hides the first answer.
 *                  This measures whether a model can hold a contract.
 *
 *   json_schema    The runtime constrains generation to a schema. Invalid
 *                  output is impossible if enforcement is real, so invalid
 *                  output means enforcement was *not* real — a runtime contract
 *                  failure, never a model success and never a model failure.
 *                  This measures whether a deployment can be relied on to
 *                  produce parseable output in production.
 *
 * A model that fails the first and passes the second is a perfectly reasonable
 * production choice. A report that merges the two says neither thing.
 *
 * ## Requested is not confirmed
 *
 * `--n-gpu-layers 999` is a request; a driver decides. `response_format` is a
 * request too, and Phase 1 already paid for the general lesson: a runtime that
 * silently ignored a placement flag served the correct artifact, attested
 * perfectly, and ran at a third of the rate. The same shape of error here would
 * be worse, because a *model* would be credited with output a grammar produced,
 * or blamed for output no grammar prevented.
 *
 * llama-server exposes no field saying "a grammar is attached to this slot" —
 * `/slots` reports the sampler chain and `chat_format`, and neither changes when
 * a schema is supplied. So enforcement is confirmed the way the tokenizer is
 * confirmed: behaviourally, against the exact backend instance, by asking for
 * something the grammar makes impossible to give.
 *
 * See `confirmStructuredOutput`. The probe sends a schema whose only legal
 * document is a fixed marker string, together with a prompt that explicitly
 * demands something else. Unconstrained, the model obeys the prompt — measured:
 * it answers `NO`. Constrained, it cannot — measured: it answers
 * `{"v":"ZQXJ7"}`. A runtime that ignores `response_format` and a runtime that
 * honours it are therefore distinguishable, which is the whole requirement.
 */

import { createHash } from 'node:crypto';

/** Bump when the regime vocabulary or the identity below changes. */
export const STRUCTURED_OUTPUT_CONTRACT_VERSION = 'bokahli.structured-output/1' as const;

/**
 * How output was produced. Part of a qualification identity, never a detail.
 */
export type GenerationRegime =
  /** The model emits JSON itself. Invalid output is MODEL-attributed. */
  | 'unconstrained'
  /** The runtime constrains generation to a JSON Schema. */
  | 'json_schema';

export const GENERATION_REGIMES: readonly GenerationRegime[] = Object.freeze([
  'unconstrained',
  'json_schema',
]);

export function isGenerationRegime(v: unknown): v is GenerationRegime {
  return typeof v === 'string' && (GENERATION_REGIMES as readonly string[]).includes(v);
}

/** What a caller may ask Bokahli to constrain generation with. */
export interface StructuredOutputRequest {
  /**
   * A JSON Schema. Passed to the runtime as given.
   *
   * Bokahli does not rewrite, relax or "fix" it. A schema the runtime refuses
   * is a refusal the caller sees, because a silently adjusted schema would
   * constrain generation to something the caller never asked for and every
   * result afterwards would describe a contract nobody wrote.
   */
  readonly schema: unknown;
  /** A short name, carried into the runtime request and into the record. */
  readonly name: string;
}

/**
 * Canonical digest of a schema.
 *
 * Keys are sorted at every level so a schema that survived a round trip through
 * a tool that reorders JSON keys still digests the same. Arrays keep their
 * order: `required: ["a","b"]` and `required: ["b","a"]` are the same schema,
 * but `prefixItems` is positional, and a canonicaliser that could not tell them
 * apart would have to sort one of them wrongly.
 */
export function structuredOutputSchemaDigest(schema: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex')}`;
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * What a confirmation probe established, against which instance, and when.
 *
 * Shaped after `TokenizerCanaryResult` on purpose: the two answer the same kind
 * of question about the same kind of claim, and an operator who has learned to
 * read one should not have to learn a second vocabulary for the other.
 */
export interface StructuredOutputConfirmation {
  readonly method: 'grammar-negative-control-probe';
  readonly contractVersion: typeof STRUCTURED_OUTPUT_CONTRACT_VERSION;
  /** The instance the probe ran against. A confirmation describes one process. */
  readonly backendInstanceId: string | null;
  readonly probedAt: string;
  /**
   * Whether the constrained answer was the only document the schema allows.
   *
   * True is a positive result: the grammar overrode a prompt that asked for
   * something else, so generation is genuinely constrained on this instance.
   */
  readonly constrained: boolean;
  /**
   * Whether the *unconstrained* control answered the prompt instead.
   *
   * Checked because without it the probe proves less than it looks. A model
   * that happened to emit the marker anyway would satisfy the constrained arm
   * on its own; the control is what makes the two arms distinguishable.
   */
  readonly controlDiffered: boolean;
  readonly reasons: readonly string[];
}

/**
 * The structured-output facts for one request.
 *
 * `requested` and `confirmed` are separate fields and never collapsed. A
 * deployment that asked for a grammar and did not get one is a different thing
 * from one that never asked, and both are different from one that asked and was
 * answered.
 */
export interface StructuredOutputFacts {
  readonly contractVersion: typeof STRUCTURED_OUTPUT_CONTRACT_VERSION;
  readonly regime: GenerationRegime;
  /** Null under `unconstrained`: there is no schema to digest. */
  readonly schemaDigest: string | null;
  readonly schemaName: string | null;
  /** Whether Bokahli sent `response_format` on this request. */
  readonly enforcementRequested: boolean;
  /**
   * Whether enforcement was proven on the serving instance.
   *
   * Null when it was never asked for, or when the probe could not run. Null is
   * not false: "we did not check" and "we checked and it does not work" send an
   * operator to different places.
   */
  readonly enforcementConfirmed: boolean | null;
  readonly confirmation: StructuredOutputConfirmation | null;
}

/** The facts for a request that asked for nothing. The common case. */
export function unconstrainedFacts(): StructuredOutputFacts {
  return {
    contractVersion: STRUCTURED_OUTPUT_CONTRACT_VERSION,
    regime: 'unconstrained',
    schemaDigest: null,
    schemaName: null,
    enforcementRequested: false,
    enforcementConfirmed: null,
    confirmation: null,
  };
}
