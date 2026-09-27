// Shared PDF-URL recognition, loaded by both the content script and the
// background script (manifest.json loads this file ahead of each of them).
// Content scripts in a tab share one isolated global, as do the background
// scripts, so these top-level names are simply visible to whichever file is
// loaded after this one. `var` rather than `const` at top level, so that
// injecting this file again into a tab (see candidatesFor()) is harmless.
//
// Kept in one place because the callers must agree: the content script
// decides which page links are worth offering, and the background script
// decides whether a tab that PDF.js rendered (no content script runs there)
// is itself a PDF, and which page loads to capture.

// Publisher PDF endpoints whose path carries no `.pdf` suffix. Anchored
// enough to avoid matching article landing pages that merely mention PDF.
var PDF_ENDPOINT_PATTERNS = [
  /\/article-pdf\//,   // Silverchair: ACS (2026 platform), OUP
  /\/articlepdf\//,    // Springer Nature
  /\/doi\/pdf\//,      // ACS (legacy), Science, Taylor & Francis, SAGE, Royal Society
  /\/pdfdirect\//,     // Wiley
  /\/stamppdf\//,      // IEEE Xplore (the file behind stamp.jsp)
  /\/content\/pdf\//,  // Springer
  /\/pdf\/[^/]+v\d+$/, // arXiv (/pdf/2401.01234v1)
];

// Pages that are not a PDF themselves but wrap one in a viewer. Fetching one
// yields HTML; the file is behind an <iframe>/<embed> inside it. Worth
// offering as a candidate, because for some publishers it is the only link
// on the article page.
var PDF_VIEWER_PATTERNS = [
  /^\/stamp\/stamp\.jsp$/, // IEEE Xplore
  /\/doi\/epdf\//,          // Wiley's reader (canonicalPdfUrl() usually gets there first)
];

// Endpoints a page lists once per bibliography entry as well as for the
// article itself -- one ScienceDirect page carries 22 of them. Offered only
// when the link also names this article, so they are kept out of
// PDF_ENDPOINT_PATTERNS and matched separately.
var REFERENCE_PDF_PATTERNS = [
  /\/pdfft$/, // ScienceDirect: /science/article/pii/<pii>/pdfft
];

function httpPathOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.pathname.toLowerCase();
  } catch (_) {
    return null;
  }
}

// True if `url` plausibly serves a PDF: by .pdf suffix, by being a local
// .pdf file, or by matching a publisher endpoint that serves
// `application/pdf` without a .pdf suffix.
function urlLooksLikePdf(url) {
  if (!url) return false;
  try {
    // Local PDFs (e.g. a paper Firefox just downloaded and opened from
    // ~/Downloads). We can't read the file itself -- see resolveFileUrl().
    const u = new URL(url);
    if (u.protocol === "file:") {
      return u.pathname.toLowerCase().endsWith(".pdf");
    }
  } catch (_) {
    return false;
  }
  const path = httpPathOf(url);
  if (path === null) return false;
  if (path.endsWith(".pdf")) return true;
  return PDF_ENDPOINT_PATTERNS.some((re) => re.test(path));
}

function urlLooksLikePdfViewer(url) {
  const path = httpPathOf(url);
  if (path === null) return false;
  return PDF_VIEWER_PATTERNS.some((re) => re.test(path));
}

function urlLooksLikeReferencePdf(url) {
  const path = httpPathOf(url);
  if (path === null) return false;
  return REFERENCE_PDF_PATTERNS.some((re) => re.test(path));
}

// Map a publisher URL that is *about* a PDF but serves HTML onto the URL
// that serves the PDF bytes. Anything not recognised comes back unchanged.
//
// Wiley: citation_pdf_url is /doi/pdf/DOI, which is an HTML wrapper
// around the /doi/epdf/DOI reader; the reader's own Download button
// fetches /doi/pdfdirect/DOI?download=true. Society journals live on
// subdomains such as febs.onlinelibrary.wiley.com.
function canonicalPdfUrl(url) {
  try {
    const u = new URL(url);
    const wiley =
      u.hostname === "onlinelibrary.wiley.com" ||
      u.hostname.endsWith(".onlinelibrary.wiley.com");
    const m = u.pathname.match(/^\/doi\/e?pdf\/(.+)$/);
    if (wiley && m) {
      return `${u.origin}/doi/pdfdirect/${m[1]}?download=true`;
    }
    return url;
  } catch (_) {
    return url;
  }
}
