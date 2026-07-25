async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const urls = await browser.runtime.sendMessage({
    type: "get-candidates",
    tabId: tab.id,
  });
  const list = document.getElementById("list");
  const status = document.getElementById("status");
  if (!urls || urls.length === 0) {
    status.textContent = "No PDFs detected on this page.";
    return;
  }
  for (const url of urls) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    let label;
    try {
      const u = new URL(url);
      label = decodeURIComponent(
        u.pathname.split("/").filter(Boolean).pop() || u.href,
      );
    } catch (_) {
      label = url;
    }
    btn.textContent = label;
    btn.title = url;
    btn.addEventListener("click", () => save(url));
    li.appendChild(btn);
    list.appendChild(li);
  }

  async function save(url) {
    status.classList.remove("error");
    status.textContent = "Saving…";
    const reply = await browser.runtime.sendMessage({
      type: "save-url",
      url,
      tabId: tab.id,
    });
    if (reply && reply.ok) {
      status.textContent = "Saved: " + reply.path;
      setTimeout(() => window.close(), 800);
    } else {
      status.classList.add("error");
      status.textContent =
        "Failed: " + ((reply && reply.error) || "unknown error");
    }
  }
}

init();
