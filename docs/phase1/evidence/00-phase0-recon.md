# Bokahli v2 — Phase 0 Reconnaissance Report (Mushin)

Date of capture: 2026-08-20 ~05:09–05:25 CDT. Read-only. Nothing installed, modified, pulled, or pushed.

---

## PART 1 — MEASURED FACTS

### 1.1 Host

| Property | Value | Command |
|---|---|---|
| Hostname | `mushin` | `hostnamectl` |
| OS | Nobara Linux 44 (KDE Plasma), `ID_LIKE=rhel centos fedora` | `/etc/os-release` |
| OS support end | 2026-12-02 (3mo 2wk remaining) | `hostnamectl` |
| Kernel | `7.1.8-201.nobara.fc44.x86_64`, PREEMPT_DYNAMIC | `uname -a` |
| Board / FW | ASUS ROG STRIX Z790-H GAMING WIFI, FW 3001 (2025-03-07) | `hostnamectl` |
| Uptime | 1d 11h, load 0.37 | `uptime` |
| Session | KDE Plasma on **Wayland**, GUI active, Steam + Brave running | `systemctl --user` |

### 1.2 CPU

- 13th Gen Intel Core i7-13700K — 16 cores / 24 threads, 1 socket, 1 NUMA node
- Max 5400 MHz, currently ~18% scaling
- L2 24 MiB, L3 30 MiB
- AVX2 + AVX-VNNI + F16C + FMA present. **No AVX-512** (P/E hybrid).
- `Command: lscpu`

### 1.3 Memory

```
Mem:   31Gi total | 7.9Gi used | 11Gi free | 12Gi buff/cache | 23Gi available
Swap:  42Gi total | 4.7Gi used
  /dev/zram0        8.0G  (prio 100, 4.7G used per swapon)
  /dev/nvme2n1p4   34.2G  (prio -1, 0B used)
```
- `Command: free -h; swapon --show; /proc/meminfo`
- Largest RSS consumer is `llama-server` at 10.3 GB, of which 9.65 GB is file-backed mmap of the GGUF (`RssFile`), 0.67 GB anonymous.

### 1.4 Storage

| Device | Model | Size | FS | Mount | Used | Avail |
|---|---|---|---|---|---|---|
| nvme2n1p3 | WD_BLACK SN770 1TB | 894.8G | btrfs | `/` and `/home` | 194G | **700G** |
| nvme0n1p1 | WD_BLACK SN850X 1TB | 931.5G | ext4 | `/data/storage` | 478G | 392G |
| nvme1n1p1 | SanDisk Ultra 3D NVMe | 931.5G | ext4 | `/run/media/zen/Games` | 762G | 109G |
| nvme2n1p2 | — | 2G | ext4 | `/boot` | 768M | 1.1G |
| nvme2n1p1 | — | 600M | vfat | `/boot/efi` | 21M | 579M |

- `/home` is **btrfs** — relevant: CoW + large GGUF files; `chattr +C` / nodatacow may matter for model dirs.
- `/data/storage` (ext4, 392G free) contains `comfy/` (ComfyUI) and `SteamLibrary/`.
- `Command: lsblk; df -hT`

### 1.5 GPU

```
NVIDIA GeForce RTX 4070 (AD104), PCI 01:00.0
Driver 595.91.07  |  CUDA runtime 13.2  |  Compute capability 8.9
VRAM 12282 MiB total
Idle temp 36–38 C  |  Power 9.2 W / 200 W cap  |  Util 1%
Persistence Mode: Disabled  |  Compute Mode: Default  |  Display Active: Enabled
```

VRAM allocation at capture time:

| Consumer | MiB |
|---|---|
| `llama-server` (compute) | 2100 |
| `brave` gpu-process | 110 |
| `plasmashell` | 118 |
| `plasma-keyboard` | 85 |
| `kwin_wayland` | 27 |
| `steamwebhelper` / `steam` / `Xwayland` | ~37 |
| **Total used** | **2855–2879** |
| **Free** | **8994–9018** |

**Desktop/display baseline VRAM cost ≈ 785 MiB** while KDE + Brave + Steam are up.
**Practical inference VRAM ceiling ≈ 11.2 GiB** with the desktop idle-but-running; ~10.5 GiB is a safe working budget.

- `Command: nvidia-smi; nvidia-smi --query-gpu=...; nvidia-smi --query-compute-apps=...`

### 1.6 CUDA / build toolchain

- `nvcc` 13.2.51 at `/usr/bin/nvcc` (distro RPM, **not** `/usr/local/cuda`)
- RPMs: `cuda-13.2.51`, `cuda-cudnn-9.20.0.48`, `cuda-nvrtc`, `cuda-cudart-devel`, `dkms-nvidia-595.91.07`, `cuda-gcc-15`
- `gcc`/`g++` 16.1.1, `cmake` present
- `Command: nvcc --version; rpm -qa | grep -Ei 'nvidia|cuda'`

### 1.7 Installed inference runtimes

| Runtime | Status |
|---|---|
| **llama.cpp** | **Present and built** — `/home/zen/llama.cpp`, git master @ `ee4c505a4` (2026-08-19), `b10499-6-gee4c505a4`, server reports `b10505-ee4c505a4` |
| ollama | **Absent** |
| vLLM | **Absent** |
| PyTorch | **Absent** (`import torch` fails) |
| SGLang / ExLlama / TGI | **Absent** |

llama.cpp build config (`build/CMakeCache.txt`):
```
CMAKE_BUILD_TYPE   = Release
GGML_CUDA          = ON
GGML_CUDA_FA       = ON      (flash attention)
GGML_CUDA_GRAPHS   = ON
GGML_CUDA_NCCL     = ON
GGML_NATIVE        = ON      <-- built for this exact CPU; not portable
CMAKE_CUDA_COMPILER= /usr/bin/nvcc
GGML_CUDA_FA_ALL_QUANTS = OFF
```
- Built 2026-08-19 05:08, build dir 966 MB, `libggml-cuda.so.0.20.2` = 44 MB.
- Upstream remote is `https://github.com/ggml-org/llama.cpp.git`, branch `master`, clean vs `origin/master`.

### 1.8 Other toolchain

| Present | Absent |
|---|---|
| python3 **3.14.6**, pip, pipx | uv |
| node **v22.22.3**, npm **10.9.8** | pnpm, bun |
| git 2.55.0 (libcurl 8.18.0, OpenSSL 3.5.7) | gh CLI |
| podman, podman-compose | docker, docker-compose |
| cmake, gcc/g++ 16.1.1, nvcc, jq, curl | go, rustc, cargo |
| tailscale, systemctl | — |

Note: **Python 3.14** is the only system interpreter. Many ML/serving wheels do not yet publish cp314 builds.

### 1.9 Installed models / artifacts

Exactly **one** model artifact exists on this machine. No models found in `~/.ollama`, `~/.cache/huggingface`, `/data/storage`, `/opt`, `/var/lib/ollama`, or `/run/media/zen/Games`.

```
Path      : /home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf
Size      : 13,506,778,944 bytes (12.58 GiB)
SHA-256   : 49533d47d170c0dad00e38f3aab0d8a5556654caa8144a7e6f3480c8e6761201
mtime     : 2026-08-19 05:13:12 -0500
Format    : GGUF v? , quantization_version=2, file_type=10 (Q2_K - Medium)
```

GGUF metadata (via `gguf-py` GGUFReader — read-only):
```
general.architecture         = qwen35moe
general.name                 = Qwen3.5 35B A3B
general.basename             = Qwen3.5
general.size_label           = 35B-A3B
qwen35moe.block_count        = 41
qwen35moe.context_length     = 262144      <-- native train context
qwen35moe.embedding_length   = 2048
qwen35moe.attention.head_count    = 16
qwen35moe.attention.head_count_kv = 2      <-- GQA 8:1, cheap KV cache
qwen35moe.rope.freq_base     = 10000000.0
qwen35moe.expert_count       = 256
qwen35moe.expert_used_count  = 8
tokenizer.ggml.model         = gpt2
tensor count                 = 753
n_params (server-reported)   = 35,505,251,456   (~3B active per token)
n_vocab                      = 248,320
```

Provenance: downloaded via `huggingface_hub` (cache metadata at `~/models/.cache/huggingface/`). The source repo tree lists the full quant ladder (IQ1_M … bf16, plus an imatrix and `kld_results/`), which identifies it as a **community imatrix quant repo**, not the Qwen first-party release. Sibling quants available upstream include `Q2_K_L` (14.0 GB), `IQ3_XXS` (15.8 GB), `Q3_K_M` (17.1 GB), `IQ4_XS` (19.7 GB), `Q4_K_M` (22.3 GB).

### 1.10 Running inference service (pre-existing, ad-hoc)

```
PID 25179, parent 25147 (bash -c), started Wed 2026-08-19 05:34:44, uptime 23h35m
/home/zen/llama.cpp/build/bin/llama-server
  -m /home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf
  --host 0.0.0.0 --port 8080
  -ngl 999 --cpu-moe -c 4096 --flash-attn on --reasoning off
```

- Launched from an interactive shell as `bash -c '... 2>&1 | head -30'` — **startup log was truncated to 30 lines and is gone**. Not under systemd. No restart policy. Reparented to PID 1.
- `--cpu-moe` keeps expert tensors in system RAM; only attention/shared layers on GPU. This is why a 12.58 GiB model runs in **2.1 GiB VRAM**.

Live endpoint state:
```
GET /health      -> {"status":"ok"}
GET /props       -> build_info "b10505-ee4c505a4", total_slots 4, n_ctx 4096 (per slot),
                    model_ftype "Q2_K - Medium", eos "<|im_end|>",
                    modalities: vision/video/audio all false
                    chat_template_caps: tools YES, parallel_tool_calls YES,
                                        system_role YES, object_arguments YES,
                                        reasoning_effort NO, preserve_reasoning NO
GET /slots       -> 4 slots, all n_ctx 4096, none processing
GET /metrics     -> 501 (metrics endpoint DISABLED; --metrics not passed)
GET /v1/models   -> id = "/home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf"
```

**Served identity note:** the model `id` exposed over the API is a **filesystem path**, not a stable model name. There is no alias, no digest, no version in the served identity. This directly blocks the EXACT routing mode.

### 1.11 Measured inference performance (real requests against the live server)

Short prompt, cold, single sequence:
```
prompt_n 25    prompt 6451.7 ms   ->    3.87 tok/s   (258 ms/token)
predicted_n 80 predicted 1325.8 ms ->  59.59 tok/s
finish_reason: stop; output was coherent and on-task
```

Longer prompt (1160 tokens), `cache_prompt:false`, two consecutive runs:
```
run 1:  prompt_n 1160  ->  517.2 tok/s   |  predicted 61.88 tok/s
run 2:  prompt_n 1160  ->  573.1 tok/s   |  predicted 60.96 tok/s
```

**Interpretation of the discrepancy:** the 3.87 tok/s figure is a cold-path artifact of a 25-token prefill (fixed per-request overhead dominates, plus first-touch of CPU-resident expert weights). Sustained batched prefill is **~520–575 tok/s**; sustained decode is **~60–62 tok/s**. However, the ~6.4 s cold TTFT on a small prompt is itself a real, user-visible number for a chat UI and needs re-measurement under a warm, steady-state server.

### 1.12 Listening services and ports

| Bind | Port | Process | Notes |
|---|---|---|---|
| `0.0.0.0` | 22 | sshd | |
| **`0.0.0.0`** | **8080** | **llama-server** | **no auth, all interfaces** |
| `0.0.0.0` / `[::]` | 5353, 5355 | avahi / resolved | mDNS/LLMNR |
| `0.0.0.0` | 41641 (udp) | tailscaled | WireGuard |
| `100.115.140.2` | 47472 | tailscaled | tailnet-local |
| `[fd7a:115c:...]` | 60727 | tailscaled | tailnet-local |
| `127.0.0.1` | 631 | cups | |
| `127.0.0.53/.54` | 53 | systemd-resolved | |
| `0.0.0.0` | 27036 | steam | |
| `127.0.0.1` | 27060, 35235, 44397, 57343 | steam | |
| `*` | 1716 | kdeconnectd | |

**Port 8080 is free of conflict for nothing else, but is already taken by llama-server.**

### 1.13 Network and exposure boundary

```
enp7s0      UP    192.168.88.10/24   (default route via 192.168.88.1, dhcp)
wlp0s20f3   DOWN
tailscale0  UP    100.115.140.2/32 , fd7a:115c:a1e0::e35:8c04/128
```

Tailnet (`tailscale status`), all nodes owned by `RootZ3n@`:
```
100.115.140.2    mushin           linux    (this host)
100.88.20.122    pehtop           linux    online
100.84.209.89    pehverse         linux    idle
100.117.132.48   zenpix           android  online
100.117.227.52   ipad-air-gen-4   iOS      offline 98d
100.86.134.78    iphone-11        iOS      offline 60d
100.86.100.115   iphone-14-pro    iOS      offline 80d
```
- `tailscale serve status` / `funnel status` -> **No serve config**. Nothing published to the tailnet or the internet via Tailscale.
- Prefs: `WantRunning=true`, `ShieldsUp=false`, `RunSSH=false`, `RouteAll=false`, `AdvertiseRoutes=null`, `LoggedOut=false`.
- `~/.ssh/config` defines `pehverse` (100.75.99.9) and `pehtop` (100.100.173.31) — note these IPs **do not match** the current tailnet addresses for those names (100.84.209.89 / 100.88.20.122). Stale config.
- SSH key: `id_ed25519`, comment `zen@mushin-1`. `known_hosts` contains **zero** github.com entries.

**Firewall (measured):**
```
firewalld: active, default zone = FedoraWorkstation
FedoraWorkstation:
  interfaces: enp7s0
  services:   dhcpv6-client mdns samba-client ssh
  ports:      1025-65535/udp  1025-65535/tcp     <-- wide open above 1024
tailscale0: "no zone"  -> falls through to the default zone (FedoraWorkstation)
```

**Consequence:** llama-server on `0.0.0.0:8080` is reachable, unauthenticated, from (a) every host on `192.168.88.0/24` and (b) every device on the tailnet. `ShieldsUp=false` confirms tailnet peers are not blocked. This is a live, currently-open, unauthenticated inference endpoint.

### 1.14 systemd user services

- `loginctl show-user zen`: `Linger=yes`, `State=active` -> **user units survive logout and start at boot**. Suitable for hosting Bokahli.
- `systemctl --user is-system-running` -> **degraded**, from 2 failed units, both unrelated:
  - `app-nvidia\x2dsettings\x2dload@autostart.service` (nvidia-settings on Wayland)
  - `drkonqi-coredump-pickup.service`
- Existing custom user unit: `~/.config/systemd/user/hermes-gateway.service` — **active/running**
  - `ExecStart=/home/zen/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run`
  - `WorkingDirectory=/home/zen/.hermes`, `Restart=always`, `RestartSec=5`, `KillMode=mixed`, `TimeoutStopSec=210`
  - `RestartForceExitStatus=75`, `RestartPreventExitStatus=78` — a usable convention to mirror.
  - Source repo: `https://github.com/NousResearch/hermes-agent.git`
- No llama-server unit exists. No bokahli unit exists.

### 1.15 Local repository state — `~/repos/bokahli`

```
/home/zen/repos/bokahli
└── .claude/        (created 2026-08-20 05:08 by this session's tooling)
```
- **Not a git repository.** `git status` -> `fatal: not a git repository`.
- No source, no remotes, no history. **Genuinely empty.**
- Only other git checkouts under `/home/zen` (depth 4): `llama.cpp` (ggml-org) and `.hermes/hermes-agent` (NousResearch).
- **No prototype Bokahli checkout exists anywhere on this machine.** (`find /home/zen /data/storage -iname '*bokahli*'` returns only the empty dir and the Claude project state dir.)
- No `~/.gitconfig`, no `/etc/gitconfig`, no `~/.git-credentials`, no `~/.config/gh`. **git has no configured user identity on this machine.**

---

## PART 2 — REMOTE / REPOSITORY TOPOLOGY

Obtained read-only via the public GitHub REST API and one `git ls-remote`. No clone, fetch, pull, merge, or push was performed.

### 2.1 Account

`RootZ3n` (name "RootZ3n"), 23 public repos. `zenisgrowing` is not a GitHub login.

### 2.2 `RootZ3n/bokahli` — the existing remote

```
full_name       RootZ3n/bokahli
clone_https     https://github.com/RootZ3n/bokahli.git
clone_ssh       git@github.com:RootZ3n/bokahli.git
visibility      public
license         MIT
created         2026-05-24T01:18:59Z
last pushed     2026-07-09T15:11:47Z   (~6 weeks stale)
size            217 KB
language        TypeScript (506,642 B TS + 3,743 B JS)
description     "small model coding"
open issues     0     forks 0
default branch  main
```

**Branches (complete):**
```
main   23c98ab722f559992b3e75ec5a439f211ebc3d88   protected=false
```
**Tags (complete):**
```
v0.0.1 -> 23c98ab722f559992b3e75ec5a439f211ebc3d88   (identical to main HEAD)
```
Confirmed independently by `git ls-remote --heads --tags`.

**History:** **63 commits** on `main` (derived from the `Link: rel="last"` header at `per_page=1`). All authored by `Zen`. The entire visible history is dated **2026-05-24**, spanning 01:24Z → 12:27Z — a single ~11-hour build session. Head commit is `docs: add Aedis dogfood protocol`.

Commit-message themes (names only, no source read): a deterministic benchmark harness (`benchmark: add ... verifier` x8 — config single-file edit, context retrieval fixture, scope violation, drift detection, failing-test fix, three-file chain, messy-prompt resilience), an "Ariadne" context-packet/repo-scan subsystem, a deterministic mock worker + mock pipeline, a CLI, and CI smoke workflows. Named concepts present: **Aedis**, **Ariadne**, **Scintilla**.

**Top-level tree on `main` (paths only, contents not read):**
```
dir   .github
dir   docs
dir   examples
dir   scripts
dir   src
dir   tests
file  .gitignore              20 B
file  LICENSE               1064 B  (MIT)
file  README.md             5246 B
file  package.json          1220 B
file  pnpm-lock.yaml       40298 B   <-- pnpm; pnpm is NOT installed on Mushin
file  tsconfig.json          322 B
file  tsconfig.build.json    161 B
file  vitest.config.ts       160 B
```

Assessment: the remote is a **small, clean, linear, single-session TypeScript prototype** — 217 KB, one branch, one tag, zero divergence. There is nothing to reconcile and no risk of losing parallel work.

### 2.3 Sibling ecosystem repos (all `RootZ3n`, all public, all TypeScript)

| Repo | Default | Size | Last push | Description |
|---|---|---|---|---|
| **luak** | `master` | 175.6 MB | 2026-08-04 | **"AI Model Testing Suite"** |
| **ikbi** | `main` | 17.6 MB | **2026-08-20T03:59Z (today)** | "To build" |
| **pehlichi** | `master` | 9.2 MB | 2026-07-22 | "Peh" |
| nusika | main | 12.6 MB | 2026-08-11 | Companion based learning |
| ofi | main | 6.1 MB | 2026-08-20 | Robotics designer |
| velum | master | 104 KB | 2026-07-09 | AI Privacy & Injection Defense — prompt-injection classification, three-stage trust guard, PII masking |
| kokuli | main | 13.2 MB | 2026-07-09 | Red team training module |
| colosseum | main | 226 KB | 2026-05-02 | Agent Proving Ground |
| chukka / hlampko / hoponi / toba / atoni / howa / peh-pub / portfolio / apela- / gridlands / wyrmsvsworms / absent-pianist / MoreInput / Portum | — | — | — | — |

**`ikbi` branches (complete list):**
```
main, master, adjudication-authority-flip, hardening-sprint-codex,
harness/cc-parity-and-bokahli-pilot, labmem-integration, rc1-hardening,
state-bound-mutation-hardening, test/cc-status-endpoint, ui/pehverse-shell-port
```
Two of these are directly load-bearing for this project:
- **`harness/cc-parity-and-bokahli-pilot`** — prior ikbi↔Bokahli integration work already exists.
- **`adjudication-authority-flip`** and **`state-bound-mutation-hardening`** — consistent with the stated split where clients keep mutation/verification/promotion authority.

`luak`'s branch list could not be retrieved (see 2.4). `luak` at 175 MB is by far the largest and is the stated qualification authority; it is **not checked out on Mushin**.

### 2.4 Network reliability caveat (measured)

GitHub access from this session is **intermittently flaky**, specifically at the TLS layer:
- `git ls-remote https://github.com/RootZ3n/bokahli.git` failed twice with `TLS connect error: error:030000EA:digital envelope routines::provider signature failure` and `SSL certificate OpenSSL verify result: certificate signature failure (7)`, then **succeeded on retry**.
- `curl https://github.com` timed out mid-body once (`code=200` but 10 s timeout after 228 KB), while `openssl s_client -connect github.com:443` reports a clean `Verify return code: 0 (ok)`, TLSv1.3, `CN=github.com`.
- Several `api.github.com` calls returned empty bodies and succeeded on retry, with `x-ratelimit-remaining: 56/60` — i.e. **not** rate limiting.

git is linked against libcurl 8.18.0 / OpenSSL 3.5.7, crypto policy `DEFAULT`. This pattern (valid cert via openssl, intermittent signature failure via libcurl) is consistent with a TLS-intercepting middlebox or proxy in this session's egress path rather than a host misconfiguration — but it is **unconfirmed**, and it is a real operational risk for any Phase 1 step that clones or pushes.

---

## PART 3 — OPERATOR-PROVIDED REQUIREMENTS (restated, not measured)

Recorded here so recommendations can be traced to them. These are inputs, not findings.

1. Fresh implementation on Mushin; no copying/importing/salvaging source from another Bokahli checkout; prototype architecture is not authoritative.
2. Standalone, network-accessible local AI platform.
3. First-class browser chat UI for direct human use.
4. Stable API for ikbi, Hermes, Pehlichi, and other clients.
5. Bokahli Intelligence routing: **AUTO**, **PROFILE**, **EXACT**, plus a typed **ESCALATE** outcome when no qualified local route is suitable.
6. Model-agnostic: driven by catalog / capability / qualification / live operational data — **no model-name conditionals**.
7. **Luak** is the independent qualification authority.
8. **Bokahli** is authority for: installed artifacts, runtime health, exact served identity, model lifecycle, machine load, queue/capacity, telemetry, local routing, execution.
9. Client systems retain higher-level governance, mutation, verification, promotion, and cloud-routing authority.
10. Default execution: **one local worker + deterministic verification**. Extra roles only where qualification evidence proves improvement.
11. Phase 1 is results-first: one runtime, one exact model, chat + API, real tasks, measurements, then harden.
12. Initial workloads: test/log triage, repo reconnaissance, diff/receipt summarization, cited extraction/documentation, structured classification — all **non-mutating**.

---

## PART 4 — RECOMMENDATIONS

### 4.1 Inference runtime — recommend **llama.cpp `llama-server`**, pinned

Grounds, all from measured state:

1. **It is the only runtime that can run this class of model on this GPU.** 12,282 MiB VRAM with ~785 MiB permanently consumed by the KDE/Wayland desktop leaves ~11.2 GiB. The one model on disk is 12.58 GiB. llama.cpp's `--cpu-moe` runs it in **2.1 GiB VRAM** by keeping the 256 experts in system RAM and only 8 are active per token. vLLM has no equivalent CPU-expert-offload path.
2. **It is already built, CUDA-enabled, and proven on this exact hardware** — Release, `GGML_CUDA=ON`, flash-attn, CUDA graphs, and 23.5 h of uptime with measured throughput.
3. **It supports the `qwen35moe` architecture.** This is a very new arch; runtime support is not a given elsewhere.
4. **vLLM is not viable here without new work and new hardware headroom.** PyTorch is not installed; the only interpreter is **Python 3.14**, for which much of the CUDA ML wheel ecosystem does not yet publish builds; and vLLM wants the full weight set resident in VRAM.
5. **Ollama adds a layer without adding capability.** It is absent, it wraps llama.cpp, and it would obscure the exact-served-identity and lifecycle control that requirement 8 assigns to Bokahli.
6. **It gives Bokahli the control surfaces the design needs**: `/health`, `/props` (build_info, ftype, slots, chat-template capabilities), `/slots` (live queue/capacity), and `/metrics` (Prometheus, currently disabled — a one-flag fix).

Conditions attached to this recommendation:
- **Pin the build.** `GGML_NATIVE=ON` means the binary is compiled for this specific CPU and is not portable. Record `b10505-ee4c505a4` as the runtime artifact identity and stop tracking `master` implicitly.
- **Enable `--metrics`.** `/metrics` currently returns 501; Bokahli's telemetry authority (req. 8) needs it.
- **Do not treat the currently-running process as the Phase 1 runtime.** It is an ad-hoc `bash -c` with its startup log truncated by `| head -30`, no restart policy, and no supervision. Replace it with a supervised unit before building anything on top.
- Keep the runtime **behind** Bokahli, never adjacent to it. Bokahli owns identity, routing, and admission; llama-server is a dumb executor.

### 4.2 Repository strategy — recommend **Option A: preserve `RootZ3n/bokahli`, orphan-branch v2**

The remote is 217 KB, one branch, one tag, 63 linear commits from a single day, zero forks, zero open issues, six weeks stale. There is no divergence to reconcile.

**Recommended sequence (Phase 1, on approval):**
1. `git clone https://github.com/RootZ3n/bokahli.git ~/repos/bokahli` — full history fetched, nothing merged.
2. Tag the prototype immutably: `git tag v1-prototype 23c98ab` (alongside the existing `v0.0.1`).
3. `git switch --orphan v2` then `git rm -rf .` — a **branch with no parent commit and no v1 files in the tree**. This satisfies "do not copy, import, or salvage source code" literally: no v1 file ever enters the v2 tree, and no v1 commit is an ancestor of any v2 commit.
4. Build v2 on that branch. When it stands on its own, promote `v2` to default branch and keep `main` frozen as the v1 record.

Why this over the alternatives:

| Option | Verdict |
|---|---|
| **A. Orphan `v2` branch in existing repo** | **Recommended.** History fully preserved and reachable. Single canonical URL keeps ikbi's existing `harness/cc-parity-and-bokahli-pilot` reference valid. Zero v1 ancestry in v2. Clean `git log v2` from commit 1. |
| B. New repo `bokahli-v2`, archive old | Breaks the single-URL identity, splits the ecosystem, and forces every client to re-point. No benefit over A. |
| C. Long-lived `v2` branch off `main` | Rejected. `main` becomes an ancestor of v2, so v1 files are in the tree at branch point and must be deleted in a commit — the prototype is then in v2's history, contradicting requirement 1. |
| D. `git checkout --orphan` in a fresh local repo, force-push over `main` | Rejected. Destroys history; explicitly out of bounds. |

Also recommended at repo init:
- **Set a git identity on Mushin** — none exists (`~/.gitconfig` absent). Nothing can be committed until this is set.
- **Resolve GitHub authentication** before step 1. There are no GitHub credentials on this machine (no `gh`, no credential store, zero github entries in `known_hosts`). SSH key is `zen@mushin-1`; whether it is registered on the `RootZ3n` account is unknown.
- **`pnpm-lock.yaml` in v1 implies pnpm; pnpm is not installed.** v2's package manager is an open decision (see 6.4).
- Consider `chattr +C` on the model directory given `/home` is btrfs.

### 4.3 Security boundary — recommend closing the current exposure in Phase 1

Present state, measured: an unauthenticated LLM endpoint on `0.0.0.0:8080`, reachable from the entire `192.168.88.0/24` LAN and from every tailnet device, because firewalld's default `FedoraWorkstation` zone opens `1025-65535/tcp` and `tailscale0` is unzoned (falls through to that same default zone) with `ShieldsUp=false`.

Recommended target shape:
```
llama-server   -> bind 127.0.0.1:8080 only        (loopback, never routable)
bokahli        -> bind 127.0.0.1 + 100.115.140.2  (loopback + tailscale0 only, never 0.0.0.0)
auth           -> bearer token on every API route, including the chat UI's own calls
firewalld      -> assign tailscale0 to an explicit zone; stop relying on default-zone fallthrough
tailscale      -> keep `serve` unconfigured; NEVER enable `funnel` (that publishes to the public internet)
```
Rationale: requirement 2 says "network-accessible", and the tailnet already provides an authenticated, encrypted, device-scoped network containing exactly the machines that need it (`pehtop`, `pehverse`, `zenpix`). Binding to `0.0.0.0` adds LAN exposure that buys nothing and cannot be authenticated at the network layer. The LAN-wide `1025-65535/tcp` opening is a pre-existing Fedora Workstation default, not something Bokahli introduced — but Bokahli must not depend on it.

### 4.4 Service supervision — recommend systemd `--user` units

`Linger=yes` is already set, so user units start at boot and survive logout. `hermes-gateway.service` is a working in-house precedent to mirror (`Restart=always`, `RestartSec=5`, `KillMode=mixed`, `RestartPreventExitStatus=78`, journal logging). Two units: `bokahli-runtime@.service` (templated on the served model) and `bokahli.service`, with the latter `After=`/`Wants=` the former. This also fixes the current "startup log went into `| head -30` and is gone" problem — journald keeps it.

---

## PART 5 — PROPOSED PHASE 1 PLAN (narrow; for approval, not yet started)

Scope: **one model, one API path, one basic chat path.** No routing modes, no catalog, no Luak integration, no multi-model.

**P1.0 — Repo foundation**
- Set git identity on Mushin. Resolve GitHub auth. Clone `RootZ3n/bokahli`, tag `v1-prototype`, create orphan `v2`, commit an empty scaffold. Verify `git log v2` shows exactly one commit and no v1 files.

**P1.1 — Pin and supervise the runtime**
- Record runtime identity: `llama.cpp b10505-ee4c505a4`, CUDA 13.2, driver 595.91.07.
- Write `bokahli-runtime.service` (user unit): loopback bind, `--metrics` enabled, `--alias` set to a stable name, explicit `-c`, log to journal.
- Stop the ad-hoc PID 25179 and start the unit. Confirm `/health`, `/props`, `/metrics` (expect 200, not 501).

**P1.2 — Establish exact served identity**
- Define the identity record Bokahli will assert and serve: `{artifact_path, sha256=49533d47…, size_bytes, gguf_arch=qwen35moe, quant=Q2_K, n_params, n_ctx_train=262144, runtime_build=b10505-ee4c505a4, driver, cuda, n_ctx_served, ngl, cpu_moe}`.
- This is the seed of the artifact catalog and the precondition for EXACT mode. It is *not* the routing engine.

**P1.3 — Determine the real context ceiling** (blocking for the stated workloads)
- Current `-c 4096` across 4 slots is far below the workloads in requirement 12; a single CI log or repo scan exceeds it.
- GQA is 16:2, so KV cache is cheap. Measure actual VRAM+RAM at `-c` = 16k / 32k / 64k / 131k with `--cpu-moe`, against the ~11.2 GiB VRAM ceiling and 31 GiB system RAM (of which llama-server already mmaps 9.65 GiB).
- Decide slot count vs. per-slot context — 4×4096 vs 1×32768 is a real capacity trade-off Bokahli will later expose as queue/capacity telemetry.

**P1.4 — Bokahli API surface (thin)**
- `POST /v1/chat/completions` — OpenAI-compatible so ikbi/Hermes/Pehlichi can adopt it with minimal client work.
- `GET /health`, `GET /v1/models` — Bokahli-asserted identity, **not** a passthrough of llama-server's filesystem-path `id`.
- Bearer-token auth on every route. Bind loopback + `100.115.140.2` only.
- Every response carries the exact served-identity record from P1.2 and a request-scoped telemetry record.
- Hardcode the single model. No routing logic. AUTO/PROFILE/EXACT/ESCALATE are **typed at the boundary but not implemented** — reserve the shape, don't build the engine.

**P1.5 — Browser chat UI**
- Minimal streaming chat against Bokahli's own API (never llama-server directly), served by Bokahli. Displays exact served identity and per-request timings.

**P1.6 — Run the real workloads and measure**
- Execute the requirement-12 tasks (test/log triage, repo recon, diff summarization, cited extraction, structured classification) against real inputs from this machine.
- Capture per-task: TTFT, prefill tok/s, decode tok/s, prompt/completion tokens, VRAM high-water, GPU util/temp, queue depth, and pass/fail against deterministic verification.
- **This measurement set is the input to every later qualification and routing decision.** Hardening and intelligent selection begin only from it (requirement 11).

Explicitly **out of scope** for Phase 1: routing modes, model catalog, Luak integration, multi-model or multi-node, model lifecycle/download, additional worker roles, cloud escalation transport.

---

## PART 6 — UNKNOWNS, BLOCKERS, AND UNRESOLVED DECISIONS

### 6.1 Blockers (must be answered before Phase 1 starts)

**B1 — GitHub authentication on Mushin.** No `~/.gitconfig`, no credential helper, no `gh`, no github.com entry in `known_hosts`. The SSH key is `zen@mushin-1`; unknown whether it is registered to `RootZ3n`. *Nothing can be cloned, committed, or pushed until this is resolved.* Operator must supply the method (SSH key registration vs. PAT vs. `gh auth`).

**B2 — git identity.** No user.name / user.email configured anywhere on this host. Required before the first commit.

**B3 — Repo strategy approval.** The orphan-`v2` plan (4.2) touches the remote's branch/tag structure. Not started; awaiting adjudication.

**B4 — TLS flakiness to github.com.** Reproducible intermittent `certificate signature failure` from git/libcurl while `openssl s_client` validates cleanly (see 2.4). Root cause unconfirmed. Will make clone/push unreliable. Needs a decision: retry-tolerant workflow, SSH transport instead of HTTPS, or diagnose the proxy.

### 6.2 Blocking for the stated workloads

**B5 — 4096-token context is too small.** Requirement 12's workloads (log triage, repo recon, diff summarization) routinely exceed 4k. Native train context is 262,144. The real ceiling on this hardware is unmeasured (P1.3).

**B6 — Q2_K quality is unvalidated for cited extraction.** Q2_K on a 35B-A3B MoE means ~3B *active* parameters at ~2-bit. "Cited extraction/documentation" and "structured classification" are precisely the tasks where aggressive quantization degrades faithfulness and citation accuracy. The upstream repo publishes `kld_results/` per quant — that data exists but was not read, and no local eval has been run. **The single smoke output observed was fluent but contained a factual error** (attributed GGUF to "Georgi" without surname and asserted a GGML-replacement narrative loosely) — one sample proves nothing, but it is not evidence of extraction-grade reliability either.

### 6.3 Unknowns (facts not obtainable read-only from Mushin)

- **Luak's interface contract.** `RootZ3n/luak` exists (175 MB, TypeScript, `master`, last push 2026-08-04) but is not checked out here and its branch list could not be retrieved. How Bokahli consumes qualification evidence from Luak — API? artifact file? shared schema? — is entirely undefined.
- **ikbi's expectations.** The branch `harness/cc-parity-and-bokahli-pilot` proves prior integration intent. What API shape it expects is unread.
- **Hermes' expectations.** `hermes-gateway.service` is live on this box (NousResearch `hermes-agent`), but whether *that* Hermes is the requirement-4 "Hermes" client, and what it would call, is unconfirmed.
- **Pehlichi's expectations.** Repo exists (`master`, 9.2 MB); no local checkout; contract unread.
- **What `pehtop` / `pehverse` are for.** Both are online tailnet Linux nodes. Whether they are future Bokahli *nodes* (requirement: "best qualified available local model/node") or only clients is undecided. `~/.ssh/config` for both has **stale IPs** that don't match current tailnet addresses.
- **ESCALATE transport.** Requirement 5 defines a typed outcome; where an escalation *goes* is client-side authority (requirement 9), so Bokahli's obligation is presumably to emit the typed result and stop. Not confirmed.
- **Whether the ~6.4 s cold TTFT is representative.** Measured once on a cold 25-token prompt; steady-state chat TTFT is unmeasured.

### 6.4 Decisions requiring operator adjudication

1. **Runtime** — accept llama.cpp `b10505-ee4c505a4` pinned (4.1)? And does Bokahli pin to a commit, or track `master`?
2. **Repo strategy** — Option A (orphan `v2` in `RootZ3n/bokahli`) vs. B vs. C (4.2)?
3. **Security boundary** — loopback + tailscale0 + bearer token (4.3)? Confirm LAN (`192.168.88.0/24`) access is **not** required. Confirm Tailscale Funnel stays off permanently.
4. **First model** — keep `Qwen3.5-35B-A3B-Q2_K` (the only artifact present, and no downloads are permitted yet), or plan a Phase 1 download of a higher-fidelity quant? `Q2_K_L` (14.0 GB) and `IQ3_XXS` (15.8 GB) fit comfortably in the 700 GB free on `/home` and still work with `--cpu-moe`, at higher RAM cost. This intersects directly with B6.
5. **Context/slot configuration** — optimize for concurrency (4 slots × small ctx) or for the stated long-context workloads (1–2 slots × 32k+)? Cannot be both within 31 GB RAM.
6. **Language/stack for Bokahli itself** — the whole ecosystem is TypeScript, and Node 22.22.3 is installed; Python is 3.14 with a thin wheel ecosystem. TS/Node looks strongly indicated, but **pnpm is not installed** (v1 used it) — pnpm vs. npm is open.
7. **Does the running PID 25179 get stopped in Phase 1?** It has 23.5 h uptime and may be in use by something not visible from here.
8. **Should Bokahli assume it is the only GPU consumer?** The desktop holds ~785 MiB permanently, and ComfyUI is installed at `/data/storage/comfy` (not currently running). If ComfyUI is ever launched concurrently, VRAM contention is guaranteed. Needs a policy.

---

## APPENDIX — Actions NOT taken (Phase 0 constraints honored)

- No packages installed, no models downloaded.
- No services created, started, stopped, enabled, or modified. PID 25179 left running untouched.
- No application architecture initialized. `~/repos/bokahli` still contains only `.claude/`.
- No git clone, fetch, pull, merge, checkout, commit, push, or force-push. No remote alteration. `git ls-remote` (read-only ref listing) and public GitHub REST reads only.
- No Bokahli prototype source read, copied, or imported — none exists on this machine, and only repo *metadata* and top-level *path names* were retrieved from the remote.
- No secrets printed. Tailscale auth state, SSH private keys, and service environment values were not disclosed.
- Two live inference requests were issued against the already-running server for measurement (1.11). These were non-mutating reads.
