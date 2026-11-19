// Admin Studio → Student workspace. A form editor for everything on the
// students' dashboard (study.html). "Publish to all students" updates the same
// primary Firestore content as Pages & JSON through the protected publishing
// API, then archives it in Neon. Every API write checks Google/admin separately.
// "Preview" is local to this browser.
import { DEFAULT_WORKSPACE, DESTINATIONS, ICON_NAMES, PROGRESS_KEYS, icon, mergeWorkspace, escapeHTML } from "./workspace-config.mjs";

const $ = (selector) => document.querySelector(selector);
const PREVIEW_KEY = "fire-counsel-workspace-preview";
const editor = $("#ws-admin-editor");

let authClient = null;
let firestoreClient = null;
let verified = false;
let session = 0;
let draft = mergeWorkspace(null);
let dirty = false;

function setStatus(text, kind = "") {
  const node = $("#ws-admin-status");
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}

async function api(path, options = {}) {
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await authClient.apiRequest(path, options);
    const waking = [502, 503, 504].includes(response.status) && !(response.headers.get("content-type") || "").includes("json");
    if (!waking || attempt >= 2 || (options.method && options.method !== "GET")) break;
    setStatus("The server is waking up… retrying");
    await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
  }
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || ([502, 503, 504].includes(response.status) ? "The server is waking up. Wait a minute and try again." : `Request failed (${response.status}).`));
    error.status = response.status;
    throw error;
  }
  return body;
}

// An unavailable archive must not hide the primary Firestore document or
// cause an unknown unpublished draft to be overwritten.
async function archivedSite() {
  try {
    const { data } = await api("/api/v1/admin/site");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The Neon archive reply could not be read.");
    return { data, error: null };
  } catch (error) { return { data: {}, error }; }
}

function setEnabled(on) {
  for (const id of ["ws-admin-preview", "ws-admin-reset", "ws-admin-publish", "ws-admin-preview-2", "ws-admin-publish-2"]) {
    const node = document.getElementById(id);
    if (node) node.disabled = !on;
  }
  editor?.querySelectorAll("input, select, textarea, button").forEach((node) => { node.disabled = !on; });
  const state = $("#ws-admin-state");
  if (state) state.textContent = on ? (dirty ? "UNPUBLISHED CHANGES" : "LIVE · SAVED IN FIREBASE") : "SIGN IN AS ADMIN";
}
function markDirty() {
  dirty = true;
  const state = $("#ws-admin-state");
  if (state && verified) state.textContent = "UNPUBLISHED CHANGES";
}

// ------------------------------------------------------------------ fields
const get = (path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), draft);
function set(path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const parent = keys.reduce((value, key) => value[key], draft);
  parent[last] = value;
}

function textField(path, label, { max = 300, wide = false, area = false, hint = "", type = "text" } = {}) {
  const value = get(path) ?? "";
  const control = area
    ? `<textarea data-path="${path}" maxlength="${max}" rows="3">${escapeHTML(value)}</textarea>`
    : `<input type="${type}" data-path="${path}" maxlength="${max}" value="${escapeHTML(value)}">`;
  return `<label class="${wide ? "fc-ws-wide" : ""}">${escapeHTML(label)}${control}${hint ? `<small>${escapeHTML(hint)}</small>` : ""}</label>`;
}
function linkField(path, label, wide = false) {
  return `<label class="${wide ? "fc-ws-wide" : ""}">${escapeHTML(label)}<input type="text" data-path="${path}" list="ws-destinations" maxlength="300" value="${escapeHTML(get(path) ?? "")}" placeholder="Choose a page or paste a https:// link"></label>`;
}
function checkField(path, label) {
  return `<label class="fc-ws-check"><input type="checkbox" data-path="${path}" ${get(path) ? "checked" : ""}> ${escapeHTML(label)}</label>`;
}
function imageField(path, label) {
  const value = get(path) || "";
  return `<div class="fc-ws-image fc-ws-wide"><span>${escapeHTML(label)}</span><div class="fc-ws-image-row">`
    + `<img alt="" src="${escapeHTML(value)}" ${value ? "" : "hidden"} data-preview-for="${path}">`
    + `<input type="text" data-path="${path}" maxlength="300" value="${escapeHTML(value)}" placeholder="No picture">`
    + `<label class="button button-light fc-ws-upload">Upload photo<input type="file" accept="image/jpeg,image/png,image/webp" data-upload-for="${path}" hidden></label>`
    + `<button class="button button-light" type="button" data-clear-image="${path}">Remove</button></div></div>`;
}
const iconSelect = (path) => `<select data-path="${path}" aria-label="Icon">${Object.entries(ICON_NAMES).map(([key, name]) => `<option value="${key}" ${get(path) === key ? "selected" : ""}>${escapeHTML(name)}</option>`).join("")}</select>`;
function rowTools(list, index, length) {
  return `<span class="fc-ws-row-tools"><button type="button" class="button button-light" data-move="${list}" data-index="${index}" data-step="-1" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>`
    + `<button type="button" class="button button-light" data-move="${list}" data-index="${index}" data-step="1" ${index === length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>`
    + `<button type="button" class="button button-light fc-ws-remove" data-remove="${list}" data-index="${index}" aria-label="Remove">✕</button></span>`;
}

function card(title, help, body, open = false) {
  return `<details class="fc-admin-card fc-ws-card" ${open ? "open" : ""}><summary><strong>${escapeHTML(title)}</strong><small>${escapeHTML(help)}</small></summary><div class="fc-ws-body">${body}</div></details>`;
}

function render() {
  if (!editor) return;
  const open = new Set([...editor.querySelectorAll("details[open]")].map((node) => node.dataset.card));
  const first = !editor.children.length;
  const menuRows = draft.menu.map((item, i) => `<div class="fc-ws-row"><span class="fc-ws-icon">${icon(item.icon)}</span>${iconSelect(`menu.${i}.icon`)}<input type="text" data-path="menu.${i}.label" maxlength="60" value="${escapeHTML(item.label)}" aria-label="Menu label"><input type="text" data-path="menu.${i}.link" list="ws-destinations" maxlength="300" value="${escapeHTML(item.link)}" aria-label="Opens"><label class="fc-ws-check"><input type="checkbox" data-path="menu.${i}.show" ${item.show ? "checked" : ""}> Show</label>${rowTools("menu", i, draft.menu.length)}</div>`).join("");
  const tileRows = draft.tiles.map((item, i) => `<div class="fc-ws-row fc-ws-row-tile"><span class="fc-ws-icon">${icon(item.icon)}</span>${iconSelect(`tiles.${i}.icon`)}<input type="text" data-path="tiles.${i}.title" maxlength="60" value="${escapeHTML(item.title)}" aria-label="Tile title"><input type="text" data-path="tiles.${i}.subtitle" maxlength="90" value="${escapeHTML(item.subtitle)}" aria-label="Short description"><input type="text" data-path="tiles.${i}.link" list="ws-destinations" maxlength="300" value="${escapeHTML(item.link)}" aria-label="Opens"><label class="fc-ws-check"><input type="checkbox" data-path="tiles.${i}.show" ${item.show ? "checked" : ""}> Show</label><label class="fc-ws-check"><input type="checkbox" data-path="tiles.${i}.wide" ${item.wide ? "checked" : ""}> Wide</label>${rowTools("tiles", i, draft.tiles.length)}</div>`).join("");
  const goalRows = draft.progress.items.map((item, i) => `<div class="fc-ws-row"><select data-path="progress.items.${i}.key" aria-label="What is counted">${Object.entries(PROGRESS_KEYS).map(([key, name]) => `<option value="${key}" ${item.key === key ? "selected" : ""}>Counts: ${escapeHTML(name)}</option>`).join("")}</select><input type="text" data-path="progress.items.${i}.label" maxlength="60" value="${escapeHTML(item.label)}" aria-label="Label"><label class="fc-ws-goal">Goal<input type="number" min="1" max="10000" data-path="progress.items.${i}.goal" value="${item.goal}"></label>${rowTools("progress.items", i, draft.progress.items.length)}</div>`).join("");
  const deadlineRows = draft.deadlines.items.map((item, i) => `<div class="fc-ws-row"><input type="date" data-path="deadlines.items.${i}.date" value="${escapeHTML(item.date)}" aria-label="Date"><input type="text" data-path="deadlines.items.${i}.title" maxlength="120" value="${escapeHTML(item.title)}" aria-label="What is due" placeholder="e.g. CBT Practice Test: Constitutional Law"><input type="text" data-path="deadlines.items.${i}.link" list="ws-destinations" maxlength="300" value="${escapeHTML(item.link || "")}" aria-label="Link (optional)" placeholder="Link (optional)">${rowTools("deadlines.items", i, draft.deadlines.items.length)}</div>`).join("");
  const noticeRows = draft.notices.map((text, i) => `<div class="fc-ws-row"><input type="text" class="fc-ws-grow" data-path="notices.${i}" maxlength="300" value="${escapeHTML(text)}" aria-label="Notice">${rowTools("notices", i, draft.notices.length)}</div>`).join("");

  const cards = [
    ["welcome", "Welcome banner", "The big picture banner at the top", `<div class="fc-ws-grid">${textField("welcome.title", "First line")}${textField("welcome.accent", "Second line (blue italic)")}${textField("welcome.tagline", "Short sentence", { wide: true })}${textField("welcome.buttonLabel", "Button text", { hint: "Leave empty to hide the button." })}${linkField("welcome.buttonLink", "Button opens")}${imageField("welcome.image", "Banner picture (wide photo)")}${textField("welcome.imageAlt", "Picture description (for blind students)", { wide: true })}</div>`],
    ["tiles", "Tool tiles", "The boxes under the banner (title, short description, what it opens)", `<div class="fc-ws-rows">${tileRows || "<p>No tiles.</p>"}</div><button type="button" class="button button-light" data-add="tiles">+ Add a tile</button>`],
    ["menu", "Side menu", "The list of links on the left (or behind ☰ on phones)", `<div class="fc-ws-rows">${menuRows || "<p>No menu links.</p>"}</div><button type="button" class="button button-light" data-add="menu">+ Add a menu link</button>`],
    ["ai", "Fire Counsel AI box", "The box where students type a question", `<div class="fc-ws-grid">${checkField("ai.show", "Show this box")}${textField("ai.title", "Title")}${textField("ai.subtitle", "Subtitle")}${textField("ai.intro", "Message", { wide: true, area: true, max: 400 })}${textField("ai.placeholder", "Text inside the empty question box")}${textField("ai.footer", "Small line at the bottom")}</div>`],
    ["quote", "Quote card", "The motivational card on the right", `<div class="fc-ws-grid">${checkField("quote.show", "Show this card")}${textField("quote.text", "Quote", { wide: true, area: true })}${textField("quote.brand", "Name under the quote")}${textField("quote.subline", "Line under the name")}${imageField("quote.image", "Background picture (tall photo)")}</div>`],
    ["progress", "Academic progress", "The progress circle. Each goal counts something the student does on their device.", `<div class="fc-ws-grid">${checkField("progress.show", "Show this card")}${textField("progress.title", "Title")}${textField("progress.cheer", "Encouragement title")}${textField("progress.cheerText", "Encouragement sentence")}</div><div class="fc-ws-rows">${goalRows}</div>${draft.progress.items.length < 6 ? `<button type="button" class="button button-light" data-add="progress.items">+ Add a goal</button>` : ""}`],
    ["deadlines", "Class deadlines", "Dates every student sees (assignments, tests, exams). Past dates disappear by themselves. Students also add their own in the Study Planner.", `<div class="fc-ws-grid">${checkField("deadlines.show", "Show the deadlines card")}${textField("deadlines.title", "Title")}</div><div class="fc-ws-rows">${deadlineRows || "<p>No class deadlines yet.</p>"}</div><button type="button" class="button button-light" data-add="deadlines.items">+ Add a deadline</button>`],
    ["notices", "Notices (bell)", "Short messages shown when students tap the bell", `<div class="fc-ws-rows">${noticeRows || "<p>No notices.</p>"}</div>${draft.notices.length < 10 ? `<button type="button" class="button button-light" data-add="notices">+ Add a notice</button>` : ""}`],
    ["other", "Name, logo, search and help", "Top-left name and logo, the search box, the Need Help card and the courses list", `<div class="fc-ws-grid">${textField("brand.name", "Name")}${textField("brand.tagline", "Line under the name")}${imageField("brand.logo", "Logo (square picture)")}${textField("search.placeholder", "Text inside the search box", { wide: true })}${checkField("help.show", "Show the Need Help card")}${textField("help.title", "Need Help title")}${textField("help.subtitle", "Need Help line")}${linkField("help.link", "Need Help opens")}${checkField("courses.show", "Show the courses list on the dashboard")}${textField("courses.title", "Courses list title")}</div>`]
  ];
  editor.innerHTML = cards.map(([key, title, help, body], index) => card(title, help, body, first ? index === 0 : open.has(key)).replace("<details ", `<details data-card="${key}" `)).join("");
  if (!verified) editor.querySelectorAll("input, select, textarea, button").forEach((node) => { node.disabled = true; });
}

const BLANK = {
  menu: () => ({ icon: "link", label: "New link", link: `#dashboard`, show: true }),
  tiles: () => ({ icon: "link", title: "New tile", subtitle: "Short description", link: `#dashboard`, show: true, wide: false }),
  "progress.items": () => ({ key: "cards", label: PROGRESS_KEYS.cards, goal: 10 }),
  "deadlines.items": () => ({ date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), title: "", link: "" }),
  notices: () => ""
};

editor?.addEventListener("input", (event) => {
  const path = event.target.dataset?.path;
  if (!path) return;
  const field = event.target;
  set(path, field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value);
  markDirty();
  if (/\.icon$/.test(path)) { const holder = field.closest(".fc-ws-row")?.querySelector(".fc-ws-icon"); if (holder) holder.innerHTML = icon(field.value); }
  const preview = editor.querySelector(`[data-preview-for="${path}"]`);
  if (preview) { preview.src = field.value; preview.hidden = !field.value; }
});
editor?.addEventListener("change", (event) => {
  if (event.target.dataset?.path && event.target.type === "checkbox") event.target.dispatchEvent(new Event("input", { bubbles: true }));
  const target = event.target.dataset?.uploadFor;
  if (target) uploadImage(target, event.target);
});
editor?.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add]");
  const move = event.target.closest("[data-move]");
  const remove = event.target.closest("[data-remove]");
  const clear = event.target.closest("[data-clear-image]");
  if (add) { get(add.dataset.add).push(BLANK[add.dataset.add]()); markDirty(); render(); return; }
  if (move) {
    const list = get(move.dataset.move);
    const from = Number(move.dataset.index);
    const to = from + Number(move.dataset.step);
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    markDirty(); render(); return;
  }
  if (remove) { get(remove.dataset.remove).splice(Number(remove.dataset.index), 1); markDirty(); render(); return; }
  if (clear) { set(clear.dataset.clearImage, ""); markDirty(); render(); }
});

// Phone photos are large: shrink to at most 1600 px (JPEG) before uploading.
async function shrinkPhoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPG, PNG or WEBP photo.");
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
async function uploadImage(path, input) {
  const file = input.files?.[0];
  if (!file || !verified) return;
  try {
    setStatus("Uploading the photo…");
    const body = await shrinkPhoto(file);
    if (body.size > 8 * 1024 * 1024) throw new Error("The photo is still larger than 8 MB.");
    const { data } = await api(`/api/v1/admin/site/images?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": body.type || file.type }, body });
    set(path, data.url);
    markDirty();
    render();
    setStatus("Photo uploaded. Press Preview to see it, then Publish to all students.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    input.value = "";
  }
}

// ------------------------------------------------------------------ load / preview / publish
function cleaned() {
  // Same clean-up the student page does, so the preview and the live page match.
  const result = mergeWorkspace(JSON.parse(JSON.stringify(draft)));
  return result;
}

async function loadWorkspace(mySession = session) {
  setStatus("Loading the student workspace settings…");
  try {
    const [{ data, error: archiveError }, live] = await Promise.all([
      archivedSite(),
      firestoreClient?.loadPublicSiteContent() || null
    ]);
    if (mySession !== session) return;
    let workspace = (live || data.published?.content)?.workspace;
    if (workspace === undefined && !live) {
      try { workspace = (await (await fetch("./data/site-content.json", { cache: "no-cache" })).json())?.workspace; } catch { workspace = null; }
    }
    // A verified-state event can start a newer Firebase load while this older
    // fallback is in flight. Never let its late reply overwrite the live form.
    if (mySession !== session) return;
    draft = mergeWorkspace(workspace || null);
    dirty = false;
    render();
    setEnabled(true);
    const loaded = workspace ? "The live student workspace is loaded. Edit it, press Preview, then Publish to all students." : "Students currently see the original design. Edit it below, press Preview, then Publish to all students.";
    setStatus(archiveError ? `${loaded} Neon drafts/history are unavailable: ${archiveError.message}` : loaded, archiveError ? "error" : "ok");
  } catch (error) {
    if (mySession !== session) return;
    render();
    setEnabled(true);
    setStatus(`${error.message} You can still edit and preview; publishing needs the server.`, "error");
  }
}

function preview() {
  try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(cleaned())); } catch { setStatus("This browser blocked saving the preview.", "error"); return; }
  const opened = window.open("./study.html?preview=workspace", "_blank", "noopener");
  setStatus(opened === null ? "Allow pop-ups for this site, or open study.html?preview=workspace in a new tab." : "Preview opened in a new tab (only you can see it).", "ok");
}

async function publish(button) {
  if (!verified) return;
  const mySession = session;
  const workspace = cleaned();
  if (!workspace.menu.some((item) => item.show)) { setStatus("Keep at least one menu link visible.", "error"); return; }
  for (const id of ["ws-admin-publish", "ws-admin-publish-2"]) { const node = document.getElementById(id); if (node) node.disabled = true; }
  setStatus("Publishing to all students…");
  try {
    if (!firestoreClient) throw new Error("The Firebase publish client could not load. Reload this page online before publishing.");
    // Start from the primary live document, not a possibly stale Neon archive.
    const [{ data, error: archiveReadError }, live] = await Promise.all([
      archivedSite(), firestoreClient.loadPublicSiteContent()
    ]);
    let base = live || data.published?.content;
    if (!base) base = await (await fetch("./data/site-content.json", { cache: "no-cache" })).json();
    if (mySession !== session || !verified) return;
    const content = { ...base, workspace };
    const draftSlot = data.draft;
    const draftIsNewer = draftSlot && (!data.published || new Date(draftSlot.updated_at) > new Date(data.published.updated_at));
    await firestoreClient.publishSiteContent(content);
    if (mySession !== session) return;
    let archiveError = archiveReadError;
    if (!archiveReadError) try {
      await api("/api/v1/admin/site/publish", { method: "POST", body: JSON.stringify({ content, note: "Student workspace updated" }) });
      if (mySession !== session) return;
      // Preserve unpublished Pages & JSON edits when updating the workspace.
      if (draftIsNewer) await api("/api/v1/admin/site/draft", { method: "PUT", body: JSON.stringify({ content: { ...draftSlot.content, workspace } }) });
    } catch (error) { archiveError = error; }
    if (mySession !== session) return;
    syncJsonEditor(workspace);
    draft = mergeWorkspace(workspace);
    dirty = false;
    setEnabled(true);
    setStatus(archiveError
      ? `Live on Firebase, but the Neon archive/draft could not be saved: ${archiveError.message}`
      : "Published on Firebase and archived in Neon. Students see the new workspace on their next refresh.", archiveError ? "error" : "ok");
  } catch (error) {
    if (mySession === session) setStatus(`Firebase publishing was not confirmed; the Neon archive was not changed: ${error.message}`, "error");
  } finally {
    for (const id of ["ws-admin-publish", "ws-admin-publish-2"]) { const node = document.getElementById(id); if (node) node.disabled = !verified; }
  }
}

// Keep the Pages & JSON editor in step, so publishing from there later does
// not bring back the old workspace.
function syncJsonEditor(workspace) {
  const json = $("#json-editor");
  if (!json) return;
  try {
    const content = JSON.parse(json.value);
    if (!content || typeof content !== "object") return;
    content.workspace = workspace;
    json.value = JSON.stringify(content, null, 2);
    json.dispatchEvent(new Event("input"));
  } catch { /* the JSON editor holds unfinished text; leave it */ }
}

for (const id of ["ws-admin-preview", "ws-admin-preview-2"]) document.getElementById(id)?.addEventListener("click", preview);
for (const id of ["ws-admin-publish", "ws-admin-publish-2"]) document.getElementById(id)?.addEventListener("click", (event) => publish(event.currentTarget));
$("#ws-admin-reset")?.addEventListener("click", () => {
  if (!window.confirm("Replace your edits with the original FIRE COUNSEL design? Nothing changes for students until you publish.")) return;
  draft = mergeWorkspace(JSON.parse(JSON.stringify(DEFAULT_WORKSPACE)));
  markDirty();
  render();
  setStatus("The original design is loaded. Press Publish to all students to use it.", "ok");
});

const destinations = $("#ws-destinations");
if (destinations) destinations.innerHTML = DESTINATIONS.map(([value, label]) => `<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`).join("");

window.addEventListener("beforeunload", (event) => { if (dirty && verified) { event.preventDefault(); event.returnValue = ""; } });

function onAdminState(state) {
  session += 1;
  verified = state === "verified" && Boolean(authClient);
  setEnabled(verified);
  if (verified) loadWorkspace(session);
  else { render(); setStatus("Sign in as the administrator to edit the student workspace."); }
}

render();
document.addEventListener("fire-counsel:admin-state", (event) => onAdminState(event.detail?.state));
try {
  authClient = await import("./firebase/auth-client.mjs");
  firestoreClient = await import("./firebase/firestore-client.mjs");
  onAdminState($("#admin-auth-status")?.dataset.state);
} catch { /* sign-in not configured: the editor stays read-only */ }
