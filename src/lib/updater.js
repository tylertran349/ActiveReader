/*
 * ActiveReader in-place updater.
 *
 * Chrome never updates unpacked extensions, and an extension cannot write into
 * its own folder on its own. It can, however, use the File System Access API
 * once the user grants access to that folder: the first "Update now" asks for
 * the folder the extension is loaded from, the directory handle is kept in
 * IndexedDB, and every later update downloads the files from this GitHub
 * repository's main branch, writes them over the local copy and reloads the
 * extension.
 *
 * Extension pages only (options + update page) — the File System Access API
 * does not exist in service workers, so nothing here may run in the background
 * worker. Every file write goes through AR.isSafeRepoPath from config.js.
 */
(function () {
  "use strict";

  const AR = globalThis.AR;

  if (typeof document === "undefined" || typeof window === "undefined") return;

  const DB_NAME = "ar-updater";
  const DB_STORE = "handles";
  const HANDLE_KEY = "extensionFolder";
  // Refuse absurd files so a bad listing cannot balloon memory or disk.
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  /* ------------------------------------------------------ IndexedDB handle */

  async function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Could not open the updater database."));
    });
  }

  async function withStore(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const fail = (err) => reject(err || new Error("Updater storage failed."));
        try {
          run(tx.objectStore(DB_STORE), resolve, fail);
        } catch (e) {
          fail(e);
        }
        tx.onabort = () => fail(tx.error);
        tx.onerror = () => fail(tx.error);
      });
    } finally {
      db.close();
    }
  }

  function idbGet() {
    return withStore("readonly", (store, resolve, fail) => {
      const req = store.get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => fail(req.error);
    });
  }

  function idbSet(handle) {
    return withStore("readwrite", (store, resolve, fail) => {
      const req = store.put(handle, HANDLE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => fail(req.error);
    });
  }

  function idbDelete() {
    return withStore("readwrite", (store, resolve, fail) => {
      const req = store.delete(HANDLE_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => fail(req.error);
    });
  }

  /* ------------------------------------------------------------ public API */

  AR.updater = {
    supported: function () {
      return typeof window.showDirectoryPicker === "function" && typeof indexedDB !== "undefined";
    },

    /* Read the manifest out of a candidate folder and make sure it really is
     * the folder ActiveReader is loaded from, never some random user folder. */
    verifyFolder: async function (handle) {
      let file;
      try {
        file = await (await handle.getFileHandle("manifest.json", { create: false })).getFile();
      } catch (e) {
        throw new Error("That folder has no manifest.json — pick the folder you loaded in chrome://extensions.");
      }
      let manifest;
      try {
        manifest = JSON.parse(await file.text());
      } catch (e) {
        throw new Error("The manifest.json in that folder is not valid JSON.");
      }
      if (manifest.manifest_version !== 3 || !/ActiveReader/i.test(String(manifest.name || ""))) {
        throw new Error("That folder is not ActiveReader — pick the folder containing ActiveReader's manifest.json.");
      }
      return manifest;
    },

    /* Show the picker, verify the choice and remember it. Returns
     * { handle, manifest } or null when the user cancels the picker. */
    chooseFolder: async function () {
      let handle;
      try {
        handle = await window.showDirectoryPicker({ id: "activereader-update", mode: "readwrite" });
      } catch (e) {
        if (e && e.name === "AbortError") return null;
        throw new Error("Chrome blocked the folder picker (" + ((e && e.message) || e.name || "unknown error") + ").");
      }
      const manifest = await AR.updater.verifyFolder(handle);
      await idbSet(handle);
      return { handle: handle, manifest: manifest };
    },

    forgetFolder: function () {
      return idbDelete();
    },

    /* Fetch every file from the repository and write it into the linked
     * folder. Returns { version, count }. Never runs without a linked folder
     * and granted write permission. */
    applyUpdate: async function (opts) {
      const onProgress = (opts && opts.onProgress) || null;
      const say = (text) => {
        if (typeof onProgress === "function") {
          try {
            onProgress(text);
          } catch (e) {
            /* progress is cosmetic */
          }
        }
      };

      const handle = (opts && opts.handle) || (await idbGet());
      if (!handle) throw new Error("Choose your ActiveReader folder first (the one that contains manifest.json).");
      if (!(await ensurePermission(handle))) {
        throw new Error("Chrome did not grant write access to the extension folder. Press “Choose extension folder…” and pick it again.");
      }

      say("Listing the latest files on GitHub…");
      const files = await fetchFileList();

      // Download everything before touching the disk, so a network error in
      // the middle can never leave a half-written extension behind.
      const items = [];
      for (let i = 0; i < files.length; i++) {
        say("Downloading " + (i + 1) + "/" + files.length + " — " + files[i]);
        const res = await fetch(rawUrl(files[i]), { cache: "no-store", credentials: "omit" });
        if (!res.ok) throw new Error("Could not download " + files[i] + " (GitHub replied " + res.status + ").");
        items.push({ path: files[i], bytes: new Uint8Array(await res.arrayBuffer()) });
      }

      // manifest.json goes last: the reported version should only change once
      // every other file is already in place.
      items.sort((a, b) => (a.path === "manifest.json" ? 1 : 0) - (b.path === "manifest.json" ? 1 : 0));

      for (let i = 0; i < items.length; i++) {
        say("Writing " + (i + 1) + "/" + items.length + " — " + items[i].path);
        await writeFile(handle, items[i].path, items[i].bytes);
      }

      let version = "";
      const manifestItem = items.find((item) => item.path === "manifest.json");
      try {
        version = String(JSON.parse(new TextDecoder().decode(manifestItem.bytes)).version || "");
      } catch (e) {
        /* empty version means unknown; the reload still happened */
      }
      return { version: version, count: items.length };
    },

    reload: function () {
      try {
        chrome.runtime.reload();
      } catch (e) {
        /* the page is about to go stale anyway */
      }
    },

    /* Wire the updater UI to a page's elements. `ids` maps: update (the
     * "Update now" button), choose, forget, folder and progress. `opts`
     * .onUpdated runs after files were written, just before the reload. */
    mount: function (ids, opts) {
      const o = opts || {};
      const $ = (id) => (id ? document.getElementById(id) : null);
      const els = {
        update: $(ids.update),
        choose: $(ids.choose),
        forget: $(ids.forget),
        folder: $(ids.folder),
        progress: $(ids.progress)
      };
      let busy = false;

      const say = (text) => {
        if (els.progress) els.progress.textContent = text || "";
      };

      const setBusy = (value) => {
        [els.update, els.choose, els.forget].forEach((el) => {
          if (el) el.disabled = !!value;
        });
      };

      async function renderFolder() {
        let handle = null;
        try {
          handle = await idbGet();
        } catch (e) {
          /* treat as unlinked */
        }
        if (els.folder) {
          els.folder.textContent = handle
            ? "Updates are written into “" + handle.name + "”, the folder the extension is loaded from."
            : "No folder linked yet — the first update asks you to pick the folder you loaded in chrome://extensions.";
        }
        if (els.forget) els.forget.hidden = !handle;
      }

      async function run(job) {
        if (busy) return;
        busy = true;
        setBusy(true);
        try {
          await job();
        } catch (e) {
          say((e && e.message) || "Something went wrong while updating.");
        }
        setBusy(false);
        busy = false;
      }

      async function updateNow() {
        let handle = await idbGet().catch(() => null);
        if (!handle) {
          // The picker must open inside the click gesture, so pick here rather
          // than letting applyUpdate fail first.
          const picked = await AR.updater.chooseFolder();
          if (!picked) return; // user cancelled the picker
          handle = picked.handle;
        }
        const res = await AR.updater.applyUpdate({ handle: handle, onProgress: say });
        say("Updated to v" + (res.version || "?") + " (" + res.count + " files). Reloading ActiveReader…");
        if (typeof o.onUpdated === "function") {
          try {
            o.onUpdated(res);
          } catch (e) {
            /* cosmetic only */
          }
        }
        setTimeout(() => AR.updater.reload(), 1200);
      }

      if (!AR.updater.supported()) {
        if (els.update) {
          els.update.disabled = true;
          els.update.title = "This browser has no folder access API; use the download instead.";
        }
        if (els.choose) els.choose.hidden = true;
        if (els.forget) els.forget.hidden = true;
        say("In-place updates are not available in this browser — download the latest version instead.");
        return;
      }

      if (els.update) els.update.addEventListener("click", () => run(updateNow));
      if (els.choose) {
        els.choose.addEventListener("click", () =>
          run(async () => {
            const picked = await AR.updater.chooseFolder();
            if (picked) {
              say(
                "Linked to “" +
                  picked.handle.name +
                  "”" +
                  (picked.manifest.version ? " (v" + picked.manifest.version + " is installed there)." : ".")
              );
            }
            await renderFolder();
          })
        );
      }
      if (els.forget) {
        els.forget.addEventListener("click", () =>
          run(async () => {
            await AR.updater.forgetFolder();
            await renderFolder();
            say("Folder link removed.");
          })
        );
      }

      renderFolder();
    }
  };

  /* -------------------------------------------------------------- internals */

  async function ensurePermission(handle) {
    const opts = { mode: "readwrite" };
    try {
      if ((await handle.queryPermission(opts)) === "granted") return true;
      // Needs a recent user gesture; every caller reaches this straight from a
      // button click, so the prompt is allowed.
      return (await handle.requestPermission(opts)) === "granted";
    } catch (e) {
      return false;
    }
  }

  async function fetchFileList() {
    let res;
    try {
      res = await fetch(AR.UPDATE.treeUrl, {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/vnd.github+json" }
      });
    } catch (e) {
      throw new Error("Could not reach GitHub. Check your connection and try again.");
    }
    if (res.status === 403) throw new Error("GitHub rate-limited this connection — try again in a few minutes.");
    if (!res.ok) throw new Error("GitHub replied " + res.status + " while listing the repository.");
    const data = await res.json();
    if (!data || !Array.isArray(data.tree)) throw new Error("Could not read the repository file list.");
    if (data.truncated) throw new Error("The repository is too large to list — download the .zip instead.");

    const files = data.tree
      .filter((entry) => entry.type === "blob" && (entry.size || 0) <= MAX_FILE_BYTES && AR.isSafeRepoPath(entry.path))
      .map((entry) => entry.path);
    if (files.indexOf("manifest.json") === -1) throw new Error("The repository has no manifest.json at its root.");
    return files;
  }

  function rawUrl(path) {
    return AR.UPDATE.rawBase + path.split("/").map(encodeURIComponent).join("/");
  }

  async function writeFile(root, path, bytes) {
    const parts = path.split("/");
    let dir = root;
    for (const name of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(name, { create: true });
    }
    const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }
})();
