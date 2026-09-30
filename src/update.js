/* ActiveReader update page: shows whether a newer build exists and how to get it. */
(function () {
  "use strict";

  const AR = globalThis.AR;
  const $ = (id) => document.getElementById(id);

  let settings = null;

  init();

  async function init() {
    $("current-version").textContent = "v" + AR.VERSION;
    $("hero-icon").innerHTML = AR.icon("refresh");

    $("link-repo").href = AR.UPDATE.repoUrl;
    $("link-releases").href = AR.UPDATE.releasesUrl;
    $("link-commits").href = AR.UPDATE.commitsUrl;

    settings = await AR.getSettings();
    $("auto-check").checked = !!settings.autoCheckUpdates;
    $("notify-updates").checked = !!settings.notifyUpdates;

    $("check-now").addEventListener("click", () => checkNow());
    $("get-latest").addEventListener("click", getLatest);
    $("open-extensions").addEventListener("click", openExtensions);
    $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

    $("auto-check").addEventListener("change", () => {
      settings.autoCheckUpdates = $("auto-check").checked;
      AR.saveSettings({ autoCheckUpdates: settings.autoCheckUpdates });
    });
    $("notify-updates").addEventListener("change", () => {
      settings.notifyUpdates = $("notify-updates").checked;
      AR.saveSettings({ notifyUpdates: settings.notifyUpdates });
    });

    const { status } = await AR.getUpdateStatus();
    render(status);

    // Opening this page usually means the user wants current information, so
    // refresh automatically when the last check is missing or old.
    if (!status || !status.checkedAt || Date.now() - status.checkedAt > 5 * 60 * 1000) {
      checkNow({ quiet: true });
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[AR.UPDATE.STATUS_KEY]) render(changes[AR.UPDATE.STATUS_KEY].newValue);
    });
  }

  async function checkNow(opts) {
    const quiet = !!(opts && opts.quiet);
    const btn = $("check-now");

    if (!quiet) {
      btn.disabled = true;
      btn.textContent = "Checking…";
    }

    const res = await AR.sendMessage({ type: AR.MSG.CHECK_UPDATES });

    if (!quiet) {
      btn.disabled = false;
      btn.textContent = "Check again";
    }

    if (res && typeof res === "object" && "checkedAt" in res) {
      render(res);
    } else {
      const { status } = await AR.getUpdateStatus();
      render(status);
    }
  }

  function render(status) {
    const current = AR.VERSION;
    const icon = $("hero-icon");
    icon.className = "hero-icon";

    if (!status) {
      icon.innerHTML = AR.icon("refresh");
      $("hero-title").textContent = "Not checked yet";
      $("hero-sub").textContent = "Press “Check again” to look for a newer version.";
      $("latest-version").textContent = "—";
      $("status-line").textContent = "";
      return;
    }

    const latest = status.latestVersion || "";
    $("latest-version").textContent = latest ? "v" + latest : "—";

    if (AR.hasUpdate(status)) {
      icon.classList.add("update");
      icon.innerHTML = AR.icon("auto_awesome");
      $("hero-title").textContent = "Update available";
      $("hero-sub").textContent = "Version " + latest + " is ready. You have version " + current + ".";
    } else if (status.ok) {
      icon.classList.add("ok");
      icon.innerHTML = AR.icon("check_circle");
      $("hero-title").textContent = "You're up to date";
      $("hero-sub").textContent = "ActiveReader " + current + " is the latest version.";
    } else {
      icon.classList.add("error");
      icon.innerHTML = AR.icon("error");
      $("hero-title").textContent = "Couldn't check for updates";
      $("hero-sub").textContent = status.error || "Check your connection and try again.";
    }

    $("status-line").textContent = status.checkedAt ? "Last checked " + timeAgo(status.checkedAt) + "." : "";
    $("get-latest").classList.toggle("primary", AR.hasUpdate(status));
  }

  async function getLatest() {
    chrome.tabs.create({ url: AR.UPDATE.zipUrl });
    $("status-line").textContent =
      "Download started. Unzip the file, then open chrome://extensions and press Reload on ActiveReader.";
  }

  async function openExtensions() {
    // Whether Chrome lets an extension open chrome:// URLs varies by version, so
    // always leave the manual instruction visible and try to open it too.
    const el = $("status-line");
    el.textContent = "Open chrome://extensions in your address bar, turn on Developer mode and press Reload on ActiveReader.";
    try {
      await chrome.tabs.create({ url: "chrome://extensions/" });
    } catch (e) {
      /* keep the manual instruction */
    }
  }

  function timeAgo(ts) {
    const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    const days = Math.round(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  }
})();
