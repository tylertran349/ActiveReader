/*
 * ActiveReader service worker.
 * Owns every network call (Gemini + Google Translate), TTS orchestration and
 * the context menu. Keeps API keys out of web pages.
 */
importScripts("lib/config.js");

const AR = globalThis.AR;
const MSG = AR.MSG;

let lastTtsTabId = null;
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  // Messages addressed to the offscreen document are ignored here.
  if (msg.target === MSG.TARGET_OFFSCREEN) return undefined;

  // Internal messages coming back from the offscreen document.
  if (msg.target === MSG.TARGET_BG) {
    if (msg.type === MSG.TTS_FALLBACK) {
      handleBrowserTts(msg.text, msg.lang).catch(() => {});
    } else if (msg.type === MSG.TTS_STATE) {
      if (msg.state === "ended" || msg.state === "failed") scheduleOffscreenClose();
      forwardTtsState(msg.state);
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
    case MSG.QUIZ:
      handleQuiz(msg).then(sendResponse);
      return true;
    case MSG.GRADE:
      handleGrade(msg).then(sendResponse);
      return true;
    case MSG.TTS:
      handleTts(msg, sender).then(sendResponse);
      return true;
    case MSG.TTS_STOP:
      stopTts().then(() => sendResponse({ ok: true }));
      return true;
    case MSG.SAVE:
      handleSave(msg).then(sendResponse);
      return true;
    case MSG.TEST_GEMINI:
      testGemini().then(sendResponse);
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

function forwardTtsState(state) {
  if (lastTtsTabId == null) return;
  chrome.tabs.sendMessage(lastTtsTabId, { type: MSG.TTS_STATE, state }).catch(() => {});
}

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

  const cacheKey = translationCacheKey(text, target, engine);
  const cached = await getCachedTranslation(cacheKey);
  if (cached) return { ok: true, cached: true, ...cached };

  try {
    const result =
      engine === "gemini"
        ? { translation: await geminiTranslate(text, target, settings), detected: "", engine: "gemini" }
        : { engine: "google", ...(await googleTranslate(text, source, target)) };
    await setCachedTranslation(cacheKey, result);
    return { ok: true, ...result };
  } catch (primaryError) {
    // Graceful fallback to the other engine.
    try {
      const result =
        engine !== "gemini"
          ? { translation: await geminiTranslate(text, target, settings), detected: "", engine: "gemini" }
          : { engine: "google", ...(await googleTranslate(text, source, target)) };
      await setCachedTranslation(cacheKey, result);
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

async function geminiTranslate(text, target, settings) {
  const langName = AR.langName(target);
  const prompt = [
    `Translate the text below into ${langName}.`,
    `Preserve meaning, tone, punctuation and line breaks. If the text is already in ${langName}, return it unchanged.`,
    `Reply with the translation only — no quotes, labels or commentary.`,
    ``,
    `Text:`,
    text
  ].join("\n");
  const out = await callGemini(prompt, settings, null, 0.2, 4096);
  return out.trim();
}

/* -------------------------------------------------------------- gemini */

async function callGemini(prompt, settings, schema, temperature, maxOutputTokens) {
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

async function testGemini() {
  const settings = await AR.getSettings();
  try {
    const out = await callGemini("Reply with exactly: OK", settings, null, 0, 16);
    return { ok: true, reply: out.trim().slice(0, 60) };
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
  const key = String(settings.geminiApiKey || "").trim();
  if (!key) return { ok: false, error: "Add a Gemini API key first." };

  const keyTag = hashString(key).toString(36);

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
        required: ["type", "question", "answer"]
      }
    }
  },
  required: ["questions"]
};

async function handleQuiz(msg) {
  const settings = await AR.getSettings();
  const text = String(msg.text || "").trim();
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

  try {
    const questions = await generateQuestions(text, cfg, settings, wantCount);
    if (!questions.length) {
      throw new Error("The model did not return usable questions. Try again.");
    }
    return { ok: true, questions, requested: wantCount };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* Some fast/lite models return fewer questions than asked for, so ask again for
 * the missing ones and merge the results. Questions are de-duplicated by text
 * across rounds so a top-up never repeats a question the learner already has. */
const QUIZ_MAX_ROUNDS = 3;

async function generateQuestions(text, cfg, settings, wantCount) {
  const collected = [];
  const seen = new Set();

  for (let round = 0; round < QUIZ_MAX_ROUNDS && collected.length < wantCount; round++) {
    const need = wantCount - collected.length;
    const prompt = buildQuizPrompt(text, cfg, settings, need, collected);
    const raw = await callGemini(prompt, settings, QUIZ_SCHEMA, 0.85, 4096);

    let parsed;
    try {
      parsed = parseJsonLoose(raw);
    } catch (e) {
      // Keep any questions already gathered; only fail if we have none.
      if (collected.length) break;
      throw e;
    }

    const fresh = (Array.isArray(parsed && parsed.questions) ? parsed.questions : [])
      .map(normalizeQuestion)
      .filter(Boolean);

    let added = 0;
    for (const q of fresh) {
      const key = questionKey(q);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(q);
      added++;
      if (collected.length >= wantCount) break;
    }

    // Nothing new came back — stop rather than burn more calls.
    if (!added) break;
  }

  return collected.slice(0, wantCount);
}

function questionKey(q) {
  return String(q.question || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuizPrompt(text, cfg, settings, count, existing) {
  const target = AR.langName(settings.targetLang);
  const base = AR.langName(settings.baseLang);
  const typeLabels = AR.QUIZ_TYPE_LABELS;

  const chosen = (Array.isArray(cfg.types) && cfg.types.length ? cfg.types : AR.QUIZ_TYPES)
    .map((t) => typeLabels[t] || t)
    .join(", ");

  const difficulty = cfg.difficulty || "intermediate";

  let languageRule;
  if (cfg.quizLanguage === "base") {
    languageRule = `Write every question, option, answer and explanation in ${base}.`;
  } else if (cfg.quizLanguage === "both") {
    languageRule = `Write each question in ${target} and include a ${base} translation of the question in parentheses.`;
  } else {
    languageRule = `Write every question, option and answer in ${target}.`;
  }

  const lines = [
    `You are a patient ${target} language tutor creating a reading-comprehension quiz.`,
    `The learner's native language is ${base} and they are learning ${target} at a ${difficulty} level.`,
    `Create exactly ${count} questions using only information found in the TEXT below.`,
    `The "questions" array MUST contain exactly ${count} complete items — not fewer.`,
    `Use only these question types: ${chosen}.`,
    languageRule,
    `Rules:`,
    `- Multiple choice: give exactly 4 plausible options and set "answerIndex" to the 0-based index of the correct one.`,
    `- Fill in the blank: a sentence from the text where the tested word/phrase is replaced by "____"; put the missing word(s) in "answer".`,
    `- Short answer: an open comprehension question; put a concise model answer in "answer".`,
    `- Always fill "answer" with the correct answer text.`,
    cfg.explain
      ? `- Always fill "explanation" with one short sentence in ${base} explaining why the answer is correct.`
      : `- You may leave "explanation" empty.`,
    `- Do not repeat the same fact in multiple questions.`
  ];

  if (existing && existing.length) {
    lines.push(
      ``,
      `You have already written these ${existing.length} question(s). Do not repeat or reword them, and do not ask about the same fact again:`
    );
    existing.forEach((q) => lines.push(`- ${q.question}`));
  }

  lines.push(``, `Return JSON only, matching the provided schema.`, ``, `TEXT:`, text);
  return lines.join("\n");
}

function normalizeQuestion(q) {
  if (!q || !q.question) return null;
  const type = AR.QUIZ_TYPES.indexOf(q.type) !== -1 ? q.type : "short";
  const out = {
    type,
    question: String(q.question).trim(),
    answer: String(q.answer == null ? "" : q.answer).trim(),
    explanation: q.explanation ? String(q.explanation).trim() : ""
  };
  if (type === "mcq") {
    out.options = Array.isArray(q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean) : [];
    if (out.options.length < 2) return normalizeQuestion(Object.assign({}, q, { type: "short" }));
    let idx = Number(q.answerIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= out.options.length) {
      const byText = out.options.findIndex((o) => o.toLowerCase() === out.answer.toLowerCase());
      idx = byText >= 0 ? byText : 0;
    }
    out.answerIndex = idx;
    out.answer = out.options[idx];
  }
  if (!out.answer) return null;
  return out;
}

function parseJsonLoose(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        /* fall through */
      }
    }
  }
  throw new Error("Could not parse the quiz JSON returned by Gemini.");
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

/* Grade a free-response answer with Gemini. The model is asked to accept
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
    `- Return JSON only, matching the provided schema.`
  ].filter(Boolean);

  try {
    const raw = await callGemini(lines.join("\n"), settings, GRADE_SCHEMA, 0.2, 512);
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

/* ------------------------------------------------------------------ tts */

async function handleTts(msg, sender) {
  const settings = await AR.getSettings();
  const text = String(msg.text || "").trim();
  if (!text) return { ok: false, error: "Nothing to read." };

  if (sender && sender.tab && sender.tab.id != null) lastTtsTabId = sender.tab.id;

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
          pitch: Number(settings.ttsPitch) || 1,
          onEvent(event) {
            if (event.type === "end" || event.type === "interrupted" || event.type === "cancelled") {
              forwardTtsState("ended");
            } else if (event.type === "error") {
              forwardTtsState("error");
            }
          }
        },
        () => {
          if (settled) return;
          settled = true;
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else {
            forwardTtsState("playing");
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

async function stopTts() {
  await stopAllTts();
  scheduleOffscreenClose();
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
