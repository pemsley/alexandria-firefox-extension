// Find candidate PDF URLs on this page and send them to the background
// script. Six sources, in priority order:
//   1. <meta name="citation_pdf_url"> (academic publisher convention)
//   2. The page itself if it is a PDF
//   3. The publisher's "PDF" button
//   4. <a href> links that look like a PDF URL
//   5. A PDF embedded in this page with <iframe>/<embed>/<object>
//   6. Links to a viewer page that wraps a PDF (IEEE's stamp.jsp). Last,
//      because the background has to fetch and unwrap one of these.
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
      return u.toString();
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

  function pdfLinkUrls() {
    const urls = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const v = absolute(a.getAttribute("href") || "");
      if (v && AlexandriaPdf.looksLikePdfUrl(v)) urls.push(v);
    });
    return urls;
  }

  function embeddedPdfUrls() {
    const urls = [];
    document
      .querySelectorAll("iframe[src], embed[src], object[data]")
      .forEach((el) => {
        const raw = el.getAttribute("src") || el.getAttribute("data") || "";
        const v = absolute(raw);
        if (v && AlexandriaPdf.looksLikePdfUrl(v)) urls.push(v);
      });
    return urls;
  }

  function pdfViewerUrls() {
    const urls = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const v = absolute(a.getAttribute("href") || "");
      if (v && AlexandriaPdf.looksLikePdfViewerUrl(v)) urls.push(v);
    });
    return urls;
  }

  function scan() {
    return Array.from(
      new Set([
        ...citationPdfUrls(),
        ...pageIsPdfUrl(),
        ...pdfButtonUrls(),
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

  // The background is an event page: it is unloaded when idle, taking its
  // record of this tab's candidates with it. This content script stays alive
  // in the page, so it can answer when the background asks again.
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
