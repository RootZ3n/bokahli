#!/usr/bin/env bash
#
# Bokahli — put the Q2_K control deployment back, exactly as it was.
#
# A campaign that swaps models needs one command that ends it, and that command
# has to restore a *specific* configuration rather than whatever the last
# measurement happened to leave behind. This writes the control's runtime.env
# byte for byte, restarts the runtime, and then refuses to claim success on
# anything it has not checked.
#
# ## Why the original profile and not the fastest one
#
# The 2026-08-21 campaign measured `--n-cpu-moe 24` as substantially faster than
# the control's `--cpu-moe` on the same artifact, same context and same sampler.
# It is not restored here. Restoring the control means restoring the control;
# changing its placement would be selecting a new production profile, and that
# is an operator's decision made against a report, not a side effect of the tool
# that cleaned up after the measurements. The measured numbers are in the
# campaign report and the change is one line in this file when someone decides
# to make it.
#
# The values below are the defaults `scripts/runtime-exec.sh` applies when the
# placement variables are absent — `--n-gpu-layers 999 --cpu-moe --flash-attn on
# --reasoning off` — so this file is the pre-campaign runtime.env unchanged,
# and the served argv is identical to the one Phase 1 pinned.
#
#   scripts/restore-control.sh [--verify-only]
#
set -euo pipefail

RUNTIME_ENV="$HOME/.config/bokahli/runtime.env"
CONTROL_MODEL=qwen3.5-35b-a3b.q2-k
CONTROL_DIGEST=sha256:49533d47d170c0dad00e38f3aab0d8a5556654caa8144a7e6f3480c8e6761201
CONTROL_PATH=/home/zen/models/Qwen_Qwen3.5-35B-A3B-Q2_K.gguf
CPUS=0-7,10-23

die() { echo "restore-control: $*" >&2; exit 1; }

if [[ "${1:-}" != "--verify-only" ]]; then
  cat > "$RUNTIME_ENV" <<EOF
# Bokahli inference runtime — explicit settings, no defaults relied upon.
# Installed to ~/.config/bokahli/runtime.env
BOKAHLI_MODEL_PATH=$CONTROL_PATH
BOKAHLI_MODEL_ALIAS=$CONTROL_MODEL
BOKAHLI_RUNTIME_PORT=8081
# Context size chosen from measurement, not from the model's 262144 train context.
# See docs/phase1/measurements/context-tiers.md
BOKAHLI_CTX=32768
# One loaded model, one inference slot, one active request.
BOKAHLI_SLOTS=1

# Placement. These are scripts/runtime-exec.sh's own defaults, written
# explicitly so the control's profile is stated rather than inherited:
#   999 layers requested, every MoE expert in system RAM, flash attention on,
#   reasoning suppressed.
BOKAHLI_GPU_LAYERS=999
BOKAHLI_CPU_MOE=all
BOKAHLI_FLASH_ATTN=on
BOKAHLI_REASONING=off

# Refuse to start unless CUDA is genuinely usable and the model lands on the GPU.
BOKAHLI_REQUIRE_GPU=1
BOKAHLI_GPU_WAIT_SECONDS=90
EOF
  echo "wrote $RUNTIME_ENV"
  systemctl --user restart bokahli-runtime.service
  # The API stays up across a backend restart by design, but it caches facts
  # against the backend instance and will re-probe on its own. Restarted here
  # anyway so the control is verified against a cold, fully re-attested API
  # rather than one that might be serving a cached observation.
  systemctl --user restart bokahli.service
fi

echo "waiting for the API…"
for _ in $(seq 1 180); do
  curl -sf --max-time 2 http://127.0.0.1:8080/health/live >/dev/null 2>&1 && break
  sleep 1
done

TOKEN="$(cat "$HOME/.config/bokahli/token")"
READY="$(curl -sf --max-time 120 http://127.0.0.1:8080/health/ready -H "Authorization: Bearer $TOKEN")" \
  || die "/health/ready did not answer"

echo "$READY" | CONTROL_MODEL="$CONTROL_MODEL" CONTROL_DIGEST="$CONTROL_DIGEST" node -e '
let raw = ""; process.stdin.on("data", (c) => { raw += c; }); process.stdin.on("end", () => {
  const d = JSON.parse(raw);
  const b = d.attestation?.binding ?? {};
  const p = d.devicePlacement ?? {};
  const t = d.tokenizer ?? {};
  const inv = d.runtimeInvocation ?? {};
  const problems = [];
  const want = process.env.CONTROL_MODEL, wantDigest = process.env.CONTROL_DIGEST;
  if (d.status !== "ready") problems.push(`status ${d.status}`);
  if (d.runtime?.attested !== true) problems.push("runtime is not attested");
  if (b.modelId !== want) problems.push(`serving ${b.modelId}, not ${want}`);
  if (b.artifactDigest !== wantDigest) problems.push(`digest ${b.artifactDigest}`);
  if (p.backendHoldsDevice !== true) problems.push("backend does not hold the device");
  if (t.encodeCanaryVerified !== true) problems.push("encode canary unverified");
  if (t.decodeCanaryVerified !== true) problems.push("decode canary unverified");
  if (inv.requestedGpuLayers !== 999) problems.push(`ngl ${inv.requestedGpuLayers}`);
  if (inv.cpuOffloadEnabled !== true) problems.push("expert offload is not enabled");
  if (inv.cpuMoeLayers !== null) problems.push(`--n-cpu-moe ${inv.cpuMoeLayers}: not the control profile`);
  if (inv.requestedReasoning !== "off") problems.push(`reasoning ${inv.requestedReasoning}`);
  if (inv.requestedContextTokens !== 32768) problems.push(`ctx ${inv.requestedContextTokens}`);
  if (inv.requestedSlots !== 1) problems.push(`slots ${inv.requestedSlots}`);
  if (problems.length) {
    console.error("control NOT restored:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log(`control restored: ${b.modelId}`);
  console.log(`  digest     ${b.artifactDigest}`);
  console.log(`  runtime    ${d.runtime.build}  instance ${b.backendInstanceId?.slice(0, 16)}`);
  console.log(`  placement  ngl=${inv.requestedGpuLayers} cpu-moe=all flash=${inv.flashAttention} ` +
    `reasoning=${inv.requestedReasoning} ctx=${inv.requestedContextTokens} slots=${inv.requestedSlots}`);
  console.log(`  device     held=${p.backendHoldsDevice} vram=${p.backendVramMiB} MiB`);
  console.log(`  tokenizer  ${t.canarySuiteId} encode=${t.encodeCanaryVerified} decode=${t.decodeCanaryVerified}`);
  console.log(`  structured ${d.structuredOutput?.constrained === true ? "constrained (confirmed)" : "unconfirmed"}`);
});
' || die "attestation check failed"

# ── thread affinity ──────────────────────────────────────────────────────────
#
# Re-checked rather than assumed. A restart is exactly when a confinement is
# lost, and physical core 4 computes wrong answers from Node's base64 encoder at
# roughly 1 in 1000 with no machine-check exception.
for unit in bokahli-runtime.service bokahli.service; do
  pid="$(systemctl --user show "$unit" -p MainPID --value)"
  [[ "$pid" != "0" ]] || die "$unit has no main pid"
  bad=0
  for t in /proc/"$pid"/task/*; do
    aff="$(taskset -pc "$(basename "$t")" 2>/dev/null | sed 's/.*list: //')"
    [[ "$aff" == "$CPUS" ]] || { echo "  NONCONFORMING $unit tid=$(basename "$t") aff=$aff" >&2; bad=1; }
  done
  [[ "$bad" -eq 0 ]] || die "$unit has threads outside $CPUS"
  echo "  affinity   $unit pid=$pid all threads on $CPUS"
done

# ── listeners and authentication ─────────────────────────────────────────────
ss -tlnp 2>/dev/null | grep -E '127\.0\.0\.1:(8080|8081)|100\.115\.140\.2:8080' | sed 's/^/  listener   /'
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8080/health/ready)"
[[ "$code" == "401" ]] || die "an unauthenticated /health/ready returned $code, expected 401"
echo "  auth       unauthenticated /health/ready → 401"

echo
echo "The Q2_K control is restored and serving."
