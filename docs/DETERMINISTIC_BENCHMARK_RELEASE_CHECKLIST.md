# Deterministic Benchmark Release Checklist

## Scope

This checklist covers Scintilla's deterministic benchmark plumbing:

- benchmark registry
- local fixtures
- deterministic verifiers
- candidate validation and loading
- evaluation API
- CLI listing, validation, evaluation, and examples commands
- example candidate manifest

It does not certify local model generation, Ollama integration, orchestration, Aedis integration, or real repository editing.

## Required Commands

Run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

All three commands must pass before claiming deterministic benchmark plumbing is healthy.

To run the required commands and CLI smoke checks together, use:

```sh
pnpm benchmark:release-smoke
```

For machine-readable output, use:

```sh
pnpm benchmark:release-smoke -- --json
```

## CLI Smoke Commands

Run:

```sh
pnpm benchmarks:list
pnpm benchmarks:list -- --json
pnpm examples:list
pnpm examples:list -- --json
pnpm examples:list -- --benchmark docs_single_file_edit
pnpm candidates:validate -- --candidate examples/candidates/docs_single_file_edit.pass.json --benchmark docs_single_file_edit
pnpm candidates:evaluate -- --candidate examples/candidates/docs_single_file_edit.pass.json --benchmark docs_single_file_edit
pnpm candidates:evaluate -- --candidate examples/candidates/docs_single_file_edit.fail.json --benchmark docs_single_file_edit
```

The final command is expected to exit `1` because `docs_single_file_edit.fail.json` has a valid candidate shape but fails deterministic verification.

## Expected Exit Codes

`benchmarks:list`:

- `0`: success
- `2`: usage error

`examples:list`:

- `0`: success
- `1`: no matches
- `2`: usage, load, or malformed manifest error

`candidates:validate`:

- `0`: valid
- `1`: validation failed
- `2`: usage or load error

`candidates:evaluate`:

- `0`: benchmark passed
- `1`: benchmark verification failed
- `2`: usage, load, validation, unknown benchmark, or benchmark mismatch failure

## CI/Scrapeable Status Convention

In normal text mode, `pnpm benchmark:release-smoke` prints exactly one final status line:

```txt
SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY
```

On deterministic smoke failure, the final line is:

```txt
SCINTILLA_BENCHMARK_PLUMBING_STATUS=NOT_READY
```

`BLOCKED` is reserved for future environment or sandbox blockage classification:

```txt
SCINTILLA_BENCHMARK_PLUMBING_STATUS=BLOCKED
```

The smoke output also includes:

```txt
SCINTILLA_BENCHMARK_PLUMBING_CHECKS_TOTAL=<number>
SCINTILLA_BENCHMARK_PLUMBING_CHECKS_PASSED=<number>
SCINTILLA_BENCHMARK_PLUMBING_CHECKS_FAILED=<number>
```

The status line is the last non-empty line in normal text mode:

```sh
pnpm benchmark:release-smoke | tail -1
```

In JSON mode, stdout is only JSON:

```sh
pnpm benchmark:release-smoke -- --json
```

## CI Workflow

The `Benchmark Release Smoke` GitHub Actions workflow runs deterministic benchmark plumbing only. It installs dependencies, runs `pnpm benchmark:release-smoke`, asserts the stable `SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY` line, writes `benchmark-release-smoke.json`, and archives the smoke reports as the `benchmark-release-smoke` artifact.

The workflow does not add model calls, Ollama setup, provider secrets, orchestration, benchmark generation, or real repository editing.

## Manifest Consistency Checks

Confirm:

- every executable benchmark has one `.pass.json` template
- `docs_single_file_edit.fail.json` validates but fails evaluation
- `examples/candidates/manifest.json` lists every example exactly once
- manifest `expectedValidation` and `expectedEvaluation` match actual CLI/API behavior
- no example contains obvious secret-like strings

These checks are covered by the test suite, but they should be reviewed when adding or removing examples.

## Benchmark Coverage Expectations

Executable benchmark families:

- `docs_single_file_edit`
- `config_single_file_edit`
- `context_retrieval_only`
- `scope_violation_detection`
- `drift_detection`
- `failing_test_single_file_fix`
- `three_file_chain_config_test_docs`
- `messy_prompt_resilience`

## Safety Expectations

The deterministic benchmark plumbing must preserve:

- no model calls
- no Ollama calls
- no network calls
- no candidate code execution
- no fixture mutation
- no shell execution by candidates
- deterministic source and JSON checks only

## Release Verdict Labels

- `BENCHMARK_PLUMBING_READY`: required commands and CLI smoke checks passed, manifest consistency is intact, and known non-goals are unchanged.
- `NOT_READY`: one or more required commands, smoke checks, manifest checks, or safety expectations failed.
- `BLOCKED`: verification cannot complete because required local state, dependencies, or access are unavailable.

## Manual Release Note Template

```md
Commit under test:

Commands run:

Test count:

CLI smoke results:

Known non-goals:
- local model generation
- Ollama integration
- orchestration
- Aedis integration
- real repo editing

Verdict:
```
