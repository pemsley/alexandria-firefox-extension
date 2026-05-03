#!/bin/sh
# Alexandria Connector uninstaller. Removes the binary and manifest;
# leaves your config and library directory in place.

set -eu

PREFIX="${PREFIX:-$HOME/.local}"
HOST_PATH="$PREFIX/bin/alexandria-connector"
MANIFEST_DIR="${MANIFEST_DIR:-$HOME/.mozilla/native-messaging-hosts}"
MANIFEST_PATH="$MANIFEST_DIR/io.github.pemsley.alexandria.json"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/alexandria-connector}"

rm -f "$HOST_PATH" "$MANIFEST_PATH"

cat <<EOF
Removed:
  $HOST_PATH
  $MANIFEST_PATH

Left in place (delete by hand if you want them gone):
  $CONFIG_DIR
  Your library directory
EOF
