#!/bin/sh
# Alexandria Connector installer.
#
# Installs:
#   - alexandria_connector.py  -> ~/.local/bin/alexandria-connector
#   - native-messaging manifest -> ~/.mozilla/native-messaging-hosts/
#   - config (only if absent)   -> ~/.config/alexandria-connector/config.toml
#
# Run from the unpacked tarball directory:
#     ./install.sh
#
# Honours the standard env vars:
#   PREFIX        (default: $HOME/.local)         -> binary lives in $PREFIX/bin
#   MANIFEST_DIR  (default: $HOME/.mozilla/native-messaging-hosts)
#   CONFIG_DIR    (default: $HOME/.config/alexandria-connector)

set -eu

PREFIX="${PREFIX:-$HOME/.local}"
BINDIR="$PREFIX/bin"
HOST_PATH="$BINDIR/alexandria-connector"
MANIFEST_DIR="${MANIFEST_DIR:-$HOME/.mozilla/native-messaging-hosts}"
MANIFEST_PATH="$MANIFEST_DIR/io.github.pemsley.alexandria.json"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/alexandria-connector}"
CONFIG_PATH="$CONFIG_DIR/config.toml"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/alexandria_connector.py"
MANIFEST_TEMPLATE="$SCRIPT_DIR/io.github.pemsley.alexandria.json.in"

if [ ! -f "$SOURCE_SCRIPT" ] || [ ! -f "$MANIFEST_TEMPLATE" ]; then
    echo "error: cannot find connector files in $SCRIPT_DIR" >&2
    echo "       (run install.sh from inside the unpacked tarball)" >&2
    exit 1
fi

# Sanity-check Python. tomllib lives in 3.11+, so insist on that.
if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 is not on \$PATH; please install Python 3.11 or newer" >&2
    exit 1
fi
PYVER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
PYMAJ="$(echo "$PYVER" | cut -d. -f1)"
PYMIN="$(echo "$PYVER" | cut -d. -f2)"
if [ "$PYMAJ" -lt 3 ] || { [ "$PYMAJ" -eq 3 ] && [ "$PYMIN" -lt 11 ]; }; then
    echo "error: Python 3.11 or newer required (found $PYVER)" >&2
    exit 1
fi

echo "Installing Alexandria Connector"
echo

# Ask for library_dir, but only if no existing config has one already.
existing_dir=""
if [ -f "$CONFIG_PATH" ]; then
    existing_dir="$(python3 -c '
import sys, tomllib
try:
    with open(sys.argv[1], "rb") as fh:
        data = tomllib.load(fh)
    print(data.get("library_dir", ""))
except Exception:
    pass
' "$CONFIG_PATH" 2>/dev/null || true)"
fi

if [ -n "$existing_dir" ]; then
    echo "Existing config: library_dir = \"$existing_dir\""
    echo "(Leaving config unchanged. Edit $CONFIG_PATH to change it.)"
    LIBRARY_DIR="$existing_dir"
else
    default_dir="$HOME/Papers"
    printf "Where should saved PDFs go? [%s]: " "$default_dir"
    if [ -t 0 ]; then
        # Interactive: read from terminal.
        read -r answer || answer=""
    else
        answer=""
    fi
    if [ -z "$answer" ]; then
        LIBRARY_DIR="$default_dir"
    else
        # Expand a leading ~ and ~/ into $HOME for friendliness.
        case "$answer" in
            "~")    LIBRARY_DIR="$HOME" ;;
            "~/"*)  LIBRARY_DIR="$HOME/${answer#~/}" ;;
            *)      LIBRARY_DIR="$answer" ;;
        esac
    fi
fi

# Create directories.
mkdir -p "$BINDIR" "$MANIFEST_DIR" "$CONFIG_DIR" "$LIBRARY_DIR"

# Install the connector binary.
install -m 0755 "$SOURCE_SCRIPT" "$HOST_PATH"

# Render the native-messaging manifest with the absolute host path.
sed "s|@@HOST_PATH@@|$HOST_PATH|" "$MANIFEST_TEMPLATE" > "$MANIFEST_PATH"

# Write config only if absent (don't clobber a customised one).
if [ ! -f "$CONFIG_PATH" ]; then
    printf 'library_dir = "%s"\n' "$LIBRARY_DIR" > "$CONFIG_PATH"
fi

cat <<EOF

Installed:
  Connector:    $HOST_PATH
  Manifest:     $MANIFEST_PATH
  Config:       $CONFIG_PATH
  Library dir:  $LIBRARY_DIR

Next: install the Firefox add-on (see INSTALL.md), then pin its
toolbar button via the puzzle-piece icon -> "Pin to Toolbar".

To remove later, run uninstall.sh from the same tarball.
EOF
