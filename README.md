# Bokahli v2

A standalone, network-accessible local AI platform for Mushin.

Bokahli is the authority for installed artifacts, runtime health, **exact served
identity**, model lifecycle, machine load, queue and capacity, telemetry, local
routing, and execution. Qualification is *not* Bokahli's authority — that belongs
to Luak, and Bokahli asserts nothing Luak has not issued evidence for.

This is the Phase 1 vertical slice. It proves one path end to end:

```
browser chat  ->  authenticated Bokahli API  ->  catalog route
              ->  loopback llama-server  ->  streamed response
                  + exact identity + telemetry
```

## Status

| | |
|---|---|
| Phase | 1 — vertical slice, verified |
| Runtime | llama.cpp, pinned `b10505-ee4c505a4` |
| Artifact | `qwen3.5-35b-a3b.q2-k`, **`INSTALLED_UNQUALIFIED`** |
| Serving context | 32 768 tokens (measured; see `docs/phase1/measurements/`) |
| Concurrency | 1 loaded model, 1 slot, 1 active request, queue depth 8 |

**The installed artifact is not qualified for anything.** It is served as an
appliance model. Luak has issued no evidence for it, so Bokahli makes no claim
that it is fit for any task class. `PROFILE` and `AUTO` requests that demand a
qualified route receive a typed `ESCALATE`, not a substitution.

## Layout

```
packages/contracts   types: identity, routing, escalation, Luak import contract
packages/catalog     artifact catalog, digest verification, public projection
packages/runtime     loopback llama-server client, GPU lease monitor, admission queue
packages/server      HTTP API, bearer auth, router, telemetry, chat UI
catalog/             the artifact catalog
config/              environment templates
systemd/             user units
scripts/             install, measure, verify, rollback
docs/phase1/         evidence and measurements
```

## Security boundary

- `llama-server` binds **127.0.0.1 only** and additionally requires an API key,
  because loopback is reachable from any browser page on this host and llama.cpp
  sets CORS to `*`.
- Bokahli binds **loopback and Mushin's Tailscale address only**. Wildcard binds
  are rejected by the process at startup, not merely omitted from config.
- **Every route except `GET /health/live` requires a bearer token**, including the
  chat UI's own HTML and assets.
- `tailscale0` is assigned an explicit default-deny firewalld zone
  (`bokahli-tailnet`, target `DROP`, allowing only `ssh` and `8080/tcp`) rather
  than falling through to the permissive `FedoraWorkstation` default.
- Prompt and completion text never enters a log unless `BOKAHLI_LOG_PROMPTS=1`.

## Install

```bash
npm install
npm run build
scripts/install-units.sh
systemctl --user start bokahli-runtime.service
systemctl --user start bokahli.service
```

Open the UI by presenting the token once; it is exchanged for an HttpOnly cookie
and stripped from the URL by redirect:

```
http://100.115.140.2:8080/?token=$(cat ~/.config/bokahli/token)
```

## API

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /health/live` | none | Liveness only. Leaks no identity, build, or capacity. |
| `GET /health/ready` | bearer | Runtime attestation, capacity, GPU lease, qualification state |
| `GET /v1/models` | bearer | OpenAI-shaped inventory. `id` is the stable identity, never a path. |
| `GET /v1/catalog` | bearer | Native inventory with full facts and qualification |
| `GET /v1/telemetry` | bearer | Aggregate counters, latency percentiles, recent records |
| `POST /v1/chat/completions` | bearer | OpenAI-compatible, streaming and buffered |
| `POST /v1/bokahli/chat` | bearer | Native envelope with `AUTO` / `PROFILE` / `EXACT` |

### Route modes

**`AUTO`** — Bokahli selects. In Phase 1 exactly one artifact is installed, so the
selection is deterministic; it still passes through the full contract and records
every candidate considered. No score, ranking, or fitness claim is fabricated to
make that look richer than it is. `requireQualified: true` yields `ESCALATE`.

**`PROFILE`** — caller-defined capability and operational constraints. Unmet
requirements are rejected with the specific requirement, what was required, and
what was actual. Bokahli will not substitute a model that fails a stated constraint.

**`EXACT`** — a specific artifact, by stable identity *and* digest. A request
without a digest is not exact and is rejected. Mismatched digest, unknown identity,
a filesystem path used as identity, or a runtime that cannot be attested all
produce a typed refusal. There is no silent substitution path.

**`ESCALATE`** is a typed outcome, not an error — HTTP 200 with the unmet
requirements and the candidates considered. Bokahli holds no cloud-routing
authority; where an escalated request goes next is the calling system's decision.

**`CAPACITY_UNAVAILABLE`** is distinct from `ESCALATE`: the local route is correct
but cannot execute now — queue full, queue timeout, runtime down, or the GPU lease
held by another consumer.

## Not implemented in Phase 1

Repository mutation, shell tools, autonomous coding, multi-agent workflows, Luak
integration beyond the versioned placeholder import contract, ikbi integration,
model downloads, automatic artifact installation, cloud fallback, and any
qualification claim.

## Verify

```bash
scripts/verify.sh     # 69 checks against a running deployment
```

## Rollback

`scripts/rollback-runtime.sh` restores the pre-v2 ad-hoc runtime exactly as it ran
before the cutover. Note it restores `--host 0.0.0.0` with no authentication, which
re-opens an unauthenticated endpoint to the LAN and tailnet. Use deliberately.

## License

MIT
