/* ActiveReader popup: quick settings + recent vocabulary. */
(function () {
  "use strict";

  const AR = globalThis.AR;
  const $ = (id) => document.getElementById(id);

  const els = {
    targetLang: $("target-lang"),
    baseLang: $("base-lang"),
    ttsProvider: $("tts-provider"),
    showToolbar: $("show-toolbar"),
    autoTranslate: $("auto-translate"),
    keyWarning: $("key-warning"),
    addKey: $("add-key"),
    openOptions: $("open-options"),
    openVocab: $("open-vocab"),
    vocabList: $("vocab-list"),
    vocabEmpty: $("vocab-empty"),
    status: $("status"),
    appVersion: $("app-version"),
    updateBanner: $("update-banner"),
    updateBannerIcon: $("update-banner-icon"),
    updateTitle: $("update-title"),
    updateSub: $("update-sub"),
    updateAction: $("update-action"),
    updateDismiss: $("update-dismiss")
  };

  let settings = null;
  let statusTimer = null;

  init();

  async function init() {
    settings = await AR.getSettings();
    els.openOptions.innerHTML = AR.icon("settings");
    fillLanguageSelect(els.targetLang, settings.targetLang);
    fillLanguageSelect(els.baseLang, settings.baseLang);
    els.ttsProvider.value = settings.ttsProvider;
    els.showToolbar.checked = !!settings.showToolbar;
    els.autoTranslate.checked = !!settings.autoTranslate;
    els.keyWarning.hidden = !!String(settings.geminiApiKey || "").trim();

    els.targetLang.addEventListener("change", () => update({ targetLang: els.targetLang.value }));
    els.baseLang.addEventListener("change", () => update({ baseLang: els.baseLang.value }));
    els.ttsProvider.addEventListener("change", () => update({ ttsProvider: els.ttsProvider.value }));
    els.showToolbar.addEventListener("change", () => update({ showToolbar: els.showToolbar.checked }));
    els.autoTranslate.addEventListener("change", () => update({ autoTranslate: els.autoTranslate.checked }));

    els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
    els.addKey.addEventListener("click", () => chrome.runtime.openOptionsPage());
    els.openVocab.addEventListener("click", () => chrome.runtime.openOptionsPage());

    els.appVersion.textContent = AR.VERSION;
    els.updateDismiss.innerHTML = AR.icon("close");
    els.updateAction.addEventListener("click", onUpdateAction);
    els.updateDismiss.addEventListener("click", dismissUpdate);

    await renderUpdate();
    await renderVocab();
    refreshStaleUpdate();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.savedWords) renderVocab();
      if (area === "local" && (changes[AR.UPDATE.STATUS_KEY] || changes[AR.UPDATE.NOTICE_KEY])) renderUpdate();
    });
  }

  function fillLanguageSelect(select, selected) {
    select.innerHTML = AR.languageOptionsHtml(selected);
  }

  async function update(patch) {
    Object.assign(settings, patch);
    await AR.saveSettings(patch);
    showStatus("Saved");
  }

  function showStatus(message, isError) {
    els.status.textContent = message;
    els.status.classList.toggle("error", !!isError);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      els.status.textContent = "";
    }, 1800);
  }

  /* Show either "an update is available" or "ActiveReader was just updated",
   * whichever is more relevant. Hidden when there is nothing to say. */
  async function renderUpdate() {
    const { status, notice, seen } = await AR.getUpdateStatus();
    let mode = "";

    if (AR.hasUpdate(status) && status.latestVersion !== seen) {
      mode = "available";
      els.updateBannerIcon.innerHTML = AR.icon("auto_awesome");
      els.updateTitle.textContent = "Update available: v" + status.latestVersion;
      els.updateSub.textContent = "You have v" + AR.VERSION + ".";
      els.updateAction.textContent = "Update";
    } else if (notice && notice.to === AR.VERSION) {
      mode = "updated";
      els.updateBannerIcon.innerHTML = AR.icon("check_circle");
      els.updateTitle.textContent = "Updated to v" + notice.to;
      els.updateSub.textContent =
        notice.from && notice.from !== notice.to ? "You were on v" + notice.from + "." : "You're on the latest version.";
      els.updateAction.textContent = "What's new";
    }

    els.updateBanner.dataset.mode = mode;
    els.updateBanner.classList.toggle("ok", mode === "updated");
    els.updateBanner.hidden = !mode;
  }

  function onUpdateAction() {
    if (els.updateBanner.dataset.mode === "updated") {
      chrome.tabs.create({ url: AR.UPDATE.commitsUrl });
    } else {
      AR.sendMessage({ type: AR.MSG.OPEN_UPDATE_PAGE });
    }
  }

  /* Ask the background to re-check when the last result is old. Sent as an
   * "auto" check so the user's auto-check setting is respected. */
  async function refreshStaleUpdate() {
    const { status } = await AR.getUpdateStatus();
    const ttl = AR.UPDATE.CHECK_INTERVAL_MINUTES * 60 * 1000;
    if (status && status.checkedAt && Date.now() - status.checkedAt < ttl) return;
    AR.sendMessage({ type: AR.MSG.CHECK_UPDATES, reason: "auto" });
  }

  async function dismissUpdate() {
    els.updateBanner.hidden = true;
    await AR.sendMessage({ type: AR.MSG.DISMISS_UPDATE });
  }

  async function renderVocab() {
    const savedWords = await AR.getSavedWords();
    const recent = savedWords.slice(0, 8);

    els.vocabEmpty.hidden = recent.length > 0;
    els.vocabList.innerHTML = recent
      .map(
        (w) => `
        <li>
          <div class="grow">
            <div class="word">${AR.escapeHtml(w.text)}</div>
            ${w.translation ? `<div class="trans">${AR.escapeHtml(w.translation)}</div>` : ""}
          </div>
          <button class="del" data-id="${w.id}" title="Remove">${AR.icon("delete")}</button>
        </li>`
      )
      .join("");

    els.vocabList.querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const all = await AR.getSavedWords();
        await AR.saveSavedWords(all.filter((w) => w.id !== id));
        renderVocab();
      });
    });
  }
})();
