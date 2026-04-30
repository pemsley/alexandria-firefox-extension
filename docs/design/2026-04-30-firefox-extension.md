# Firefox extension: "Save to Alexandria"

**Date:** 2026-04-30
**Status:** Design approved; ready for implementation plan.

## Goal

A Firefox extension that, while browsing a publisher's article page (HTML)
or a direct PDF URL, lets the user drop the article's PDF into the
Alexandria library directory in one click. Once the file is in the library,
Alexandria's existing `pdforg-import` pipeline owns the rest (renaming,
metadata, indexing).

The extension itself is metadata-blind: it delivers a PDF, nothing more.

## Non-goals

- No metadata scraping or sidecar JSON authoring by the extension.
- No filename beautification — saved as the PDF URL's basename.
- No invocation of `pdforg-import` from the native host.
- No AMO signing / packaging in v1; loaded as a temporary add-on.
- No support for Chromium-based browsers in v1.

## Architecture

Three components:

1. **Content script** — runs in the page; finds candidate PDF URLs.
2. **Background script + browser-action button** — owns UI state, fetches
   PDFs with the user's session cookies, forwards bytes to the native host.
3. **Native messaging host** — short-lived Python script; writes the PDF
   into the configured library directory.

Data flow:

```
page → content script (URLs only) → background (fetch w/ cookies)
     → native host (write file to library_dir)
```

The extension never touches the filesystem. The native host never
touches the network.

## Detection (content script)

On page load, collect candidate PDF URLs from:

1. `<meta name="citation_pdf_url">` tags — primary signal; covers most
   academic publishers (Cell/Elsevier, Nature, PLOS, Wiley, ACS, OUP,
   arXiv, bioRxiv, …).
2. `<a href$=".pdf">` and `<a href*=".pdf?">` — fallback for preprint
   servers, lab pages, theses.
3. If `document.contentType === "application/pdf"`, the page itself is a
   PDF — use `window.location.href`.

De-duplicate (resolved absolute URLs), send to background as
`{type: "candidates", urls: [...]}`.

## Toolbar button states

Single browser-action button is the only entry point.

| Detected PDFs | Icon                          | Badge | Click behaviour              |
|---------------|-------------------------------|-------|------------------------------|
| 0             | Alexandria SVG, desaturated   | none  | disabled / no-op             |
| 1             | Alexandria SVG, full colour   | none  | save immediately             |
| ≥2            | Alexandria SVG, full colour   | count | open popup picker            |

Icons are reused from `data/io.github.pemsley.Alexandria.svg`. Two PNG
variants are generated (full-colour and desaturated) and shipped under
`firefox-extension/icons/`.

## Popup picker (multi-PDF case)

Plain list of detected URLs, each showing the URL basename. Clicking a
row triggers the same fetch-and-send flow as the single-PDF case and
closes the popup.

## Fetch and delivery

Background script:

- `fetch(url, {credentials: "include"})` — uses the browser's session
  cookies so paywalled / authenticated content downloads correctly.
- `await response.arrayBuffer()` → base64-encode.
- Send to native host via `browser.runtime.connectNative(...)`:
  ```json
  {"action": "save",
   "filename": "S0969212617303374.pdf",
   "data_b64": "<base64>"}
  ```

Filename is the URL basename (`new URL(url).pathname` → last segment,
stripped of query string). Sanity-checked to end in `.pdf`; if not,
`.pdf` is appended.

Native messaging size limits (Firefox): extension → host messages may
be up to 4 GB, which comfortably accommodates any PDF.

## Native messaging host

Small Python script, `connector/alexandria_connector.py`, installed at
`~/.local/bin/alexandria-connector`.

**Registration:** manifest at
`~/.mozilla/native-messaging-hosts/io.github.pemsley.alexandria.json`,
with `path` pointing at the installed script and `allowed_extensions`
listing the Firefox extension's ID.

**Wire format:** standard native-messaging framing — 4-byte
little-endian length prefix, then UTF-8 JSON payload, on stdin/stdout.
The host reads exactly one message per spawn, replies, exits.

**Reply format:**

```json
{"ok": true, "path": "/home/paule/Papers/S0969212617303374.pdf"}
```

or

```json
{"ok": false, "error": "library_dir not configured"}
```

**Config:** `~/.config/alexandria-connector/config.toml`:

```toml
library_dir = "/home/paule/Papers"
```

Read on each invocation. If the file or `library_dir` key is missing,
host returns an `ok: false` error and the extension shows a "configure
library directory" notification.

**Filename collisions:**

- If `<library_dir>/<basename>.pdf` does not exist → write it.
- If it exists and the SHA-256 of the bytes matches → no-op success
  (idempotent re-save).
- If it exists with different bytes → append `-1`, `-2`, … before
  `.pdf` until a free name is found, then write.

**Errors surfaced:** missing config, unwritable directory, bad base64,
disk full. All come back to the extension as
`{"ok": false, "error": "<message>"}`.

## Notifications

- **Success:** `browser.notifications.create()` with the saved filename.
- **Failure:** notification with the error message returned by the
  host (or "Alexandria connector not installed" if the native message
  port disconnects immediately).

## Repository layout

New top-level directories, sibling to `pdforg/`:

```
firefox-extension/
  manifest.json
  background.js
  content.js
  popup.html
  popup.js
  icons/
    alexandria-32.png
    alexandria-32-grey.png
  README.md
connector/
  alexandria_connector.py
  io.github.pemsley.alexandria.json.in
  Makefile
```

The connector lives at the top level (not nested inside
`firefox-extension/`) because it is a separate installable artifact
with its own install/uninstall lifecycle.

## Install flow

1. `make -C connector install`
   - Copies `alexandria_connector.py` to `~/.local/bin/alexandria-connector`.
   - Writes the native-messaging manifest to
     `~/.mozilla/native-messaging-hosts/` with the absolute path to the
     installed script and the extension ID interpolated.
2. User edits `~/.config/alexandria-connector/config.toml` to set
   `library_dir`.
3. Load `firefox-extension/` as a temporary add-on via
   `about:debugging` → "Load Temporary Add-on…".

## Testing

**Connector (automated, pytest):**

- Feed a length-prefixed JSON message on stdin, assert file is written
  to a tmp library dir, assert reply JSON on stdout.
- Cases: happy path; config missing; `library_dir` unwritable;
  identical-bytes idempotent re-save; collision with different bytes
  → suffix appended; malformed base64.

**Extension (manual checklist in `firefox-extension/README.md`):**

- A Cell/Elsevier article page (the original example URL).
- An arXiv abstract page.
- A direct `.pdf` URL.
- A page with no PDFs (button stays greyed).
- A page with multiple `.pdf` links (popup appears).
- A paywalled article on a logged-in domain (cookies applied).

No automated browser tests in v1.

## Permissions

`manifest.json`:

```json
"permissions": [
  "activeTab",
  "nativeMessaging",
  "notifications",
  "<all_urls>"
]
```

`<all_urls>` is required because the content script needs to run on
arbitrary publisher pages and the background script needs to `fetch()`
PDF URLs cross-origin.

## Out of scope (deferred)

- Per-publisher rules for sites that don't expose `citation_pdf_url`
  and don't use `.pdf` link extensions.
- Auto-running `pdforg-import` after save.
- Localhost HTTP transport (Zotero-style) — would require Alexandria
  GTK app to be running.
- Capturing source-page metadata into a partial sidecar JSON.
- Chromium support, AMO signing, .xpi distribution.
