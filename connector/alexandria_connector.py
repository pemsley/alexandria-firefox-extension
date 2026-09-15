#!/usr/bin/env python3
"""Alexandria native-messaging host.

Receives a single message from the Firefox extension on stdin,
writes the embedded PDF bytes into the configured library directory,
replies with the saved path or an error, and exits.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import struct
import sys
from pathlib import Path
from typing import IO, Optional

# We deliberately avoid `tomllib` (Python 3.11+) so the connector can run
# on the system Python 3 that macOS ships (currently 3.9). The config has
# exactly one key; a single regex matches everything we need.
_LIBRARY_DIR_RE = re.compile(
    r'^\s*library_dir\s*=\s*(?:"([^"]*)"|\'([^\']*)\')\s*(?:#.*)?$'
)


def _parse_library_dir(text: str) -> Optional[str]:
    """Return the `library_dir` value from a minimal-TOML config, or None
    if absent. Accepts double- or single-quoted strings; ignores comments
    and blank lines."""
    for line in text.splitlines():
        m = _LIBRARY_DIR_RE.match(line)
        if m:
            return m.group(1) if m.group(1) is not None else m.group(2)
    return None


def read_message(stream: IO[bytes]) -> Optional[dict]:
    """Read one length-prefixed JSON message. Return None on EOF."""
    header = stream.read(4)
    if len(header) == 0:
        return None
    if len(header) != 4:
        raise ValueError("truncated length prefix")
    (length,) = struct.unpack("<I", header)
    body = stream.read(length)
    if len(body) != length:
        raise ValueError("truncated message body")
    return json.loads(body.decode("utf-8"))


def write_message(stream: IO[bytes], payload: dict) -> None:
    """Write one length-prefixed JSON message."""
    body = json.dumps(payload).encode("utf-8")
    stream.write(struct.pack("<I", len(body)))
    stream.write(body)
    stream.flush()


class ConfigError(Exception):
    pass


def load_library_dir(config_path: Path) -> Path:
    """Read `library_dir` from a TOML config file."""
    if not config_path.is_file():
        raise ConfigError(
            f"config file not found: {config_path} "
            "(create it with: library_dir = \"/path/to/your/papers\")"
        )
    text = config_path.read_text(encoding="utf-8")
    value = _parse_library_dir(text)
    if value is None:
        raise ConfigError(f"`library_dir` missing from {config_path}")
    return Path(value).expanduser()


def default_config_path() -> Path:
    return Path.home() / ".config" / "alexandria-connector" / "config.toml"


class UnsafeFilename(Exception):
    pass


def safe_filename(name: str) -> str:
    """Return a sanitised filename ending in `.pdf`.

    Rejects path separators and leading dots; the extension only ever
    sends URL basenames, but we revalidate on the host side.
    """
    if not name:
        raise UnsafeFilename("empty filename")
    if "/" in name or "\\" in name:
        raise UnsafeFilename(f"filename contains path separator: {name!r}")
    if name.startswith("."):
        raise UnsafeFilename(f"filename starts with dot: {name!r}")
    if not name.lower().endswith(".pdf"):
        name = name + ".pdf"
    return name


def write_pdf(library_dir: Path, filename: str, data: bytes) -> Path:
    """Write `data` into `library_dir/filename`, resolving collisions.

    - If target is missing: write and return the path.
    - If target exists with identical SHA-256: no-op, return the path.
    - Otherwise: append `-1`, `-2`, … before `.pdf` until free.
    """
    library_dir.mkdir(parents=True, exist_ok=True)
    target = library_dir / filename
    incoming_digest = hashlib.sha256(data).hexdigest()

    if target.exists():
        if hashlib.sha256(target.read_bytes()).hexdigest() == incoming_digest:
            return target
        stem, suffix = target.stem, target.suffix
        i = 1
        while True:
            candidate = library_dir / f"{stem}-{i}{suffix}"
            if not candidate.exists():
                target = candidate
                break
            if hashlib.sha256(candidate.read_bytes()).hexdigest() == incoming_digest:
                return candidate
            i += 1

    target.write_bytes(data)
    return target


def _handle(msg: dict, config_path: Path) -> dict:
    action = msg.get("action")
    if action != "save":
        return {"ok": False, "error": f"unknown action: {action!r}"}
    library_dir = load_library_dir(config_path)
    filename = safe_filename(msg.get("filename", ""))
    try:
        data = base64.b64decode(msg["data_b64"], validate=True)
    except (KeyError, ValueError) as exc:
        return {"ok": False, "error": f"bad base64 payload: {exc}"}
    path = write_pdf(library_dir, filename, data)
    return {"ok": True, "path": str(path)}


def main(
    stdin: Optional[IO[bytes]] = None,
    stdout: Optional[IO[bytes]] = None,
    config_path: Optional[Path] = None,
) -> int:
    stdin = stdin if stdin is not None else sys.stdin.buffer
    stdout = stdout if stdout is not None else sys.stdout.buffer
    config_path = config_path if config_path is not None else default_config_path()
    msg = read_message(stdin)
    if msg is None:
        return 0
    try:
        reply = _handle(msg, config_path)
    except ConfigError as exc:
        reply = {"ok": False, "error": str(exc)}
    except UnsafeFilename as exc:
        reply = {"ok": False, "error": str(exc)}
    except Exception as exc:  # last-resort: never crash the host
        reply = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    write_message(stdout, reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
