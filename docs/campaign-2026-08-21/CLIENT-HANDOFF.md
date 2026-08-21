# Client integration handoff

**No client was modified in this session, and none should be until a model and
profile are selected.** This is the contract those integrations have to meet and
the specific things that will break if they do not — written now, while the
platform behaviour is fresh, so the integration work starts from a checklist
rather than from a re-reading of the source.

## Targets

| client | machine | notes |
|---|---|---|
| ikbi | Mushin | same host as Bokahli; reaches it over loopback |
| Hermes | Pehverse | reaches Mushin over the tailnet |
| Pehlichi | Pehverse | shares a deployment with Luna and Ptah |
| Luna | Pehverse | " |
| Ptah | Pehverse | " |
| Phone Pehlichi | phone | **required publication/deployment target** |

The three Pehverse clients are integrated together because they share one
deployment surface; a change to the routing contract that satisfies one and
breaks another is a change that has not been made.

## What every client must exercise

### 1. Exact routing, and refusal instead of substitution

`route: { mode: "EXACT", modelId, artifactDigest }` — both fields. A route
without a digest is not exact and Bokahli refuses it with `BAD_REQUEST`. If the
deployment is serving a different artifact, Bokahli refuses rather than
substituting, and the client must surface that refusal rather than retrying
against whatever is loaded.

The OpenAI-compatible dialect cannot express EXACT: `model` carries no digest.
A bare `model` name is honoured as a *hard pin* and refused on mismatch, which
is close but not the same contract. Clients that need exact routing use
`/v1/bokahli/chat`.

### 2. Typed escalation, never a 5xx and never a fabricated answer

Bokahli's units are wired `Wants=`, not `Requires=`, so the API stays up when
its backend does not. With no runtime loaded the campaign measured
`200 ESCALATE` with no completion — that is the contract, and clients must
handle it as a first-class outcome rather than as an error.

The outcomes a client will actually see:

| outcome | meaning | client action |
|---|---|---|
| `ROUTED` | a completion was produced | use it |
| `ESCALATE` / `RUNTIME_UNHEALTHY` | backend absent or unattested | fall back; do not retry tightly |
| `ESCALATE` / `ATTEMPT_NOT_ATTRIBUTABLE` | the backend changed mid-attempt | discard, do not score |
| `ESCALATE` / `VELUM_EVIDENCE_BLOCKED` | block-severity finding in evidence | surface to the operator |
| `REFUSED` / `EXACT_IDENTITY_UNKNOWN` | wrong artifact is loaded | do not substitute |
| `CAPACITY_UNAVAILABLE` | queue full; one slot, one request | back off |

**A campaign found a real 500 here.** Three of four catalog entries carried no
`operational` block, and the `AUTO` router dereferenced it. Every campaign
request routes EXACT, so nothing reached that path until a swap probe used AUTO.
It is fixed and refused at catalog load now — but the lesson for client work is
that the AUTO path is the least-travelled one, and an integration that uses it
should be tested against a deployment with the backend deliberately stopped.

### 3. Attested identity, checked by the client

Every routed response carries `result.servedIdentity` with `modelId`, `digest`,
`attested`, and the runtime build. A client that does not check `attested ===
true` and the digest it asked for is a client that will one day attribute output
to weights that did not produce it. Luak's responder refuses on all four and is
the reference implementation.

### 4. Streaming

`/v1/bokahli/chat` with `stream: true` emits SSE. Partial text is never a
completion: when the runtime dies mid-generation Bokahli discards partial output
and says so with `partialTextDiscarded`. A client that renders deltas must drop
what it has rendered when a non-`ROUTED` terminal arrives, rather than keeping a
truncated answer on screen as though it were one.

### 5. Cancellation, where the client supports it

Bokahli forwards a client disconnect to the backend, so an abandoned request
frees the single inference slot. A client that opens a request and walks away
without closing the response holds the slot for the whole generation — with
`maxConcurrent: 1`, that is the entire deployment.

Phone Pehlichi is the case to be careful with: a backgrounded app that keeps a
socket half-open is indistinguishable, from the server's side, from a slow
reader.

### 6. Evidence goes in the evidence channel

This is the one that changes behaviour rather than plumbing.

Untrusted material — logs, files, documents, tool output, anything the user did
not type — goes in `evidence: [{ id, content }]`, **not** interpolated into a
`user` message. The channel is what assigns the trust zone. A hostile document
pasted into `messages` is treated as the caller's own instruction, which is
correct and is exactly what the caller asked for by putting it there.

Sent as evidence it is fenced, scanned, and framed by
`bokahli.evidence-policy/1`. Sent in a message it is none of those things.

The previous campaign measured injection resistance without using this channel
and therefore measured the harness rather than the boundary. A client that
interpolates evidence into messages reproduces that mistake in production.

### 7. Safe fallback to existing provider paths

Every client keeps its current provider. The local path is additive, and the
fallback must be exercised in tests — not merely present — for at least:
backend absent, artifact mismatch, capacity exhausted, and attestation stale.

## What must be settled before any of this starts

1. **A selected model and placement profile.** Until then there is nothing to
   pin a digest to.
2. **An operator qualification policy, or an explicit decision to run
   unqualified.** Every artifact is `INSTALLED_UNQUALIFIED`; a client sending
   `requireQualified: true` today gets a typed escalation, every time, by
   design. Clients must either send `false` deliberately or wait for a policy.
3. **A regime per client.** `unconstrained` and `json_schema` are different
   production contracts. A client that needs parseable output every time wants
   the constrained regime and should send `structuredOutput`; a client that
   wants to know whether the model can hold a contract on its own wants the
   other. Both are supported; picking neither is how a deployment ends up
   measuring one and running the other.

## Deployment note for Phone Pehlichi

It is a required publication target, and it is the only client that will reach
Bokahli over a link that can disappear mid-response. Its integration should be
built against the streaming path with cancellation, and its fallback tested with
the network removed rather than with the server stopped — those fail
differently, and only one of them is what a phone actually does.
