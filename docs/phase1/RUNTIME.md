# Runtime

## Pin

| | |
|---|---|
| Engine | llama.cpp `llama-server` |
| Build | `b10505-ee4c505a4` (git `ee4c505a4fb37be8ea37a78af272e74dad2835c1`) |
| Binary | `/home/zen/llama.cpp/build/bin/llama-server` |
| Binary SHA-256 | `30ced9f78f3801f7dcd36b19a3881ad934617bce8d6d7bf76241013a165add6f` |
| CUDA | 13.2.51 · Driver 595.91.07 · RTX 4070, compute 8.9 |
| Build flags | `Release`, `GGML_CUDA=ON`, `GGML_CUDA_FA=ON`, `GGML_CUDA_GRAPHS=ON`, `GGML_NATIVE=ON` |

`GGML_NATIVE=ON` means this binary is compiled for this exact CPU and is **not
portable**. The pin is the binary, not just the commit.

Bokahli refuses to attest a served identity if `/props.build_info` does not match
this pin, which turns a runtime upgrade into an explicit, visible action.

## Served artifact

| | |
|---|---|
| Public identity | `qwen3.5-35b-a3b.q2-k` |
| Digest | `sha256:49533d47d170c0dad00e38f3aab0d8a5556654caa8144a7e6f3480c8e6761201` |
| Size | 13 506 778 944 bytes (12.58 GiB) |
| Architecture | `qwen35moe` — 41 blocks, 256 experts, 8 active, GQA 16:2 |
| Train context | 262 144 · **served at 32 768** |
| Qualification | `INSTALLED_UNQUALIFIED` |

The filesystem path lives only in `catalog/artifacts.json` and in the systemd
environment. It is structurally unable to reach an API response: the public
projection in `@bokahli/catalog` does not carry the field.

## Why these flags

| Flag | Reason |
|------|--------|
| `--host 127.0.0.1` | The backend is never routable. Bokahli is its sole client. |
| `--api-key` | Loopback is reachable from any browser page on this host, and llama.cpp sets CORS to `*`. Without a key a hostile page could drive inference directly. |
| `--alias` | Gives the backend a stable served name so identity can be attested instead of inferred from a path. |
| `--metrics` | Bokahli holds telemetry authority and needs the Prometheus endpoint. The pre-v2 process returned 501. |
| `--ctx-size 32768` | Chosen from measurement. See `measurements/context-tiers.md`. |
| `--parallel 1` | One loaded model, one slot, one active request. |
| `--cpu-moe` | Keeps 256 expert tensors in system RAM. This is what lets a 12.58 GiB model run in ~2.4 GiB VRAM on a 12 GiB card with a live desktop. |
| `--n-gpu-layers 999` | Offload everything eligible; experts are excluded by `--cpu-moe`. |
| `--flash-attn on` | Measured KV cost is 21 MiB per 1 024 tokens with it enabled. |
| `--no-webui` | Bokahli owns the human surface. |
| *(absent)* `-v` | Deliberately not passed: verbose logging would put prompt contents in the journal. |

## Device placement is checked, not assumed

`--n-gpu-layers 999` is a request, not a guarantee. When CUDA fails to
initialise, llama.cpp prints a warning, ignores the flag, and serves the correct
artifact from system RAM at roughly a third of the decode rate — while attesting
perfectly. That happened on the 2026-08-20 reboot and passed every acceptance
check; see `REBOOT-2026-08-20.md`.

Two checks now bracket the load:

| | |
|---|---|
| `ExecStartPre` | `scripts/require-gpu.sh` — loads `nvidia_uvm`, then proves CUDA initialises via `llama-server --list-devices` |
| `ExecStartPost` | `scripts/assert-gpu-placement.sh` — asks the driver whether the loaded backend actually holds VRAM |

`NoNewPrivileges` is off for `bokahli-runtime.service` alone, because loading
`nvidia_uvm` needs the setuid `/usr/bin/nvidia-modprobe`. `bokahli.service`, the
network-facing unit, keeps it on. `BOKAHLI_REQUIRE_GPU=0` opts out deliberately.

## Replacing the pre-v2 process

The runtime that ran before Phase 1 was an interactive `bash -c ... | head -30`.
`head` exited after 30 lines, so both stdout and stderr pointed at a pipe with a
closed read end for ~23 h 50 m: **no startup log, no runtime log, and no error log
for that process ever existed**, and its model load report is unrecoverable.

Full evidence captured before it was stopped: `evidence/01`–`evidence/04`.

It was started from an SSH session originating on **pehverse** (`100.84.209.89`).
No client was attached at cutover time.

Rollback: `scripts/rollback-runtime.sh`.
