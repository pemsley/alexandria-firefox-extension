// Shared by background.js and content.js — manifest.json loads this file
// ahead of each of them.
//
// True if `url` plausibly serves a PDF: by .pdf suffix, by being a local
// file, or by matching publisher PDF endpoints (Wiley pdfdirect, ACS and
// Science /doi/pdf/, etc.) that serve `application/pdf` without a .pdf
// suffix.
function urlLooksLikePdf(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Local PDFs (e.g. a paper Firefox just downloaded and opened from
    // ~/Downloads). We can't read the file itself — see resolveFileUrl().
    if (u.protocol === "file:") {
      return u.pathname.toLowerCase().endsWith(".pdf");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const path = u.pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
    // Common publisher PDF endpoints with no .pdf suffix.
    if (/\/pdfdirect\//.test(path)) return true;       // Wiley
    if (/\/doi\/pdf\//.test(path)) return true;        // ACS, Science, others
    if (/\/articlepdf\//.test(path)) return true;      // Springer/Nature
    if (/\/articles\/[^/]+\.pdf$/.test(path)) return true;
    return false;
  } catch (_) {
    return false;
  }
}
