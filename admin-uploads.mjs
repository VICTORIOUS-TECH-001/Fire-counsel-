// Admin Studio: upload PDFs, Word files, photos and text into the Neon
// library (course materials, case judgments, past-question papers). The file
// is sent as-is; the server reads it in the background (pdf.js for digital
// PDFs, AI OCR for scans) and this page shows the progress.
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const PURPOSE_LABEL = { material: "Course material", case: "Case judgment", past_questions: "Past-question paper", material_version: "New version" };
const STATUS_LABEL = { uploaded: "Waiting", processing: "Reading…", ready: "Check the text", saved: "Saved", failed: "Failed" };
const METHOD_LABEL = { pdf_text: "PDF text (no AI needed)", docx: "Word file", text: "Text file", ocr_space: "OCR.space" };

let authClient = null;
let verified = false;
let session = 0;
let rows = [];
let pollTimer = null;
let usage = null;
let viewing = null;

function setText(selector, text, kind = "") {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  node.dataset.kind = kind;
}
const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const method = (value) => (!value ? "" : METHOD_LABEL[value] || value.replace(/^pdf_text\+/, "PDF text + ").replace(/ai_ocr:(\w+)/, "AI reading ($1)"));

async function api(path, options = {}) {
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await authClient.apiRequest(path, options);
    const waking = [502, 503, 504].includes(response.status) && !(response.headers.get("content-type") || "").includes("json");
    if (!waking || attempt >= 2 || (options.method && options.method !== "GET")) break;
    setText("#upload-status", "The server is waking up… retrying");
    await new Promise((resolve) => setTimeout(resolve, 4000 * (attempt + 1)));
  }
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const waking = [502, 503, 504].includes(response.status) && !body.code;
    const error = new Error(body.error || (waking ? "The server is waking up or restarting (Render free plan). Wait about a minute, then try again." : `Request failed (${response.status}).`));
    error.status = response.status;
    error.code = body.code;
    error.data = body.data;
    throw error;
  }
  return body;
}

function setEnabled(on) {
  for (const id of ["#upload-submit", "#upload-refresh", "#upload-files"]) {
    const node = $(id);
    if (node) node.disabled = !on;
  }
  setText("#uploads-panel-status", on ? "LIVE · SAVED IN NEON" : "SIGN IN AS ADMIN");
  if (!on) {
    rows = [];
    renderRows();
    closeViewer();
    clearTimeout(pollTimer);
  }
}

// ---------------------------------------------------------------- form

function updateFields() {
  const purpose = $("#upload-purpose").value;
  const show = (selector, visible) => { const node = $(selector); if (node) node.hidden = !visible; };
  show("#upload-course-field", purpose !== "material_version");
  show("#upload-material-field", purpose === "material_version");
  show("#upload-case-field", purpose === "case");
  show("#upload-type-field", purpose === "material");
  show("#upload-paper-fields", purpose === "past_questions");
  show("#upload-title-field", purpose !== "material_version");
  const help = {
    material: "Lecture notes, textbook chapters, handouts or statutes. Students' AI answers will quote them with page numbers.",
    case: "A judgment or law report. The AI fills in the case record (name, citation, court, facts, ratio…) and keeps the full text for case analysis. Choose an existing case to attach the judgment to it instead.",
    past_questions: "A past examination paper. The AI splits it into separate questions for the question setter. Choose the course.",
    material_version: "Replace the text of an existing material with a newer file (the old version is kept)."
  }[purpose];
  setText("#upload-help", help);
  const course = $("#upload-course");
  if (course?.options[0]) course.options[0].textContent = purpose === "past_questions" ? "Choose the course…" : "No specific course (all students)";
}

async function loadOptions(resource, select, firstLabel, mySession) {
  if (!select) return;
  try {
    const { data } = await api(`/api/v1/admin/database/options/${resource}?limit=500`);
    if (mySession !== session) return;
    const current = select.value;
    select.innerHTML = `<option value="">${escapeHTML(firstLabel)}</option>${data.map((item) => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.label || item.id)}</option>`).join("")}`;
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  } catch { /* dropdown keeps its first option; the server validates anyway */ }
}

async function loadUsage(mySession = session) {
  try {
    const { data } = await api("/api/v1/admin/documents/usage");
    if (mySession !== session) return;
    usage = data;
    const ocr = data.ocr.ai ? "Scans and photos are read by your Gemini key." : data.ocr.ocr_space ? "Scans are read by OCR.space (small files only)." : "Scans and photos cannot be read until GEMINI_API_KEY is set in Render; digital PDFs and Word files work.";
    setText("#upload-usage", `File storage: ${size(data.used_bytes)} of ${size(data.budget_bytes)} used (${data.files} file${data.files === 1 ? "" : "s"}). Up to ${size(data.max_file_bytes)} per file. ${ocr}`, data.used_bytes > data.budget_bytes * 0.9 ? "error" : "");
  } catch (error) {
    if (mySession === session) setText("#upload-usage", error.message, "error");
  }
}

$("#upload-purpose")?.addEventListener("change", updateFields);

$("#upload-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!verified) return;
  const files = [...($("#upload-files").files || [])];
  if (!files.length) { setText("#upload-status", "Choose at least one file.", "error"); return; }
  const purpose = $("#upload-purpose").value;
  const params = new URLSearchParams({ purpose });
  const course = $("#upload-course").value;
  if (purpose === "past_questions" && !course) { setText("#upload-status", "Choose the course this past-question paper belongs to.", "error"); return; }
  if (purpose === "material_version" && !$("#upload-material").value) { setText("#upload-status", "Choose the material to update.", "error"); return; }
  if (course && purpose !== "material_version") params.set("course_id", course);
  if (purpose === "material_version") params.set("material_id", $("#upload-material").value);
  if (purpose === "case" && $("#upload-case").value) params.set("case_id", $("#upload-case").value);
  if (purpose === "material") params.set("material_type", $("#upload-type").value);
  if (purpose === "past_questions") {
    if ($("#upload-year").value) params.set("examination_year", $("#upload-year").value);
    if ($("#upload-semester").value.trim()) params.set("semester", $("#upload-semester").value.trim());
  }
  if (!$("#upload-publish").checked) params.set("publish", "0");
  if ($("#upload-review").checked) params.set("auto_save", "0");
  const title = $("#upload-title").value.trim();
  const button = $("#upload-submit");
  button.disabled = true;
  const done = [];
  const problems = [];
  for (const [index, file] of files.entries()) {
    if (usage && file.size > usage.max_file_bytes) { problems.push(`${file.name}: larger than ${size(usage.max_file_bytes)}`); continue; }
    const one = new URLSearchParams(params);
    one.set("name", file.name);
    if (title && purpose !== "material_version") one.set("title", files.length > 1 ? `${title} (${index + 1})` : title);
    setText("#upload-status", `Uploading ${file.name} (${size(file.size)})${files.length > 1 ? ` — ${index + 1} of ${files.length}` : ""}…`);
    try {
      await api(`/api/v1/admin/documents?${one}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      done.push(file.name);
    } catch (error) {
      problems.push(error.code === "DUPLICATE_FILE" ? `${file.name}: already uploaded (see the list below)` : `${file.name}: ${error.message}`);
    }
  }
  button.disabled = !verified;
  if (done.length) { $("#upload-files").value = ""; $("#upload-title").value = ""; }
  setText("#upload-status", [done.length ? `${done.length} file${done.length === 1 ? "" : "s"} uploaded — reading now. You can leave this page; it continues on the server.` : "", ...problems].filter(Boolean).join(" · "), problems.length ? "error" : "ok");
  await refresh();
});

// ---------------------------------------------------------------- list

function resultSummary(row) {
  const r = row.result || {};
  if (row.status === "saved") {
    if (row.purpose === "case") return `Case: <b>${escapeHTML(r.case_name || "")}</b>${r.filled ? ` (filled ${r.filled.length} empty field${r.filled.length === 1 ? "" : "s"})` : ""}`;
    if (row.purpose === "past_questions") return `${r.questions || 0} question${r.questions === 1 ? "" : "s"} added (marked “pending” — check them in Database data → Past questions)`;
    return `Material: <b>${escapeHTML(r.title || "")}</b> · version ${escapeHTML(r.version_number)} · ${escapeHTML(r.chunks)} searchable part${r.chunks === 1 ? "" : "s"}`;
  }
  if (row.status === "failed") return `<span class="fc-upload-error">${escapeHTML(row.error_message || "Failed")}</span>`;
  if (row.status === "ready") return "Text is ready: tap <b>Check text</b>, correct it if needed, then Save.";
  return escapeHTML(row.progress || "Waiting…");
}

function renderRows() {
  const body = $("#upload-rows");
  if (!body) return;
  if (!rows.length) { body.innerHTML = `<tr><td colspan="4">${verified ? "No uploads yet." : "Sign in as the administrator to see uploads."}</td></tr>`; return; }
  body.innerHTML = rows.map((row) => {
    const warnings = (row.warnings || []).length ? `<small class="fc-upload-warning">⚠ ${row.warnings.map(escapeHTML).join(" · ")}</small>` : "";
    const busy = row.status === "uploaded" || row.status === "processing";
    const actions = [
      row.status === "ready" || row.status === "saved" ? `<button class="button button-light" type="button" data-upload-view="${escapeHTML(row.id)}">${row.status === "ready" ? "Check text" : "View text"}</button>` : "",
      row.status === "failed" ? `<button class="button button-primary" type="button" data-upload-retry="${escapeHTML(row.id)}">Retry</button>` : "",
      row.has_file ? `<button class="button button-light" type="button" data-upload-download="${escapeHTML(row.id)}">Download</button>` : "",
      !busy && row.has_file ? `<button class="button button-light" type="button" data-upload-delete="${escapeHTML(row.id)}" title="Frees storage; the saved library text stays">Delete file</button>` : "",
      !busy && !row.has_file ? `<button class="button button-light" type="button" data-upload-remove="${escapeHTML(row.id)}">Remove from list</button>` : ""
    ].filter(Boolean).join(" ");
    return `<tr data-status="${escapeHTML(row.status)}">
      <td><strong>${escapeHTML(row.file_name)}</strong><small>${escapeHTML(PURPOSE_LABEL[row.purpose] || row.purpose)} · ${size(row.size_bytes)}${row.page_count ? ` · ${row.page_count} page${row.page_count === 1 ? "" : "s"}` : ""}</small></td>
      <td><span class="fc-state" data-upload-state="${escapeHTML(row.status)}">${escapeHTML(STATUS_LABEL[row.status] || row.status)}</span><small>${escapeHTML(method(row.method))}</small></td>
      <td>${resultSummary(row)}${warnings}</td>
      <td class="fc-upload-actions">${actions}</td>
    </tr>`;
  }).join("");
}

async function refresh(mySession = session) {
  clearTimeout(pollTimer);
  if (!verified) return;
  try {
    const { data } = await api("/api/v1/admin/documents?limit=40");
    if (mySession !== session) return;
    rows = data;
    renderRows();
    if (rows.some((row) => row.status === "uploaded" || row.status === "processing")) {
      pollTimer = setTimeout(() => refresh(mySession), document.hidden ? 15000 : 3000);
    } else {
      loadUsage(mySession);
    }
  } catch (error) {
    if (mySession !== session) return;
    setText("#upload-status", error.message, "error");
    if (error.code === "UPLOADS_SCHEMA_NOT_READY") {
      $("#upload-rows").innerHTML = `<tr><td colspan="4">${escapeHTML(error.message)}</td></tr>`;
    }
  }
}

$("#upload-refresh")?.addEventListener("click", () => { refresh(); loadUsage(); });

async function download(id) {
  const row = rows.find((item) => item.id === id);
  const response = await authClient.apiRequest(`/api/v1/admin/documents/${encodeURIComponent(id)}/file`);
  if (!response.ok) throw new Error("The original file is not stored any more.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = row?.file_name || "document";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

$("#upload-rows")?.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const { uploadView, uploadRetry, uploadDownload, uploadDelete, uploadRemove } = button.dataset;
  button.disabled = true;
  try {
    if (uploadView) await openViewer(uploadView);
    if (uploadRetry) { await api(`/api/v1/admin/documents/${encodeURIComponent(uploadRetry)}/retry`, { method: "POST" }); await refresh(); }
    if (uploadDownload) await download(uploadDownload);
    if (uploadDelete && window.confirm("Delete the original file to free space? The text already saved in the library stays, but the file cannot be read again.")) {
      await api(`/api/v1/admin/documents/${encodeURIComponent(uploadDelete)}`, { method: "DELETE" });
      await refresh();
    }
    if (uploadRemove) { await api(`/api/v1/admin/documents/${encodeURIComponent(uploadRemove)}?remove=1`, { method: "DELETE" }); await refresh(); }
  } catch (error) {
    setText("#upload-status", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- text viewer

function closeViewer() {
  viewing = null;
  const viewer = $("#upload-viewer");
  if (viewer) viewer.hidden = true;
}

async function openViewer(id) {
  const { data } = await api(`/api/v1/admin/documents/${encodeURIComponent(id)}`);
  viewing = data;
  $("#upload-viewer").hidden = false;
  $("#upload-viewer-title").textContent = data.file_name;
  const text = $("#upload-text");
  text.value = data.text || "";
  text.readOnly = data.status !== "ready";
  $("#upload-save-text").hidden = data.status !== "ready";
  setText("#upload-viewer-status", data.status === "ready"
    ? "Correct any reading mistakes. Keep the [Page N] lines so answers can cite page numbers. Then press Save to library."
    : `${(data.characters || data.text?.length || 0).toLocaleString()} characters · ${method(data.method)}. This text is what the AI reads.`);
  $("#upload-viewer").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#upload-viewer-close")?.addEventListener("click", closeViewer);
$("#upload-copy-text")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#upload-text").value); setText("#upload-viewer-status", "Copied.", "ok"); }
  catch { $("#upload-text").select(); setText("#upload-viewer-status", "Select all and copy manually.", "error"); }
});
$("#upload-save-text")?.addEventListener("click", async () => {
  if (!viewing) return;
  const button = $("#upload-save-text");
  button.disabled = true;
  try {
    setText("#upload-viewer-status", "Saving to the library…");
    await api(`/api/v1/admin/documents/${encodeURIComponent(viewing.id)}/save`, { method: "POST", body: JSON.stringify({ text: $("#upload-text").value }) });
    setText("#upload-viewer-status", "Saved to the library.", "ok");
    closeViewer();
    await refresh();
  } catch (error) {
    setText("#upload-viewer-status", error.message, "error");
  } finally {
    button.disabled = false;
  }
});

// ---------------------------------------------------------------- start
function onAdminState(state) {
  session += 1;
  verified = state === "verified" && Boolean(authClient);
  setEnabled(verified);
  if (!verified) return;
  const mySession = session;
  loadUsage(mySession);
  refresh(mySession);
  loadOptions("courses", $("#upload-course"), "No specific course (all students)", mySession).then(updateFields);
  loadOptions("materials", $("#upload-material"), "Choose the material…", mySession);
  loadOptions("legal_cases", $("#upload-case"), "Create a new case record", mySession);
}

updateFields();
document.addEventListener("fire-counsel:admin-state", (event) => onAdminState(event.detail?.state));
document.addEventListener("visibilitychange", () => { if (!document.hidden && verified && rows.some((row) => row.status === "processing" || row.status === "uploaded")) refresh(); });
try {
  authClient = await import("./firebase/auth-client.mjs");
  onAdminState($("#admin-auth-status")?.dataset.state);
} catch { /* sign-in not configured: uploads stay disabled */ }
