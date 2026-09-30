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
