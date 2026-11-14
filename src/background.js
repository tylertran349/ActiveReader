/*
 * ActiveReader service worker.
 * Owns every network call (Gemini/custom AI + Google Translate), TTS
 * orchestration and the context menu. Keeps API keys out of web pages.
 */
importScripts("lib/config.js");

const AR = globalThis.AR;
const MSG = AR.MSG;

let creatingOffscreen = null;
let offscreenCloseTimer = null;

/* ------------------------------------------------------------ lifecycle */

chrome.runtime.onInstalled.addListener(async (details) => {
  // Menus must always be rebuilt, even if seeding settings fails.
  buildContextMenus();
  try {
    // getSettings() also restores from the local mirror if sync was wiped, so
    // run it first and persist the result instead of blindly writing defaults.
    await AR.saveSettings(await AR.getSettings());
  } catch (e) {
    /* seeding is best effort */
  }

  // A real version change means the extension itself was updated: remember it so
  // the popup can show a "what's new" notice.
  if (details && details.reason === "update" && details.previousVersion && details.previousVersion !== AR.VERSION) {
    await recordUpdateNotice(details.previousVersion);
  }

  // Keep the periodic check running on the user's schedule and look right away.
  await syncUpdateAlarm();
  checkForUpdate({ reason: "auto" }).catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  buildContextMenus();
  await syncUpdateAlarm();
  checkForUpdate({ reason: "auto" }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === AR.UPDATE.ALARM_NAME) checkForUpdate({ reason: "auto" }).catch(() => {});
});

/* Mirror settings into the local backup on every change, including ones that
 * arrive through Chrome Sync from another computer. This is what lets a wiped
 * sync area be rebuilt. Also react to the update settings themselves. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.autoCheckUpdates) syncUpdateAlarm();
  chrome.storage.sync
    .get(null)
    .then((all) => AR.writeLocalBackup(all))
    .catch(() => {});
});

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    const items = [
      { id: "ar-translate", title: "ActiveReader: Translate “%s”", contexts: ["selection"] },
      { id: "ar-speak", title: "ActiveReader: Listen to selection", contexts: ["selection"] },
      { id: "ar-quiz", title: "ActiveReader: Quiz me on selection", contexts: ["selection"] },
      { id: "ar-save", title: "ActiveReader: Save to vocabulary", contexts: ["selection"] }
    ];
    for (const item of items) chrome.contextMenus.create(item);
  });
}

const MENU_COMMANDS = {
  "ar-translate": "translate",
  "ar-speak": "speak",
  "ar-quiz": "quiz",
  "ar-save": "save"
};

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  const command = MENU_COMMANDS[info.menuItemId];
  if (!command) return;

  // Respect the site-access settings: never act on a page the reader has not
  // enabled ActiveReader for. When the host cannot be determined, fall through
  // and let the content script's own guard decide.
  const settings = await AR.getSettings();
  const host = AR.hostFromUrl(info.pageUrl || tab.url || "");
  if (host && !AR.isSiteActive(settings, host)) return;

  const ok = await ensureContentScript(tab.id);
  if (!ok) return;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: MSG.COMMAND,
      command,
      text: info.selectionText || ""
    });
  } catch (e) {
    /* page may have navigated away */
  }
});

/* The content script is normally injected by the manifest, but tabs that were
 * already open before install (or after an extension reload) will not have it.
 * In that case the old script's global flag survives in the isolated world, so
 * remove any leftover host + flag before injecting a fresh copy. */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    return true;
  } catch (e) {
    /* not there yet */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          delete window.__activeReaderInjected;
          const stale = document.getElementById("active-reader-root");
          if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
        } catch (e) {
          /* ignore */
        }
      }
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/lib/config.js", "src/content.js"]
    });
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------- router */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  // Messages addressed to the offscreen document are ignored here.
  if (msg.target === MSG.TARGET_OFFSCREEN) return undefined;

  // Internal messages coming back from the offscreen document.
  if (msg.target === MSG.TARGET_BG) {
    if (msg.type === MSG.TTS_FALLBACK) {
      handleBrowserTts(msg.text, msg.lang).catch(() => {});
    } else if (msg.type === MSG.TTS_STATE) {
      if (msg.state === "ended" || msg.state === "failed") scheduleOffscreenClose();
    }
    return undefined;
  }

  switch (msg.type) {
    case MSG.PING:
      sendResponse({ ok: true });
      return undefined;
    case MSG.TRANSLATE:
      handleTranslate(msg).then(sendResponse);
      return true;
    case MSG.DEFINE:
      handleDefine(msg).then(sendResponse);
      return true;
    case MSG.QUIZ:
      handleQuiz(msg).then(sendResponse);
      return true;
    case MSG.GRADE:
      handleGrade(msg).then(sendResponse);
      return true;
    case MSG.TTS:
      handleTts(msg).then(sendResponse);
      return true;
    case MSG.SAVE:
      handleSave(msg).then(sendResponse);
      return true;
    case MSG.TEST_GEMINI:
      testAI().then(sendResponse);
      return true;
    case MSG.LIST_MODELS:
      listModels(!!msg.force).then(sendResponse);
      return true;
    case MSG.OPEN_OPTIONS:
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return undefined;
    case MSG.CHECK_UPDATES:
      checkForUpdate({ reason: msg.reason === "auto" ? "auto" : "manual" }).then(sendResponse);
      return true;
    case MSG.DISMISS_UPDATE:
      dismissUpdate(msg.version).then(() => sendResponse({ ok: true }));
      return true;
    case MSG.OPEN_UPDATE_PAGE:
      openUpdatePage();
      sendResponse({ ok: true });
      return undefined;
    default:
      return undefined;
  }
});

/* -------------------------------------------------------------- updates */

/* ActiveReader is loaded unpacked, so Chrome never updates it by itself. The
 * background periodically reads the version in this GitHub repo's manifest.json
 * and, when it is newer, flags the toolbar badge, notifies (optionally) and lets
 * the UI point the user at the download. Only the version number is fetched. */

const NOTIFY_UPDATE = "ar-update-available";
const NOTIFY_UPDATED = "ar-updated";

let updateCheckInFlight = null;

/* Public entry point. Auto checks honour the setting; a manual check always
 * runs. Concurrent requests share one network call. */
async function checkForUpdate(opts) {
  const reason = (opts && opts.reason) || "manual";

  if (reason === "auto") {
    const settings = await AR.getSettings();
    if (!settings.autoCheckUpdates) return (await readUpdateStatus()) || emptyUpdateStatus();
  }

  if (updateCheckInFlight) return updateCheckInFlight;
  updateCheckInFlight = runUpdateCheck(reason).finally(() => {
    updateCheckInFlight = null;
  });
  return updateCheckInFlight;
}

async function runUpdateCheck(reason) {
  const previous = await readUpdateStatus();
  let status;

  try {
    // raw.githubusercontent.com sends `Access-Control-Allow-Origin: *`, so this
    // works without a host permission. `no-store` avoids a stale cached copy.
    const res = await fetch(AR.UPDATE.manifestUrl, { cache: "no-store", credentials: "omit" });
    if (!res.ok) throw new Error("GitHub replied " + res.status + ".");
    const data = await res.json();
    const latest = String((data && data.version) || "").trim();
    if (!AR.parseVersion(latest)) throw new Error("The latest manifest has no usable version.");

    status = {
      ok: true,
      reason,
      currentVersion: AR.VERSION,
      latestVersion: latest,
      updateAvailable: AR.isNewerVersion(latest, AR.VERSION),
      checkedAt: Date.now()
    };
  } catch (e) {
    status = {
      ok: false,
      reason,
      currentVersion: AR.VERSION,
      // Keep the last known version so a transient failure does not lose it.
      latestVersion: (previous && previous.latestVersion) || "",
      updateAvailable: !!(previous && previous.updateAvailable),
      checkedAt: Date.now(),
      error: e.message || "Could not check for updates."
    };
  }

  await writeUpdateStatus(status);
  await refreshUpdateBadge();
  await maybeNotifyUpdate(status);
  return status;
}

function emptyUpdateStatus() {
  return { ok: false, currentVersion: AR.VERSION, latestVersion: "", updateAvailable: false, checkedAt: 0 };
}

async function readUpdateStatus() {
  try {
    const store = await chrome.storage.local.get(AR.UPDATE.STATUS_KEY);
    return store[AR.UPDATE.STATUS_KEY] || null;
  } catch (e) {
    return null;
  }
}

async function writeUpdateStatus(status) {
  try {
    await chrome.storage.local.set({ [AR.UPDATE.STATUS_KEY]: status });
  } catch (e) {
    /* best effort */
  }
}

async function readLocal(key, fallback) {
  try {
    const store = await chrome.storage.local.get(key);
    return key in store ? store[key] : fallback;
  } catch (e) {
    return fallback;
  }
}

/* Keep the periodic alarm in sync with the autoCheckUpdates setting. */
async function syncUpdateAlarm() {
  try {
    const settings = await AR.getSettings();
    if (settings.autoCheckUpdates) {
      await chrome.alarms.create(AR.UPDATE.ALARM_NAME, {
        periodInMinutes: AR.UPDATE.CHECK_INTERVAL_MINUTES
      });
    } else {
      await chrome.alarms.clear(AR.UPDATE.ALARM_NAME);
    }
  } catch (e) {
    /* alarms are best effort */
  }
}

/* Red "NEW" badge on the toolbar icon until the user dismisses the version. */
async function refreshUpdateBadge() {
  try {
    const status = await readUpdateStatus();
    const seen = await readLocal(AR.UPDATE.SEEN_KEY, "");
    const show = AR.hasUpdate(status) && status.latestVersion !== seen;

    await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    await chrome.action.setBadgeText({ text: show ? "NEW" : "" });
    await chrome.action.setTitle({
      title: show ? "ActiveReader — update available (v" + status.latestVersion + ")" : "ActiveReader"
    });
  } catch (e) {
    /* action API unavailable; badge is cosmetic */
  }
}

/* One desktop notification per discovered version, at most. */
async function maybeNotifyUpdate(status) {
  if (!AR.hasUpdate(status)) return;

  const settings = await AR.getSettings();
  if (!settings.notifyUpdates) return;

  const already = await readLocal(AR.UPDATE.NOTIFIED_KEY, "");
  if (already === status.latestVersion) return;

  const shown = await notify(
    NOTIFY_UPDATE,
    "ActiveReader update available",
    "Version " + status.latestVersion + " is ready (you have " + AR.VERSION + "). Click to update."
  );
  if (shown) {
    try {
      await chrome.storage.local.set({ [AR.UPDATE.NOTIFIED_KEY]: status.latestVersion });
    } catch (e) {
      /* best effort */
    }
  }
}

/* Record that the extension itself just changed version, for the "what's new"
 * banner. Resets dismissals and drops the previous check result, which pointed
 * at an older target, so nothing claims an update is available until the fresh
 * check finishes. */
async function recordUpdateNotice(previousVersion) {
  try {
    await chrome.storage.local.set({
      [AR.UPDATE.NOTICE_KEY]: { from: String(previousVersion || ""), to: AR.VERSION, at: Date.now() }
    });
    await chrome.storage.local.remove([AR.UPDATE.SEEN_KEY, AR.UPDATE.STATUS_KEY]);
  } catch (e) {
    /* best effort */
  }

  await refreshUpdateBadge();

  const settings = await AR.getSettings();
  if (settings.notifyUpdates) {
    notify(
      NOTIFY_UPDATED,
      "ActiveReader updated",
      "You are now on version " + AR.VERSION + ". Click to see what changed."
    ).catch(() => {});
  }
}

function notify(id, title, message) {
  if (!chrome.notifications) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(
        id,
        {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: String(title),
          message: String(message),
          priority: 1
        },
        () => {
          // Reading lastError also clears it; a value means creation failed.
          resolve(!chrome.runtime.lastError);
        }
      );
    } catch (e) {
      resolve(false);
    }
  });
}

if (chrome.notifications) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIFY_UPDATE && id !== NOTIFY_UPDATED) return;
    chrome.notifications.clear(id);
    openUpdatePage();
  });
}

function openUpdatePage() {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/update.html") });
}

/* Hide the badge/banner for a version without changing the check result. */
async function dismissUpdate(version) {
  const status = await readUpdateStatus();
  const value = String(version || "").trim() || (status && status.latestVersion) || "";
  try {
    await chrome.storage.local.set({ [AR.UPDATE.SEEN_KEY]: value });
    await chrome.storage.local.remove(AR.UPDATE.NOTICE_KEY);
  } catch (e) {
    /* best effort */
  }
  await refreshUpdateBadge();
}

/* ----------------------------------------------------------- translation */

const TRANSLATION_CACHE_KEY = "translationCache";

/* Small, fast, non-cryptographic string hash (djb2). Used for cache keys. */
function hashString(str) {
  const s = String(str);
  let hash = 5381;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  return hash >>> 0;
}

/* Cheap stable key for a (text, target, engine) triple. */
function translationCacheKey(text, target, engine) {
  return engine + "|" + target + "|" + text.length + "|" + hashString(text).toString(36);
}

async function getCachedTranslation(key) {
  try {
    const store = (await chrome.storage.session.get(TRANSLATION_CACHE_KEY))[TRANSLATION_CACHE_KEY] || {};
    const hit = store[key];
    return hit ? { translation: hit.t, detected: hit.d || "", engine: hit.e } : null;
  } catch (e) {
    return null;
  }
}

async function setCachedTranslation(key, value) {
  try {
    const store = (await chrome.storage.session.get(TRANSLATION_CACHE_KEY))[TRANSLATION_CACHE_KEY] || {};
    store[key] = { t: value.translation, d: value.detected || "", e: value.engine, ts: Date.now() };

    const keys = Object.keys(store);
    const max = AR.CACHE.SESSION_TRANSLATION_MAX;
    if (keys.length > max) {
      keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
      for (let i = 0; i < keys.length - max; i++) delete store[keys[i]];
    }

    await chrome.storage.session.set({ [TRANSLATION_CACHE_KEY]: store });
  } catch (e) {
    /* session storage unavailable; caching is best-effort */
  }
}

async function handleTranslate(msg) {
  const settings = await AR.getSettings();
  const text = String(msg.text || "").trim();
  if (!text) return { ok: false, error: "Nothing was selected." };

  const target = msg.baseLang || settings.baseLang;
  const source = msg.sourceLang || "auto";
  const engine = msg.engine || settings.translationEngine;
  // Include the active LLM backend so switching Gemini <-> custom never reuses
  // a translation produced by the other one.
  const cacheEngine = engine === "gemini" ? "gemini:" + settings.llmProvider : engine;

  const cacheKey = translationCacheKey(text, target, cacheEngine);
  const cached = await getCachedTranslation(cacheKey);
  if (cached) return { ok: true, cached: true, ...cached };

  try {
    const result =
      engine === "gemini"
        ? { translation: await llmTranslate(text, target, settings), detected: "", engine: "gemini" }
        : { engine: "google", ...(await googleTranslate(text, source, target)) };
    await setCachedTranslation(cacheKey, result);
    return { ok: true, ...result };
  } catch (primaryError) {
    // Graceful fallback to the other engine. Cache it under its own engine key
    // so a one-off failure never makes the primary engine return the fallback
    // translation from cache on later requests.
    try {
      const fallbackEngine = engine === "gemini" ? "google" : "gemini:" + settings.llmProvider;
      const fallbackKey = translationCacheKey(text, target, fallbackEngine);
      const result =
        engine !== "gemini"
          ? { translation: await llmTranslate(text, target, settings), detected: "", engine: "gemini" }
          : { engine: "google", ...(await googleTranslate(text, source, target)) };
      await setCachedTranslation(fallbackKey, result);
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: primaryError.message || "Translation failed." };
    }
  }
}

async function googleTranslate(text, source, target) {
  const body = new URLSearchParams({
    client: "gtx",
    sl: source,
    tl: target,
    dt: "t",
    q: text
  });

  const res = await fetch("https://translate.googleapis.com/translate_a/single", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString()
  });

  if (!res.ok) throw new Error("Google Translate request failed (" + res.status + ").");

  const data = await res.json();
  const translation = Array.isArray(data && data[0])
    ? data[0].map((part) => (part && part[0]) || "").join("")
    : "";
  const detected = (data && data[2]) || "";

  if (!translation.trim()) throw new Error("Google Translate returned an empty result.");
  return { translation: translation.trim(), detected };
}

async function llmTranslate(text, target, settings) {
  const langName = AR.langName(target);
  const prompt = [
    `Translate the text below into ${langName}.`,
    `Preserve meaning, tone, punctuation and line breaks. If the text is already in ${langName}, return it unchanged.`,
    `Reply with the translation only — no quotes, labels or commentary.`,
    ``,
    `Text:`,
    text
  ].join("\n");
  const out = await callLLM(prompt, settings, null, 0.2, 4096);
  return out.trim();
}

/* ----------------------------------------------------------- AI provider */

/* Route every LLM call through whichever backend is selected in settings. The
 * Gemini path keeps its native schema support; the custom path speaks the
 * OpenAI Chat Completions dialect used by Command Code and most gateways. */
async function callLLM(prompt, settings, schema, temperature, maxOutputTokens, opts) {
  if (settings.llmProvider === "custom") {
    return callCustomModel(prompt, settings, schema, temperature, maxOutputTokens, opts);
  }
  return callGemini(prompt, settings, schema, temperature, maxOutputTokens, opts);
}

async function callCustomModel(prompt, settings, schema, temperature, maxOutputTokens, opts) {
  const key = String(settings.customApiKey || "").trim();
  if (!key) {
    throw new Error("No API key set for the custom provider. Open ActiveReader settings to add one.");
  }

  const model = String(settings.customApiModel || "").trim();
  if (!model) {
    throw new Error(
      "No custom model set. Open ActiveReader settings and click “Fetch models” to pick one."
    );
  }

  const url = AR.customChatCompletionsUrl(settings.customApiBaseUrl);
  if (!url) {
    throw new Error("No custom API base URL set. Open ActiveReader settings to add one.");
  }

  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: temperature == null ? 0.7 : temperature,
    max_tokens: maxOutputTokens || 4096,
    stream: false
  };

  // DeepSeek and OpenAI-style reasoning models accept this on Chat
  // Completions. When the field is omitted the provider uses its own default,
  // which is exactly what the "model default" entry in the UI means. Quiz
  // writing asks for the cheapest level because reasoning tokens are billed as
  // output and add nothing to a simple reading-comprehension quiz.
  const effort =
    opts && opts.cheap
      ? AR.resolveQuizThinkingLevel(model, settings.customThinkingLevel)
      : AR.resolveThinkingLevel(model, settings.customThinkingLevel);
  if (effort) body.reasoning_effort = effort;

  // JSON mode improves quiz/grading reliability on supported gateways. Retry
  // once without it if a provider rejects the field.
  if (schema) body.response_format = { type: "json_object" };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Could not reach the custom API. Check the base URL and your network connection.");
  }

  let data = await res.json().catch(() => ({}));

  if (!res.ok && body.response_format && res.status === 400) {
    // Some OpenAI-compatible servers do not implement response_format. Only
    // retry when the error points at that field, so a genuinely bad request
    // is not sent twice.
    const probe = JSON.stringify(data || {});
    if (/response_format|json[_ ]?object|json mode/i.test(probe)) {
      delete body.response_format;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key
          },
          body: JSON.stringify(body)
        });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        throw new Error("Could not reach the custom API. Check the base URL and your network connection.");
      }
    }
  }

  if (!res.ok) {
    const detail =
      (data && data.error && (data.error.message || data.error.type)) ||
      (data && data.message) ||
      "";
    throw new Error(customApiErrorMessage(res.status, detail));
  }

  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message;
  let text = "";

  if (message) {
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (typeof part === "string" ? part : (part && (part.text || part.content)) || ""))
        .join("");
    }
  }

  // Anthropic-shaped or non-standard gateways occasionally answer with a
  // top-level content array instead of choices.
  if (!text.trim() && Array.isArray(data && data.content)) {
    text = data.content.map((part) => (part && part.text) || "").join("");
  }

  if (!text.trim()) {
    const reason = (choice && choice.finish_reason) || (data && data.stop_reason) || "";
    // "length" is the OpenAI-style cutoff reason; Anthropic-shaped gateways use
    // "max_tokens". Both mean the output budget was exhausted before any text
    // was written, which is the classic reasoning-model failure mode.
    const cutoff = /^(length|max_tokens)$/i.test(String(reason));
    const hint = cutoff
      ? " — the output token limit was reached before any content was written, likely because the model spent it all on hidden reasoning."
      : "";
    throw new Error(
      reason
        ? "The AI model returned no text (" + reason + ")" + hint + "."
        : "The AI model returned an empty response."
    );
  }

  return text;
}

function customApiErrorMessage(status, detail) {
  const suffix = detail ? " — " + detail : "";
  if (status === 400) return "The custom API rejected the request (400). Check the model ID and that it supports this prompt." + suffix;
  if (status === 401 || status === 403) return "The custom API refused the API key (" + status + "). Check the key and your plan." + suffix;
  if (status === 404) return "The custom API endpoint or model was not found (404). Check the base URL and model ID." + suffix;
  if (status === 429) return "The custom API rate limit or quota was reached (429). Wait a moment or check your plan." + suffix;
  if (status >= 500) return "The custom API had a server error (" + status + "). Try again shortly." + suffix;
  return "The custom API request failed (" + status + ")." + suffix;
}

/* -------------------------------------------------------------- gemini */

async function callGemini(prompt, settings, schema, temperature, maxOutputTokens, opts) {
  const key = String(settings.geminiApiKey || "").trim();
  if (!key) {
    throw new Error("No Gemini API key set. Open ActiveReader settings to add one.");
  }

  const model = String(settings.geminiModel || "").trim();
  if (!model) {
    throw new Error(
      "No Gemini model set. Open ActiveReader settings and click “Fetch models” to pick one."
    );
  }
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent?key=" +
    encodeURIComponent(key);

  const generationConfig = { temperature: temperature == null ? 0.7 : temperature };
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
  if (opts && opts.noThinking) {
    const thinking = AR.geminiQuizThinkingConfig(model);
    if (thinking) generationConfig.thinkingConfig = thinking;
  }

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new Error("Could not reach Gemini. Check your network connection.");
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || "";
    throw new Error(geminiErrorMessage(res.status, detail));
  }

  const candidate = data && data.candidates && data.candidates[0];
  const text =
    candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts.map((p) => p.text || "").join("")
      : "";

  if (!text.trim()) {
    const reason =
      (candidate && candidate.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason);
    throw new Error(reason ? "Gemini returned no text (" + reason + ")." : "Gemini returned an empty response.");
  }

  return text;
}

function geminiErrorMessage(status, detail) {
  const suffix = detail ? " — " + detail : "";
  if (status === 400) return "Gemini rejected the request (400). Check the model ID supports this prompt." + suffix;
  if (status === 401 || status === 403) return "Gemini refused the API key (" + status + "). Check that the key is valid and the API is enabled." + suffix;
  if (status === 404) return "Gemini model not found (404). Open settings and pick a model with “Fetch models”." + suffix;
  if (status === 429) return "Gemini rate limit or quota reached (429). Wait a moment or check your plan." + suffix;
  if (status >= 500) return "Gemini had a server error (" + status + "). Try again shortly." + suffix;
  return "Gemini request failed (" + status + ")." + suffix;
}

async function testAI() {
  const settings = await AR.getSettings();
  try {
    const out = await callLLM("Reply with exactly: OK", settings, null, 0, 16);
    return { ok: true, reply: out.trim().slice(0, 60), provider: settings.llmProvider };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* Ask the API which models this key can use, so the UI never needs a hardcoded
 * list. Only models that support generateContent are returned. Results are
 * cached for a while to avoid repeating the call on every options visit. */
const MODEL_CACHE_KEY = "modelCache";

async function getCachedModels(keyTag) {
  try {
    const store = await chrome.storage.local.get(MODEL_CACHE_KEY);
    const entry = store[MODEL_CACHE_KEY];
    if (!entry || entry.h !== keyTag) return null;
    if (Date.now() - (entry.ts || 0) > AR.CACHE.MODEL_TTL_MS) return null;
    return Array.isArray(entry.models) && entry.models.length ? entry.models : null;
  } catch (e) {
    return null;
  }
}

async function setCachedModels(keyTag, models) {
  try {
    await chrome.storage.local.set({ [MODEL_CACHE_KEY]: { h: keyTag, ts: Date.now(), models } });
  } catch (e) {
    /* caching is best-effort */
  }
}

async function listModels(force) {
  const settings = await AR.getSettings();
  if (settings.llmProvider === "custom") return listCustomModels(settings, force);
  return listGeminiModels(settings, force);
}

async function listGeminiModels(settings, force) {
  const key = String(settings.geminiApiKey || "").trim();
  if (!key) return { ok: false, error: "Add a Gemini API key first." };

  const keyTag = "gemini|" + hashString(key).toString(36);

  if (!force) {
    const cached = await getCachedModels(keyTag);
    if (cached) return { ok: true, models: cached, cached: true };
  }

  try {
    const collected = [];
    let pageToken = "";
    // The API paginates; walk every page so no model is silently missed.
    for (let page = 0; page < 10; page++) {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200" +
        (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "") +
        "&key=" +
        encodeURIComponent(key);
      const res = await fetch(url, { method: "GET" });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const message = (data && data.error && data.error.message) || "Could not list models (" + res.status + ").";
        return { ok: false, error: message };
      }

      if (Array.isArray(data.models)) collected.push(...data.models);
      pageToken = data.nextPageToken || "";
      if (!pageToken) break;
    }

    const models = collected
      .filter(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.indexOf("generateContent") !== -1
      )
      .map((m) => ({
        id: String(m.name || "").replace(/^models\//, ""),
        displayName: String(m.displayName || "")
      }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));

    await setCachedModels(keyTag, models);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: "Could not reach Gemini. Check your network connection." };
  }
}

/* OpenAI-compatible discovery: GET {base}/models. Thinking levels come from
 * the row's own metadata when the provider exposes it, otherwise from the
 * built-in Command Code/DeepSeek ladder table. */
async function listCustomModels(settings, force) {
  const base = AR.normalizeCustomBaseUrl(settings.customApiBaseUrl) || AR.DEFAULTS.customApiBaseUrl;
  const url = AR.customModelsUrl(base);
  if (!url) return { ok: false, error: "Add a custom API base URL first." };

  const key = String(settings.customApiKey || "").trim();
  const keyTag = "custom|" + hashString(base + "|" + key).toString(36);

  if (!force) {
    const cached = await getCachedModels(keyTag);
    if (cached) return { ok: true, models: cached, cached: true };
  }

  const headers = { Accept: "application/json" };
  if (key) headers.Authorization = "Bearer " + key;

  try {
    const res = await fetch(url, { method: "GET", headers });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message =
        (data && data.error && data.error.message) || "Could not list models (" + res.status + ").";
      return { ok: false, error: message };
    }

    const rows = Array.isArray(data && data.data)
      ? data.data
      : Array.isArray(data && data.models)
        ? data.models
        : [];

    const models = rows
      .filter((m) => {
        if (!m) return false;
        // Skip models that cannot answer on Chat Completions (for example
        // Command Code's Claude rows, which only serve /messages).
        const endpoints = Array.isArray(m.supported_endpoints) ? m.supported_endpoints : null;
        return !endpoints || endpoints.some((endpoint) => /chat\/completions/i.test(String(endpoint)));
      })
      .map((m) => {
        const id = String(m.id || m.name || "").replace(/^models\//, "");
        const thinking = AR.getThinkingLevelsFromModel(m, id);
        return {
          id,
          displayName: String(m.name || m.displayName || ""),
          thinkingLevels: thinking.levels,
          defaultThinkingLevel: thinking.default
        };
      })
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));

    await setCachedModels(keyTag, models);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: "Could not reach the custom API. Check the base URL and your network connection." };
  }
}

/* ----------------------------------------------------------------- quiz */

const QUIZ_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["mcq", "short", "blank"] },
          question: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          answerIndex: { type: "INTEGER" },
          answer: { type: "STRING" },
          explanation: { type: "STRING" }
        },
        // MCQ answers are derived from options[answerIndex], so the model does
        // not have to repeat the correct option in a separate "answer" field.
        required: ["type", "question"]
      }
    }
  },
  required: ["questions"]
};

const QUIZ_CACHE_KEY = "quizCache";
const QUIZ_CACHE_VERSION = 2;
const quizInFlight = new Map();

/* A stable key for (passage + quiz options + backend). Length + a 32-bit hash
 * keeps the stored key small even for long selections. */
function quizCacheKey(text, cfg, settings) {
  const custom = settings.llmProvider === "custom";
  return [
    "v" + QUIZ_CACHE_VERSION,
    settings.llmProvider,
    custom ? settings.customApiBaseUrl : "",
    custom ? settings.customApiModel : settings.geminiModel,
    custom ? settings.customThinkingLevel : "",
    settings.targetLang,
    settings.baseLang,
    cfg.difficulty,
    cfg.count,
    (cfg.types || []).slice().sort().join(","),
    cfg.quizLanguage,
    cfg.explain ? "1" : "0",
    text.length,
    hashString(text).toString(36)
  ].join("|");
}

async function getCachedQuiz(key) {
  try {
    const store = (await chrome.storage.session.get(QUIZ_CACHE_KEY))[QUIZ_CACHE_KEY] || {};
    const hit = store[key];
    return hit && Array.isArray(hit.q) && hit.q.length ? hit.q : null;
  } catch (e) {
    return null;
  }
}

async function setCachedQuiz(key, questions) {
  try {
    const store = (await chrome.storage.session.get(QUIZ_CACHE_KEY))[QUIZ_CACHE_KEY] || {};
    store[key] = { q: questions, ts: Date.now() };

    const keys = Object.keys(store);
    const max = AR.CACHE.SESSION_QUIZ_MAX;
    if (keys.length > max) {
      keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
      for (let i = 0; i < keys.length - max; i++) delete store[keys[i]];
    }

    await chrome.storage.session.set({ [QUIZ_CACHE_KEY]: store });
  } catch (e) {
    /* session storage unavailable; caching is best-effort */
  }
}

async function handleQuiz(msg) {
  const settings = await AR.getSettings();
  // Respect the reader's "Maximum characters to send" setting up to the quiz
  // hard cap, and collapse whitespace before slicing so a poorly formatted
  // selection costs fewer input tokens without losing any words.
  const maxChars = Math.min(
    AR.QUIZ_MAX_INPUT_CHARS,
    Math.max(200, Number(settings.maxSelectionLength) || 2000)
  );
  const text = AR.compactQuizText(msg.text, maxChars);
  if (!text) return { ok: false, error: "Select some text first." };

  const cfg = Object.assign(
    {
      types: settings.quizTypes,
      difficulty: settings.quizDifficulty,
      count: settings.quizCount,
      quizLanguage: settings.quizLanguage,
      explain: settings.quizExplain
    },
    msg.config || {}
  );

  const wantCount = Math.max(1, Math.min(20, Number(cfg.count) || 5));
  cfg.count = wantCount;
  cfg.explain = !!cfg.explain;
  cfg.types = (Array.isArray(cfg.types) ? cfg.types : []).filter(
    (t) => AR.QUIZ_TYPES.indexOf(t) !== -1
  );
  if (!cfg.types.length) cfg.types = AR.QUIZ_TYPES.slice();

  const key = quizCacheKey(text, cfg, settings);

  try {
    // "New quiz" deliberately bypasses the cache; every other request reuses a
    // quiz generated earlier in this browser session for the same passage and
    // options, so no API call is made.
    if (!msg.force) {
      const cached = await getCachedQuiz(key);
      if (cached) {
        return { ok: true, questions: cached, requested: wantCount, cached: true };
      }
    }

    // Two tabs (or a double click) asking for the same quiz share one request.
    const existing = quizInFlight.get(key);
    if (existing) return await existing;

    const job = (async () => {
      const questions = await generateQuestions(text, cfg, settings, wantCount);
      if (!questions.length) {
        throw new Error("The model did not return usable questions. Try again.");
      }
      await setCachedQuiz(key, questions);
      return { ok: true, questions, requested: wantCount };
    })();

    quizInFlight.set(key, job);
    const clear = () => {
      if (quizInFlight.get(key) === job) quizInFlight.delete(key);
    };
    job.then(clear, clear);
    return await job;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* Generate the whole quiz with a single API request, asking for exactly the
 * number of questions needed. Extra "spare" questions would be discarded and
 * still billed as output tokens, so they are intentionally not requested.
 *
 * If the response is empty, truncated or not valid JSON, the request is
 * repeated once at a lower temperature. This only costs anything on a failure,
 * and it turns the common one-off "model returned no text / bad JSON" error
 * into a successful quiz instead of showing an error to the reader. */
async function generateQuestions(text, cfg, settings, wantCount) {
  const prompt = AR.buildQuizPrompt(text, cfg, settings, wantCount);
  const budget = AR.quizOutputTokenLimit(wantCount, cfg.explain);
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callLLM(
        prompt,
        settings,
        QUIZ_SCHEMA,
        attempt === 0 ? 0.6 : 0.3,
        // The retry gets the full output budget: a "no text" failure usually
        // means reasoning tokens consumed the limit before any JSON was
        // written, so repeating with the same cap tends to fail again.
        attempt === 0 ? budget : 4096,
        { cheap: true, noThinking: true }
      );
      const collected = collectQuestions(parseJsonLoose(raw), wantCount);
      if (collected.length) return collected;
      lastError = new Error("The model did not return usable questions. Try again.");
    } catch (e) {
      lastError = e;
      if (!isRetryableQuizError(e)) break;
    }
  }

  throw lastError || new Error("The model did not return usable questions. Try again.");
}

/* Configuration, auth, quota and network errors will not improve by sending
 * the same prompt again. Empty/truncated/unparseable output might. */
function isRetryableQuizError(err) {
  const msg = String((err && err.message) || "");
  /* "No ..." anchors to the "No API key / No custom model set" style config
   * errors; without the anchor a message like "returned no text ... the model
   * spent it all" would falsely match and skip the retry. */
  if (
    /^No .*model|API key|base URL|refused|not found|\(401\)|\(403\)|\(404\)|\(429\)|rate limit|quota|Could not reach/i.test(
      msg
    )
  ) {
    return false;
  }
  return /no text|empty response|Could not parse|usable questions/i.test(msg);
}

function collectQuestions(parsed, wantCount) {
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.questions)
      ? parsed.questions
      : Array.isArray(parsed && parsed.data && parsed.data.questions)
        ? parsed.data.questions
        : [];

  const seen = new Set();
  const collected = [];
  for (const item of list) {
    const q = normalizeQuestion(item);
    if (!q) continue;
    const key = questionKey(q);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    collected.push(q);
    if (collected.length >= wantCount) break;
  }
  spreadMcqAnswers(collected);
  return collected;
}

function questionKey(q) {
  return String(q.question || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/* Spread the correct-answer positions of every mcq in one quiz, and shuffle
 * the wrong options around each assigned position. Models are heavily
 * biased toward placing the correct option first, which would make "A" the
 * right answer almost every time if options were shown as generated.
 * Within a single quiz the positions are also kept distinct as long as
 * there are enough option slots, so consecutive mcq questions get different
 * answer letters. When there are more mcq questions than slots, the
 * least-used position wins so repeats spread out instead of piling up. */
function spreadMcqAnswers(questions) {
  const mcqs = questions.filter(
    (q) => q && q.type === "mcq" && Array.isArray(q.options) && q.options.length >= 2
  );
  const used = new Map();
  for (const q of mcqs) {
    const n = q.options.length;
    const free = [];
    for (let i = 0; i < n; i++) {
      if (!used.get(i)) free.push(i);
    }
    let pos;
    if (free.length) {
      pos = free[Math.floor(Math.random() * free.length)];
    } else {
      /* Every position is taken: reuse the least-used one. */
      const least = [];
      let minCount = Infinity;
      for (let i = 0; i < n; i++) {
        const count = used.get(i) || 0;
        if (count < minCount) {
          minCount = count;
          least.length = 0;
          least.push(i);
        } else if (count === minCount) {
          least.push(i);
        }
      }
      pos = least[Math.floor(Math.random() * least.length)];
    }
    used.set(pos, (used.get(pos) || 0) + 1);

    /* Move the correct option to the chosen slot and shuffle the wrong
     * options into the remaining slots. Grading compares answer text, so
     * only the index needs remapping. */
    const correct = q.options[q.answerIndex];
    const wrong = q.options.filter((_, i) => i !== q.answerIndex);
    for (let i = wrong.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = wrong[i];
      wrong[i] = wrong[j];
      wrong[j] = tmp;
    }
    wrong.splice(pos, 0, correct);
    q.options = wrong;
    q.answerIndex = pos;
    q.answer = correct;
  }
}

function normalizeQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const rawQuestion = q.question != null ? q.question : q.text;
  if (!rawQuestion) return null;

  const options = Array.isArray(q.options)
    ? q.options
    : Array.isArray(q.choices)
      ? q.choices
      : [];

  // Models occasionally omit "type". Infer it instead of discarding a
  // perfectly usable question (which would leave the quiz short).
  let type = AR.QUIZ_TYPES.indexOf(q.type) !== -1 ? q.type : "";
  if (!type) {
    if (options.length >= 2) type = "mcq";
    else if (/_{3,}/.test(String(rawQuestion))) type = "blank";
    else type = "short";
  }

  let answer = q.answer;
  if (answer == null) answer = q.correctAnswer;
  if (answer == null) answer = q.correct_answer;
  if (Array.isArray(answer)) answer = answer.join(", ");

  const out = {
    type,
    question: String(rawQuestion).trim(),
    answer: String(answer == null ? "" : answer).trim(),
    explanation: q.explanation ? String(q.explanation).trim() : ""
  };
  if (type === "mcq") {
    out.options = options.map((o) => String(o).trim()).filter(Boolean);
    if (out.options.length < 2) return normalizeQuestion(Object.assign({}, q, { type: "short" }));
    let idx = q.answerIndex;
    if (idx == null) idx = q.answer_index;
    if (typeof idx === "string" && /^[A-Za-z]$/.test(idx.trim())) {
      // Some models answer "B" instead of 1.
      idx = idx.trim().toUpperCase().charCodeAt(0) - 65;
    } else {
      idx = Number(idx);
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= out.options.length) {
      const byText = out.options.findIndex((o) => o.toLowerCase() === out.answer.toLowerCase());
      idx = byText >= 0 ? byText : 0;
    }
    /* Per-question shuffling is skipped here: spreadMcqAnswers() assigns the
     * correct-answer position for the whole quiz at once, so that multiple
     * mcq questions in one quiz get distinct, random answer letters. */
    out.answerIndex = idx;
    out.answer = out.options[idx];
  }
  if (!out.answer) return null;
  return out;
}

function parseJsonLoose(raw) {
  const source = String(raw == null ? "" : raw)
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();

  if (!source) {
    throw new Error("Could not parse the quiz JSON returned by the AI model.");
  }

  const candidates = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text && candidates.indexOf(text) === -1) candidates.push(text);
  };

  add(source);
  // Strip markdown fences and any prose around them.
  add(source.replace(/```[\w-]*\s*/g, "").replace(/```/g, ""));
  // Extract complete objects/arrays. A string-aware scan is used so braces or
  // brackets inside question or answer text cannot end a candidate early.
  for (const value of extractJsonValues(source, "{", "}")) add(value);
  for (const value of extractJsonValues(source, "[", "]")) add(value);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed.ok) return shapeParsedJson(parsed.value);

    // Repair the two most common small syntax errors: raw newlines/tabs inside
    // strings, and a trailing comma before a closing brace/bracket.
    const escaped = escapeControlCharsInStrings(candidate);
    const repaired = stripTrailingCommas(escaped.text);
    if (repaired !== candidate) {
      const retried = tryParseJson(repaired);
      if (retried.ok) return shapeParsedJson(retried.value);
    }
  }

  throw new Error("Could not parse the quiz JSON returned by the AI model.");
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, value: null };
  }
}

function extractJsonValues(text, open, close) {
  const values = [];
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          const value = text.slice(start, i + 1);
          if (values.indexOf(value) === -1) values.push(value);
          break;
        }
      }
    }
  }
  return values;
}

function escapeControlCharsInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return { text: out };
}

function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/* Some gateways double-encode the JSON or wrap the array in an envelope. */
function shapeParsedJson(value) {
  if (typeof value === "string") {
    const inner = tryParseJson(value);
    if (inner.ok) return shapeParsedJson(inner.value);
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.questions === "string") {
      const inner = tryParseJson(value.questions);
      if (inner.ok) value.questions = inner.value;
    }
    if (
      !Array.isArray(value.questions) &&
      value.questions &&
      typeof value.questions === "object" &&
      value.questions.question
    ) {
      value.questions = [value.questions];
    }
    if (!Array.isArray(value.questions) && Array.isArray(value.items)) {
      value.questions = value.items;
    }
    if (
      !Array.isArray(value.questions) &&
      value.data &&
      Array.isArray(value.data.questions)
    ) {
      value.questions = value.data.questions;
    }
  }
  return value;
}

/* --------------------------------------------------------------- grading */

const GRADE_SCHEMA = {
  type: "OBJECT",
  properties: {
    correct: { type: "BOOLEAN" },
    feedback: { type: "STRING" }
  },
  required: ["correct", "feedback"]
};

/* Grade a free-response answer with the configured AI model. The model is asked to accept
 * semantically equivalent answers and to write its feedback in the learner's
 * own language (baseLang). */
async function handleGrade(msg) {
  const settings = await AR.getSettings();
  const question = String(msg.question || "").trim();
  const answer = String(msg.answer || "").trim();
  const userAnswer = String(msg.userAnswer || "").trim();

  if (!question || !answer) return { ok: false, error: "Nothing to grade." };
  if (!userAnswer) return { ok: false, error: "Type an answer first." };

  const base = AR.langName(settings.baseLang);
  const target = AR.langName(settings.targetLang);
  const typeLabel = msg.qType === "blank" ? "fill-in-the-blank" : "short-answer";
  const passage = String(msg.text || "").trim().slice(0, 4000);

  const lines = [
    `You are a patient ${target} language tutor grading a learner's ${typeLabel} answer.`,
    `The learner's native language is ${base} and their level is ${settings.quizDifficulty}.`,
    ``,
    `Question: ${question}`,
    `Expected answer: ${answer}`,
    passage ? `Passage the question comes from:\n${passage}` : "",
    `Learner's answer: ${userAnswer}`,
    ``,
    `Rules:`,
    `- Set "correct" to true when the learner's answer shows the right meaning. Accept answers that are semantically equivalent to the expected answer and ignore case, punctuation and small typos.`,
    `- Be honest but encouraging: a partly correct answer is not correct, but point out what they got right.`,
    `- Write "feedback" in ${base} using 1-3 short sentences. Explain why the answer is right or wrong, gently correct mistakes and, when helpful, show the correct or a more natural phrasing.`,
    `- Return JSON only, in the shape {"correct": true or false, "feedback": "..."}.`
  ].filter(Boolean);

  try {
    const raw = await callLLM(lines.join("\n"), settings, GRADE_SCHEMA, 0.2, 512);
    const parsed = parseJsonLoose(raw);
    return {
      ok: true,
      correct: !!parsed.correct,
      feedback: String(parsed.feedback || "").trim()
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------- definitions */

const DEFINE_SCHEMA = {
  type: "OBJECT",
  properties: {
    meaning: { type: "STRING" },
    partOfSpeech: { type: "STRING" },
    example: { type: "STRING" }
  },
  required: ["meaning"]
};

/* One-word lookup. Google Translate is the default path (no key, no API
 * cost): the word is translated in isolation and the detected source
 * language is shown when it is not the target language. When the
 * translation engine is set to AI, the model instead writes a short
 * dictionary-style note in the learner's own language, using the sentence
 * the word appeared in to pick the right sense (a "bank" by a river is not
 * a "bank" with tellers). Either route falls back to the other on failure,
 * so the popup always shows something. */
async function handleDefine(msg) {
  const settings = await AR.getSettings();
  const word = String(msg.word || "").trim();
  if (!word) return { ok: false, error: "No word to look up." };
  if (word.length > 64) return { ok: false, error: "That selection is too long for a word lookup." };

  const engine = msg.engine || settings.translationEngine;
  const context = String(msg.context || "").trim().slice(0, 300);

  if (engine === "gemini") {
    // AI rule: rich, context-aware definition, if the model is reachable.
    try {
      return { ok: true, engine: "gemini", ...(await aiDefine(word, context, settings)) };
    } catch (e) {
      try {
        const res = await googleTranslate(word, "auto", settings.baseLang);
        return {
          ok: true,
          engine: "google",
          fallback: true,
          meaning: res.translation,
          partOfSpeech: "",
          example: "",
          detected: res.detected
        };
      } catch (e2) {
        return { ok: false, error: e.message };
      }
    }
  }

  // Default: Google Translate (free, no key). Words are translated in
  // isolation — googleTranslate() has no notion of sentence context, which is
  // exactly what keeps these tiny calls cheap.
  try {
    const res = await googleTranslate(word, "auto", settings.baseLang);
    return {
      ok: true,
      engine: "google",
      meaning: res.translation,
      partOfSpeech: "",
      example: "",
      detected: res.detected
    };
  } catch (e) {
    try {
      return { ok: true, engine: "gemini", fallback: true, ...(await aiDefine(word, context, settings)) };
    } catch (e2) {
      return { ok: false, error: e.message };
    }
  }
}

/* The AI route of a word lookup: a compact dictionary-style note written
 * from the sentence context. Throws on failure so the Google fallback in
 * handleDefine can run. */
async function aiDefine(word, context, settings) {
  const base = AR.langName(settings.baseLang);
  const target = AR.langName(settings.targetLang);

  const prompt = [
    `You are a concise ${target} dictionary for someone whose own language is ${base}.`,
    `The reader clicked the word below while reading.`,
    context ? `It appeared in this text: «${context}»` : "",
    ``,
    `WORD: ${word}`,
    ``,
    `Rules:`,
    `- "meaning": one short definition of THIS occurrence in ${base} (1 sentence, no quotes).`,
    `- If the word is not ${target} or is a proper noun, a number, or otherwise not worth defining, use "meaning" to give the most useful short gloss anyway (e.g. a translation) rather than a definition.`,
    `- "partOfSpeech": the part of speech in ${base}, one or two words ("noun", "verb", …). Optional.`,
    `- "example": skip it unless a tiny example (max 8 words) genuinely helps; otherwise return an empty string.`,
    `- Reply in JSON only.`
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await callLLM(prompt, settings, DEFINE_SCHEMA, 0.3, 256);
  const parsed = parseJsonLoose(raw);
  return {
    meaning: String(parsed.meaning || "").trim(),
    partOfSpeech: String(parsed.partOfSpeech || "").trim(),
    example: String(parsed.example || "").trim()
  };
}

/* ------------------------------------------------------------------ tts */

async function handleTts(msg) {
  const settings = await AR.getSettings();
  const text = AR.ttsText(msg.text);
  if (!text) return { ok: false, error: "Nothing to read." };

  clearOffscreenCloseTimer();

  // Only one TTS track may play at a time: silence the current one, whichever
  // provider it uses, before starting the new one.
  await stopAllTts();

  const provider = msg.provider || settings.ttsProvider;
  const lang = msg.lang || settings.targetLang;

  if (provider === "browser") {
    return handleBrowserTts(text, lang, settings);
  }

  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: MSG.TARGET_OFFSCREEN,
      type: "play",
      text,
      lang: AR.ttsCode(lang)
    });
    return { ok: true, provider: "google" };
  } catch (e) {
    // Offscreen unavailable — fall back to the built-in browser voice.
    return handleBrowserTts(text, lang, settings);
  }
}

function handleBrowserTts(text, lang, settingsArg) {
  return (async () => {
    const settings = settingsArg || (await AR.getSettings());
    return new Promise((resolve) => {
      try {
        chrome.tts.stop();
      } catch (e) {
        /* ignore */
      }

      let settled = false;
      chrome.tts.speak(
        text,
        {
          lang: AR.ttsLocale(lang),
          rate: Number(settings.ttsRate) || 1,
          pitch: Number(settings.ttsPitch) || 1
        },
        () => {
          if (settled) return;
          settled = true;
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else {
            resolve({ ok: true, provider: "browser" });
          }
        }
      );
    });
  })();
}

/* Stop every TTS track, regardless of which provider started it. */
async function stopAllTts() {
  try {
    chrome.tts.stop();
  } catch (e) {
    /* ignore */
  }
  try {
    await chrome.runtime.sendMessage({ target: MSG.TARGET_OFFSCREEN, type: "stop" });
  } catch (e) {
    /* offscreen may not exist */
  }
}

/* The offscreen document only exists to play audio. Close it once playback has
 * been idle for a while so it does not sit around consuming memory. */
function scheduleOffscreenClose() {
  clearOffscreenCloseTimer();
  offscreenCloseTimer = setTimeout(() => {
    offscreenCloseTimer = null;
    if (typeof chrome.offscreen !== "undefined") {
      chrome.offscreen.closeDocument().catch(() => {});
    }
  }, 30000);
}

function clearOffscreenCloseTimer() {
  if (offscreenCloseTimer) {
    clearTimeout(offscreenCloseTimer);
    offscreenCloseTimer = null;
  }
}

async function ensureOffscreen() {
  if (typeof chrome.offscreen === "undefined") throw new Error("Offscreen API unavailable.");
  clearOffscreenCloseTimer();

  try {
    if (typeof chrome.offscreen.hasDocument === "function" && (await chrome.offscreen.hasDocument())) {
      return;
    }
  } catch (e) {
    /* fall through to creation attempt */
  }

  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: "src/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play text-to-speech audio for the text the user selected."
    })
    .catch(() => {
      /* document probably already exists */
    })
    .finally(() => {
      creatingOffscreen = null;
    });

  return creatingOffscreen;
}

/* ---------------------------------------------------------- vocabulary */

async function handleSave(msg) {
  const entry = msg.entry || {};
  const text = String(entry.text || "").trim();
  if (!text) return { ok: false, error: "Nothing to save." };

  const savedWords = await AR.getSavedWords();
  const key = (text + "\u0000" + (entry.lang || "")).toLowerCase();

  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text,
    translation: String(entry.translation || "").trim(),
    lang: entry.lang || "",
    baseLang: entry.baseLang || "",
    sourceTitle: entry.sourceTitle || "",
    url: entry.url || "",
    createdAt: Date.now()
  };

  const filtered = savedWords.filter(
    (w) => (String(w.text) + "\u0000" + (w.lang || "")).toLowerCase() !== key
  );
  filtered.unshift(record);
  await AR.saveSavedWords(filtered);

  return { ok: true, entry: record };
}
