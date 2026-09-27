// Find candidate PDF URLs on this page and send them to the background
// script. Three sources, in priority order:
//   1. <meta name="citation_pdf_url"> (academic publisher convention)
//   2. The page itself if it is a PDF
//   3. <a href> links that look like a PDF per urlLooksLikePdf()
//      (pdf-url.js, loaded before this file): .pdf suffix or a known
//      publisher PDF endpoint such as Science/ACS /doi/pdf/.
// Sources 1 and 3 go through canonicalPdfUrl() (also pdf-url.js) first,
// so publisher URLs that serve an HTML wrapper or reader (Wiley /doi/pdf/,
// /doi/epdf/) become the URL that serves the PDF itself.
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
        if (v) urls.push(canonicalPdfUrl(v));
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
    // Keyed by origin+pathname so query-string variants of the same PDF
    // (e.g. Science's /doi/pdf/... and /doi/pdf/...?download=true) count
    // as one candidate, not a two-item picker.
    const byPath = new Map();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      let abs;
      try {
        abs = new URL(canonicalPdfUrl(new URL(href, document.baseURI).toString()));
      } catch (_) {
        return; /* skip malformed */
      }
      if (!urlLooksLikePdf(abs.toString())) return;
      const key = abs.origin + abs.pathname;
      if (!byPath.has(key)) byPath.set(key, abs.toString());
    });
    return Array.from(byPath.values());
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
