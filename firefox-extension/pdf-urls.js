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
    /\/pdfdirect\//,     // Wiley
    /\/stamppdf\//,      // IEEE Xplore (the file behind stamp.jsp)
    /\/content\/pdf\//,  // Springer
    /\/pdf\/[^/]+v\d+$/, // arXiv (/pdf/2401.01234v1)
  ];

  // Pages that are not a PDF themselves but wrap one in a viewer. Fetching one
  // yields HTML; the file is behind an <iframe>/<embed> inside it. Worth
  // offering as a candidate, because for some publishers it is the only link
  // on the article page.
  const VIEWER_PATTERNS = [
    /^\/stamp\/stamp\.jsp$/, // IEEE Xplore
    /\/doi\/epdf\//,          // Wiley's reader
  ];

  function pathOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.pathname.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  function looksLikePdfUrl(url) {
    const path = pathOf(url);
    if (path === null) return false;
    if (path.endsWith(".pdf")) return true;
    return ENDPOINT_PATTERNS.some((re) => re.test(path));
  }

  function looksLikePdfViewerUrl(url) {
    const path = pathOf(url);
    if (path === null) return false;
    return VIEWER_PATTERNS.some((re) => re.test(path));
  }

  return { looksLikePdfUrl, looksLikePdfViewerUrl };
})();
