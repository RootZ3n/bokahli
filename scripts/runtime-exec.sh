#!/usr/bin/env bash
#
# Bokahli — build the runtime's argv from configuration, then become it.
#
# Why this exists
# ---------------
# The unit's ExecStart carried `--n-gpu-layers 999 --cpu-moe --flash-attn on
# --reasoning off` as literals. That was correct for one artifact and one
# placement, and it is exactly the shape a qualification campaign cannot use: a
# placement profile is a set of *requests*, comparing profiles means changing
# them, and changing them meant editing the unit file between measurements. A
# measurement whose configuration lives in a file somebody edits by hand between
# runs is a measurement whose configuration nobody can state afterwards.
#
# systemd cannot express "include this flag only when that variable is set" in
# an ExecStart line, so the decision moves here, where it can be read, tested
# and refused.
#
# ## exec, not run
#
# The last line is `exec`. This process *becomes* llama-server rather than
# supervising it, which is load-bearing three times over:
#
#   - Bokahli finds its backend by scanning /proc for a `llama-server` whose
#     argv carries the serving port, and reads placement flags from that same
#     argv. A wrapper that forked would leave a shell holding the pid systemd
#     tracks, and the flags would be read off the wrapper or not at all.
#   - `scripts/assert-gpu-placement.sh` matches `argv[0] == *llama-server` and
#     asks the driver about that pid.
#   - `KillMode=mixed` signals the main pid. A supervising shell would absorb
#     SIGTERM and leave the model loaded.
#
# ## What it refuses
#
# Every value is validated before exec, and an unrecognised one is a startup
# failure rather than a flag silently dropped. A dropped flag is the failure
# mode this whole campaign is about: a runtime that served the correct artifact
# at a third of the rate because a placement request went nowhere, attesting
# perfectly the entire time. A profile that cannot be started is loud; a profile
# that starts as something else is not.
set -euo pipefail

die() { echo "bokahli-runtime-exec: $*" >&2; exit 1; }

LLAMA="${BOKAHLI_LLAMA_BIN:-/home/zen/llama.cpp/build/bin/llama-server}"
[[ -x "$LLAMA" ]] || die "no llama-server at $LLAMA"

: "${BOKAHLI_MODEL_PATH:?BOKAHLI_MODEL_PATH is required}"
: "${BOKAHLI_MODEL_ALIAS:?BOKAHLI_MODEL_ALIAS is required}"
: "${BOKAHLI_RUNTIME_PORT:?BOKAHLI_RUNTIME_PORT is required}"
: "${BOKAHLI_CTX:?BOKAHLI_CTX is required}"
: "${BOKAHLI_SLOTS:?BOKAHLI_SLOTS is required}"
[[ -r "$BOKAHLI_MODEL_PATH" ]] || die "model is not readable: $BOKAHLI_MODEL_PATH"

# ── placement ────────────────────────────────────────────────────────────────
#
# Layers, and where the MoE experts live. These two decide the profile.
GPU_LAYERS="${BOKAHLI_GPU_LAYERS:-999}"
[[ "$GPU_LAYERS" =~ ^[0-9]+$ ]] || die "BOKAHLI_GPU_LAYERS must be a non-negative integer, got '$GPU_LAYERS'"

# off        every expert on the device, if it fits
# all        every expert in system RAM (--cpu-moe)
# <integer>  the first N layers' experts in system RAM (--n-cpu-moe N)
#
# Named rather than inferred from an empty string: "" and "0" and "unset" would
# otherwise all mean something slightly different, and the difference between
# "no expert offload" and "expert offload for zero layers" is a flag that is
# either present or absent in the argv Bokahli reads back.
CPU_MOE="${BOKAHLI_CPU_MOE:-all}"
MOE_ARGS=()
case "$CPU_MOE" in
  off)          ;;
  all)          MOE_ARGS=(--cpu-moe) ;;
  ''|*[!0-9]*)  die "BOKAHLI_CPU_MOE must be 'off', 'all', or an integer layer count, got '$CPU_MOE'" ;;
  *)            MOE_ARGS=(--n-cpu-moe "$CPU_MOE") ;;
esac

FLASH_ATTN="${BOKAHLI_FLASH_ATTN:-on}"
case "$FLASH_ATTN" in on|off|auto) ;; *) die "BOKAHLI_FLASH_ATTN must be on, off or auto" ;; esac

REASONING="${BOKAHLI_REASONING:-off}"
case "$REASONING" in on|off|auto) ;; *) die "BOKAHLI_REASONING must be on, off or auto" ;; esac

# ── what is deliberately absent ──────────────────────────────────────────────
#
# No mmproj, no draft model, no speculative decoding, no Eagle, no MTP, no LoRA.
# None of them is refused by a flag here because none of them is *offered*: this
# script constructs the whole argv, so a knob it does not write cannot be set by
# forgetting to disable it. A campaign comparing artifacts must compare
# artifacts, and an accelerator attached to one of them would make the fastest
# candidate the one with the most help.
exec "$LLAMA" \
  --model "$BOKAHLI_MODEL_PATH" \
  --alias "$BOKAHLI_MODEL_ALIAS" \
  --host 127.0.0.1 \
  --port "$BOKAHLI_RUNTIME_PORT" \
  --ctx-size "$BOKAHLI_CTX" \
  --parallel "$BOKAHLI_SLOTS" \
  --n-gpu-layers "$GPU_LAYERS" \
  "${MOE_ARGS[@]}" \
  --flash-attn "$FLASH_ATTN" \
  --reasoning "$REASONING" \
  --metrics \
  --api-key-file "$HOME/.config/bokahli/runtime-api-key" \
  --no-webui \
  --log-timestamps
