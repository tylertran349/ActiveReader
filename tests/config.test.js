/*
 * Unit tests for the shared ActiveReader config helpers.
 *
 * Plain Node, no dependencies:
 *   node tests/config.test.js
 *
 * config.js is a classic script that hangs everything off globalThis.AR, so we
 * provide a tiny in-memory chrome.storage stub and require it directly.
 */
"use strict";

const assert = require("assert");
const path = require("path");

/* ---- minimal chrome.storage stub ------------------------------------- */
function makeStorage() {
  const data = {};
  const area = {
    get: async (keys) => {
      if (keys == null) return Object.assign({}, data);
      if (typeof keys === "string") return { [keys]: data[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (k in data) out[k] = data[k];
        });
        return out;
      }
      const out = {};
      Object.keys(keys).forEach((k) => {
        out[k] = k in data ? data[k] : keys[k];
      });
      return out;
    },
    set: async (patch) => {
      Object.assign(data, patch);
    }
  };
  return { area, data };
}

const local = makeStorage();
const sync = makeStorage();
globalThis.chrome = { storage: { local: local.area, sync: sync.area } };

require(path.join("..", "src", "lib", "config.js"));
const AR = globalThis.AR;

/* ---- tiny async-aware test runner ------------------------------------ */
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("defaults are valid and independent of the shared template", () => {
  const s = AR.normalizeSettings({});
  assert.strictEqual(s.targetLang, "es");
  assert.strictEqual(s.baseLang, "en");
  assert.strictEqual(s.clickDefine, false);
  assert.deepStrictEqual(s.quizTypes, ["mcq", "short", "blank"]);
  s.disabledSites.push("mutated");
  s.quizTypes.push("mutated");
  assert.deepStrictEqual(AR.DEFAULTS.disabledSites, []);
  assert.deepStrictEqual(AR.DEFAULTS.quizTypes, ["mcq", "short", "blank"]);
});

test("garbage values are coerced and clamped", () => {
  const s = AR.normalizeSettings({
    geminiApiKey: 123,
    geminiModel: "  gemini-2.5-flash  ",
    targetLang: "not-a-language",
    ttsProvider: "hack",
    ttsRate: 99,
    ttsPitch: -5,
    showToolbar: "yes",
    clickDefine: "yes",
    minSelectionLength: 0,
    maxSelectionLength: 50,
    translationEngine: "bogus",
    quizTypes: ["mcq", "bogus", "short"],
    quizDifficulty: "nope",
    quizCount: 999,
    quizLanguage: "klingon",
    theme: "solar",
    panelAccent: "toString",
    panelWidth: -12,
    panelHeight: "abc"
  });
  assert.strictEqual(s.geminiApiKey, "");
  assert.strictEqual(s.geminiModel, "gemini-2.5-flash");
  assert.strictEqual(s.targetLang, "es");
  assert.strictEqual(s.ttsProvider, "google");
  assert.strictEqual(s.ttsRate, 2);
  assert.strictEqual(s.ttsPitch, 0);
  assert.strictEqual(s.showToolbar, true);
  // Non-boolean values fall back to the default, which is now false.
  assert.strictEqual(s.clickDefine, false);
  assert.strictEqual(s.minSelectionLength, 1);
  assert.strictEqual(s.maxSelectionLength, 200);
  assert.strictEqual(s.translationEngine, "google");
  assert.deepStrictEqual(s.quizTypes, ["mcq", "short"]);
  assert.strictEqual(s.quizDifficulty, "intermediate");
  assert.strictEqual(s.quizCount, 10);
  assert.strictEqual(s.quizLanguage, "target");
  assert.strictEqual(s.theme, "auto");
  assert.strictEqual(s.panelAccent, "indigo");
  assert.strictEqual(s.panelWidth, 0);
  assert.strictEqual(s.panelHeight, 0);
});

test("an intentionally empty quiz type list is preserved", () => {
  assert.deepStrictEqual(AR.normalizeSettings({ quizTypes: [] }).quizTypes, []);
});

test("language options are sorted alphabetically by label", () => {
  const labels = AR.LANGUAGES.map((l) => l.label);
  assert.deepStrictEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, "en")));
  assert.strictEqual(labels[0], "Afrikaans");
  assert.strictEqual(labels[labels.length - 1], "Vietnamese");
  // The rendered dropdown options follow the same order and keep the selection.
  const html = AR.languageOptionsHtml("es");
  const order = [...html.matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)</g)];
  assert.deepStrictEqual(
    order.map((m) => m[3]),
    labels
  );
  assert.ok(order.some((m) => m[1] === "es" && m[2].includes("selected")));
});

test("non-numeric values fall back to defaults instead of 0", () => {
  const s = AR.normalizeSettings({ ttsRate: null, ttsPitch: true, quizCount: [], panelWidth: "" });
  assert.strictEqual(s.ttsRate, 1); // default, not the 0.5 minimum
  assert.strictEqual(s.ttsPitch, 1);
  assert.strictEqual(s.quizCount, 5);
  assert.strictEqual(s.panelWidth, 0);
  assert.strictEqual(AR.normalizeSettings({ ttsRate: "1.25" }).ttsRate, 1.25);
  assert.strictEqual(AR.normalizeSettings({ ttsRate: 0 }).ttsRate, 0.5);
});

test("parseSiteList strips schemes, paths, ports, wildcards and duplicates", () => {
  assert.deepStrictEqual(
    AR.parseSiteList(["*.Example.com", "https://foo.com/path", "example.com", ".bar.com", "https://port.com:8443/x", ""]),
    ["example.com", "foo.com", "bar.com", "port.com"]
  );
  assert.deepStrictEqual(AR.parseSiteList("a.com\nb.com, a.com"), ["a.com", "b.com"]);
});

test("site access defaults to all sites with empty lists", () => {
  const s = AR.normalizeSettings({});
  assert.strictEqual(s.siteAccess, "all");
  assert.deepStrictEqual(s.enabledSites, []);
  assert.deepStrictEqual(s.disabledSites, []);
  assert.strictEqual(AR.normalizeSettings({ siteAccess: "hack" }).siteAccess, "all");
});

test("isSiteActive honours the block list and the allow-list mode", () => {
  const all = AR.normalizeSettings({ disabledSites: ["blocked.com"] });
  assert.strictEqual(AR.isSiteActive(all, "example.com"), true);
  assert.strictEqual(AR.isSiteActive(all, "blocked.com"), false);
  assert.strictEqual(AR.isSiteActive(all, "news.blocked.com"), false);
  // A page with no hostname (file://, about:blank) stays active in "all" mode.
  assert.strictEqual(AR.isSiteActive(all, ""), true);

  const selected = AR.normalizeSettings({
    siteAccess: "selected",
    enabledSites: ["*.Example.com", "https://learn.es/path"]
  });
  assert.strictEqual(selected.siteAccess, "selected");
  assert.strictEqual(AR.isSiteActive(selected, "example.com"), true);
  assert.strictEqual(AR.isSiteActive(selected, "news.example.com"), true);
  assert.strictEqual(AR.isSiteActive(selected, "learn.es"), true);
  assert.strictEqual(AR.isSiteActive(selected, "other.com"), false);
  assert.strictEqual(AR.isSiteActive(selected, ""), false);

  // The block list still wins over the allow list.
  const both = AR.normalizeSettings({
    siteAccess: "selected",
    enabledSites: ["example.com"],
    disabledSites: ["news.example.com"]
  });
  assert.strictEqual(AR.isSiteActive(both, "example.com"), true);
  assert.strictEqual(AR.isSiteActive(both, "news.example.com"), false);
});

test("hostFromUrl extracts a hostname and survives garbage", () => {
  assert.strictEqual(AR.hostFromUrl("https://News.Example.com/path?q=1"), "news.example.com");
  assert.strictEqual(AR.hostFromUrl("not a url"), "");
  assert.strictEqual(AR.hostFromUrl(""), "");
});

test("normalizePatch touches only the supplied keys", () => {
  const patch = AR.normalizePatch({ autoTranslate: true, maxSelectionLength: 9, unknown: 1 });
  assert.deepStrictEqual(Object.keys(patch).sort(), ["autoTranslate", "maxSelectionLength"]);
  assert.strictEqual(patch.autoTranslate, true);
  assert.strictEqual(patch.maxSelectionLength, 200);
  assert.deepStrictEqual(AR.normalizePatch(null), {});
});

test("getSettings round-trips through storage and normalizes", async () => {
  await AR.saveSettings({ targetLang: "fr", quizCount: 3 });
  const s = await AR.getSettings();
  assert.strictEqual(s.targetLang, "fr");
  assert.strictEqual(s.quizCount, 3);
});

test("saved-word helpers defend against a corrupted value", async () => {
  local.data.savedWords = "not-an-array";
  assert.deepStrictEqual(await AR.getSavedWords(), []);
  await AR.saveSavedWords([{ id: "1", text: "hola" }]);
  assert.strictEqual((await AR.getSavedWords()).length, 1);
});

test("update settings default on and coerce from garbage", () => {
  const d = AR.normalizeSettings({});
  assert.strictEqual(d.autoCheckUpdates, true);
  assert.strictEqual(d.notifyUpdates, true);

  const s = AR.normalizeSettings({ autoCheckUpdates: "yes", notifyUpdates: 0 });
  assert.strictEqual(s.autoCheckUpdates, true); // non-boolean falls back
  assert.strictEqual(s.notifyUpdates, true);

  assert.strictEqual(AR.normalizeSettings({ autoCheckUpdates: false, notifyUpdates: false }).autoCheckUpdates, false);
});

test("parseVersion accepts plain, v-prefixed and prerelease versions", () => {
  assert.deepStrictEqual(AR.parseVersion("1.2.3").parts, [1, 2, 3]);
  assert.deepStrictEqual(AR.parseVersion("v1.2.3").parts, [1, 2, 3]);
  assert.deepStrictEqual(AR.parseVersion("1.2.3.4").parts, [1, 2, 3, 4]);
  assert.strictEqual(AR.parseVersion("1.2.3-beta.1").pre, "beta.1");
  assert.strictEqual(AR.parseVersion("1.2.3+build.5").pre, ""); // build metadata ignored
  assert.strictEqual(AR.compareVersions("1.2.3+build.5", "1.2.3"), 0);
  assert.strictEqual(AR.parseVersion("not-a-version"), null);
  assert.strictEqual(AR.parseVersion(""), null);
});

test("compareVersions orders versions and treats releases above prereleases", () => {
  assert.strictEqual(AR.compareVersions("1.0.0", "1.0.0"), 0);
  assert.strictEqual(AR.compareVersions("1.0.0", "1.0.1"), -1);
  assert.strictEqual(AR.compareVersions("1.2.0", "1.1.9"), 1);
  assert.strictEqual(AR.compareVersions("v1.0.0", "1.0.0"), 0);
  assert.strictEqual(AR.compareVersions("1.0", "1.0.0"), 0); // trailing zero padded
  assert.strictEqual(AR.compareVersions("1.0.0", "1.0.0-beta"), 1);
  assert.strictEqual(AR.compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.strictEqual(AR.compareVersions("1.0.0", "garbage"), 1);
  assert.strictEqual(AR.compareVersions("garbage", "1.0.0"), -1);
});

test("isNewerVersion only reports strict advances", () => {
  assert.strictEqual(AR.isNewerVersion("1.1.0", "1.0.0"), true);
  assert.strictEqual(AR.isNewerVersion("1.0.0", "1.0.0"), false);
  assert.strictEqual(AR.isNewerVersion("0.9.9", "1.0.0"), false);
});

test("hasUpdate recomputes availability instead of trusting the stored flag", () => {
  // Runs against the version loaded from the manifest (1.1.0 in the fallback).
  assert.strictEqual(AR.hasUpdate({ latestVersion: "9.9.9", updateAvailable: false }), true);
  assert.strictEqual(AR.hasUpdate({ latestVersion: "0.0.1", updateAvailable: true }), false);
  assert.strictEqual(AR.hasUpdate({ latestVersion: "" }), false);
  assert.strictEqual(AR.hasUpdate(null), false);
});

test("update URLs point at the ActiveReader GitHub repository", () => {
  assert.strictEqual(AR.UPDATE.OWNER, "tylertran349");
  assert.strictEqual(AR.UPDATE.REPO, "ActiveReader");
  assert.strictEqual(AR.UPDATE.repoUrl, "https://github.com/tylertran349/ActiveReader");
  assert.strictEqual(
    AR.UPDATE.manifestUrl,
    "https://raw.githubusercontent.com/tylertran349/ActiveReader/main/manifest.json"
  );
  assert.strictEqual(
    AR.UPDATE.treeUrl,
    "https://api.github.com/repos/tylertran349/ActiveReader/git/trees/main?recursive=1"
  );
  assert.ok(AR.UPDATE.rawBase.startsWith("https://raw.githubusercontent.com/tylertran349/ActiveReader/main/"));
});

test("isSafeRepoPath blocks traversal, absolute and empty paths", () => {
  assert.strictEqual(AR.isSafeRepoPath("manifest.json"), true);
  assert.strictEqual(AR.isSafeRepoPath("src/content.js"), true);
  assert.strictEqual(AR.isSafeRepoPath("icons/icon16.png"), true);
  assert.strictEqual(AR.isSafeRepoPath("src/lib/config.js"), true);

  assert.strictEqual(AR.isSafeRepoPath("../outside.js"), false);
  assert.strictEqual(AR.isSafeRepoPath("a/../../b"), false);
  assert.strictEqual(AR.isSafeRepoPath("src/./config.js"), false);
  assert.strictEqual(AR.isSafeRepoPath("src//config.js"), false);
  assert.strictEqual(AR.isSafeRepoPath("src/"), false);
  assert.strictEqual(AR.isSafeRepoPath("/absolute"), false);
  assert.strictEqual(AR.isSafeRepoPath("."), false);
  assert.strictEqual(AR.isSafeRepoPath(""), false);
  assert.strictEqual(AR.isSafeRepoPath(null), false);
  // Backslashes are treated as separators, so they cannot hide a traversal.
  assert.strictEqual(AR.isSafeRepoPath("a\\..\\config.js"), false);
});

test("custom provider settings normalize with a safe base URL", () => {
  const s = AR.normalizeSettings({
    llmProvider: "custom",
    customApiBaseUrl: " https://api.commandcode.ai/provider/v1/chat/completions/ ",
    customApiKey: 123,
    customApiModel: "  deepseek/deepseek-v4.1-flash  ",
    customThinkingLevel: " MAX "
  });
  assert.strictEqual(s.llmProvider, "custom");
  assert.strictEqual(s.customApiBaseUrl, "https://api.commandcode.ai/provider/v1");
  assert.strictEqual(s.customApiKey, "");
  assert.strictEqual(s.customApiModel, "deepseek/deepseek-v4.1-flash");
  assert.strictEqual(s.customThinkingLevel, "max");

  assert.strictEqual(AR.normalizeSettings({ llmProvider: "bogus" }).llmProvider, "gemini");
  assert.strictEqual(AR.normalizeSettings({ customThinkingLevel: "<script>" }).customThinkingLevel, "");
  assert.strictEqual(AR.normalizeSettings({}).customApiBaseUrl, "");
  assert.strictEqual(AR.normalizeSettings({}).customApiModel, "");
  assert.strictEqual(AR.normalizeSettings({}).customThinkingLevel, "");
});

test("DeepSeek V4.1 Flash exposes its documented thinking ladder", () => {
  const info = AR.getThinkingLevels("deepseek/deepseek-v4.1-flash");
  assert.deepStrictEqual(info.levels, ["low", "high", "max"]);
  assert.strictEqual(info.default, "high");

  assert.strictEqual(AR.resolveThinkingLevel("deepseek/deepseek-v4.1-flash", ""), "high");
  assert.strictEqual(AR.resolveThinkingLevel("deepseek/deepseek-v4.1-flash", "max"), "max");
  assert.strictEqual(AR.resolveThinkingLevel("deepseek/deepseek-v4.1-flash", "bogus"), "high");
  assert.deepStrictEqual(AR.getThinkingLevels("deepseek-v4.1-flash"), info);
  assert.deepStrictEqual(AR.getThinkingLevels("unknown/model"), { levels: [], default: "" });
  // Known models reject an unknown token; an unknown model keeps an explicit
  // safe token so provider-advertised ladders still work.
  assert.strictEqual(AR.resolveThinkingLevel("unknown/model", "max"), "max");
  assert.strictEqual(AR.resolveThinkingLevel("unknown/model", "<bad>"), "");
});

test("think levels can be read from custom model-row metadata", () => {
  const fromRow = AR.getThinkingLevelsFromModel(
    { id: "acme/reasoner", reasoning_efforts: ["minimal", "low", "high"], default_reasoning_effort: "low" },
    "acme/reasoner"
  );
  assert.deepStrictEqual(fromRow.levels, ["minimal", "low", "high"]);
  assert.strictEqual(fromRow.default, "low");

  const nested = AR.getThinkingLevelsFromModel(
    { id: "acme/nested", capabilities: { thinking: { efforts: ["low", "max"], default: "max" } } },
    "acme/nested"
  );
  assert.deepStrictEqual(nested.levels, ["low", "max"]);
  assert.strictEqual(nested.default, "max");

  // No metadata: fall back to the built-in table.
  const fallback = AR.getThinkingLevelsFromModel({ id: "deepseek/deepseek-v4.1-flash" });
  assert.deepStrictEqual(fallback.levels, ["low", "high", "max"]);
  assert.strictEqual(fallback.default, "high");
});

test("custom endpoint helpers accept bare roots and full chat URLs", () => {
  assert.strictEqual(
    AR.customChatCompletionsUrl("https://api.commandcode.ai/provider/v1"),
    "https://api.commandcode.ai/provider/v1/chat/completions"
  );
  assert.strictEqual(
    AR.customChatCompletionsUrl("https://api.commandcode.ai/provider/v1/chat/completions/"),
    "https://api.commandcode.ai/provider/v1/chat/completions"
  );
  assert.strictEqual(
    AR.customModelsUrl("https://example.com/v1/responses"),
    "https://example.com/v1/models"
  );
  assert.strictEqual(AR.normalizeCustomBaseUrl("api.commandcode.ai/provider/v1"), "https://api.commandcode.ai/provider/v1");
  assert.strictEqual(AR.normalizeCustomBaseUrl("localhost:11434/v1"), "http://localhost:11434/v1");
  assert.strictEqual(
    AR.normalizeCustomBaseUrl("https://api.commandcode.ai/provider/v1/models"),
    "https://api.commandcode.ai/provider/v1"
  );
});

test("compactQuizText collapses wasted whitespace and enforces the cap", () => {
  assert.strictEqual(AR.compactQuizText("  a\t\tb\n\n\n\nc  "), "a b\n\nc");
  assert.strictEqual(AR.compactQuizText("abcdef", 3), "abc");
  assert.strictEqual(AR.compactQuizText("  \r\n  "), "");
  // Newlines between real lines survive; only their surrounding padding goes.
  assert.strictEqual(AR.compactQuizText("one\n  two\n"), "one\ntwo");
});

test("quiz output budget grows with the question count and explanations", () => {
  const short = AR.quizOutputTokenLimit(5, false);
  const long = AR.quizOutputTokenLimit(5, true);
  assert.ok(short > 0);
  assert.ok(long > short);
  assert.ok(long < 4096);
  assert.strictEqual(AR.quizOutputTokenLimit(100, true), 3584);
  assert.strictEqual(AR.quizOutputTokenLimit(1, false), 580);
});

test("quiz writing uses the cheapest known thinking level", () => {
  assert.strictEqual(AR.resolveQuizThinkingLevel("deepseek/deepseek-v4.1-flash", "max"), "low");
  assert.strictEqual(AR.resolveQuizThinkingLevel("deepseek/deepseek-v4-flash", "max"), "high");
  // Unknown models keep the explicit choice instead of inventing a level.
  assert.strictEqual(AR.resolveQuizThinkingLevel("unknown/model", "max"), "max");
  assert.strictEqual(AR.resolveQuizThinkingLevel("unknown/model", ""), "");
});

test("Gemini quiz calls use the cheapest supported thinking setting", () => {
  assert.deepStrictEqual(AR.geminiQuizThinkingConfig("gemini-2.5-flash"), { thinkingBudget: 0 });
  assert.deepStrictEqual(AR.geminiQuizThinkingConfig("gemini-3-flash-preview"), { thinkingLevel: "low" });
  assert.deepStrictEqual(AR.geminiQuizThinkingConfig("gemini-3.8-flash"), { thinkingLevel: "low" });
  // Lite models already skip thinking; a level could switch it on.
  assert.strictEqual(AR.geminiQuizThinkingConfig("gemini-2.5-flash-lite"), null);
  assert.strictEqual(AR.geminiQuizThinkingConfig("gemini-3.5-flash-lite"), null);
  // Pro and Gemini 4+ models reject these values, so leave them at defaults.
  assert.strictEqual(AR.geminiQuizThinkingConfig("gemini-2.5-pro"), null);
  assert.strictEqual(AR.geminiQuizThinkingConfig("gemini-4-argon"), null);
  assert.strictEqual(AR.geminiQuizThinkingConfig("gemini-2.0-flash"), null);
});

test("quiz prompt only documents the selected types and requested fields", () => {
  const settings = { targetLang: "es", baseLang: "en" };
  const mcqOnly = AR.buildQuizPrompt("Hola mundo", {
    types: ["mcq"],
    difficulty: "beginner",
    quizLanguage: "target",
    explain: false
  }, settings, 3);

  assert.ok(mcqOnly.includes("exactly 3 questions"));
  assert.ok(mcqOnly.includes("Hola mundo"));
  assert.ok(mcqOnly.includes("mcq (Multiple choice)"));
  assert.ok(mcqOnly.includes('"answerIndex"'));
  assert.ok(!mcqOnly.includes("Fill in the blank"));
  assert.ok(!mcqOnly.includes("short: open"));
  assert.ok(!mcqOnly.includes('"answer":"..."'));
  assert.ok(!mcqOnly.includes('"explanation":"..."'));
  // A short prompt is the main way input tokens are kept low.
  assert.ok(mcqOnly.length < 800, "prompt was " + mcqOnly.length + " chars");

  const full = AR.buildQuizPrompt("Hola mundo", {
    types: ["mcq", "short", "blank"],
    difficulty: "advanced",
    quizLanguage: "both",
    explain: true
  }, settings, 5);

  assert.ok(
    full.includes(
      "mcq (Multiple choice), short (Short answer), blank (Fill in the blank)"
    )
  );
  assert.ok(full.includes("Fill in the blank"));
  assert.ok(full.includes('"explanation"'));
  assert.ok(full.includes("translation in parentheses"));

  const shortOnly = AR.buildQuizPrompt("Hola mundo", {
    types: ["short"],
    difficulty: "intermediate",
    quizLanguage: "target",
    explain: false
  }, settings, 4);
  assert.ok(shortOnly.includes('"answer":"..."'));
  assert.ok(!shortOnly.includes('"options"'));
  assert.ok(!shortOnly.includes('"answerIndex"'));
});

(async () => {
  console.log("config.js");
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log("  ok - " + t.name);
    } catch (e) {
      console.error("  FAIL - " + t.name);
      console.error("    " + (e && e.message));
      process.exitCode = 1;
    }
  }
  console.log("\n" + passed + "/" + tests.length + " tests passed");
})();
