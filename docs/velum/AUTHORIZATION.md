# Reuse and licensing authorization — A32 contract and Pike VM

## What was authorized

On 2026-08-20, after reviewing the V0 reconnaissance, the operator — who owns
both repositories — authorized:

- **reusing and porting** the A32 Velum contract and the Pike VM implementation
  from the private `RootZ3n/abaiya` repository;
- **publishing the derived work under the MIT licence** in the public
  `RootZ3n/velum` repository;
- **adapting it into TypeScript** while preserving semantics;
- **using ABAIYA's Rust implementation and its 38-fixture corpus as the
  conformance oracle**.

The authorization covers the operator's own source and contracts. Any
third-party notice discovered during the port is preserved rather than
absorbed.

## Why it is recorded here

The V0 report recommended reusing the A32 contract rather than reimplementing
its rules, and noted as a blocking unknown that `RootZ3n/abaiya` carries no
LICENCE file, leaving the Rust crate's terms unstated. That unknown is now
closed by decision rather than by inference, and closing it by decision is the
only way it could have been closed: the terms of unlicensed source are not
discoverable from the source.

This file exists so the provenance chain is legible from Bokahli, which is the
consumer, and not only from the repository that publishes the result.

## What it does not authorize

- It does not make ABAIYA public. The private repository stays private; only the
  derived TypeScript work is published.
- It does not license the *reference* implementations' regex bodies beyond the
  MIT terms they already carry. `velum-ai` 0.2.2 is MIT; A32's provenance record
  states `velum-ai` 0.3.0 (Python) is MIT.
- It does not authorize any Bokahli production change. Velum V1 establishes the
  canonical engine; integration is a later, separately reviewed phase.

## Attribution requirement

Ported material carries attribution in source comments and documentation to the
operator-owned ABAIYA implementation it derives from, naming the crate and the
commit it was ported at. A port that hides where its semantics came from cannot
be audited against the thing it claims to be faithful to.
