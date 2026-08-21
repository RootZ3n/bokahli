# Multi-model campaign, 2026-08-21 — results

Method and the corrections that had to precede it: `METHOD.md`.
Client integration contract: `CLIENT-HANDOFF.md`.

Every table below is rendered by `scripts/campaign-report.mjs` from evidence
under `~/.local/state/bokahli/campaign` and `~/repos/luak/runs`. Nothing here is
typed in by hand. Neither evidence directory is in Git: a benchmark result is
generated evidence.

<!-- TABLES -->

## Notes on reading the placement table

**Cold load** is the wall time of `systemctl start`, which returns only after
`/health` answers *and* `assert-gpu-placement.sh` has confirmed the driver lists
the process as holding VRAM. It is a cold load including the GPU precondition,
not a pure weight-load time.

**TTFT** is a full prefill of the measurement prompt, not a short-prompt
latency. Each measured run carries a distinct nonce ahead of an otherwise
identical body, so nothing is served from KV cache — with an identical prompt
llama.cpp reported `prompt eval time = 58 ms / 4 tokens`, which is not a prefill
rate and read as 54 tok/s against a real 572.

**Prefill and decode** are llama.cpp's own timings by way of Bokahli telemetry.
Bokahli counts nothing itself and neither does the harness.

**Prompt token counts differ between tokenizer families** for the same bytes.
The prompt is byte-identical across artifacts; `gpt2/qwen35` and `gemma4`
segment it differently, and the measured counts are recorded beside the rates
rather than assumed equal.

**VRAM** is what the driver reports our exact pid holding, not whole-device
usage. Whole-device telemetry cannot answer whether *our* backend is on the GPU,
which is the Phase 1 lesson this column exists for.
