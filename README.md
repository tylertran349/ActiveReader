# ActiveReader

A lightweight Chrome extension for learning a language while you read the web.
Highlight any text on any page and you can **hear it**, **translate it**, and
**quiz yourself on it** — all from a small floating toolbar.

Built with Manifest V3, vanilla JavaScript, and no build step or external
dependencies.

---

## Features

| | |
|---|---|
| 🔊 **Text to speech** | Uses the Google Translate voice by default (natural, no API key). Falls back to the built-in browser voice if Google is unreachable. Long selections are split into chunks automatically. |
| 🌐 **Translation** | Translates the highlighted text into your target language via Google Translate, with an optional Gemini engine. Reports the detected source language. |
| 🎓 **AI quizzes** | Gemini generates multiple-choice, short-answer and fill-in-the-blank questions from the selection. Answer them inline, get instant feedback, and read a short explanation. |
| ⭐ **Vocabulary** | Save words/phrases with their translation and source page. Search, export (JSON/CSV) and manage them in settings. |
| ⚙️ **Persistent settings** | API key, languages, voice, quiz defaults, theme and more are stored in Chrome sync storage. |
| 🖱️ **Right-click menu** | Translate / listen / quiz / save straight from the context menu after selecting text. |

Everything reacts to **whatever text you have selected** — drag-selected,
double-clicked, or keyboard-highlighted.

---

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Pin **ActiveReader** to the toolbar.

Then open the extension's **Settings** and paste a Gemini API key (see below).

> After installing or updating, reload any tabs that were already open so the
> content script is injected. The right-click menu injects it on demand.

### Getting a Gemini API key

1. Go to <https://aistudio.google.com/app/apikey>.
2. Create a key and copy it.
3. In ActiveReader settings, paste it into **API key** and press **Test connection**.
   The model field is free text and no model names are hardcoded in the extension —
   when you add a key a model is picked automatically from the API's live list, and
   **Fetch models** lets you choose any other one. New Gemini releases work without
   updating the extension.

The key is stored in `chrome.storage.sync` and is only ever sent to
`generativelanguage.googleapis.com`. Translation and audio work without a key;
only quizzes (and optional Gemini translation) need one.

---

## How to use

1. **Highlight some text** on any page.
2. A small menu appears next to the selection with **Translate**, **Listen**,
   **Quiz**, **Save** and **Close**.
3. Results open in the panel. Switch between the **Translate**, **Audio** and
   **Quiz** tabs, drag the panel by its header, and press `Esc` to close.

You can also right-click a selection and pick an ActiveReader action.

---

## Settings

Open settings from the panel's ⚙ button, the popup, or `chrome://extensions`.

- **Gemini AI** — API key, **model** (a free-text field — type any model ID, or click *Fetch models* to load the live list your key can access), connection test.
- **Languages** — the language you are learning and the language explanations/translations are shown in.
- **Translation** — Google Translate or Gemini (automatic fallback to the other).
- **Text to speech** — Google Translate voice or browser voice, plus speed, pitch and a preview box.
- **Reading & selection** — floating toolbar on/off, auto-translate, auto-save lookups, minimum/maximum selection size, and a per-site block list.
- **Quiz defaults** — which question types to generate, difficulty, number of questions, question language and whether to include explanations.
- **Appearance** — light/dark/system theme and an accent colour.
- **Saved vocabulary** — search, delete, export and clear your saved words.

Changes save automatically.

---

## Project layout

```
manifest.json            MV3 manifest
icons/                   toolbar + store icons
src/
  background.js          service worker: Gemini, translation, TTS, context menus
  content.js             selection toolbar + Translate/Audio/Quiz panel
  content.css            styles for the injected shadow-DOM UI
  offscreen.html/.js     plays Google Translate TTS audio in an extension context
  popup.html/.js/.css    toolbar popup (quick settings + recent vocabulary)
  options.html/.js/.css  full settings page
  lib/config.js          shared defaults, language list, storage helpers
```

### Why an offscreen document?

Chrome service workers cannot create blob URLs, and many pages block media
through their own CSP. The hidden offscreen document fetches the Google
Translate MP3s and plays them, keeping playback reliable regardless of the page.

---

## Privacy

- No analytics, no remote servers other than Google.
- Selected text is sent to Google Translate for translation/audio and to the
  Gemini API for quizzes, and nowhere else.
- The API key never touches the page — all requests are made from the extension's
  service worker.
- Saved vocabulary lives in `chrome.storage.local` on your machine.

---

## Performance & caching

- Translations are cached per page and session-wide, and quizzes are cached per
  page, so re-opening the panel or re-reading a passage does not repeat a call.
- The Gemini model list is cached for 12 hours. **Fetch models** always refreshes
  it; automatic model selection reuses the cache.
- Gemini output is bounded and quiz/translation text is capped — very long
  selections are trimmed and the panel tells you when that happens.
- The audio offscreen document closes itself after playback has been idle for
  30 seconds.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Toolbar doesn't appear | Reload the page, and check the site isn't in your disabled-sites list. |
| No audio | Some voices need a user gesture — click Play. Try switching to the **Browser voice** in settings. |
| Quiz fails | Check the API key with **Test connection** and confirm the model name is available to your key. |
| "Could not reach the extension" | The extension was reloaded; refresh the page. |
| Translation empty | Try switching the translation engine; both engines fall back to each other automatically. |
