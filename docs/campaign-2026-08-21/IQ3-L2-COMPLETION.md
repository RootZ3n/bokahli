# Phase 2 — the IQ3 L2 constrained run, completed

## What "18/18 (partial)" meant

The declared design is 9 reconnaissance fixtures × 3 repeats = 27 attempts. The
constrained run recorded 18 and stopped:

    abortedReason: "attempt 18: /health/ready did not return 200"

The schedule is `[...fixtures] × repeats` flattened, so 18 attempts is exactly
repeats 1 and 2 complete and repeat 3 not started. **Nine attempts were missing,
one per fixture, all from the third repeat.** No fixture was partially covered
and no attempt was recorded twice.

The 18 that exist are intact: 18 records, 18 verbatim completions, every
`completion.sha256` resolving into the completions file, an identity that passes
`checkLocalIdentity`. The abort is Luak's per-attempt precondition doing its job
— it refused to continue against a deployment it could not confirm, and the
partial run was preserved rather than retried.

The cause was a ten-second `AbortSignal.timeout` in the precondition elapsing
against `/health/ready`, which performs a full attestation — `/props`, `/slots`,
`/v1/models`, instance and placement probes — on a runtime serving one request
at a time. Bokahli logged no warning or error in that window. It was a slow
answer recorded as a failed one.

## What was run

Only the nine missing attempts. Nothing that already existed was re-run.

The artifact was swapped in exclusively first: previous runtime stopped and
proven to have released device, port and process; `ESCALATE` with no fabricated
completion while no backend was resident; re-attested on load.

    served        qwen3.5-35b-a3b.iq3-xxs
    digest        sha256:c385920c6b956dc8c69...
    placement     ngl=999 n-cpu-moe=16 ctx=32768
    device        10118 MiB held
    canary        tokcanary.v1.gpt2-qwen35.c9a67aacc.tec568e238fc0 enc=true dec=true
    constrained   true (behavioural probe)
    affinity      39 threads, all on 0-7,10-23

## The completion describes the same thing as the original

Every identity field that could invalidate a comparison was checked field by
field against the original run's identity, not assumed from the profile name:

    artifact digest                 same
    quantization                    same
    runtime build                   same
    requested GPU layers            same
    CPU offload enabled             same
    GPU placement confirmed         same
    configured context              same
    generation regime               same
    output schema digest            same
    enforcement confirmed           same
    evidence policy digest          same
    verification regime version     same
    fixture suite version           same

Coverage after completion: **27 of 27 attempts, 9 fixtures, exactly 3 repeats
each, none over- or under-covered.**

Result of the nine: 9 of 9 valid structured output, 8 PARTIAL and 1 PASS, zero
injections followed.

## What was preserved

The two runs are kept as two files rather than merged into one. They are the
same regime version, the same artifact and the same profile, so they are
*poolable* — but merging them would destroy the record of which attempts came
from which execution, and the campaign's own rule is that evidence is preserved
as it was produced. Any consumer that wants the 27 reads both.

Nothing was retried, no attempt was replaced, and the original abort reason
stays on the original file.
