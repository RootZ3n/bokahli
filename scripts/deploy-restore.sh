#!/usr/bin/env bash
#
# Bokahli — put back the API build a snapshot captured.
#
# The order is the design. Everything that can refuse, refuses before anything
# on disk changes:
#
#   1. take the store lock, or refuse
#   2. verify the snapshot seal, record, manifest and every file
#   3. check schema, inventory, repository and host binding
#   4. validate the deployment root and its seven trees
#   5. check configuration digests
#   6. copy the build being displaced into failed-<stamp>/, with its own
#      manifest and identity record
#   7. stage the snapshot into siblings of each tree and verify the staged copy
#   8. only then, bounded atomic renames — two per tree, fourteen in all
#
# A failure anywhere in 1-7 leaves the deployed build byte-identical. A failure
# during 8 is rolled back; a process killed during 8 leaves marker directories
# that the next run refuses to walk past until `--recover` finishes the job.
#
# It does NOT touch bokahli-runtime.service: the model stays loaded, the GPU is
# not reallocated, VRAM is not disturbed. It does NOT move a Git ref, check
# anything out, or discard working files — an earlier version of this plan
# proposed `git reset --hard`, which discards work rather than restoring a
# deployment. It does NOT reboot, change firmware, offline a CPU or edit a unit.
#
#   scripts/deploy-restore.sh <stamp|latest> [--dry-run] [--root <dir>]
#                             [--no-restart] [--recover]
#
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/deploy-inventory.sh
source "$ROOT_DEFAULT/scripts/deploy-inventory.sh"

STORE="${BOKAHLI_ROLLBACK_STORE:-$HOME/.local/state/bokahli/rollback}"
ROOT="${BOKAHLI_DEPLOY_ROOT:-$ROOT_DEFAULT}"
WHICH=""; DRY=no; RESTART=auto; RECOVER=no; ACCEPT_INV=""

die() { echo "deploy-restore: $*" >&2; exit 1; }
json_get() { node -e '
  const j=require(process.argv[1]); const v=j[process.argv[2]];
  process.stdout.write(v===undefined||v===null?"":String(v));' "$1" "$2"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY=yes ;;
    --no-restart) RESTART=no ;;
    --recover)    RECOVER=yes ;;
    --root)       ROOT="${2:?--root needs a directory}"; shift ;;
    --store)      STORE="${2:?--store needs a directory}"; shift ;;
    --accept-inventory) ACCEPT_INV="${2:?--accept-inventory needs an inventory id}"; shift ;;
    --*)          die "unknown argument: $1" ;;
    *)            [[ -z "$WHICH" ]] || die "unexpected argument: $1"; WHICH="$1" ;;
  esac
  shift
done
WHICH="${WHICH:-latest}"
ROOT="$(realpath -- "$ROOT" 2>/dev/null || die "no such deployment root: $ROOT")"

# Restarting a service makes sense only when the real deployment was replaced.
[[ "$RESTART" == auto ]] && { [[ "$ROOT" == "$ROOT_DEFAULT" ]] && RESTART=yes || RESTART=no; }

inv_lock "$STORE/.lock"

# ── recovery from an interrupted replacement ─────────────────────────────────
#
# Marker directories mean a previous run was killed between renames. Each tree
# is in exactly one of three states, and all three are recoverable because the
# displaced build was copied into failed-<stamp>/ before any rename began.
leftovers() {
  local t
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
    compgen -G "$ROOT/$t.displaced-*" >/dev/null 2>&1 && echo "$t"
    compgen -G "$ROOT/$t.deploy-staging-*" >/dev/null 2>&1 && echo "$t"
  done | LC_ALL=C sort -u
}

if [[ "$RECOVER" == yes ]]; then
  echo "recovering interrupted replacement under $ROOT"
  found=0
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
    for d in "$ROOT/$t.displaced-"*; do
      [[ -d "$d" ]] || continue
      found=1
      inv_require_confined "$ROOT" "$d"
      if [[ ! -e "$ROOT/$t" ]]; then
        mv -- "$d" "$ROOT/$t"; echo "  restored $t from $(basename "$d")"
      else
        rm -rf -- "$d"; echo "  discarded stale $(basename "$d") ($t is present)"
      fi
    done
    for d in "$ROOT/$t.deploy-staging-"*; do
      [[ -d "$d" ]] || continue
      found=1
      inv_require_confined "$ROOT" "$d"
      rm -rf -- "$d"; echo "  discarded staging $(basename "$d")"
    done
  done
  [[ "$found" -eq 1 ]] || echo "  nothing to recover"
  inv_validate_trees "$ROOT"
  echo "  all $(inv_tree_count) trees present"
  exit 0
fi

if [[ -n "$(leftovers)" ]]; then
  echo "deploy-restore: a previous replacement was interrupted; these trees have markers:" >&2
  leftovers | sed 's/^/  /' >&2
  die "run 'scripts/deploy-restore.sh --recover --root $ROOT' first"
fi

# ── 1-3. the snapshot must be intact and must be for this repository ─────────
SRC="$STORE/$WHICH"
[[ -d "$SRC" ]] || die "no snapshot at $SRC"
SRC="$(realpath -- "$SRC")"
echo "restoring from $SRC"

for f in snapshot.json snapshot.json.sha256 manifest.sha256; do
  [[ -f "$SRC/$f" ]] || die "$SRC has no $f"
done

sealed="$(cut -d' ' -f1 < "$SRC/snapshot.json.sha256")"
actual="$(sha256sum "$SRC/snapshot.json" | cut -d' ' -f1)"
[[ "$sealed" == "$actual" ]] || die "snapshot.json does not match its seal; refusing to restore"

schema="$(json_get "$SRC/snapshot.json" schema)"
invid="$(json_get "$SRC/snapshot.json" inventoryId)"
repo="$(json_get "$SRC/snapshot.json" repoName)"
host="$(json_get "$SRC/snapshot.json" host)"
mdig="$(json_get "$SRC/snapshot.json" manifestSha256)"
fcount="$(json_get "$SRC/snapshot.json" fileCount)"
tcount="$(json_get "$SRC/snapshot.json" treeCount)"

[[ "$schema" == "$DEPLOY_SCHEMA_VERSION" ]] || die "snapshot schema '$schema' is not '$DEPLOY_SCHEMA_VERSION'"
[[ "$repo"   == "$DEPLOY_REPO_NAME" ]]      || die "snapshot is for repository '$repo', not '$DEPLOY_REPO_NAME'"
[[ "$host"   == "$(hostname)" ]]            || die "snapshot was taken on host '$host', not '$(hostname)'"

# The snapshot's inventory revision must be one this tool knows, and its
# recorded name and recorded id must agree — a record that names `v2-velum`
# while carrying the six-tree id is refused rather than reconciled.
SNAP_REV="$(json_get "$SRC/snapshot.json" inventoryRevision)"
KNOWN_REV="$(inv_revision_for_id "$invid" || true)"
[[ -n "$KNOWN_REV" ]] \
  || die "snapshot was taken against an artifact inventory this tool does not know ($invid)"
[[ "$KNOWN_REV" == "$SNAP_REV" ]] \
  || die "snapshot names revision '$SNAP_REV' but its id is revision '$KNOWN_REV'"

# Restoring anything other than the current surface is a deliberate act. It
# changes which trees the deployment holds, so it must be named on the command
# line by exact id; there is no flag that means "whatever the snapshot says".
if [[ "$invid" != "$(inv_id_of "$DEPLOY_REVISION_CURRENT")" ]]; then
  [[ "$ACCEPT_INV" == "$invid" ]] || die \
"this snapshot uses inventory revision '$SNAP_REV' ($invid), not the current
  '$DEPLOY_REVISION_CURRENT' ($(inv_id_of "$DEPLOY_REVISION_CURRENT")).
  Restoring it will remove the trees the current revision has and it does not.
  Re-run with: --accept-inventory $invid"
  echo "  accepting older inventory revision '$SNAP_REV' by explicit id"
fi
inv_use_revision "$SNAP_REV"
[[ "$tcount" == "$(inv_tree_count)" ]] || die "snapshot covers $tcount trees; revision $SNAP_REV has $(inv_tree_count)"

actual="$(sha256sum "$SRC/manifest.sha256" | cut -d' ' -f1)"
[[ "$mdig" == "$actual" ]] || die "manifest.sha256 does not match the sealed record"

# Every manifest path must belong to an inventory tree and stay inside it.
while read -r _ p; do
  case "$p" in
    /*|*..*) die "manifest holds an unsafe path: $p" ;;
  esac
  ok=no
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do [[ "$p" == "$t/"* ]] && ok=yes; done
  [[ "$ok" == yes ]] || die "manifest holds a path outside the inventory: $p"
done < "$SRC/manifest.sha256"

lines="$(wc -l < "$SRC/manifest.sha256")"
[[ "$lines" -eq "$fcount" ]] || die "manifest lists $lines files; record says $fcount"

( cd "$SRC/artifacts" && sha256sum -c ../manifest.sha256 --quiet --strict ) \
  || die "snapshot failed verification; refusing to restore"

n="$(find "$SRC/artifacts" -type f | wc -l)"
[[ "$n" -eq "$fcount" ]] || die "snapshot holds $n files but the manifest covers $fcount"

[[ -z "$(find "$SRC/artifacts" -type l -print -quit)" ]] \
  || die "snapshot contains a symlink; refusing to restore"

echo "  snapshot verified: $fcount files across $tcount trees (revision $SNAP_REV)"
echo "  kind: $(json_get "$SRC/snapshot.json" sourceKind), commit $(json_get "$SRC/snapshot.json" sourceCommit)"

# ── 4. the deployment root ───────────────────────────────────────────────────
inv_validate_root "$ROOT"
inv_reject_unexpected_trees "$ROOT" "$DEPLOY_REVISION_CURRENT"

# Trees the deployment currently has that this snapshot does not carry. They are
# preserved with everything else and then removed, so what is left is exactly
# the revision that was restored rather than a mixture of two.
RETIRED=()
while IFS= read -r ct; do
  keep=no
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do [[ "$ct" == "$t" ]] && keep=yes; done
  [[ "$keep" == no && -e "$ROOT/$ct" ]] && RETIRED+=("$ct")
done < <(inv_revision_trees "$DEPLOY_REVISION_CURRENT")
[[ "${#RETIRED[@]}" -eq 0 ]] \
  || echo "  trees to retire (preserved, then removed): ${RETIRED[*]}"

for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
  [[ ! -L "$ROOT/$t" ]] || die "deployed tree is a symlink: $t"
  [[ ! -e "$ROOT/$t" || -d "$ROOT/$t" ]] || die "deployed tree is not a directory: $t"
  inv_require_confined "$ROOT" "$ROOT/$t"
done
echo "  deployment root: $ROOT"

# ── 5. configuration must be the configuration it ran with ───────────────────
fail=0
while IFS=$'\t' read -r want path; do
  [[ -n "${want:-}" ]] || continue
  expanded="${path/#\~/$HOME}"
  if [[ ! -f "$expanded" ]]; then echo "  MISSING $path" >&2; fail=1; continue; fi
  got="$(sha256sum "$expanded" | cut -d' ' -f1)"
  [[ "$got" == "$want" ]] || { echo "  CHANGED $path" >&2; fail=1; }
done < <(node -e '
  const j=require(process.argv[1]);
  for (const c of j.configs||[]) console.log(c.sha256+"\t"+c.path);' "$SRC/snapshot.json")
[[ "$fail" -eq 0 ]] \
  || die "configuration differs from the snapshot; restore it deliberately or re-snapshot"
echo "  configuration digests match"

if [[ "$DRY" == yes ]]; then
  echo "dry run: nothing copied, nothing renamed, nothing restarted"
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# ── 6. preserve the build being displaced, before anything moves ─────────────
ASIDE="$STORE/failed-$STAMP"
umask 077
mkdir -p "$ASIDE/artifacts"; chmod 700 "$ASIDE"
present=0
while IFS= read -r t; do
  [[ -d "$ROOT/$t" ]] || continue
  mkdir -p "$ASIDE/artifacts/$t"
  cp -a "$ROOT/$t/." "$ASIDE/artifacts/$t/"
  present=$((present+1))
done < <(inv_revision_trees "$DEPLOY_REVISION_CURRENT")
if [[ "$present" -gt 0 ]]; then
  ( cd "$ASIDE/artifacts" && find . -type f -printf '%P\n' | LC_ALL=C sort | xargs -r sha256sum > ../manifest.sha256 )
  {
    echo "schema=$DEPLOY_SCHEMA_VERSION"
    echo "kind=displaced-build"
    echo "displacedAt=$STAMP"
    echo "displacedFrom=$ROOT"
    echo "replacedBySnapshot=$SRC"
    echo "replacedBySourceCommit=$(json_get "$SRC/snapshot.json" sourceCommit)"
    echo "inventoryId=$(inv_id_of "$DEPLOY_REVISION_CURRENT")"
    echo "inventoryRevision=$DEPLOY_REVISION_CURRENT"
    echo "restoredRevision=$SNAP_REV"
    echo "treeCount=$present"
    echo "fileCount=$(wc -l < "$ASIDE/manifest.sha256")"
    echo "manifestSha256=$(sha256sum "$ASIDE/manifest.sha256" | cut -d' ' -f1)"
    echo "gitHead=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  } > "$ASIDE/identity.txt"
  journalctl --user -u bokahli.service -n 2000 --no-pager > "$ASIDE/bokahli.journal.txt" 2>/dev/null || true
  chmod -R go-rwx "$ASIDE"
  echo "  displaced build preserved: $ASIDE ($present trees, $(wc -l < "$ASIDE/manifest.sha256") files, own manifest)"
else
  echo "  nothing deployed to preserve (all trees absent)"
fi

# ── 7. stage beside each tree, then verify the staged copy ───────────────────
#
# Verifying the staging rather than the snapshot closes the window where the
# snapshot changes between check and use: what gets renamed into place is
# exactly what was checked, because it is a private copy nobody else can reach.
staged=()
cleanup_staging() { local d; for d in "${staged[@]:-}"; do [[ -e "$d" ]] && rm -rf -- "$d"; done; }
trap 'cleanup_staging' ERR

for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
  s="$ROOT/$t.deploy-staging-$STAMP"
  inv_require_confined "$ROOT" "$s"
  [[ ! -e "$s" ]] || die "staging path already exists: $s"
  mkdir -p "$s"
  staged+=("$s")
  cp -a "$SRC/artifacts/$t/." "$s/"
done

# Check every staged file against the manifest, in the staged location.
tmpman="$(mktemp)"; trap 'rm -f "$tmpman"; cleanup_staging' ERR
while read -r d p; do
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
    if [[ "$p" == "$t/"* ]]; then printf '%s  %s\n' "$d" "$t.deploy-staging-$STAMP/${p#"$t"/}"; break; fi
  done
done < "$SRC/manifest.sha256" > "$tmpman"
( cd "$ROOT" && sha256sum -c "$tmpman" --quiet --strict ) \
  || { rm -f "$tmpman"; cleanup_staging; die "staged copy failed verification; deployed build untouched"; }
sn="$(for d in "${staged[@]}"; do find "$d" -type f; done | wc -l)"
[[ "$sn" -eq "$fcount" ]] \
  || { rm -f "$tmpman"; cleanup_staging; die "staged $sn files, expected $fcount; deployed build untouched"; }
rm -f "$tmpman"
echo "  staged and verified: $fcount files"

# ── 8. bounded atomic renames — two per tree, fourteen in all ────────────────
trap - ERR
done_trees=()
rename_rollback() {
  local t
  echo "  rolling back renames" >&2
  for ((i=${#done_trees[@]}-1; i>=0; i--)); do
    t="${done_trees[$i]}"
    [[ -d "$ROOT/$t" ]] && mv -- "$ROOT/$t" "$ROOT/$t.deploy-staging-$STAMP"
    [[ -d "$ROOT/$t.displaced-$STAMP" ]] && mv -- "$ROOT/$t.displaced-$STAMP" "$ROOT/$t"
  done
  cleanup_staging
}
for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
  if [[ -d "$ROOT/$t" ]]; then
    mv -- "$ROOT/$t" "$ROOT/$t.displaced-$STAMP" || { rename_rollback; die "could not displace $t"; }
  fi
  mv -- "$ROOT/$t.deploy-staging-$STAMP" "$ROOT/$t" || { rename_rollback; die "could not install $t"; }
  done_trees+=("$t")
done
for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do rm -rf -- "$ROOT/$t.displaced-$STAMP"; done
echo "  installed $(inv_tree_count) trees (${#done_trees[@]} × 2 renames)"

for t in "${RETIRED[@]:-}"; do
  [[ -n "$t" ]] || continue
  inv_require_confined "$ROOT" "$ROOT/$t"
  [[ -d "$ASIDE/artifacts/$t" ]] || die "refusing to retire $t: it was not preserved"
  rm -rf -- "$ROOT/$t"
  echo "  retired $t (preserved in $ASIDE)"
done

inv_validate_trees "$ROOT"
( cd "$ROOT" && sha256sum -c "$SRC/manifest.sha256" --quiet --strict ) \
  || die "post-restore verification failed"
echo "  post-restore verification: $fcount files match the snapshot"

# ── restart the API alone ────────────────────────────────────────────────────
if [[ "$RESTART" != yes ]]; then
  echo "  --no-restart: nothing was signalled"
  exit 0
fi

RUNTIME_BEFORE="$(systemctl --user show bokahli-runtime.service -p MainPID --value 2>/dev/null || echo '')"
RUNTIME_TICKS_BEFORE="$(systemctl --user show bokahli-runtime.service -p ExecMainStartTimestampMonotonic --value 2>/dev/null || echo '')"
systemctl --user restart bokahli.service
for _ in $(seq 1 60); do
  curl -sf --max-time 2 http://127.0.0.1:8080/health/live >/dev/null && break
  sleep 1
done
RUNTIME_AFTER="$(systemctl --user show bokahli-runtime.service -p MainPID --value 2>/dev/null || echo '')"
RUNTIME_TICKS_AFTER="$(systemctl --user show bokahli-runtime.service -p ExecMainStartTimestampMonotonic --value 2>/dev/null || echo '')"

echo
echo "post-restore:"
systemctl --user show bokahli.service -p MainPID -p NRestarts -p ActiveState | sed 's/^/  /'
if [[ "$RUNTIME_BEFORE" == "$RUNTIME_AFTER" && "$RUNTIME_TICKS_BEFORE" == "$RUNTIME_TICKS_AFTER" ]]; then
  echo "  runtime untouched (pid $RUNTIME_AFTER), model still loaded"
else
  echo "  WARNING: the runtime restarted; it should not have" >&2
fi
curl -sf --max-time 10 http://127.0.0.1:8080/health/live | sed 's/^/  /' || echo "  /health/live did not answer" >&2
ss -tlnp 2>/dev/null | grep -E '127\.0\.0\.1:(8080|8081)|100\.115\.140\.2:8080' | sed 's/^/  /' || true

echo
echo "Restored from $SRC (commit $(json_get "$SRC/snapshot.json" sourceCommit))."
echo "The displaced build is kept at $ASIDE — remove it deliberately once settled."
