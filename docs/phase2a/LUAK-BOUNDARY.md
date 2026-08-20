# The Luak / Bokahli authority boundary

Luak is the qualification authority. Bokahli consumes what Luak has issued and
decides, under an operator's policy, whether that is enough to route a task
class to a specific installed artifact. Neither side can do the other's job:

| | Luak | Bokahli |
|---|---|---|
| Runs fixtures against a model | ✅ | ❌ |
| Scores an attempt | ✅ | ❌ |
| Issues QUALIFIED / DISQUALIFIED | ✅ | ❌ |
| Decides what evidence is *sufficient* | its own thresholds, for its own leaderboard | the operator's policy, for routing |
| Knows the exact served artifact digest | ❌ (see gaps) | ✅ |
| Knows the runtime build and hardware | ❌ (see gaps) | ✅ |
| Attests what is actually being served | ❌ | ✅ |

Bokahli never calls Luak. Import is an offline, operator-initiated act, so a
Luak outage cannot change what Bokahli will route, and a compromised Luak
service cannot reach into the request path.

---

## Part 1 — What Luak already has

Read-only inspection of `RootZ3n/luak` at `master` `46e99cf920cf`
("AI Model Testing Suite", TypeScript, public). Everything in this section is an
observed fact about that repository, with the file it came from. Nothing here is
proposed, requested, or assumed.

### Evidence bundle format

`schemas/evidence_bundle.schema.json`, `$id: https://crucibulum.local/schemas/evidence_bundle.schema.json`,
`additionalProperties: false`, `bundle_version` `"1.0.0"` (the conversational
runner also emits `"2.0.0"`). Required: `bundle_id`, `bundle_hash`,
`bundle_version`, `task`, `agent`, `environment`, `timeline`, `diff`, `security`,
`verification_results`, `score`, `usage`, `judge`, `trust`, `diagnosis`.

**One bundle is one attempt at one task.** Aggregation across runs happens at
query time in the leaderboard layer (`server/routes/leaderboard.ts`,
`leaderboard/aggregator.ts`); there is no persisted aggregate artifact.

### Model / provider identity

`agent.{adapter, adapter_version, system, system_version, model, model_version, provider}`.
The leaderboard groups runs by `` `${adapter}:${provider}:${model}` ``
(`leaderboardIdentity`, `server/routes/leaderboard.ts:101`).

`environment.{os, arch, repo_commit, crucibulum_version, timestamp_start, timestamp_end}`.

### Score and outcome representation

- `score.{total, breakdown{correctness, regression, integrity, efficiency}, pass, pass_threshold, integrity_violations}`
- `verification_results.efficiency.{time_sec, time_limit_sec, steps_used, steps_limit}`
- `usage.{tokens_in, tokens_out, estimated_cost_usd}`
- `types/scores.ts`: `ScoreFamily` A–K, `CanonicalTaskFamily` (11 values),
  `SuiteManifest` with weights + `pass_threshold` + `flake_detection {enabled, retries}`
- Leaderboard derives `stability_score`, `reliability_score`, `completion_rate`,
  `nc_rate`, `model_failure_rate`, `total_flaky`, `total_stable`, `confidence`

### Failure-origin classification

This is the strongest part of the existing model, and Bokahli adopts it rather
than inventing a parallel vocabulary. `types/verdict.ts`:

- `CompletionState`: `PASS | FAIL | NC`
- `FailureOrigin`: `MODEL | PROVIDER | NETWORK | TEST | JUDGE | HARNESS | UNKNOWN`
- `FailureReasonCode`: ~35 values (`provider_rate_limited`, `judge_not_evaluable`,
  `harness_preflight_failure`, …)
- `countsTowardModelScore` / `countsTowardFailureRate` — explicit attribution flags

The bundle additionally carries per-family `*_evaluation` objects
(`benchmark_evaluation`, `build_evaluation`, `safety_evaluation`,
`memory_evaluation`, `personality_evaluation`), each with a `category` enum plus
`reflects_model_capability` and `failure_is_infrastructure`.

### Evidence identity — content hash and signature

Both already exist (`core/bundle.ts`, `utils/hashing.ts`):

- `bundle_hash = sha256Hex(JSON.stringify(bundleHashInput(bundle), null, 0))`,
  where `bundleHashInput` strips `bundle_hash`, `signature`, and
  `trust.bundle_signature_status`.
- `signature = "hmac-sha256:" + HMAC-SHA256(CRUCIBLE_HMAC_KEY, `${bundle_id}.${bundle_hash}`)`,
  computed only when `CRUCIBLE_HMAC_KEY` is set.
- `BundleSignatureStatus`: `valid | forged | legacy_unverified | unsigned_key_missing | tampered`.
  `verifyBundle()` returns `valid: true` only when hash *and* signature verify.
- Unverified, tampered, mock or demo bundles are quarantined and marked
  `NOT RANKED` rather than deleted (`filterLeaderboardEligibleBundles`).

Oracle integrity is separately hashed: `oracle_ref.hash` with statuses
`valid | missing | mismatch | malformed | placeholder | not_required`.

### Existing capability / task taxonomy

- `CanonicalTaskFamily`: `poison_localization`, `spec_discipline`, `orchestration`,
  `identity`, `truthfulness`, `cost_efficiency`, `personality`, `safety`, `memory`,
  `tool_calling`, `operational_trust`
- `schemas/task_manifest.schema.json` `family` enum is currently narrower:
  `poison_localization | spec_discipline | orchestration`
- `core/capability-certification-types.ts`: `CapabilityId = "vision" | "roleplay"`;
  `CapabilityTier = EXPERIMENTAL | PROVIDER_TESTED | STABLE | CAPABILITY_CERTIFIED | BLOCKED_UNSUPPORTED`,
  with `affectsLeaderboard` and `affectsCertification` typed as the literal `false`

**Neither `test_log_triage` nor `repo_reconnaissance` exists in Luak today.**

### Deterministic scorers

`judge.kind` is the literal `"deterministic"` in the bundle schema.
`trust.{rubric_hidden, narration_ignored, state_based_scoring, bundle_verified}`
record the anti-gaming posture. `core/scorer-registry.ts`, `scorers/`,
`core/oracle.ts`. Task manifests carry `verification.{public_tests_command, build_command, runtime_command, lint_command}`,
`constraints.*` budgets, `seed`, and `oracle_ref.hash`.

### Eligibility synthesis

`core/eligibility.ts` already produces a routing-facing artifact:
`schema: "crucible.eligibility.v1"` with `capabilities[] {capability, eligible, reason}`,
`sample_adequate`, `total_runs`, `hard_fail_modes`, `unproven`. Its constants are
`MIN_SCORE = 50`, `MIN_TRUST_SCORE = 60`, `MIN_RUNS = 3`. The bundle also carries
`diagnosis.integrations.paedagogus.routing_signals`, so exporting for a router is
an intended direction, not a novel one.

---

## Part 2 — What Bokahli adds, and why

Everything in this section is a Bokahli-side extension. None of it is a change
to Luak, and none of it was found in Luak.

### The qualification key

`packages/contracts/src/qualification.ts`. Luak's identity is
`adapter:provider:model`. That is the right grain for comparing hosted
providers, and the wrong grain for deciding what a local box may serve, because
every element below can invalidate a verdict on its own:

| Key element | Present in Luak | Why Bokahli needs it |
|---|---|---|
| `modelId` | ✅ as `agent.model` | — |
| `artifactDigest` | ❌ | The same name can front different weights. Bokahli attests digests; a verdict that does not name one cannot be tied to what is served. |
| `quantization` | ❌ | Q2_K and Q8 are different models for every purpose qualification exists to serve. |
| `runtimeName` + `runtimeBuild` | ❌ | Sampling, tokenisation edges and numerics move between builds. Bokahli already pins the build and refuses to attest a mismatch. |
| `hardwareProfileId` | ❌ | With partial offload (`--cpu-moe`), placement changes throughput and can change output. The 2026-08-20 reboot is the standing proof that placement is not cosmetic. |
| `taskClass` + `taskClassContractVersion` | partial (`task.family`) | Changing the question invalidates the answer. |
| `fixtureSuiteId` + `fixtureSuiteVersion` | partial (`SuiteManifest.id`, no version field) | A suite that gained fixtures is a different bar. |
| `verificationRegimeVersion` | ❌ | Scoring-regime changes must not silently re-grade old runs. |

### Aggregate evidence

Luak persists per-attempt bundles and aggregates at query time. Bokahli needs a
persisted, hashable aggregate, because a routing decision must be reproducible
from a stored artifact rather than from a live query against another service.
`QualificationAggregate` carries attempt counts, outcome counts, mean score,
pass rate, infrastructure-failure rate, schema/citation violation rates, score
standard deviation, repeatability disagreement, context tier and known failure
modes — and the importer **recomputes every one of them from the attempts and
rejects the bundle if they disagree**. Aggregates are compared, never corrected:
silently fixing evidence would make Bokahli a second, unaccountable scoring
authority.

### Canonicalisation

Luak's `sha256Object` is `JSON.stringify(obj, null, 0)` — insertion-order
dependent. It is stable inside the process that built the bundle and stops being
stable the moment anything reorders keys, which JSON explicitly permits. Bokahli
hashes its own bundles with a JCS-style canonical form (sorted keys, no
insignificant whitespace, arrays untouched) and carries Luak's `bundle_hash`
alongside as provenance rather than adopting it as identity.
`luakCompatBundleHash()` reproduces Luak's algorithm exactly so the divergence
stays demonstrable rather than asserted; a test pins it.

### Signatures

Luak's signing is **HMAC-SHA256 with a shared secret**. Bokahli deliberately
does not hold `CRUCIBLE_HMAC_KEY`: a key that lets Bokahli verify a Luak
signature is the same key that lets Bokahli forge one, which would dissolve the
authority boundary this whole document is about. So for Phase 2A:

- Bokahli verifies its own canonical content hash — no secret required.
- Luak's `bundle_hash` and `signature_status` are carried through verbatim,
  never upgraded. An `unsigned_key_missing` bundle stays `unsigned_key_missing`
  after import, and a test asserts it.
- No new cryptography was written.

Asymmetric signing would close this properly. It is named as a Phase 2B item,
not improvised here.

### Unknown is not favourable

Every optional measurement is a **required field that may be `null`**. An
omitted key is a malformed bundle. This is the difference between "TTFT was not
measured" and "TTFT was zero", and between "no fixture was repeated" and
"repeats never disagreed". The policy evaluator treats a `null` that a
requirement depends on as a shortfall with reason `EVIDENCE_INCOMPLETE`, unless
the operator writes `treatUnknownAsFailure: false` explicitly.

### Policy, and the absence of thresholds

`QualificationPolicy` has no defaults. An unconfigured policy accepts nothing
and says `NO_POLICY_CONFIGURED`. Luak has picked numbers for its own leaderboard
(`MIN_RUNS = 3`, `MIN_SCORE = 50`); Bokahli does not inherit them, because a
threshold for ranking a public scoreboard is not a threshold for deciding what a
machine will do unattended. Choosing those numbers is an operator act, informed
by evidence that does not exist yet.

---

## Part 3 — Gaps between current Luak output and the required import bundle

An exporter written today could **not** produce a valid Bokahli bundle. What is
missing, in order of how much work it represents:

| # | Required by Bokahli | Luak today | Severity |
|---|---|---|---|
| 1 | `artifactDigest` | absent — no artifact-level identity anywhere | **blocking** |
| 2 | `quantization` | absent | **blocking** |
| 3 | `runtimeName` / `runtimeBuild` | absent; `environment` records `crucibulum_version`, not the inference runtime | **blocking** |
| 4 | `hardwareProfileId` + `HardwareProfile` | absent; `environment` has `os`/`arch` only, no GPU, VRAM, driver, CUDA or offload | **blocking** |
| 5 | `taskClass` `test_log_triage` / `repo_reconnaissance` | neither exists; no fixtures, no oracles, no scorer | **blocking** |
| 6 | `fixtureSuiteVersion` | `SuiteManifest` has `id` but no version field | moderate |
| 7 | `verificationRegimeVersion` | not modelled | moderate |
| 8 | `timings.timeToFirstTokenMs` | absent | moderate |
| 9 | `timings.prefillTokensPerSecond` / `decodeTokensPerSecond` | absent; only `time_sec` | moderate |
| 10 | `contextTierTokens` | absent | moderate |
| 11 | `compliance.outputSchemaValid` / `citationsValid` | no citation-grounding scorer exists | moderate |
| 12 | Persisted aggregate over N attempts | aggregation is query-time only | moderate |
| 13 | Order-independent canonical hash | `JSON.stringify` order-dependent | minor (Bokahli hashes its own form) |
| 14 | Verifiable-by-Bokahli signature | HMAC with a shared secret | minor for now, structural later |

Mapping that *does* work today, unchanged:

| Bokahli | Luak |
|---|---|
| `AttemptOutcome.PASS/FAIL` | `CompletionState.PASS/FAIL` |
| `AttemptOutcome.INCOMPLETE` | `CompletionState.NC` |
| `AttemptOutcome.PROVIDER_FAILURE` | `FailureOrigin.PROVIDER \| NETWORK`, `failure_is_infrastructure: true` |
| `AttemptOutcome.HARNESS_FAILURE` | `FailureOrigin.HARNESS \| TEST \| JUDGE` |
| `FailureOrigin` | `FailureOrigin`, adopted verbatim |
| `failureReasonCode` | `FailureReasonCode`, carried through uninterpreted |
| `attempt.score` | `score.total`, normalised to 0..1 |
| `tokens.promptTokens/completionTokens` | `usage.tokens_in/tokens_out` |
| `timings.wallTimeMs` | `verification_results.efficiency.time_sec × 1000` |
| `knownFailureModes` | `diagnosis.failure_mode`, `hard_fail_modes` |
| `provenance.luakBundleIds/Hashes` | `bundle_id`, `bundle_hash` |
| `provenance.luakSignatureStatus` | `BundleSignatureStatus` |
| `provenance.luakRepoCommit` | `environment.repo_commit` |

`AttemptOutcome.PARTIAL` has no single Luak source; the `*_evaluation.category`
enums carry a `PARTIAL` value, so it is derivable per family but not uniformly.

---

## Part 4 — A narrow Phase 2B proposal

Scoped to close the blocking gaps and nothing else. Each item is small, and
each is on the Luak side except where noted.

**2B.1 — Local-artifact identity in the evidence bundle.** Add an optional
`agent.local_artifact { digest, quantization, size_bytes }` and
`environment.runtime { name, build, binary_digest }` to
`evidence_bundle.schema.json`. Optional keeps every existing hosted-provider
bundle valid. Populated by the local adapter only. *Closes gaps 1–3.*

**2B.2 — Hardware profile.** Add optional `environment.hardware { profile_id,
gpu_model, gpu_memory_mib, driver, cuda, cpu_model, system_memory_mib,
partial_offload }`. `profile_id` is operator-assigned and opaque. *Closes gap 4.*

**2B.3 — Two task families with deterministic oracles.** Add
`test_log_triage` and `repo_reconnaissance` to `CanonicalTaskFamily` and to the
`task_manifest` `family` enum, with fixtures under `tasks/` and hashed oracles
under `oracles/`. The scorer is deterministic and citation-based — it checks
that every cited span exists in the supplied input and that quoted text appears
where it is claimed to. Bokahli's `@bokahli/tasks` validators are exactly that
check and can be lifted directly. **Fixtures must be authored, not generated
from model output**, or the suite measures agreement with a model rather than
correctness. *Closes gap 5, and 11.*

**2B.4 — Suite and regime versioning.** Add `version` to `SuiteManifest` and a
`verification_regime_version` constant bumped whenever scoring changes.
*Closes gaps 6–7.*

**2B.5 — Streaming timings for the local adapter.** Record TTFT, prefill and
decode rates and the context tier the run used. llama.cpp already returns all of
these in its `timings` block; Bokahli logs them per request today. *Closes gaps
8–10.*

**2B.6 — An export command.** `luak export-qualification --model … --task-class
… --suite …` emitting the Bokahli bundle format with canonical hashing.
Bokahli-side: nothing new — the importer already exists and is tested.
*Closes gap 12.*

**2B.7 — Then, and only then, an empirical qualification run.** Once 2B.1–2B.6
exist, run the two suites against the installed Q2_K artifact on Mushin, import
the result, and let the operator choose thresholds **from the observed
distribution**. Not before: any threshold picked now would be a number with
nothing behind it.

Deliberately out of scope for 2B: asymmetric signing (worth doing, larger than
this), further task classes, Bokahli-side shell or filesystem access, and any
change to Bokahli's routing modes.

Until 2B.7 completes, the installed artifact remains `INSTALLED_UNQUALIFIED` and
every qualification-required request escalates. That is not a limitation to work
around; it is the system reporting its actual state.
