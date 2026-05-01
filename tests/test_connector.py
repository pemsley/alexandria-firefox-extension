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


import tempfile


class TestConfig(unittest.TestCase):
    def test_load_library_dir_returns_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.toml"
            cfg.write_text('library_dir = "/home/me/Papers"\n')
            self.assertEqual(ac.load_library_dir(cfg), Path("/home/me/Papers"))

    def test_load_library_dir_missing_file_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "nope.toml"
            with self.assertRaises(ac.ConfigError):
                ac.load_library_dir(cfg)

    def test_load_library_dir_expands_tilde(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.toml"
            cfg.write_text('library_dir = "~/Papers"\n')
            self.assertEqual(
                ac.load_library_dir(cfg),
                Path.home() / "Papers",
            )

    def test_load_library_dir_missing_key_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.toml"
            cfg.write_text('other_key = "x"\n')
            with self.assertRaises(ac.ConfigError):
                ac.load_library_dir(cfg)


import hashlib


class TestSafeFilename(unittest.TestCase):
    def test_rejects_path_separators(self):
        with self.assertRaises(ac.UnsafeFilename):
            ac.safe_filename("../etc/passwd")
        with self.assertRaises(ac.UnsafeFilename):
            ac.safe_filename("a/b.pdf")

    def test_rejects_dotfiles(self):
        with self.assertRaises(ac.UnsafeFilename):
            ac.safe_filename(".hidden.pdf")

    def test_rejects_empty(self):
        with self.assertRaises(ac.UnsafeFilename):
            ac.safe_filename("")

    def test_appends_pdf_extension_if_missing(self):
        self.assertEqual(ac.safe_filename("paper"), "paper.pdf")

    def test_keeps_existing_pdf_extension(self):
        self.assertEqual(ac.safe_filename("paper.pdf"), "paper.pdf")


class TestWriteWithCollision(unittest.TestCase):
    def test_writes_new_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = ac.write_pdf(Path(tmp), "a.pdf", b"hello")
            self.assertEqual(out, Path(tmp) / "a.pdf")
            self.assertEqual(out.read_bytes(), b"hello")

    def test_idempotent_on_identical_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ac.write_pdf(Path(tmp), "a.pdf", b"hello")
            out = ac.write_pdf(Path(tmp), "a.pdf", b"hello")
            self.assertEqual(out, Path(tmp) / "a.pdf")
            self.assertEqual(
                sorted(p.name for p in Path(tmp).iterdir()),
                ["a.pdf"],
            )

    def test_appends_suffix_on_byte_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            ac.write_pdf(Path(tmp), "a.pdf", b"hello")
            out = ac.write_pdf(Path(tmp), "a.pdf", b"different")
            self.assertEqual(out, Path(tmp) / "a-1.pdf")
            self.assertEqual(out.read_bytes(), b"different")

    def test_suffix_increments_until_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            ac.write_pdf(Path(tmp), "a.pdf", b"v0")
            ac.write_pdf(Path(tmp), "a.pdf", b"v1")  # -> a-1.pdf
            out = ac.write_pdf(Path(tmp), "a.pdf", b"v2")
            self.assertEqual(out, Path(tmp) / "a-2.pdf")


import base64
import struct


class TestMain(unittest.TestCase):
    def _run(self, msg: dict, library_dir: Path, config_path: Path) -> dict:
        body = json.dumps(msg).encode("utf-8")
        stdin = io.BytesIO(struct.pack("<I", len(body)) + body)
        stdout = io.BytesIO()
        ac.main(stdin=stdin, stdout=stdout, config_path=config_path)
        out = stdout.getvalue()
        length = int.from_bytes(out[:4], "little")
        return json.loads(out[4:4 + length].decode("utf-8"))

    def test_save_writes_file_and_replies_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            lib = tmp / "lib"
            cfg = tmp / "config.toml"
            cfg.write_text(f'library_dir = "{lib}"\n')
            payload = base64.b64encode(b"PDF-DATA").decode("ascii")
            reply = self._run(
                {"action": "save", "filename": "x.pdf", "data_b64": payload},
                lib, cfg,
            )
            self.assertTrue(reply["ok"])
            self.assertEqual(Path(reply["path"]).read_bytes(), b"PDF-DATA")

    def test_missing_config_yields_error_reply(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "missing.toml"
            payload = base64.b64encode(b"x").decode("ascii")
            reply = self._run(
                {"action": "save", "filename": "x.pdf", "data_b64": payload},
                Path(tmp), cfg,
            )
            self.assertFalse(reply["ok"])
            self.assertIn("config file not found", reply["error"])

    def test_unknown_action_yields_error_reply(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.toml"
            cfg.write_text(f'library_dir = "{tmp}"\n')
            reply = self._run(
                {"action": "frobnicate"}, Path(tmp), cfg,
            )
            self.assertFalse(reply["ok"])
            self.assertIn("unknown action", reply["error"])

    def test_bad_base64_yields_error_reply(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.toml"
            cfg.write_text(f'library_dir = "{tmp}"\n')
            reply = self._run(
                {"action": "save", "filename": "x.pdf",
                 "data_b64": "not!!base64!!"},
                Path(tmp), cfg,
            )
            self.assertFalse(reply["ok"])
            self.assertIn("base64", reply["error"].lower())


if __name__ == "__main__":
    unittest.main()
