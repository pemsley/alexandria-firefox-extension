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
