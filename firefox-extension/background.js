// State per tab: array of candidate PDF URLs reported by the content script.
const candidatesByTab = new Map();

// PDF bytes captured while the tab loaded them, keyed by tab id
// ({url, bytes}). Publishers like ScienceDirect serve PDFs from
// pre-signed URLs that expire within minutes and cannot be fetched a
// second time, so saving must reuse the bytes from the original load.
// This cache (and candidatesByTab) is why the background page is
// persistent: an event page would drop it on suspend.
const capturedByTab = new Map();

// Keep at most this much captured PDF data across all tabs; oldest
// captures are evicted first. A single PDF larger than the per-file
// cap is not captured at all (saving falls back to re-fetching).
const CAPTURE_TOTAL_LIMIT = 200 * 1024 * 1024;
const CAPTURE_FILE_LIMIT = 100 * 1024 * 1024;

const NATIVE_HOST = "io.github.pemsley.alexandria";
const ICON_ACTIVE = "icons/alexandria-32.png";
const ICON_INACTIVE = "icons/alexandria-32-grey.png";

function setButtonState(tabId, urls) {
  const count = urls.length;
  browser.browserAction.setIcon({
    tabId,
    path: count > 0 ? ICON_ACTIVE : ICON_INACTIVE,
  });
  browser.browserAction.setBadgeText({
    tabId,
    text: count >= 2 ? String(count) : "",
  });
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#3a7" });
  browser.browserAction.setTitle({
    tabId,
    title:
      count === 0
        ? "Save to Alexandria (no PDF detected)"
        : count === 1
        ? "Save to Alexandria"
        : `Save to Alexandria (${count} PDFs found)`,
  });
  // Show popup only when there is a choice to make.
  browser.browserAction.setPopup({
    tabId,
    popup: count >= 2 ? "popup.html" : "",
  });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "candidates") {
    if (!sender.tab) return;
    candidatesByTab.set(sender.tab.id, msg.urls || []);
    setButtonState(sender.tab.id, msg.urls || []);
  } else if (msg.type === "get-candidates") {
    return Promise.resolve(candidatesByTab.get(msg.tabId) || []);
  } else if (msg.type === "save-url") {
    return saveUrl(msg.url, msg.tabId).then(
      (path) => ({ ok: true, path }),
      (err) => ({ ok: false, error: String((err && err.message) || err) }),
    );
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  candidatesByTab.delete(tabId);
  capturedByTab.delete(tabId);
});

function storeCapture(tabId, url, bytes) {
  capturedByTab.delete(tabId); // re-insert so Map order tracks recency
  capturedByTab.set(tabId, { url, bytes });
  let total = 0;
  for (const { bytes: b } of capturedByTab.values()) total += b.length;
  for (const key of capturedByTab.keys()) {
    if (total <= CAPTURE_TOTAL_LIMIT || key === tabId) break;
    total -= capturedByTab.get(key).bytes.length;
    capturedByTab.delete(key);
  }
}

// Capture PDF bytes as the tab loads them. filterResponseData() must be
// attached in onBeforeRequest, before the content type is known, so we
// gate on urlLooksLikePdf() and verify the %PDF magic once loaded.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !urlLooksLikePdf(details.url)) return;
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];
    let size = 0;
    filter.ondata = (event) => {
      filter.write(event.data); // always pass through to the page
      if (size < 0) return; // over the cap; stop accumulating
      size += event.data.byteLength;
      if (size > CAPTURE_FILE_LIMIT) {
        chunks.length = 0;
        size = -1;
        return;
      }
      chunks.push(new Uint8Array(event.data));
    };
    filter.onstop = () => {
      filter.close();
      if (size <= 0) return;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      // A login or error page served on a .pdf URL is not a PDF.
      const magic = String.fromCharCode(...bytes.subarray(0, 5));
      if (magic !== "%PDF-") return;
      storeCapture(details.tabId, details.url, bytes);
      maybeMarkTabAsPdf(details.tabId, details.url);
    };
    filter.onerror = () => {
      chunks.length = 0;
    };
  },
  { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
  ["blocking"],
);

// PDF.js renders PDFs in a privileged chrome page where our content script
// does not run, so we'd never get a `candidates` message for direct PDF URLs
// or for publisher endpoints that serve `application/pdf`. Detect those by
// tab-URL pattern from the background, using urlLooksLikePdf() (pdf-url.js).
function maybeMarkTabAsPdf(tabId, url) {
  if (!urlLooksLikePdf(url)) return;
  // Don't clobber a richer list reported by the content script.
  const existing = candidatesByTab.get(tabId) || [];
  if (existing.includes(url)) return;
  if (existing.length === 0) {
    candidatesByTab.set(tabId, [url]);
    setButtonState(tabId, [url]);
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Fires for both direct .pdf navigations and publisher PDF endpoints,
  // including pages that PDF.js renders without running our content script.
  if (changeInfo.url) maybeMarkTabAsPdf(tabId, changeInfo.url);
  else if (changeInfo.status === "complete" && tab && tab.url) {
    maybeMarkTabAsPdf(tabId, tab.url);
  }
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab && tab.url) maybeMarkTabAsPdf(tabId, tab.url);
  } catch (_) { /* tab gone */ }
});

browser.browserAction.onClicked.addListener(async (tab) => {
  // Only fires when there is no popup, i.e. 0 or 1 candidates.
  const urls = candidatesByTab.get(tab.id) || [];
  if (urls.length !== 1) return; // 0 → button disabled; ≥2 → popup shown
  try {
    const path = await saveUrl(urls[0], tab.id);
    notify("Saved to Alexandria", path);
  } catch (err) {
    notify("Save failed", String((err && err.message) || err));
  }
});

function basenameFromUrl(url) {
  try {
    const u = new URL(url);
    let name = u.pathname.split("/").filter(Boolean).pop() || "download.pdf";
    name = decodeURIComponent(name);
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    return name;
  } catch (_) {
    return "download.pdf";
  }
}

// Firefox 74+ forbids extensions from fetching file:// URLs, and the
// native host is sandboxed away from ~/Downloads. So for a local PDF we
// look up the download record that produced it and re-fetch the original
// https URL (usually served straight from the browser cache).
async function resolveFileUrl(fileUrl) {
  const path = decodeURIComponent(new URL(fileUrl).pathname);
  const items = await browser.downloads.search({ exists: true });
  const matches = items.filter((d) => d.filename === path);
  if (matches.length === 0) {
    throw new Error(
      "cannot read local files directly and no download record matches " +
        path,
    );
  }
  matches.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
  return matches[0].finalUrl || matches[0].url;
}

// Pre-signed URLs (ScienceDirect etc.) expire minutes after they are
// minted; re-fetching one past its window returns an HTML error page.
function urlIsPresigned(url) {
  return /[?&]X-Amz-(Signature|Expires)=/i.test(url);
}

async function saveUrl(url, tabId) {
  // Prefer the bytes captured while the tab loaded this PDF: no second
  // download, and the only thing that works for expiring pre-signed URLs.
  const captured = tabId !== undefined && capturedByTab.get(tabId);
  if (captured && captured.url === url) {
    return sendToConnector(captured.bytes, basenameFromUrl(url));
  }

  if (new URL(url).protocol === "file:") {
    url = await resolveFileUrl(url);
  }
  const expiredHint = urlIsPresigned(url)
    ? " (this publisher's PDF links expire after a few minutes — reload the PDF page and click Save again)"
    : "";
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) {
    throw new Error(`fetch failed: ${resp.status} ${resp.statusText}${expiredHint}`);
  }
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (ctype && !ctype.includes("application/pdf") && !ctype.includes("application/octet-stream")) {
    throw new Error(
      `server returned ${ctype}, not a PDF${expiredHint || " (likely an anti-bot challenge page)"}`,
    );
  }
  const buf = await resp.arrayBuffer();
  return sendToConnector(new Uint8Array(buf), basenameFromUrl(url));
}

async function sendToConnector(bytes, filename) {
  const reply = await browser.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "save",
    filename,
    data_b64: arrayBufferToBase64(bytes),
  });
  if (!reply || !reply.ok) {
    throw new Error((reply && reply.error) || "connector returned no reply");
  }
  return reply.path;
}

function arrayBufferToBase64(bytes) {
  // Chunked to avoid `String.fromCharCode(... 50MB ...)` stack issues.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK),
    );
  }
  return btoa(binary);
}

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: ICON_ACTIVE,
    title,
    message,
  });
}
