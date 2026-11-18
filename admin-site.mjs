// Admin Studio: website draft -> preview -> publish, version history and
// homepage slide photos. Everything is saved in Neon by the server, and only
// after it verifies the Firebase admin claim. The JSON editor (#json-editor,
// managed by admin.js) holds the content being edited.
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const editor = $("#json-editor");

let authClient = null;
let verified = false;
let session = 0;
let publishedContent = null;
let pendingPreview = null;

function setText(selector, text, kind = "") {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}
const editorStatus = (text, kind = "") => {
  const node = $("#editor-status");
  if (!node) return;
  node.textContent = text;
  node.className = `editor-status ${kind === "error" ? "is-error" : kind === "ok" ? "is-ok" : ""}`;
};
const when = (value) => {
  try { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return String(value || ""); }
};

async function api(path, options = {}) {
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await authClient.apiRequest(path, options);
    // Render's free plan sleeps; its proxy answers 502/503/504 (not JSON) while waking.
    const waking = [502, 503, 504].includes(response.status) && !(response.headers.get("content-type") || "").includes("json");
    if (!waking || attempt >= 2 || (options.method && options.method !== "GET")) break;
    editorStatus("The server is waking up… retrying");
    await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
  }
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const waking = [502, 503, 504].includes(response.status) && !body.code;
    const error = new Error(body.error || (waking ? "The server is waking up or restarting (Render free plan). Wait about a minute, then try again." : `Request failed (${response.status}).`));
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function readEditor() {
  let data;
  try { data = JSON.parse(editor.value); } catch { throw new Error("The JSON has a mistake (a missing comma or quote?). Fix it before saving."); }
  if (!data?.brand?.name) throw new Error("Add brand.name before saving.");
  if (!Array.isArray(data.hero?.slides) || !data.hero.slides.length) throw new Error("Keep at least one homepage slide.");
  return data;
}

function writeEditor(data) {
  editor.dataset.source = "server";
  editor.value = JSON.stringify(data, null, 2);
  editor.dispatchEvent(new Event("input"));
}

function setEnabled(on) {
  for (const id of ["#save-draft", "#clear-draft", "#publish-site", "#add-slide-files"]) {
    const node = $(id);
    if (!node) continue;
    node.disabled = !on;
    node.setAttribute("aria-disabled", String(!on));
    node.classList.toggle("button-disabled", !on);
  }
  const note = $("#publish-note");
  if (note) note.disabled = !on;
  setText("#site-publish-state", on ? "SAVED IN NEON · LIVE ON PUBLISH" : "SIGN IN AS ADMIN TO PUBLISH");
  if (!on) setText("#slide-status", "Sign in as the administrator to upload photos.");
}

function renderVersions(versions = []) {
  const holder = $("#site-versions");
  if (!holder) return;
  if (!versions.length) { holder.innerHTML = "<p>Nothing has been published from the admin studio yet. The live site shows the built-in content.</p>"; return; }
  holder.innerHTML = `<ol class="fc-version-list">${versions.map((version, index) => `<li><div><strong>${index === 0 ? "LIVE NOW · " : ""}${escapeHTML(when(version.created_at))}</strong><small>${escapeHTML(version.note || "No note")} · ${escapeHTML(version.published_by || "")}</small></div>${index === 0 ? "" : `<button class="button button-light" type="button" data-restore-version="${escapeHTML(version.id)}">Restore this version</button>`}</li>`).join("")}</ol>`;
}

// after: "publish" keeps the editor and message; "restore" shows the restored
// live content in the editor but keeps the message.
async function loadSite(mySession = session, after = "") {
  try {
    const { data } = await api("/api/v1/admin/site");
    if (mySession !== session) return;
    publishedContent = data.published?.content || null;
    renderVersions(data.versions);
    if (after === "publish") return;
    if (after === "restore") { if (publishedContent) writeEditor(publishedContent); return; }
    const draft = data.draft;
    const draftIsNewer = draft && (!data.published || new Date(draft.updated_at) > new Date(data.published.updated_at));
    if (draftIsNewer) {
      writeEditor(draft.content);
      editorStatus(`Unpublished draft loaded (saved ${when(draft.updated_at)}). Preview it, then Publish.`, "ok");
    } else if (data.published) {
      writeEditor(data.published.content);
      editorStatus(`Live content loaded (published ${when(data.published.updated_at)}).`, "ok");
    }
  } catch (error) {
    if (mySession !== session) return;
    editorStatus(error.message, "error");
    if (error.code === "SITE_SCHEMA_NOT_READY") renderVersions([]);
  }
}

// ---------------------------------------------------------------- buttons

$("#save-draft")?.addEventListener("click", async () => {
  try {
    const content = readEditor();
    editorStatus("Saving draft…");
    await api("/api/v1/admin/site/draft", { method: "PUT", body: JSON.stringify({ content }) });
    editorStatus("Draft saved in Neon (not live yet). Press Preview to check it, then Publish.", "ok");
  } catch (error) { editorStatus(error.message, "error"); }
});

function openPreview() {
  let content;
  try { content = readEditor(); } catch (error) { editorStatus(error.message, "error"); return; }
  pendingPreview = content;
  // Same site, so the preview tab can ask this page for the draft. It is not
  // saved anywhere by previewing.
  const tab = window.open("./index.html?preview=1", "fire-counsel-preview");
  if (!tab) { editorStatus("Your browser blocked the preview tab. Allow pop-ups for this site and tap Preview again.", "error"); return; }
  editorStatus("Preview opened in a new tab. Come back here to Publish.", "ok");
}
for (const id of ["#preview-site", "#preview-site-top"]) {
  $(id)?.addEventListener("click", (event) => { event.preventDefault(); openPreview(); });
}
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "fire-counsel-preview-ready" || !event.source) return;
  let content = pendingPreview;
  if (!content) { try { content = JSON.parse(editor.value); } catch { return; } }
  event.source.postMessage({ type: "fire-counsel-preview", content }, location.origin);
});

$("#publish-site")?.addEventListener("click", async () => {
  let content;
  try { content = readEditor(); } catch (error) { editorStatus(error.message, "error"); return; }
  if (!window.confirm("Publish these changes? Every visitor will see them within a minute.")) return;
  const button = $("#publish-site");
  button.disabled = true;
  try {
    editorStatus("Publishing…");
    const note = $("#publish-note")?.value.trim() || "";
    await api("/api/v1/admin/site/publish", { method: "POST", body: JSON.stringify({ content, note }) });
    if ($("#publish-note")) $("#publish-note").value = "";
    editorStatus("Published! The live website now shows these changes.", "ok");
    await loadSite(session, "publish");
  } catch (error) {
    editorStatus(error.message, "error");
  } finally {
    button.disabled = !verified;
  }
});

$("#clear-draft")?.addEventListener("click", () => {
  if (!window.confirm("Throw away the changes in the editor and go back to the live website content?")) return;
  if (publishedContent) {
    writeEditor(publishedContent);
    editorStatus("Editor reset to the live content. Press Save draft if you want to replace the saved draft too.", "ok");
    return;
  }
  fetch("./data/site-content.json", { cache: "no-cache" }).then((r) => r.json()).then((data) => {
    writeEditor(data);
    editorStatus("Editor reset to the live content.", "ok");
  }).catch(() => editorStatus("Could not reload the live content.", "error"));
});

$("#site-versions")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-restore-version]");
  if (!button) return;
  if (!window.confirm("Put this older version back on the live website?")) return;
  button.disabled = true;
  try {
    await api(`/api/v1/admin/site/versions/${encodeURIComponent(button.dataset.restoreVersion)}/restore`, { method: "POST" });
    editorStatus("That version is live again and is now in the editor.", "ok");
    await loadSite(session, "restore");
  } catch (error) {
    editorStatus(error.message, "error");
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- slide photos

// Phone photos are large: shrink to at most 1600 px and re-encode as JPEG
// before uploading (keeps Neon storage and page loads small).
async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error(`${file.name}: choose a JPG, PNG or WEBP photo.`);
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 900 * 1024) { bitmap.close?.(); return file; }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  return blob || file;
}

$("#add-slide-files")?.addEventListener("click", async () => {
  const picker = $("#slide-files");
  const files = [...(picker.files || [])];
  if (!files.length) { setText("#slide-status", "Choose one or more JPG, PNG or WEBP photos first.", "error"); return; }
  let data;
  try { data = readEditor(); } catch (error) { setText("#slide-status", error.message, "error"); return; }
  const button = $("#add-slide-files");
  button.disabled = true;
  let added = 0;
  try {
    for (const [index, file] of files.entries()) {
      setText("#slide-status", `Uploading photo ${index + 1} of ${files.length}…`);
      const body = await shrinkPhoto(file);
      if (body.size > 8 * 1024 * 1024) throw new Error(`${file.name} is still larger than 8 MB.`);
      const { data: image } = await api(`/api/v1/admin/site/images?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": body.type || file.type }, body });
      const template = data.hero.slides.at(-1) || {};
      data.hero.slides.push({ ...template, title: "New slide", accent: "Edit this text", image: image.url, imageAlt: file.name.replace(/\.[a-z0-9]+$/i, ""), imageCredit: "" });
      added++;
    }
  } catch (error) {
    setText("#slide-status", error.message, "error");
  } finally {
    button.disabled = !verified;
    picker.value = "";
    setText("#slide-selection-count", "No photos selected");
  }
  if (added) {
    writeEditor(data);
    setText("#slide-status", `${added} photo${added === 1 ? "" : "s"} uploaded and added as new slide${added === 1 ? "" : "s"}. Edit the slide text in Pages & JSON, then Preview and Publish.`, "ok");
  }
});

// ---------------------------------------------------------------- start
function onAdminState(state) {
  session += 1;
  verified = state === "verified" && Boolean(authClient);
  setEnabled(verified);
  if (verified) loadSite(session);
}

document.addEventListener("fire-counsel:admin-state", (event) => onAdminState(event.detail?.state));
setEnabled(false);
try {
  authClient = await import("./firebase/auth-client.mjs");
  onAdminState($("#admin-auth-status")?.dataset.state);
} catch { /* sign-in not configured: publishing stays disabled */ }
