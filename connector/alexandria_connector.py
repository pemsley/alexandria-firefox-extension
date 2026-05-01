"""Alexandria native-messaging host.

Receives a single message from the Firefox extension on stdin,
writes the embedded PDF bytes into the configured library directory,
replies with the saved path or an error, and exits.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path
from typing import IO, Optional

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - 3.9/3.10
    import tomli as tomllib  # type: ignore[no-redef]


class ConfigError(Exception):
    pass


def load_library_dir(config_path: Path) -> Path:
    """Read `library_dir` from a TOML config file."""
    if not config_path.is_file():
        raise ConfigError(
            f"config file not found: {config_path} "
            "(create it with: library_dir = \"/path/to/your/papers\")"
        )
    with config_path.open("rb") as fh:
        data = tomllib.load(fh)
    if "library_dir" not in data:
        raise ConfigError(f"`library_dir` missing from {config_path}")
    return Path(data["library_dir"]).expanduser()


def default_config_path() -> Path:
    return Path.home() / ".config" / "alexandria-connector" / "config.toml"


import hashlib


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
