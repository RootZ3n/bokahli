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
if [ -f "$CFG_DIR/shared.env" ]; then
  echo "keep    $CFG_DIR/shared.env (already exists)"
else
  umask 077
  printf 'BOKAHLI_RUNTIME_API_KEY=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-43)" \
    > "$CFG_DIR/shared.env"
  chmod 600 "$CFG_DIR/shared.env"
  echo "install $CFG_DIR/shared.env (key generated)"
fi

for f in runtime.env bokahli.env; do
  if [ -f "$CFG_DIR/$f" ]; then
    echo "keep    $CFG_DIR/$f (already exists)"
  else
    install -m 600 "$REPO/config/$f.example" "$CFG_DIR/$f"
    echo "install $CFG_DIR/$f"
  fi
done

for u in bokahli-runtime.service bokahli.service; do
  install -m 644 "$REPO/systemd/$u" "$UNIT_DIR/$u"
  echo "install $UNIT_DIR/$u"
done

systemctl --user daemon-reload
echo "daemon-reload complete"
echo
echo "next: systemctl --user start bokahli-runtime.service"
