#!/usr/bin/env bash
# Install Bokahli systemd user units and environment files.
# Idempotent. Does not start anything; does not overwrite an existing env file.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UNIT_DIR="$HOME/.config/systemd/user"
CFG_DIR="$HOME/.config/bokahli"

mkdir -p "$UNIT_DIR" "$CFG_DIR"
chmod 700 "$CFG_DIR"

# Shared runtime key. Generated once; never regenerated over an existing file,
# because both units must agree on it.
#
# It lives in a bare file rather than an EnvironmentFile. llama-server takes it
# as --api-key-file and the API server reads the same path at startup, so the
# secret reaches both processes without appearing in either one's environment or
# argv. It used to be BOKAHLI_RUNTIME_API_KEY in shared.env, loaded by both
# units; that put the key in /proc/<pid>/environ of two processes to save
# reading one file.
#
# This script generated shared.env for some time after the units stopped loading
# it, which meant a fresh install produced a key nothing read and a runtime that
# came up with no key at all. Only an existing deployment carried on working,
# which is the failure mode that hides longest.
if [ -f "$CFG_DIR/runtime-api-key" ]; then
  echo "keep    $CFG_DIR/runtime-api-key (already exists)"
else
  umask 077
  head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-43 > "$CFG_DIR/runtime-api-key"
  chmod 600 "$CFG_DIR/runtime-api-key"
  echo "install $CFG_DIR/runtime-api-key (key generated)"
fi

# shared.env is no longer written. An existing one is left alone rather than
# deleted — this script installs, and removing a file that might still be
# someone's only copy of a working key is not an install step — but it is called
# out, because a stale secret nobody reads is still a secret on disk.
if [ -f "$CFG_DIR/shared.env" ]; then
  echo "stale   $CFG_DIR/shared.env — nothing loads this any more; remove it once"
  echo "        $CFG_DIR/runtime-api-key is confirmed working"
fi

for f in runtime.env bokahli.env; do
  if [ -f "$CFG_DIR/$f" ]; then
    echo "keep    $CFG_DIR/$f (already exists)"
  else
    install -m 600 "$REPO/config/$f.example" "$CFG_DIR/$f"
    echo "install $CFG_DIR/$f"
  fi
done

# Units. A deployed unit that is *newer* than the repo's copy is not overwritten
# without --force.
#
# This script is run by hand, often to fix something, and often on a machine
# where the deployed unit was edited in place during an incident. Silently
# replacing that edit with an older repo version undoes the fix at the exact
# moment someone is relying on it, and does so while printing "install", which
# reads as success. Refusing is recoverable; a silent regression is not.
#
# Comparison is by mtime, which is what `install` would clobber. It is a coarse
# signal and deliberately so: the failure it prevents is destructive and the
# cost of a false positive is one --force.
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

regressed=0
for u in bokahli-runtime.service bokahli.service; do
  src="$REPO/systemd/$u"
  dst="$UNIT_DIR/$u"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "same    $dst"
    continue
  fi
  if [ -f "$dst" ] && [ "$dst" -nt "$src" ] && [ "$FORCE" -eq 0 ]; then
    echo "REFUSE  $dst is newer than $src" >&2
    echo "        the deployed unit has changes the repo does not. Diff them, and" >&2
    echo "        either commit the deployed version or re-run with --force." >&2
    regressed=1
    continue
  fi
  install -m 644 "$src" "$dst"
  echo "install $dst"
done

if [ "$regressed" -ne 0 ]; then
  echo >&2
  echo "install-units: refused to regress a newer deployed unit; nothing reloaded." >&2
  exit 1
fi

systemctl --user daemon-reload
echo "daemon-reload complete"
echo
echo "next: systemctl --user start bokahli-runtime.service"
