/*
 * Offscreen document for ActiveReader.
 *
 * Chrome will not let a service worker create blob URLs, and many pages block
 * media requests through CSP, so all Google Translate TTS playback happens in
 * this hidden extension document instead.
 */
(function () {
  "use strict";

  const AR = globalThis.AR;
  const MSG =
    (AR && AR.MSG) || {
      TARGET_OFFSCREEN: "offscreen",
      TARGET_BG: "bg",
      TTS_STATE: "ar-tts-state",
      TTS_FALLBACK: "ar-tts-fallback"
    };

  // Google's translate_tts endpoint accepts roughly 200 characters per call.
  const MAX_CHUNK = 190;

  const HOSTS = [
    "https://translate.google.com/translate_tts",
    "https://translate.googleapis.com/translate_tts"
  ];

  let queue = [];
  let stopped = true;
  let audio = null;
  let objectUrl = null;
  let currentLang = "en";

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== MSG.TARGET_OFFSCREEN) return undefined;

    if (msg.type === "play") {
      start(msg.text, msg.lang || "en");
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "stop") {
      stop();
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  });

  function notify(state) {
    try {
      chrome.runtime.sendMessage({ target: MSG.TARGET_BG, type: MSG.TTS_STATE, state });
    } catch (e) {
      /* service worker may be gone */
    }
  }

  /* Google refused the audio. Hand the rest of the text to the browser voice. */
  function handOffToBrowser(chunk) {
    notify("failed");
    try {
      chrome.runtime.sendMessage({
        target: MSG.TARGET_BG,
        type: MSG.TTS_FALLBACK,
        text: pendingText(chunk),
        lang: currentLang
      });
    } catch (e) {
      /* ignore */
    }
    queue = [];
  }

  /* Rebuild the remaining text. Only insert a space when the language uses them,
   * so CJK text does not gain stray spaces. */
  function pendingText(chunk) {
    const parts = [chunk].concat(queue);
    return parts.join(/\s/.test(chunk) ? " " : "");
  }

  function start(text, lang) {
    stop();
    stopped = false;
    queue = chunkText(text);
    currentLang = lang;
    notify("playing");
    playNext();
  }

  function stop() {
    stopped = true;
    queue = [];
    if (audio) {
      try {
        audio.pause();
        audio.src = "";
      } catch (e) {
        /* ignore */
      }
      audio = null;
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  async function playNext() {
    if (stopped || !queue.length) {
      if (!stopped) notify("ended");
      return;
    }

    const chunk = queue.shift();
    const blob = await fetchAudio(chunk, currentLang);

    if (stopped) return;

    if (!blob) {
      handOffToBrowser(chunk);
      return;
    }

    objectUrl = URL.createObjectURL(blob);
    audio = new Audio(objectUrl);

    let playBlocked = false;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      audio.onended = finish;
      audio.onerror = finish;
      audio.onpause = finish;
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          playBlocked = true;
          finish();
        });
      }
      // Safety net in case a media event never fires.
      setTimeout(finish, Math.min(60000, 8000 + chunk.length * 180));
    });

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    audio = null;

    if (stopped) {
      notify("ended");
      return;
    }

    // The browser refused to play the audio; use chrome.tts instead.
    if (playBlocked) {
      handOffToBrowser(chunk);
      return;
    }

    playNext();
  }

  async function fetchAudio(chunk, lang) {
    for (const host of HOSTS) {
      try {
        const params = new URLSearchParams({
          ie: "UTF-8",
          client: "tw-ob",
          tl: lang,
          q: chunk
        });
        const res = await fetch(host + "?" + params.toString(), {
          method: "GET",
          credentials: "omit",
          cache: "no-store"
        });
        if (!res.ok) continue;
        const blob = await res.blob();
        // Error pages are tiny; real MP3 chunks are comfortably larger.
        if (blob && blob.size > 400) return blob;
      } catch (e) {
        /* try the next host */
      }
    }
    return null;
  }

  /* Split text into TTS friendly chunks on natural boundaries. */
  function chunkText(text) {
    const clean = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return [];

    const chunks = [];
    let rest = clean;

    while (rest.length > MAX_CHUNK) {
      const windowText = rest.slice(0, MAX_CHUNK + 1);
      let cut = -1;

      const patterns = [/[.!?。！？؛;]\s?/g, /[,،、，:]\s?/g, /\s/g];
      for (const re of patterns) {
        let last = -1;
        let m;
        while ((m = re.exec(windowText)) !== null) {
          last = m.index + m[0].length;
          if (m.index === re.lastIndex) re.lastIndex++;
        }
        if (last > MAX_CHUNK * 0.4) {
          cut = last;
          break;
        }
      }

      if (cut < 0) cut = MAX_CHUNK;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }

    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }
})();
