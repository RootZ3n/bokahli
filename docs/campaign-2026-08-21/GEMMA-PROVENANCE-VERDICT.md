# Phase 5 — can a general proof replace the missing `tokenizer.ggml.pre`?

**Verdict: no, not with what this runtime exposes.** Both Gemma artifacts stay
blocked. What is missing is precise, and two different one-line changes would
each close it.

This document records the attempt in full, including the part where the first
approach was wrong, because the way it was wrong is the interesting part.

## The gap, restated exactly

`tokenizerFullyProven` requires `pretokenizer !== null`. Both Gemma GGUFs
declare `tokenizer.ggml.model = "gemma4"` and no `tokenizer.ggml.pre`, so
`metadataBound` is false, token counts degrade to
`runtime_reported_unknown_tokenizer`, and Luak's exporter refuses the evidence.

Everything else these artifacts carry is complete: exact artifact digest,
tokenizer metadata digest, 40/40 encode canary and 32/32 decode canary against
independent preparation-time references, canary bound to the serving instance,
vocabulary size agreement, template identity, runtime build, instance
continuity.

## Attempt 1 — an override sweep. It was wrong, and the control is what caught it

The idea: if `tokenizer.ggml.pre` genuinely cannot change how an artifact
tokenizes, its absence is not ambiguity. Test it by re-tokenizing a
boundary-heavy corpus under `--override-kv tokenizer.ggml.pre=str:X` for every
pre-tokenizer name the build knows (46 of them), and require that some value
changes the output before treating the field as load-bearing.

On Gemma, 24 overrides produced byte-identical token ids. That looked like proof.

**Then the negative control failed.** Qwen3.5 declares `pre = "qwen35"`, which
llama.cpp maps to `LLAMA_VOCAB_PRE_TYPE_QWEN2` — a different regex from
`LLAMA_VOCAB_PRE_TYPE_LLAMA3`, and the digit-splitting rules differ. Overriding
Qwen's `pre` to `llama3`, to `deepseek-llm`, and to `default` produced the *same*
ids as the baseline on inputs chosen to discriminate them:

    input "1234567890"
      no override      [16,17,18,19,20,21,22,23,24,15]
      pre=llama3       [16,17,18,19,20,21,22,23,24,15]
      pre=deepseek-llm [16,17,18,19,20,21,22,23,24,15]
      pre=default      [16,17,18,19,20,21,22,23,24,15]

`--override-kv` does not reach the vocabulary loader in `llama-tokenize`. The
instrument reports "inert" for every artifact, including one where the field is
provably load-bearing.

Had the sweep been run without a negative control, it would have produced a
general-looking rule that unblocked every artifact in the catalog on the
strength of a measurement that measures nothing. That is the same shape as the
three defects this campaign has already corrected — an unchecked cast, a grep
that matched itself, a prefill rate computed over four cached tokens — and it is
the reason the control was run.

## What the source says, and why that is not enough

`src/llama-vocab.cpp:2123`, inside the `tokenizer_model == "gemma4"` branch:

    tokenizer_pre = "gemma4";

assigned unconditionally, after the file's own value is read at line 1929 and
before the mapping at 2133. For this tokenizer model the field is genuinely
inert: llama.cpp overwrites whatever the file said with the same constant.

So the *fact* is almost certainly true. But the brief requires the proof to rest
on independently measured facts, and "we read the loader's source for this build"
is neither measured nor stable — it is a claim about one commit that no check
would re-verify after an upgrade.

## Attempt 2 — the fallback warning. Measurable, and still not sound

When a BPE vocabulary has no usable pre-tokenizer, llama.cpp warns:

    missing pre-tokenizer type, using: 'default'
    GENERATION QUALITY WILL BE DEGRADED!

That is the exact hazard the field exists to prevent, and its absence is
runtime-observable. Measured: loading either Gemma artifact emits four warning
lines and none of them is this one, so neither artifact defaults its
pre-tokenizer. The channel demonstrably works.

**This was rejected as a provenance basis anyway**, because its failure mode is
silent. The check is a negative observation against a log string with no
stability contract. If the message is reworded upstream, every artifact silently
gains provenance it has not earned — and nothing in the test would notice,
because there is no artifact in the catalog that triggers the warning to serve
as a live control.

A proof that degrades to "pass" when its instrument breaks is the defect this
whole campaign exists to remove. It is not made acceptable by being convenient.

## What is actually missing

The runtime exposes `vocab_type` (2, BPE) through `/v1/models` and reports
`bos_token` and `eos_token` through `/props`. **It never reports the pre-tokenizer
type it resolved.** There is no positive signal anywhere in the served surface
that says which splitting rule is in force.

Either of these closes the gap completely:

1. **Upstream metadata.** The producer sets `tokenizer.ggml.pre = "gemma4"` in
   the GGUF. llama.cpp reads it at line 1929 and overwrites it with the same
   value at 2123, so the behaviour is unchanged and the existing contract is
   satisfied with no rule change here at all. One field in a conversion script.

2. **Runtime capability.** llama-server reports the resolved pre-tokenizer — the
   string `tokenizer_pre` holds after loading — in `/props` or `/v1/models`
   meta. Then the proof is a positive, bindable observation: the runtime states
   which rule it resolved, Bokahli records it beside the metadata digest and the
   canary, and an artifact that defaulted is distinguishable from one that did
   not. That rule would be general, would need no name allowlist, and would fail
   closed when the field is absent.

Until one of those exists, `pretokenizer !== null` stays as the requirement. It
is not a good requirement — the metadata digest already hashes the field, so the
collision it claims to prevent is prevented without it — but it is a *safe* one,
and replacing a poor rule with an unsound one is not an improvement.

## What was explicitly not done

- No Gemma-specific exception.
- No model-name allowlist.
- No relaxation of the rule for Qwen, whose evidence is untouched.
- No re-run of Gemma inference. The Stage A evidence is preserved exactly as
  measured and would become exportable, without re-measurement, the moment the
  provenance basis is available.

Gemma 26B's constrained-regime Stage A results remain among the best measured in
this campaign — 6/6 valid structured output, 15/15 exact citations, 0 injections
followed, 3/3 detected. It is blocked on a metadata convention, not on
behaviour, and that distinction is the point of writing this down.
