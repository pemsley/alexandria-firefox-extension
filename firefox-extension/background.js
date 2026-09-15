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
        ? "Alexandria connector: No PDF detected"
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
    return saveWithProgress(msg.url, msg.tabId);
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
    notify("Alexandria connector", "No PDF detected on this page.");
    return;
  }
  if (urls.length > 1) {
    // A rescan turned up more than we knew about; setButtonState has just
    // installed the popup, so the next click will offer the choice.
    notify("Save to Alexandria", `${urls.length} PDFs found — click again to choose.`);
    return;
  }
  const result = await saveWithProgress(urls[0], tab.id, urls);
  if (result.ok) {
    notify("Saved to Alexandria", result.path);
  } else {
    notify("Save failed", result.error);
  }
});

// A click can sit for half a minute on a slow publisher, and the button used
// to look identical whether we were still waiting on the server or were most
// of the way through a large PDF. Drive the badge from the transfer instead:
// animated dots while waiting, a percentage once bytes are arriving.
//
// `knownUrls` is what the button goes back to showing once the transfer ends.
// Take it from the caller, which knows what it offered, rather than re-reading
// `candidatesByTab` and risking the two disagreeing.
async function saveWithProgress(url, tabId, knownUrls) {
  const restoreTo = knownUrls || candidatesByTab.get(tabId) || [];
  const indicator = tabId == null ? null : progressIndicator(tabId);
  try {
    const path = await saveUrl(url, (p) => {
      if (indicator) indicator.update(p);
      // The popup shows the same progress; it may not be open.
      browser.runtime
        .sendMessage({ type: "save-progress", progress: p })
        .catch(() => {});
    });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (indicator) {
      indicator.stop();
      setButtonState(tabId, restoreTo);
    }
  }
}

const PROGRESS_COLOUR = "#c80";

function progressIndicator(tabId) {
  let timer = null;
  let downloading = false;

  const badge = (text) => browser.browserAction.setBadgeText({ tabId, text });
  const title = (t) => browser.browserAction.setTitle({ tabId, title: t });

  function dots(label) {
    stopDots();
    let n = 0;
    badge(".");
    title(label);
    timer = setInterval(() => {
      n = (n + 1) % 3;
      badge(".".repeat(n + 1));
    }, 400);
  }

  function stopDots() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  browser.browserAction.setBadgeBackgroundColor({
    tabId,
    color: PROGRESS_COLOUR,
  });
  dots("Alexandria: contacting server…");

  return {
    update(p) {
      if (p.phase === "downloading") {
        if (!downloading) {
          downloading = true;
          stopDots();
        }
        if (p.total > 0) {
          const pct = Math.min(99, Math.floor((p.received / p.total) * 100));
          badge(`${pct}%`);
          title(`Alexandria: downloading ${pct}% of ${humanBytes(p.total)}`);
        } else {
          badge(humanBytes(p.received));
          title(`Alexandria: downloaded ${humanBytes(p.received)}`);
        }
      } else if (p.phase === "saving") {
        downloading = false;
        dots("Alexandria: writing to the library…");
      }
    },
    stop: stopDots,
  };
}

// Badge text only has room for about four characters.
function humanBytes(n) {
  if (n >= 10485760) return `${Math.round(n / 1048576)}M`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}

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

async function saveUrl(url, onProgress) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
  const ctype = (resp.headers.get("content-type") || "").toLowerCase();
  if (ctype && !ctype.includes("application/pdf") && !ctype.includes("application/octet-stream")) {
    throw new Error(`server returned ${ctype || "unknown content-type"}, not a PDF (likely an anti-bot challenge page)`);
  }
  // Content-Length is absent on chunked responses; callers cope with total 0.
  const total = Number(resp.headers.get("content-length")) || 0;
  const bytes = await readBody(resp, total, onProgress);
  if (onProgress) {
    onProgress({ phase: "saving", received: bytes.length, total });
  }
  const dataB64 = bytesToBase64(bytes);
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

// Read the body a chunk at a time rather than with `resp.arrayBuffer()`, so
// there is something to report while a large PDF comes down. Progress is
// throttled: a fast transfer yields hundreds of chunks a second and the badge
// cannot usefully show that.
async function readBody(resp, total, onProgress) {
  if (!resp.body || typeof resp.body.getReader !== "function") {
    return new Uint8Array(await resp.arrayBuffer());
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const now = Date.now();
    if (onProgress && now - lastReport >= 100) {
      lastReport = now;
      onProgress({ phase: "downloading", received, total });
    }
  }
  if (onProgress) onProgress({ phase: "downloading", received, total });

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesToBase64(bytes) {
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
