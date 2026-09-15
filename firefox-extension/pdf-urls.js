// Shared PDF-URL recognition, loaded by both the content script and the
// background script (see manifest.json). Content scripts in a tab share one
// isolated global, as do the background scripts, so `AlexandriaPdf` is simply
// visible to whichever file is loaded after this one.
//
// Kept in one place because the two callers must agree: the content script
// decides which page links are worth offering, and the background script
// decides whether a tab that PDF.js rendered (no content script runs there)
// is itself a PDF.

var AlexandriaPdf = (function () {
  // Publisher PDF endpoints whose path carries no `.pdf` suffix. Anchored
  // enough to avoid matching article landing pages that merely mention PDF.
  const ENDPOINT_PATTERNS = [
    /\/article-pdf\//,   // Silverchair: ACS (2026 platform), OUP
    /\/articlepdf\//,    // Springer Nature
    /\/doi\/pdf\//,      // ACS (legacy), Taylor & Francis, SAGE, Royal Society
    /\/doi\/epdf\//,     // Wiley / ACS inline reader
    /\/pdfdirect\//,     // Wiley
    /\/content\/pdf\//,  // Springer
    /\/pdf\/[^/]+v\d+$/, // arXiv (/pdf/2401.01234v1)
  ];

  function looksLikePdfUrl(url) {
    if (!url) return false;
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
    return ENDPOINT_PATTERNS.some((re) => re.test(path));
  }

  return { looksLikePdfUrl };
})();
