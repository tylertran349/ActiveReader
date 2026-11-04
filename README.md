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
| 🌐 **Translation** | Translates the highlighted text into your own language via Google Translate, with an optional AI engine, and reports the detected source language. Small speaker buttons play the original or the translation aloud. |
| 🎓 **AI quizzes** | Your chosen AI model generates multiple-choice, short-answer and fill-in-the-blank questions from the selection. Answer them inline and get instant feedback: free-response answers are graded by the model (equivalent wording and small typos count) with a short explanation written in your own language. A **Translate question** button under each question shows it in your own language. Your last quiz stays put when you highlight new text or switch tabs, and if the model returns fewer questions than you asked for, ActiveReader automatically asks again to fill the quiz. |
| 🖱️ **Click-a-word** | Optionally, click **any single word** while reading and a small popup appears right above it with a quick lookup of that word. Uses Google Translate by default (no key, no API cost); switch the translation engine to AI in settings for a richer, context-aware definition with part of speech and a tiny example. Off by default — turn it on via **Settings → Reading & selection → Show a definition when I click a single word**. |
| ⭐ **Vocabulary** | Save words/phrases with their translation and source page. Search, export (JSON/CSV) and manage them in settings. |
| ⬆️ **Update checks** | ActiveReader notices when its own version changes and, optionally, checks this GitHub project for a newer build every 12 hours. When one exists you get a toolbar badge, an optional notification, an in-popup banner — and an **Update now** button in settings that fetches the newest files from this repo and installs them in place. |
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

Then open the extension's **Settings** and add a Gemini or custom API key (see below).

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
only quizzes (and optional AI translation) need one.

### Using a custom API (Command Code / DeepSeek)

Choose **Custom API (OpenAI-compatible)** as the AI provider to use any
OpenAI-compatible endpoint. Both the base URL and model ID are blank by
default; enter your provider's values or fetch its live model list.

For the [Command Code Provider API](https://commandcode.ai/docs/provider) on the
GOAT plan:

- **Base URL** — enter `https://api.commandcode.ai/provider/v1`
- **Model** — a free-text field; type `deepseek/deepseek-v4.1-flash` (or any
  other model ID) or fetch the provider's live list.
- **Thinking level** — populated from the model's advertised levels
  (`low`, `high`, `max` for DeepSeek V4.1 Flash). The model's default level is
  selected automatically; pick another to override it.

The API key is stored in Chrome sync storage and is only ever sent to the base
URL you enter. Only hosts granted in the manifest can be reached; Command Code's
API is included by default.

---

## How to use

1. **Highlight some text** on any page.
2. A small menu appears next to the selection with **Translate**, **Listen**,
   **Quiz**, **Save** and **Close**.
3. Results open in the panel. Switch between the **Translate**, **Audio** and
   **Quiz** tabs, drag the panel by its header to move it, drag any edge or
   corner to resize it, and press `Esc` to close. The panel remembers its size.
4. **Optionally, click any single word** to see a quick lookup of it in a
   small popup above the word. This is off by default; enable it in settings.
   Click elsewhere or press `Esc` to dismiss it; lookups are cached per page,
   so re-clicking a word is instant.

You can also right-click a selection and pick an ActiveReader action.

---

## Settings

Open settings from the panel's ⚙ button, the popup, or `chrome://extensions`.

- **AI provider** — Google Gemini, or a custom OpenAI-compatible API (base URL, key, model, and a thinking-level dropdown populated from the model's capabilities), plus a connection test.
- **Languages** — the language you are learning and your own language, used for translations, quiz explanations and the AI model's answer feedback.
- **Translation** — Google Translate or your AI provider (automatic fallback to the other).
- **Text to speech** — Google Translate voice or browser voice, plus speed, pitch and a preview box.
- **Reading & selection** — floating toolbar on/off, auto-translate, double-click-a-word definitions, auto-save lookups, minimum/maximum selection size, and where the extension runs: on **every site except the ones you block**, or **only on the sites you allow** (per-site allow and block lists).
- **Quiz defaults** — which question types to generate, difficulty, number of questions, question language and whether to include explanations.
- **Appearance** — light/dark/system theme and an accent colour.
- **Updates** — current version, a **Check for updates** button, an automatic 12-hour check, an optional notification, and **Update now**, which downloads the latest files from this repo into your extension folder and reloads the extension.
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

### What Update now can and cannot do

Chrome extensions are sandboxed and cannot overwrite their own files without permission. **Update
now** (in **Settings → Updates**, and on the update page) works around that with the File System
Access API:

1. The first time, Chrome asks you to **pick the folder** the extension is loaded from (the one
   containing `manifest.json`) and to **allow writes** to it. ActiveReader keeps only that folder
   permission, in its own storage.
2. Every later update lists the files in this repo's `main` branch, downloads each one from
   `raw.githubusercontent.com`, writes them into that folder (with `manifest.json` last), and
   **reloads the extension by itself**. Your settings, API key and vocabulary live in Chrome
   storage, not in the folder, so they survive untouched.
3. If your browser has no folder access API, or you skip the folder step, the update page falls
   back to **Download .zip**: grab the newest archive, unzip it over the old folder and press
   **Reload** in `chrome://extensions`.

> Fully silent updates (no folder permission at all) are only possible when the extension is
> installed from a signed `.crx` with an `update_url` (the Chrome Web Store, or a self-hosted
> update manifest). If this project is ever published that way, Chrome updates it automatically
> and the built-in checker becomes a simple "new version available" notice. See
> [Chrome's update documentation](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
> to self-host a signed build.

### Privacy of update checks

The check fetches one file - `manifest.json` from this GitHub repository - and
reads only its `version` field. Pressing **Update now** additionally lists the repository's files
via `api.github.com` and downloads them from `raw.githubusercontent.com` (that is what it writes
into your extension folder). Neither request sends identifiers or personal data, and neither
touches the pages you read. Turn the automatic check off with **Check for updates
automatically**.

---

## Project layout

```
manifest.json            MV3 manifest
icons/                   toolbar + store icons
tests/config.test.js     unit tests for the shared config helpers
src/
  background.js          service worker: AI providers, translation, TTS, context menus, update checks
  content.js             selection toolbar + Translate/Audio/Quiz panel + click-a-word popup
  content.css            styles for the injected shadow-DOM UI
  offscreen.html/.js     plays Google Translate TTS audio in an extension context
  popup.html/.js/.css    toolbar popup (quick settings + recent vocabulary)
  options.html/.js/.css  full settings page
  update.html/.js/.css   "update available" page + in-place update / download / instructions
  lib/config.js          shared defaults, languages, version helpers, storage helpers
  lib/updater.js         in-place updater: fetches the repo's files and writes them into the extension folder
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

- No analytics and no remote servers other than Google, the AI provider you
  configure, and (for update checks) GitHub. The update check downloads one
  public file and reads only its version number; see
  [Updating ActiveReader](#updating-activereader).
- Selected text is sent to Google Translate for translation/audio and to your
  chosen AI provider (Gemini by default) for quizzes, and nowhere else.
- The API key never touches the page — all requests are made from the extension's
  service worker.
- Saved vocabulary lives in `chrome.storage.local` on your machine.
- The optional backup file you download is a plain JSON file that **includes your
  API key**, so keep it somewhere private.

---

## Performance & caching

- Translations are cached per page and session-wide, and quizzes are cached per
  page, so re-opening the panel or re-reading a passage does not repeat a call.
- The AI model list is cached for 12 hours. **Fetch models** always refreshes
  it; automatic model selection reuses the cache.
- AI output is bounded and quiz/translation text is capped — very long
  selections are trimmed and the panel tells you when that happens.
- The audio offscreen document closes itself after playback has been idle for
  30 seconds.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Toolbar doesn't appear | Reload the page, and check the site is allowed by your site-access settings (not blocked, and listed if you chose "Only the sites I allow"). |
| No audio | Some voices need a user gesture — click Play. Try switching to the **Browser voice** in settings. |
| Quiz fails | Check the API key with **Test connection** and confirm the model name is available to your key. |
| Word popup doesn't appear | The feature is off by default - enable **Show a definition when I click a single word twice** in settings; the popup also skips links, buttons and form fields on purpose. Double-click exactly one word, and refresh any tab that was open when the extension was reloaded. |
| Word popup says "Fallback lookup" | The preferred engine failed, so the other one answered. Check **Test connection** in settings when the AI engine is selected. |
| "Could not reach the extension" | The extension was reloaded; refresh the page. |
| Translation empty | Try switching the translation engine; both engines fall back to each other automatically. |
