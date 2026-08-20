#!/usr/bin/env bash
# Phase 1 rollback: restore the pre-existing ad-hoc llama-server exactly as it
# ran before the cutover, and stop the Bokahli units.
#
# Captured from PID 25179 on 2026-08-20T10:25:39Z. See
# docs/phase1/evidence/01-process-identity.txt for the source of these values.
#
# NOTE: this restores the ORIGINAL configuration, including --host 0.0.0.0 with
# no authentication. It re-opens an unauthenticated inference endpoint to the
# LAN and the tailnet. Use only to recover service, and only deliberately.
set -uo pipefail

echo "stopping Bokahli units..."
systemctl --user stop bokahli.service 2>/dev/null || true
systemctl --user stop bokahli-runtime.service 2>/dev/null || true

echo "restoring original ad-hoc runtime on 0.0.0.0:8080 ..."
nohup /home/zen/llama.cpp/build/bin/llama-server \
  -m /home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf \
  --host 0.0.0.0 --port 8080 \
  -ngl 999 --cpu-moe -c 4096 --flash-attn on --reasoning off \
  > /tmp/llama-rollback.log 2>&1 &

for i in $(seq 1 120); do
  if curl -sf --max-time 2 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "restored: original runtime healthy on 0.0.0.0:8080 (log: /tmp/llama-rollback.log)"
    exit 0
  fi
  sleep 1
done
echo "ROLLBACK FAILED to become healthy within 120s; see /tmp/llama-rollback.log" >&2
exit 1
