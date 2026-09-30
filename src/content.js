/*
 * ActiveReader content script.
 *
 * Injects a small shadow-DOM toolbar whenever the user highlights text, plus a
 * panel with Translate / Audio / Quiz tabs. All heavy lifting (network calls)
 * happens in the service worker.
 */
(function () {
  "use strict";

  if (window.__activeReaderInjected) return;
  window.__activeReaderInjected = true;

  const AR = globalThis.AR;
  if (!AR) {
    console.warn("[ActiveReader] config not loaded");
    return;
  }
  const MSG = AR.MSG;

  const HOST_TAG = "active-reader-root";

  let settings = Object.assign({}, AR.DEFAULTS);
  let host = null;
  let shadow = null;
  let toolbarEl = null;
  let panelEl = null;
  let bodyEl = null;
  let selEl = null;
  let badgeEl = null;
  let toastEl = null;

  let tab = "translate";
  let pendingReposition = false;
  let toastTimer = null;
  let dragState = null;
  let resizeState = null;

  /* Bumped whenever the highlighted text changes, so responses that arrive
   * after the user selected something else are discarded. */
  let selectionToken = 0;

  /* Small per-page caches so re-opening the panel does not re-hit the network. */
  const translateCache = new Map();
  const quizCache = new Map();

  const current = { text: "", rect: null, saved: false };

  const state = {
    translation: { status: "idle", text: "", detected: "", engine: "", error: "" },
    audio: { status: "idle", provider: "" },
    quiz: {
      status: "idle",
      questions: [],
      error: "",
      revealed: {},
      checked: {},
      picked: {},
      entered: {},
      grading: {},
      grades: {},
      translations: {},
      requested: 0,
      text: "",
      config: null
    }
  };

  const MAX_QUIZ_CHARS = 4000;
  const PANEL_MIN_W = 280;
  const PANEL_MIN_H = 220;

  /* --------------------------------------------------------------- boot */

  init();

  async function init() {
    settings = await AR.getSettings();
    await ensureUi();
    document.addEventListener("mouseup", onSelectionEvent, true);
    document.addEventListener("keyup", onSelectionEvent, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onWindowScroll, true);
    window.addEventListener("resize", hideToolbar);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------ UI setup */

  const FALLBACK_CSS = `
    :host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;
      --ar-bg:#fff;--ar-fg:#0f172a;--ar-border:#e2e8f0;--ar-accent:#6366f1;--ar-accent-2:#0ea5e9;--ar-muted:#64748b;--ar-field:#f1f5f9;--ar-accent-fg:#fff;--ar-bg-2:#f8fafc;--ar-ok:#10b981;--ar-danger:#ef4444;--ar-shadow:0 10px 30px rgba(0,0,0,.25);}
    .ar-toolbar,.ar-panel,.ar-toast{position:fixed;pointer-events:auto;font-family:sans-serif}
    .ar-toolbar{display:none;flex-direction:column;align-items:stretch;gap:2px;padding:5px;min-width:158px;max-height:calc(100vh - 16px);overflow:auto;background:var(--ar-bg);border:1px solid var(--ar-border);border-radius:12px;box-shadow:var(--ar-shadow)}
    .ar-toolbar.open{display:flex}
    .ar-tb-btn{border:0;background:none;color:var(--ar-fg);text-align:left;cursor:pointer;font-size:13px;font-weight:600;padding:7px 10px;border-radius:8px;white-space:nowrap}
    .ar-tb-sep{height:1px;background:var(--ar-border);margin:3px 4px}
    .ar-icon{display:inline-block;width:1.15em;height:1.15em;flex:none;vertical-align:-0.19em;fill:currentColor;pointer-events:none}
    .ar-panel{display:none;flex-direction:column;width:384px;max-height:70vh;background:var(--ar-bg);color:var(--ar-fg);border:1px solid var(--ar-border);border-radius:16px;box-shadow:var(--ar-shadow);overflow:hidden;font-size:14px}
    .ar-panel.open{display:flex}
    .ar-resize{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;color:var(--ar-muted);opacity:.65;touch-action:none}
  `;

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* Some sites enforce Trusted Types / strict CSP which makes innerHTML throw.
   * Fall back to plain text so the panel still shows something useful. */
  function setHtml(node, html) {
    if (!node) return;
    try {
      node.innerHTML = html;
    } catch (e) {
      node.textContent = String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  async function ensureUi() {
    if (host) return;

    host = document.createElement(HOST_TAG);
    host.id = "active-reader-root";
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = await loadCss();
    shadow.appendChild(style);

    /* toolbar */
    toolbarEl = mk("div", "ar-toolbar");
    toolbarEl.setAttribute("role", "toolbar");
    toolbarEl.setAttribute("aria-label", "ActiveReader");
    toolbarEl.setAttribute("aria-orientation", "vertical");
    [
      ["translate", "Translate", "Translate selection"],
      ["speak", "Listen", "Listen to selection"],
      ["quiz", "Quiz", "Quiz me on selection"],
      ["__sep", "", ""],
      ["save", "Save", "Save to vocabulary"],
      ["close", "Close", "Dismiss"]
    ].forEach(([action, label, title]) => {
      if (action === "__sep") {
        toolbarEl.appendChild(mk("span", "ar-tb-sep"));
        return;
      }
      const btn = mk("button", "ar-tb-btn", label);
      btn.type = "button";
      btn.dataset.action = action;
      btn.title = title;
      toolbarEl.appendChild(btn);
    });

    /* panel */
    panelEl = mk("div", "ar-panel");
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-label", "ActiveReader panel");

    const head = mk("div", "ar-head");
    head.setAttribute("data-drag", "true");
    const brand = mk("div", "ar-brand");
    brand.appendChild(mk("span", "ar-logo", "AR"));
    brand.appendChild(document.createTextNode(" ActiveReader "));
    badgeEl = mk("span", "ar-badge");
    brand.appendChild(badgeEl);
    head.appendChild(brand);
    head.appendChild(mk("div", "ar-head-spacer"));
    [
      ["disable-site", "block", "Disable ActiveReader on this site"],
      ["settings", "settings", "Open settings"],
      ["close", "close", "Close"]
    ].forEach(([action, icon, title]) => {
      const btn = mk("button", "ar-icon-btn");
      btn.type = "button";
      btn.dataset.action = action;
      btn.title = title;
      setHtml(btn, AR.icon(icon));
      head.appendChild(btn);
    });
    panelEl.appendChild(head);

    const tabs = mk("div", "ar-tabs");
    [
      ["translate", "Translate"],
      ["audio", "Audio"],
      ["quiz", "Quiz"]
    ].forEach(([key, label]) => {
      const btn = mk("button", "ar-tab", label);
      btn.type = "button";
      btn.dataset.tab = key;
      tabs.appendChild(btn);
    });
    panelEl.appendChild(tabs);

    selEl = mk("div", "ar-sel");
    panelEl.appendChild(selEl);

    bodyEl = mk("div", "ar-body");
    panelEl.appendChild(bodyEl);

    /* Corner grip used to resize the panel by dragging. */
    const resizeHandle = mk("div", "ar-resize");
    resizeHandle.title = "Drag to resize";
    resizeHandle.setAttribute("aria-hidden", "true");
    panelEl.appendChild(resizeHandle);

    shadow.appendChild(toolbarEl);
    shadow.appendChild(panelEl);

    toastEl = mk("div", "ar-toast");
    toastEl.setAttribute("role", "status");
    shadow.appendChild(toastEl);

    shadow.addEventListener("click", onShadowClick);
    shadow.addEventListener("mousedown", onShadowMouseDown);
    shadow.addEventListener("change", onShadowChange);
    shadow.addEventListener("input", onShadowInput);

    applyPanelSize();
    applyTheme();
    (document.documentElement || document.body).appendChild(host);
  }

  async function loadCss() {
    try {
      const url = chrome.runtime.getURL("src/content.css");
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch (e) {
      /* fall through */
    }
    return FALLBACK_CSS;
  }

  function applyTheme() {
    if (!host) return;
    const dark =
      settings.theme === "dark" ||
      (settings.theme === "auto" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    host.setAttribute("data-ar-theme", dark ? "dark" : "light");
    const accent = AR.ACCENTS[settings.panelAccent] || AR.ACCENTS.indigo;
    host.style.setProperty("--ar-accent", accent.a);
    host.style.setProperty("--ar-accent-2", accent.b);
  }

  /* Apply a saved panel size (from dragging the resize grip), clamped to the
   * current viewport. A zero means "use the default / fit the content". */
  function applyPanelSize() {
    if (!panelEl) return;
    const maxW = Math.max(PANEL_MIN_W, window.innerWidth - 24);
    const maxH = Math.max(PANEL_MIN_H, window.innerHeight - 24);
    const w = Number(settings.panelWidth) || 0;
    const h = Number(settings.panelHeight) || 0;

    if (w > 0) {
      panelEl.style.width = Math.round(clamp(w, PANEL_MIN_W, maxW)) + "px";
      panelEl.style.maxWidth = "none";
    } else {
      panelEl.style.width = "";
      panelEl.style.maxWidth = "";
    }

    if (h > 0) {
      panelEl.style.height = Math.round(clamp(h, PANEL_MIN_H, maxH)) + "px";
      panelEl.style.maxHeight = "none";
    } else {
      panelEl.style.height = "";
      panelEl.style.maxHeight = "";
    }
  }

  /* -------------------------------------------------------- selection */

  function onSelectionEvent(e) {
    if (isInsideUi(e)) return;
    setTimeout(() => {
      const info = getSelectionInfo();
      if (!info || info.text.length < (settings.minSelectionLength || 1)) {
        hideToolbar();
        return;
      }

      if (current.text !== info.text) resetForText(info.text);
      current.text = info.text;
      current.rect = info.rect;

      if (settings.showToolbar && !isDisabledSite()) showToolbar();
      else hideToolbar();
    }, 0);
  }

  /* Returns { text, rect } for the current selection — including selections
   * inside input/textarea elements, which window.getSelection() does not see. */
  function getSelectionInfo() {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        const text = String(active.value || "").slice(start, end).trim();
        if (text) return { text, rect: normRect(active.getBoundingClientRect()) };
      }
    }

    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!text) return null;

    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (err) {
      rect = null;
    }
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect: normRect(rect) };
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && panelEl && panelEl.classList.contains("open")) {
      closePanel();
    }
  }

  /* Hide the toolbar on page scroll, but not when scrolling inside our panel. */
  function onWindowScroll(e) {
    if (isInsideUi(e)) return;
    hideToolbar();
  }

  function isInsideUi(e) {
    if (!host) return false;
    const path = typeof e.composedPath === "function" ? e.composedPath() : null;
    if (path && path.indexOf(host) !== -1) return true;
    const t = e.target;
    return t === host || (t && t.getRootNode && t.getRootNode() === shadow);
  }

  function isDisabledSite() {
    const hostname = (location.hostname || "").toLowerCase();
    if (!hostname) return false;
    return (settings.disabledSites || []).some((site) => {
      const s = String(site || "")
        .toLowerCase()
        .replace(/^\*\./, "")
        .replace(/^\./, "");
      return s && (hostname === s || hostname.endsWith("." + s));
    });
  }

  function resetForText(text) {
    selectionToken++;
    state.translation = { status: "idle", text: "", detected: "", engine: "", error: "" };
    state.audio = { status: "idle", provider: "" };
    /* The quiz is intentionally kept: highlighting a new phrase (for example
     * to translate a word) should not throw away a quiz the reader already
     * generated. It is replaced only when a new quiz is generated. */
    current.text = text;
    current.saved = false;
  }

  function normRect(r) {
    return {
      top: r.top,
      left: r.left,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height
    };
  }

  function defaultRect() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return { top: h / 3, left: w / 2, right: w / 2, bottom: h / 3, width: 0, height: 0 };
  }

  function showToolbar() {
    if (!toolbarEl) return;
    toolbarEl.classList.add("open");
    const r = current.rect || defaultRect();
    const w = toolbarEl.offsetWidth || 180;
    const h = toolbarEl.offsetHeight || 40;
    let left = r.left + r.width / 2 - w / 2;
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    left = clamp(left, 8, Math.max(8, window.innerWidth - w - 8));
    top = clamp(top, 8, Math.max(8, window.innerHeight - h - 8));
    toolbarEl.style.left = Math.round(left) + "px";
    toolbarEl.style.top = Math.round(top) + "px";
  }

  function hideToolbar() {
    if (toolbarEl) toolbarEl.classList.remove("open");
  }

  /* ------------------------------------------------------------- panel */

  function openPanel(reposition) {
    if (!panelEl) return;
    /* Only place the panel next to the selection when it first opens. Once it
     * is open (and possibly dragged somewhere else by the reader), keep it put
     * so translating another phrase does not yank it around the page. */
    const wasOpen = panelEl.classList.contains("open");
    hideToolbar();
    panelEl.classList.add("open");
    pendingReposition = !!reposition && !wasOpen;
    render();
  }

  function closePanel() {
    if (panelEl) panelEl.classList.remove("open");
  }

  function setTab(next) {
    tab = next;
    render();
  }

  function render() {
    if (!shadow) return;
    const scroll = bodyEl ? bodyEl.scrollTop : 0;

    shadow.querySelectorAll(".ar-tab").forEach((el) => {
      const active = el.dataset.tab === tab;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
    });

    if (toolbarEl) {
      const saveBtn = toolbarEl.querySelector('[data-action="save"]');
      if (saveBtn) {
        saveBtn.classList.toggle("is-active", !!current.saved);
        saveBtn.textContent = current.saved ? "Saved" : "Save";
      }
    }

    if (selEl) {
      const preview = current.text + (isTruncated() ? " …" : "");
      if (tab === "translate" && current.text) {
        setHtml(
          selEl,
          `<div class="ar-sel-row"><span class="ar-sel-text">${AR.escapeHtml(preview)}</span>` +
            `<button class="ar-speak" type="button" data-action="speak-original" title="Listen to the original" aria-label="Listen to the original">${AR.icon(
              "volume_up"
            )}</button></div>`
        );
      } else {
        selEl.textContent = preview;
      }
    }
    if (badgeEl) badgeEl.textContent = AR.langLabel(settings.targetLang);

    if (bodyEl) {
      if (tab === "translate") setHtml(bodyEl, htmlTranslate());
      else if (tab === "audio") setHtml(bodyEl, htmlAudio());
      else setHtml(bodyEl, htmlQuiz());
    }

    if (tab === "quiz") syncQuizControls();
    if (bodyEl) bodyEl.scrollTop = scroll;

    if (pendingReposition) {
      pendingReposition = false;
      positionPanel();
    }
  }

  function positionPanel() {
    if (!panelEl) return;
    const r = current.rect || defaultRect();
    const w = panelEl.offsetWidth || 384;
    const h = panelEl.offsetHeight || 420;

    let left = r.right + 14;
    if (left + w > window.innerWidth - 12) left = r.left - w - 14;
    if (left < 12) left = clamp(r.left - w / 2, 12, Math.max(12, window.innerWidth - w - 12));

    const maxTop = Math.max(12, window.innerHeight - h - 12);
    const top = clamp(r.top - 8, 12, maxTop);

    panelEl.style.left = Math.round(left) + "px";
    panelEl.style.top = Math.round(top) + "px";
  }

  function isTruncated() {
    return (current.text || "").length > (settings.maxSelectionLength || 2000);
  }

  function limitText(text) {
    const max = settings.maxSelectionLength || 2000;
    const t = String(text || "");
    return t.length > max ? t.slice(0, max) : t;
  }

  function quizText() {
    const t = String(current.text || "");
    return t.length > MAX_QUIZ_CHARS ? t.slice(0, MAX_QUIZ_CHARS) : t;
  }

  function isQuizTruncated() {
    return (current.text || "").length > MAX_QUIZ_CHARS;
  }

  /* Bounded FIFO cache: keeps the newest `max` entries. */
  function cacheSet(map, key, value, max) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  function translateKey(text) {
    return settings.baseLang + "\u0000" + settings.translationEngine + "\u0000" + text;
  }

  function quizKey(text, cfg) {
    return JSON.stringify([
      settings.targetLang,
      settings.baseLang,
      !!settings.quizExplain,
      cfg.difficulty,
      cfg.count,
      (cfg.types || []).slice().sort(),
      cfg.quizLanguage,
      text
    ]);
  }

  /* ------------------------------------------------- translate tab html */

  function htmlTranslate() {
    const t = state.translation;
    let out;

    if (t.status === "loading") {
      out = `<div class="ar-loading"><span class="ar-spinner"></span> Translating…</div>`;
    } else if (t.status === "error") {
      out = `<div class="ar-error">${AR.escapeHtml(t.error)}</div>`;
    } else if (t.status === "done") {
      const rtl = AR.isRtl(settings.baseLang) ? " rtl" : "";
      out = `
        <div class="ar-trans-actions">
          <button class="ar-speak" type="button" data-action="speak-translation" title="Listen to the translation" aria-label="Listen to the translation">${AR.icon(
            "volume_up"
          )}</button>
        </div>
        <div class="ar-result${rtl}">${AR.escapeHtml(t.text)}</div>
        <div class="ar-meta">
          ${t.detected ? "Detected: " + AR.escapeHtml(AR.langLabel(t.detected)) + " · " : ""}
          ${t.engine === "gemini" ? "Gemini" : "Google Translate"} · Into ${AR.escapeHtml(
            AR.langLabel(settings.baseLang)
          )}
        </div>`;
    } else {
      out = `<div class="ar-hint">Translate the highlighted text into <b>${AR.escapeHtml(
        AR.langLabel(settings.baseLang)
      )}</b>.</div>`;
    }

    return `
      <div class="ar-row">
        <button class="ar-btn primary" data-action="translate">${AR.icon("translate")} Translate</button>
        ${t.status === "done" ? `<button class="ar-btn" data-action="copy">${AR.icon("content_copy")} Copy</button>` : ""}
        <button class="ar-btn" data-action="save">${AR.icon(current.saved ? "star_fill" : "star")} ${
          current.saved ? "Saved" : "Save"
        }</button>
      </div>
      ${out}
      ${isTruncated() ? `<div class="ar-hint">Only the first ${settings.maxSelectionLength} characters were sent.</div>` : ""}
    `;
  }

  /* ----------------------------------------------------- audio tab html */

  function htmlAudio() {
    const a = state.audio;
    const playing = a.status === "playing";
    const provider = a.provider || settings.ttsProvider;
    const providerLabel = provider === "google" ? "Google Translate voice" : "Browser voice";

    return `
      <div class="ar-audio-disc">
        <div class="ar-disc ${playing ? "playing" : ""}">${AR.icon(playing ? "graphic_eq" : "headphones")}</div>
        <div>
          <div style="font-weight:600">Listen to the selection</div>
          <div class="ar-meta" style="margin-top:2px">Voice: ${providerLabel}</div>
        </div>
      </div>

      <div class="ar-row" style="margin-top:12px">
        <button class="ar-btn primary" data-action="play">${AR.icon(playing ? "replay" : "play_arrow")} ${
          playing ? "Replay" : "Play"
        }</button>
        <button class="ar-btn" data-action="stop">${AR.icon("stop")} Stop</button>
      </div>

      ${a.status === "failed" ? `<div class="ar-error" style="margin-top:12px">Google Translate TTS was unavailable, so the browser voice was used instead.</div>` : ""}
      ${a.status === "error" ? `<div class="ar-error" style="margin-top:12px">Audio playback failed. Try the browser voice in settings.</div>` : ""}

      <div class="ar-hint">Playing with the <b>${AR.escapeHtml(
        AR.langLabel(settings.targetLang)
      )}</b> voice. Change the provider, speed or pitch in settings.</div>
      ${isTruncated() ? `<div class="ar-hint">Only the first ${settings.maxSelectionLength} characters were played.</div>` : ""}
    `;
  }

  /* ------------------------------------------------------ quiz tab html */

  function ensureQuizConfig() {
    if (!state.quiz.config) {
      state.quiz.config = {
        difficulty: settings.quizDifficulty,
        count: settings.quizCount,
        types: (settings.quizTypes || []).slice(),
        quizLanguage: settings.quizLanguage
      };
    }
    return state.quiz.config;
  }

  function htmlQuiz() {
    const cfg = ensureQuizConfig();
    const hasQuestions = state.quiz.questions.length > 0;

    let body = "";
    if (state.quiz.status === "loading") {
      body = `<div class="ar-loading"><span class="ar-spinner"></span> Writing your quiz…</div>`;
    } else if (state.quiz.status === "error") {
      body = `<div class="ar-error">${AR.escapeHtml(state.quiz.error)}</div>`;
    } else if (state.quiz.status === "done") {
      body = state.quiz.questions.map((q, i) => htmlQuestion(q, i)).join("");
    } else {
      body = `<div class="ar-hint">Gemini will write comprehension questions about the highlighted text. Answers and explanations are shown as you go.</div>`;
    }

    const controls = `
      <div class="ar-grid2">
        <label class="ar-field">Difficulty
          <select data-quiz="difficulty">
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label class="ar-field">Questions
          <input type="number" min="1" max="10" data-quiz="count" />
        </label>
      </div>
      <label class="ar-field" style="margin-top:10px">Question language
        <select data-quiz="quizLanguage">
          <option value="target">Target language only</option>
          <option value="base">My language only</option>
          <option value="both">Both</option>
        </select>
      </label>
      <div class="ar-checks">
        ${AR.QUIZ_TYPES
          .map(
            (t) =>
              `<label class="ar-check"><input type="checkbox" data-quiz="type" value="${t}" ${
                cfg.types.indexOf(t) !== -1 ? "checked" : ""
              }/> ${AR.QUIZ_TYPE_LABELS[t]}</label>`
          )
          .join("")}
      </div>
      <div class="ar-row" style="margin-top:12px">
        <button class="ar-btn primary" data-action="quiz-generate">${
          hasQuestions ? AR.icon("refresh") + " New quiz" : AR.icon("auto_awesome") + " Generate quiz"
        }</button>
        ${
          hasQuestions
            ? `<button class="ar-btn" data-action="quiz-reveal-all">${AR.icon("visibility")} Reveal all</button>`
            : ""
        }
      </div>
    `;

    const truncNote = isQuizTruncated()
      ? `<div class="ar-hint">Only the first ${MAX_QUIZ_CHARS} characters were sent to Gemini.</div>`
      : "";

    const shortNote =
      hasQuestions && state.quiz.requested && state.quiz.questions.length < state.quiz.requested
        ? `<div class="ar-hint">Gemini returned ${state.quiz.questions.length} of ${state.quiz.requested} questions. Press <b>New quiz</b> to try for more.</div>`
        : "";

    const staleNote =
      hasQuestions && state.quiz.text && state.quiz.text !== quizText()
        ? `<div class="ar-hint">Showing your last quiz, for a previous selection. Press <b>New quiz</b> to use the current text.</div>`
        : "";

    return controls + truncNote + shortNote + staleNote + body;
  }

  function htmlQuestion(q, i) {
    const revealed = !!state.quiz.revealed[i];
    const checked = !!state.quiz.checked[i];
    let inner = "";

    if (q.type === "mcq") {
      const picked = state.quiz.picked[i];
      inner =
        `<div class="ar-options">` +
        q.options
          .map((opt, j) => {
            let cls = "";
            if (revealed) {
              if (j === q.answerIndex) cls = "correct";
              else if (j === picked) cls = "wrong";
            }
            return `<button class="ar-option ${cls}" data-action="pick" data-q="${i}" data-opt="${j}" ${
              revealed ? "disabled" : ""
            }>${String.fromCharCode(65 + j)}. ${AR.escapeHtml(opt)}</button>`;
          })
          .join("") +
        `</div>`;
    } else {
      const entered = state.quiz.entered[i] || "";
      const grading = !!state.quiz.grading[i];
      const grade = state.quiz.grades[i];
      const isCorrect = grade ? !!grade.correct : normalizeAnswer(entered) === normalizeAnswer(q.answer);
      const feedback = (grade && grade.feedback) || "";
      inner = `
        <input class="ar-answer-input" type="text" data-action="answer-input" data-q="${i}"
          placeholder="${q.type === "blank" ? "Fill in the blank…" : "Type your answer…"}"
          value="${AR.escapeHtml(entered)}" ${revealed || grading ? "disabled" : ""} />
        <div class="ar-actions">
          ${!revealed && !grading ? `<button class="ar-btn primary" data-action="check" data-q="${i}">Check</button>` : ""}
          ${!revealed && !grading ? `<button class="ar-btn" data-action="reveal" data-q="${i}">Show answer</button>` : ""}
        </div>
        ${
          grading
            ? `<div class="ar-loading"><span class="ar-spinner"></span> Checking your answer…</div>`
            : revealed
            ? checked
              ? `<div class="ar-verdict ${isCorrect ? "ok" : "no"}">${
                  isCorrect
                    ? AR.icon("check_circle") + " Correct"
                    : AR.icon("cancel") + " Answer: " + AR.escapeHtml(q.answer)
                }</div>`
              : `<div class="ar-verdict" style="color:var(--ar-muted)">${AR.icon(
                  "lightbulb"
                )} Answer: ${AR.escapeHtml(q.answer)}</div>`
            : ""
        }
        ${feedback ? `<div class="ar-explain">${AR.icon("auto_awesome")} ${AR.escapeHtml(feedback)}</div>` : ""}
      `;
    }

    return `
      <div class="ar-qcard">
        <span class="ar-qtype">${AR.QUIZ_TYPE_LABELS[q.type] || q.type}</span>
        <div class="ar-qtext">${i + 1}. ${AR.escapeHtml(q.question)}</div>
        ${htmlQuestionTranslation(i, q)}
        ${inner}
        ${
          revealed && q.explanation
            ? `<div class="ar-explain">${AR.escapeHtml(q.explanation)}</div>`
            : ""
        }
      </div>
    `;
  }

  /* Translate button + result shown under a quiz question. Uses the same
   * translation engine/cache as the Translate tab, into the learner's own
   * language (baseLang). */
  function htmlQuestionTranslation(i, q) {
    const t = state.quiz.translations[i];
    const rtl = AR.isRtl(settings.baseLang) ? " rtl" : "";

    let out = "";
    if (!t || t.status === "error") {
      out =
        `<button class="ar-qtrans" data-action="translate-question" data-q="${i}">` +
        AR.icon("translate") +
        ` Translate question</button>`;
    }
    if (t && t.status === "loading") {
      out += `<div class="ar-loading"><span class="ar-spinner"></span> Translating…</div>`;
    }
    if (t && t.status === "error") {
      out += `<div class="ar-error">${AR.escapeHtml(t.error)}</div>`;
    }
    if (t && t.status === "done") {
      const translated = String(t.text || "");
      const same = translated.trim().toLowerCase() === String(q.question || "").trim().toLowerCase();
      out += same
        ? `<div class="ar-hint">Already in ${AR.escapeHtml(AR.langLabel(settings.baseLang))}.</div>`
        : `<div class="ar-qtranslation${rtl}">${AR.escapeHtml(translated)}</div>`;
    }
    return out;
  }

  function syncQuizControls() {
    if (!bodyEl) return;
    const cfg = ensureQuizConfig();
    const d = bodyEl.querySelector('[data-quiz="difficulty"]');
    const c = bodyEl.querySelector('[data-quiz="count"]');
    const l = bodyEl.querySelector('[data-quiz="quizLanguage"]');
    if (d) d.value = cfg.difficulty;
    if (c) c.value = cfg.count;
    if (l) l.value = cfg.quizLanguage;
  }

  function normalizeAnswer(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[.!?,;:¡¿"']/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ------------------------------------------------------------ actions */

  function openTranslate() {
    tab = "translate";
    openPanel(true);
    if (state.translation.status === "idle") runTranslate();
  }

  function openSpeak() {
    tab = "audio";
    openPanel(true);
    runSpeak();
  }

  function openQuiz() {
    tab = "quiz";
    openPanel(true);
  }

  async function runTranslate() {
    const text = limitText(current.text);
    if (!text || state.translation.status === "loading") return;

    const key = translateKey(text);
    const cached = translateCache.get(key);
    if (cached) {
      state.translation = { status: "done", text: cached.translation, detected: cached.detected, engine: cached.engine, error: "" };
      render();
      if (settings.autoSaveLookups) saveCurrent(false);
      return;
    }

    const token = selectionToken;
    state.translation = { status: "loading", text: "", detected: "", engine: "", error: "" };
    render();

    const res = await send({
      type: MSG.TRANSLATE,
      text,
      baseLang: settings.baseLang,
      engine: settings.translationEngine
    });

    // A newer selection appeared while we were waiting — drop this result.
    if (token !== selectionToken) return;

    if (!res) {
      state.translation = { status: "error", error: "No response from the extension. Reload the page and try again.", text: "", detected: "", engine: "" };
    } else if (res.ok) {
      state.translation = {
        status: "done",
        text: res.translation,
        detected: res.detected || "",
        engine: res.engine || "",
        error: ""
      };
      cacheSet(
        translateCache,
        key,
        { translation: state.translation.text, detected: state.translation.detected, engine: state.translation.engine },
        AR.CACHE.TRANSLATION_MAX
      );
      if (settings.autoSaveLookups) saveCurrent(false);
    } else {
      state.translation = { status: "error", error: res.error || "Translation failed.", text: "", detected: "", engine: "" };
    }
    render();
  }

  async function runSpeak(text, lang) {
    const value = limitText(text == null ? current.text : text);
    if (!value) return;
    const useLang = lang || settings.targetLang;

    state.audio = { status: "playing", provider: settings.ttsProvider };
    if (tab === "audio") render();

    const res = await send({
      type: MSG.TTS,
      text: value,
      lang: useLang,
      provider: settings.ttsProvider
    });

    if (res && res.ok) {
      state.audio = { status: "playing", provider: res.provider || settings.ttsProvider };
    } else {
      state.audio = { status: "error", provider: "" };
      toast((res && res.error) || "Could not play audio");
    }
    if (tab === "audio") render();
  }

  async function stopSpeak() {
    state.audio = { status: "idle", provider: "" };
    if (tab === "audio") render();
    await send({ type: MSG.TTS_STOP });
  }

  async function runQuiz(force) {
    const text = quizText();
    if (!text || state.quiz.status === "loading") return;
    const cfg = ensureQuizConfig();

    if (!cfg.types.length) {
      state.quiz.status = "error";
      state.quiz.error = "Pick at least one question type.";
      render();
      return;
    }

    const key = quizKey(text, cfg);
    if (!force) {
      const cached = quizCache.get(key);
      if (cached) {
        resetQuizAnswers();
        state.quiz.status = "done";
        state.quiz.error = "";
        state.quiz.questions = cached;
        state.quiz.requested = cached.length;
        state.quiz.text = text;
        render();
        return;
      }
    }

    const token = selectionToken;
    resetQuizAnswers();
    state.quiz.status = "loading";
    state.quiz.error = "";
    render();

    const res = await send({
      type: MSG.QUIZ,
      text,
      config: {
        types: cfg.types,
        difficulty: cfg.difficulty,
        count: cfg.count,
        quizLanguage: cfg.quizLanguage,
        explain: settings.quizExplain
      }
    });

    // The selection changed while we were waiting — drop this result and fall
    // back to whatever quiz (if any) was already showing.
    if (token !== selectionToken) {
      state.quiz.status = state.quiz.questions.length ? "done" : "idle";
      if (tab === "quiz") render();
      return;
    }

    if (!res) {
      state.quiz.status = "error";
      state.quiz.error = "No response from the extension. Reload the page and try again.";
    } else if (res.ok) {
      state.quiz.status = "done";
      state.quiz.questions = res.questions || [];
      state.quiz.requested = res.requested || cfg.count || state.quiz.questions.length;
      state.quiz.text = text;
      cacheSet(quizCache, key, state.quiz.questions, AR.CACHE.QUIZ_MAX);
    } else {
      state.quiz.status = "error";
      state.quiz.error = res.error || "Could not generate a quiz.";
    }
    render();
  }

  function resetQuizAnswers() {
    state.quiz.revealed = {};
    state.quiz.checked = {};
    state.quiz.picked = {};
    state.quiz.entered = {};
    state.quiz.grading = {};
    state.quiz.grades = {};
    state.quiz.translations = {};
  }

  /* Free-response answers are graded by Gemini so that equivalent wording and
   * small typos still count, and so the learner gets feedback in their own
   * language. If Gemini is unavailable we fall back to a plain string match. */
  async function gradeAnswer(i, q, userAnswer) {
    state.quiz.grading[i] = true;
    render();

    const token = selectionToken;
    const res = await send({
      type: MSG.GRADE,
      question: q.question,
      answer: q.answer,
      userAnswer,
      qType: q.type,
      text: quizText()
    });

    // A newer selection appeared while we were waiting — drop this result but
    // clear the "checking" flag so the question is not stuck spinning.
    if (token !== selectionToken) {
      delete state.quiz.grading[i];
      if (tab === "quiz") render();
      return;
    }

    delete state.quiz.grading[i];
    state.quiz.revealed[i] = true;
    state.quiz.checked[i] = true;

    if (res && res.ok) {
      state.quiz.grades[i] = { correct: !!res.correct, feedback: res.feedback || "" };
    } else {
      state.quiz.grades[i] = {
        correct: normalizeAnswer(userAnswer) === normalizeAnswer(q.answer),
        feedback: ""
      };
      toast((res && res.error) || "Could not reach Gemini — checked automatically");
    }
    render();
  }

  /* Translate a single quiz question into the learner's own language. Shares
   * the translation cache with the Translate tab so repeats are instant. */
  async function translateQuestion(i) {
    const q = state.quiz.questions[i];
    if (!q) return;
    const existing = state.quiz.translations[i];
    if (existing && existing.status === "loading") return;

    const text = String(q.question || "").trim();
    if (!text) return;

    const key = translateKey(text);
    const cached = translateCache.get(key);
    if (cached) {
      state.quiz.translations[i] = { status: "done", text: cached.translation, error: "" };
      render();
      return;
    }

    const token = selectionToken;
    state.quiz.translations[i] = { status: "loading", text: "", error: "" };
    render();

    const res = await send({
      type: MSG.TRANSLATE,
      text,
      baseLang: settings.baseLang,
      engine: settings.translationEngine
    });

    // A newer selection appeared while we were waiting — drop this result but
    // clear the "translating" flag so the button comes back.
    if (token !== selectionToken) {
      delete state.quiz.translations[i];
      if (tab === "quiz") render();
      return;
    }

    if (res && res.ok) {
      state.quiz.translations[i] = { status: "done", text: res.translation, error: "" };
      cacheSet(
        translateCache,
        key,
        { translation: res.translation, detected: res.detected || "", engine: res.engine || "" },
        AR.CACHE.TRANSLATION_MAX
      );
    } else {
      state.quiz.translations[i] = {
        status: "error",
        text: "",
        error: (res && res.error) || "Translation failed."
      };
    }
    render();
  }

  async function saveCurrent(withToast) {
    const text = String(current.text || "").trim();
    if (!text) return;

    const res = await send({
      type: MSG.SAVE,
      entry: {
        text,
        translation: state.translation.status === "done" ? state.translation.text : "",
        lang: settings.targetLang,
        baseLang: settings.baseLang,
        sourceTitle: document.title,
        url: location.href
      }
    });

    if (res && res.ok) {
      current.saved = true;
      toast(withToast ? "Saved to vocabulary" : "Auto-saved to vocabulary", withToast ? "star_fill" : "");
      render();
    } else if (withToast) {
      toast((res && res.error) || "Could not save");
    }
  }

  async function disableSite() {
    const hostname = location.hostname || "";
    if (!hostname) return;
    const list = (settings.disabledSites || []).slice();
    if (list.indexOf(hostname) === -1) list.push(hostname);
    settings.disabledSites = list;
    await AR.saveSettings({ disabledSites: list });
    hideToolbar();
    closePanel();
    toast("ActiveReader disabled on this site");
  }

  function copyTranslation() {
    if (state.translation.status !== "done") return;
    copyText(state.translation.text);
  }

  function copyText(text) {
    const value = String(text || "");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(
          () => toast("Copied"),
          () => fallbackCopy(value)
        );
        return;
      }
    } catch (e) {
      /* fall through */
    }
    fallbackCopy(value);
  }

  function fallbackCopy(value) {
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Copied");
    } catch (e) {
      toast("Copy failed");
    }
  }

  /* ------------------------------------------------------------- events */

  function onShadowClick(e) {
    const tabBtn = e.target.closest(".ar-tab");
    if (tabBtn) {
      setTab(tabBtn.dataset.tab);
      return;
    }

    const el = e.target.closest("[data-action]");
    if (!el) return;

    const action = el.dataset.action;
    switch (action) {
      case "close":
        hideToolbar();
        closePanel();
        break;
      case "settings":
        send({ type: MSG.OPEN_OPTIONS });
        break;
      case "disable-site":
        disableSite();
        break;
      case "translate":
        openTranslate();
        break;
      case "copy":
        copyTranslation();
        break;
      case "save":
        saveCurrent(true);
        break;
      case "speak":
      case "play":
        openSpeak();
        break;
      case "speak-original":
        runSpeak(current.text, settings.targetLang);
        break;
      case "speak-translation":
        if (state.translation.status === "done") runSpeak(state.translation.text, settings.baseLang);
        break;
      case "stop":
        stopSpeak();
        break;
      case "quiz":
        openQuiz();
        break;
      case "quiz-generate":
        runQuiz(state.quiz.questions.length > 0);
        break;
      case "quiz-reveal-all":
        state.quiz.questions.forEach((_, i) => {
          state.quiz.revealed[i] = true;
        });
        render();
        break;
      case "pick": {
        const i = Number(el.dataset.q);
        state.quiz.picked[i] = Number(el.dataset.opt);
        state.quiz.revealed[i] = true;
        state.quiz.checked[i] = true;
        render();
        break;
      }
      case "check": {
        const i = Number(el.dataset.q);
        const entered = (state.quiz.entered[i] || "").trim();
        if (!entered) {
          toast("Type an answer first");
          break;
        }
        const q = state.quiz.questions[i];
        if (!q) break;
        if (q.type === "mcq") {
          state.quiz.revealed[i] = true;
          state.quiz.checked[i] = true;
          render();
          break;
        }
        gradeAnswer(i, q, entered);
        break;
      }
      case "reveal": {
        const i = Number(el.dataset.q);
        state.quiz.revealed[i] = true;
        render();
        break;
      }
      case "translate-question": {
        const i = Number(el.dataset.q);
        translateQuestion(i);
        break;
      }
      default:
        break;
    }
  }

  function onShadowMouseDown(e) {
    if (e.target.closest(".ar-resize")) {
      beginResize(e);
      return;
    }
    if (e.target.closest(".ar-toolbar, .ar-head, .ar-tabs, .ar-tab")) {
      e.preventDefault();
    }
    if (e.target.closest("[data-drag]") && !e.target.closest(".ar-icon-btn")) {
      beginDrag(e);
    }
  }

  function onShadowChange(e) {
    const field = e.target.closest("[data-quiz]");
    if (!field) return;
    const key = field.dataset.quiz;
    const cfg = ensureQuizConfig();

    if (key === "type") {
      cfg.types = Array.from(bodyEl.querySelectorAll('[data-quiz="type"]:checked')).map((x) => x.value);
    } else if (key === "count") {
      cfg.count = Math.max(1, Math.min(10, Number(field.value) || 5));
      field.value = cfg.count;
    } else if (key === "difficulty") {
      cfg.difficulty = field.value;
    } else if (key === "quizLanguage") {
      cfg.quizLanguage = field.value;
    }
  }

  function onShadowInput(e) {
    const field = e.target.closest('[data-action="answer-input"]');
    if (field) state.quiz.entered[field.dataset.q] = field.value;
  }

  function beginDrag(e) {
    if (!panelEl) return;
    const r = panelEl.getBoundingClientRect();
    dragState = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", endDrag, true);
  }

  function onDragMove(e) {
    if (!dragState || !panelEl) return;
    const w = panelEl.offsetWidth;
    const h = panelEl.offsetHeight;
    const left = clamp(e.clientX - dragState.dx, 4, Math.max(4, window.innerWidth - w - 4));
    const top = clamp(e.clientY - dragState.dy, 4, Math.max(4, window.innerHeight - h - 4));
    panelEl.style.left = Math.round(left) + "px";
    panelEl.style.top = Math.round(top) + "px";
  }

  function endDrag() {
    dragState = null;
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", endDrag, true);
  }

  /* --------------------------------------------------------------- resize */

  function beginResize(e) {
    if (!panelEl) return;
    const r = panelEl.getBoundingClientRect();
    resizeState = {
      x: e.clientX,
      y: e.clientY,
      w: r.width,
      h: r.height,
      left: r.left,
      top: r.top
    };
    /* Pin the current size, then lift the CSS caps so the panel can grow
     * beyond its defaults. Pinning first avoids a jump on a bare click. */
    panelEl.style.width = Math.round(r.width) + "px";
    panelEl.style.height = Math.round(r.height) + "px";
    panelEl.style.maxWidth = "none";
    panelEl.style.maxHeight = "none";
    e.preventDefault();
    e.stopPropagation();
    window.addEventListener("mousemove", onResizeMove, true);
    window.addEventListener("mouseup", endResize, true);
  }

  function onResizeMove(e) {
    if (!resizeState || !panelEl) return;
    const maxW = Math.max(PANEL_MIN_W, window.innerWidth - resizeState.left - 8);
    const maxH = Math.max(PANEL_MIN_H, window.innerHeight - resizeState.top - 8);
    const w = clamp(resizeState.w + (e.clientX - resizeState.x), PANEL_MIN_W, maxW);
    const h = clamp(resizeState.h + (e.clientY - resizeState.y), PANEL_MIN_H, maxH);
    panelEl.style.width = Math.round(w) + "px";
    panelEl.style.height = Math.round(h) + "px";
  }

  function endResize() {
    if (resizeState && panelEl) {
      AR.saveSettings({
        panelWidth: Math.round(panelEl.offsetWidth),
        panelHeight: Math.round(panelEl.offsetHeight)
      }).catch(() => {});
    }
    resizeState = null;
    window.removeEventListener("mousemove", onResizeMove, true);
    window.removeEventListener("mouseup", endResize, true);
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || !msg.type) return undefined;

    if (msg.type === MSG.PING) {
      sendResponse({ ok: true });
      return undefined;
    }
    if (msg.type === MSG.COMMAND) {
      handleCommand(msg);
      return undefined;
    }
    if (msg.type === MSG.TTS_STATE) {
      if (msg.state === "ended" || msg.state === "failed") {
        state.audio = { status: msg.state === "failed" ? "failed" : "ended", provider: state.audio.provider };
        if (tab === "audio" && panelEl && panelEl.classList.contains("open")) render();
      }
      return undefined;
    }
    return undefined;
  }

  async function handleCommand(msg) {
    settings = await AR.getSettings();

    const info = getSelectionInfo();
    const text = String(msg.text || "").trim() || (info ? info.text : "");
    if (!text) return;

    if (current.text !== text) resetForText(text);
    current.text = text;
    current.rect = info && info.text === text ? info.rect : defaultRect();

    if (msg.command === "translate") openTranslate();
    else if (msg.command === "speak") openSpeak();
    else if (msg.command === "quiz") openQuiz();
    else if (msg.command === "save") saveCurrent(true);
  }

  function onStorageChanged(changes, area) {
    if (area !== "sync") return;
    AR.getSettings().then((next) => {
      settings = next;
      applyTheme();
      applyPanelSize();
      if (isDisabledSite()) {
        hideToolbar();
        closePanel();
      }
    });
  }

  /* -------------------------------------------------------------- toast */

  function toast(message, icon) {
    if (!toastEl) return;
    setHtml(toastEl, (icon ? AR.icon(icon) + " " : "") + AR.escapeHtml(message));
    toastEl.classList.add("open");
    positionToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("open"), 2200);
  }

  function positionToast() {
    if (!toastEl) return;
    toastEl.style.left = "50%";
    toastEl.style.bottom = "28px";
    toastEl.style.top = "auto";
    toastEl.style.transform = "translateX(-50%)";
  }

  /* ------------------------------------------------------------- helpers */

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /* Thin alias over the shared helper in config.js. */
  function send(message) {
    return AR.sendMessage(message);
  }
})();
