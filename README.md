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
| 🌐 **Translation** | Translates the highlighted text into your own language via Google Translate, with an optional Gemini engine, and reports the detected source language. Small speaker buttons play the original or the translation aloud. |
| 🎓 **AI quizzes** | Gemini generates multiple-choice, short-answer and fill-in-the-blank questions from the selection. Answer them inline and get instant feedback: free-response answers are graded by Gemini (equivalent wording and small typos count) with a short explanation written in your own language. A **Translate question** button under each question shows it in your own language. Your last quiz stays put when you highlight new text or switch tabs, and if the model returns fewer questions than you asked for, ActiveReader automatically asks again to fill the quiz. |
| ⭐ **Vocabulary** | Save words/phrases with their translation and source page. Search, export (JSON/CSV) and manage them in settings. |
| ⬆️ **Update checks** | ActiveReader notices when its own version changes and, optionally, checks this GitHub project for a newer build every 12 hours. When one exists you get a toolbar badge, an optional notification, an in-popup banner and a one-click update page. |
| ⚙️ **Persistent settings** | API key, languages, voice, quiz defaults, theme and more are stored in Chrome sync storage. |
| 🛡️ **Backups that survive a clean** | Settings are also mirrored locally and restored automatically if they are wiped, and **Download backup file** in settings saves everything (plus vocabulary) so you can restore it after a system cleaner empties the browser profile. |
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
   **Quiz** tabs, drag the panel by its header to move it, drag the bottom-right
   corner to resize it, and press `Esc` to close. The panel remembers its size.

You can also right-click a selection and pick an ActiveReader action.

---

## Settings

Open settings from the panel's ⚙ button, the popup, or `chrome://extensions`.

- **Gemini AI** — API key, **model** (a free-text field — type any model ID, or click *Fetch models* to load the live list your key can access), connection test.
- **Languages** — the language you are learning and your own language, used for translations, quiz explanations and Gemini's answer feedback.
- **Translation** — Google Translate or Gemini (automatic fallback to the other).
- **Text to speech** — Google Translate voice or browser voice, plus speed, pitch and a preview box.
- **Reading & selection** — floating toolbar on/off, auto-translate, auto-save lookups, minimum/maximum selection size, and a per-site block list.
- **Quiz defaults** — which question types to generate, difficulty, number of questions, question language and whether to include explanations.
- **Appearance** — light/dark/system theme and an accent colour.
- **Updates** — current version, a **Check for updates** button, an automatic 12-hour check, an optional notification, and a page that walks through downloading the latest build.
- **Backup & restore** — download a backup file (settings + vocabulary) and restore it later. Handy after a system cleaner empties the browser profile.
- **Saved vocabulary** — search, delete, export and clear your saved words.

Changes save automatically.

---

## Updating ActiveReader

ActiveReader is installed as an **unpacked** extension, and Chrome does not update
unpacked extensions on its own. To make that painless, the extension watches its
own version and (optionally) this GitHub repository:

- **After the extension itself changes version** — for example you replaced the
  files and pressed **Reload** — the popup shows an *Updated to vX.Y.Z* banner and,
  if notifications are on, a short "what's new" notification.
- **When a newer version is published** to this repo's `main` branch, the toolbar
  icon gets a red **NEW** badge, you can get a desktop notification, and the popup
  banner plus the **Update ActiveReader** page link you straight to the download.
- **Auto-check** runs on startup and every 12 hours while the setting is on. Turn it
  off in **Settings → Updates** (or on the update page).

### What one click can and cannot do

Chrome extensions are sandboxed and cannot overwrite their own files, so a loaded
unpacked extension **cannot install its own update**. Clicking **Download latest
version** grabs the newest `.zip`, and the update page then tells you to unzip it
and press **Reload** in `chrome://extensions`. Your settings, API key and
vocabulary live in Chrome storage, not in the folder, so they survive the update.

> **True automatic updates** are only possible when the extension is installed from
> a `.crx` with an `update_url` (the Chrome Web Store, or a self-hosted update
> manifest signed with the same key). If this project is ever published that way,
> Chrome updates it silently and the built-in checker is simply a no-op. See
> [Chrome's update documentation](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
> to self-host a signed build.

### Privacy of update checks

The check fetches one file — `manifest.json` from this GitHub repository — and
reads only its `version` field. It sends no identifiers and no personal data, and
it never touches the pages you read. Turn it off with **Check for updates
automatically**.

---

## Project layout

```
manifest.json            MV3 manifest
icons/                   toolbar + store icons
tests/config.test.js     unit tests for the shared config helpers
src/
  background.js          service worker: Gemini, translation, TTS, context menus, update checks
  content.js             selection toolbar + Translate/Audio/Quiz panel
  content.css            styles for the injected shadow-DOM UI
  offscreen.html/.js     plays Google Translate TTS audio in an extension context
  popup.html/.js/.css    toolbar popup (quick settings + recent vocabulary)
  options.html/.js/.css  full settings page
  update.html/.js/.css   "update available" page + download/instructions
  lib/config.js          shared defaults, languages, version helpers, storage helpers
```

### Running the tests

The shared helpers in `src/lib/config.js` have unit tests that run with plain
Node and no dependencies:

```
node tests/config.test.js
```

### Why an offscreen document?

Chrome service workers cannot create blob URLs, and many pages block media
through their own CSP. The hidden offscreen document fetches the Google
Translate MP3s and plays them, keeping playback reliable regardless of the page.

---

## Privacy

- No analytics and no remote servers other than Google and (for update checks)
  GitHub. The update check downloads one public file and reads only its version
  number; see [Updating ActiveReader](#updating-activereader).
- Selected text is sent to Google Translate for translation/audio and to the
  Gemini API for quizzes, and nowhere else.
- The API key never touches the page — all requests are made from the extension's
  service worker.
- Saved vocabulary lives in `chrome.storage.local` on your machine.
- The optional backup file you download is a plain JSON file that **includes your
  API key**, so keep it somewhere private.

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
