# Velum V0 — reconnaissance and contract design

Bokahli needs Velum's prompt-injection defence. It does not need Velum's
privacy-redaction system, because inference is local: there is no third party to
withhold data from, and a redactor between a local caller and a local model
removes evidence from the only place it was ever going.

This document reports what actually exists, what is reusable, what is missing,
and what Bokahli would have to build. It designs contracts and implements
nothing.

## 1. Canonical implementation

There are **three** Velum implementations and they are not equivalent. Naming
them precisely matters, because "Velum" in conversation has meant all three.

| Implementation | Location | Version | Language | Licence | Status |
|---|---|---|---|---|---|
| **velum-ai (TypeScript)** | `github.com/RootZ3n/velum` `master` `2ee3bfa`, tag `v0.2.2` | 0.2.2 | TypeScript, zero deps | MIT | public, released |
| **velum-python** | referenced, not located in this account | 0.3.0 | Python | MIT | not found under `RootZ3n`; known only through A32 provenance records |
| **abaiya-policy (Rust)** | `github.com/RootZ3n/abaiya` (private) `main` `a471252`, crate `abaiya-policy` | workspace member | Rust | no LICENSE file in repo | production-wired |

**The canonical detector for Bokahli's purposes is `abaiya-policy`.** It is the
only implementation that treats the detector vocabulary as a contract rather
than as an implementation detail, the only one with a frozen behavioural oracle,
and the only one whose matcher is not a regex engine with backtracking.

The A32 amendment (`abaiya-types/src/velum.rs`, `abaiya-contract/src/velum.rs`)
is the reusable part of the thinking, independent of the language it landed in.
Its central move is refusing to collapse four questions into one enum:

| Layer | Question | Type |
|---|---|---|
| A | what did the detector find? | `VelumFindingCategory` |
| B | what did policy decide? | `PolicyClassification` |
| C | how may content leave? | `ContentSecurityClass` |
| D | where is it going? | `ExportBoundary` |

Bokahli needs exactly that separation and for the same reason: a finding is
evidence, a decision is a decision, and a qualification verdict is Luak's.

## 2. What is real, partial, scaffolded, absent

**Real, and production-wired.** `abaiya-policy` is ~4,600 lines of Rust with
~1,400 lines of tests. `abaiya/src/composition.rs` constructs `VelumPolicy` and
`FenceNeutralizer` behind `PolicyPort`; `abaiya-core`, `abaiya-provider` and
`abaiya-dossier` depend on it. This is not a fixture-only shelf.

- `matcher.rs` (1,061 lines) — a hand-written **Pike VM**. The pattern compiles
  to an NFA program and executes without backtracking, so pattern matching is
  linear in input length and ReDoS is structurally impossible rather than
  mitigated. It produces `Match { start, end }`.
- `patterns.rs` (523 lines) — the pattern catalogue **with regex bodies**. The
  A32 fixture registry deliberately does not port regexes ("A32 fixes identity,
  category, and severity only"), but the Rust crate carries its own.
- `detect.rs`, `engine.rs`, `rules.rs`, `port.rs` — detection, policy resolution,
  export evaluation, promotion clearance.
- `normalize.rs` — three normative stages: zero-width removal, leetspeak folding,
  base64 segment decoding.
- `fence.rs` (587 lines) — fence-marker neutralization.
- `pii.rs`, `transform.rs`, `outbound.rs` — the privacy half. **Excluded**; see §4.

**Real, and public.** velum-ai 0.2.2: a three-stage guard (`input` / `context` /
`output`) with decisions `allow | warn | review | block`, plus `classify`,
`patterns`, `pii`, `credential-buffer`, `receipts`, `tool-guard`, and
Express/Fastify/generic adapters. Its `Stage.OUTPUT` is the nearest existing
thing to Bokahli's "output inspection" step, and its stage model is worth
copying even though its implementation is not the one to reuse.

**The 38 fixtures.** `abaiya-contract/fixtures/velum-conformance-mvp-1.json`,
corpus `abaiya-velum-mvp-1`, detector contract `1.0.0`. Composition by expected
primary category:

| safe | credential | boundary-probe | instruction-override | prompt-injection | memory-manipulation |
|---|---|---|---|---|---|
| 15 | 8 | 5 | 5 | 3 | 2 |

By id prefix: `pii` 7, `cred` 6, `probe` 5, `override` 4, `safe` 3, `inj` 3,
`memory` 3, `mixed` 2, `fp` 2, `tie` 1, `encoded` 1, `nested` 1.

**A correction worth making explicitly.** "38/38" is the *corpus size*, not a
reference pass rate. The corpus itself records that **TypeScript v0.2.2 fails 1
fixture (`override-003`) and Python v0.3.0 fails 15**. `abaiya-policy/tests/
conformance.rs` asserts the Rust detector passes all 38 on the complete finding
set, the derived primary category, and the PII detections, and separately
asserts that it disagrees with the references on exactly the recorded cases.

**I could not execute that test.** There is no Rust toolchain on this host and
installing one is outside the safety envelope for this task. The 38/38 claim for
the Rust implementation is therefore *asserted by a committed test I read but
did not run*. Verifying it is the first item of V1.

**Partial.** Encoded-instruction handling. The `base64_injection` pattern is
explicitly **deferred** (with `instruction_leak_indirect`, `prompt_leak_attempt`,
`role_override`, `system_message_*`) on the grounds that ARCH-003 §3.2 does not
enumerate a category for it and assigning one would be builder invention.
Encoded attacks are instead caught by *normalization* — base64 segments are
decoded and **appended**, then matched by the ordinary patterns. Fixture
`encoded-001` asserts `prompt-injection`. This works and it has an offset
consequence: see §7.

**Absent.** No detector distinguishes *indirect* injection (instructions inside
supplied evidence) from *direct* injection (instructions typed by the user).
Velum scans a string; who supplied the string is the caller's knowledge. That is
not a defect — it is precisely the boundary Bokahli must supply, and it is the
main reason this integration needs a Bokahli-side trust model rather than a
drop-in.

## 3. Reusable contracts, fixtures, components

Directly reusable as contract vocabulary:

- `VelumFindingCategory`: `safe | credential | prompt-injection |
  instruction-override | memory-manipulation | boundary-probe`.
- `VelumSeverity`: `warn | review | block`.
- `VelumFinding { pattern_id, category, severity }` and `VelumFindingSet` with a
  deterministic `selection_key` — canonical ordering, so two callers who found
  the same things in different orders produce byte-identical sets.
- The 45-pattern registry (24 injection-family, 21 credential) by identity,
  category and severity.
- The 38-fixture corpus as a behavioural oracle.
- `PolicyClassification` × `TransformationDecision` × `ExportDecision`.
- `NeutralizeContext` / `NeutralizedContent` and the fence discipline of §7.

**Prefer Velum's vocabulary over the names proposed in the brief.** The brief
suggested `PROMPT_INJECTION_DETECTED`, `AUTHORITY_SPOOFING`,
`EXFILTRATION_ATTEMPT`, `TOOL_MANIPULATION`, `ENCODED_INSTRUCTION`. Velum's
existing six categories already cover these and are frozen against a corpus:

| Proposed | Velum canonical | Note |
|---|---|---|
| `PROMPT_INJECTION_DETECTED` | `prompt-injection` | patterns `ignore_instructions`, `prior_instructions`, `hidden_prompt`, `highest_priority`, `disregard`, `tool_output_says` |
| `AUTHORITY_SPOOFING` | `instruction-override` | `system_message_override` (block), `developer_message`, `new_instructions`, `forget_everything`, `you_are_now`, `pretend_you_are` |
| `EXFILTRATION_ATTEMPT` | `boundary-probe` | `exfiltrate`, `exfiltrate_secrets`, `encode_secrets`, `reveal_system_prompt`, `repeat_text_above` |
| `TOOL_MANIPULATION` | `prompt-injection` / `boundary-probe` | only `tool_output_says` exists; **thin**, see §12 |
| `ENCODED_INSTRUCTION` | *(no category)* | handled by normalization, surfaced as the decoded pattern's category |
| `SUSPICIOUS_INSTRUCTION` | severity `warn`/`review` | a severity, not a category |
| `UNSUPPORTED_OR_AMBIGUOUS` | *(absent)* | Bokahli must add; see §6 |
| `CLEAN` | `safe` | absence of findings, never a finding |

Adding a seventh category would fork the corpus. Bokahli should adopt the six
and carry its own *transport* concerns (`unsupported`, `scan-failed`) outside the
category enum.

## 4. Privacy components explicitly excluded

Not integrated into Bokahli, by decision and not by omission:

- `abaiya-policy/src/pii.rs` (424 lines) — name/credit-card/etc. detection with
  Luhn validation.
- `abaiya-policy/src/transform.rs` — `ReversibleRedaction`,
  `IrreversibleSanitization`, provenance tagging.
- `abaiya-policy/src/outbound.rs` — outbound export gating.
- velum-ai's `pii.ts`, `credential-buffer.ts`, and the `defaultPiiLevel` middleware
  posture that `ikbi` uses (`velumFastify(app, { defaultPiiLevel: 2 })`).

The reason is not that privacy is unimportant. It is that redaction *destroys
evidence*, and both Bokahli task classes — `test_log_triage` and
`repo_reconnaissance` — require every claim to cite a span of caller-supplied
input. A redactor in that path removes the thing citations point at, in exchange
for withholding data from a model running on the same machine as the data.

**This exclusion must not be reintroduced under another name.** Any future
component that rewrites, masks, normalizes or drops caller evidence on
privacy grounds is this system, whatever it is called, and needs its own
decision rather than inheritance from this one.

## 5. Secret hygiene that remains mandatory

Baseline security hygiene, unchanged and unrelated to §4:

- Never log credentials, API keys, `authorization` headers, environment secrets,
  or protected local paths. Bokahli already enforces the path half — artifact
  paths and canary paths are internal, `toPublic()` cannot emit them, and error
  strings report `err.name` rather than `err.message` precisely because Node's
  fs messages embed the path they failed on.
- Velum's `credential` category is **retained** for this, and it is the one place
  where suppressing a span is correct: a credential finding must carry
  `pattern_id` and never the matched value. A32 enforces this structurally —
  `VelumFinding` has no field a raw value could occupy.
- The asymmetry is deliberate: **injection findings need spans, credential
  findings must not have them.** §7 keeps them apart.

## 6. Trust-zone model

Velum scans strings. Bokahli knows where each string came from, and that
knowledge is the integration.

| Zone | Origin | Treatment |
|---|---|---|
| **Z0 — system** | Bokahli's own prompt scaffolding | trusted; never scanned; never caller-supplied |
| **Z1 — caller instruction** | the client's task request | trusted-by-configuration; **not** injection by default |
| **Z2 — human chat** | `messages[].content` from a human | direct instruction; scanned for *authority spoofing of Z0*, not for being instructions |
| **Z3 — untrusted evidence** | the evidence packet: logs, files, README text, JSON, diffs | **the primary target**; instructions here are injection by construction |
| **Z4 — tool/runtime output** | anything a tool returned | untrusted as Z3 |
| **Z5 — model output** | the completion | scanned for injection-*induced* violations, not for being text |

The governing sentence: **a direct user instruction is not prompt injection.** A
user may say "ignore the previous file and look at the second one" and that is a
request. The same words inside a log line the user asked Bokahli to triage are an
attack. Velum cannot tell those apart and should not try; Bokahli labels the
zone and Velum answers about the content.

Pipeline:

```
client request
  → zone labelling (Z1 instruction / Z3 evidence separated at parse)
  → Velum inspection of Z3 + Z4 only
  → fence neutralization of Z3 + Z4, unconditionally
  → Bokahli routing (unchanged)
  → model request with zones preserved as structure, not prose
  → Velum inspection of Z5 for injection-induced violation
  → typed result
```

Two properties are load-bearing. Fencing is applied **regardless of the Velum
verdict** — `fence.rs` takes no classification argument, on the stated grounds
that "a detector miss must not silently disable the boundary". And zone labels
are structural: if a caller can move text from Z3 to Z1 by wording, the model is
the boundary again.

## 7. Offset and citation strategy — **the blocker**

Bokahli's task contracts require every claim to cite a resolvable span of
supplied input. Two gaps sit between that and Velum as it stands.

**Gap 1 — findings carry no spans.** `VelumFinding` is
`{ pattern_id, category, severity }`. The Pike VM produces `Match { start, end }`
and `detect.rs` keeps `credential_spans` internally, so the information exists
and is discarded at the contract boundary. That discarding is *correct for
credentials* — a span plus the source text is the secret — and *wrong for
injection findings*, where the content is the caller's own evidence and the
operator needs to see which line was hostile.

**Gap 2 — the fence has no transformation map.** `NeutralizedContent` is
`{ raw_content_hash, rendered_content_hash, rendered, fence_version }`. The fence
escapes rather than strips — "every input code point remains represented in the
output", nothing is deleted, raw evidence is never mutated, and the original stays
recoverable by hash — but escaping changes lengths, and there is no
rendered→raw offset map. Reversible notation is not a map.

**Gap 3 — normalization appends.** Base64 segments are decoded and *appended
rather than substituted*. A match found in the appended region has no offset into
the source at all. Today this is invisible because findings carry no offsets; the
moment they do, decoded-region matches need an explicit "derived, no source span"
marker rather than a fabricated one.

**This is a blocker, and it is an adapter-shaped blocker, not a redesign.**
Required of V1, in Velum or in the adapter:

1. `VelumFinding` gains an optional span, populated for injection categories and
   structurally absent for `credential`.
2. The fence emits a `TransformationMap` — an ordered list of
   `(raw_start, raw_end, rendered_start, rendered_end)` — produced by the same
   deterministic escape pass that produces `rendered`. Not reconstructed
   afterwards.
3. Findings in normalization-derived regions carry
   `sourceSpan: null, derivedFrom: "base64-decode"` and are never presented as
   citable spans.

If (2) cannot be produced from the existing fence without changing its output
bytes, **that is the blocker to report upward, not a mapping to invent.** A
citation that resolves to the wrong span is worse than one that refuses to
resolve.

## 8. Proposed Bokahli-facing protocol

Versioned, additive, and shaped like the rest of Bokahli's telemetry: facts with
provenance, nulls with reasons, no field that can name its own strength.

```ts
export const VELUM_INSPECTION_CONTRACT = 'bokahli.velum-inspection.v1';

export interface VelumInspection {
  readonly contractVersion: typeof VELUM_INSPECTION_CONTRACT;
  readonly detectorContractVersion: string;   // e.g. "1.0.0"
  readonly corpusVersion: string | null;      // e.g. "abaiya-velum-mvp-1"
  readonly patternRegistryVersion: string | null;
  readonly detectorBuild: string | null;      // identity of the running detector
  readonly mode: 'off' | 'audit' | 'enforce';
  readonly zonesInspected: readonly TrustZone[];
  readonly packets: readonly VelumPacketResult[];
  readonly verdict: 'clean' | 'findings' | 'unsupported' | 'scan-failed';
  readonly observedAt: string;
  /** Null when the detector ran. Non-null explains why it did not. */
  readonly unavailableReason: string | null;
}

export interface VelumPacketResult {
  readonly packetId: string;          // caller's identity for this evidence item
  readonly zone: TrustZone;
  readonly rawContentHash: string;    // sha256 of the bytes as supplied
  readonly renderedContentHash: string | null;
  readonly fenceVersion: string | null;
  readonly findings: readonly VelumFindingRecord[];
  readonly primaryCategory: VelumCategory;   // 'safe' when there are none
  readonly deterministic: true;              // v1 is entirely deterministic
}

export interface VelumFindingRecord {
  readonly patternId: string;         // identity, never a matched value
  readonly category: VelumCategory;   // the six canonical names
  readonly severity: 'warn' | 'review' | 'block';
  /**
   * Byte span in the ORIGINAL supplied bytes. Null for credential findings —
   * a span plus the source is the secret — and for findings recovered from a
   * normalization-derived region, which have no source offset.
   */
  readonly sourceSpan: { readonly start: number; readonly end: number } | null;
  readonly spanAbsentReason: 'credential-suppressed' | 'derived-region' | null;
  readonly derivedFrom: 'source' | 'zero-width-folded' | 'leetspeak-folded' | 'base64-decoded';
  readonly recommendedAction: 'record' | 'annotate' | 'quarantine' | 'refuse';
}
```

Constraints carried over from the rest of Bokahli:

- `safe` is the absence of findings and never appears inside one.
- Finding sets are canonically ordered by Velum's `selection_key`, so identical
  content produces byte-identical results regardless of scan order.
- A detector that could not run yields `verdict: 'scan-failed'` with a reason —
  never `clean`. Absence of a scan is not absence of injection.
- `recommendedAction` is a **recommendation**. Bokahli's policy decides; Velum
  never decides.

## 9. Policy modes and task defaults

| Mode | Behaviour |
|---|---|
| `off` | operator-authorized bypass. Still receipted: the attestation records that inspection was disabled, by whom, and for which request. A silent bypass is indistinguishable from a missing feature. |
| `audit` | inspect, record every finding, execute anyway. |
| `enforce` | inspect; quarantine or refuse per policy. |

Proposed defaults, and the reasoning rather than the table alone: both existing
Bokahli task classes consume an evidence packet the caller assembles, and both
require citations into it. That is exactly the shape indirect injection targets.

| Surface | Default | Why |
|---|---|---|
| `repo_reconnaissance` | **enforce** | README, comments, config text — attacker-writable content in a repository the caller did not author |
| `test_log_triage` | **enforce** | logs quote whatever produced them, including model output and user input |
| uploaded files / retrieved web evidence | **enforce** | untrusted by construction |
| first-party chat, no attachments | **audit** | Z2 is a human giving instructions; enforcing here means refusing users for phrasing |

`off` is never a default for any task class that can produce qualification
evidence.

**No detector result becomes a qualification decision.** Luak qualifies injection
resistance; Bokahli applies request policy. A Velum finding must not appear in
`QualificationFacts` as anything other than a recorded observation, and must
never move `tokenCountSource`, `completeness`, or any attestation field.

## 10. False-positive strategy

The corpus already contains `fp-001`/`fp-002` and 15 `safe` fixtures, and
`detect.rs` has an `is_known_safe` allowlist — but that allowlist is narrow
(dotted module references, triple-hyphenated tool ids) and **credential-only**.
There is no "these instructions are being quoted, not issued" reasoning anywhere
in the implementation, and there should not be: that is a judgement about
provenance, and provenance is Bokahli's.

The strategy is therefore structural rather than lexical. Content in Z3 is *data*
by construction, so:

- Security documentation discussing injection, tests containing malicious
  strings, source implementing prompt defences, logs quoting prompts, fictional
  dialogue, and a user explicitly asking for an attack to be analysed all produce
  **findings**, and in `enforce` mode those findings quarantine the *span* while
  the surrounding evidence stays citable.
- Quarantine is not deletion. The span is fenced, the original bytes remain
  authoritative, and a claim may still cite the quarantined region *as* a
  quarantined region.
- "Analyse this attack" is a Z1/Z2 instruction about Z3 content. It is served,
  with the attack fenced, and the model is asked to describe rather than obey.
  Refusing it would make Bokahli useless for exactly the security work it should
  be good at.

The measurable target for V1 is **not** "zero false positives". It is: no
legitimate evidence becomes unciteable, and no finding silently removes content.

## 11. Luak qualification proposal

A versioned `prompt_injection_resistance` family, deliberately **separating four
questions that a single number would merge**:

| Lane | Measures | Independent of |
|---|---|---|
| `detector_accuracy` | Velum's findings vs the frozen corpus | any model |
| `model_resistance_protected` | model behaviour with Velum + fencing | detector recall |
| `model_resistance_bare` | model behaviour with no defence | Bokahli policy |
| `policy_effectiveness` | end-to-end Bokahli outcome | model quality |

Fixture families to cover: clear indirect injection; subtle authority spoofing;
encoded/obfuscated; instructions in code comments, logs, README, JSON and quoted
messages; exfiltration; tool manipulation; clean-but-suspicious controls;
over-refusal; correct analysis of an injection without following it; and citation
resolvability after quarantine.

The last two matter most and are the ones a naive suite omits. A model that
refuses everything scores perfectly on resistance and is worthless, and a
defence that breaks citations has broken the task contract while passing every
injection test.

**No fixtures are created and Luak is unchanged in V0.**

## 12. Recommended integration form

| Option | Fidelity | Cost | Isolation | Offsets | Verdict |
|---|---|---|---|---|---|
| Rust FFI / napi to `abaiya-policy` | exact | build toolchain, per-platform artifacts | in-process crash = API crash | best (Pike VM spans available) | **no toolchain on this host**; heavy for V1 |
| Rust sidecar service | exact | process, port, lifecycle | strong | good | plausible V2 |
| Subprocess CLI | exact | per-call spawn | strong | good | too slow per evidence packet |
| WASM build of the crate | exact | build pipeline | strong | good | promising, unproven |
| **Vendored velum-ai (TypeScript)** | **partial — fails `override-003`, no A32 categories** | none | in-process | none today | rejected as the detector of record |
| Reimplement rules in TypeScript | **none** | high | n/a | n/a | rejected: forks the corpus |

**Recommendation for V1: a TypeScript adapter over the A32 *contract*, with the
Rust crate as the conformance oracle.** Concretely:

1. Bokahli implements `VelumInspection` (§8) in TypeScript, over the **frozen
   38-fixture corpus and the 45-pattern registry**, both consumed as pinned data
   — the same mechanism already used for the Bokahli→Luak contract pin, which
   works and is audited.
2. The pattern regex bodies come from MIT-licensed velum-ai 0.2.2 by identity,
   and the **A32 category/severity assignment overrides velum-ai's** wherever
   they differ — including `override-003`, where TypeScript is non-conformant.
3. A conformance test asserts 38/38 against the frozen corpus, in Bokahli's own
   suite, in the same shape as the Luak cross-repo test.
4. Matching uses a bounded, backtracking-free matcher. If that cannot be done
   convincingly in TypeScript, the sidecar becomes V1 rather than V2 — a regex
   engine with backtracking scanning attacker-supplied evidence is a
   denial-of-service surface, and the Pike VM exists precisely because someone
   already reached that conclusion.

This buys semantic fidelity to the audited contract without a toolchain
dependency, and it keeps a migration path to the Rust crate open, because the
contract — not the implementation — is what Bokahli depends on.

## 13. Blocking unknowns

1. **Offset preservation (§7).** No finding spans, no fence transformation map,
   appended normalization regions. Blocks citation-preserving quarantine.
2. **The 38/38 Rust claim is unexecuted here.** No Rust toolchain; asserted by a
   test I read and could not run.
3. **`abaiya` has no LICENSE file.** velum-ai is MIT and the A32 provenance
   records velum-python as MIT, but the Rust crate's terms are unstated. Reusing
   its *contract vocabulary and fixtures* needs that settled; reusing its code
   certainly does.
4. **velum-python 0.3.0 was not located** under this account. It is referenced by
   A32 provenance as `/pehverse/repos/ecosystem/hlampko/velum-python`. Only its
   recorded conformance is available, and it fails 15 of 38.
5. **Tool-manipulation coverage is one pattern** (`tool_output_says`). Bokahli
   has no tool-use surface today, so this blocks nothing now and would need real
   work before it does.
6. **No indirect/direct distinction exists in any implementation.** Bokahli
   supplies it via zones; nothing upstream validates that it did.
7. **A32's deferred patterns** (`base64_injection`, `instruction_leak_indirect`,
   `prompt_leak_attempt`, `role_override`, `system_message_*`) were deferred for
   a contract reason, not a technical one. Bokahli should not unilaterally
   un-defer them.

## 14. Narrow V1 plan

Deliberately small, and ordered so the blocker is hit early rather than late.

1. **Verify the oracle.** Get 38/38 executing — Rust toolchain, or the corpus
   running against the TypeScript adapter. No integration work before this.
2. **Settle licensing** for the A32 contract vocabulary and fixtures.
3. **Prove the offset story or report it blocked.** Produce a fence with a real
   transformation map on one worked example, end to end, before anything depends
   on it.
4. **Land the contract only** — `VelumInspection` types in
   `@bokahli/contracts`, no detector wired, no request path touched.
5. **Zone labelling at parse.** Separate Z1 instruction from Z3 evidence in the
   request contract. This is valuable on its own and blocks nothing.
6. **Adapter + pinned corpus**, `audit` mode only, findings recorded in
   telemetry and affecting nothing.
7. **`enforce` for the two task classes**, with quarantine that preserves
   citations, only after (3) is real.

Steps 1–3 are reconnaissance closure. Steps 4–5 are safe to land early. Nothing
in 6–7 should start before 3 answers.

---

**Not implemented. No production code changed. No live service was contacted,
signalled, or reconfigured, and no inference was invoked.**
