(() => {
  "use strict";
  const DRAFT_KEY = "fire-counsel-site-draft-v1";
  const QUOTA_PREVIEW_KEY = "fire-counsel-admin-quota-preview-v1";
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const editor = $("#json-editor");
  const status = $("#editor-status");
  const setStatus = (message, kind = "") => { status.textContent = message; status.className = `editor-status ${kind}`; };
  const setSlideStatus = (message, kind = "") => { const node = $("#slide-status"); if (node) { node.textContent = message; node.className = `slide-status ${kind}`; } };
  const setText = (selector, message) => { const node = $(selector); if (node) node.textContent = message; };
  const escapeHTML = value => String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[ch]));
  const FEATURE_KEYS = ["explanations", "pastQuestions", "marking", "ocr", "practiceScenarios"];
  const PLAN_KEYS = ["free", "paid"];
  const DEMO_USERS = [
    {id:"demo-student-001", label:"Preview student 001", plan:"Free preview"},
    {id:"demo-student-002", label:"Preview student 002", plan:"Free preview"},
    {id:"demo-student-003", label:"Preview student 003", plan:"Paid preview"}
  ];
  let defaultContent = null;
  let quotaDraft = {policy:{features:{}}, accounts:{}};
  let temporarySlides = [];
  let currentObjectUrls = new Set();

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
    if (/^(?:\.\/)?assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(path)) return path.startsWith("./") ? path : `./${path}`;
    try {
      const url = new URL(path, location.href);
      const decodedPath = decodeURIComponent(url.pathname);
      if (url.protocol === "https:" && url.hostname === "firebasestorage.googleapis.com" && /^\/v0\/b\/fire-counsel\.firebasestorage\.app\/o\/site\/slides\/[^/]+\.(?:png|jpe?g|webp)$/i.test(decodedPath)) return url.href;
    } catch (_) { /* untrusted path: fall through to the local brand image */ }
    return "./assets/images/fire-counsel-brand.jpg";
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
        <div class="slide-card-copy"><strong>${escapeHTML(slide.title || slide.eyebrow || `Homepage slide ${index + 1}`)}</strong><small>${escapeHTML(slide.imageCredit || slide.image || "No photo credit set")}</small><button class="slide-remove" type="button" data-delete-slide="${index}" ${slides.length <= 1 ? "disabled title=\"Keep at least one homepage slide\"" : ""}>Remove from draft</button></div>
      </article>`).join("");
    const temporary = temporarySlides.map(slide => `
      <article class="slide-card slide-card-temporary">
        <div class="slide-thumb"><img src="${escapeHTML(slide.url)}" alt="Temporary photo preview"><span class="slide-index">LOCAL</span></div>
        <div class="slide-card-copy"><strong>${escapeHTML(slide.name)}</strong><small>${escapeHTML(slide.size)} · temporary preview only</small><button class="slide-remove" type="button" data-delete-temp-slide="${escapeHTML(slide.id)}">Remove preview</button></div>
      </article>`).join("");
    holder.innerHTML = items + temporary || `<div class="slide-empty">No valid slide list is available. Fix the JSON and refresh the preview.</div>`;
    if (!items && !temporary) holder.innerHTML = `<div class="slide-empty">No valid slide list is available. Fix the JSON and refresh the preview.</div>`;
    if (count) count.textContent = `${slides.length} website slide${slides.length === 1 ? "" : "s"}${temporarySlides.length ? ` · ${temporarySlides.length} temporary` : ""}`;
  }
  async function load() {
    const response = await fetch("./data/site-content.json", {cache:"no-cache"});
    if (!response.ok) throw new Error(`Could not load default JSON (${response.status}).`);
    defaultContent = await response.json();
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft) {
        const parsed = validate(JSON.parse(draft));
        editor.value = JSON.stringify(parsed, null, 2);
        setStatus("Local website draft loaded", "is-ok");
        renderSlideLibrary();
        return;
      }
    } catch (error) { setStatus(`Default content loaded; invalid local draft ignored: ${error.message}`, "is-error"); }
    editor.value = JSON.stringify(defaultContent, null, 2);
    if (!status.classList.contains("is-error")) setStatus("Default website content loaded", "is-ok");
    renderSlideLibrary();
  }
  function saveWebsiteDraft(data) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    setStatus("Saved in this browser only", "is-ok");
    renderSlideLibrary();
  }

  $("#save-draft").addEventListener("click", () => {
    try { saveWebsiteDraft(parseEditor()); }
    catch (_) { /* validation feedback is shown above the editor */ }
  });
  $("#export-json").addEventListener("click", () => {
    try {
      const data = parseEditor();
      const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "site-content.json";
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      setStatus("JSON exported — review it before deployment", "is-ok");
    } catch (_) { /* validation feedback is shown above the editor */ }
  });
  $("#json-import").addEventListener("change", async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2_000_000) { setStatus("JSON file must be under 2 MB.", "is-error"); event.target.value = ""; return; }
    try {
      const data = validate(JSON.parse(await file.text()));
      editor.value = JSON.stringify(data, null, 2);
      renderSlideLibrary();
      setStatus(`Imported ${file.name} into the editor; not published`, "is-ok");
    } catch (error) { setStatus(`Import failed: ${error.message}`, "is-error"); }
    event.target.value = "";
  });
  $("#clear-draft").addEventListener("click", () => {
    localStorage.removeItem(DRAFT_KEY);
    editor.value = JSON.stringify(defaultContent, null, 2);
    renderSlideLibrary();
    setStatus("Local website draft discarded; default JSON restored", "is-ok");
  });
  editor.addEventListener("input", () => {
    try { validate(JSON.parse(editor.value)); renderSlideLibrary(); }
    catch (_) { /* keep the previous slide cards while the user edits invalid/incomplete JSON */ }
  });

  $("#slide-files").addEventListener("change", event => {
    const files = [...(event.target.files || [])];
    setText("#slide-selection-count", files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} selected` : "No photos selected");
  });
  $("#add-slide-files").addEventListener("click", () => {
    const picker = $("#slide-files");
    const files = [...(picker.files || [])];
    if (!files.length) { setSlideStatus("Choose one or more JPG, PNG or WebP photos first.", "is-error"); return; }
    const accepted = new Set(["image/jpeg", "image/png", "image/webp"]);
    let added = 0;
    for (const file of files) {
      if (!accepted.has(file.type)) { setSlideStatus(`${file.name}: choose a JPG, PNG or WebP photo.`, "is-error"); continue; }
      if (file.size > 10 * 1024 * 1024) { setSlideStatus(`${file.name}: choose an image under 10 MB.`, "is-error"); continue; }
      const url = URL.createObjectURL(file);
      currentObjectUrls.add(url);
      temporarySlides.push({id:`temp-${Date.now()}-${Math.random().toString(16).slice(2)}`, name:file.name, size:`${(file.size / 1024).toFixed(0)} KB`, url});
      added++;
    }
    picker.value = "";
    setText("#slide-selection-count", "No photos selected");
    renderSlideLibrary();
    if (added) setSlideStatus(`${added} temporary photo preview${added === 1 ? "" : "s"} added; nothing uploaded`, "is-ok");
  });
  $("#slide-library").addEventListener("click", event => {
    const tempButton = event.target.closest("[data-delete-temp-slide]");
    if (tempButton) {
      const item = temporarySlides.find(slide => slide.id === tempButton.dataset.deleteTempSlide);
      if (item) { URL.revokeObjectURL(item.url); currentObjectUrls.delete(item.url); }
      temporarySlides = temporarySlides.filter(slide => slide.id !== tempButton.dataset.deleteTempSlide);
      renderSlideLibrary();
      setSlideStatus("Temporary image preview removed", "is-ok");
      return;
    }
    const button = event.target.closest("[data-delete-slide]");
    if (!button) return;
    try {
      const data = validate(JSON.parse(editor.value));
      const index = Number(button.dataset.deleteSlide);
      if (!Number.isInteger(index) || index < 0 || index >= data.hero.slides.length) return;
      if (data.hero.slides.length <= 1) { setSlideStatus("Keep at least one homepage slide.", "is-error"); return; }
      if (!window.confirm("Remove this slide from the local website draft? This does not delete a Firebase file.")) return;
      data.hero.slides.splice(index, 1);
      editor.value = JSON.stringify(data, null, 2);
      renderSlideLibrary();
      setSlideStatus("Slide removed from the editor. Save the local draft to keep this preview change.", "is-ok");
    } catch (_) { /* the JSON editor already shows its validation state */ }
  });

  function emptyQuotaDraft() { return {policy:{features:{}}, accounts:{}}; }
  function loadQuotaDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUOTA_PREVIEW_KEY) || "null");
      if (!saved || typeof saved !== "object") return emptyQuotaDraft();
      return {policy:saved.policy && typeof saved.policy === "object" ? saved.policy : {features:{}}, accounts:saved.accounts && typeof saved.accounts === "object" ? saved.accounts : {}};
    } catch (_) { return emptyQuotaDraft(); }
  }
  function persistQuotaDraft() {
    localStorage.setItem(QUOTA_PREVIEW_KEY, JSON.stringify(quotaDraft));
  }
  function renderQuotaPolicy() {
    FEATURE_KEYS.forEach(feature => PLAN_KEYS.forEach(plan => {
      const rule = quotaDraft.policy?.features?.[feature]?.[plan] || {};
      const count = $(`[data-quota-count][data-feature="${feature}"][data-plan="${plan}"]`);
      const period = $(`[data-quota-period][data-feature="${feature}"][data-plan="${plan}"]`);
      if (count) count.value = rule.limit == null ? "" : String(rule.limit);
      if (period) period.value = rule.period || "";
    }));
    const hasValues = Object.values(quotaDraft.policy?.features || {}).some(pair => Object.values(pair || {}).some(rule => rule && (rule.limit != null || rule.period)));
    setText("#quota-policy-status", hasValues ? "Local quota draft loaded · not active for any student" : "No quota policy is saved in this browser.");
  }
  function collectPolicy() {
    const features = {};
    for (const feature of FEATURE_KEYS) {
      features[feature] = {};
      for (const plan of PLAN_KEYS) {
        const countInput = $(`[data-quota-count][data-feature="${feature}"][data-plan="${plan}"]`);
        const periodInput = $(`[data-quota-period][data-feature="${feature}"][data-plan="${plan}"]`);
        const raw = countInput.value.trim();
        const period = periodInput.value || null;
        if (raw === "") {
          features[feature][plan] = {limit:null, period};
          continue;
        }
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 0 || limit > 1_000_000) throw new Error("Enter a whole-number allowance from 0 to 1,000,000.");
        if (!period) throw new Error("Choose a reset period for every allowance you set.");
        features[feature][plan] = {limit, period};
      }
    }
    return {features, updatedAt:new Date().toISOString(), previewOnly:true};
  }
  const featureLabels = {explanations:"AI explanations", pastQuestions:"archived questions", marking:"rubric marking", ocr:"OCR", practiceScenarios:"practice scenarios"};
  function accessLabel(access) {
    if (access === "grant-free") return "Free AI granted · preview";
    if (access === "pause") return "AI paused · preview";
    return "Plan defaults · preview";
  }
  function renderStudentRows() {
    const holder = $("#student-account-rows");
    const query = $("#account-search").value.trim().toLowerCase();
    const users = DEMO_USERS.filter(user => `${user.id} ${user.label} ${user.plan}`.toLowerCase().includes(query));
    if (!users.length) { holder.innerHTML = `<tr><td colspan="5" class="account-empty">No sample account matches that search.</td></tr>`; return; }
    holder.innerHTML = users.map(user => {
      const entry = quotaDraft.accounts?.[user.id] || {};
      const changes = Object.entries(entry.overrides || {}).filter(([, value]) => Number(value?.delta) !== 0).map(([feature, value]) => `${Number(value.delta) > 0 ? "+" : ""}${Number(value.delta)} ${featureLabels[feature] || feature}`).join(" · ");
      return `<tr><td><strong>${escapeHTML(user.label)}</strong><small>${escapeHTML(user.id)}</small></td><td><span class="plan-pill">${escapeHTML(user.plan)}</span></td><td>${escapeHTML(accessLabel(entry.access))}<small>Usage unavailable in preview</small></td><td>${escapeHTML(changes || "No personal override")}</td><td><button class="button button-light account-edit-button" type="button" data-edit-account="${escapeHTML(user.id)}">Adjust</button></td></tr>`;
    }).join("");
  }
  function loadAccountForm(id) {
    const account = DEMO_USERS.find(user => user.id === id);
    if (!account) return;
    const entry = quotaDraft.accounts?.[id] || {};
    $("#quota-account-id").value = account.id;
    $("#quota-account-access").value = entry.access || "inherit";
    $("#adjustment-account-pill").textContent = account.label;
    loadFeatureAdjustment();
    setText("#account-adjustment-status", "Editing a sample account. Save stores a local preview only.");
  }
  function loadFeatureAdjustment() {
    const id = $("#quota-account-id").value;
    const feature = $("#quota-adjust-feature").value;
    const entry = quotaDraft.accounts?.[id]?.overrides?.[feature] || {};
    $("#quota-adjust-count").value = entry.delta == null ? "" : String(entry.delta);
    $("#quota-adjust-period").value = entry.period || "";
    $("#quota-adjust-reason").value = entry.reason || "";
  }
  $("#account-search").addEventListener("input", renderStudentRows);
  $("#student-account-rows").addEventListener("click", event => {
    const button = event.target.closest("[data-edit-account]");
    if (!button) return;
    loadAccountForm(button.dataset.editAccount);
    $("#quota-account-id").scrollIntoView({behavior:"smooth", block:"center"});
  });
  $("#quota-adjust-feature").addEventListener("change", loadFeatureAdjustment);
  $("#account-adjustment-form").addEventListener("submit", event => {
    event.preventDefault();
    const id = $("#quota-account-id").value;
    if (!DEMO_USERS.some(user => user.id === id)) { setText("#account-adjustment-status", "Select one of the sample accounts first."); return; }
    const raw = $("#quota-adjust-count").value.trim();
    let delta = null;
    if (raw !== "") {
      delta = Number(raw);
      if (!Number.isInteger(delta) || delta < -100_000 || delta > 100_000) { setText("#account-adjustment-status", "Use a whole-number adjustment between −100,000 and +100,000."); return; }
    }
    const feature = $("#quota-adjust-feature").value;
    const account = quotaDraft.accounts[id] || {access:"inherit", overrides:{}};
    account.access = $("#quota-account-access").value;
    account.overrides = account.overrides || {};
    if (delta == null || delta === 0) delete account.overrides[feature];
    else account.overrides[feature] = {delta, period:$("#quota-adjust-period").value || null, reason:$("#quota-adjust-reason").value.trim() || null};
    account.previewUpdatedAt = new Date().toISOString();
    quotaDraft.accounts[id] = account;
    try {
      persistQuotaDraft();
      renderStudentRows();
      setText("#account-adjustment-status", "Saved in this browser only · no student allowance changed.");
    } catch (_) { setText("#account-adjustment-status", "Could not save the local preview draft in this browser."); }
  });
  $("#save-quota-policy").addEventListener("click", () => {
    try {
      quotaDraft.policy = collectPolicy();
      persistQuotaDraft();
      setText("#quota-policy-status", "Saved in this browser only · not enforced for students.");
    } catch (error) { setText("#quota-policy-status", error.message); }
  });
  $("#clear-quota-policy").addEventListener("click", () => {
    quotaDraft.policy = {features:{}};
    try { persistQuotaDraft(); renderQuotaPolicy(); }
    catch (_) { setText("#quota-policy-status", "Could not clear the local preview policy."); }
  });

  $$("[data-panel]").forEach(button => button.addEventListener("click", () => {
    const target = button.dataset.panel;
    $$(".admin-tab").forEach(tab => tab.classList.toggle("is-active", tab === button));
    $$(".admin-panel").forEach(panel => {
      const selected = panel.id === `panel-${target}`;
      panel.hidden = !selected; panel.classList.toggle("is-visible", selected);
    });
  }));
  $$("[data-switch]").forEach(button => button.addEventListener("click", () => {
    const target = button.dataset.switch;
    $$(".admin-tab").forEach(tab => tab.classList.toggle("is-active", tab.dataset.panel === target));
    $$(".admin-panel").forEach(panel => {
      const selected = panel.id === `panel-${target}`;
      panel.hidden = !selected; panel.classList.toggle("is-visible", selected);
    });
    window.scrollTo({top:0, behavior:"smooth"});
  }));
  window.addEventListener("beforeunload", () => currentObjectUrls.forEach(url => URL.revokeObjectURL(url)));

  quotaDraft = loadQuotaDraft();
  renderQuotaPolicy();
  renderStudentRows();
  load().catch(error => { editor.value = ""; setStatus(error.message, "is-error"); renderSlideLibrary(); });
  // The provider-key field is intentionally disabled and is never read, copied, or persisted here.
})();
