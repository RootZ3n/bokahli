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
| `messy_prompt_resilience` | no | `P4` | 1 | Extract a valid task from noisy or contradictory instructions. |

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

`config_single_file_edit` also has an executable fixture and verifier. The fixture requires a config-only update to `scintilla.config.json`: `auditEverySteps` must change from `5` to `3`, `allowMultiFileWorkerTasks` must remain `false`, and `defaultModelTier` must remain `tier_1`. The verifier rejects package or README edits, invalid JSON, unrelated files, wrong config values, and success claims without diff evidence. It is deterministic and makes no model calls.
