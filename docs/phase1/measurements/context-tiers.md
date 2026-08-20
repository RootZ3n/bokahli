# Context tier measurements

Measured 2026-08-20 on Mushin against the pinned runtime `b10505-ee4c505a4`
serving `qwen3.5-35b-a3b.q2-k`, `--parallel 1`, `-ngl 999 --cpu-moe --flash-attn on`.

Each tier ran an isolated `llama-server` on a scratch port. VRAM is
per-process, attributed via `nvidia-smi --query-compute-apps`. The large request
fills ~75% of the context. Raw data: `context-tiers.jsonl`.
Harness: `scripts/measure-context.sh`.

| ctx | cold load | VRAM steady | VRAM peak | anon RSS | prompt tokens | prefill tok/s | decode tok/s | prefill wall time | survived |
|-----|-----------|-------------|-----------|----------|---------------|---------------|--------------|-------------------|----------|
| 8 192  | 2.20 s | 1 914 MiB | 1 972 MiB | 851 MB | 5 933  | 579.2 | 56.7 | 10.2 s | yes |
| 16 384 | 2.12 s | 2 082 MiB | 2 140 MiB | 859 MB | 12 065 | 582.3 | 55.3 | 20.7 s | yes |
| 32 768 | 2.03 s | 2 418 MiB | 2 476 MiB | 862 MB | 24 357 | 572.6 | 52.3 | 42.5 s | yes |
| 65 536 | 2.05 s | 3 090 MiB | 3 148 MiB | 869 MB | 48 885 | 552.4 | 48.9 | 88.5 s | yes |

## What the numbers say

**KV cache cost is exactly linear at 21 MiB per 1 024 tokens** (+168 MiB from 8K→16K,
+336 from 16K→32K, +672 from 32K→64K). That is ~21.5 KB/token, which is cheap
because the architecture is GQA 16:2 and flash attention is on.

**Memory is not the limiting factor.** Extrapolating the measured slope, 131 072
tokens would cost ~4 434 MiB and the full 262 144-token train context ~7 122 MiB —
both fit inside the ~11.2 GiB usable VRAM.

**Prefill wall time is the limiting factor.** Prefill holds at 550–580 tok/s across
every tier, so worst-case time-to-first-token scales linearly with context: 42.5 s
at 32K, 88.5 s at 64K, and roughly 3 minutes at 128K. That is the real ceiling on
a human-facing chat UI, not VRAM.

**Decode degrades mildly with context depth**: 56.7 → 48.9 tok/s from 8K to 64K
at 75% fill, a 14% loss.

## Decision

Serving context is **32 768**. Measured stability, memory, and latency all support
it, and it is the operator's stated target. 65 536 is proven viable and can be
raised without new measurement if a workload justifies doubling worst-case prefill.

Anything above 64K is not recommended without first addressing prefill throughput.
The runtime emitted a related hint at startup that has not been acted on:

    tensor overrides to CPU are used with mmap enabled -
    consider using --load-mode none for better performance

That is an untested lead for improving prefill, not a measured result.
