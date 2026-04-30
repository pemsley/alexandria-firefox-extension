"""Alexandria native-messaging host.

Receives a single message from the Firefox extension on stdin,
writes the embedded PDF bytes into the configured library directory,
replies with the saved path or an error, and exits.
"""

from __future__ import annotations

import json
import struct
import sys
from typing import IO, Optional


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
