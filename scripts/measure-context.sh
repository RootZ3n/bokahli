#!/usr/bin/env bash
# Measure llama-server operation at a set of context sizes.
#
# Runs an isolated instance on a scratch port so the production runtime is not
# disturbed. Records cold-start time, per-process VRAM, resident memory,
# prefill and decode throughput, and time to first token.
#
# Usage: scripts/measure-context.sh <out.jsonl> [ctx ...]
set -uo pipefail

BIN=/home/zen/llama.cpp/build/bin/llama-server
MODEL=/home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf
ALIAS=qwen3.5-35b-a3b.q2-k
PORT=${MEASURE_PORT:-8082}
OUT=${1:?usage: measure-context.sh <out.jsonl> [ctx ...]}
shift
TIERS=("$@")
[ ${#TIERS[@]} -eq 0 ] && TIERS=(8192 16384 32768 65536)

: > "$OUT"

gpu_for_pid() {
  nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null \
    | awk -F', *' -v p="$1" '$1==p {print $2; found=1} END{if(!found) print 0}'
}

for CTX in "${TIERS[@]}"; do
  echo "=================== ctx=${CTX} ===================" >&2
  LOG=$(mktemp /tmp/claude-1000/-home-zen-repos-bokahli/53b48fcd-9ad1-484e-8231-dd297e7bf045/scratchpad/llama-measure-XXXX.log)

  START=$(date +%s.%N)
  "$BIN" --model "$MODEL" --alias "$ALIAS" \
    --host 127.0.0.1 --port "$PORT" \
    --ctx-size "$CTX" --parallel 1 \
    --n-gpu-layers 999 --cpu-moe --flash-attn on \
    --metrics --no-webui --reasoning off \
    > "$LOG" 2>&1 &
  PID=$!

  READY=0
  for _ in $(seq 1 240); do
    if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then READY=1; break; fi
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  LOAD=$(echo "$(date +%s.%N) - $START" | bc)

  if [ "$READY" -ne 1 ]; then
    echo "{\"ctx\":$CTX,\"status\":\"FAILED_TO_START\",\"loadSeconds\":$LOAD,\"log\":$(jq -Rs . < "$LOG" | head -c 4000)}" >> "$OUT"
    echo "  FAILED to start at ctx=$CTX" >&2
    kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
    continue
  fi

  sleep 2
  VRAM=$(gpu_for_pid "$PID")
  RSS=$(awk '/^VmRSS:/{print $2}' /proc/$PID/status)
  ANON=$(awk '/^RssAnon:/{print $2}' /proc/$PID/status)
  HWM=$(awk '/^VmHWM:/{print $2}' /proc/$PID/status)
  MEMFREE=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  SWAP=$(awk '/^SwapFree:/{print $2}' /proc/meminfo)

  # --- warm-up + short request (TTFT path) -------------------------------
  curl -s --max-time 120 "http://127.0.0.1:${PORT}/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"Say OK."}],"max_tokens":4,"cache_prompt":false}' >/dev/null

  SHORT=$(curl -s --max-time 180 "http://127.0.0.1:${PORT}/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"List three properties of a hash function."}],"max_tokens":64,"temperature":0.2,"cache_prompt":false}' \
    | jq -c '.timings // {}')

  # --- large request at ~75% of the context -----------------------------
  TARGET=$(( CTX * 75 / 100 ))
  FILL=$(( TARGET - 200 ))
  # Measured on this tokenizer: the repeat unit below costs ~28.05 tokens.
  # Target 75% of ctx and stay under it rather than overshooting into a 400.
  BIG=$(python3 -c "
import json,sys
n=int(sys.argv[1])
unit='Service auth-gateway returned 503 after upstream timeout at 14:%02d:%02d on node worker-%d. '
reps=max(1, int(n/28.05))
body=''.join(unit % (i%60, (i*7)%60, i%9) for i in range(reps))
print(json.dumps({'messages':[{'role':'user','content':body+'\n\nName the single most frequent failure mode in one short sentence.'}],'max_tokens':48,'temperature':0.1,'cache_prompt':False}))
" "$FILL")

  BIGRES=$(echo "$BIG" | curl -s --max-time 900 "http://127.0.0.1:${PORT}/v1/chat/completions" \
    -H 'content-type: application/json' --data-binary @- \
    | jq -c '{timings: (.timings // {}), finish: .choices[0].finish_reason, err: .error}')

  sleep 1
  VRAM_PEAK=$(gpu_for_pid "$PID")
  HWM_AFTER=$(awk '/^VmHWM:/{print $2}' /proc/$PID/status)
  ANON_AFTER=$(awk '/^RssAnon:/{print $2}' /proc/$PID/status)

  ALIVE=0; kill -0 "$PID" 2>/dev/null && ALIVE=1

  jq -nc \
    --argjson ctx "$CTX" --arg load "$LOAD" \
    --argjson vram "$VRAM" --argjson vramPeak "$VRAM_PEAK" \
    --argjson rssKb "$RSS" --argjson anonKb "$ANON" --argjson anonAfterKb "$ANON_AFTER" \
    --argjson hwmKb "$HWM" --argjson hwmAfterKb "$HWM_AFTER" \
    --argjson memAvailKb "$MEMFREE" --argjson swapFreeKb "$SWAP" \
    --argjson short "$SHORT" --argjson big "$BIGRES" --argjson alive "$ALIVE" \
    '{ctx:$ctx, status:"OK", loadSeconds:($load|tonumber|.*100|round/100),
      vramMiB:$vram, vramPeakMiB:$vramPeak,
      rssMB:($rssKb/1024|round), anonMB:($anonKb/1024|round), anonAfterMB:($anonAfterKb/1024|round),
      hwmMB:($hwmKb/1024|round), hwmAfterMB:($hwmAfterKb/1024|round),
      hostMemAvailableMB:($memAvailKb/1024|round), hostSwapFreeMB:($swapFreeKb/1024|round),
      short:$short, large:$big, survived:($alive==1)}' >> "$OUT"

  tail -5 "$LOG" >&2
  kill "$PID" 2>/dev/null
  for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  rm -f "$LOG"
  sleep 3
done

echo "--- results in $OUT ---" >&2
