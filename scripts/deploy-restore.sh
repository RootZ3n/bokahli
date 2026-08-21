#!/usr/bin/env bash
#
# Bokahli — put back the API build a snapshot captured.
#
# Prepared, not executed. What it does and does not do:
#
#   - copies the captured `dist` trees back over the current ones, after
#     verifying every file against the snapshot's manifest;
#   - moves the *current* build aside first, into the same store, so a failed
#     rollback is still diagnosable and nothing is destroyed;
#   - restarts `bokahli.service` only.
#
#   - does NOT touch `bokahli-runtime.service`. The model stays loaded, the GPU
#     is not reallocated, and VRAM is not disturbed.
#   - does NOT move any Git ref, check anything out, or discard working files.
#     The source tree is the operator's; a rollback is about what is *deployed*.
#   - does NOT reboot, change firmware, offline a CPU, or edit a unit file.
#   - does NOT write to the environment files. It verifies their digests against
#     the snapshot and refuses if they changed, because a build restored against
#     configuration it never ran with is not the deployment that was captured.
#
#   scripts/deploy-restore.sh <stamp|latest> [--dry-run]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${BOKAHLI_ROLLBACK_STORE:-$HOME/.local/state/bokahli/rollback}"
WHICH="${1:-latest}"
DRY="${2:-}"
SRC="$STORE/$WHICH"

[[ -d "$SRC" ]] || { echo "no snapshot at $SRC" >&2; exit 1; }
[[ -f "$SRC/manifest.sha256" ]] || { echo "$SRC has no manifest" >&2; exit 1; }

echo "restoring from $SRC"

# ── 1. the snapshot must be intact before anything is replaced ───────────────
( cd "$SRC/artifacts" && sha256sum -c ../manifest.sha256 --quiet ) \
  || { echo "snapshot failed verification; refusing to restore" >&2; exit 1; }
echo "  manifest verified: $(wc -l < "$SRC/manifest.sha256") files"

# ── 2. configuration must be the configuration it ran with ──────────────────
fail=0
while read -r want path; do
  [[ -n "${want:-}" ]] || continue
  expanded="${path/#\~/$HOME}"
  [[ -f "$expanded" ]] || { echo "  MISSING $path" >&2; fail=1; continue; }
  got="$(sha256sum "$expanded" | cut -d' ' -f1)"
  if [[ "$got" != "$want" ]]; then
    echo "  CHANGED $path (snapshot $want, now $got)" >&2
    fail=1
  fi
done < <(sed -n '/environment files/,/^$/p' "$SRC/identity.txt" | awk '/^  [0-9a-f]{64}/ {print $1, $2}')
if [[ "$fail" -ne 0 ]]; then
  echo "configuration differs from the snapshot; restore it deliberately or re-snapshot" >&2
  exit 1
fi
echo "  configuration digests match"

if [[ "$DRY" == "--dry-run" ]]; then
  echo "dry run: nothing copied, nothing restarted"
  exit 0
fi

# ── 3. set the current build aside; never delete it ─────────────────────────
ASIDE="$STORE/failed-$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$ASIDE/artifacts"
chmod 700 "$ASIDE"
while IFS= read -r d; do
  [[ -d "$ROOT/$d" ]] || continue
  mkdir -p "$ASIDE/artifacts/$d"
  cp -a "$ROOT/$d/." "$ASIDE/artifacts/$d/"
done < <(cd "$SRC/artifacts" && find . -mindepth 2 -maxdepth 2 -type d -name dist | sed 's|^\./||')
cp -a "$ROOT"/../*.log "$ASIDE/" 2>/dev/null || true
journalctl --user -u bokahli.service -n 2000 --no-pager > "$ASIDE/bokahli.journal.txt" 2>/dev/null || true
echo "  current build and logs preserved at $ASIDE"

# ── 4. copy the captured artifacts back ─────────────────────────────────────
( cd "$SRC/artifacts" && find . -mindepth 1 -type d -print0 ) | while IFS= read -r -d '' d; do
  mkdir -p "$ROOT/${d#./}"
done
cp -a "$SRC/artifacts/." "$ROOT/"
echo "  artifacts restored"

# ── 5. restart the API alone ────────────────────────────────────────────────
RUNTIME_PID_BEFORE="$(systemctl --user show bokahli-runtime.service -p MainPID --value 2>/dev/null || echo '')"
systemctl --user restart bokahli.service
sleep 2
RUNTIME_PID_AFTER="$(systemctl --user show bokahli-runtime.service -p MainPID --value 2>/dev/null || echo '')"

# ── 6. prove what came back ─────────────────────────────────────────────────
echo
echo "post-restore:"
systemctl --user show bokahli.service -p MainPID -p NRestarts -p ActiveState | sed 's/^/  /'
echo "  runtime pid before=$RUNTIME_PID_BEFORE after=$RUNTIME_PID_AFTER"
[[ "$RUNTIME_PID_BEFORE" == "$RUNTIME_PID_AFTER" ]] \
  && echo "  runtime untouched, model still loaded" \
  || echo "  WARNING: the runtime pid changed; it should not have" >&2
curl -sf --max-time 10 http://127.0.0.1:8080/health/live | sed 's/^/  /' || echo "  /health/live did not answer" >&2
ss -tlnp 2>/dev/null | grep -E '127\.0\.0\.1:(8080|8081)|100\.115\.140\.2:8080' | sed 's/^/  /' || true

cat <<EOF

Restored build identity is in $SRC/identity.txt (gitHead, node digest, unit
digests). The failed build is kept at $ASIDE — remove it deliberately, once the
deployment is settled, with:
  rm -rf $ASIDE
EOF
