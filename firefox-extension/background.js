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
    return Promise.resolve(candidatesByTab.get(msg.tabId) || []);
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

browser.browserAction.onClicked.addListener(async (tab) => {
  // Only fires when there is no popup, i.e. 0 or 1 candidates.
  const urls = candidatesByTab.get(tab.id) || [];
  if (urls.length !== 1) return; // 0 → button disabled; ≥2 → popup shown
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
