/*
 * ActiveReader content script.
 *
 * Injects a small shadow-DOM toolbar whenever the user highlights text, plus a
 * panel with Translate / Quiz tabs. All heavy lifting (network calls)
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
  let selLabelEl = null;
  let selEl = null;
  let badgeEl = null;
  let toastEl = null;

  let tab = "translate";
  let pendingReposition = false;
  let toastTimer = null;
  let dragState = null;
  let resizeState = null;

  /* Click-a-word popup state. One popup element, reused for every word. */
  let defineEl = null;
  let defineToken = 0;
  let defineTarget = null; // { word, x, y } the popup is anchored to
  /* The word from the previous click. Definitions open on the second click
   * on the same word, so a stray click while reading does not pop anything up. */
  let pendingWordClick = null; // { node, word, start }
  /* Small per-page cache so re-clicking a word does not re-hit the network. */
  const defineCache = new Map();

  /* Bumped whenever the highlighted text changes, so responses that arrive
   * after the user selected something else are discarded. */
  let selectionToken = 0;

  /* Small per-page caches so re-opening the panel does not re-hit the network. */
  const translateCache = new Map();
  const quizCache = new Map();

  const current = { text: "", rect: null, saved: false };

  const state = {
    translation: { status: "idle", text: "", detected: "", engine: "", error: "" },
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
    document.addEventListener("click", onWordClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onWindowScroll, true);
    window.addEventListener("resize", () => {
      hideToolbar();
      hideDefine();
    });
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
    .ar-sel{margin:10px 12px 0;padding:8px 10px;background:var(--ar-bg-2);border:1px solid var(--ar-border);border-radius:10px;flex:0 1 auto;min-height:40px;overflow:auto;font-size:15px;white-space:pre-wrap;word-break:break-word}
    .ar-body{flex:1 1 auto;padding:12px;overflow:auto}
    .ar-body[data-tab="translate"]{display:flex;flex-direction:column;overflow:hidden}
    .ar-body[data-tab="translate"]>*{flex:none}
    .ar-body[data-tab="translate"]>.ar-result{flex:1 1 auto;overflow:auto}
    .ar-result{margin-top:12px;padding:12px;border-radius:12px;background:var(--ar-bg-2);border:1px solid var(--ar-border);font-size:15px;line-height:1.6;white-space:pre-wrap;word-break:break-word;min-height:54px}
    .ar-resize-handle{position:absolute;touch-action:none;background:transparent}
    .ar-resize-handle[data-dir="n"]{top:0;left:10px;right:10px;height:6px;cursor:ns-resize;z-index:5}
    .ar-resize-handle[data-dir="s"]{bottom:0;left:10px;right:10px;height:6px;cursor:ns-resize;z-index:5}
    .ar-resize-handle[data-dir="w"]{left:0;top:10px;bottom:10px;width:6px;cursor:ew-resize;z-index:5}
    .ar-resize-handle[data-dir="e"]{right:0;top:10px;bottom:10px;width:6px;cursor:ew-resize;z-index:5}
    .ar-resize-handle[data-dir="nw"]{top:0;left:0;width:12px;height:12px;cursor:nwse-resize;z-index:6}
    .ar-resize-handle[data-dir="ne"]{top:0;right:0;width:12px;height:12px;cursor:nesw-resize;z-index:6}
    .ar-resize-handle[data-dir="sw"]{bottom:0;left:0;width:12px;height:12px;cursor:nesw-resize;z-index:6}
    .ar-resize-handle[data-dir="se"]{bottom:0;right:0;width:12px;height:12px;cursor:nwse-resize;z-index:6}
    .ar-define{position:fixed;display:none;pointer-events:auto;z-index:5;max-width:300px;padding:10px 12px;
      background:var(--ar-bg);color:var(--ar-fg);border:1px solid var(--ar-border);border-radius:12px;
      box-shadow:var(--ar-shadow);font-family:sans-serif;font-size:13px;line-height:1.45}
    .ar-define.open{display:block}
    .ar-define-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
    .ar-define-word{font-weight:700;font-size:14px;word-break:break-word}
    .ar-define-pos{flex:none;padding:1px 7px;border-radius:999px;background:var(--ar-field);color:var(--ar-muted);
      font-size:10.5px;font-weight:700;text-transform:uppercase}
    .ar-define-close{all:unset;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
      margin-left:auto;border-radius:6px;color:var(--ar-muted);cursor:pointer;font-size:12px}
    .ar-define-meaning{color:var(--ar-fg);white-space:pre-wrap;word-break:break-word}
    .ar-define-example{margin-top:6px;padding-left:8px;border-left:2px solid var(--ar-accent);color:var(--ar-muted);font-style:italic}
    .ar-define-note{margin-top:7px;font-size:11px;color:var(--ar-muted)}
    .ar-define-loading{display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--ar-muted);font-size:12.5px}
    .ar-define-loading .ar-spinner{width:13px;height:13px}
    .ar-define-error{margin-top:4px;color:var(--ar-danger);font-size:12.5px}
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
      ["disable-site", "block", "Turn ActiveReader off on this site"],
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
      ["quiz", "Quiz"]
    ].forEach(([key, label]) => {
      const btn = mk("button", "ar-tab", label);
      btn.type = "button";
      btn.dataset.tab = key;
      tabs.appendChild(btn);
    });
    panelEl.appendChild(tabs);

    selLabelEl = mk("div", "ar-sel-label", "Selected text");
    panelEl.appendChild(selLabelEl);

    selEl = mk("div", "ar-sel");
    panelEl.appendChild(selEl);

    bodyEl = mk("div", "ar-body");
    panelEl.appendChild(bodyEl);

    /* Invisible handles on every side and corner used to resize the panel. */
    ["n", "s", "w", "e", "nw", "ne", "sw", "se"].forEach((dir) => {
      const h = mk("div", "ar-resize-handle");
      h.dataset.dir = dir;
      h.title = "Resize";
      h.setAttribute("aria-hidden", "true");
      panelEl.appendChild(h);
    });

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

  /* Apply a saved panel size (from dragging a resize handle), clamped to the
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
    /* A native double-click selects the clicked word. With click-a-word enabled
     * that gesture is owned by the definition popup, so it must not also summon
     * the selection toolbar or the auto-translate panel. */
    const fromDoubleClick = e.type === "mouseup" && e.detail > 1;
    setTimeout(() => {
      const info = getSelectionInfo();
      if (!info || info.text.length < (settings.minSelectionLength || 1)) {
        hideToolbar();
        return;
      }

      const changed = current.text !== info.text;
      if (changed) resetForText(info.text);
      current.text = info.text;
      current.rect = info.rect;

      if (settings.clickDefine && fromDoubleClick && isActiveSite() && selectedWordText(info.text)) {
        hideToolbar();
        return;
      }

      if (settings.showToolbar && isActiveSite()) showToolbar();
      else hideToolbar();

      // Auto-translate reacts to a new selection. Re-selecting the same text
      // while the panel is already open is a no-op, so we do not re-render or
      // re-request anything. If the panel is closed, reopen it.
      if (settings.autoTranslate && isActiveSite()) {
        const panelOpen = panelEl && panelEl.classList.contains("open");
        if (changed || !panelOpen) {
          if (!panelOpen || tab === "translate") openTranslate();
          else if (state.translation.status === "idle") runTranslate();
        }
      }
    }, 0);
  }

  /* Returns { text, rect } for the current selection — including selections
   * inside input/textarea elements, which window.getSelection() does not see. */
  function getSelectionInfo() {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      try {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        if (typeof start === "number" && typeof end === "number" && end > start) {
          const text = String(active.value || "").slice(start, end).trim();
          if (text) return { text, rect: normRect(active.getBoundingClientRect()) };
        }
      } catch (e) {
        /* some input types do not expose a text selection */
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
    if (e.key !== "Escape") return;
    hideDefine();
    hideToolbar();
    if (panelEl && panelEl.classList.contains("open")) closePanel();
  }

  /* Hide the toolbar and the word popup on page scroll, but not when
   * scrolling inside our panel. */
  function onWindowScroll(e) {
    if (isInsideUi(e)) return;
    hideDefine();
    hideToolbar();
  }

  function isInsideUi(e) {
    if (!host) return false;
    const path = typeof e.composedPath === "function" ? e.composedPath() : null;
    if (path && path.indexOf(host) !== -1) return true;
    const t = e.target;
    return t === host || (t && t.getRootNode && t.getRootNode() === shadow);
  }

  function isActiveSite() {
    return AR.isSiteActive(settings, location.hostname);
  }

  function resetForText(text) {
    selectionToken++;
    state.translation = { status: "idle", text: "", detected: "", engine: "", error: "" };
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

    if (selLabelEl) selLabelEl.hidden = !current.text;

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
      /* Lets the CSS restyle the tab contents as a flex column where needed
       * (e.g. the Translate tab, whose two text boxes share the height). */
      bodyEl.dataset.tab = tab;
      if (tab === "translate") setHtml(bodyEl, htmlTranslate());
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
        <div class="ar-result${rtl}"><div class="ar-result-row">
            <span class="ar-result-text">${AR.escapeHtml(t.text)}</span>
            <button class="ar-speak" type="button" data-action="speak-translation" title="Listen to the translation" aria-label="Listen to the translation">${AR.icon(
              "volume_up"
            )}</button>
          </div></div>
        <div class="ar-meta">
          ${t.detected ? "Detected: " + AR.escapeHtml(AR.langLabel(t.detected)) + " · " : ""}
          ${t.engine === "gemini" ? "AI model" : "Google Translate"} · Into ${AR.escapeHtml(
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
      body = `<div class="ar-hint">Your AI model will write comprehension questions about the highlighted text. Answers and explanations are shown as you go.</div>`;
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
      ? `<div class="ar-hint">Only the first ${MAX_QUIZ_CHARS} characters were sent to the AI model.</div>`
      : "";

    const shortNote =
      hasQuestions && state.quiz.requested && state.quiz.questions.length < state.quiz.requested
        ? `<div class="ar-hint">The AI model returned ${state.quiz.questions.length} of ${state.quiz.requested} questions. Press <b>New quiz</b> to try for more.</div>`
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
          spellcheck="false" autocorrect="off" autocapitalize="off"
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
        ${feedback ? `<div class="ar-explain">${AR.escapeHtml(feedback)}</div>` : ""}
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
    tab = "translate";
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

    const res = await send({
      type: MSG.TTS,
      text: value,
      lang: useLang,
      provider: settings.ttsProvider
    });

    if (!res || !res.ok) {
      toast((res && res.error) || "Could not play audio");
    }
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

  /* Free-response answers are graded by the configured AI model so that
   * equivalent wording and small typos still count, and so the learner gets
   * feedback in their own language. If it is unavailable we fall back to a
   * plain string match. */
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
      // Grade against the passage the quiz was built from, even if the reader
      // has since highlighted something else.
      text: state.quiz.text || quizText()
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
      toast((res && res.error) || "Could not reach the AI model — checked automatically");
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
    const hostname = (location.hostname || "").toLowerCase();
    if (!hostname) return;

    /* Add the exact host to the block list. This works in both modes because
     * the block list always wins, and it is precise: on an allowed domain's
     * subdomain it disables only that subdomain. (Removing the allow entry
     * instead would be ambiguous, since an entry also matches its subdomains.) */
    const list = (settings.disabledSites || []).slice();
    if (list.indexOf(hostname) === -1) list.push(hostname);
    settings.disabledSites = list;
    await AR.saveSettings({ disabledSites: list });
    hideToolbar();
    closePanel();
    toast("ActiveReader turned off on this site");
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

  /* ------------------------------------------------- click a word popup */

  /* Whether the clicked point sits on a plain word worth looking up. Skips
   * links, buttons and inputs so the popup never fights the page's own UI,
   * and empty clicks on margins or images. Returns the text node + character
   * offset the click landed on, or null. */
  function wordAtPoint(x, y) {
    let el = null;
    try {
      el = document.elementFromPoint(x, y);
    } catch (e) {
      return null;
    }
    if (!el) return null;
    if (el.closest) {
      const nz = el.closest(
        'a[href], button, input, textarea, select, label, summary, [role="button"], [role="option"], [role="tab"], [role="menuitem"], [contenteditable], iframe, video, audio, embed, object, svg, active-reader-root'
      );
      if (nz) return null;
    }

    /* Chrome resolves the exact text node + offset under the pointer, which
     * handles wrapped text and letter-spaced runs better than any manual
     * geometry. Fall back to a per-node scan when it is unavailable. */
    let node = null;
    let offset = 0;
    try {
      if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        if (r && r.startContainer && r.startContainer.nodeType === Node.TEXT_NODE) {
          node = r.startContainer;
          offset = r.startOffset;
        }
      }
    } catch (e) {
      /* fall through to the manual scan */
    }
    if (node) return { node, offset };

    if (el.nodeType === Node.TEXT_NODE) {
      return { node: el, offset: offsetAtPoint(el, x) };
    }

    /* Text is often wrapped: the element at the point is the containing <p>
     * or <span>. Walk its text-node descendants to find the exact line box. */
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let candidate = walker.nextNode();
    while (candidate) {
      let hit = false;
      try {
        const range = document.createRange();
        range.selectNodeContents(candidate);
        const rects = range.getClientRects();
        for (const rect of rects) {
          if (rect.width && rect.height && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            hit = true;
            break;
          }
        }
      } catch (e) {
        /* unrenderable node */
      }
      if (hit) {
        return { node: candidate, offset: offsetAtPoint(candidate, x) };
      }
      candidate = walker.nextNode();
    }
    return null;
  }

  /* Character index inside a text node for the given x coordinate. Binary
   * searches over per-character client ranges so wrapped words stay exact. */
  function offsetAtPoint(node, x) {
    const text = node.textContent || "";
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      pointRightOf(node, mid) <= x ? (lo = mid + 1) : (hi = mid);
    }
    return lo > 0 ? lo - 1 : 0;
  }

  function pointRightOf(node, index) {
    try {
      const r = document.createRange();
      r.setStart(node, Math.max(0, index - 1));
      r.setEnd(node, Math.max(0, index));
      const rect = r.getBoundingClientRect();
      return rect && rect.width ? rect.right : -Infinity;
    } catch (e) {
      return -Infinity;
    }
  }

  /* Scripts that do not put spaces between words, so a plain "letters run"
   * scan cannot find a word boundary on its own. */
  const WIDE_SCRIPT_RE =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

  /* Whole word around a character offset: letters/digits/accents, plus "'"
   * and "-" glued to letters ("don't", "mother-in-law"). Returns both the
   * word and its start index so callers can measure it exactly. */
  function wordSpanAroundOffset(text, offset) {
    const isWordChar = (ch) => /[\p{L}\p{N}'’-]/u.test(ch);
    let start = Math.min(offset, Math.max(0, text.length - 1));
    let end = start;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < text.length && isWordChar(text[end])) end++;
    if (start === end) return null;

    const raw = text.slice(start, end);
    /* Interior apostrophes/hyphens stay; leading/trailing ones are cut. */
    const word = raw.replace(/^['’-]+|['’-]+$/g, "");
    if (!word || !/\p{L}/u.test(word)) return null;
    /* Keep `start` on the first character of the trimmed word. */
    start += raw.indexOf(word);
    return { word, start };
  }

  /* Word span for a click. For wide scripts, ask ICU (Intl.Segmenter) where
   * the word really begins and ends; otherwise a Japanese/Chinese/Thai
   * sentence would be treated as one enormous "word". */
  function wordSpanAt(text, offset) {
    const span = wordSpanAroundOffset(text, offset);
    if (!span || !WIDE_SCRIPT_RE.test(span.word)) return span;
    try {
      if (typeof Intl !== "undefined" && Intl.Segmenter) {
        const segmenter = new Intl.Segmenter(settings.targetLang || undefined, { granularity: "word" });
        for (const part of segmenter.segment(text)) {
          if (part.isWordLike && offset >= part.index && offset < part.index + part.segment.length) {
            return { word: part.segment, start: part.index };
          }
        }
      }
    } catch (e) {
      /* fall back to the letter run */
    }
    return span;
  }

  /* The word the browser itself selected, trimmed of surrounding punctuation.
   * Returns "" when the selection is a phrase (triple-click) or empty. */
  function selectedWordText(selected) {
    const text = String(selected || "").trim();
    const word = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const chars = Array.from(word).length;
    if (chars < 2 || chars > 40) return "";
    if (!/\p{L}/u.test(word) || /\s/u.test(word)) return "";
    return word;
  }

  /* On-screen rect of the browser's current selection, if there is one. */
  function selectionRect(sel) {
    try {
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) {
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function onWordClick(e) {
    if (!settings.clickDefine || !isActiveSite()) return;
    if (isInsideUi(e) || e.button) {
      /* Clicking inside our own UI neither opens nor arms a lookup. */
      return;
    }

    const hit = wordAtPoint(e.clientX, e.clientY);
    if (!hit) {
      pendingWordClick = null;
      hideDefine();
      return;
    }

    const text = hit.node.textContent || "";
    const span = wordSpanAt(text, hit.offset);
    if (!span || Array.from(span.word).length < 2 || Array.from(span.word).length > 40) {
      pendingWordClick = null;
      hideDefine();
      return;
    }

    const sel = window.getSelection ? window.getSelection() : null;
    const selected = sel ? String(sel || "").trim() : "";
    const selectedWord = selectedWordText(selected);

    /* A native double-click has already selected exactly one word. Trust the
     * browser's boundary: it handles scripts without spaces (Chinese,
     * Japanese, Thai) and matches the text the reader sees highlighted.
     * Widen to a hyphen/apostrophe compound for spaced scripts, where the
     * browser stops at the hyphen ("mother" in "mother-in-law"). */
    if (e.detail > 1 && selectedWord) {
      let word = selectedWord;
      let start = span.start;
      if (!WIDE_SCRIPT_RE.test(span.word) && span.word.toLowerCase().indexOf(word.toLowerCase()) !== -1) {
        word = span.word;
        start = span.start;
      }
      const rect = selectionRect(sel) || wordRectAt(hit.node, start, word);
      if (rect) {
        pendingWordClick = null;
        showDefine(word, rect, contextAroundWord(text, start, word));
        return;
      }
    }

    const rect = wordRectAt(hit.node, span.start, span.word);
    if (!rect) {
      pendingWordClick = null;
      hideDefine();
      return;
    }

    /* A drag-selection ends with a mouseup+click too. Never treat a click
     * that leaves real selected text behind as a word click. A native
     * double-click selects just the clicked word (possibly with trailing
     * punctuation), which is allowed here so it can open the popup. */
    const selectedIsWord =
      selected.length <= 1 ||
      (selected.toLowerCase().includes(span.word.toLowerCase()) && selected.length <= span.word.length + 3);
    if (!selectedIsWord) {
      pendingWordClick = null;
      hideDefine();
      return;
    }

    const pending = pendingWordClick;
    pendingWordClick = null;
    const sameWord =
      pending && pending.node === hit.node && pending.word === span.word && pending.start === span.start;

    if (!sameWord) {
      /* First click: remember the word but keep the popup closed. */
      pendingWordClick = { node: hit.node, word: span.word, start: span.start };
      hideDefine();
      return;
    }

    /* The event still reaches the page untouched — the popup only *adds*
     * something to look at; a click on a word keeps its normal behaviour. */
    showDefine(span.word, rect, contextAroundWord(text, span.start, span.word));
  }

  function showDefine(word, rect, context) {
    defineToken++;
    const token = defineToken;
    defineTarget = { word, x: rect.left + rect.width / 2, y: rect.top };
    ensureDefineEl().classList.add("open");
    renderDefineLoading(word);
    positionDefine();

    const key = [settings.translationEngine, settings.baseLang, word.toLowerCase()].join("\u0000");
    const cached = defineCache.get(key);
    if (cached) {
      renderDefine(word, cached);
      positionDefine();
      return;
    }

    send({ type: MSG.DEFINE, word, context, engine: settings.translationEngine }).then((res) => {
      /* The reader clicked another word (or Esc) while we were waiting. */
      if (token !== defineToken) return;
      if (res && res.ok) {
        const entry = {
          meaning: res.meaning,
          partOfSpeech: res.partOfSpeech,
          example: res.example,
          fallback: !!res.fallback
        };
        cacheSet(defineCache, key, entry, 120);
        renderDefine(word, entry);
      } else {
        renderDefineError(word, (res && res.error) || "Could not look up this word.");
      }
      if (defineEl && defineTarget) positionDefine();
    });
  }

  function ensureDefineEl() {
    if (defineEl) return defineEl;
    defineEl = mk("div", "ar-define");
    defineEl.setAttribute("role", "tooltip");
    defineEl.setAttribute("aria-live", "polite");
    shadow.appendChild(defineEl);
    return defineEl;
  }

  function renderDefineLoading(word) {
    setHtml(
      defineEl,
      defineHeadHtml(word) +
        `<div class="ar-define-loading"><span class="ar-spinner"></span> Looking up…</div>`
    );
  }

  function defineHeadHtml(word, posHtml) {
    return (
      `<div class="ar-define-head"><span class="ar-define-word">${AR.escapeHtml(word)}</span>` +
      (posHtml || "") +
      `<span class="ar-define-close" data-action="define-close" title="Dismiss" role="button" tabindex="0">${AR.icon(
        "close"
      )}</span></div>`
    );
  }

  function renderDefine(word, entry) {
    const rtl = AR.isRtl(settings.baseLang) ? " rtl" : "";
    const pos = entry.partOfSpeech ? `<span class="ar-define-pos">${AR.escapeHtml(entry.partOfSpeech)}</span>` : "";
    const meaning = entry.meaning ? AR.escapeHtml(entry.meaning) : "No definition found.";
    const example = entry.example
      ? `<div class="ar-define-example${rtl}">“${AR.escapeHtml(entry.example)}”</div>`
      : "";
    const note = entry.fallback
      ? `<div class="ar-define-note">Fallback lookup — switch the translation engine to AI in settings for richer definitions.</div>`
      : "";
    setHtml(
      defineEl,
      defineHeadHtml(word, pos) +
        `<div class="ar-define-meaning${rtl}">${meaning}</div>` +
        example +
        note
    );
  }

  function renderDefineError(word, error) {
    setHtml(defineEl, defineHeadHtml(word) + `<div class="ar-define-error">${AR.escapeHtml(error)}</div>`);
  }

  function positionDefine() {
    if (!defineEl || !defineTarget) return;
    const w = defineEl.offsetWidth || 240;
    const h = defineEl.offsetHeight || 60;
    const maxW = Math.max(120, window.innerWidth - 16);
    const width = Math.min(w, maxW);
    let left = clamp(defineTarget.x - width / 2, 8, Math.max(8, window.innerWidth - width - 8));
    let top = defineTarget.y - h - 8;
    /* No room above the word (toolbar users know this pattern): flip below. */
    if (top < 8) top = clamp(defineTarget.y + 22, 8, Math.max(8, window.innerHeight - h - 8));
    defineEl.style.left = Math.round(left) + "px";
    defineEl.style.top = Math.round(top) + "px";
    if (width !== w) defineEl.style.width = Math.round(width) + "px";
    else defineEl.style.width = "";
  }

  function hideDefine() {
    if (defineEl) defineEl.classList.remove("open");
    defineTarget = null;
    defineToken++; /* any in-flight lookup is dropped */
  }

  /* The on-screen rectangle of one word inside a text node, measured with
   * per-character ranges. A word wrapped over two lines has two rects; the
   * last one is the side the reader clicked, so it wins. */
  function wordRectAt(node, start, word) {
    try {
      const textLength = (node.textContent || "").length;
      const from = Math.max(0, start);
      const to = Math.min(textLength, from + word.length);
      const range = document.createRange();
      let best = null;
      for (let i = from; i < to; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect && rect.width && rect.height) best = rect;
      }
      return best;
    } catch (err) {
      return null;
    }
  }

  /* A short window of the surrounding sentence, so a model can pick the right
   * sense of the word ("bank" by a river vs. a "bank" with tellers). */
  function contextAroundWord(text, start, word) {
    const from = Math.max(0, start - 80);
    const to = Math.min(text.length, start + word.length + 80);
    return text
      .slice(from, to)
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ----------------------------------------------------------- events */

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
        hideDefine();
        break;
      case "define-close":
        hideDefine();
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
        openSpeak();
        break;
      case "speak-original":
        runSpeak(current.text, settings.targetLang);
        break;
      case "speak-translation":
        if (state.translation.status === "done") runSpeak(state.translation.text, settings.baseLang);
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
    const resizeHandle = e.target.closest(".ar-resize-handle");
    if (resizeHandle) {
      beginResize(e, resizeHandle.dataset.dir || "se");
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

  function beginResize(e, dir) {
    if (!panelEl) return;
    const r = panelEl.getBoundingClientRect();
    /* Snapshot both edges: the corner opposite the handle stays fixed,
     * so top/left drags have to move the panel as well as its size.
     * Anchoring on the far edge keeps sizes valid even at the minimum. */
    resizeState = {
      dir: dir || "se",
      x: e.clientX,
      y: e.clientY,
      w: r.width,
      h: r.height,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom
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
    const s = resizeState;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    let w = s.w;
    let h = s.h;
    let left = s.left;
    let top = s.top;

    /* Width: an east edge stretches the panel; a west edge moves the left
     * edge while the right side stays put. Clamp the new size between the
     * minimum and the viewport so the panel never leaves the screen. */
    if (s.dir.indexOf("e") !== -1) {
      const maxW = Math.max(PANEL_MIN_W, window.innerWidth - 8 - s.left);
      w = clamp(s.w + dx, PANEL_MIN_W, maxW);
    } else if (s.dir.indexOf("w") !== -1) {
      const maxW = Math.max(PANEL_MIN_W, s.right - 8);
      w = clamp(s.w - dx, PANEL_MIN_W, maxW);
      left = s.right - w;
    }

    if (s.dir.indexOf("s") !== -1) {
      const maxH = Math.max(PANEL_MIN_H, window.innerHeight - 8 - s.top);
      h = clamp(s.h + dy, PANEL_MIN_H, maxH);
    } else if (s.dir.indexOf("n") !== -1) {
      const maxH = Math.max(PANEL_MIN_H, s.bottom - 8);
      h = clamp(s.h - dy, PANEL_MIN_H, maxH);
      top = s.bottom - h;
    }

    /* Handles for a pure edge keep the other axis untouched. The inline
     * size/position also replaces the CSS default caps, so clamp them here:
     * width is at least the minimum and the panel stays on screen. */
    panelEl.style.width = Math.round(w) + "px";
    panelEl.style.height = Math.round(h) + "px";
    if (left !== s.left) panelEl.style.left = Math.round(left) + "px";
    if (top !== s.top) panelEl.style.top = Math.round(top) + "px";
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
    return undefined;
  }

  async function handleCommand(msg) {
    settings = await AR.getSettings();
    if (!isActiveSite()) return;

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
      // Pick up new quiz defaults until the reader has generated a quiz (but
      // never while a generation is in flight).
      if (!state.quiz.questions.length && state.quiz.status !== "loading") {
        state.quiz.config = null;
      }
      if (badgeEl) badgeEl.textContent = AR.langLabel(settings.targetLang);
      if (!isActiveSite()) {
        hideDefine();
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
