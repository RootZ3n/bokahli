#!/usr/bin/env bash
#
# Post-start placement assertion for bokahli-runtime.service.
#
# The runtime is loaded and answering /health by the time this runs. That says
# nothing about *where* it loaded. A CUDA-serving llama-server holds
# /dev/nvidia-uvm open; a CPU-only one does not, and is otherwise
# indistinguishable — same build, same artifact, same digest, same attestation,
# roughly a third of the decode rate.
#
# scripts/require-gpu.sh proves CUDA was available before the load; this proves
# the load actually used it. Both are needed: the first can pass and the second
# still fail if the device is lost between probe and load.
set -uo pipefail

port="${BOKAHLI_RUNTIME_PORT:-8081}"
require="${BOKAHLI_REQUIRE_GPU:-1}"
# The artifact is served with --cpu-moe, so the GPU-resident share is the
# non-expert tensors plus KV cache: ~2.4 GiB measured. The floor only has to be
# well above incidental desktop allocations and well below that.
floor_mib="${BOKAHLI_GPU_MIN_VRAM_MIB:-512}"
grace_seconds="${BOKAHLI_GPU_PLACEMENT_GRACE_SECONDS:-15}"

log() { printf 'bokahli-gpu-placement: %s\n' "$*" >&2; }

if [[ "$require" != "1" ]]; then
  log "BOKAHLI_REQUIRE_GPU=$require — placement not asserted."
  exit 0
fi

# Find our own backend the same way the API does: scan /proc for a llama-server
# whose argv carries this port. No dependency on $MAINPID expansion, and no
# helper binary that a minimal service PATH might not resolve.
pids=()
for d in /proc/[0-9]*; do
  cmdline="$d/cmdline"
  [[ -r "$cmdline" ]] || continue
  mapfile -d '' -t argv < "$cmdline" 2>/dev/null || continue
  (( ${#argv[@]} )) || continue
  [[ "${argv[0]}" == *llama-server ]] || continue
  for a in "${argv[@]}"; do
    if [[ "$a" == "$port" ]]; then pids+=("${d#/proc/}"); break; fi
  done
done

if (( ${#pids[@]} == 0 )); then
  log "FAILED: no llama-server process found serving port $port."
  exit 1
fi

# Ask the driver, not /proc/<pid>/fd.
#
# The obvious check — does the process hold an open /dev/nvidia-uvm handle — is
# correct but unavailable here: this script runs inside the unit's sandbox, and
# any mount-namespacing option (PrivateTmp, ProtectControlGroups,
# ProtectKernelTunables are all set) gives the unit a fresh procfs whose
# /proc/<pid>/fd entries for sibling processes cannot be read. Argv is still
# readable, so the pid is found; only the descriptor list is hidden. Measured,
# not assumed: the same script passes in a login shell and fails under any one
# of those three properties.
#
# nvidia-smi's compute-app table answers the same question from the driver's
# side and works in the sandbox. A CPU-only llama-server never appears in it.
for attempt in $(seq 1 "$grace_seconds"); do
  apps="$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null)" || apps=""
  for pid in "${pids[@]}"; do
    mib="$(awk -F', *' -v p="$pid" '$1 == p { print $2 }' <<<"$apps" | head -1)"
    if [[ -n "$mib" ]] && (( mib >= floor_mib )); then
      log "GPU placement confirmed: pid $pid holds ${mib} MiB of VRAM"
      exit 0
    fi
  done
  sleep 1
done

log "FAILED: llama-server (pid ${pids[*]}) loaded WITHOUT the GPU."
log "the driver reports no compute allocation of at least ${floor_mib} MiB for it after ${grace_seconds}s,"
log "so the model is resident in system RAM. It would serve the correct artifact,"
log "attest correctly, and run at roughly a third of the expected decode rate."
log "Refusing to present that as healthy."
log "diagnose with: nvidia-smi --query-compute-apps=pid,used_memory --format=csv"
log "to serve on CPU deliberately, set BOKAHLI_REQUIRE_GPU=0 in ~/.config/bokahli/runtime.env"
exit 1
