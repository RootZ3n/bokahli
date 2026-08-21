/**
 * Prove that constrained generation is actually constraining.
 *
 * `response_format` is a request. llama-server accepts it, and llama-server
 * exposes nothing that says it applied it: `/slots` reports the sampler chain
 * and `chat_format`, and neither changes when a schema is supplied. So a
 * deployment that silently dropped the field would be indistinguishable, by
 * inspection, from one that honoured it — and the consequence is worse than the
 * placement bug Phase 1 paid for, because the thing credited or blamed would be
 * a *model*. Output a grammar produced would read as a model that writes clean
 * JSON; output no grammar prevented would read as one that cannot.
 *
 * This is the tokenizer canary's argument applied to a different claim, and it
 * takes the same shape: ask the running process something whose answer differs
 * depending on whether the claim is true.
 *
 * ## The probe
 *
 * Two generations against one instance, with the same prompt:
 *
 *   constrained  a schema whose only legal document is `{"v":"<marker>"}`,
 *                sent with a prompt that explicitly demands a bare word and
 *                forbids JSON and braces.
 *   control      the same prompt with no schema at all.
 *
 * If enforcement is real the first cannot obey the prompt and the second can,
 * so the two answers differ and the first is the marker. If `response_format`
 * is being dropped, both arms answer the prompt and are identical — which is
 * exactly the state that must not be reported as confirmation.
 *
 * The control arm is what makes the probe worth running. Without it, a model
 * that happened to emit the marker anyway would satisfy the constrained arm on
 * its own, and the probe would confirm enforcement on a runtime that has none.
 *
 * Measured on the pinned build against Q2_K: constrained returns
 * `{"v":"ZQXJ7"}`, control returns `NO`. A malformed schema is refused with
 * HTTP 400, which separately establishes that the field is parsed rather than
 * ignored.
 *
 * ## Cost, and what it does not prove
 *
 * Two short generations per backend instance, cached for the life of that
 * instance exactly as the tokenizer probe is. It establishes that this runtime
 * constrains generation for *this* schema shape on *this* process. It is not a
 * proof that every schema is enforced correctly — a grammar compiler can be
 * wrong about a construct the probe does not use — and the per-attempt check
 * that the answer validates against the caller's own schema is what covers
 * that. Where the probe is decisive is the case it was built for: a runtime
 * that is not constraining at all.
 */
import {
  STRUCTURED_OUTPUT_CONTRACT_VERSION,
  type StructuredOutputConfirmation,
} from '@bokahli/contracts';

/**
 * The marker the schema pins.
 *
 * Deliberately not a word. A model asked for `NO` will not emit `ZQXJ7` by
 * accident, and a grammar that pins it leaves no other legal document — so the
 * marker appearing in the constrained arm is the grammar's work and nothing
 * else's.
 */
export const STRUCTURED_OUTPUT_PROBE_MARKER = 'ZQXJ7';

/**
 * The prompt, written to be answerable without JSON and to say so twice.
 *
 * An ambiguous prompt would weaken the control arm: if the model might have
 * emitted JSON anyway, "the control differed" stops being evidence. This one is
 * explicit, and the measured control answer is the bare word.
 */
export const STRUCTURED_OUTPUT_PROBE_PROMPT =
  'Reply with the single word NO. Do not output JSON. Do not use braces.';

export const STRUCTURED_OUTPUT_PROBE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['v'],
  properties: { v: { type: 'string', enum: [STRUCTURED_OUTPUT_PROBE_MARKER] } },
});

export interface StructuredOutputProbeSources {
  /**
   * One short generation. `schema` null means the control arm.
   *
   * Returns the completion text, or null when the call failed — a failed probe
   * leaves the claim unproven, which is a correct outcome and not an error a
   * caller has to handle.
   */
  readonly generate: (
    prompt: string,
    schema: unknown | null,
  ) => Promise<string | null>;
  readonly backendInstanceId: () => string | null;
  readonly now: () => Date;
}

/** Never throws. An unprovable claim is reported as unproven. */
export async function confirmStructuredOutput(
  sources: StructuredOutputProbeSources,
): Promise<StructuredOutputConfirmation> {
  const probedAt = sources.now().toISOString();
  const backendInstanceId = sources.backendInstanceId();
  const reasons: string[] = [];

  if (backendInstanceId === null) {
    return {
      method: 'grammar-negative-control-probe',
      contractVersion: STRUCTURED_OUTPUT_CONTRACT_VERSION,
      backendInstanceId: null,
      probedAt,
      constrained: false,
      controlDiffered: false,
      reasons: ['backend instance is unknown, so a confirmation cannot be bound to it'],
    };
  }

  let constrainedText: string | null = null;
  let controlText: string | null = null;
  try {
    constrainedText = await sources.generate(
      STRUCTURED_OUTPUT_PROBE_PROMPT,
      STRUCTURED_OUTPUT_PROBE_SCHEMA,
    );
    controlText = await sources.generate(STRUCTURED_OUTPUT_PROBE_PROMPT, null);
  } catch (err) {
    reasons.push(`probe could not run: ${(err as Error).message}`);
  }

  if (constrainedText === null) {
    reasons.push('the constrained arm produced no completion');
  }
  if (controlText === null) {
    reasons.push('the control arm produced no completion');
  }

  let constrained = false;
  if (constrainedText !== null) {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(constrainedText.trim());
    } catch {
      reasons.push(
        'the constrained arm did not return JSON, so the schema was not applied: ' +
          'the runtime accepted response_format and generated as though it had not',
      );
    }
    if (parsed !== undefined) {
      const v = (parsed as Record<string, unknown> | null)?.['v'];
      if (v === STRUCTURED_OUTPUT_PROBE_MARKER) {
        constrained = true;
      } else {
        reasons.push(
          `the constrained arm returned JSON the schema does not allow ` +
            `(v=${JSON.stringify(v)}): generation is not being constrained to it`,
        );
      }
    }
  }

  // Normalised only for the comparison, never for the verdict above.
  const controlDiffered =
    controlText !== null &&
    constrainedText !== null &&
    controlText.trim() !== constrainedText.trim();

  if (constrained && !controlDiffered && controlText !== null) {
    reasons.push(
      'both arms returned the same text, so the marker cannot be attributed to the ' +
        'grammar: an unconstrained model that emits it anyway is indistinguishable here',
    );
  }

  return {
    method: 'grammar-negative-control-probe',
    contractVersion: STRUCTURED_OUTPUT_CONTRACT_VERSION,
    backendInstanceId,
    probedAt,
    // Both arms, or nothing. The constrained arm alone is not a confirmation.
    constrained: constrained && controlDiffered,
    controlDiffered,
    reasons,
  };
}
