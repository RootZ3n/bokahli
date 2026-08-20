# Backend lifecycle

## The defect

Phase 1 shipped `bokahli.service` with `Requires=bokahli-runtime.service`. That
made a backend crash take Bokahli's API down with it:

- callers got a refused connection instead of an answer;
- `GET /health/live` — the one route that exists to say "the service is up" —
  went dark at precisely the moment someone would ask;
- the API re-ran its ~11 s startup digest verification on the way back, turning
  a ~7 s backend restart into ≈18 s of total unavailability;
- and Bokahli, which holds the authority for runtime health, disappeared exactly
  when the runtime failed. An authority that vanishes with the thing it reports
  on is not an authority.

## The correction

`Requires=` → `Wants=`. Ordering is still enforced by `After=`, so a cold boot
starts the runtime first and Bokahli attests a loaded model on its first probe.
What is dropped is stop/restart propagation — the part nobody wanted.

That is the minimum change: not `PartOf=` (propagates stop and restart, which is
the defect), not `BindsTo=` (stronger than `Requires=`), not a plain removal
(then nothing pulls the runtime in at boot).

## Behaviour during backend unavailability

| | |
|---|---|
| `GET /health/live` | 200, unauthenticated, throughout |
| `GET /health/ready` | 503, `status: not-ready`, `runtime.health: "unavailable"`, `attested: false` |
| Inference (any mode) | HTTP 200 with a typed terminal escalation |

The inference result:

```json
{
  "outcome": "ESCALATE",
  "route": {
    "kind": "ESCALATE",
    "reason": "RUNTIME_UNHEALTHY",
    "retryableLocal": true,
    "unmet": [{ "requirement": "runtime.reachable", "required": "true", "actual": "false" }]
  },
  "result": null
}
```

`outcome` / `reason` / `retryableLocal` are this codebase's spelling of
`outcome` / `reason_code` / `retryable_local`; the contract is the same and the
regression suite asserts that exact triple.

`retryableLocal` is the field that carries the meaning. Every other escalation
is a statement about local *capability* — no qualified route, context too large,
capability unsupported — and retrying cannot change it. This one is a statement
about local *health*: the route is correct, the same request will succeed here
once the runtime is back, and the caller does not need to go elsewhere
permanently.

Three failure shapes are all mapped onto that one result:

| Situation | Result |
|---|---|
| Runtime already gone when routing | `ESCALATE` / `RUNTIME_UNHEALTHY` before execution |
| Runtime dies mid-request (buffered) | partial text **discarded**, same escalation returned |
| Runtime dies mid-request (streaming) | terminal `bokahli.done` with `outcome: "ESCALATE"`, `result: null`, `partialTextDiscarded: true` |
| Runtime accepts the connection and never answers | same escalation, on the client's own deadline (`LlamaBackend` bounds the wait for response *headers* only, so slow generations are never cut off) |

Partial output is discarded rather than returned. A truncated answer with no
terminal event from an attested runtime is exactly the plausible-looking model
output this path exists to prevent.

## What recovery does *not* relax

Identity attestation is unchanged and is re-run on every request. A restarted
runtime does not inherit the trust of the one it replaced:

- reachable but serving a different artifact → `REFUSED` / `EXACT_NOT_ATTESTED`;
- reachable but a different build than the pin → `REFUSED` / `EXACT_NOT_ATTESTED`;
- reachable and attesting correctly → `ROUTED`.

`Attestation.reachable` is what separates "absent" from "present but wrong".
Collapsing those two would either turn a crash into an accusation of
substitution, or turn a substitution into "try again later".

The backend's pid is re-discovered rather than cached, because the runtime now
restarts under a new pid while the API keeps running. A pid learned at startup
is wrong the moment that happens, and a stale one makes our own inference server
look like a competing GPU consumer — turning every subsequent request into a
false `CAPACITY_UNAVAILABLE`.

## Measured: controlled SIGKILL, 2026-08-20

`kill -KILL` on the `llama-server` main pid (10365), with `/health/live` polled
every 100 ms, authenticated EXACT every 400 ms, and `/health/ready` every 300 ms.

| | |
|---|---|
| **API availability** | **551/551 `/health/live` samples returned 200** over the 63 s window — zero failures |
| API pid | 10449 before, 10449 after — **unchanged** |
| `bokahli.service` `NRestarts` | 0 → **0** |
| `bokahli-runtime.service` `NRestarts` | 0 → 1 |
| Backend pid | 10365 → **11949** (new process) |
| Time to typed unhealthy | in-flight request returned the escalation in **0.12 s**; subsequent requests 40–110 ms |
| Backend unreachable at | +0.01 s |
| Backend restart scheduled | +5.0 s (`RestartSec=5`) |
| Backend answering again | **+6.68 s** |
| Re-attested `healthy` | **+6.69 s** |
| First successful EXACT | **+6.69 s** |
| Outcomes observed | `ESCALATE`/`RUNTIME_UNHEALTHY` ×14, then `ROUTED`. Nothing else — no 5xx, no capacity failure, no fabricated content |

Total unavailability of inference: **6.69 s**, against ≈18 s under `Requires=`.
The difference is the ~11 s digest verification the API no longer re-runs,
because the API no longer restarts.

Journal, trimmed:

```
06:37:59.991 bokahli[10449]  runtime.lostDuringExecution  partialChars=0
06:38:00.150 systemd         bokahli-runtime.service: Main process exited, code=killed, status=9/KILL
06:38:00.150 systemd         bokahli-runtime.service: Failed with result 'signal'
06:38:05.156 systemd         bokahli-runtime.service: Scheduled restart job, restart counter is at 1
06:38:05.368 bokahli-runtime bokahli-gpu-precondition: CUDA available: CUDA0: NVIDIA GeForce RTX 4070
06:38:06.484 bokahli-runtime srv llama_server: model loaded
06:38:07.506 bokahli-runtime bokahli-gpu-placement: GPU placement confirmed: pid 11949 holds 2430 MiB
06:38:07.507 systemd         Started bokahli-runtime.service
```

`bokahli.service` appears nowhere in that sequence. It was never stopped, never
restarted, and answered every liveness probe throughout.

The streaming path was exercised separately by stopping the runtime 3 s into a
900-token generation: 168 deltas had been delivered, and the stream terminated
with `outcome: "ESCALATE"`, `reason: "RUNTIME_UNHEALTHY"`, `result: null`,
`partialTextDiscarded: true`. The client exited cleanly rather than hanging.

## Regression tests

`packages/server/test/lifecycle.test.js` drives the real router against a real
HTTP backend on a loopback port, stopped and restarted for real:

- backend loss while the API is healthy yields a typed terminal escalation;
- the terminal result carries exactly `{ESCALATE, RUNTIME_UNHEALTHY, retryable_local: true}` for EXACT, AUTO and PROFILE;
- an unhealthy runtime is never reported as a capability or qualification failure;
- the backend restarting under a new pid does not require an API restart;
- routing resumes only after the restarted runtime re-attests its exact identity — a wrong artifact and a wrong build are both refused;
- identity is re-attested on every request, not cached across an outage;
- a backend that accepts connections but never answers fails terminally, not indefinitely.

`packages/runtime/test/discovery.test.js` spawns real processes to prove a
restarted backend is re-adopted under its new pid.
