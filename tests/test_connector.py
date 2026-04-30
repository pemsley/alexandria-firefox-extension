"""Tests for connector.alexandria_connector.

Runnable as `python3 -m unittest tests.test_connector` or via the
existing project test runner.
"""

import io
import json
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "connector"))
import alexandria_connector as ac  # noqa: E402


class TestFraming(unittest.TestCase):
    def test_read_message_decodes_length_prefixed_json(self):
        payload = json.dumps({"hello": "world"}).encode("utf-8")
        prefix = len(payload).to_bytes(4, "little")
        stream = io.BytesIO(prefix + payload)
        self.assertEqual(ac.read_message(stream), {"hello": "world"})

    def test_write_message_emits_length_prefixed_json(self):
        out = io.BytesIO()
        ac.write_message(out, {"ok": True})
        raw = out.getvalue()
        length = int.from_bytes(raw[:4], "little")
        self.assertEqual(length, len(raw) - 4)
        self.assertEqual(json.loads(raw[4:].decode("utf-8")), {"ok": True})

    def test_read_message_returns_none_on_eof(self):
        self.assertIsNone(ac.read_message(io.BytesIO(b"")))


if __name__ == "__main__":
    unittest.main()
