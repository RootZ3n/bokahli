# Phase 1 — the Qwen ~9B candidate, selected and recorded before download

The operator recalled "a Qwen model around 9B parameters" without naming an
artifact. This is what that resolves to, why, and everything checkable about it
that was established *before* 7.4 GiB was written to disk.

## The model

| | |
|---|---|
| upstream | `Qwen/Qwen3.5-9B` |
| GGUF repo | `bartowski/Qwen_Qwen3.5-9B-GGUF` |
| repo revision | `182be2fd6c7bc44887d88a91cb03ff009cc9f549` |
| producer | bartowski — the same producer as all three existing non-control artifacts |
| license | Apache-2.0 |
| gated | no |
| private | no |
| imatrix | yes, `Qwen_Qwen3.5-9B-imatrix.gguf` is published in the repo |

Dense and instruction-capable, which is what was asked for. The 35B already
installed is `qwen35moe`; this is the dense sibling.

## Architecture, read from the file's own header before downloading it

A 48 MiB range request over the artifact is enough to reach the whole key-value
block (the metadata is 10.9 MB). Nothing below is taken from a model card.

    general.architecture              qwen35
    general.name                      Qwen3.5 9B
    general.size_label                9B
    qwen35.block_count                33
    qwen35.context_length             262144
    qwen35.embedding_length           4096
    qwen35.attention.head_count       16
    qwen35.attention.head_count_kv    4
    qwen35.attention.key_length       256
    qwen35.attention.value_length     256
    qwen35.full_attention_interval    4
    qwen35.rope.freq_base             10000000.0

**Runtime compatibility is established, not assumed.** The pinned build
`b10505-ee4c505a4` carries a `qwen35` architecture implementation alongside
`qwen35moe`; both appear in `libllama.so`. The control artifact this machine
serves today is `qwen35moe` from the same family.

## Tokenizer — the field that blocked Gemma

    tokenizer.ggml.model              gpt2
    tokenizer.ggml.pre                "qwen35"
    vocab size                        248320
    eos / pad                         248046 / 248044, add_bos false
    tokenizer metadata digest         sha256:ec568e238fc0a08604677d646731795c78934c222648bc6c2217281c39af21ab
    chat template digest              sha256:a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715

Two things follow, and both matter.

**It carries `tokenizer.ggml.pre`.** Both Gemma artifacts do not, which is why
their token counts degrade to `runtime_reported_unknown_tokenizer` and their
evidence cannot be exported. This candidate satisfies the existing provenance
contract as it stands, with no rule change.

**Its tokenizer and chat template are byte-identical to the 35B Qwen
artifacts.** Same metadata digest, same template digest, same vocabulary. That
is a real convenience — the canary corpus and its expectations transfer exactly,
and the derived canary suite id will be the same
`tokcanary.v1.gpt2-qwen35.c9a67aacc.tec568e238fc0` — but it changes nothing
about binding: a canary is pinned to `artifactDigest`, so a new suite must still
be generated for this artifact and a 35B canary can never verify against it.

## Quantization choice

Mushin has 12282 MiB of device memory and needs a real margin for KDE/Wayland.

KV cost is unusually low for this architecture. `full_attention_interval: 4`
means roughly 8 of 33 layers carry a growing cache; at 4 KV heads × 256 dim,
K+V, f16, that is ~32 KiB per token, so 32K context costs about 1.0 GiB rather
than the 3–4 GiB a uniformly-attentive 9B would need.

| quant | GiB | est. weights+KV+compute | est. margin under 12282 MiB |
|---|---|---|---|
| **Q6_K** | **7.41** | **~9.0 GiB** | **~3.0 GiB** |
| Q8_0 | 9.13 | ~10.6 GiB | ~1.3 GiB |
| Q5_K_M | 6.62 | ~8.2 GiB | ~3.8 GiB |

**Q6_K selected.** It is the operator's stated initial preference, it is an
imatrix quantisation, and it leaves roughly 3 GiB of device memory unused — a
margin that survives an ordinary desktop rather than one that requires an idle
one. Gemma 12B Q6_K measured 11082 MiB at 32K on this machine and was stable but
left under 1.2 GiB; that is the configuration this choice is deliberately
avoiding.

**Only one quantisation is being downloaded.** A second is justified only by a
concrete question the first cannot answer, and none exists yet. If Q6_K's
measured VRAM leaves more headroom than estimated *and* its qualification
results are marginal, Q8_0 answers "is this quantisation the limiting factor" —
that decision waits for measurements.

## Published digest

    Qwen_Qwen3.5-9B-Q6_K.gguf
    sha256:073a9275e65d9c8cd2819cf5f77b99fbaa6e87ba591da6bbaa86ec073a64bfef

Verified against the repository's LFS metadata before download, recomputed over
the downloaded bytes before installation, and installed atomically. It will be
registered `INSTALLED_UNQUALIFIED` with `authority: none`, like every other
artifact in this catalog.

## What is deliberately not used

The repository publishes `mmproj-Qwen_Qwen3.5-9B-f16.gguf`. This model accepts
images upstream; Bokahli serves the language model only, declares
`capabilities.vision: false`, and loads no mmproj. The campaign's placement
rules already forbid an mmproj, draft model or speculative decoder, and
`scripts/runtime-exec.sh` has no knob for any of them.
