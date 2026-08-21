# Bokahli — the canonical deployment artifact inventory, and the checks that
# keep every tool honest about it.
#
# Sourced, never executed. `deploy-snapshot.sh`, `deploy-restore.sh` and the
# hostile test suite all read the list from here; none of them discovers
# artifact trees from the filesystem.
#
# That is the whole point. The previous restore script found the trees to
# preserve with `find . -mindepth 2 -maxdepth 2 -type d -name dist`, which
# matched zero of the seven real trees, because they live at depth three
# (`packages/<pkg>/dist`). The step that saved the build being replaced was a
# silent no-op, and a rollback would have looked fine right up until someone
# needed the displaced build back. A wrong depth constant is invisible; a
# missing entry in a seven-line list that everything validates against is not.
#
# Every function here fails closed. There is no path through this file that
# says "close enough".

set -euo pipefail

# ── schema ───────────────────────────────────────────────────────────────────
#
# Bound into every snapshot and checked on every restore. A snapshot written by
# a different schema is refused rather than interpreted: the failure mode this
# guards against is a future format change that an older restore reads as if it
# understood it.
DEPLOY_SCHEMA_VERSION="bokahli-deploy-snapshot/2"
DEPLOY_REPO_NAME="bokahli"

# ── the inventory, as named revisions ────────────────────────────────────────
#
# The deployable surface is a closed list, but it is not the *same* closed list
# at every commit, and pretending otherwise breaks the first real rollback.
#
# `packages/velum` was created by the release commit. The fallback target one
# commit earlier builds six trees, not seven. A single hard-coded seven would
# have made that fallback unsnapshottable — and the tempting fix, letting the
# tool discover whatever trees happen to be on disk, is exactly the
# filesystem-discovery behaviour that produced the depth-3 defect.
#
# So each revision is named, closed and ordered, and a snapshot records which
# one it was taken against. Restoring anything other than the current revision
# requires naming its id explicitly on the command line; see deploy-restore.sh.
DEPLOY_REVISION_CURRENT="v2-velum"

inv_revision_trees() {
  case "$1" in
    v2-velum)
      # The current surface: seven trees, Velum included.
      printf '%s\n' \
        packages/contracts/dist \
        packages/catalog/dist \
        packages/qualification/dist \
        packages/tasks/dist \
        packages/runtime/dist \
        packages/velum/dist \
        packages/server/dist
      ;;
    pre-velum)
      # Everything up to and including 94f4d6c: six trees, no Velum. Retained
      # so a committed fallback from before the trust boundary can be built,
      # snapshotted and restored without loosening any check.
      printf '%s\n' \
        packages/contracts/dist \
        packages/catalog/dist \
        packages/qualification/dist \
        packages/tasks/dist \
        packages/runtime/dist \
        packages/server/dist
      ;;
    *) return 1 ;;
  esac
}

inv_known_revisions() { printf '%s\n' v2-velum pre-velum; }

# Select the revision every subsequent check operates on.
inv_use_revision() {
  local name="$1" list
  list="$(inv_revision_trees "$name")" || inv_die "unknown inventory revision: $name"
  mapfile -t DEPLOY_ARTIFACT_TREES <<< "$list"
  DEPLOY_REVISION="$name"
}

# The id of a revision, without disturbing the selected one.
inv_id_of() {
  local name="$1" list
  list="$(inv_revision_trees "$name")" || inv_die "unknown inventory revision: $name"
  { printf '%s\n' "$DEPLOY_SCHEMA_VERSION" "$name"; printf '%s\n' "$list"; } | sha256sum | cut -d' ' -f1
}

# Which named revision an id belongs to, or empty. An id that matches nothing
# is refused rather than guessed at.
inv_revision_for_id() {
  local want="$1" name
  while read -r name; do
    [[ "$(inv_id_of "$name")" == "$want" ]] && { printf '%s' "$name"; return 0; }
  done < <(inv_known_revisions)
  return 1
}

# Configuration whose *identity* is recorded and never its contents. These hold
# the bearer token and the runtime API key.
DEPLOY_CONFIG_FILES=(
  "$HOME/.config/bokahli/shared.env"
  "$HOME/.config/bokahli/bokahli.env"
  "$HOME/.config/bokahli/runtime.env"
)

DEPLOY_UNIT_FILES=(
  "$HOME/.config/systemd/user/bokahli.service"
  "$HOME/.config/systemd/user/bokahli-runtime.service"
  "$HOME/.config/systemd/user/bokahli.service.d/10-cpu-exclusion.conf"
  "$HOME/.config/systemd/user/bokahli-runtime.service.d/10-cpu-exclusion.conf"
)

inv_die() { echo "deploy-inventory: $*" >&2; exit 1; }

# ── inventory identity ───────────────────────────────────────────────────────
#
# A digest over the schema and the exact tree list. A snapshot taken when the
# inventory held seven trees cannot be restored by a tool that now expects
# eight: the restore refuses instead of quietly leaving the eighth tree at
# whatever happened to be on disk.
inv_id() { inv_id_of "$DEPLOY_REVISION"; }

inv_trees() { printf '%s\n' "${DEPLOY_ARTIFACT_TREES[@]}"; }
inv_tree_count() { printf '%s' "${#DEPLOY_ARTIFACT_TREES[@]}"; }

# ── path confinement ─────────────────────────────────────────────────────────
#
# Every path any tool touches must resolve beneath the root it was given.
# `realpath` resolves symlinks, so a tree that is a link pointing outside is
# caught here rather than followed.
inv_resolve() { realpath -m -- "$1"; }

inv_confined() {
  local root path rroot rpath
  root="$(realpath -m -- "$1")"; path="$(realpath -m -- "$2")"
  case "$path" in
    "$root") return 0 ;;
    "$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

inv_require_confined() {
  inv_confined "$1" "$2" || inv_die "path escapes the deployment root: $2 (root $1)"
}

# ── validation ───────────────────────────────────────────────────────────────

# The root must be an absolute, existing directory that actually looks like a
# Bokahli checkout. Restoring Bokahli artifacts into an arbitrary directory is
# not a rollback; it is scattering build output across someone's filesystem.
inv_validate_root() {
  local root="$1" kind="${2:-deployment}"
  [[ -n "$root" ]] || inv_die "$kind root is empty"
  [[ "$root" = /* ]] || inv_die "$kind root must be absolute: $root"
  [[ -d "$root" ]] || inv_die "$kind root is not a directory: $root"
  [[ ! -L "$root" ]] || inv_die "$kind root is a symlink: $root"
  [[ -f "$root/package.json" ]] || inv_die "$kind root has no package.json: $root"
  local name
  name="$(node -e 'process.stdout.write(String(require(process.argv[1]).name??""))' "$root/package.json" 2>/dev/null || true)"
  [[ "$name" == "$DEPLOY_REPO_NAME" ]] \
    || inv_die "$kind root is not the $DEPLOY_REPO_NAME repository (package.json name='$name'): $root"
}

# Each tree must exist exactly once, be a real directory, sit under the root,
# and contain no symlink that leaves it. Anything else stops the tool.
inv_validate_trees() {
  local root="$1" seen_list="" t resolved
  inv_validate_root "$root" "${2:-deployment}"
  local expected; expected="$(inv_revision_trees "$DEPLOY_REVISION" | wc -l)"
  [[ "${#DEPLOY_ARTIFACT_TREES[@]}" -eq "$expected" ]] \
    || inv_die "inventory revision $DEPLOY_REVISION holds ${#DEPLOY_ARTIFACT_TREES[@]} trees; expected $expected"

  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
    case " $seen_list " in *" $t "*) inv_die "duplicate tree in inventory: $t" ;; esac
    seen_list="$seen_list $t"

    [[ "$t" != /* ]] || inv_die "inventory tree must be relative: $t"
    case "$t" in *..*) inv_die "inventory tree contains '..': $t" ;; esac

    [[ -e "$root/$t" ]] || inv_die "artifact tree is missing: $t"
    [[ ! -L "$root/$t" ]] || inv_die "artifact tree is a symlink: $t"
    [[ -d "$root/$t" ]] || inv_die "artifact tree is not a directory: $t"
    inv_require_confined "$root" "$root/$t"

    # No symlink anywhere inside may leave the tree.
    while IFS= read -r -d '' link; do
      resolved="$(realpath -m -- "$link")"
      inv_confined "$root/$t" "$resolved" \
        || inv_die "symlink escapes its artifact tree: ${link#$root/} -> $resolved"
    done < <(find "$root/$t" -type l -print0)
  done
}

# Nothing that looks like a build artifact may sit outside the inventory. An
# eighth `packages/*/dist` means the inventory is stale, and a stale inventory
# silently leaves a tree un-snapshotted and un-restored.
inv_reject_unexpected_trees() {
  local root="$1" found t known current
  current="$(inv_revision_trees "${2:-$DEPLOY_REVISION_CURRENT}")"
  while IFS= read -r found; do
    found="${found#$root/}"
    known=no
    while IFS= read -r t; do [[ "$found" == "$t" ]] && known=yes; done <<< "$current"
    [[ "$known" == yes ]] || inv_die "unexpected artifact tree not in the inventory: $found"
  done < <(find "$root/packages" -mindepth 2 -maxdepth 2 -name dist \( -type d -o -type l \) 2>/dev/null)
}

# Every file under the inventory, exactly once, in a stable order. This is the
# only enumeration any tool uses; there is no second, subtly different one.
inv_list_files() {
  local root="$1" t
  for t in "${DEPLOY_ARTIFACT_TREES[@]}"; do
    find "$root/$t" -type f -printf '%P\0' | while IFS= read -r -d '' f; do printf '%s/%s\n' "$t" "$f"; done
  done | LC_ALL=C sort
}

# Refuse filenames the manifest format cannot round-trip, rather than writing a
# manifest that silently drops or mis-parses them.
inv_validate_filenames() {
  local root="$1" f
  while IFS= read -r f; do
    case "$f" in
      *[$'\n\r\t']*|*' '*) inv_die "artifact filename contains whitespace: $f" ;;
      *'\'*)               inv_die "artifact filename contains a backslash: $f" ;;
    esac
  done < <(inv_list_files "$root")
}

# ── locking ──────────────────────────────────────────────────────────────────
#
# Snapshot and restore both mutate a shared store, and restore mutates the
# deployment. Two at once interleave copies and renames. The lock is refused,
# not waited on: a rollback that blocks behind another rollback is a rollback
# nobody can reason about.
inv_lock() {
  local lockfile="$1"
  mkdir -p "$(dirname "$lockfile")"
  exec {INV_LOCK_FD}>"$lockfile"
  flock -n "$INV_LOCK_FD" \
    || inv_die "another snapshot or restore holds $lockfile; refusing to run concurrently"
}

# Select the current revision by default. Tools override it explicitly.
inv_use_revision "$DEPLOY_REVISION_CURRENT"
