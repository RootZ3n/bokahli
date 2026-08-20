#!/usr/bin/env bash
#
# GPU precondition for bokahli-runtime.service.
#
# Why this exists
# ---------------
# On the 2026-08-20 unattended reboot, llama-server started 1.23 s before the
# `nvidia_uvm` kernel module was loaded. CUDA initialisation failed with
# "unknown error", llama.cpp printed "no usable GPU found", ignored
# --n-gpu-layers, and loaded the whole 12.58 GiB artifact into system RAM. It
# then served correctly for hours at roughly a third of the expected decode
# rate (19.9 tok/s against a measured 62 tok/s), and every acceptance check
# still passed: the build matched the pin, the digest matched, the identity
# attested. Nothing in the stack could see the difference, because device
# placement was never part of what was checked.
#
# `nvidia_uvm` is loaded lazily, by the setuid helper /usr/bin/nvidia-modprobe,
# on behalf of the first process to open a CUDA context. Under
# NoNewPrivileges=true that helper cannot elevate, so the runtime unit could
# never load the module itself — it silently depended on some *other* GPU
# consumer having gone first.
#
# This script makes that dependency explicit and, failing that, loud:
#   1. load nvidia_uvm ourselves if it is not loaded yet;
#   2. prove CUDA actually initialises, using llama.cpp's own device probe —
#      the same ggml_cuda_init the server is about to run;
#   3. exit non-zero if it does not, so the unit fails visibly instead of
#      coming up degraded.
#
# Set BOKAHLI_REQUIRE_GPU=0 to serve on CPU deliberately. That is a choice an
# operator may make; it is not a state the machine may drift into unnoticed.
set -uo pipefail

require="${BOKAHLI_REQUIRE_GPU:-1}"
wait_seconds="${BOKAHLI_GPU_WAIT_SECONDS:-90}"
llama_bin="${BOKAHLI_LLAMA_BIN:-/home/zen/llama.cpp/build/bin/llama-server}"

log() { printf 'bokahli-gpu-precondition: %s\n' "$*" >&2; }

if [[ "$require" != "1" ]]; then
  log "BOKAHLI_REQUIRE_GPU=$require — skipping the GPU precondition."
  log "the runtime may load on CPU; decode throughput will be roughly a third of GPU-served rates."
  exit 0
fi

deadline=$(( SECONDS + wait_seconds ))
attempted_modprobe=0

while :; do
  if [[ ! -e /dev/nvidia-uvm ]]; then
    if (( attempted_modprobe == 0 )) && command -v nvidia-modprobe >/dev/null 2>&1; then
      attempted_modprobe=1
      log "/dev/nvidia-uvm absent; loading the UVM module via nvidia-modprobe"
      nvidia-modprobe -u -c 0 >/dev/null 2>&1 || \
        log "nvidia-modprobe could not load nvidia_uvm (this needs NoNewPrivileges=no); waiting instead"
    fi
  elif devices="$(timeout 30 "$llama_bin" --list-devices 2>/dev/null)"; then
    # The authoritative check: llama.cpp's own ggml_cuda_init. If this reports a
    # CUDA device, the server started next will find the same one.
    if grep -q '^\s*CUDA[0-9]' <<<"$devices"; then
      log "CUDA available: $(grep -m1 '^\s*CUDA[0-9]' <<<"$devices" | sed 's/^\s*//')"
      exit 0
    fi
    log "llama.cpp reports no CUDA device yet; retrying"
  fi

  if (( SECONDS >= deadline )); then
    log "FAILED: no usable CUDA device after ${wait_seconds}s."
    log "refusing to start: a CPU-only load would serve the correct artifact at roughly"
    log "a third of the expected rate, and nothing downstream can detect that."
    log "diagnose with: nvidia-smi -L ; ls -l /dev/nvidia-uvm ; ${llama_bin} --list-devices"
    log "to serve on CPU deliberately, set BOKAHLI_REQUIRE_GPU=0 in ~/.config/bokahli/runtime.env"
    exit 1
  fi
  sleep 1
done
