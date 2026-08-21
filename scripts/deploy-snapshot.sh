#!/usr/bin/env bash
#
# Bokahli — capture what is deployed now, so it can be put back.
#
# Prepared, not executed. Nothing here restarts a service, touches
# bokahli-runtime.service, moves a Git ref, or deletes anything: it copies the
# built API artifacts and the identity of everything around them into a
# timestamped, permission-restricted directory and prints the manifest.
#
# The rollback it enables is `deploy-restore.sh`, which copies those artifacts
# back and restarts the API. Neither script rewrites source history. An earlier
# plan proposed `git reset --hard`, which discards work rather than restoring a
# deployment, and would have taken the operator's uncommitted tree with it if
# anything were in flight.
#
#   scripts/deploy-snapshot.sh            # capture
#   scripts/deploy-snapshot.sh --verify   # re-check the newest snapshot
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${BOKAHLI_ROLLBACK_STORE:-$HOME/.local/state/bokahli/rollback}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$STORE/$STAMP"

# The artifacts the API is actually served from. Deliberately *not* the whole
# repository: source is in Git and does not need copying, and a snapshot that
# includes node_modules is one nobody keeps.
ARTIFACT_DIRS=(
  packages/contracts/dist
  packages/catalog/dist
  packages/qualification/dist
  packages/tasks/dist
  packages/runtime/dist
  packages/velum/dist
  packages/server/dist
)

# Configuration whose *identity* is recorded, never its contents. These files
# hold the bearer token and the runtime API key; a rollback directory that
# contained them would be a second place a secret lives.
CONFIG_FILES=(
  "$HOME/.config/bokahli/shared.env"
  "$HOME/.config/bokahli/bokahli.env"
  "$HOME/.config/bokahli/runtime.env"
)

UNIT_FILES=(
  "$HOME/.config/systemd/user/bokahli.service"
  "$HOME/.config/systemd/user/bokahli-runtime.service"
)

verify() {
  local dir="$1"
  echo "verifying $dir"
  ( cd "$dir/artifacts" && sha256sum -c ../manifest.sha256 --quiet ) \
    && echo "  artifacts: all files match manifest.sha256"
}

if [[ "${1:-}" == "--verify" ]]; then
  latest="$(ls -1d "$STORE"/*/ 2>/dev/null | sort | tail -1 || true)"
  [[ -n "$latest" ]] || { echo "no snapshot in $STORE" >&2; exit 1; }
  verify "${latest%/}"
  exit 0
fi

umask 077
mkdir -p "$DEST/artifacts"
chmod 700 "$STORE" "$DEST"

# ── the artifacts ────────────────────────────────────────────────────────────
for d in "${ARTIFACT_DIRS[@]}"; do
  if [[ -d "$ROOT/$d" ]]; then
    mkdir -p "$DEST/artifacts/$d"
    cp -a "$ROOT/$d/." "$DEST/artifacts/$d/"
  fi
done
( cd "$DEST/artifacts" && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../manifest.sha256 )

# ── the identity of everything else ──────────────────────────────────────────
{
  echo "capturedAt: $STAMP"
  echo "host: $(hostname)"
  echo "node: $(readlink -f "$(command -v node)") $(node -v)"
  echo "nodeSha256: $(sha256sum "$(readlink -f "$(command -v node)")" | cut -d' ' -f1)"
  echo
  echo "# git — recorded, never moved. Rollback restores artifacts, not history."
  echo "gitHead: $(git -C "$ROOT" rev-parse HEAD)"
  echo "gitBranch: $(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
  echo "gitDescribe: $(git -C "$ROOT" describe --always --dirty)"
  echo "gitStatusLines: $(git -C "$ROOT" status --porcelain | wc -l)"
  echo
  echo "# services — identity only; this script starts and stops nothing."
  for u in bokahli.service bokahli-runtime.service; do
    echo "$u:"
    systemctl --user show "$u" \
      -p MainPID -p NRestarts -p ExecMainStartTimestamp \
      -p ExecMainStartTimestampMonotonic -p ActiveState -p FragmentPath 2>/dev/null \
      | sed 's/^/  /'
  done
  echo
  echo "# unit files — digest, so a changed unit is visible at restore time."
  for f in "${UNIT_FILES[@]}"; do
    [[ -f "$f" ]] && echo "  $(sha256sum "$f" | cut -d' ' -f1)  ${f/#$HOME/\~}"
  done
  echo
  echo "# environment files — digest ONLY. These hold the bearer token and the"
  echo "# runtime API key; their contents are never copied here."
  for f in "${CONFIG_FILES[@]}"; do
    [[ -f "$f" ]] && echo "  $(sha256sum "$f" | cut -d' ' -f1)  ${f/#$HOME/\~}"
  done
  echo
  echo "# listeners at capture time"
  ss -tlnp 2>/dev/null | grep -E '127\.0\.0\.1:(8080|8081)|100\.115\.140\.2:8080' | sed 's/^/  /' || true
} > "$DEST/identity.txt"

chmod -R go-rwx "$DEST"
ln -sfn "$DEST" "$STORE/latest"

cat <<EOF
snapshot: $DEST
  artifacts: $(find "$DEST/artifacts" -type f | wc -l) files
  manifest:  $DEST/manifest.sha256
  identity:  $DEST/identity.txt
  mode:      $(stat -c '%a' "$DEST") (owner only)
  latest ->  $STORE/latest

Nothing was restarted, signalled or deleted. Restore with:
  scripts/deploy-restore.sh $STAMP
EOF
