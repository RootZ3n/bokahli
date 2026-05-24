# Aedis Dogfood Protocol

## Purpose

Scintilla is the controlled target project for testing whether Aedis can actually build software under constraints.

The point is not for Aedis to claim that a task is done. The point is for Aedis to produce scoped candidate outputs and changes that Scintilla can validate, evaluate, and reject when they are wrong. Scintilla should become a proving ground for Aedis build capability, not a stage for self-certification.

## Core Doctrine

- Aedis must not self-certify success.
- Scintilla validators and verifiers decide whether a candidate passes.
- Candidate JSON is the handoff object between generation and verification.
- TaskContract defines scope, allowed files, forbidden files, and verification requirements.
- Ariadne context packets define what the worker sees.
- Validation and evaluation happen after generation.
- Receipts and structured results beat claims.

## Dogfood Loop

The intended loop is:

1. A human defines or approves a TaskContract.
2. Ariadne builds a context packet from the repo and contract.
3. Aedis proposes an implementation or candidate.
4. The candidate is validated for shape, path safety, and supported benchmark IDs.
5. The candidate is evaluated against a deterministic benchmark or verifier where applicable.
6. Aedis receives the structured result.
7. If the result failed, Aedis repairs the candidate or explains the failure honestly.
8. No success is accepted without verifier evidence.

## Early Dogfood Milestones

Stage 0: deterministic mock pipeline only.

Stage 1: Aedis reads a TaskContract and Ariadne context packet, then proposes a candidate manually or under human supervision.

Stage 2: Aedis edits Scintilla in a sandbox branch or worktree.

Stage 3: Aedis runs validation and evaluation commands.

Stage 4: Aedis produces receipts and enters a repair loop when validation or verification fails.

Stage 5: Aedis handles a real Scintilla feature end to end.

## First Aedis Dogfood Target

The first target should be deliberately small. Good candidates include:

- add a second TaskContract example for `config_single_file_edit`
- add a mock-pipeline failed result fixture
- add a simple CLI list command
- add a small verifier test case

The first target must:

- be small
- be single-purpose
- avoid broad refactors
- have clear tests
- have deterministic validation
- avoid real model calls

## Required Safeguards

- Work only in a branch or sandbox worktree.
- Do not edit `main` directly.
- Do not make broad file changes.
- Do not churn packages or dependencies without explicit permission.
- Do not generate success claims without test output.
- Do not modify tests to make failures disappear.
- Do not touch CI unless the task requires it.
- Do not include secrets in candidates, examples, manifests, receipts, or logs.

## Success Criteria

A dogfood task is successful only when:

- required tests pass
- candidate scope is respected
- changed files match the TaskContract
- unrelated edits are absent
- validation and evaluation output is archived or summarized as a receipt
- Aedis explains failures honestly when they occur

## Non-Goals

This protocol does not yet prove:

- Aedis is autonomous
- local models are good enough
- real repo editing is safe
- Scintilla can replace human review
- benchmark pass equals production readiness

## Commands

Useful current commands:

```sh
pnpm benchmarks:list
pnpm contracts:list
pnpm ariadne:packet -- --repo tests/fixtures/simple-ts-repo --contract examples/contracts/readme_patch_one_file.contract.json --json
pnpm mock-pipeline:run -- --contract examples/contracts/readme_patch_one_file.contract.json --context-packet examples/context-packets/readme_patch_one_file.packet.json --scenario valid_docs_single_file_edit --benchmark docs_single_file_edit --json
pnpm candidates:validate -- --candidate examples/candidates/docs_single_file_edit.pass.json --benchmark docs_single_file_edit
pnpm candidates:evaluate -- --candidate examples/candidates/docs_single_file_edit.pass.json --benchmark docs_single_file_edit
pnpm benchmark:release-smoke
```

## Next Implementation Recommendation

The first dogfood-friendly Scintilla task should be:

1. Add `examples/contracts/config_patch_one_file.contract.json`.
2. Add the matching `examples/contracts/manifest.json` entry.
3. Add tests proving the contract validates and appears in `pnpm contracts:list`.

This task is small, deterministic, single-purpose, and avoids real model calls while exercising the TaskContract, manifest, and read-only discovery path.
