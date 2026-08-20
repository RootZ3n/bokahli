# Typed task classes

Phase 2A defines two, versioned independently of each other and of the
qualification bundle format. A task class is a pair of contracts — what a caller
may send, what a model must return — plus the rules that decide whether a
returned answer is *grounded*.

| Task class | Contract version | Output schema |
|---|---|---|
| `test_log_triage` | `1.0.0` | `1.0.0` |
| `repo_reconnaissance` | `1.0.0` | `1.0.0` |

The contract version is part of the qualification key. Changing either shape
invalidates every verdict earned under the old one, because evidence for
answering one question shape is not evidence for another.

## What "grounded" means

Both task classes enforce the same four checks, and only these four. They are
deliberately mechanical: whether an answer is *insightful* is not decidable, but
whether it points at text the caller actually sent is.

1. **Did the model cite anything?** A failure group, a relevant file, a symbol,
   an observed fact — each must carry at least one citation.
2. **Does the cited span exist?** Line ranges are 1-based and inclusive and must
   fall inside the supplied input. For `repo_reconnaissance`, the path must be in
   the evidence packet *and* inside the caller's `allowedPaths`.
3. **If the model quoted, is the quote there?** Checked by containment within the
   cited span, so citing a whole line for a phrase within it is fine, while text
   the model produced that is not in the input at all is not.
4. **Is observation separated from inference?** `ObservedFact` and `Inference`
   are different types with different fields. The same statement may not appear
   as both.

A result failing any of these is rejected. That is harsh on purpose: an
ungrounded triage is not a slightly worse triage, it is a fluent guess wearing
the shape of an answer, and the shape is what makes it dangerous.

## Outcomes

Three, and they are mutually exclusive:

- `ANSWERED` — findings, each grounded. No abstention, no escalation.
- `ABSTAINED` — the model declines, with a typed reason and what it *would* need.
  This is a correct answer of a kind, and scoring must be able to tell it apart
  from a wrong one. Abstaining without saying why is rejected.
- `ESCALATE` — the model declines for a structural reason: unsupported
  capability, input over budget, unsupported contract version, unhealthy runtime.

`ANSWERED` with no findings is rejected. A log with nothing wrong in it is an
abstention with reason `INSUFFICIENT_EVIDENCE`, not an empty answer.

## `test_log_triage`

**Input**: bounded log text (≤ 1 MiB, ≤ 20 000 lines — over the bound is refused,
never truncated), optional tool/command/exit-code metadata, the required output
schema version, and context/latency budgets.

**Output**: failure groups, each with a classification
(`ASSERTION_FAILURE`, `TIMEOUT`, `DEPENDENCY_OR_IMPORT_FAILURE`,
`FLAKE_OR_NONDETERMINISM`, `INFRASTRUCTURE`, …), citations into the log, observed
facts, an optional probable cause carried as an `Inference`, an optional
suggested next diagnostic action with its rationale, affected test names,
confidence or `null`, and a coverage report saying what was not considered.

`probableCause` may be `null`. Declining to guess at a cause while reporting what
the log says is a valid, and often the correct, answer.

## `repo_reconnaissance`

**Bokahli gains no filesystem, shell, or repository access in this phase, and
none is planned in it.** The task operates on a `RepoEvidencePacket` the caller
assembles and sends: files, line-numbered excerpts, an explicit `allowedPaths`
allowlist, and a record of what was deliberately withheld. Bokahli reads what it
is given and nothing else. A citation to a real file that was not supplied is as
invalid as a citation to a file that does not exist.

The allowlist matches whole path segments, never raw prefixes: `src` admits
`src/auth.ts` and rejects `srcret/secrets.ts`. Absolute paths and `..` segments
are rejected outright.

**Output**: relevant files and symbols with citations, relationship findings
(`imports`, `calls`, `implements`, …) each marked `OBSERVED` or `INFERRED` — an
`OBSERVED` relationship with no citation is rejected, since if it was observed
the text showing it can be named — observed facts and inferences in separate
fields, and a coverage report naming both what was examined and what relevant
context the model believes it was *not* given.

## Where these are not yet used

Nothing routes on these contracts today. There are no Luak fixtures for either
task class, so no evidence exists, so no artifact is qualified for either, so
every qualification-required request escalates. Phase 2A ships the boundary and
the shapes; measuring anything against them is Phase 2B.

See `LUAK-BOUNDARY.md` for what Luak would need to add to produce that evidence.
