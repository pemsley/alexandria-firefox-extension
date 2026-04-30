# Save-to-Alexandria Firefox Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Firefox extension + Python native-messaging host that drops the PDF of the article on the current page into the Alexandria library directory.

**Architecture:** Content script finds candidate PDF URLs from `<meta name="citation_pdf_url">` and `<a href*=".pdf">`. Background script owns the toolbar button state, fetches the chosen PDF with session cookies, and ships base64-encoded bytes to a Python native-messaging host. The host writes the file under `library_dir` from `~/.config/alexandria-connector/config.toml` and replies with the saved path.

**Tech Stack:** Firefox WebExtensions (MV2), vanilla JavaScript (no build step), Python 3.9+ stdlib (`json`, `struct`, `tomllib`/`tomli`, `base64`, `hashlib`, `pathlib`, `sys`), Make for install. Tests use `unittest` to match the existing `tests/test_bibtex.py` convention (no pytest).

Reference: design spec at `docs/design/2026-04-30-firefox-extension.md`.

## File Structure

```
connector/
  alexandria_connector.py            # native messaging host (single file)
  io.github.pemsley.alexandria.json.in   # manifest template
  Makefile                           # install / uninstall

tests/
  test_connector.py                  # unittest suite for the connector

firefox-extension/
  manifest.json
  background.js                      # state + fetch + native-messaging port
  content.js                         # URL detection only
  popup.html                         # multi-PDF picker
  popup.js
  icons/
    alexandria-32.png
    alexandria-32-grey.png
  README.md                          # install + manual test checklist
```

Each file has one responsibility. The connector is small enough (≈100 lines) to live in a single module; functions are pure and individually testable.

---

## Task 1: Connector — read/write native-messaging frames

**Files:**
- Create: `connector/alexandria_connector.py`
- Create: `tests/test_connector.py`

Native messaging frames each message as a 4-byte little-endian length prefix followed by UTF-8 JSON. Implement and test the framing primitives first; everything else builds on them.

- [ ] **Step 1: Write the failing test**

Create `tests/test_connector.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests.test_connector -v`
Expected: ImportError (file doesn't exist yet) or AttributeError on `read_message` / `write_message`.

- [ ] **Step 3: Create the connector module with framing**

Create `connector/alexandria_connector.py`:

```python
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
```

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest tests.test_connector -v`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "Add native-messaging frame read/write for Alexandria connector"
```

---

## Task 2: Connector — config loading

**Files:**
- Modify: `connector/alexandria_connector.py`
- Modify: `tests/test_connector.py`

Read `library_dir` from `~/.config/alexandria-connector/config.toml`. The function takes the config path explicitly so tests can pass a tmp file. Use `tomllib` (Python 3.11+) with a `tomli` fallback for 3.9/3.10.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_connector.py`:

```python
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

    def test_load_library_dir_missing_key_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.toml"
            cfg.write_text('other_key = "x"\n')
            with self.assertRaises(ac.ConfigError):
                ac.load_library_dir(cfg)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_connector -v`
Expected: AttributeError on `load_library_dir` / `ConfigError`.

- [ ] **Step 3: Implement config loader**

Add to `connector/alexandria_connector.py`:

```python
from pathlib import Path

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
```

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest tests.test_connector -v`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "Add config loading for Alexandria connector"
```

---

## Task 3: Connector — filename sanitisation and collision handling

**Files:**
- Modify: `connector/alexandria_connector.py`
- Modify: `tests/test_connector.py`

The extension supplies a filename it derived from the URL. The host must (a) reject any filename containing `/` or starting with `.` (defence in depth — the extension already produces basenames, but we don't trust the wire), (b) ensure the filename ends with `.pdf`, and (c) on collision: identical bytes → idempotent no-op success; different bytes → suffix `-1`, `-2`, … before `.pdf`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_connector.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_connector -v`
Expected: AttributeError on `safe_filename` / `write_pdf` / `UnsafeFilename`.

- [ ] **Step 3: Implement filename + write**

Add to `connector/alexandria_connector.py`:

```python
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
```

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest tests.test_connector -v`
Expected: 14 tests pass.

- [ ] **Step 5: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "Add filename sanitisation and collision handling for connector"
```

---

## Task 4: Connector — end-to-end `main()`

**Files:**
- Modify: `connector/alexandria_connector.py`
- Modify: `tests/test_connector.py`

Wire it together: `main()` reads one message, validates `action == "save"`, decodes base64 bytes, writes the file, replies. All errors become `{"ok": false, "error": "..."}` replies; the process exits 0 either way (Firefox treats nonzero exits as port-disconnect).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_connector.py`:

```python
import base64


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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_connector -v`
Expected: AttributeError on `main`.

- [ ] **Step 3: Implement `main()`**

Append to `connector/alexandria_connector.py`:

```python
import base64


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
```

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest tests.test_connector -v`
Expected: 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "Wire end-to-end main() for Alexandria connector"
```

---

## Task 5: Connector — install Makefile and manifest template

**Files:**
- Create: `connector/io.github.pemsley.alexandria.json.in`
- Create: `connector/Makefile`

The native-messaging manifest tells Firefox where the host binary is and which extension IDs may invoke it. The extension ID is fixed in the extension's `manifest.json` (we'll set it in Task 6 to `alexandria-connector@pemsley.github.io`).

- [ ] **Step 1: Create the manifest template**

Create `connector/io.github.pemsley.alexandria.json.in`:

```json
{
  "name": "io.github.pemsley.alexandria",
  "description": "Save PDFs to the Alexandria library directory",
  "path": "@@HOST_PATH@@",
  "type": "stdio",
  "allowed_extensions": ["alexandria-connector@pemsley.github.io"]
}
```

- [ ] **Step 2: Create the Makefile**

Create `connector/Makefile`:

```make
PREFIX     ?= $(HOME)/.local
BINDIR     ?= $(PREFIX)/bin
HOST_PATH  := $(BINDIR)/alexandria-connector
MANIFEST_DIR ?= $(HOME)/.mozilla/native-messaging-hosts
MANIFEST   := $(MANIFEST_DIR)/io.github.pemsley.alexandria.json
CONFIG_DIR := $(HOME)/.config/alexandria-connector

.PHONY: install uninstall

install:
	install -d $(BINDIR) $(MANIFEST_DIR) $(CONFIG_DIR)
	install -m 0755 alexandria_connector.py $(HOST_PATH)
	sed 's|@@HOST_PATH@@|$(HOST_PATH)|' io.github.pemsley.alexandria.json.in > $(MANIFEST)
	@echo
	@echo "Installed connector at: $(HOST_PATH)"
	@echo "Installed manifest at:  $(MANIFEST)"
	@echo
	@echo "Next: create $(CONFIG_DIR)/config.toml with a single line:"
	@echo "    library_dir = \"/path/to/your/papers\""

uninstall:
	rm -f $(HOST_PATH) $(MANIFEST)
	@echo "Removed connector and manifest. Config at $(CONFIG_DIR) left in place."
```

- [ ] **Step 3: Smoke-test install in a tmp prefix**

```bash
make -C connector install PREFIX=/tmp/alex-test MANIFEST_DIR=/tmp/alex-test/nm
test -x /tmp/alex-test/bin/alexandria-connector
test -f /tmp/alex-test/nm/io.github.pemsley.alexandria.json
grep '/tmp/alex-test/bin/alexandria-connector' /tmp/alex-test/nm/io.github.pemsley.alexandria.json
rm -rf /tmp/alex-test
```
Expected: all three checks pass silently.

- [ ] **Step 4: Make the connector script directly executable**

Add a shebang at the very top of `connector/alexandria_connector.py` (insert as line 1, before the existing module docstring):

```python
#!/usr/bin/env python3
```

Then:
```bash
chmod +x connector/alexandria_connector.py
```

- [ ] **Step 5: Commit**

```bash
git add connector/Makefile connector/io.github.pemsley.alexandria.json.in connector/alexandria_connector.py
git commit -m "Add install Makefile and manifest template for connector"
```

---

## Task 6: Extension — manifest and icons

**Files:**
- Create: `firefox-extension/manifest.json`
- Create: `firefox-extension/icons/alexandria-32.png`
- Create: `firefox-extension/icons/alexandria-32-grey.png`

Minimal MV2 manifest with the explicit add-on ID needed by the native-messaging manifest. Two icon variants (active / disabled) generated from the existing SVG.

- [ ] **Step 1: Generate icons from the existing SVG**

Run (requires `rsvg-convert` from `librsvg`, which the project's GTK4 stack already pulls in):

```bash
mkdir -p firefox-extension/icons
rsvg-convert -w 32 -h 32 data/io.github.pemsley.Alexandria.svg \
    -o firefox-extension/icons/alexandria-32.png
# Greyscale + 50% opacity for the inactive state, via ImageMagick.
convert firefox-extension/icons/alexandria-32.png \
    -colorspace Gray -alpha set -channel A -evaluate set 50% +channel \
    firefox-extension/icons/alexandria-32-grey.png
```

If `convert` (ImageMagick) is unavailable, an acceptable substitute is `gm convert` (GraphicsMagick) with the same flags. Verify both files exist and are non-empty:

```bash
test -s firefox-extension/icons/alexandria-32.png
test -s firefox-extension/icons/alexandria-32-grey.png
```

- [ ] **Step 2: Create `manifest.json`**

Create `firefox-extension/manifest.json`:

```json
{
  "manifest_version": 2,
  "name": "Save to Alexandria",
  "version": "0.1.0",
  "description": "Save the article PDF on the current page into the Alexandria library directory.",

  "browser_specific_settings": {
    "gecko": {
      "id": "alexandria-connector@pemsley.github.io",
      "strict_min_version": "115.0"
    }
  },

  "permissions": [
    "activeTab",
    "tabs",
    "nativeMessaging",
    "notifications",
    "<all_urls>"
  ],

  "background": {
    "scripts": ["background.js"],
    "persistent": false
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],

  "browser_action": {
    "default_title": "Save to Alexandria",
    "default_icon": {
      "32": "icons/alexandria-32-grey.png"
    },
    "default_popup": null
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add firefox-extension/manifest.json firefox-extension/icons/
git commit -m "Add Firefox extension manifest and icons"
```

---

## Task 7: Extension — content script (URL detection)

**Files:**
- Create: `firefox-extension/content.js`

Runs on every page; reports candidate PDF URLs to the background script. No DOM mutation, no UI.

- [ ] **Step 1: Create `content.js`**

```javascript
// Find candidate PDF URLs on this page and send them to the background
// script. Three sources, in priority order:
//   1. <meta name="citation_pdf_url"> (academic publisher convention)
//   2. The page itself if it is a PDF
//   3. <a href> links whose URL ends in .pdf or has .pdf? in the path
//
// We only collect URLs. Fetching, auth, and storage live in the
// background script and the native messaging host respectively.

(function () {
  function citationPdfUrls() {
    const urls = [];
    document
      .querySelectorAll('meta[name="citation_pdf_url"]')
      .forEach((m) => {
        const v = (m.getAttribute("content") || "").trim();
        if (v) urls.push(v);
      });
    return urls;
  }

  function pageIsPdfUrl() {
    if (document.contentType === "application/pdf") {
      return [window.location.href];
    }
    return [];
  }

  function pdfLinkUrls() {
    const urls = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      // Match `.pdf` at end of pathname, optionally followed by ? or #.
      if (/\.pdf(\?|#|$)/i.test(href)) {
        try {
          urls.push(new URL(href, document.baseURI).toString());
        } catch (_) {
          /* skip malformed */
        }
      }
    });
    return urls;
  }

  function dedupe(urls) {
    return Array.from(new Set(urls));
  }

  const candidates = dedupe([
    ...citationPdfUrls(),
    ...pageIsPdfUrl(),
    ...pdfLinkUrls(),
  ]);

  browser.runtime.sendMessage({ type: "candidates", urls: candidates });
})();
```

- [ ] **Step 2: Commit**

```bash
git add firefox-extension/content.js
git commit -m "Add content script that detects candidate PDF URLs"
```

---

## Task 8: Extension — background script

**Files:**
- Create: `firefox-extension/background.js`

State machine for the toolbar button, plus the fetch + native-messaging plumbing.

- [ ] **Step 1: Create `background.js`**

```javascript
// State per tab: array of candidate PDF URLs reported by the content script.
const candidatesByTab = new Map();

const NATIVE_HOST = "io.github.pemsley.alexandria";
const ICON_ACTIVE = "icons/alexandria-32.png";
const ICON_INACTIVE = "icons/alexandria-32-grey.png";

function setButtonState(tabId, urls) {
  const count = urls.length;
  browser.browserAction.setIcon({
    tabId,
    path: count > 0 ? ICON_ACTIVE : ICON_INACTIVE,
  });
  browser.browserAction.setBadgeText({
    tabId,
    text: count >= 2 ? String(count) : "",
  });
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#3a7" });
  browser.browserAction.setTitle({
    tabId,
    title:
      count === 0
        ? "Save to Alexandria (no PDF detected)"
        : count === 1
        ? "Save to Alexandria"
        : `Save to Alexandria (${count} PDFs found)`,
  });
  // Show popup only when there is a choice to make.
  browser.browserAction.setPopup({
    tabId,
    popup: count >= 2 ? "popup.html" : "",
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  if (msg.type === "candidates") {
    candidatesByTab.set(sender.tab.id, msg.urls || []);
    setButtonState(sender.tab.id, msg.urls || []);
  } else if (msg.type === "get-candidates") {
    // Popup asks for the active tab's candidates.
    return Promise.resolve(candidatesByTab.get(msg.tabId) || []);
  } else if (msg.type === "save-url") {
    return saveUrl(msg.url).then(
      (path) => ({ ok: true, path }),
      (err) => ({ ok: false, error: String(err && err.message || err) }),
    );
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  candidatesByTab.delete(tabId);
});

browser.browserAction.onClicked.addListener(async (tab) => {
  // Only fires when there is no popup, i.e. 0 or 1 candidates.
  const urls = candidatesByTab.get(tab.id) || [];
  if (urls.length !== 1) return; // 0 → button disabled; ≥2 → popup shown
  try {
    const path = await saveUrl(urls[0]);
    notify("Saved to Alexandria", path);
  } catch (err) {
    notify("Save failed", String(err && err.message || err));
  }
});

function basenameFromUrl(url) {
  try {
    const u = new URL(url);
    let name = u.pathname.split("/").filter(Boolean).pop() || "download.pdf";
    name = decodeURIComponent(name);
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    return name;
  } catch (_) {
    return "download.pdf";
  }
}

async function saveUrl(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
  const buf = await resp.arrayBuffer();
  const dataB64 = arrayBufferToBase64(buf);
  const filename = basenameFromUrl(url);

  const reply = await browser.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "save",
    filename,
    data_b64: dataB64,
  });
  if (!reply || !reply.ok) {
    throw new Error((reply && reply.error) || "connector returned no reply");
  }
  return reply.path;
}

function arrayBufferToBase64(buf) {
  // Chunked to avoid `String.fromCharCode(... 50MB ...)` stack issues.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK),
    );
  }
  return btoa(binary);
}

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: ICON_ACTIVE,
    title,
    message,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add firefox-extension/background.js
git commit -m "Add background script: state, fetch, native-messaging"
```

---

## Task 9: Extension — popup picker

**Files:**
- Create: `firefox-extension/popup.html`
- Create: `firefox-extension/popup.js`

Shown when ≥2 PDFs are detected. Lists candidates by URL basename; clicking one triggers the same save flow.

- [ ] **Step 1: Create `popup.html`**

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font: 13px system-ui, sans-serif;
        margin: 0;
        padding: 8px;
        min-width: 320px;
      }
      h1 {
        font-size: 13px;
        font-weight: 600;
        margin: 0 0 8px;
      }
      ul {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      li button {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: 1px solid transparent;
        padding: 6px 8px;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        word-break: break-all;
      }
      li button:hover {
        background: #eef;
        border-color: #99c;
      }
      .status {
        margin-top: 8px;
        color: #555;
      }
      .status.error {
        color: #a00;
      }
    </style>
  </head>
  <body>
    <h1>Save to Alexandria</h1>
    <ul id="list"></ul>
    <div class="status" id="status"></div>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `popup.js`**

```javascript
async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const urls = await browser.runtime.sendMessage({
    type: "get-candidates",
    tabId: tab.id,
  });
  const list = document.getElementById("list");
  const status = document.getElementById("status");
  if (!urls || urls.length === 0) {
    status.textContent = "No PDFs detected on this page.";
    return;
  }
  for (const url of urls) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    let label;
    try {
      const u = new URL(url);
      label = decodeURIComponent(
        u.pathname.split("/").filter(Boolean).pop() || u.href,
      );
    } catch (_) {
      label = url;
    }
    btn.textContent = label;
    btn.title = url;
    btn.addEventListener("click", () => save(url));
    li.appendChild(btn);
    list.appendChild(li);
  }

  async function save(url) {
    status.classList.remove("error");
    status.textContent = "Saving…";
    const reply = await browser.runtime.sendMessage({
      type: "save-url",
      url,
    });
    if (reply && reply.ok) {
      status.textContent = "Saved: " + reply.path;
      setTimeout(() => window.close(), 800);
    } else {
      status.classList.add("error");
      status.textContent =
        "Failed: " + ((reply && reply.error) || "unknown error");
    }
  }
}

init();
```

- [ ] **Step 3: Commit**

```bash
git add firefox-extension/popup.html firefox-extension/popup.js
git commit -m "Add popup picker for multi-PDF pages"
```

---

## Task 10: Extension README and manual test checklist

**Files:**
- Create: `firefox-extension/README.md`

Single source of install instructions and the manual test matrix.

- [ ] **Step 1: Create `firefox-extension/README.md`**

````markdown
# Save to Alexandria — Firefox extension

Adds a toolbar button that drops the article PDF on the current page
into the Alexandria library directory. Works on:

- Direct PDF URLs.
- Publisher pages exposing `<meta name="citation_pdf_url">` (Cell,
  Nature, PLOS, Wiley, ACS, OUP, arXiv, bioRxiv, …).
- Any page with `.pdf` links.

## Install

### 1. Native messaging host

```bash
make -C connector install
```

Then create `~/.config/alexandria-connector/config.toml`:

```toml
library_dir = "/home/you/Papers"
```

### 2. Firefox extension

1. Open `about:debugging#/runtime/this-firefox`.
2. "Load Temporary Add-on…" and pick `firefox-extension/manifest.json`.

The button appears in the toolbar. Greyed out = no PDF detected on the
current page; full-colour = one PDF (click to save); badge with a
number = multiple PDFs (click for a picker).

## Manual test checklist

After loading the extension, verify each row:

| Page                                               | Expected                                  |
|----------------------------------------------------|-------------------------------------------|
| A direct `.pdf` URL                                | Button active; click saves the PDF        |
| Cell article (the spec's example URL)              | Button active; click saves linked PDF     |
| arXiv abstract page (`arxiv.org/abs/...`)          | Button active; click saves the PDF        |
| Page with multiple `.pdf` links                    | Badge shows count; click opens picker     |
| Page with no PDFs (e.g. google.com)                | Button greyed; click does nothing         |
| Paywalled article on a logged-in publisher domain  | PDF downloads using session cookies       |

After each successful save, check that the file appears under
`library_dir`. Run `alexandria-import` to ingest it as usual.

## Uninstall

```bash
make -C connector uninstall
```

Then remove the temporary add-on from `about:debugging`.
````

- [ ] **Step 2: Commit**

```bash
git add firefox-extension/README.md
git commit -m "Add Firefox extension README and manual test checklist"
```

---

## Self-review notes

Spec coverage:
- Detection (citation_pdf_url + .pdf links + pdf-page) → Task 7.
- Toolbar button states + icons + badge → Tasks 6, 8.
- Popup picker on multi-PDF pages → Task 9.
- Fetch with cookies → Task 8 (`credentials: "include"`).
- Native-messaging framing/handler → Tasks 1–4.
- Config at `~/.config/alexandria-connector/config.toml` → Task 2.
- Filename = URL basename → Task 8 (`basenameFromUrl`).
- Collision handling (sha256 idempotent / suffix) → Task 3.
- Repo layout (`firefox-extension/`, `connector/`) → Tasks 1, 5, 6.
- Install via `make -C connector install` → Task 5.
- README test checklist → Task 10.
- No `pdforg-import` invocation → enforced by absence (Task 4 host writes only).
