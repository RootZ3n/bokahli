#!/usr/bin/env bash
#
# Bokahli × Luak — run one Stage against one artifact, exclusively.
#
# The two halves of a campaign step, in the only order that makes them mean
# anything:
#
#   1. Swap the runtime to this artifact on this placement profile, prove the
#      previous one released the device and the port, and re-attest what is now
#      serving. `measure-placement.mjs --swap-only` does all of it, and is the
#      same code path the throughput harness uses — a second swapper would agree
#      with the first until the day it did not, and that day the campaign would
#      be measuring a machine it had not cleared.
#
#   2. Run the Stage. Luak drives Bokahli over HTTP, sequentially, with its own
#      per-attempt precondition re-checking the deployment before every request.
#      If the runtime restarts mid-Stage the run aborts rather than pooling two
#      deployments under one evidence key.
#
# Every artifact gets its own directory of records, completions and identity,
# per regime. Nothing is merged here; merging is what the exporter refuses.
#
#   scripts/campaign-stage.sh <modelId> <profile.json> <suiteId> <schema.json> \
#                             <outDir> [repeats] [split]
#
# `split` defaults to `evaluation`, which is the Stage A bar: a held-out subset,
# and the only split the exporter will emit as qualification evidence without
# being told to. Stage B passes `both` to run the whole fixture pack — a wider
# measurement, and one whose development-split attempts are for reading rather
# than for export.
#
set -euo pipefail

MODEL="${1:?modelId}"
PROFILE="${2:?profile json}"
SUITE="${3:?suiteId}"
SCHEMA="${4:?output schema json}"
OUTDIR="${5:?output directory}"
REPEATS="${6:-3}"
SPLIT="${7:-evaluation}"

BOKAHLI=/home/zen/repos/bokahli
LUAK=/home/zen/repos/luak
CPUS=0-7,10-23

echo "══ ${MODEL} — ${SUITE} × ${REPEATS} (${SPLIT}) ═══════════════════════════"
mkdir -p "$OUTDIR"

echo "── swapping runtime"
taskset -c "$CPUS" node "$BOKAHLI/scripts/measure-placement.mjs" \
  --plan "$PROFILE" --swap-only \
  --out "$OUTDIR/${MODEL}.swap.json"

# The swap either produced an attested deployment serving this exact artifact or
# it did not. Running a Stage against a deployment that failed to attest would
# produce records that look entirely normal and describe something else.
node -e '
const r = require(process.argv[1]).results[0];
const served = r.attestation?.binding?.modelId ?? null;
const problems = [];
if (r.aborted) problems.push(r.aborted);
if (served !== process.argv[2]) problems.push(`served ${served}, expected ${process.argv[2]}`);
if (r.attestation?.devicePlacement?.backendHoldsDevice !== true) problems.push("backend does not hold the device");
if (r.affinity?.conforming !== true) problems.push(`affinity ${JSON.stringify(r.affinity?.distinct)}`);
if (!r.teardown?.released) problems.push("previous runtime did not release");
if (r.unavailable?.chat?.is5xx) problems.push("Bokahli produced a 5xx while the backend was absent");
if (r.unavailable?.chat?.producedCompletion) problems.push("Bokahli fabricated a completion with no backend");
if (problems.length) { console.error("swap refused:\n  " + problems.join("\n  ")); process.exit(1); }
console.log(`  attested ${served} | vram ${r.attestation.devicePlacement.backendVramMiB} MiB | ` +
  `canary ${r.attestation.tokenizer?.canarySuiteId} enc=${r.attestation.tokenizer?.encodeCanaryVerified} ` +
  `dec=${r.attestation.tokenizer?.decodeCanaryVerified} | ` +
  `constrained=${r.attestation.structuredOutput?.constrained} | cold ${r.start.coldLoadMs} ms`);
' "$OUTDIR/${MODEL}.swap.json" "$MODEL"

echo "── running stage"
taskset -c "$CPUS" node "$LUAK/scripts/run-local-stage.mjs" \
  --model "$MODEL" \
  --suite "$SUITE" \
  --repeats "$REPEATS" \
  --split "$SPLIT" \
  --regimes unconstrained,json_schema \
  --schema "$SCHEMA" \
  --out-dir "$OUTDIR"
