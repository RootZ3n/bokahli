# Qualification telemetry

Every operational fact Luak needs to turn a Bokahli response into qualification
evidence, and — for each one — where it came from and what it is worth.

## Why

The six-attempt pilot on 2026-08-20 executed end to end and then refused to
export, with seven refusals: `TOKEN_COUNTS_NOT_MEASURED` once per attempt, and
`CONTEXT_TIER_NOT_MEASURED` on the identity. Both had one cause. Bokahli
returned `promptTokens` and `completionTokens` and said nothing about which
tokenizer produced them.

Those counts were almost certainly exact — they come from llama.cpp's own
`usage` block. "Almost certainly" is the problem. It cannot be distinguished
afterwards from "we assumed", and a benchmark built on it is measuring its own
assumptions. So the fix is not to assert the counts are good; it is to publish
the proof and let the claim fail when the proof is absent.

## Provenance classes

Every fact carries one:

| Class | Means | Worth |
|---|---|---|
| `declared` | Configuration says so | Bokahli was told |
| `requested` | Bokahli asked for it | Nothing confirms it took effect |
| `runtime-reported` | The serving process answered a query | Real, and only as fresh as the query |
| `observed` | Measured from the kernel, the driver, or the artifact's bytes | Independent of what anyone claims |

The weak two are the ones that read strongest in a report. `--n-gpu-layers 999`
is a request. A driver that lists our pid holding VRAM is an observation. A
field that cannot say which it is will eventually be read as the stronger one.

## The fields

### Tokenizer — `qualificationFacts.tokenizer`

| Field | Source | Class | Restart-stable |
|---|---|---|---|
| `family` | GGUF `tokenizer.ggml.model` | observed | yes — a property of the artifact |
| `pretokenizer` | GGUF `tokenizer.ggml.pre` | observed | yes |
| `vocabSize` | count of GGUF `tokenizer.ggml.tokens` | observed | yes |
| `runtimeVocabSize` | `/v1/models` → `meta.n_vocab` | runtime-reported | yes, unless the model changes |
| `vocabSizeMatch` | the two compared | observed | yes |
| `metadataDigest` | sha256 over family, pre-tokenizer, token list, merge list, token types, special ids | observed | yes |
| `tokenizedBy` | structural: llama.cpp's `usage` is the only source of counts | observed | yes |

Observed once per artifact digest and cached against it, because the digest *is*
the content: a cache hit means the bytes are the same bytes.

**`runtime_tokenizer` requires all three of:**

1. the backend was attested to be serving this artifact — otherwise we may be
   describing the tokenizer of a file that is not loaded;
2. `metadataDigest` is present — a family name is not an identity, since two
   Qwen quantisations can share `gpt2` and split text differently through
   different pre-tokenizers;
3. `vocabSizeMatch` is true — the binding between the file we hashed and the
   model the runtime loaded.

Miss any one and the answer is `runtime_reported_unknown_tokenizer` with the
reason in `unprovenReasons`. Failure to read the artifact is a null digest and a
reason, never a guess. Nothing in this path can produce `estimated`: Bokahli
never counts characters.

Prompt and completion counts carry separate verdicts, and the overall verdict is
the weaker of the two — a prompt count that could not be established must not
hide behind a completion count that could.

### Prompt template — `qualificationFacts.template`

| Field | Source | Class | Restart-stable |
|---|---|---|---|
| `effective.templateDigest` | sha256 of `/props` → `chat_template` | runtime-reported | yes |
| `effective.templateId` | `/slots` → `params.chat_format` | runtime-reported | reflects the last request |
| `effective.reasoningFormat` | `/slots` → `params.reasoning_format` | runtime-reported | reflects the last request |
| `matchesArtifactTemplate` | runtime template hashed against GGUF `tokenizer.chat_template` | observed | yes |
| `requested` | what Bokahli asked for — currently nothing | requested | n/a |

Measured on the live deployment: the runtime's template is **byte-identical** to
the one in the verified artifact (`sha256:a4aee8af…`, 7,756 bytes). That is the
proof the model's own template was applied rather than a substitute. A name
would not have caught a substitution; the bytes do.

Requested and effective are separate fields because on this deployment they
disagree. The unit starts llama-server with `--reasoning off` and `/props`
reports `reasoning_format: "none"`, while a live slot reports `"deepseek"` with
a generation prompt injecting an empty thinking block
(`<|im_start|>assistant\n<think>\n\n</think>\n\n`). A single field would have had
to choose one, and would have reported the wrong one.

Bokahli requests no chat format: it sends messages and lets the runtime apply
the model's template. That is recorded as `requested: null` — "we did not ask",
which is distinct from "we do not know what we asked".

### Sampler — `telemetry.sampler`

Three records, never collapsed: `requested` (the client's ask), `sent` (what
went on the wire, including any Phase 1 default that filled a gap), and
`effective` (what the runtime says it used, from `/slots`).

`seedSupport` is `not_requested` | `requested` | `honoured` | `overridden`.
**Sending is not honouring.** `honoured` requires the runtime to echo the same
value back.

llama.cpp reports `0xFFFFFFFF` when no seed was given. That sentinel is treated
as "no seed reported", not as a value — comparing it against a sent seed yields
"not equal" and would report `overridden`, telling an operator the runtime
substituted a seed it never echoed. The API also refuses `4294967295` as a seed
so the verdict cannot be made to lie from the other direction.

`effective` is read from `/slots` after the response completes, and only when
`maxConcurrentRequests <= 1`. Above that the slot may hold another request's
parameters, and evidence gathered under a race is not distinguishable afterwards
from evidence gathered without one.

**Deterministic settings do not guarantee identical output.** Measured on this
deployment at `temperature: 0`: the same prompt produced 68, 53 and 68
completion tokens across three attempts. The artifact is a 256-expert MoE served
with `--cpu-moe`; expert routing, batching and kernel reduction order are all
free to vary. `deterministicOutputGuaranteed` is typed as the literal `false`.
Repeatability is measured by repetition, and that is Luak's job.

### Backend instance — `qualificationFacts.backendInstance`

| Field | Source | Class | Restart-stable |
|---|---|---|---|
| `pid` | `/proc` scan matching argv against the backend port | observed | **no, by design** |
| `kernelStartTicks` | `/proc/<pid>/stat` field 22 | observed | **no** |
| `bootId` | `/proc/sys/kernel/random/boot_id` | observed | survives restart, not reboot |
| `startedAt` | `/proc/stat` btime + ticks / 100 | observed | no |
| `instanceId` | sha256 of bootId, pid and kernelStartTicks | observed | **no** |

The point is that it is *not* stable. A restart returning on the same build is
invisible to build-level identity, and attempts either side of one ran against
freshly loaded weights and an empty KV cache while claiming one identity.

Pid alone is worthless — pids are reused. The kernel start time makes reuse
detectable; it is in ticks since boot rather than wall-clock, so a clock
adjustment cannot look like a restart. The boot id makes the pair meaningful
across reboots, where tick counts restart from zero.

All three or nothing: a hash over a partial set would be stable for the wrong
reasons. Failure leaves `instanceId` null with a reason.

### Device placement — `qualificationFacts.placement`

| Field | Source | Class | Restart-stable |
|---|---|---|---|
| `backendHoldsDevice` | `nvidia-smi --query-compute-apps` listing our exact pid | observed | no |
| `backendVramMiB` | the same table | observed | no |
| `requestedGpuLayers` | `--n-gpu-layers` from `/proc/<pid>/cmdline` | **requested** | no |
| `cpuOffloadEnabled` | `--cpu-moe` from the same | **requested** | no |

Re-measured on a 5-second TTL, because a backend can lose the device without any
other signal changing — pid, build and attestation would all stay identical.

The driver's compute-app table is used rather than `/proc/<pid>/fd`, which is
unreadable inside the units' sandboxes. Same definition as
`scripts/assert-gpu-placement.sh`, deliberately: two process-detection
implementations will eventually disagree, and the day they do, one of them will
be deciding whether evidence is valid.

**Unreadable is not absent.** A failed query yields `backendHoldsDevice: null`
plus a limitation; an answered query that omits our pid yields `false`. Reporting
the first as the second would accuse a healthy GPU backend of running on the CPU.

Whole-GPU telemetry stays in `gpuLease` — a separate key, because it answers "is
the box busy", never "is our backend on the device". A CPU-only llama-server
serves the correct artifact, attests correctly, and runs at a third of the decode
rate while the utilisation graph looks fine. That was a real Phase 1 failure.

### Runtime facts — `qualificationFacts.runtime`

| Field | Source | Class | Restart-stable |
|---|---|---|---|
| `imageDigest` | sha256 over the executable and the build tree's shared objects | observed | yes, unless rebuilt |
| `imageDigestBinding` | which method produced it | observed | no |
| `driverVersion` | `nvidia-smi --query-gpu=driver_version` | observed | yes |
| `driverSupportedCuda` | `nvidia-smi` header `CUDA Version:` | observed | yes |
| `processCudaRuntime` | `libcudart.so.<v>` in `/proc/<pid>/maps` | observed | yes |
| `cublasVersion` | `libcublas.so.<v>` in the same | observed | yes |

**The digest is composite and has to be.** `llama-server` on this host is 12,528
bytes — a stub. The CUDA backend is 44 MB of `libggml-cuda`, and the inference
code is in `libllama` and `libllama-server-impl` beside it. Hashing the stub
alone would produce a digest that survives a complete rebuild of everything that
does the work: proof-shaped, and proving nothing. Nine objects contribute, each
as `basename:sha256` in sorted order. Only basenames ever leave the process.

**Two CUDA versions, because they are two facts.** Measured here: the driver
advertises 13.2, and the serving process has `libcudart.so.13.2.51` and
`libcublas.so.13.3.0.5` mapped. The header number is a capability of the driver.
Reporting it as the CUDA the runtime uses would be copying a version string into
a stronger field.

**A known limitation, stated in the payload.** Binding either fact to the running
process needs `/proc/<pid>/maps`, and that is denied under the API's systemd
sandbox. Measured, not assumed — under `NoNewPrivileges`, `PrivateTmp`,
`ProtectControlGroups` and `ProtectKernelTunables`:

```
cmdline: READABLE      stat: READABLE      status: READABLE
maps:    DENIED        exe:  ABSENT
```

So in production `imageDigestBinding` is `configured-tree`: the digest proves
what is on disk at the location the running process names in its argv, not what
that process mapped. The strong form is attempted first and used when available.
`processCudaRuntime` is null under the sandbox, and `driverSupportedCuda` is
**not** substituted for it.

### Attestation — `qualificationFacts.attestation`

`bindingDigest` is a domain-tagged canonical hash over `binding`, which contains
model id, artifact digest, runtime build, image digest, tokenizer digest,
effective template digest, backend instance id, the placement *verdict*, context
and concurrency configuration, and only runtime-confirmed sampler settings.

A requested-but-unconfirmed sampler is not bound: binding it would attest to
something nobody checked.

GPU utilisation, temperature and VRAM held are deliberately absent. They change
second to second, and including them would make the digest change constantly —
which trains a reader to ignore changes, the opposite of what a digest is for.

`completeness` is `complete` | `partial` | `unattested`. `unattested` is
identity failure only. A deployment can be perfectly attested and still
`partial`, and collapsing the two would report a missing observation as a
possible substitution — a much louder claim than the facts support. `missing`
names each absent component.

A backend restart changes `backendInstanceId`, so it invalidates the attestation
by construction rather than by anyone remembering to invalidate it.

## API compatibility

Additive. Every Phase 1 field keeps its name, its type and its value.

- `telemetry.promptTokens` / `completionTokens` are unchanged; `tokenCounts`
  says where they came from.
- `RuntimeIdentity.executableDigest`, `.cuda` and `.driver` were declared in the
  type and hardcoded `null` since Phase 1. They are now populated from the same
  observation `qualificationFacts.runtime` carries, so the summary field and the
  detailed one cannot disagree.
- The top-level `temperature`, `top_p` and `max_tokens` keep their original
  coercing parse **exactly**. A client that has been sending `temperature: "0.7"`
  since Phase 1 still gets 0.7.
- Strictness applies only to the new native `sampler` object: bounded, integers
  where integers are meant, unknown keys refused, and out of range refused rather
  than clamped. Setting a value in both places is a 400, never a silent
  precedence rule.
- A request that omits `sampler` produces **byte-identical** upstream request
  bytes — `top_k` and `seed` are spread in only when present. Asserted by test,
  not by this paragraph.
- AUTO, PROFILE, EXACT and escalation semantics are untouched. The OpenAI
  endpoint is untouched.

## Security

No response carries a model path, an executable path, a token, a header, an
environment value, or a process command line. Argv is parsed for two values —
`--n-gpu-layers` and `--cpu-moe` — and discarded; a command line can carry an API
key. Image components are basenames. Artifact-read failures report the error
*class*, since the message would name a path. Asserted by test across the chat,
`/health/ready` and `/v1/models` bodies.

## What is still unavailable

- **`processCudaRuntime` in production.** Needs `/proc/<pid>/maps`, denied under
  the sandbox. Closing it means relaxing a hardening option, which is an operator
  decision and not obviously worth it.
- **`imageDigest` bound to the process** in production, for the same reason. The
  fallback announces itself.
- **`observedGpuLayers`.** llama.cpp reports no per-layer placement, only whether
  the process holds a compute allocation. Requested layers and actual placement
  are both reported; how many layers landed is not knowable from outside.
- **A seed the runtime confirms.** The seed is now sent and llama.cpp accepts it,
  but whether it is echoed can only be verified against a live backend. Until
  then `seedSupport` will read `requested`, which is the honest state.
