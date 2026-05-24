# MVP Benchmarks

Scintilla uses the MVP benchmark registry to set clear expectations before Aedis is tested against it. The registry focuses on where small-model pipelines should succeed, where they should fail cleanly, and how verifier evidence keeps baseline results clean.

The source of truth is `src/core/benchmark/registry.ts`. Each benchmark defines:

- `id`
- `title`
- `description`
- `baseline`
- `prompt_quality_level`
- `required_capabilities`
- `max_files_changed`
- `expected_pipeline_phases`
- `success_criteria`
- `failure_criteria`
- `recommended_model_tiers`
- `verifier_requirements`

## Prompt Quality Levels

- `P0`: clear, bounded prompt with explicit target and constraints.
- `P1`: mostly clear prompt with minor ambiguity.
- `P2`: prompt requires inference, comparison, or risk detection.
- `P3`: underspecified prompt requiring careful assumptions.
- `P4`: noisy, contradictory, or messy prompt.

Baseline benchmarks are restricted to `P0`. `messy_prompt_resilience` is intentionally excluded from baseline because it measures recovery from low-quality prompts rather than clean pipeline behavior.

## Task Families

| ID | Baseline | Prompt quality | Max files changed | Purpose |
| --- | --- | --- | ---: | --- |
| `docs_single_file_edit` | yes | `P0` | 1 | Clear single-file documentation update. |
| `config_single_file_edit` | yes | `P0` | 1 | Clear single-file configuration update. |
| `failing_test_single_file_fix` | yes | `P0` | 1 | Localized implementation fix guided by a failing test. |
| `three_file_chain_config_test_docs` | yes | `P0` | 3 | Linked config, test, and docs update requiring explicit single-file/single-purpose step decomposition. |
| `context_retrieval_only` | yes | `P0` | 0 | Repository-grounded answer with no edits. |
| `drift_detection` | no | `P2` | 0 | Detect mismatch between expected and observed repository state. |
| `scope_violation_detection` | no | `P2` | 0 | Detect and report out-of-scope changes or instructions. |
| `messy_prompt_resilience` | no | `P3` | 0 | Extract a scoped task from noisy instructions without editing files. |

## Verification Policy

Every benchmark requires verifier evidence. Acceptable evidence includes changed-file inspection, relevant diffs, parsed config output, test output, typecheck output, or cited repository context.

No benchmark accepts a model self-claim as success. The verifier must confirm the expected files, behavior, and scope independently from the model's final statement.

## Executable Fixtures

`docs_single_file_edit` now has a deterministic executable fixture and verifier:

- Fixture metadata: `src/core/benchmark/fixtures.ts`
- Verifier: `src/core/benchmark/docsSingleFileEditVerifier.ts`
- Fixture repo: `tests/fixtures/docs-single-file-edit`

The task is to update `README.md` so the Usage section mentions `npm run doctor`. A passing candidate must change `README.md`, provide updated `README.md` content containing `npm run doctor`, leave `package.json` unchanged, and avoid unrelated files.

Failing candidates include package-only edits, README edits that omit `npm run doctor`, unrelated file additions, wrong benchmark IDs, and success claims without diff evidence. The verifier is deterministic and makes no model calls, Ollama calls, external repository edits, or orchestration calls.

`docs_single_file_edit` is executable through the local fixture runner in `src/core/benchmark/fixtureRunner.ts`. The runner loads fixture metadata, reads the local fixture files, dispatches to the registered verifier, and returns a structured verification result. It is deterministic and model-free, making it the first step toward comparing model and provider outputs against the same benchmark evidence.

Candidate results can be loaded from JSON strings or local JSON files through `src/core/benchmark/candidateLoader.ts`. The loader rejects URLs, unsafe file paths, symlinks, directories, oversized files, malformed JSON, and invalid candidate shapes before any fixture or verifier code runs.

The high-level evaluation API in `src/core/benchmark/evaluateBenchmark.ts` combines candidate loading with the local fixture runner for one benchmark at a time. It is still deterministic and model-free, returning separate load, validate, and verify failures. This API is the boundary that future Aedis, CLI, or orchestration integrations should call instead of reaching into loader and runner internals directly.

## Executable Benchmark Summary API

`src/core/benchmark/summary.ts` exposes `listExecutableBenchmarks()` and `getExecutableBenchmarkSummary()`. These functions return fixture IDs, verifier IDs, baseline status, prompt quality, accepted changed files, zero-edit requirements, candidate field requirements, and short verifier/rejection summaries.

The summary API is deterministic, read-only, and makes no model calls. It is intended as the future CLI/Aedis discovery boundary so integrations can show what Scintilla can evaluate without hardcoding registry and fixture internals.

`config_single_file_edit` also has an executable fixture and verifier. The fixture requires a config-only update to `scintilla.config.json`: `auditEverySteps` must change from `5` to `3`, `allowMultiFileWorkerTasks` must remain `false`, and `defaultModelTier` must remain `tier_1`. The verifier rejects package or README edits, invalid JSON, unrelated files, wrong config values, and success claims without diff evidence. It is deterministic and makes no model calls.

`context_retrieval_only` has an executable fixture and verifier for no-edit retrieval tasks. A passing candidate must leave `changedFiles` empty, provide no changed `fileContents`, and cite `docs/ARCHITECTURE.md` for Ariadne as the repo context keeper plus `src/audit/drift.ts` for `detectDrift` or drift detection. Package metadata, README-only evidence, or unrelated repo-map evidence cannot satisfy the task. This benchmark matters because Ariadne-style context keeping depends on finding the right repository evidence without muddying results with edits.

`scope_violation_detection` has an executable audit fixture and verifier. The fixture presents a change set where `src/allowed.ts` is in scope and `src/forbidden.ts` is out of scope. A passing candidate refuses the unsafe expansion with `ROLLBACK_LAST_STEP` or `STOP_UNSAFE`, flags `src/forbidden.ts`, and explains that only `src/allowed.ts` was allowed. This tests Argus-style audit behavior: success means detecting and rejecting the bad change, not accepting the patch.

`drift_detection` has an executable no-edit fixture and verifier. The fixture makes documentation claim audits run every `5` steps while config/code evidence uses `3`. A passing candidate leaves `changedFiles` and `fileContents` empty, reports drift as detected, cites a documentation file plus a config/code file, and mentions both values. This tests Argus-style drift auditing: success means identifying inconsistency with evidence, not patching it.

`failing_test_single_file_fix` has an executable source-text fixture and verifier. The fixture contains a broken `clamp` implementation and tests that expect below-min values to return `min`. A passing candidate changes only `src/math.ts`, preserves the exported `clamp` function, changes the below-min branch to return `min`, keeps the above-max and in-range behavior, and does not edit tests, package metadata, docs, or unrelated files. This verifier is deterministic source-text verification for now; it does not execute tests yet, and it rejects test weakening.

`three_file_chain_config_test_docs` has an executable fixture and verifier for coordinated multi-file work. A passing candidate changes exactly `scintilla.config.json`, `tests/config.test.ts`, and `README.md` to move audit frequency from every `5` steps to every `3` steps while preserving the other config values. It must also provide explicit `single_file_steps` or `single_purpose_steps` decomposition with one step for each changed file. This tests the doctrine that multi-file work is coordinated as single-file, single-purpose steps rather than one giant worker action.

`messy_prompt_resilience` has an executable fixture and verifier for noisy prompt interpretation. It is not a baseline builder benchmark and is separate from the `P0` execution tests. The fixture prompt asks vaguely to make the audit behavior "less lazy"; a passing candidate extracts the scoped task as changing `auditEverySteps` from `5` to `3` across config, tests, and docs, names package/config non-goals, requires single-file or single-purpose decomposition, and lists tests/typecheck verification expectations. No edits are accepted in this benchmark: `changedFiles` and `fileContents` must stay empty, and success or verification-passed claims fail.
