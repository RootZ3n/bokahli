# Scintilla Project Status

## Current Status

Scintilla is experimental. It has deterministic benchmark, context, contract, mock-worker, and mock-pipeline plumbing, but it does not call real models yet.

Current non-goals remain:

- no real model calls
- no Ollama integration
- no orchestration or Aedis integration
- no real repository editing

The deterministic benchmark release smoke now checks the benchmark/context/contract/mock-worker path end to end without leaving the deterministic test-double layer. The in-memory mock pipeline API composes the same deterministic path for tests and future tooling.

## What The Smoke Certifies

`pnpm benchmark:release-smoke` currently certifies that these deterministic paths are healthy:

- executable benchmark registry and verifiers
- candidate validation and evaluation
- candidate examples and manifest
- context packet examples and manifest
- Ariadne read-only scan and packet tooling
- TaskContract template discovery
- contract-mode packet generation
- mock-worker generated candidate output
- generated candidate validation
- generated candidate evaluation
- direct mock-pipeline pass/refusal/invalid-schema CLI coverage
- in-memory mock pipeline stage separation

The mock-worker path proves this deterministic chain:

```txt
TaskContract + ContextPacket + scenario
-> mock worker candidate JSON
-> candidate validation
-> benchmark evaluation
```

The mock pipeline API exposes that chain as a structured in-memory result without shelling out or writing files.

The smoke also exercises `mock-pipeline:run` directly for the passing docs scenario, a structured refusal scenario, and an invalid-schema candidate scenario.

## What The Smoke Does Not Certify

The smoke does not certify:

- real small-model quality
- real model generation
- Ollama or local model calls
- cloud provider calls
- production orchestration
- Aedis integration
- real repository editing
- candidate code execution

## Stable Smoke Outputs

The stable text status line remains:

```txt
SCINTILLA_BENCHMARK_PLUMBING_STATUS=BENCHMARK_PLUMBING_READY
```

The GitHub Actions artifact name remains:

```txt
benchmark-release-smoke
```

The artifact contains:

- `benchmark-release-smoke.txt`
- `benchmark-release-smoke.json`

JSON mode reports:

```json
{
  "status": "BENCHMARK_PLUMBING_READY"
}
```

## Recommended Verification

Run the text smoke locally:

```sh
pnpm benchmark:release-smoke
```

Run the machine-readable smoke locally:

```sh
pnpm benchmark:release-smoke -- --json
```

## Next Development Milestone

The next milestone is a deterministic orchestration-shaped dry run:

```txt
contract + context packet + scenario
-> mock pipeline runner
-> candidate validation
-> benchmark evaluation
-> structured result
```

This should still use no real models, no Ollama calls, no production orchestration, and no Aedis integration.
