# Service behaviour

Measured 2026-08-20 on Mushin. Raw run: `cold-warm-queue.txt`.

## Cold start, full stack from stopped

| Stage | Time |
|-------|------|
| `bokahli-runtime.service` start → `/health` ok (systemd readiness-gated) | **2.15 s** |
| `bokahli.service` start → `/health/live` ok | **11.30 s** |
| `bokahli.service` live → ready | 0.07 s |
| **Total cold stack → ready** | **13.53 s** |

Bokahli's 11.3 s is dominated by startup digest verification: it re-reads the
entire 12.58 GiB artifact and recomputes its SHA-256 (measured 10.99–11.21 s).
That is the price of attesting identity from disk rather than trusting the
catalog. Setting `BOKAHLI_VERIFY_DIGEST=0` removes it and reduces start to well
under a second, at the cost of that guarantee.

## Request latency

| | TTFT | Total | Prefill | Decode |
|---|------|-------|---------|--------|
| First request after cold start | 221 ms | 1 232 ms | 100 tok/s | 62.3 tok/s |
| Warm run 1 | 138 ms | 1 142 ms | 67 tok/s | 62.8 tok/s |
| Warm run 2 | 128 ms | 1 141 ms | 74 tok/s | 62.2 tok/s |
| Warm run 3 | 145 ms | 1 172 ms | 73 tok/s | 61.3 tok/s |

Short-prompt prefill rates look low only because a ~20-token prefill is dominated
by fixed per-request overhead. Sustained batched prefill is 550–580 tok/s — see
`context-tiers.md`. The same artefact produced the misleading 3.87 tok/s figure in
the Phase 0 report.

## Queue behaviour under load

36 concurrent requests against one slot, `maxConcurrent=1`, `maxQueueDepth=8`:

```
ROUTED                27
CAPACITY_UNAVAILABLE   9
peakDepth              8      (exactly maxQueueDepth)
totalAdmitted         27
totalRejected          9
totalTimedOut          0
maxQueueWaitMs       695
```

Rejections are typed `CAPACITY_UNAVAILABLE` / `QUEUE_FULL` with HTTP 503 and a
`Retry-After` header. No request was dropped, stalled, or returned malformed.

## Restart and recovery

| Event | Result |
|-------|--------|
| `systemctl --user restart bokahli.service` | Ready in ~12 s; runtime untouched |
| `systemctl --user restart bokahli-runtime.service` | Runtime ready in 2.4 s |
| `SIGKILL` the backend (simulated crash) | `Restart=on-failure` restarts it; `Requires=` propagates a restart to `bokahli.service`; full recovery ~18 s, verified by a successful request afterwards |

Because `Requires=` propagates, **a backend crash also restarts the API layer**,
and Bokahli then pays its ~11 s digest verification again. Worst-case unavailability
on a backend crash is therefore ≈ 18 s, not ≈ 7 s.

## GPU lease contention

Started a competing `llama-server` holding 1 830 MiB (stand-in for ComfyUI):

- `/health/ready` → `not-ready`, `gpuLease.available: false`, holder listed by pid, name and MiB.
- Requests → HTTP 503, `CAPACITY_UNAVAILABLE` / `GPU_LEASE_HELD_BY_OTHER`, `Retry-After: 30`,
  with the lease holder named in the typed body. EXACT behaves identically — contention
  is a capacity outcome, never a refusal or a substitution.
- On stopping the competitor, the lease recovered **without restarting Bokahli**.

The 512 MiB threshold is deliberate: the KDE/Wayland desktop and browsers register
as compute apps holding tens of MiB (measured desktop baseline ~785 MiB across all
display processes, individually well under 512 MiB), while a real second GPU
consumer registers in GiB.
