// State per tab: array of candidate PDF URLs reported by the content script.
const candidatesByTab = new Map();

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
    return candidatesFor(msg.tabId);
  } else if (msg.type === "save-url") {
    return saveUrl(msg.url).then(
      (path) => ({ ok: true, path }),
      (err) => ({ ok: false, error: String((err && err.message) || err) }),
    );
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  candidatesByTab.delete(tabId);
});

// PDF.js renders PDFs in a privileged chrome page where our content script
// does not run, so we'd never get a `candidates` message for direct PDF URLs
// or for publisher endpoints (Wiley pdfdirect, Silverchair article-pdf, IUCr
// .pdf links, etc.) that serve `application/pdf`. Detect those by URL pattern
// from the background, using the same matcher the content script uses.
function urlLooksLikePdf(url) {
  return AlexandriaPdf.looksLikePdfUrl(url);
}

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

// This is a non-persistent background page, so `candidatesByTab` is lost
// every time Firefox unloads us for being idle -- which, on a page you spend
// a few minutes reading, is most of the time you might click the button. The
// per-tab icon and popup settings are held by the browser and survive, so the
// button still looks armed while our side of the state has gone. Ask the
// content script, which is still alive in the page, rather than concluding
// the page has no PDF.
async function candidatesFor(tabId) {
  const cached = candidatesByTab.get(tabId) || [];
  if (cached.length > 0) return cached;
  let urls = await askTab(tabId);
  if (urls === null) {
    // Nothing answered. Tabs that were already open when the add-on was
    // loaded have no content script -- the usual case when running this as a
    // temporary add-on from about:debugging -- so inject one and ask again.
    try {
      await browser.tabs.executeScript(tabId, { file: "pdf-urls.js" });
      await browser.tabs.executeScript(tabId, { file: "content.js" });
      urls = await askTab(tabId);
    } catch (_) {
      // A PDF.js view or a page we are not allowed to inject into.
      // `maybeMarkTabAsPdf` covers the first case.
    }
  }
  if (urls && urls.length > 0) {
    candidatesByTab.set(tabId, urls);
    setButtonState(tabId, urls);
    return urls;
  }
  return cached;
}

// Returns the tab's candidates, or null if no content script answered.
async function askTab(tabId) {
  try {
    return await browser.tabs.sendMessage(tabId, { type: "rescan" });
  } catch (_) {
    return null;
  }
}

browser.browserAction.onClicked.addListener(async (tab) => {
  // Only fires when there is no popup, i.e. 0 or 1 candidates were known
  // when the button state was last set.
  const urls = await candidatesFor(tab.id);
  if (urls.length === 0) {
    notify("Save to Alexandria", "No PDF found on this page.");
    return;
  }
  if (urls.length > 1) {
    // A rescan turned up more than we knew about; setButtonState has just
    // installed the popup, so the next click will offer the choice.
    notify("Save to Alexandria", `${urls.length} PDFs found — click again to choose.`);
    return;
  }
  try {
    const path = await saveUrl(urls[0]);
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

async function saveUrl(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (ctype && !ctype.includes("application/pdf") && !ctype.includes("application/octet-stream")) {
    throw new Error(`server returned ${ctype || "unknown content-type"}, not a PDF (likely an anti-bot challenge page)`);
  }
  const buf = await resp.arrayBuffer();
  const dataB64 = arrayBufferToBase64(buf);
  const filename = basenameFromUrl(url);

  const reply = await browser.runtime.sendNativeMessage(NATIVE_HOST, {
    action: "save",
    filename,
    data_b64: dataB64,
  });
  if (!reply || !reply.ok) {
    throw new Error((reply && reply.error) || "connector returned no reply");
  }
  return reply.path;
}

function arrayBufferToBase64(buf) {
  // Chunked to avoid `String.fromCharCode(... 50MB ...)` stack issues.
  const bytes = new Uint8Array(buf);
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
