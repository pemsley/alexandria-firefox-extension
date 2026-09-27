async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const urls = await browser.runtime.sendMessage({
    type: "get-candidates",
    tabId: tab.id,
  });
  const list = document.getElementById("list");
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  const bar = document.getElementById("bar");
  const detail = document.getElementById("detail");
  if (!urls || urls.length === 0) {
    status.textContent = "No PDFs detected on this page.";
    return;
  }
  // Mirror the naming the background uses when it saves, so the button says
  // what you will get. The path is no help for these endpoints: ScienceDirect
  // would label its article PDF "pdfft", right beside a supplementary file
  // showing its real name.
  function labelFor(url) {
    try {
      const u = new URL(url);
      for (const value of u.searchParams.values()) {
        const v = value.trim();
        if (/\.pdf$/i.test(v) && !v.includes("/")) return v;
      }
      return decodeURIComponent(
        u.pathname.split("/").filter(Boolean).pop() || u.href,
      );
    } catch (_) {
      return url;
    }
  }

  for (const url of urls) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = labelFor(url);
    btn.title = url;
    btn.addEventListener("click", () => save(url));
    li.appendChild(btn);
    list.appendChild(li);
  }

  function humanBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " kB";
    return n + " B";
  }

  // Leaving `bar.value` unset keeps the indeterminate animation, which is how
  // "still waiting on the server" reads differently from a real transfer.
  function showProgress(p) {
    progress.hidden = false;
    if (p.phase === "downloading" && p.total > 0) {
      const pct = Math.min(99, Math.floor((p.received / p.total) * 100));
      bar.value = pct;
      detail.textContent = `${pct}% of ${humanBytes(p.total)}`;
    } else if (p.phase === "downloading") {
      bar.removeAttribute("value");
      detail.textContent = humanBytes(p.received);
    } else if (p.phase === "saving") {
      bar.removeAttribute("value");
      detail.textContent = "writing…";
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "save-progress") showProgress(msg.progress);
  });

  async function save(url) {
    status.classList.remove("error");
    status.textContent = "Saving…";
    progress.hidden = false;
    bar.removeAttribute("value");
    detail.textContent = "contacting server…";
    const reply = await browser.runtime.sendMessage({
      type: "save-url",
      url,
      tabId: tab.id,
    });
    progress.hidden = true;
    if (reply && reply.ok) {
      // Deliberately no auto-close: the saved path is the one thing worth
      // reading here, and it is often long. Dismiss with Esc or by clicking
      // away.
      status.textContent = "Saved to:";
      const path = document.createElement("div");
      path.className = "saved-path";
      path.textContent = reply.path;
      status.appendChild(path);
    } else {
      status.classList.add("error");
      status.textContent =
        "Failed: " + ((reply && reply.error) || "unknown error");
    }
  }
}

init();
