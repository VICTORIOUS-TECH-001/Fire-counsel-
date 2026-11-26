(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const editor = $("#json-editor");
  const status = $("#editor-status");
  const setStatus = (message, kind = "") => { status.textContent = message; status.className = `editor-status ${kind}`; };
  const setSlideStatus = (message, kind = "") => { const node = $("#slide-status"); if (node) { node.textContent = message; node.className = `slide-status ${kind}`; } };
  const setText = (selector, message) => { const node = $(selector); if (node) node.textContent = message; };
  const escapeHTML = value => String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[ch]));
  let defaultContent = null;

  function validate(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("JSON must contain one top-level object.");
    if (!data.brand?.name) throw new Error("Add brand.name before saving.");
    if (!Array.isArray(data.navigation)) throw new Error("navigation must be a JSON array.");
    if (!Array.isArray(data.hero?.slides) || data.hero.slides.length < 1) throw new Error("Keep at least one homepage slide.");
    if (!Array.isArray(data.learning?.cards)) throw new Error("learning.cards must be a JSON array.");
    if (!Array.isArray(data.articles?.items)) throw new Error("articles.items must be a JSON array.");
    return data;
  }
  function parseEditor() {
    try { return validate(JSON.parse(editor.value)); }
    catch (error) { setStatus(error.message || "JSON is not valid.", "is-error"); editor.focus(); throw error; }
  }
  function validSlideSource(value) {
    const path = String(value || "");
    if (/^(?:\.\/|\/)?assets\/images\/fire-counsel-brand\.jpg(?:[?#].*)?$/i.test(path)) return "./assets/images/fire-counsel-flame.png";
    if (/^(?:\.\/)?assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(path)) return path.startsWith("./") ? path : `./${path}`;
    if (/^\/media\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(path)) return path;
    try {
      const url = new URL(path, location.href);
      const decodedPath = decodeURIComponent(url.pathname);
      if (url.protocol === "https:" && url.hostname === "firebasestorage.googleapis.com" && /^\/v0\/b\/fire-counsel\.firebasestorage\.app\/o\/site\/slides\/[^/]+\.(?:png|jpe?g|webp)$/i.test(decodedPath)) return url.href;
    } catch (_) { /* untrusted path: fall through to the local brand image */ }
    return "./assets/images/fire-counsel-flame.png";
  }
  function readSlides() {
    try { return JSON.parse(editor.value)?.hero?.slides || []; }
    catch (_) { return []; }
  }
  function renderSlideLibrary() {
    const holder = $("#slide-library");
    const count = $("#slide-count-label");
    if (!holder || !editor) return;
    const slides = readSlides();
    const items = slides.map((slide, index) => `
      <article class="slide-card">
        <div class="slide-thumb"><img src="${escapeHTML(validSlideSource(slide.image))}" alt="${escapeHTML(slide.imageAlt || slide.title || "Homepage slide photo")}" loading="lazy"><span class="slide-index">${String(index + 1).padStart(2, "0")}</span></div>
        <div class="slide-card-copy"><strong>${escapeHTML(slide.title || slide.eyebrow || `Homepage slide ${index + 1}`)}</strong><small>${escapeHTML(slide.imageCredit || slide.image || "No photo credit set")}</small><button class="slide-remove" type="button" data-delete-slide="${index}" ${slides.length <= 1 ? "disabled title=\"Keep at least one homepage slide\"" : ""}>Remove slide</button></div>
      </article>`).join("");
    holder.innerHTML = items || `<div class="slide-empty">No valid slide list is available. Fix the JSON in Pages &amp; JSON.</div>`;
    if (count) count.textContent = `${slides.length} slide${slides.length === 1 ? "" : "s"} in the editor`;
  }
  async function load() {
    // On the live site this is the PUBLISHED content (served from Neon). The
    // saved draft, if any, is loaded by admin-site.mjs after admin sign-in.
    const response = await fetch("./data/site-content.json", {cache:"no-cache"});
    if (!response.ok) throw new Error(`Could not load the website content (${response.status}).`);
    defaultContent = await response.json();
    // admin-site.mjs may already have put the saved draft in the editor.
    if (editor.dataset.source === "server") { renderSlideLibrary(); return; }
    editor.value = JSON.stringify(defaultContent, null, 2);
    setStatus("Live website content loaded", "is-ok");
    renderSlideLibrary();
    document.dispatchEvent(new CustomEvent("fire-counsel:site-editor-ready"));
  }

  $("#export-json").addEventListener("click", () => {
    try {
      const data = parseEditor();
      const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "site-content.json";
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setStatus("JSON downloaded (a backup copy)", "is-ok");
    } catch (_) { /* validation feedback is shown above the editor */ }
  });
  $("#json-import").addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2_000_000) { setStatus("JSON file must be under 2 MB.", "is-error"); event.target.value = ""; return; }
    try {
      const data = validate(JSON.parse(await file.text()));
      editor.value = JSON.stringify(data, null, 2);
      editor.dispatchEvent(new Event("input"));
      renderSlideLibrary();
      setStatus(`Imported ${file.name} into the editor — not saved or published yet`, "is-ok");
    } catch (error) { setStatus(`Import failed: ${error.message}`, "is-error"); }
    event.target.value = "";
  });
  editor.addEventListener("input", () => {
    try { validate(JSON.parse(editor.value)); renderSlideLibrary(); }
    catch (_) { /* keep the previous slide cards while the user edits invalid/incomplete JSON */ }
  });
  $("#slide-files").addEventListener("change", event => {
    const files = [...(event.target.files || [])];
    setText("#slide-selection-count", files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} selected` : "No photos selected");
  });
  $("#slide-library").addEventListener("click", event => {
    const button = event.target.closest("[data-delete-slide]");
    if (!button) return;
    try {
      const data = validate(JSON.parse(editor.value));
      const index = Number(button.dataset.deleteSlide);
      if (!Number.isInteger(index) || index < 0 || index >= data.hero.slides.length) return;
      if (data.hero.slides.length <= 1) { setSlideStatus("Keep at least one homepage slide.", "is-error"); return; }
      if (!window.confirm("Remove this slide? It disappears from the live site only after you press Publish.")) return;
      data.hero.slides.splice(index, 1);
      editor.value = JSON.stringify(data, null, 2);
      editor.dispatchEvent(new Event("input"));
      renderSlideLibrary();
      setSlideStatus("Slide removed. Press Save draft or Publish (Pages & JSON) to keep it.", "is-ok");
    } catch (_) { /* the JSON editor already shows its validation state */ }
  });

  $$("[data-panel]").forEach(button => button.addEventListener("click", () => {
    const target = button.dataset.panel;
    $$(".admin-tab").forEach(tab => tab.classList.toggle("is-active", tab === button));
    $$(".admin-panel").forEach(panel => {
      const selected = panel.id === `panel-${target}`;
      panel.hidden = !selected; panel.classList.toggle("is-visible", selected);
    });
    document.dispatchEvent(new CustomEvent("fire-counsel:admin-panel", { detail: { panel: target } }));
  }));
  $$("[data-switch]").forEach(button => button.addEventListener("click", () => {
    const target = button.dataset.switch;
    $$(".admin-tab").forEach(tab => tab.classList.toggle("is-active", tab.dataset.panel === target));
    $$(".admin-panel").forEach(panel => {
      const selected = panel.id === `panel-${target}`;
      panel.hidden = !selected; panel.classList.toggle("is-visible", selected);
    });
    document.dispatchEvent(new CustomEvent("fire-counsel:admin-panel", { detail: { panel: target } }));
    window.scrollTo({top:0, behavior:"smooth"});
  }));

  load().catch(error => { editor.value = ""; setStatus(error.message, "is-error"); renderSlideLibrary(); });
  // Drafts, preview, publishing and photo uploads live in admin-site.mjs; AI
  // settings in admin-ai.mjs; uploads in admin-uploads.mjs. The server saves
  // anything only after it verifies the admin claim.
})();
