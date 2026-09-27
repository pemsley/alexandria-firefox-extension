// Run with: node --test tests/test_pdf_url.mjs
//
// pdf-url.js is a plain browser script (no exports), so load it into a
// fresh context and pull its top-level functions out of that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(
  new URL("../firefox-extension/pdf-url.js", import.meta.url),
  "utf8",
);
const ctx = vm.createContext({ URL });
vm.runInContext(src, ctx);
const { urlLooksLikePdf, canonicalPdfUrl } = ctx;

const PDFDIRECT =
  "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/pro.3943?download=true";

test("Wiley /doi/pdf/ (citation_pdf_url, serves HTML) -> pdfdirect", () => {
  assert.equal(
    canonicalPdfUrl("https://onlinelibrary.wiley.com/doi/pdf/10.1002/pro.3943"),
    PDFDIRECT,
  );
});

test("Wiley /doi/epdf/ reader -> pdfdirect", () => {
  assert.equal(
    canonicalPdfUrl("https://onlinelibrary.wiley.com/doi/epdf/10.1002/pro.3943"),
    PDFDIRECT,
  );
});

test("Wiley society subdomains are rewritten too", () => {
  assert.equal(
    canonicalPdfUrl("https://febs.onlinelibrary.wiley.com/doi/epdf/10.1111/febs.1"),
    "https://febs.onlinelibrary.wiley.com/doi/pdfdirect/10.1111/febs.1?download=true",
  );
});

test("Wiley pdfdirect is left alone", () => {
  assert.equal(canonicalPdfUrl(PDFDIRECT), PDFDIRECT);
});

test("non-Wiley /doi/pdf/ (ACS, Science) is left alone", () => {
  const acs = "https://pubs.acs.org/doi/pdf/10.1021/acs.jcim.0c01234";
  assert.equal(canonicalPdfUrl(acs), acs);
});

test("malformed URL is returned unchanged", () => {
  assert.equal(canonicalPdfUrl("not a url"), "not a url");
});

test("rewritten Wiley URLs look like PDFs", () => {
  assert.ok(urlLooksLikePdf(PDFDIRECT));
});
