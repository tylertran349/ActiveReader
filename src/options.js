/* ActiveReader options page. */
(function () {
  "use strict";

  const AR = globalThis.AR;
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let saveTimer = null;
  let vocabSearchTimer = null;
  let modelInputTimer = null;
  let pending = {};
  let autofillTried = false;
  let customModels = [];

  init();

  async function init() {
    settings = await AR.getSettings();

    $("preview").innerHTML = AR.icon("play_arrow") + " Preview";

    fillLanguages($("target-lang"), settings.targetLang);
    fillLanguages($("base-lang"), settings.baseLang);

    // Text / password
    bindText("api-key", "geminiApiKey");
    bindText("gemini-model", "geminiModel");
    bindText("custom-base-url", "customApiBaseUrl");
    bindText("custom-api-key", "customApiKey");
    bindText("custom-model", "customApiModel");
    bindText("preview-text", null);

    // LLM provider: switching only changes which fields are visible; the
    // chosen backend is saved immediately.
    const provider = $("llm-provider");
    provider.value = settings.llmProvider;
    provider.addEventListener("change", () => {
      settings.llmProvider = provider.value;
      queueSave({ llmProvider: provider.value });
      syncLlmProvider();
    });

    // Thinking level is populated from the model and saved explicitly.
    $("custom-thinking-level").addEventListener("change", () => {
      queueSave({ customThinkingLevel: $("custom-thinking-level").value });
    });
    $("custom-model").addEventListener("change", () => {
      syncCustomThinking(settings.customApiModel, true);
    });
    // Update the thinking-level list as the user types a known model ID,
    // without waiting for the field to lose focus.
    $("custom-model").addEventListener("input", () => {
      clearTimeout(modelInputTimer);
      modelInputTimer = setTimeout(() => {
        syncCustomThinking(settings.customApiModel, false);
      }, 200);
    });

    // Selects
    bindSelect("target-lang", "targetLang");
    bindSelect("base-lang", "baseLang");
    bindSelect("translation-engine", "translationEngine");
    bindSelect("tts-provider", "ttsProvider");
    bindSelect("theme", "theme");
    bindSelect("accent", "panelAccent");
    bindSelect("quiz-difficulty", "quizDifficulty");
    bindSelect("quiz-language", "quizLanguage");

    // Numbers
    bindNumber("min-len", "minSelectionLength", 1, 100);
    bindNumber("max-len", "maxSelectionLength", 200, 20000);
    bindNumber("quiz-count", "quizCount", 1, 10);

    // Checkboxes
    bindCheck("show-toolbar", "showToolbar");
    bindCheck("auto-translate", "autoTranslate");
    bindCheck("click-define", "clickDefine");
    bindCheck("auto-save", "autoSaveLookups");
    bindCheck("quiz-explain", "quizExplain");
    bindCheck("auto-check-updates", "autoCheckUpdates");
    bindCheck("notify-updates", "notifyUpdates");

    // Ranges
    bindRange("tts-rate", "ttsRate", "tts-rate-val", (v) => v.toFixed(2));
    bindRange("tts-pitch", "ttsPitch", "tts-pitch-val", (v) => v.toFixed(2));

    // Quiz types
    document.querySelectorAll('input[name="quizTypes"]').forEach((box) => {
      box.checked = (settings.quizTypes || []).indexOf(box.value) !== -1;
      box.addEventListener("change", () => {
        const types = Array.from(document.querySelectorAll('input[name="quizTypes"]:checked')).map((b) => b.value);
        queueSave({ quizTypes: types });
      });
    });

    // Site access: allow-list vs block-list, plus the two hostname lists.
    const access = $("site-access");
    access.value = settings.siteAccess;
    access.addEventListener("change", () => {
      settings.siteAccess = access.value;
      queueSave({ siteAccess: access.value });
      syncSiteAccess();
    });

    const enabled = $("enabled-sites");
    enabled.value = (settings.enabledSites || []).join("\n");
    enabled.addEventListener("change", () => queueSave({ enabledSites: parseSites(enabled.value) }));

    const sites = $("disabled-sites");
    sites.value = (settings.disabledSites || []).join("\n");
    sites.addEventListener("change", () => queueSave({ disabledSites: parseSites(sites.value) }));

    syncSiteAccess();
    syncLlmProvider();
    syncCustomThinking(settings.customApiModel);

    // Buttons
    $("toggle-key").addEventListener("click", () => toggleKey("api-key", "toggle-key"));
    $("toggle-custom-key").addEventListener("click", () => toggleKey("custom-api-key", "toggle-custom-key"));
    $("test-gemini").addEventListener("click", testAI);
    $("test-custom").addEventListener("click", testAI);
    $("fetch-models").addEventListener("click", () => fetchModels("gemini"));
    $("fetch-custom-models").addEventListener("click", () => fetchModels("custom"));
    $("preview").addEventListener("click", previewVoice);
    $("api-key").addEventListener("change", maybeAutofillModel);
    $("custom-api-key").addEventListener("change", maybeAutofillModel);
    $("reset-all").addEventListener("click", resetAll);
    $("vocab-search").addEventListener("input", () => {
      clearTimeout(vocabSearchTimer);
      vocabSearchTimer = setTimeout(renderVocab, 120);
    });
    $("export-json").addEventListener("click", () => exportVocab("json"));
    $("export-csv").addEventListener("click", () => exportVocab("csv"));
    $("clear-vocab").addEventListener("click", clearVocab);
    $("export-settings").addEventListener("click", exportBackup);
    $("import-settings").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", onImportFileChosen);

    $("update-repo-link").href = AR.UPDATE.repoUrl;
    $("check-updates").addEventListener("click", checkUpdates);
    $("open-update-page").addEventListener("click", () => send({ type: AR.MSG.OPEN_UPDATE_PAGE }));

    // In-place updater: fetches the repository's files and writes them into the
    // folder the extension is loaded from (File System Access API).
    AR.updater.mount({
      update: "update-now",
      choose: "choose-update-folder",
      forget: "forget-update-folder",
      folder: "update-folder",
      progress: "update-progress"
    });

    maybeAutofillModel();
    refreshCustomThinkingFromCache();
    await renderUpdateStatus();
    await renderVocab();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.savedWords) renderVocab();
      if (area === "local" && changes[AR.UPDATE.STATUS_KEY]) renderUpdateStatus();
    });
  }

  /* ------------------------------------------------------------- binding */

  function bindText(id, key) {
    const el = $(id);
    if (key) el.value = settings[key] == null ? "" : settings[key];
    el.addEventListener("input", () => {
      if (key) queueSave({ [key]: el.value });
    });
  }

  function bindSelect(id, key) {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener("change", () => queueSave({ [key]: el.value }));
  }

  function bindCheck(id, key) {
    const el = $(id);
    el.checked = !!settings[key];
    el.addEventListener("change", () => queueSave({ [key]: el.checked }));
  }

  function bindNumber(id, key, min, max) {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener("change", () => {
      let v = Number(el.value);
      if (!Number.isFinite(v)) v = settings[key];
      v = Math.min(Math.max(v, min), max);
      el.value = v;
      queueSave({ [key]: v });
    });
  }

  function bindRange(id, key, labelId, format) {
    const el = $(id);
    const label = $(labelId);
    el.value = settings[key];
    label.textContent = format(Number(settings[key]));
    el.addEventListener("input", () => {
      const v = Number(el.value);
      label.textContent = format(v);
      queueSave({ [key]: v });
    });
  }

  function fillLanguages(select, selected) {
    select.innerHTML = AR.languageOptionsHtml(selected);
  }

  function parseSites(value) {
    return AR.parseSiteList(value);
  }

  /* The allowed-sites field is only relevant in "selected" mode. */
  function syncSiteAccess() {
    const field = $("enabled-sites-field");
    if (field) field.hidden = settings.siteAccess !== "selected";
  }

  /* Show the field group for the selected LLM backend. */
  function syncLlmProvider() {
    const custom = settings.llmProvider === "custom";
    $("gemini-fields").hidden = custom;
    $("custom-fields").hidden = !custom;
  }

  /* Prefer capabilities from the fetched model list, then the built-in table. */
  function resolveCustomThinking(modelId) {
    const id = String(modelId || "").trim();
    const row = customModels.find((m) => String(m.id || "").toLowerCase() === id.toLowerCase());
    if (row) {
      return {
        levels: row.thinkingLevels || [],
        default: row.defaultThinkingLevel || ""
      };
    }
    return AR.getThinkingLevels(id);
  }

  /* Fill the thinking-level dropdown from the model's capabilities. `info` lets
   * a freshly fetched model row supply levels that are not in the built-in
   * table. The model default is selected when there is one. */
  function syncCustomThinking(modelId, persist, info) {
    const caps = info || resolveCustomThinking(modelId);
    const levels = (caps.levels || []).slice();
    const fallback = caps.default || levels[0] || "";
    const select = $("custom-thinking-level");
    const field = $("custom-thinking-field");
    const note = $("custom-thinking-note");

    select.innerHTML = "";
    if (!levels.length) {
      field.hidden = true;
      if (note) {
        note.hidden = false;
        note.textContent = String(modelId || "").trim()
          ? "This model does not advertise thinking levels; the provider's default is used."
          : "Enter a model ID to see the thinking levels it supports.";
      }
      if (persist && settings.customThinkingLevel) queueSave({ customThinkingLevel: "" });
      return;
    }

    field.hidden = false;
    if (note) {
      note.hidden = false;
      note.textContent =
        "The model's default" +
        (fallback ? " (" + fallback + ")" : "") +
        " is selected unless you choose another level.";
    }

    const current = String(settings.customThinkingLevel || "").toLowerCase();
    const chosen = levels.indexOf(current) !== -1 ? current : fallback;
    levels.forEach((level) => {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level.charAt(0).toUpperCase() + level.slice(1) + (level === fallback ? " (default)" : "");
      select.appendChild(option);
    });
    select.value = chosen;
    settings.customThinkingLevel = chosen;
    if (persist && chosen !== current) queueSave({ customThinkingLevel: chosen });
  }

  /* --------------------------------------------------------------- saving */

  function queueSave(patch) {
    Object.assign(pending, patch);
    Object.assign(settings, patch);
    clearTimeout(saveTimer);
    // Keep well under chrome.storage.sync's write-per-minute quota even when
    // the user types or drags a slider quickly.
    saveTimer = setTimeout(flush, 700);
  }

  async function flush() {
    const patch = pending;
    pending = {};
    if (!Object.keys(patch).length) return;
    await AR.saveSettings(patch);
    showStatus("Saved", "check_circle");
  }

  function showStatus(text, icon) {
    const el = $("save-status");
    el.innerHTML = (icon ? AR.icon(icon) : "") + AR.escapeHtml(text);
    setTimeout(() => {
      if (el.textContent === text) el.innerHTML = "";
    }, 1800);
  }

  /* -------------------------------------------------------------- actions */

  function toggleKey(inputId, buttonId) {
    const input = $(inputId);
    const btn = $(buttonId);
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  }

  async function testAI() {
    const custom = settings.llmProvider === "custom";
    const el = $(custom ? "test-result-custom" : "test-result");
    const providerName = custom ? "the custom API" : "Gemini";

    el.textContent = "Testing…";
    el.className = "test-result";
    await flush();
    const res = await send({ type: AR.MSG.TEST_GEMINI });
    if (res && res.ok) {
      el.innerHTML = AR.icon("check_circle") + AR.escapeHtml('Connected. ' + providerName + ' said: "' + res.reply + '"');
      el.className = "test-result ok";
    } else {
      el.innerHTML = AR.icon("error") + AR.escapeHtml((res && res.error) || "Could not reach " + providerName + ".");
      el.className = "test-result error";
    }
  }

  async function fetchModels(mode) {
    const custom = mode === "custom";
    const btn = $(custom ? "fetch-custom-models" : "fetch-models");
    const box = $(custom ? "custom-model-suggestions" : "model-suggestions");
    const label = btn.textContent;

    // The backend uses the saved provider, so make sure the clicked mode is
    // the active one before asking for its model list.
    if (settings.llmProvider !== mode) {
      settings.llmProvider = mode;
      $("llm-provider").value = mode;
      queueSave({ llmProvider: mode });
      syncLlmProvider();
    }

    btn.disabled = true;
    btn.textContent = "Loading…";
    box.textContent = "";
    await flush();

    const res = await send({ type: AR.MSG.LIST_MODELS, force: true });

    btn.disabled = false;
    btn.textContent = label;

    if (!res || !res.ok) {
      showChipsNote((res && res.error) || "Could not fetch models.", true, box);
      return;
    }

    const models = res.models || [];
    if (!models.length) {
      showChipsNote("No models were returned by this provider.", false, box);
      return;
    }

    autofillTried = true;
    if (custom) customModels = models;
    renderModelChips(models, mode);

    // If the current model is in the fresh list, refresh its levels from the
    // metadata the provider just returned.
    if (custom) {
      const current = models.find((m) => m.id === settings.customApiModel);
      if (current) {
        syncCustomThinking(current.id, false, {
          levels: current.thinkingLevels || [],
          default: current.defaultThinkingLevel || ""
        });
      }
    }
  }

  function showChipsNote(text, isError, box) {
    const target = box || $("model-suggestions");
    target.textContent = "";
    const note = document.createElement("span");
    note.className = "chips-note" + (isError ? " error" : "");
    note.innerHTML = (isError ? AR.icon("error") : "") + AR.escapeHtml(text);
    target.appendChild(note);
  }

  /* Render the live model list as datalist options + clickable chips. */
  function renderModelChips(models, mode) {
    const custom = mode === "custom";
    if (custom) customModels = models;
    const listId = custom ? "custom-model-list" : "model-list";
    const boxId = custom ? "custom-model-suggestions" : "model-suggestions";
    const inputId = custom ? "custom-model" : "gemini-model";
    const settingKey = custom ? "customApiModel" : "geminiModel";

    $(listId).innerHTML = models
      .map((m) => `<option value="${AR.escapeHtml(m.id)}"></option>`)
      .join("");

    const box = $(boxId);
    box.textContent = "";

    models.forEach((m) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = m.id;
      chip.title = m.displayName || m.id;
      chip.addEventListener("click", () => {
        $(inputId).value = m.id;
        settings[settingKey] = m.id;
        queueSave({ [settingKey]: m.id });
        if (custom) {
          syncCustomThinking(m.id, true, {
            levels: m.thinkingLevels || [],
            default: m.defaultThinkingLevel || ""
          });
        }
        showStatus("Saved", "check_circle");
      });
      box.appendChild(chip);
    });
  }

  /* If no model is set yet and a key exists, choose one from the live API list
   * so a new user can generate a quiz without touching the model field. */
  async function maybeAutofillModel() {
    if (autofillTried) return;
    const custom = settings.llmProvider === "custom";
    if (String((custom ? settings.customApiModel : settings.geminiModel) || "").trim()) return;
    if (!String((custom ? settings.customApiKey : settings.geminiApiKey) || "").trim()) return;

    autofillTried = true;
    await flush();

    const res = await send({ type: AR.MSG.LIST_MODELS });
    if (!res || !res.ok || !res.models || !res.models.length) {
      autofillTried = false;
      return;
    }

    const chosen = custom ? res.models[0] : { id: pickDefaultModel(res.models) };
    if (!chosen || !chosen.id) return;

    const inputId = custom ? "custom-model" : "gemini-model";
    const settingKey = custom ? "customApiModel" : "geminiModel";
    $(inputId).value = chosen.id;
    settings[settingKey] = chosen.id;
    await AR.saveSettings({ [settingKey]: chosen.id });

    if (custom) {
      syncCustomThinking(chosen.id, true, {
        levels: chosen.thinkingLevels || [],
        default: chosen.defaultThinkingLevel || ""
      });
    }
    showStatus("Model picked", "check_circle");
    renderModelChips(res.models, custom ? "custom" : "gemini");
  }

  /* On reload, recover provider-advertised thinking levels for a custom model
   * that is not in the built-in table. Uses the cached model list when it is
   * still fresh. */
  async function refreshCustomThinkingFromCache() {
    if (settings.llmProvider !== "custom") return;
    if (!String(settings.customApiBaseUrl || "").trim() || !String(settings.customApiModel || "").trim()) return;
    if (AR.getThinkingLevels(settings.customApiModel).levels.length) return;

    const res = await send({ type: AR.MSG.LIST_MODELS });
    if (!res || !res.ok) return;
    customModels = res.models || [];
    const current = customModels.find((m) => m.id === settings.customApiModel);
    if (!current) return;
    syncCustomThinking(current.id, false, {
      levels: current.thinkingLevels || [],
      default: current.defaultThinkingLevel || ""
    });
  }

  /* Heuristic: prefer a recent "flash" model, avoid lite/preview/experimental. */
  function pickDefaultModel(models) {
    const rank = (id) => {
      let score = 0;
      if (/flash/.test(id)) score += 100;
      if (/pro/.test(id)) score += 60;
      if (/lite/.test(id)) score -= 40;
      if (/preview|exp|experimental|tts|image|embedding|aqa|vision|live/.test(id)) score -= 20;
      const version = id.match(/(\d+)\.(\d+)/);
      if (version) score += Number(version[1]) * 10 + Number(version[2]);
      return score;
    };
    return models
      .map((m) => m.id)
      .sort((a, b) => rank(b) - rank(a))[0];
  }

  async function previewVoice() {
    await flush();
    const text = ($("preview-text").value || "").trim() || "Hello!";
    const res = await send({
      type: AR.MSG.TTS,
      text,
      lang: settings.targetLang,
      provider: settings.ttsProvider
    });
    if (!res || !res.ok) {
      const el = $(settings.llmProvider === "custom" ? "test-result-custom" : "test-result");
      el.innerHTML = AR.icon("error") + AR.escapeHtml((res && res.error) || "Playback failed.");
      el.className = "test-result error";
    }
  }

  async function resetAll() {
    if (!confirm("Reset all ActiveReader settings to their defaults?\n\nYour API keys are kept.")) return;
    const defaults = Object.assign({}, AR.DEFAULTS, {
      geminiApiKey: settings.geminiApiKey,
      customApiKey: settings.customApiKey
    });
    await AR.saveSettings(defaults);
    settings = await AR.getSettings();
    location.reload();
  }

  /* ------------------------------------------------------------- updates */

  async function checkUpdates() {
    const btn = $("check-updates");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";

    const res = await send({ type: AR.MSG.CHECK_UPDATES });

    btn.disabled = false;
    btn.textContent = label;

    if (res && typeof res === "object" && "checkedAt" in res) renderUpdateStatus(res);
    else renderUpdateStatus();
  }

  async function renderUpdateStatus(fresh) {
    const status = fresh || (await AR.getUpdateStatus()).status;
    const badge = $("update-badge");
    const detail = $("update-detail");

    if (!status) {
      badge.textContent = "Not checked yet";
      badge.className = "update-badge";
      detail.textContent = "";
      $("update-status").textContent = "";
      return;
    }

    if (AR.hasUpdate(status)) {
      badge.textContent = "Update available";
      badge.className = "update-badge warn";
      detail.textContent = "Latest is v" + status.latestVersion + " — you have v" + AR.VERSION + ".";
    } else if (status.ok) {
      badge.textContent = "Up to date";
      badge.className = "update-badge ok";
      detail.textContent = "You have the latest version (v" + AR.VERSION + ").";
    } else {
      badge.textContent = "Couldn't check";
      badge.className = "update-badge error";
      detail.textContent = status.error || "Check your connection and try again.";
    }

    $("update-status").textContent = status.checkedAt ? "Last checked " + timeAgo(status.checkedAt) + "." : "";
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

  /* ----------------------------------------------------------- vocabulary */

  async function getVocab() {
    return AR.getSavedWords();
  }

  async function renderVocab() {
    const all = await getVocab();
    const query = ($("vocab-search").value || "").trim().toLowerCase();
    const list = query
      ? all.filter(
          (w) =>
            String(w.text).toLowerCase().indexOf(query) !== -1 ||
            String(w.translation).toLowerCase().indexOf(query) !== -1
        )
      : all;

    $("vocab-count").textContent = all.length
      ? `${list.length} shown · ${all.length} total`
      : "";
    $("vocab-empty").hidden = list.length > 0;

    $("vocab-list").innerHTML = list
      .map(
        (w) => `
        <li>
          <div class="grow">
            <div class="word">${AR.escapeHtml(w.text)}</div>
            ${w.translation ? `<div class="trans">${AR.escapeHtml(w.translation)}</div>` : ""}
            <div class="meta">
              ${AR.escapeHtml(AR.langLabel(w.lang))} → ${AR.escapeHtml(AR.langLabel(w.baseLang))}
              · ${new Date(w.createdAt || Date.now()).toLocaleDateString()}
              ${w.sourceTitle ? " · " + AR.escapeHtml(w.sourceTitle) : ""}
            </div>
          </div>
          <button class="del" data-id="${w.id}" title="Remove">${AR.icon("delete")}</button>
        </li>`
      )
      .join("");

    $("vocab-list").querySelectorAll(".del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const all2 = await getVocab();
        await AR.saveSavedWords(all2.filter((w) => w.id !== btn.dataset.id));
      });
    });
  }

  async function exportVocab(format) {
    const all = await getVocab();
    if (!all.length) {
      alert("No saved words to export yet.");
      return;
    }

    let content;
    let mime;
    let filename;

    if (format === "csv") {
      const rows = [["text", "translation", "language", "baseLanguage", "sourceTitle", "url", "savedAt"]];
      all.forEach((w) => {
        rows.push([
          w.text,
          w.translation,
          w.lang,
          w.baseLang,
          w.sourceTitle,
          w.url,
          w.createdAt ? new Date(w.createdAt).toISOString() : ""
        ]);
      });
      content = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
      mime = "text/csv";
      filename = "activereader-vocabulary.csv";
    } else {
      content = JSON.stringify(all, null, 2);
      mime = "application/json";
      filename = "activereader-vocabulary.json";
    }

    downloadFile(filename, content, mime);
  }

  function csvCell(value) {
    const s = String(value == null ? "" : value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async function clearVocab() {
    const all = await getVocab();
    if (!all.length) return;
    if (!confirm(`Delete all ${all.length} saved words? This cannot be undone.`)) return;
    await AR.saveSavedWords([]);
  }

  /* -------------------------------------------------------- backup/restore */

  /* One file with everything the reader cares about, so it can be restored
   * after a full profile clean. Contains the API keys in plain text. */
  async function exportBackup() {
    const current = await AR.getSettings();
    const savedWords = await AR.getSavedWords();
    const payload = {
      app: "ActiveReader",
      kind: "backup",
      version: AR.VERSION,
      exportedAt: new Date().toISOString(),
      settings: current,
      vocabulary: savedWords
    };
    downloadFile("activereader-backup.json", JSON.stringify(payload, null, 2), "application/json");
    setBackupStatus("Backup file downloaded. Keep it somewhere private — it includes your API key.");
  }

  function onImportFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (file) importBackup(file);
  }

  async function importBackup(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      setBackupStatus("That file isn't a valid ActiveReader backup.", true);
      return;
    }

    // Accept both the wrapped backup file and a bare settings object.
    let incoming = null;
    if (data && data.settings && typeof data.settings === "object") incoming = data.settings;
    else if (data && typeof data === "object" && !Array.isArray(data)) incoming = data;

    const clean = AR.normalizePatch(incoming);
    if (!Object.keys(clean).length) {
      setBackupStatus("That file doesn't contain any ActiveReader settings.", true);
      return;
    }

    if (
      !confirm(
        "Replace your current ActiveReader settings with this backup?\n\nYour saved vocabulary will be merged, not replaced."
      )
    ) {
      return;
    }

    await AR.saveSettings(clean);

    const vocab = Array.isArray(data && data.vocabulary) ? data.vocabulary : [];
    if (vocab.length) {
      const savedWords = await AR.getSavedWords();
      const byId = new Map();
      savedWords.concat(vocab).forEach((w) => {
        if (w && w.id != null) byId.set(String(w.id), w);
      });
      await AR.saveSavedWords(Array.from(byId.values()));
    }

    setBackupStatus("Restored. Reloading…");
    setTimeout(() => location.reload(), 700);
  }

  function setBackupStatus(text, isError) {
    const el = $("backup-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#ef4444" : "";
  }

  /* -------------------------------------------------------------- helpers */

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: (mime || "application/json") + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* Thin alias over the shared helper in config.js. */
  function send(message) {
    return AR.sendMessage(message);
  }
})();
