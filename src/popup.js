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
    status: $("status")
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

    await renderVocab();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.savedWords) renderVocab();
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

  async function renderVocab() {
    const { savedWords = [] } = await chrome.storage.local.get({ savedWords: [] });
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
        const { savedWords: all = [] } = await chrome.storage.local.get({ savedWords: [] });
        await chrome.storage.local.set({ savedWords: all.filter((w) => w.id !== id) });
        renderVocab();
      });
    });
  }
})();
