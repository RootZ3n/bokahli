# Deterministic Benchmark Release Checklist

## Scope

This checklist covers Scintilla's deterministic benchmark plumbing, Ariadne read-only context tooling, contract template discovery, mock-worker generated-candidate validation, direct mock-pipeline checks, and mock-pipeline result fixture discovery:

- benchmark registry
- local fixtures
- deterministic verifiers
- candidate validation and loading
- evaluation API
- CLI listing, validation, evaluation, and examples commands
- example candidate manifest
- Ariadne repo scan, context packet, and context packet example listing commands
- TaskContract examples, manifest listing commands, and contract-mode Ariadne packet checks
- mock-worker candidate generation, generated candidate validation, and generated candidate evaluation
- direct mock-pipeline CLI pass, refusal, and invalid-schema candidate behavior
- mock-pipeline result fixture manifest listing and filters

It does not certify real model calls, Ollama integration, model quality, production orchestration, Aedis integration, or real repository editing.

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
pnpm ariadne:scan -- --repo tests/fixtures/simple-ts-repo
pnpm ariadne:scan -- --repo tests/fixtures/simple-ts-repo --json
pnpm ariadne:packet -- --repo tests/fixtures/simple-ts-repo --task-type patch_one_file --goal "Update README usage text" --allowed-file README.md --select README.md --verification "pnpm test" --json
pnpm context-packets:list
pnpm context-packets:list -- --json
pnpm context-packets:list -- --id readme_patch_one_file
pnpm contracts:list
pnpm contracts:list -- --json
pnpm contracts:list -- --id readme_patch_one_file
pnpm ariadne:packet -- --repo tests/fixtures/simple-ts-repo --contract examples/contracts/readme_patch_one_file.contract.json --json
pnpm mock-pipeline:run -- --contract examples/contracts/readme_patch_one_file.contract.json --context-packet examples/context-packets/readme_patch_one_file.packet.json --scenario valid_docs_single_file_edit --benchmark docs_single_file_edit --json
pnpm mock-pipeline:run -- --contract examples/contracts/readme_patch_one_file.contract.json --context-packet examples/context-packets/readme_patch_one_file.packet.json --scenario refusal_uncertain --benchmark docs_single_file_edit --json
pnpm mock-pipeline:run -- --contract examples/contracts/readme_patch_one_file.contract.json --context-packet examples/context-packets/readme_patch_one_file.packet.json --scenario invalid_schema --benchmark docs_single_file_edit --json
pnpm mock-pipeline-results:list
pnpm mock-pipeline-results:list -- --json
pnpm mock-pipeline-results:list -- --benchmark docs_single_file_edit
pnpm mock-pipeline-results:list -- --status passed
pnpm mock-pipeline-results:list -- --id docs_single_file_edit.passed
pnpm --silent mock-worker:run -- --contract examples/contracts/readme_patch_one_file.contract.json --context-packet examples/context-packets/readme_patch_one_file.packet.json --scenario valid_docs_single_file_edit --candidate-only
pnpm candidates:validate -- --candidate <generated mock-worker candidate JSON> --benchmark docs_single_file_edit
pnpm candidates:evaluate -- --candidate <generated mock-worker candidate JSON> --benchmark docs_single_file_edit
```

The `docs_single_file_edit.fail.json` evaluation command is expected to exit `1` because it has a valid candidate shape but fails deterministic verification.

The smoke script captures mock-worker candidate JSON with `pnpm --silent` so pnpm lifecycle text cannot contaminate the generated candidate file. It writes the captured JSON to a temporary file, validates it, evaluates it, and then removes the temp file. This path remains deterministic and model-free.

The smoke script also runs `mock-pipeline:run` directly. The successful docs scenario must exit `0`; the refusal and invalid-schema scenarios must exit `1`, and those expected failures count as passing smoke checks because they verify structured refusal and candidate-invalid behavior.

The smoke script also lists mock-pipeline result fixtures through `mock-pipeline-results:list` in human, JSON, benchmark-filtered, status-filtered, and id-filtered modes. This covers result fixture discovery without running the mock pipeline.

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

`mock-pipeline-results:list`:

- `0`: success
- `1`: filter returned no entries
- `2`: usage, load, or malformed manifest error

## CI/Scrapeable Status Convention

In normal text mode, `pnpm benchmark:release-smoke` prints exactly one final status line:

```txt
SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY
```

The status variable and `BENCHMARK_PLUMBING_READY` wording remain unchanged for compatibility, even though the smoke script now also covers Ariadne read-only context tooling, contract template discovery, mock-worker generated-candidate validation/evaluation, direct mock-pipeline CLI checks, and mock-pipeline result fixture discovery.

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

The `Benchmark Release Smoke` GitHub Actions workflow runs deterministic benchmark plumbing, Ariadne read-only context tooling, contract template discovery, the mock-worker generated-candidate validation/evaluation chain, direct mock-pipeline pass/refusal/invalid-schema checks, and mock-pipeline result fixture discovery. It installs dependencies, runs `pnpm benchmark:release-smoke`, asserts the stable `SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY` line, writes `benchmark-release-smoke.json`, and archives the smoke reports as the stable `benchmark-release-smoke` artifact.

The artifact includes both:

- `benchmark-release-smoke.txt`
- `benchmark-release-smoke.json`

The archived reports cover deterministic benchmark plumbing, candidate examples and manifests, Ariadne read-only scan, packet, and context-packet template tooling, TaskContract template discovery, contract-mode Ariadne packet generation, mock-worker candidate generation, generated candidate validation, generated candidate evaluation, direct mock-pipeline pass/refusal/invalid-schema checks, and mock-pipeline result fixture discovery.

The workflow does not add real model calls, Ollama setup, provider secrets, model quality certification, production orchestration, Aedis integration, benchmark generation, or real repository editing. Ariadne, contract, mock-worker, and mock-pipeline checks are deterministic read-only tooling checks only.

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
