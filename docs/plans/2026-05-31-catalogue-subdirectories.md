# Catalogue Subdirectories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user save a PDF into a *catalogue* — an immediate subdirectory of the Alexandria library directory — chosen via a right-click menu on the toolbar button, with the choice remembered.

**Architecture:** The Python native host gains a `list_catalogues` action (lists immediate subdirectories of `library_dir`) and an optional `catalogue` field on `save` (validated as a single safe path segment, written into the existing subdirectory). The extension stores a global `currentCatalogue` in `browser.storage.local`; left-click saves there, a `browser_action` context menu changes it, and the multi-PDF popup carries the same selector.

**Tech Stack:** Python 3.11+ (`unittest`, stdlib only), Firefox WebExtension (MV2, `background.js`/`popup.js`, `browser.*` APIs).

Reference spec: `docs/design/2026-05-31-catalogue-subdirectories.md`.

---

## File structure

- `connector/alexandria_connector.py` — add `UnsafeCatalogue`, `safe_catalogue()`, `list_catalogues()`; extend `_handle()` and `main()`'s exception handling.
- `tests/test_connector.py` — add test classes for the above.
- `firefox-extension/manifest.json` — add `"menus"` permission.
- `firefox-extension/background.js` — storage helpers, `listCatalogues()`, catalogue in `saveUrl`, async title, context menu, new message types.
- `firefox-extension/popup.js` / `popup.html` — catalogue selector.
- `firefox-extension/README.md` — manual checklist rows.

Tests: connector is TDD via `unittest`. The extension has no JS test harness (per the design's manual-checklist decision); its tasks use implementation + manual verification steps.

Run all connector tests with: `python3 -m unittest tests.test_connector -v`

---

## Task 1: `safe_catalogue()` and `UnsafeCatalogue`

**Files:**
- Modify: `connector/alexandria_connector.py` (after the `safe_filename` block, ~line 88)
- Test: `tests/test_connector.py`

- [ ] **Step 1: Write the failing tests**

Add this class to `tests/test_connector.py` after `TestSafeFilename` (around line 92):

```python
class TestSafeCatalogue(unittest.TestCase):
    def test_accepts_plain_name(self):
        self.assertEqual(ac.safe_catalogue("Crystallography"), "Crystallography")

    def test_accepts_name_with_spaces(self):
        self.assertEqual(ac.safe_catalogue("My Papers"), "My Papers")

    def test_accepts_leading_underscore(self):
        # leading underscore is fine; only a leading dot is rejected
        self.assertEqual(ac.safe_catalogue("_figures"), "_figures")

    def test_rejects_empty(self):
        with self.assertRaises(ac.UnsafeCatalogue):
            ac.safe_catalogue("")

    def test_rejects_path_separators(self):
        with self.assertRaises(ac.UnsafeCatalogue):
            ac.safe_catalogue("a/b")
        with self.assertRaises(ac.UnsafeCatalogue):
            ac.safe_catalogue("a\\b")

    def test_rejects_parent_ref(self):
        with self.assertRaises(ac.UnsafeCatalogue):
            ac.safe_catalogue("..")

    def test_rejects_leading_dot(self):
        with self.assertRaises(ac.UnsafeCatalogue):
            ac.safe_catalogue(".hidden")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_connector.TestSafeCatalogue -v`
Expected: FAIL with `AttributeError: module 'alexandria_connector' has no attribute 'safe_catalogue'`

- [ ] **Step 3: Implement `UnsafeCatalogue` and `safe_catalogue`**

In `connector/alexandria_connector.py`, immediately after the `safe_filename` function (after line 87), add:

```python
class UnsafeCatalogue(Exception):
    pass


def safe_catalogue(name: str) -> str:
    """Validate a catalogue as a single safe path segment.

    A catalogue is an immediate subdirectory of `library_dir`. Reject
    anything that could escape it: path separators, `..`, leading dots.
    """
    if not name:
        raise UnsafeCatalogue("empty catalogue name")
    if "/" in name or "\\" in name:
        raise UnsafeCatalogue(f"catalogue contains path separator: {name!r}")
    if name.startswith("."):
        raise UnsafeCatalogue(f"catalogue starts with dot: {name!r}")
    return name
```

Note: a leading-dot check already rejects `..`, so no separate clause is needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_connector.TestSafeCatalogue -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "connector: add safe_catalogue() path-segment validation"
```

---

## Task 2: `list_catalogues()` function

**Files:**
- Modify: `connector/alexandria_connector.py` (after `safe_catalogue`)
- Test: `tests/test_connector.py`

- [ ] **Step 1: Write the failing tests**

Add this class to `tests/test_connector.py` after `TestSafeCatalogue`:

```python
class TestListCatalogues(unittest.TestCase):
    def test_lists_immediate_subdirs_sorted(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "Neuroscience").mkdir()
            (tmp / "Crystallography").mkdir()
            self.assertEqual(
                ac.list_catalogues(tmp),
                ["Crystallography", "Neuroscience"],
            )

    def test_excludes_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "Crystallography").mkdir()
            (tmp / "loose.pdf").write_text("x")
            self.assertEqual(ac.list_catalogues(tmp), ["Crystallography"])

    def test_excludes_hidden_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "Visible").mkdir()
            (tmp / ".hidden").mkdir()
            self.assertEqual(ac.list_catalogues(tmp), ["Visible"])

    def test_empty_when_no_subdirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(ac.list_catalogues(Path(tmp)), [])

    def test_empty_when_dir_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(ac.list_catalogues(Path(tmp) / "nope"), [])
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_connector.TestListCatalogues -v`
Expected: FAIL with `AttributeError: ... has no attribute 'list_catalogues'`

- [ ] **Step 3: Implement `list_catalogues`**

In `connector/alexandria_connector.py`, after `safe_catalogue`, add:

```python
def list_catalogues(library_dir: Path) -> list[str]:
    """Immediate subdirectories of `library_dir`, sorted.

    Hidden entries (names starting with `.`) are omitted. Symlinks
    pointing at directories are included. Returns `[]` when the
    library directory does not yet exist.
    """
    if not library_dir.is_dir():
        return []
    names = [
        p.name
        for p in library_dir.iterdir()
        if p.is_dir() and not p.name.startswith(".")
    ]
    return sorted(names)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_connector.TestListCatalogues -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "connector: add list_catalogues() helper"
```

---

## Task 3: Wire `list_catalogues` and `catalogue` into the message handler

**Files:**
- Modify: `connector/alexandria_connector.py` (`_handle`, ~lines 119-130; `main` except clauses, ~lines 144-151)
- Test: `tests/test_connector.py`

- [ ] **Step 1: Write the failing tests**

Add these methods inside the existing `TestMain` class in `tests/test_connector.py` (after `test_bad_base64_yields_error_reply`):

```python
    def test_list_catalogues_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            lib = tmp / "lib"
            lib.mkdir()
            (lib / "Cryst").mkdir()
            (lib / "Neuro").mkdir()
            cfg = tmp / "config.toml"
            cfg.write_text(f'library_dir = "{lib}"\n')
            reply = self._run({"action": "list_catalogues"}, lib, cfg)
            self.assertTrue(reply["ok"])
            self.assertEqual(reply["catalogues"], ["Cryst", "Neuro"])

    def test_save_into_catalogue(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            lib = tmp / "lib"
            (lib / "Cryst").mkdir(parents=True)
            cfg = tmp / "config.toml"
            cfg.write_text(f'library_dir = "{lib}"\n')
            payload = base64.b64encode(b"PDF-DATA").decode("ascii")
            reply = self._run(
                {"action": "save", "filename": "x.pdf",
                 "catalogue": "Cryst", "data_b64": payload},
                lib, cfg,
            )
            self.assertTrue(reply["ok"])
            self.assertEqual(Path(reply["path"]), lib / "Cryst" / "x.pdf")
            self.assertEqual(Path(reply["path"]).read_bytes(), b"PDF-DATA")

    def test_save_no_catalogue_uses_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            lib = tmp / "lib"
            cfg = tmp / "config.toml"
            cfg.write_text(f'library_dir = "{lib}"\n')
            payload = base64.b64encode(b"PDF-DATA").decode("ascii")
            reply = self._run(
                {"action": "save", "filename": "x.pdf",
                 "catalogue": None, "data_b64": payload},
                lib, cfg,
            )
            self.assertTrue(reply["ok"])
            self.assertEqual(Path(reply["path"]), lib / "x.pdf")

    def test_save_nonexistent_catalogue_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            lib = tmp / "lib"
            lib.mkdir()
            cfg = tmp / "config.toml"
            cfg.write_text(f'library_dir = "{lib}"\n')
            payload = base64.b64encode(b"x").decode("ascii")
            reply = self._run(
                {"action": "save", "filename": "x.pdf",
                 "catalogue": "Ghost", "data_b64": payload},
                lib, cfg,
            )
            self.assertFalse(reply["ok"])
            self.assertIn("catalogue not found", reply["error"])

    def test_save_catalogue_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            lib = tmp / "lib"
            lib.mkdir()
            cfg = tmp / "config.toml"
            cfg.write_text(f'library_dir = "{lib}"\n')
            payload = base64.b64encode(b"x").decode("ascii")
            reply = self._run(
                {"action": "save", "filename": "x.pdf",
                 "catalogue": "../escape", "data_b64": payload},
                lib, cfg,
            )
            self.assertFalse(reply["ok"])
            self.assertIn("catalogue", reply["error"].lower())
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m unittest tests.test_connector.TestMain -v`
Expected: the five new tests FAIL (e.g. `list_catalogues` returns `unknown action`; catalogue save writes to root; traversal not rejected).

- [ ] **Step 3: Update `_handle`**

Replace the body of `_handle` (lines 119-130) in `connector/alexandria_connector.py` with:

```python
def _handle(msg: dict, config_path: Path) -> dict:
    action = msg.get("action")
    if action == "list_catalogues":
        library_dir = load_library_dir(config_path)
        return {"ok": True, "catalogues": list_catalogues(library_dir)}
    if action != "save":
        return {"ok": False, "error": f"unknown action: {action!r}"}
    library_dir = load_library_dir(config_path)
    filename = safe_filename(msg.get("filename", ""))
    catalogue = msg.get("catalogue")
    if catalogue:
        safe_cat = safe_catalogue(catalogue)
        target_dir = library_dir / safe_cat
        if not target_dir.is_dir():
            return {"ok": False, "error": f"catalogue not found: {safe_cat}"}
    else:
        target_dir = library_dir
    try:
        data = base64.b64decode(msg["data_b64"], validate=True)
    except (KeyError, ValueError) as exc:
        return {"ok": False, "error": f"bad base64 payload: {exc}"}
    path = write_pdf(target_dir, filename, data)
    return {"ok": True, "path": str(path)}
```

- [ ] **Step 4: Update `main` to catch `UnsafeCatalogue`**

In `main`, the existing two except clauses (lines 146-149) read:

```python
    except ConfigError as exc:
        reply = {"ok": False, "error": str(exc)}
    except UnsafeFilename as exc:
        reply = {"ok": False, "error": str(exc)}
```

Replace them with a single combined clause:

```python
    except (ConfigError, UnsafeFilename, UnsafeCatalogue) as exc:
        reply = {"ok": False, "error": str(exc)}
```

- [ ] **Step 5: Run the full connector suite to verify it passes**

Run: `python3 -m unittest tests.test_connector -v`
Expected: PASS (all tests, including the three earlier task classes and the existing ones)

- [ ] **Step 6: Commit**

```bash
git add connector/alexandria_connector.py tests/test_connector.py
git commit -m "connector: route save into catalogue subdirectory; add list_catalogues action"
```

---

## Task 4: Extension — manifest permission + background storage/save plumbing

**Files:**
- Modify: `firefox-extension/manifest.json` (`permissions`, lines 14-20)
- Modify: `firefox-extension/background.js`

No JS test harness exists; verify by loading the extension. Do the manual verification in Step 5.

- [ ] **Step 1: Add the `menus` permission**

In `firefox-extension/manifest.json`, change the `permissions` array (lines 14-20) to include `"menus"`:

```json
  "permissions": [
    "activeTab",
    "tabs",
    "nativeMessaging",
    "notifications",
    "menus",
    "<all_urls>"
  ],
```

- [ ] **Step 2: Add storage helpers and `listCatalogues` to `background.js`**

In `firefox-extension/background.js`, after the constant declarations (after line 6, before `setButtonState`), add:

```javascript
async function getCurrentCatalogue() {
  const { currentCatalogue } = await browser.storage.local.get(
    "currentCatalogue",
  );
  return currentCatalogue || null;
}

async function setCurrentCatalogue(name) {
  await browser.storage.local.set({ currentCatalogue: name || null });
}

async function listCatalogues() {
  try {
    const reply = await browser.runtime.sendNativeMessage(NATIVE_HOST, {
      action: "list_catalogues",
    });
    if (reply && reply.ok && Array.isArray(reply.catalogues)) {
      return reply.catalogues;
    }
  } catch (_) {
    /* connector missing or old version */
  }
  return [];
}
```

- [ ] **Step 3: Make `setButtonState` async and append the catalogue to the title**

Replace `setButtonState` (lines 8-33) with:

```javascript
async function setButtonState(tabId, urls) {
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
  const cat = await getCurrentCatalogue();
  const suffix = cat ? ` → ${cat}` : "";
  browser.browserAction.setTitle({
    tabId,
    title:
      count === 0
        ? "Save to Alexandria (no PDF detected)"
        : count === 1
        ? `Save to Alexandria${suffix}`
        : `Save to Alexandria (${count} PDFs found)${suffix}`,
  });
  // Show popup only when there is a choice to make.
  browser.browserAction.setPopup({
    tabId,
    popup: count >= 2 ? "popup.html" : "",
  });
}
```

Existing callers invoke `setButtonState(...)` without awaiting; that stays fine (fire-and-forget).

- [ ] **Step 4: Include the catalogue in `saveUrl`'s native message**

In `saveUrl` (lines 127-147), after `const filename = basenameFromUrl(url);` add the catalogue read and pass it in the message. Replace the `sendNativeMessage` call block with:

```javascript
  const filename = basenameFromUrl(url);
  const catalogue = await getCurrentCatalogue();

  const reply = await browser.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "save",
    filename,
    catalogue: catalogue || null,
    data_b64: dataB64,
  });
```

- [ ] **Step 5: Manual verification**

Load the extension via `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → `firefox-extension/manifest.json`. Confirm:
- No manifest/permission errors in the add-on's console.
- On a single-PDF page, the button tooltip reads "Save to Alexandria" (no catalogue chosen yet) and clicking still saves to the library root.

- [ ] **Step 6: Commit**

```bash
git add firefox-extension/manifest.json firefox-extension/background.js
git commit -m "extension: remember currentCatalogue and send it on save"
```

---

## Task 5: Extension — right-click catalogue menu

**Files:**
- Modify: `firefox-extension/background.js`

- [ ] **Step 1: Add menu constants and a rebuild function**

In `firefox-extension/background.js`, after the `listCatalogues` function (from Task 4), add:

```javascript
const MENU_ROOT_ID = "catalogue-root";
const MENU_PREFIX = "catalogue:";

async function rebuildCatalogueMenu() {
  await browser.menus.removeAll();
  const current = await getCurrentCatalogue();
  browser.menus.create({
    id: MENU_ROOT_ID,
    type: "radio",
    title: "Library root",
    checked: !current,
    contexts: ["browser_action"],
  });
  const cats = await listCatalogues();
  for (const name of cats) {
    browser.menus.create({
      id: MENU_PREFIX + name,
      type: "radio",
      title: name,
      checked: current === name,
      contexts: ["browser_action"],
    });
  }
}

async function refreshActiveTabTitle() {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (tab) setButtonState(tab.id, candidatesByTab.get(tab.id) || []);
}
```

- [ ] **Step 2: Register menu lifecycle listeners**

At the end of `firefox-extension/background.js`, after the `notify` function, add:

```javascript
// Rebuild on demand so the radio list reflects the live subdirectories
// and the currently-remembered catalogue each time the menu opens.
browser.menus.onShown.addListener(async () => {
  await rebuildCatalogueMenu();
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);
  let name = null;
  if (id !== MENU_ROOT_ID && id.startsWith(MENU_PREFIX)) {
    name = id.slice(MENU_PREFIX.length);
  }
  await setCurrentCatalogue(name);
  await refreshActiveTabTitle();
});

// Build the menu once at startup so it exists before the first onShown.
rebuildCatalogueMenu();
```

- [ ] **Step 3: Manual verification**

Reload the temporary add-on. With the connector installed and at least two subdirectories under `library_dir`:
- Right-click the toolbar button → a radio list shows "Library root" + each subdirectory; "Library root" is checked initially.
- Select a subdirectory → its radio becomes checked; the button tooltip updates to "Save to Alexandria → <name>".
- Left-click a single-PDF page → the file lands in `library_dir/<name>/`.
- Select "Library root" again → saves return to the top level.
- With the connector NOT installed, the menu still shows just "Library root" (no crash).

- [ ] **Step 4: Commit**

```bash
git add firefox-extension/background.js
git commit -m "extension: browser-action context menu to choose catalogue"
```

---

## Task 6: Extension — catalogue selector in the multi-PDF popup

**Files:**
- Modify: `firefox-extension/background.js` (message listener, lines 35-48)
- Modify: `firefox-extension/popup.html`
- Modify: `firefox-extension/popup.js`

- [ ] **Step 1: Add `get-catalogues` and `set-catalogue` message handlers**

In `firefox-extension/background.js`, extend the `browser.runtime.onMessage` listener (lines 35-48). After the `save-url` branch and before the closing `}`, add two branches:

```javascript
  } else if (msg.type === "get-catalogues") {
    return Promise.all([listCatalogues(), getCurrentCatalogue()]).then(
      ([catalogues, current]) => ({ catalogues, current }),
    );
  } else if (msg.type === "set-catalogue") {
    return setCurrentCatalogue(msg.name || null).then(() => {
      refreshActiveTabTitle();
      return { ok: true };
    });
```

- [ ] **Step 2: Add a selector container to `popup.html`**

In `firefox-extension/popup.html`, add a styled block and a container. First, add CSS inside the `<style>` block (after the `.status.error` rule, before `</style>`):

```css
      .catalogue {
        margin: 0 0 8px;
        padding-bottom: 8px;
        border-bottom: 1px solid #ddd;
      }
      .catalogue label {
        display: block;
        padding: 3px 4px;
        cursor: pointer;
      }
      .catalogue .heading {
        font-weight: 600;
        margin-bottom: 4px;
      }
```

Then add the container in the `<body>`, between the `<h1>` and the `<ul id="list">`:

```html
    <div class="catalogue" id="catalogue"></div>
```

- [ ] **Step 3: Populate and wire the selector in `popup.js`**

In `firefox-extension/popup.js`, inside `init()`, after the `const status = document.getElementById("status");` line (line 9), add a call to render the selector and the renderer itself. Insert this block right after line 9:

```javascript
  await renderCatalogues();

  async function renderCatalogues() {
    const box = document.getElementById("catalogue");
    const { catalogues, current } = await browser.runtime.sendMessage({
      type: "get-catalogues",
    });
    box.innerHTML = "";
    const heading = document.createElement("div");
    heading.className = "heading";
    heading.textContent = "Save to:";
    box.appendChild(heading);

    const options = [{ name: null, label: "Library root" }].concat(
      (catalogues || []).map((name) => ({ name, label: name })),
    );
    for (const opt of options) {
      const label = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "catalogue";
      radio.checked = (current || null) === opt.name;
      radio.addEventListener("change", () => {
        browser.runtime.sendMessage({ type: "set-catalogue", name: opt.name });
      });
      label.appendChild(radio);
      label.appendChild(document.createTextNode(" " + opt.label));
      box.appendChild(label);
    }
  }
```

Because `saveUrl` in the background reads `currentCatalogue` from storage at save time, selecting a radio (which persists via `set-catalogue`) is enough to route the subsequent PDF click — no other change to `save()` is needed.

- [ ] **Step 4: Manual verification**

Reload the add-on. On a page with **two or more** `.pdf` links:
- Click the toolbar button → popup opens showing "Save to:" with "Library root" + subdirectories, the current one selected.
- Pick a subdirectory, then click a PDF row → the file lands in that subdirectory and the popup reports the saved path.
- Reopen the popup → the previously chosen catalogue is still selected (persisted), and the toolbar tooltip reflects it.

- [ ] **Step 5: Commit**

```bash
git add firefox-extension/background.js firefox-extension/popup.html firefox-extension/popup.js
git commit -m "extension: catalogue selector in the multi-PDF popup"
```

---

## Task 7: Documentation — README manual checklist

**Files:**
- Modify: `firefox-extension/README.md`

- [ ] **Step 1: Document catalogue behaviour and add checklist rows**

In `firefox-extension/README.md`, after the paragraph describing the button states (the one ending "click for a picker", around line 36), add:

```markdown
### Catalogues

Catalogues are immediate subdirectories of your `library_dir`. Right-click
the toolbar button to pick the destination catalogue ("Library root" or any
subdirectory); the choice is remembered and shown in the button tooltip.
Left-click then saves into that catalogue. The multi-PDF popup has the same
selector. The connector only writes into subdirectories that already exist —
create catalogues in Alexandria first.
```

Then add these rows to the manual test checklist table (after the "Paywalled article…" row, around line 49):

```markdown
| Right-click button (≥1 subdir under library_dir)   | Menu lists "Library root" + each subdirectory     |
| Select a catalogue, then left-click a 1-PDF page   | PDF saved into that subdirectory; tooltip updated |
| Multi-PDF page                                     | Popup shows catalogue selector; routes correctly  |
| Select "Library root"                              | Saves return to the top-level library_dir         |
```

- [ ] **Step 2: Verify the table renders**

Run: `python3 -c "import pathlib; print('OK' if 'Catalogues' in pathlib.Path('firefox-extension/README.md').read_text() else 'MISSING')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add firefox-extension/README.md
git commit -m "docs: document catalogue selection in the extension README"
```

---

## Final verification

- [ ] Run the full connector suite: `python3 -m unittest tests.test_connector -v` — expect all PASS.
- [ ] Load the extension and walk the new README checklist rows end-to-end against a real `library_dir` with subdirectories.
