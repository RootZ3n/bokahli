# Scintilla

Deterministic benchmark plumbing for evaluating candidate JSON outputs against executable benchmark fixtures.

## Quickstart: deterministic benchmark flow

Install dependencies and build the CLI:

```sh
pnpm install
pnpm build
```

List executable benchmarks:

```sh
pnpm benchmarks:list
pnpm benchmarks:list -- --json
```

Validate a candidate JSON file:

```sh
pnpm candidates:validate -- --candidate tests/fixtures/candidate-cli/valid-docs-candidate.json --benchmark docs_single_file_edit
pnpm candidates:validate -- --candidate tests/fixtures/candidate-cli/valid-docs-candidate.json --benchmark docs_single_file_edit --json
```

Evaluate a candidate JSON file:

```sh
pnpm candidates:evaluate -- --candidate tests/fixtures/candidate-cli/valid-docs-candidate.json --benchmark docs_single_file_edit
pnpm candidates:evaluate -- --candidate tests/fixtures/candidate-cli/valid-docs-candidate.json --benchmark docs_single_file_edit --json
```

`candidates:validate` exits `0` for valid candidates, `1` for validation failures, and `2` for usage or load errors.

`candidates:evaluate` exits `0` when the benchmark passes, `1` when benchmark verification fails, and `2` for usage, load, validation, unknown benchmark, or benchmark mismatch failures.

These commands make no model calls, no Ollama calls, perform no candidate shell execution, and mutate no files. They are deterministic benchmark plumbing. Future Aedis/worker integration should produce candidate JSON and run this validation/evaluation flow.

Before claiming the deterministic benchmark plumbing is healthy, use `docs/DETERMINISTIC_BENCHMARK_RELEASE_CHECKLIST.md`.

## Example candidate files

Passing candidate JSON templates for every executable benchmark live in `examples/candidates/`. Start with `examples/candidates/docs_single_file_edit.pass.json` for the simplest edit benchmark, or use the matching `<benchmarkId>.pass.json` file as the payload shape for a specific verifier. See `examples/README.md` for field shapes and benchmark-specific guidance.

## Ariadne repo scanner

`scanRepoContext(root)` provides Ariadne v0's read-only repository snapshot. It records package manager, package scripts, included source/config/docs file metadata, ignored directories, and scanner warnings without reading full file contents or mutating the scanned repository.
