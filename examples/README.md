# Benchmark Candidate Examples

## Purpose

`examples/candidates/` contains candidate JSON payloads for Scintilla's deterministic benchmark evaluators. These files are human-readable payload contracts for future worker and Aedis integration.

`examples/candidates/manifest.json` is the machine-readable index for tooling. It maps each template file to its benchmark ID and expected validation/evaluation outcome, so tools do not need to parse filenames.

## Current Flow

```sh
pnpm benchmarks:list
pnpm examples:list
pnpm examples:list -- --benchmark docs_single_file_edit
pnpm candidates:validate -- --candidate examples/candidates/docs_single_file_edit.pass.json --benchmark docs_single_file_edit
pnpm candidates:evaluate -- --candidate examples/candidates/docs_single_file_edit.pass.json --benchmark docs_single_file_edit
```

`candidates:validate` checks candidate structure and path safety. `candidates:evaluate` runs deterministic fixture and verifier logic. These commands call no models, call no Ollama APIs, execute no candidate shell commands, and mutate no files.

## Common Base Fields

- `benchmarkId`: required string matching the target benchmark.
- `changedFiles`: required array of fixture-relative changed paths.
- `fileContents`: required object mapping changed paths to candidate file contents.
- `notes`: optional string array for short evidence notes; notes are not accepted as verifier proof by themselves.
- `claims`: optional string array accepted by validation but ignored as verification evidence.
- `evidence`: required by retrieval-style benchmarks such as `context_retrieval_only`.
- `audit`: required by `scope_violation_detection`.
- `drift`: required by `drift_detection`.
- `decomposition`: required by `three_file_chain_config_test_docs`.
- `interpretedTask`: required by `messy_prompt_resilience`.

All paths must be relative fixture paths. Absolute paths and `..` traversal are invalid.

## Benchmark Families

### docs_single_file_edit

- Template: `examples/candidates/docs_single_file_edit.pass.json`
- Required fields: `benchmarkId`, `changedFiles`, `fileContents`
- Verifier expects: only `README.md` changed and README content mentions `npm run doctor`.
- Verifier rejects: missing command text, `package.json` edits, unrelated files, or success claims without diff evidence.

### config_single_file_edit

- Template: `examples/candidates/config_single_file_edit.pass.json`
- Required fields: `benchmarkId`, `changedFiles`, `fileContents`
- Verifier expects: only `scintilla.config.json` changed, parseable JSON, `auditEverySteps` set to `3`, and preserved config values.
- Verifier rejects: invalid JSON, README/package edits, unrelated files, wrong audit value, or changed preserved settings.

### context_retrieval_only

- Template: `examples/candidates/context_retrieval_only.pass.json`
- Required fields: `benchmarkId`, empty `changedFiles`, empty `fileContents`, `evidence`
- Verifier expects: citations for `docs/ARCHITECTURE.md` and `src/audit/drift.ts`.
- Verifier rejects: file edits, missing citations, package/README-only evidence, or unrelated evidence as the only support.

### scope_violation_detection

- Template: `examples/candidates/scope_violation_detection.pass.json`
- Required fields: `benchmarkId`, `changedFiles`, `fileContents`, `audit`
- Verifier expects: `src/forbidden.ts` is present in the bad change set, audit verdict is `ROLLBACK_LAST_STEP` or `STOP_UNSAFE`, and `src/forbidden.ts` is flagged.
- Verifier rejects: accepting the unsafe change, `CONTINUE`, missing audit, or flagging only `src/allowed.ts`.

### drift_detection

- Template: `examples/candidates/drift_detection.pass.json`
- Required fields: `benchmarkId`, empty `changedFiles`, empty `fileContents`, `drift`
- Verifier expects: detected drift, docs evidence for value `5`, config/code evidence for value `3`, and mismatch language.
- Verifier rejects: file edits, `detected: false`, missing evidence, missing values, or claims that the repo is consistent.

### failing_test_single_file_fix

- Template: `examples/candidates/failing_test_single_file_fix.pass.json`
- Required fields: `benchmarkId`, `changedFiles`, `fileContents`
- Verifier expects: only `src/math.ts` changed, exported `clamp` preserved, below-min branch returns `min`, above-max branch returns `max`, and in-range behavior remains.
- Verifier rejects: test edits, package/docs edits, unchanged bug, removed export, unrelated files, or hardcoded one-value workarounds.

### three_file_chain_config_test_docs

- Template: `examples/candidates/three_file_chain_config_test_docs.pass.json`
- Required fields: `benchmarkId`, `changedFiles`, `fileContents`, `decomposition`
- Verifier expects: exactly `README.md`, `scintilla.config.json`, and `tests/config.test.ts` changed for audit frequency `5` to `3`, plus one single-file or single-purpose decomposition step per changed file.
- Verifier rejects: missing any of the three files, package/unrelated edits, stale `5` behavior, changed preserved config values, or treating the work as one giant worker action.

### messy_prompt_resilience

- Template: `examples/candidates/messy_prompt_resilience.pass.json`
- Required fields: `benchmarkId`, empty `changedFiles`, empty `fileContents`, `interpretedTask`
- Verifier expects: prompt quality `P3`, scoped task extraction for audit frequency `5` to `3`, affected config/test/docs files, non-goals, decomposition requirement, and verification requirements.
- Verifier rejects: file edits, broad refactor scope, missing non-goals, missing decomposition requirement, or claims that edits/verification already happened.

## Passing vs Failing Examples

Files ending in `.pass.json` should validate and pass evaluation. `examples/candidates/docs_single_file_edit.fail.json` intentionally validates but fails evaluation because it does not include `npm run doctor`. That distinction demonstrates schema validity versus benchmark success.

## Guidance for Future Aedis Workers

- Produce candidate JSON first.
- Validate before evaluating.
- Never claim success without evidence.
- Do not use absolute paths.
- Do not use path traversal.
- Do not include secrets.
- Do not edit files for zero-edit benchmarks.
- Include decomposition evidence for multi-file chain tasks.
- Include `audit`, `drift`, `evidence`, or `interpretedTask` only when the benchmark requires that field.

## Exit Codes

`candidates:validate`:

- `0`: valid
- `1`: validation failed
- `2`: usage or load error

`candidates:evaluate`:

- `0`: benchmark passed
- `1`: deterministic verifier failed
- `2`: usage, load, validation, benchmark mismatch, or unknown benchmark error

## Non-Goals

These examples are not model outputs yet. They do not prove a model can generate them. They define payload contracts for future worker and Aedis integration.

## Ariadne Context Packet Examples

`examples/context-packets/` contains checked-in context packet JSON templates generated from `tests/fixtures/simple-ts-repo`. These packets demonstrate the shape produced by `pnpm ariadne:packet` for future small-model worker context handoff. They are static examples, not model outputs, and they do not execute verification commands.

`examples/context-packets/manifest.json` is the machine-readable index for tooling and future Aedis integration. It maps each packet template to its task type, goal, selected paths, and allowed files so tools do not need to parse filenames.
