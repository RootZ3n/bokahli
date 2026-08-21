#!/usr/bin/env bash
#
# Bokahli — capture a set of built API artifacts so it can be put back.
#
# Nothing here restarts a service, touches bokahli-runtime.service, moves a Git
# ref, or deletes anything. It copies the seven trees named by the canonical
# inventory into a timestamped, owner-only directory, seals a machine-readable
# record of what was captured, and prints the manifest.
#
#   scripts/deploy-snapshot.sh --kind running-deployment
#   scripts/deploy-snapshot.sh --kind committed-fallback --source <worktree> \
#                              --label 94f4d6c --note "..."
#   scripts/deploy-snapshot.sh --verify [<stamp|latest>]
#
# --kind is mandatory and has no default. A snapshot is only a rollback target
# if someone can tell what it is, and the one thing this repository has already
# learned the hard way is that a snapshot which *looks* like the running build
# and is not is worse than no snapshot at all. The two kinds are:
#
#   running-deployment  — the artifacts currently being served.
#   committed-fallback  — built from an exact commit in a clean worktree.
#                         Reproducible, reviewable, and NOT what is running.
#
set -euo pipefail

ROOT_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/deploy-inventory.sh
source "$ROOT_DEFAULT/scripts/deploy-inventory.sh"

STORE="${BOKAHLI_ROLLBACK_STORE:-$HOME/.local/state/bokahli/rollback}"
SOURCE="$ROOT_DEFAULT"
KIND=""; LABEL=""; NOTE=""; MODE="capture"; WHICH=""; INVENTORY="$DEPLOY_REVISION_CURRENT"

die() { echo "deploy-snapshot: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)  MODE="verify"; [[ "${2:-}" == --* || -z "${2:-}" ]] || { WHICH="$2"; shift; } ;;
    --source)  SOURCE="${2:?--source needs a directory}"; shift ;;
    --kind)    KIND="${2:?--kind needs a value}"; shift ;;
    --label)   LABEL="${2:?--label needs a value}"; shift ;;
    --note)    NOTE="${2:?--note needs a value}"; shift ;;
    --store)   STORE="${2:?--store needs a directory}"; shift ;;
    --inventory) INVENTORY="${2:?--inventory needs a revision name}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# ── verification of an existing snapshot ─────────────────────────────────────
#
# Checks the seal, then the record against the seal, then every file against the
# manifest the record names. Each step is refused independently, so a corrupt
# record and a corrupt file do not produce the same message.
verify_snapshot() {
  local dir="$1"
  [[ -d "$dir" ]] || die "no snapshot at $dir"
  [[ -f "$dir/snapshot.json" ]] || die "$dir has no snapshot.json"
  [[ -f "$dir/snapshot.json.sha256" ]] || die "$dir has no seal"
  [[ -f "$dir/manifest.sha256" ]] || die "$dir has no manifest"

  local sealed actual
  sealed="$(cut -d' ' -f1 < "$dir/snapshot.json.sha256")"
  actual="$(sha256sum "$dir/snapshot.json" | cut -d' ' -f1)"
  [[ "$sealed" == "$actual" ]] || die "snapshot.json does not match its seal (record was modified)"

  local schema inv repo mdigest fcount
  schema="$(json_get "$dir/snapshot.json" schema)"
  inv="$(json_get "$dir/snapshot.json" inventoryId)"
  repo="$(json_get "$dir/snapshot.json" repoName)"
  mdigest="$(json_get "$dir/snapshot.json" manifestSha256)"
  fcount="$(json_get "$dir/snapshot.json" fileCount)"

  [[ "$schema" == "$DEPLOY_SCHEMA_VERSION" ]] \
    || die "snapshot schema '$schema' is not '$DEPLOY_SCHEMA_VERSION'"
  local rev
  rev="$(inv_revision_for_id "$inv" || true)"
  [[ -n "$rev" ]] \
    || die "snapshot was taken against an artifact inventory this tool does not know ($inv)"
  [[ "$rev" == "$(json_get "$dir/snapshot.json" inventoryRevision)" ]] \
    || die "snapshot names revision '$(json_get "$dir/snapshot.json" inventoryRevision)' but its id is revision '$rev'"
  [[ "$repo" == "$DEPLOY_REPO_NAME" ]] \
    || die "snapshot is for repository '$repo', not '$DEPLOY_REPO_NAME'"

  actual="$(sha256sum "$dir/manifest.sha256" | cut -d' ' -f1)"
  [[ "$mdigest" == "$actual" ]] || die "manifest.sha256 does not match the sealed record"

  local lines
  lines="$(wc -l < "$dir/manifest.sha256")"
  [[ "$lines" -eq "$fcount" ]] || die "manifest lists $lines files; record says $fcount"

  ( cd "$dir/artifacts" && sha256sum -c ../manifest.sha256 --quiet --strict ) \
    || die "artifact files do not match the manifest"

  local n; n="$(find "$dir/artifacts" -type f | wc -l)"
  [[ "$n" -eq "$fcount" ]] \
    || die "artifacts hold $n files but the manifest covers $fcount (extra file present)"

  echo "  schema:    $schema"
  echo "  inventory: $rev ($(json_get "$dir/snapshot.json" treeCount) trees) $inv"
  echo "  kind:      $(json_get "$dir/snapshot.json" sourceKind)"
  echo "  commit:    $(json_get "$dir/snapshot.json" sourceCommit)"
  echo "  files:     $fcount, all match manifest.sha256"
}

json_get() { node -e '
  const j=require(process.argv[1]); const v=j[process.argv[2]];
  process.stdout.write(v===undefined||v===null?"":String(v));' "$1" "$2"; }

if [[ "$MODE" == "verify" ]]; then
  target="$STORE/${WHICH:-latest}"
  [[ -e "$target" ]] || { target="$(ls -1d "$STORE"/*/ 2>/dev/null | sort | tail -1 || true)"; target="${target%/}"; }
  [[ -n "$target" && -d "$target" ]] || die "no snapshot in $STORE"
  echo "verifying $target"
  verify_snapshot "$target"
  exit 0
fi

# ── capture ──────────────────────────────────────────────────────────────────
case "$KIND" in
  running-deployment|committed-fallback) ;;
  "") die "--kind is required: running-deployment | committed-fallback" ;;
  *)  die "unknown --kind '$KIND'; expected running-deployment or committed-fallback" ;;
esac

SOURCE="$(realpath -- "$SOURCE" 2>/dev/null || die "no such source directory: $SOURCE")"
inv_revision_trees "$INVENTORY" >/dev/null 2>&1 \
  || die "unknown --inventory '$INVENTORY'; known: $(inv_known_revisions | tr '\n' ' ')"
inv_use_revision "$INVENTORY"
inv_validate_root "$SOURCE" "source"
inv_validate_trees "$SOURCE" "source"
inv_reject_unexpected_trees "$SOURCE" "$INVENTORY"
inv_validate_filenames "$SOURCE"

inv_lock "$STORE/.lock"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$STORE/$STAMP"
[[ ! -e "$DEST" ]] || die "snapshot $STAMP already exists"

umask 077
mkdir -p "$DEST/artifacts"
chmod 700 "$STORE" "$DEST"

# ── the artifacts, from the inventory and only the inventory ─────────────────
for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
  mkdir -p "$DEST/artifacts/$t"
  cp -a "$SOURCE/$t/." "$DEST/artifacts/$t/"
done

( cd "$DEST/artifacts" && inv_list_files . | sed 's|^\./||' | xargs -r sha256sum > ../manifest.sha256 )
FILE_COUNT="$(wc -l < "$DEST/manifest.sha256")"
COPIED="$(find "$DEST/artifacts" -type f | wc -l)"
[[ "$FILE_COUNT" -eq "$COPIED" ]] \
  || die "manifest covers $FILE_COUNT files but $COPIED were copied"
SRC_COUNT="$(inv_list_files "$SOURCE" | wc -l)"
[[ "$FILE_COUNT" -eq "$SRC_COUNT" ]] \
  || die "source holds $SRC_COUNT files but $FILE_COUNT were captured"

# ── the sealed record ────────────────────────────────────────────────────────
#
# Credential FILES are digested, never read. The digests below are of
# ~/.config/bokahli/*.env; their contents are not copied, printed or referenced.
NODE_BIN="$(readlink -f "$(command -v node)")"
{
  echo "schema=$DEPLOY_SCHEMA_VERSION"
  echo "inventoryId=$(inv_id)"
  echo "inventoryRevision=$DEPLOY_REVISION"
  echo "treeCount=$(inv_tree_count)"
  echo "fileCount=$FILE_COUNT"
  echo "capturedAt=$STAMP"
  echo "host=$(hostname)"
  echo "repoName=$DEPLOY_REPO_NAME"
  echo "sourceRoot=$SOURCE"
  echo "sourceKind=$KIND"
  echo "sourceCommit=$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "sourceTree=$(git -C "$SOURCE" rev-parse HEAD^{tree} 2>/dev/null || echo unknown)"
  echo "sourceDirtyFiles=$(git -C "$SOURCE" status --porcelain 2>/dev/null | wc -l)"
  echo "sourceDescribe=$(git -C "$SOURCE" describe --always --dirty 2>/dev/null || echo unknown)"
  echo "label=$LABEL"
  echo "note=$NOTE"
  echo "nodePath=$NODE_BIN"
  echo "nodeVersion=$(node -v)"
  echo "nodeSha256=$(sha256sum "$NODE_BIN" | cut -d' ' -f1)"
  echo "manifestSha256=$(sha256sum "$DEST/manifest.sha256" | cut -d' ' -f1)"
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do echo "tree=$t"; done
  for f in "${DEPLOY_UNIT_FILES[@]}";   do [[ -f "$f" ]] && echo "unit=$(sha256sum "$f" | cut -d' ' -f1) ${f/#$HOME/\~}"; done
  for f in "${DEPLOY_CONFIG_FILES[@]}"; do [[ -f "$f" ]] && echo "config=$(sha256sum "$f" | cut -d' ' -f1) ${f/#$HOME/\~}"; done
  for u in bokahli.service bokahli-runtime.service; do
    echo "service=$u $(systemctl --user show "$u" -p MainPID -p NRestarts -p ExecMainStartTimestampMonotonic -p ActiveState --value 2>/dev/null | tr '\n' ' ')"
  done
  ss -tlnp 2>/dev/null | grep -E '127\.0\.0\.1:(8080|8081)|100\.115\.140\.2:8080' \
    | awk '{print "listener=" $4}' || true
} > "$DEST/record.kv"

node -e '
const fs=require("fs");
const out={trees:[],units:[],configs:[],services:[],listeners:[]};
for (const line of fs.readFileSync(process.argv[1],"utf-8").split("\n")) {
  if (!line) continue;
  const i=line.indexOf("="); const k=line.slice(0,i), v=line.slice(i+1);
  if (k==="tree") out.trees.push(v);
  else if (k==="unit"||k==="config") { const [d,...p]=v.split(" "); (k==="unit"?out.units:out.configs).push({sha256:d,path:p.join(" ")}); }
  else if (k==="service") { const [n,...r]=v.split(" "); out.services.push({unit:n,state:r.join(" ").trim()}); }
  else if (k==="listener") out.listeners.push(v);
  else out[k]= /^[0-9]+$/.test(v) ? Number(v) : v;
}
fs.writeFileSync(process.argv[2], JSON.stringify(out,null,2)+"\n");
' "$DEST/record.kv" "$DEST/snapshot.json"
rm -f "$DEST/record.kv"

sha256sum "$DEST/snapshot.json" | cut -d' ' -f1 > "$DEST/snapshot.json.sha256"

# Human-readable rendering. Nothing reads this; restore consumes snapshot.json.
{
  echo "Bokahli deployment snapshot"
  echo "  captured   $STAMP on $(hostname)"
  echo "  kind       $KIND"
  case "$KIND" in
    committed-fallback)
      echo "             REPRODUCIBLE COMMITTED FALLBACK — built from an exact commit."
      echo "             This is NOT the build that was running when it was captured." ;;
    running-deployment)
      echo "             The artifacts that were being served at capture time." ;;
  esac
  echo "  commit     $(json_get "$DEST/snapshot.json" sourceCommit)"
  echo "  label      $LABEL"
  echo "  note       $NOTE"
  echo "  source     $SOURCE"
  echo "  inventory  $DEPLOY_REVISION ($(inv_tree_count) trees)"
  echo "  files      $FILE_COUNT"
  echo
  echo "  Environment-file digests below are digests only. The bearer token and"
  echo "  the runtime API key are never copied into this directory."
} > "$DEST/identity.txt"

chmod -R go-rwx "$DEST"
ln -sfn "$DEST" "$STORE/latest"

echo "snapshot: $DEST"
echo "  kind:      $KIND${LABEL:+ ($LABEL)}"
echo "  commit:    $(json_get "$DEST/snapshot.json" sourceCommit)"
echo "  inventory: $DEPLOY_REVISION ($(inv_tree_count) trees, id $(inv_id))"
echo "  artifacts: $FILE_COUNT files"
echo "  record:    $DEST/snapshot.json (sealed)"
echo "  mode:      $(stat -c '%a' "$DEST") (owner only)"
echo
echo "Nothing was restarted, signalled or deleted. Restore with:"
echo "  scripts/deploy-restore.sh $STAMP"
