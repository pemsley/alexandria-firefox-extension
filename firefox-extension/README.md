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
3. Pin the button to the toolbar: click the puzzle-piece icon (Extensions) in
   the toolbar, find "Save to Alexandria", and click the gear → "Pin to
   Toolbar" (or drag it onto the toolbar via "Customize Toolbar"). Firefox
   hides newly-installed extensions behind the puzzle-piece icon by default.

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
