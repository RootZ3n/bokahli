# Phase 1 measurements

| File | Contents |
|------|----------|
| `context-tiers.md` | Context sizing at 8K / 16K / 32K / 64K, and the reasoning behind serving 32 768 |
| `context-tiers.jsonl` | Raw per-tier records from `scripts/measure-context.sh` |
| `cold-warm-queue.txt` | Cold-start, first-request, warm-request, and queue-behaviour run |
| `service-behaviour.md` | Start-up, restart, recovery, and contention characteristics. Its crash-recovery row is superseded by `../LIFECYCLE.md`. |

All numbers are measured on Mushin, not estimated. Where a number is derived or
extrapolated, the text says so.
