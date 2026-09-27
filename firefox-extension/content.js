// Find candidate PDF URLs on this page and send them to the background
// script. Seven sources, in priority order:
//   1. <meta name="citation_pdf_url"> (academic publisher convention)
//   2. The page itself if it is a PDF
//   3. The publisher's "PDF" button
//   4. This article's own PDF endpoint, where the publisher also lists one
//      per bibliography entry (ScienceDirect's /pdfft)
//   5. <a href> links that look like a PDF URL
//   6. A PDF embedded in this page with <iframe>/<embed>/<object>
//   7. Links to a viewer page that wraps a PDF (IEEE's stamp.jsp). Last,
//      because the background has to fetch and unwrap one of these.
// Every URL goes through canonicalPdfUrl() (pdf-url.js, loaded before this
// file) first, so publisher URLs that serve an HTML wrapper or reader (Wiley
// /doi/pdf/, /doi/epdf/) become the URL that serves the PDF itself.
//
// We only collect URLs. Fetching, auth, and storage live in the
// background script and the native messaging host respectively.

(function () {
  // Containers and anchors publishers use for the PDF button. Their hrefs
  // sometimes have no `.pdf` suffix (Wiley points at /doi/pdfdirect/...), so
  // take them on the strength of the selector alone.
  //
  // Deliberately not matching on link text: "PDF" is also the label on
  // supporting-information links, and every extra candidate downgrades a
  // one-click save into a pick-one-from-the-popup.
  const BUTTON_SELECTORS = [
    ".article-pdf-button-wrapper a[href]",  // ACS 2026 platform (Silverchair)
    "a.article-pdfLink",                    // OUP and other Silverchair sites
    "a.pdf-download",
    "a.download-pdf",
    'a[data-item-name*="download-pdf" i]',
    'a[data-track-action*="download pdf" i][href]',
  ];

  function absolute(href) {
    try {
      const u = new URL(href, document.baseURI);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return canonicalPdfUrl(u.toString());
    } catch (_) {
      return null;
    }
  }

  function citationPdfUrls() {
    const urls = [];
    document
      .querySelectorAll('meta[name="citation_pdf_url"]')
      .forEach((m) => {
        const v = absolute((m.getAttribute("content") || "").trim());
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

  function pdfButtonUrls() {
    const urls = [];
    document.querySelectorAll(BUTTON_SELECTORS.join(",")).forEach((a) => {
      const v = absolute(a.getAttribute("href") || "");
      if (v) urls.push(v);
    });
    return urls;
  }

  // Publishers list a PDF link for every reference as well as for the article
  // itself, so those endpoints are only safe to offer when the link names this
  // article. Identify it from the publisher's own id metas, falling back to
  // the last segment of the page's path.
  function articleIds() {
    const ids = [];
    ["citation_pii", "citation_doi"].forEach((name) => {
      const m = document.querySelector(`meta[name="${name}"]`);
      const v = m ? (m.getAttribute("content") || "").trim() : "";
      if (v) ids.push(v);
    });
    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments.length) {
      try {
        ids.push(decodeURIComponent(segments[segments.length - 1]));
      } catch (_) {
        ids.push(segments[segments.length - 1]);
      }
    }
    return ids;
  }

  function ownArticlePdfUrls() {
    const ids = articleIds();
    if (ids.length === 0) return [];
    const urls = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const v = absolute(a.getAttribute("href") || "");
      if (!v || !urlLooksLikeReferencePdf(v)) return;
      const path = new URL(v).pathname;
      if (ids.some((id) => path.includes(id))) urls.push(v);
    });
    return urls;
  }

  function pdfLinkUrls() {
    // Keyed by origin+pathname so query-string variants of the same PDF
    // (e.g. Science's /doi/pdf/... and /doi/pdf/...?download=true) count
    // as one candidate, not a two-item picker.
    const byPath = new Map();
    document.querySelectorAll("a[href]").forEach((a) => {
      const v = absolute(a.getAttribute("href") || "");
      if (!v || !urlLooksLikePdf(v)) return;
      const u = new URL(v);
      const key = u.origin + u.pathname;
      if (!byPath.has(key)) byPath.set(key, v);
    });
    return Array.from(byPath.values());
  }

  function embeddedPdfUrls() {
    const urls = [];
    document
      .querySelectorAll("iframe[src], embed[src], object[data]")
      .forEach((el) => {
        const raw = el.getAttribute("src") || el.getAttribute("data") || "";
        const v = absolute(raw);
        if (v && urlLooksLikePdf(v)) urls.push(v);
      });
    return urls;
  }

  function pdfViewerUrls() {
    const urls = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const v = absolute(a.getAttribute("href") || "");
      if (v && urlLooksLikePdfViewer(v)) urls.push(v);
    });
    return urls;
  }

  function scan() {
    return Array.from(
      new Set([
        ...citationPdfUrls(),
        ...pageIsPdfUrl(),
        ...pdfButtonUrls(),
        ...ownArticlePdfUrls(),
        ...pdfLinkUrls(),
        ...embeddedPdfUrls(),
        ...pdfViewerUrls(),
      ]),
    );
  }

  let lastSent = null;

  function report() {
    const candidates = scan();
    const key = candidates.join("\n");
    if (key === lastSent) return;
    lastSent = key;
    browser.runtime.sendMessage({ type: "candidates", urls: candidates });
  }

  // The background can lose its record of this tab's candidates (the add-on
  // reloaded, say). This content script stays alive in the page, so it can
  // answer when the background asks again.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "rescan") return Promise.resolve(scan());
  });

  report();

  // Publisher pages increasingly render the PDF button after `document_idle`,
  // so keep watching for a while rather than judging the page once.
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(report, 300);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setTimeout(() => {
    clearTimeout(timer);
    observer.disconnect();
    report();
  }, 15000);
})();
