# Firefox extension: save into catalogue subdirectories

**Date:** 2026-05-31
**Status:** Design approved; ready for implementation plan.

## Goal

Let the user drop a PDF into a *catalogue* — a subdirectory of the
Alexandria library directory — instead of only the top-level directory.

Alexandria gained multi-directory libraries ("catalogues") in
`alexandria` commit `a65a4c6`. There a catalogue is `{name,
library_root}` and `library_root` may technically be any path. For
this extension we adopt a tighter policy: **a catalogue is always a
subdirectory of the one main library directory** (`~/Documents/
Alexandria`). This keeps every save target inside the single path a
Flatpak install is granted (`--filesystem=xdg-documents`), so the
connector never needs access outside its sandbox.

The extension stays metadata-blind: it delivers a PDF into a chosen
directory, nothing more. Alexandria's `pdforg-import` pipeline still
owns renaming, metadata, and indexing.

## Non-goals

- No reading or writing of Alexandria's own `config.json`. Catalogues
  are discovered purely by listing subdirectories.
- The connector never creates catalogue directories. The user makes
  those in Alexandria; the extension only writes into existing ones.
- No per-tab or per-site catalogue memory — a single global "current
  catalogue" default.
- No cross-catalogue features, moving papers, etc. (Alexandria's
  concern, not the extension's.)

## Decisions (from brainstorming)

1. **Discovery:** the connector lists the immediate subdirectories of
   `library_dir`. Fully decoupled from Alexandria's config. Stray
   folders (e.g. `_figures`) are listed too; the user picks sensibly.
2. **Save flow:** left-click saves instantly to the *remembered*
   catalogue (default: library root). The chooser changes the
   remembered default.
3. **Chooser access:** a right-click context menu on the toolbar
   button (Firefox `browser_action` menu) lists catalogues as radio
   items. The multi-PDF popup carries the same selector.

## Connector protocol (`connector/alexandria_connector.py`)

### New action: `list_catalogues`

Request:

```json
{"action": "list_catalogues"}
```

Reply:

```json
{"ok": true, "catalogues": ["Crystallography", "Neuroscience", "_figures"]}
```

- Immediate subdirectories of `library_dir` only (not recursive).
- Sorted; names only (no leading path). The extension prepends its own
  "Library root" option.
- Symlinks to directories are included (treated like directories).
- If `library_dir` does not yet exist, return `{"ok": true,
  "catalogues": []}` (consistent with `save` creating it lazily).
- Hidden entries (names starting with `.`) are omitted.

### `save` gains an optional `catalogue` field

Request:

```json
{"action": "save",
 "filename": "S0969212617303374.pdf",
 "catalogue": "Crystallography",
 "data_b64": "<base64>"}
```

- `catalogue` is a single path segment. Validated like `filename`:
  reject empty-after-strip, `/`, `\`, `..`, and leading `.`. A new
  `safe_catalogue()` helper (mirroring `safe_filename`) raises
  `UnsafeCatalogue` on violation.
- Missing, `null`, or empty `catalogue` → save into `library_dir`
  (today's behaviour, unchanged).
- The target directory is `library_dir/<catalogue>`. It must already
  exist and be a directory; otherwise reply `{"ok": false, "error":
  "catalogue not found: <name>"}`. The host does **not** create it.
- Collision handling (`write_pdf`) is unchanged, applied within the
  chosen directory.

The host still never touches the network and writes only inside
`library_dir`.

## Extension

### Remembered target

`browser.storage.local`, key `currentCatalogue`:

- `null` (or missing) → library root.
- a string → that subdirectory name.

Single global value; persists across sessions; shared across tabs.

### `background.js`

- `saveUrl(url)` reads `currentCatalogue` from storage and includes it
  as `catalogue` in the `save` message (omitted/`null` for root).
- New helper `listCatalogues()` → `sendNativeMessage({action:
  "list_catalogues"})`, returning the array (or `[]` on error).
- Button title reflects the current target, e.g.
  `"Save to Alexandria → Crystallography"` (or plain
  `"Save to Alexandria"` for the root). Updated in `setButtonState`
  and whenever `currentCatalogue` changes.
- Context menu (requires `menus` permission):
  - One parent-less set of radio items in the `browser_action`
    context: **Library root** + one per subdirectory.
  - Rebuilt on `menus.onShown` from a fresh `listCatalogues()` call,
    then `menus.refresh()`; the current target is checked.
  - `menus.onClicked` writes `currentCatalogue` (null for root) and
    refreshes the title.

### `popup.{html,js}` (multi-PDF case)

- A catalogue selector (radio list: Library root + subdirectories) is
  shown above the PDF list, populated via `get-catalogues` message to
  the background.
- Changing the selection writes `currentCatalogue` (via a
  `set-catalogue` message to the background) so it persists and matches
  the menu.
- Clicking a PDF saves it to the currently selected catalogue, as today.

### Message types (content/popup ↔ background)

- `get-catalogues` → background replies with the catalogue array.
- `set-catalogue` `{name|null}` → background persists `currentCatalogue`
  and updates the title.

### `manifest.json`

- Add `"menus"` to `permissions` (Firefox accepts `menus`; the
  `contextMenus` alias also works — use `menus`).

## Error handling

- `list_catalogues` failure (connector missing, etc.): menu falls back
  to just "Library root"; popup selector shows only "Library root".
- Saving to a catalogue that has since been removed: connector returns
  `{"ok": false, "error": "catalogue not found: ..."}`, surfaced via the
  existing failure notification. The user can pick another target.

## Testing

**Connector (pytest, `tests/test_connector.py`):**

- `list_catalogues`: subdirectories listed and sorted; files and hidden
  entries excluded; empty when none; empty when `library_dir` absent.
- `save` with `catalogue`: writes into the named subdirectory; nonexistent
  subdirectory → `ok: false`; path-traversal / separator / `..` rejected
  via `UnsafeCatalogue`; missing/empty `catalogue` falls back to root.

**Extension (manual checklist in `firefox-extension/README.md`):**

Add rows for:

- Right-click button → catalogue menu lists subdirectories; selecting
  one updates the button title.
- After selecting a catalogue, left-click saves into that subdirectory.
- Multi-PDF popup shows the catalogue selector and routes correctly.
- Selecting "Library root" restores top-level saves.

## Out of scope (deferred)

- Reading Alexandria's `config.json` for authoritative catalogue names.
- Nested (multi-level) catalogues.
- Creating catalogues from the extension.
- Per-site / per-tab catalogue defaults.
