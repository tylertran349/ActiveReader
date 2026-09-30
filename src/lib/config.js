/*
 * ActiveReader shared configuration.
 * Loaded as a classic script in the service worker, content script, popup and
 * options page. Everything hangs off the global `AR` namespace.
 */
(function () {
  "use strict";

  const AR = (globalThis.AR = globalThis.AR || {});

  AR.VERSION = "1.0.0";

  /* ---------------------------------------------------------------- defaults */

  AR.DEFAULTS = {
    // Gemini
    geminiApiKey: "",
    // Empty by default: the model ID is free text, and the options page can pick
    // one automatically from the live API list (no hardcoded model catalog).
    geminiModel: "",

    // Languages
    targetLang: "es", // the language being learned
    baseLang: "en", // the language explanations/translations are shown in

    // Text to speech
    ttsProvider: "google", // "google" | "browser"
    ttsRate: 1.0,
    ttsPitch: 1.0,

    // Selection behaviour
    showToolbar: true,
    autoTranslate: false,
    minSelectionLength: 2,
    maxSelectionLength: 2000,
    disabledSites: [],

    // Translation
    translationEngine: "google", // "google" | "gemini"

    // Quiz defaults
    quizTypes: ["mcq", "short", "blank"],
    quizDifficulty: "intermediate", // beginner | intermediate | advanced
    quizCount: 5,
    quizLanguage: "target", // target | base | both
    quizExplain: true,

    // Appearance / misc
    theme: "auto", // auto | light | dark
    panelAccent: "indigo", // indigo | emerald | rose | amber | violet
    autoSaveLookups: false
  };

  // NOTE: no hardcoded list of Gemini models. The model ID is free text so new
  // models work the moment Google ships them; the options page can also fetch
  // the live list from the API. DEFAULTS.geminiModel is only a starting value.

  AR.ACCENTS = {
    indigo: { a: "#6366f1", b: "#0ea5e9" },
    emerald: { a: "#10b981", b: "#14b8a6" },
    rose: { a: "#f43f5e", b: "#fb7185" },
    amber: { a: "#f59e0b", b: "#f97316" },
    violet: { a: "#8b5cf6", b: "#d946ef" }
  };

  /* --------------------------------------------------------------- languages */

  // `code` is the Google Translate code, `tts` the Google Translate TTS code,
  // `gemini` the English name handed to the model, `locale` the BCP-47 tag used
  // for the built in browser speech synthesiser.
  AR.LANGUAGES = [
    { code: "en", label: "English", gemini: "English", tts: "en", locale: "en-US" },
    { code: "es", label: "Spanish", gemini: "Spanish", tts: "es", locale: "es-ES" },
    { code: "fr", label: "French", gemini: "French", tts: "fr", locale: "fr-FR" },
    { code: "de", label: "German", gemini: "German", tts: "de", locale: "de-DE" },
    { code: "it", label: "Italian", gemini: "Italian", tts: "it", locale: "it-IT" },
    { code: "pt", label: "Portuguese", gemini: "Portuguese", tts: "pt", locale: "pt-BR" },
    { code: "nl", label: "Dutch", gemini: "Dutch", tts: "nl", locale: "nl-NL" },
    { code: "sv", label: "Swedish", gemini: "Swedish", tts: "sv", locale: "sv-SE" },
    { code: "da", label: "Danish", gemini: "Danish", tts: "da", locale: "da-DK" },
    { code: "no", label: "Norwegian", gemini: "Norwegian", tts: "no", locale: "nb-NO" },
    { code: "fi", label: "Finnish", gemini: "Finnish", tts: "fi", locale: "fi-FI" },
    { code: "pl", label: "Polish", gemini: "Polish", tts: "pl", locale: "pl-PL" },
    { code: "cs", label: "Czech", gemini: "Czech", tts: "cs", locale: "cs-CZ" },
    { code: "sk", label: "Slovak", gemini: "Slovak", tts: "sk", locale: "sk-SK" },
    { code: "hu", label: "Hungarian", gemini: "Hungarian", tts: "hu", locale: "hu-HU" },
    { code: "ro", label: "Romanian", gemini: "Romanian", tts: "ro", locale: "ro-RO" },
    { code: "bg", label: "Bulgarian", gemini: "Bulgarian", tts: "bg", locale: "bg-BG" },
    { code: "el", label: "Greek", gemini: "Greek", tts: "el", locale: "el-GR" },
    { code: "ru", label: "Russian", gemini: "Russian", tts: "ru", locale: "ru-RU" },
    { code: "uk", label: "Ukrainian", gemini: "Ukrainian", tts: "uk", locale: "uk-UA" },
    { code: "tr", label: "Turkish", gemini: "Turkish", tts: "tr", locale: "tr-TR" },
    { code: "ar", label: "Arabic", gemini: "Arabic", tts: "ar", locale: "ar-SA" },
    { code: "he", label: "Hebrew", gemini: "Hebrew", tts: "he", locale: "he-IL" },
    { code: "fa", label: "Persian", gemini: "Persian", tts: "fa", locale: "fa-IR" },
    { code: "hi", label: "Hindi", gemini: "Hindi", tts: "hi", locale: "hi-IN" },
    { code: "bn", label: "Bengali", gemini: "Bengali", tts: "bn", locale: "bn-BD" },
    { code: "ta", label: "Tamil", gemini: "Tamil", tts: "ta", locale: "ta-IN" },
    { code: "te", label: "Telugu", gemini: "Telugu", tts: "te", locale: "te-IN" },
    { code: "ur", label: "Urdu", gemini: "Urdu", tts: "ur", locale: "ur-PK" },
    { code: "th", label: "Thai", gemini: "Thai", tts: "th", locale: "th-TH" },
    { code: "vi", label: "Vietnamese", gemini: "Vietnamese", tts: "vi", locale: "vi-VN" },
    { code: "id", label: "Indonesian", gemini: "Indonesian", tts: "id", locale: "id-ID" },
    { code: "ms", label: "Malay", gemini: "Malay", tts: "ms", locale: "ms-MY" },
    { code: "tl", label: "Filipino", gemini: "Filipino", tts: "tl", locale: "fil-PH" },
    { code: "ja", label: "Japanese", gemini: "Japanese", tts: "ja", locale: "ja-JP" },
    { code: "ko", label: "Korean", gemini: "Korean", tts: "ko", locale: "ko-KR" },
    { code: "zh-CN", label: "Chinese (Simplified)", gemini: "Simplified Chinese", tts: "zh-CN", locale: "zh-CN" },
    { code: "zh-TW", label: "Chinese (Traditional)", gemini: "Traditional Chinese", tts: "zh-TW", locale: "zh-TW" },
    { code: "sw", label: "Swahili", gemini: "Swahili", tts: "sw", locale: "sw-KE" },
    { code: "ca", label: "Catalan", gemini: "Catalan", tts: "ca", locale: "ca-ES" },
    { code: "hr", label: "Croatian", gemini: "Croatian", tts: "hr", locale: "hr-HR" },
    { code: "sr", label: "Serbian", gemini: "Serbian", tts: "sr", locale: "sr-RS" },
    { code: "lt", label: "Lithuanian", gemini: "Lithuanian", tts: "lt", locale: "lt-LT" },
    { code: "lv", label: "Latvian", gemini: "Latvian", tts: "lv", locale: "lv-LV" },
    { code: "et", label: "Estonian", gemini: "Estonian", tts: "et", locale: "et-EE" },
    { code: "sl", label: "Slovenian", gemini: "Slovenian", tts: "sl", locale: "sl-SI" },
    { code: "af", label: "Afrikaans", gemini: "Afrikaans", tts: "af", locale: "af-ZA" }
  ];

  AR.langByCode = function (code) {
    return AR.LANGUAGES.find((l) => l.code === code) || null;
  };

  AR.langName = function (code) {
    const l = AR.langByCode(code);
    return l ? l.gemini : code || "the target language";
  };

  AR.langLabel = function (code) {
    const l = AR.langByCode(code);
    return l ? l.label : code || "?";
  };

  AR.ttsCode = function (code) {
    const l = AR.langByCode(code);
    return l ? l.tts : code;
  };

  AR.ttsLocale = function (code) {
    const l = AR.langByCode(code);
    return l ? l.locale : code;
  };

  /* --------------------------------------------------------------- settings */

  AR.getSettings = async function () {
    try {
      const stored = await chrome.storage.sync.get(AR.DEFAULTS);
      return Object.assign({}, AR.DEFAULTS, stored);
    } catch (e) {
      return Object.assign({}, AR.DEFAULTS);
    }
  };

  AR.saveSettings = async function (patch) {
    return chrome.storage.sync.set(patch);
  };

  AR.escapeHtml = function (str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  /* ----------------------------------------------------------------- icons */

  /* Material Symbols (Rounded) path data, inlined as SVG so the icons render
   * identically in the page shadow DOM, the popup and the options page without
   * shipping a font or reaching the network. Icons with a `_fill` suffix are
   * the filled variant used to show an active/selected state. */
  AR.ICON_PATHS = {
    translate:
      "m603-202-34 97q-4 11-14 18t-22 7q-20 0-32.5-16.5T496-133l152-402q5-11 15-18t22-7h30q12 0 22 7t15 18l152 403q8 19-4 35.5T868-80q-13 0-22.5-7T831-106l-34-96H603ZM362-401 188-228q-11 11-27.5 11.5T132-228q-11-11-11-28t11-28l174-174q-35-35-63.5-80T190-640h84q20 39 40 68t48 58q33-33 68.5-92.5T484-720H80q-17 0-28.5-11.5T40-760q0-17 11.5-28.5T80-800h240v-40q0-17 11.5-28.5T360-880q17 0 28.5 11.5T400-840v40h240q17 0 28.5 11.5T680-760q0 17-11.5 28.5T640-720h-76q-21 72-63 148t-83 116l96 98-30 82-122-125Zm266 129h144l-72-204-72 204Z",
    volume_up:
      "M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z",
    quiz: "M589.5-372.5Q602-385 602-402t-12.5-29.5Q577-444 560-444t-29.5 12.5Q518-419 518-402t12.5 29.5Q543-360 560-360t29.5-12.5ZM560-488q11 0 20.5-8t11.5-21q2-12 8.5-22t23.5-27q30-30 40-48.5t10-43.5q0-45-31.5-73.5T560-760q-33 0-60 15t-43 43q-6 10-1 21t17 16q11 5 21.5 1t17.5-14q9-13 21-19.5t27-6.5q24 0 39 13.5t15 36.5q0 14-8 26.5T578-596q-29 25-37 38.5T531-518q-1 12 7.5 21t21.5 9ZM320-240q-33 0-56.5-23.5T240-320v-480q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H320Zm0-80h480v-480H320v480ZM160-80q-33 0-56.5-23.5T80-160v-520q0-17 11.5-28.5T120-720q17 0 28.5 11.5T160-680v520h520q17 0 28.5 11.5T720-120q0 17-11.5 28.5T680-80H160Zm160-720v480-480Z",
    star: "m354-287 126-76 126 77-33-144 111-96-146-13-58-136-58 135-146 13 111 97-33 143Zm126 18L314-169q-11 7-23 6t-21-8q-9-7-14-17.5t-2-23.5l44-189-147-127q-10-9-12.5-20.5T140-571q4-11 12-18t22-9l194-17 75-178q5-12 15.5-18t21.5-6q11 0 21.5 6t15.5 18l75 178 194 17q14 2 22 9t12 18q4 11 1.5 22.5T809-528L662-401l44 189q3 13-2 23.5T690-171q-9 7-21 8t-23-6L480-269Zm0-201Z",
    star_fill:
      "M480-269 314-169q-11 7-23 6t-21-8q-9-7-14-17.5t-2-23.5l44-189-147-127q-10-9-12.5-20.5T140-571q4-11 12-18t22-9l194-17 75-178q5-12 15.5-18t21.5-6q11 0 21.5 6t15.5 18l75 178 194 17q14 2 22 9t12 18q4 11 1.5 22.5T809-528L662-401l44 189q3 13-2 23.5T690-171q-9 7-21 8t-23-6L480-269Z",
    close:
      "M480-424 284-228q-11 11-28 11t-28-11q-11-11-11-28t11-28l196-196-196-196q-11-11-11-28t11-28q11-11 28-11t28 11l196 196 196-196q11-11 28-11t28 11q11 11 11 28t-11 28L536-480l196 196q11 11 11 28t-11 28q-11 11-28 11t-28-11L480-424Z",
    block:
      "M324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM480-160q54 0 104-17.5t92-50.5L228-676q-33 42-50.5 92T160-480q0 134 93 227t227 93Zm252-124q33-42 50.5-92T800-480q0-134-93-227t-227-93q-54 0-104 17.5T284-732l448 448ZM480-480Z",
    settings:
      "M433-80q-27 0-46.5-18T363-142l-9-66q-13-5-24.5-12T307-235l-62 26q-25 11-50 2t-39-32l-47-82q-14-23-8-49t27-43l53-40q-1-7-1-13.5v-27q0-6.5 1-13.5l-53-40q-21-17-27-43t8-49l47-82q14-23 39-32t50 2l62 26q11-8 23-15t24-12l9-66q4-26 23.5-44t46.5-18h94q27 0 46.5 18t23.5 44l9 66q13 5 24.5 12t22.5 15l62-26q25-11 50-2t39 32l47 82q14 23 8 49t-27 43l-53 40q1 7 1 13.5v27q0 6.5-2 13.5l53 40q21 17 27 43t-8 49l-48 82q-14 23-39 32t-50-2l-60-26q-11 8-23 15t-24 12l-9 66q-4 26-23.5 44T527-80h-94Zm7-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z",
    content_copy:
      "M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-520q0-17 11.5-28.5T160-720q17 0 28.5 11.5T200-680v520h400q17 0 28.5 11.5T640-120q0 17-11.5 28.5T600-80H200Zm160-240v-480 480Z",
    graphic_eq:
      "M280-280v-400q0-17 11.5-28.5T320-720q17 0 28.5 11.5T360-680v400q0 17-11.5 28.5T320-240q-17 0-28.5-11.5T280-280Zm160 160v-720q0-17 11.5-28.5T480-880q17 0 28.5 11.5T520-840v720q0 17-11.5 28.5T480-80q-17 0-28.5-11.5T440-120ZM120-440v-80q0-17 11.5-28.5T160-560q17 0 28.5 11.5T200-520v80q0 17-11.5 28.5T160-400q-17 0-28.5-11.5T120-440Zm480 160v-400q0-17 11.5-28.5T640-720q17 0 28.5 11.5T680-680v400q0 17-11.5 28.5T640-240q-17 0-28.5-11.5T600-280Zm160-160v-80q0-17 11.5-28.5T800-560q17 0 28.5 11.5T840-520v80q0 17-11.5 28.5T800-400q-17 0-28.5-11.5T760-440Z",
    headphones:
      "M280-120h-80q-33 0-56.5-23.5T120-200v-280q0-75 28.5-140.5t77-114q48.5-48.5 114-77T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480v280q0 33-23.5 56.5T760-120h-80q-33 0-56.5-23.5T600-200v-160q0-33 23.5-56.5T680-440h80v-40q0-117-81.5-198.5T480-760q-117 0-198.5 81.5T200-480v40h80q33 0 56.5 23.5T360-360v160q0 33-23.5 56.5T280-120Zm0-240h-80v160h80v-160Zm400 0v160h80v-160h-80Zm-400 0h-80 80Zm400 0h80-80Z",
    play_arrow:
      "M320-273v-414q0-17 12-28.5t28-11.5q5 0 10.5 1.5T381-721l326 207q9 6 13.5 15t4.5 19q0 10-4.5 19T707-446L381-239q-5 3-10.5 4.5T360-233q-16 0-28-11.5T320-273Zm80-207Zm0 134 210-134-210-134v268Z",
    replay:
      "M339.5-108.5q-65.5-28.5-114-77t-77-114Q120-365 120-440q0-17 11.5-28.5T160-480q17 0 28.5 11.5T200-440q0 117 81.5 198.5T480-160q117 0 198.5-81.5T760-440q0-117-81.5-198.5T480-720h-6l34 34q12 12 11.5 28T508-630q-12 12-28.5 12.5T451-629L348-732q-12-12-12-28t12-28l103-103q12-12 28.5-11.5T508-890q11 12 11.5 28T508-834l-34 34h6q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-440q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-80q-75 0-140.5-28.5Z",
    stop: "M240-320v-320q0-33 23.5-56.5T320-720h320q33 0 56.5 23.5T720-640v320q0 33-23.5 56.5T640-240H320q-33 0-56.5-23.5T240-320Zm80 0h320v-320H320v320Zm160-160Z",
    auto_awesome:
      "m706-706-70-32q-6-3-8.5-8t-2.5-10q0-5 2.5-10t8.5-8l70-32 32-70q3-6 8-9t10-3q5 0 10 3t8 9l32 70 70 32q6 3 9 8t3 10q0 5-3 10t-9 8l-70 32-32 70q-3 6-8 8.5t-10 2.5q-5 0-10-2.5t-8-8.5l-32-70ZM260-380l-160-73q-9-4-13-11.5T83-480q0-8 4-15.5t13-11.5l160-73 73-160q4-9 11.5-13t15.5-4q8 0 15.5 4t11.5 13l73 160 160 73q9 4 13 11.5t4 15.5q0 8-4 15.5T620-453l-160 73-73 160q-4 9-11.5 13t-15.5 4q-8 0-15.5-4T333-220l-73-160Zm100 26 40-86 86-40-86-40-40-86-40 86-86 40 86 40 40 86Zm350 204-70-32q-6-3-9-8t-3-10q0-5 3-10t9-8l70-32 32-70q3-6 8-9t10-3q5 0 10 3t8 9l32 70 70 32q6 3 9 8t3 10q0 5-3 10t-9 8l-70 32-32 70q-3 6-8 9t-10 3q-5 0-10-3t-8-9l-32-70ZM360-480Z",
    refresh:
      "M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-70q0-17 11.5-28.5T760-800q17 0 28.5 11.5T800-760v200q0 17-11.5 28.5T760-520H560q-17 0-28.5-11.5T520-560q0-17 11.5-28.5T560-600h128q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q68 0 124.5-34.5T692-367q8-14 22.5-19.5t29.5-.5q16 5 23 21t-1 30q-41 80-117 128t-169 48Z",
    visibility:
      "M607.5-372.5Q660-425 660-500t-52.5-127.5Q555-680 480-680t-127.5 52.5Q300-575 300-500t52.5 127.5Q405-320 480-320t127.5-52.5Zm-204-51Q372-455 372-500t31.5-76.5Q435-608 480-608t76.5 31.5Q588-545 588-500t-31.5 76.5Q525-392 480-392t-76.5-31.5ZM235.5-272Q125-344 61-462q-5-9-7.5-18.5T51-500q0-10 2.5-19.5T61-538q64-118 174.5-190T480-800q134 0 244.5 72T899-538q5 9 7.5 18.5T909-500q0 10-2.5 19.5T899-462q-64 118-174.5 190T480-200q-134 0-244.5-72ZM480-500Zm207.5 160.5Q782-399 832-500q-50-101-144.5-160.5T480-720q-113 0-207.5 59.5T128-500q50 101 144.5 160.5T480-280q113 0 207.5-59.5Z",
    check_circle:
      "m424-408-86-86q-11-11-28-11t-28 11q-11 11-11 28t11 28l114 114q12 12 28 12t28-12l226-226q11-11 11-28t-11-28q-11-11-28-11t-28 11L424-408Zm56 328q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
    cancel:
      "m480-424 116 116q11 11 28 11t28-11q11-11 11-28t-11-28L536-480l116-116q11-11 11-28t-11-28q-11-11-28-11t-28 11L480-536 364-652q-11-11-28-11t-28 11q-11 11-11 28t11 28l116 116-116 116q-11 11-11 28t11 28q11 11 28 11t28-11l116-116Zm0 344q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
    lightbulb:
      "M423.5-103.5Q400-127 400-160h160q0 33-23.5 56.5T480-80q-33 0-56.5-23.5ZM360-200q-17 0-28.5-11.5T320-240q0-17 11.5-28.5T360-280h240q17 0 28.5 11.5T640-240q0 17-11.5 28.5T600-200H360Zm-30-120q-69-41-109.5-110T180-580q0-125 87.5-212.5T480-880q125 0 212.5 87.5T780-580q0 81-40.5 150T630-320H330Zm24-80h252q45-32 69.5-79T700-580q0-92-64-156t-156-64q-92 0-156 64t-64 156q0 54 24.5 101t69.5 79Zm126 0Z",
    delete:
      "M280-120q-33 0-56.5-23.5T200-200v-520q-17 0-28.5-11.5T160-760q0-17 11.5-28.5T200-800h160q0-17 11.5-28.5T400-840h160q17 0 28.5 11.5T600-800h160q17 0 28.5 11.5T800-760q0 17-11.5 28.5T760-720v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM428.5-291.5Q440-303 440-320v-280q0-17-11.5-28.5T400-640q-17 0-28.5 11.5T360-600v280q0 17 11.5 28.5T400-280q17 0 28.5-11.5Zm160 0Q600-303 600-320v-280q0-17-11.5-28.5T560-640q-17 0-28.5 11.5T520-600v280q0 17 11.5 28.5T560-280q17 0 28.5-11.5ZM280-720v520-520Z",
    error:
      "M508.5-291.5Q520-303 520-320t-11.5-28.5Q497-360 480-360t-28.5 11.5Q440-337 440-320t11.5 28.5Q463-280 480-280t28.5-11.5Zm0-160Q520-463 520-480v-160q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640v160q0 17 11.5 28.5T480-440q17 0 28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"
  };

  /* Inline Material Symbols icon. Returns an <svg> string so it can be dropped
   * into template HTML in any context. Size/colour follow the surrounding text
   * (1em / currentColor), and `options.className` adds extra classes. */
  AR.icon = function (name, options) {
    const d = AR.ICON_PATHS[name];
    if (!d) return "";
    const opts = options || {};
    const cls = "ar-icon" + (opts.className ? " " + opts.className : "");
    const a11y = opts.label
      ? ' role="img" aria-label="' + AR.escapeHtml(opts.label) + '"'
      : ' aria-hidden="true"';
    return (
      '<svg class="' +
      cls +
      '" viewBox="0 -960 960 960" width="1.15em" height="1.15em" fill="currentColor" focusable="false"' +
      a11y +
      '><path d="' +
      d +
      '"/></svg>'
    );
  };

  AR.QUIZ_TYPES = ["mcq", "short", "blank"];

  AR.QUIZ_TYPE_LABELS = {
    mcq: "Multiple choice",
    short: "Short answer",
    blank: "Fill in the blank"
  };

  /* Languages written right-to-left. */
  AR.RTL_LANGS = { ar: true, he: true, fa: true, ur: true };

  AR.isRtl = function (code) {
    const base = String(code || "").split("-")[0].toLowerCase();
    return !!AR.RTL_LANGS[base];
  };

  /* ------------------------------------------------------------- messages */

  /* One place for every runtime message name so contexts cannot drift apart. */
  AR.MSG = {
    PING: "ar-ping",
    COMMAND: "ar-command",
    TRANSLATE: "ar-translate",
    QUIZ: "ar-quiz",
    TTS: "ar-tts",
    TTS_STOP: "ar-tts-stop",
    TTS_STATE: "ar-tts-state",
    TTS_FALLBACK: "ar-tts-fallback",
    SAVE: "ar-save",
    TEST_GEMINI: "ar-test-gemini",
    LIST_MODELS: "ar-list-models",
    OPEN_OPTIONS: "ar-open-options",
    TARGET_OFFSCREEN: "offscreen",
    TARGET_BG: "bg"
  };

  /* ------------------------------------------------------------- caches */

  AR.CACHE = {
    // How long a fetched model list stays fresh in storage.
    MODEL_TTL_MS: 12 * 60 * 60 * 1000,
    // Max cached translations / quizzes kept per context.
    TRANSLATION_MAX: 60,
    QUIZ_MAX: 20,
    // Max translations kept in the session-wide cache in the service worker.
    SESSION_TRANSLATION_MAX: 200
  };

  /* ------------------------------------------------------------ helpers */

  /* Send a message to the background. Never throws; returns {ok:false} instead. */
  AR.sendMessage = async function (message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      return { ok: false, error: "Could not reach the extension. Reload the page and try again." };
    }
  };

  /* <option> markup for a language <select>. Values come from the trusted list. */
  AR.languageOptionsHtml = function (selected) {
    return AR.LANGUAGES.map(function (l) {
      return '<option value="' + l.code + '"' + (l.code === selected ? " selected" : "") + ">" + l.label + "</option>";
    }).join("");
  };
})();
