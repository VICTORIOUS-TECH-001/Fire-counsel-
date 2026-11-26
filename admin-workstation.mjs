// Counsel Working Station: an approval-first document desk alongside the
// classic uploader. No keys, files, instructions or drafts are cached locally.
import { adminResponse, statusRetryDelay } from "./admin-network.mjs";

const $ = selector => document.querySelector(selector);
let authClient;
let verified = false;
let session = 0;
let revision = 0;
let selectedFile = null;
let activeId = null;
let readyId = null;
let result = null;
let docName = "Reviewed document.txt";
let phase = "idle";
let timer;
let config;
let saved = false;
let approvalSnapshot = null;
let pollPending = null;
let pollNotBefore = 0;
let pollFailures = 0;
let pollExhausted = false;
let activeInstructions = "";
let testingProvider = false;
const busy = () => ["starting", "polling", "saving"].includes(phase);
const setText = (selector, text, kind = "") => { const node = $(selector); node.textContent = text; node.dataset.kind = kind; };

async function api(path, options = {}) {
  const read = !options.method || ["GET", "HEAD"].includes(options.method);
  const request = read && !options.signal && globalThis.AbortSignal?.timeout ? { ...options, signal: AbortSignal.timeout(30_000) } : options;
  return (await adminResponse(await authClient.apiRequest(path, request))).data;
}

function mode(value) {
  const classic = value === "classic";
  $("#station-panel").hidden = classic;
  $("#classic-upload-panel").hidden = !classic;
  for (const button of document.querySelectorAll("[data-upload-mode]")) {
    const selected = button.dataset.uploadMode === (classic ? "classic" : "station");
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  document.dispatchEvent(new CustomEvent("fire-counsel:upload-mode", { detail: { mode: classic ? "classic" : "station" } }));
}
for (const button of document.querySelectorAll("[data-upload-mode]")) {
  button.addEventListener("click", () => mode(button.dataset.uploadMode));
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === "Home" ? $("#station-mode") : event.key === "End" ? $("#classic-upload-mode")
      : button.dataset.uploadMode === "station" ? $("#classic-upload-mode") : $("#station-mode");
    mode(target.dataset.uploadMode); target.focus();
  });
}

function fields() {
  const version = $("#station-purpose").value === "material_version";
  $("#station-material-field").hidden = !version;
  $("#station-material").required = version;
  for (const id of ["station-course-field", "station-type-field", "station-publish-field"]) document.getElementById(id).hidden = version;
  $("#station-version-note").hidden = !version;
}

function controls() {
  const pending = busy() || Boolean(activeId);
  const locked = !verified || pending || Boolean(approvalSnapshot);
  for (const id of ["station-input", "station-file-input", "station-attach", "station-tool", "station-provider", "station-paste", "station-remove-file"]) document.getElementById(id).disabled = locked;
  for (const button of document.querySelectorAll("[data-station-tool]")) button.disabled = locked;
  $("#station-new").disabled = !verified || phase === "saving" || Boolean(approvalSnapshot);
  $("#station-submit").disabled = !verified || busy() || Boolean(approvalSnapshot);
  $("#station-submit").firstElementChild.textContent = activeId && phase === "paused" ? "Check progress" : readyId ? "Refine again" : "Process";
  $("#station-progress").hidden = !busy();
  $("#station-output").disabled = !verified || !result || pending || saved || Boolean(approvalSnapshot);
  $("#station-download").disabled = !verified || !result || !$("#station-output").value.trim();
  for (const element of $("#station-save-form").elements) element.disabled = !verified || !result || pending || saved || Boolean(approvalSnapshot);
  const acknowledged = !result?.truncated || $("#station-incomplete").checked;
  $("#station-save").disabled = !verified || !result || pending || saved || config?.database !== "ready"
    || (!approvalSnapshot && (!$("#station-approval").checked || !acknowledged || !$("#station-output").value.trim()));
  $("#station-save").textContent = phase === "saving" ? "Confirming the save…" : approvalSnapshot ? "Retry the same save" : saved ? "Saved to Neon ✓" : "Approve & save to Neon ↗";
  $("#station-refresh-connections").disabled = !verified || testingProvider;
  for (const button of document.querySelectorAll("[data-station-test]")) button.disabled = !verified || testingProvider || busy() || !config?.providers?.[button.dataset.stationTest]?.configured;
  fields();
}

function reset() {
  clearTimeout(timer);
  revision++;
  pollPending = null; pollNotBefore = 0; pollFailures = 0; pollExhausted = false; activeInstructions = ""; testingProvider = false;
  setText("#station-test-status", "Provider tests run only when you press a test button; they use the selected admin service quota.");
  selectedFile = null; activeId = null; readyId = null; result = null; saved = false; approvalSnapshot = null;
  docName = "Reviewed document.txt"; phase = "idle";
  for (const id of ["station-file-input", "station-input", "station-paste", "station-output", "station-title"]) document.getElementById(id).value = "";
  $("#station-tool").value = "correct";
  $("#station-provider").value = "auto";
  $("#station-purpose").value = "material";
  $("#station-type").value = "lecture_note";
  $("#station-course").value = "";
  $("#station-material").value = "";
  for (const id of ["station-approval", "station-publish", "station-incomplete"]) document.getElementById(id).checked = false;
  $("#station-chat").replaceChildren(); $("#station-chat").hidden = true;
  $("#station-source").textContent = "";
  $("#station-file-name").textContent = "";
  $("#station-file").hidden = true;
  $("#station-empty").hidden = false;
  $("#station-review").hidden = true;
  $("#station-warnings").replaceChildren(); $("#station-warnings").hidden = true;
  $("#station-incomplete-field").hidden = true;
  setText("#station-save-status", "No document is saved automatically.");
  controls();
}

function message(role, text) {
  $("#station-empty").hidden = true;
  const log = $("#station-chat");
  log.hidden = false;
  const node = document.createElement("div");
  node.className = "station-message"; node.dataset.role = role;
  const label = document.createElement("strong"); label.textContent = role === "user" ? "You" : "Counsel · document desk";
  const content = document.createElement("span"); content.textContent = text;
  node.append(label, content); log.append(node);
  while (log.childElementCount > 10) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

async function loadConnections(mySession) {
  try {
    const data = await api("/api/v1/admin/workstation/status");
    if (mySession !== session || !verified) return;
    config = data;
    const p = config.providers;
    const label = name => {
      if (p[name]?.configured) return "ready (not a live key test)";
      if (name === "gemini") {
        const state = p.gemini?.setting_state;
        return state === "same_as_student" ? "not configured — identical student key refused; set a different ADMIN_GEMINI_API_KEY"
          : state ? `not configured — ADMIN_GEMINI_API_KEY: ${state.replaceAll("_", " ")}` : "not configured";
      }
      return p.cloudflare?.account_state ? `not configured — account: ${p.cloudflare.account_state.replaceAll("_", " ")}; token: ${p.cloudflare.token_state.replaceAll("_", " ")}` : "not configured";
    };
    setText("#station-providers", `Cloudflare Workers AI: ${label("cloudflare")}. Admin Gemini: ${label("gemini")}. Scan OCR: ${p.ocr || "not configured"}. Student Gemini is isolated from this desk.`);
    setText("#station-neon", config.database === "ready" ? "Neon library tables are ready. Saving still requires your explicit approval." : `Neon: ${config.database.replaceAll("_", " ")}. You can process and download drafts; database saving stays locked.`);
    setText("#station-connection-summary", `${p.configured ? "Admin AI configured" : "Extract digital text without AI"} · Neon ${config.database === "ready" ? "ready" : "not ready"}`);
    if (phase === "idle" && !result) setText("#station-status", "Attach a file or paste source text. Your work is not saved until you approve it.");
    controls();
  } catch (error) {
    if (mySession !== session || !verified) return;
    config = null;
    setText("#station-connection-summary", "Connection status unavailable");
    setText("#station-providers", error.message);
    controls();
  }
}
async function loadOptions(resource, id, label, mySession) {
  try {
    const data = await api(`/api/v1/admin/database/options/${resource}?limit=500`);
    if (mySession !== session || !verified) return;
    const select = document.getElementById(id);
    select.replaceChildren(new Option(label, ""), ...data.map(item => new Option(item.label || item.id, item.id)));
  } catch { /* Saving still validates every selected id on the server. */ }
}

function acceptJob(job) {
  const previousId = readyId;
  readyId = job.id; activeId = null; activeInstructions = ""; pollNotBefore = 0; pollFailures = 0; pollExhausted = false; result = job.result; saved = false; approvalSnapshot = null; phase = "idle";
  docName = job.name;
  selectedFile = null; $("#station-file-input").value = ""; $("#station-paste").value = "";
  $("#station-file").hidden = true;
  $("#station-output").value = result.text;
  $("#station-source").textContent = result.source_text;
  $("#station-title").value ||= docName.replace(/\.[^.]+$/, "").slice(0, 250);
  $("#station-approval").checked = false; $("#station-incomplete").checked = false;
  $("#station-review").hidden = false;
  $("#station-incomplete-field").hidden = !result.truncated;
  const list = $("#station-warnings"); list.replaceChildren();
  for (const warning of result.warnings || []) { const item = document.createElement("li"); item.textContent = warning; list.append(item); }
  list.hidden = !list.childElementCount;
  const providers = (result.providers || []).map(item => `${item.provider === "gemini" ? "Admin Gemini" : "Cloudflare"} · ${item.model}`).join(" / ");
  const extractionLabel = /ai_ocr/.test(result.method) ? "Admin Gemini OCR — no correction pass" : /ocr_space/.test(result.method) ? "OCR.space — no correction pass" : "Local extraction — no correction AI call";
  setText("#station-result-meta", `${result.characters.toLocaleString()} characters${result.pages ? ` · ${result.pages} pages` : ""} · ${providers || extractionLabel} · source: ${result.method}`);
  setText("#station-status", "Your draft is ready. Edit it below or send a follow-up instruction. Nothing has been saved to Neon.", "ok");
  setText("#station-save-status", "Review the result, choose its destination, then approve the save.");
  message("assistant", result.truncated ? "The result needs extra checking: some text may be incomplete. Compare the source and warnings before approving." : "Your processed text is ready below. Review or edit it, download a TXT, or tell me what to refine next. I have not saved anything to Neon.");
  controls();
  if (previousId && previousId !== readyId) api(`/api/v1/admin/workstation/jobs/${encodeURIComponent(previousId)}`, { method: "DELETE" }).catch(() => {});
}

function canPoll() {
  return verified && !document.hidden && !$("#station-panel").hidden && !$("#panel-uploads").hidden;
}
function schedulePoll(id, mySession, myRevision, delay) {
  clearTimeout(timer);
  timer = setTimeout(() => poll(id, mySession, myRevision), delay);
}
async function poll(id, mySession, myRevision) {
  if (!verified || mySession !== session || myRevision !== revision || activeId !== id) return;
  if (!canPoll()) { phase = "paused"; controls(); return; }
  if (pollPending?.id === id && pollPending.session === mySession && pollPending.revision === myRevision) return;
  if (Date.now() < pollNotBefore) {
    const left = pollNotBefore - Date.now();
    if (left > 15 * 60_000) {
      phase = "paused";
      setText("#station-status", "The server requested a longer wait. Check progress after its Retry-After period; nothing will be re-uploaded or saved automatically.", "error");
      controls();
    } else schedulePoll(id, mySession, myRevision, left);
    return;
  }
  const token = { id, session: mySession, revision: myRevision };
  pollPending = token;
  try {
    const job = await api(`/api/v1/admin/workstation/jobs/${encodeURIComponent(id)}`);
    if (!verified || mySession !== session || myRevision !== revision) return;
    pollNotBefore = 0; pollFailures = 0;
    if (job.status === "ready") { acceptJob(job); return; }
    if (job.status === "failed") {
      activeId = null; phase = "idle";
      $("#station-input").value ||= activeInstructions;
      setText("#station-status", `${job.error?.message || "Processing failed."} Any earlier draft below is unchanged.`, "error");
      message("assistant", job.error?.message || "Processing stopped. Nothing was saved.");
      controls(); return;
    }
    phase = "polling";
    setText("#station-status", `${job.progress} The server continues processing if you change tabs; status checks resume when you return.`);
    schedulePoll(id, mySession, myRevision, 2500);
  } catch (error) {
    if (!verified || mySession !== session || myRevision !== revision) return;
    if (error.status === 404 && error.code === "DRAFT_NOT_FOUND") {
      activeId = null; phase = "idle";
      $("#station-input").value ||= activeInstructions;
      setText("#station-status", "The server no longer has this temporary job (it may have restarted or the draft expired). Your source/previous draft is still here. Nothing was automatically re-uploaded or saved; Process starts a new job only when you choose it.", "error");
    } else {
      const delay = statusRetryDelay(error, ++pollFailures);
      pollNotBefore = Date.now() + (error.retryAfterMs || 0);
      if (delay !== null) {
        phase = "polling";
        pollNotBefore = Date.now() + delay;
        setText("#station-status", `${error.message} Checking the same job again in ${Math.ceil(delay / 1000)} seconds (${pollFailures}/5). No file is being re-uploaded and no new AI job is started.`, "error");
        schedulePoll(id, mySession, myRevision, delay);
      } else {
        phase = "paused"; pollExhausted = true;
        setText("#station-status", `${error.message} Automatic status checks are paused. Use Check progress to resume the same job; do not submit the file again.`, "error");
      }
    }
  } finally {
    if (pollPending === token) pollPending = null;
  }
  controls();
}
function resumePolling() {
  clearTimeout(timer);
  if (!activeId || !verified || ["starting", "saving"].includes(phase)) return;
  if (!canPoll() || pollExhausted) { phase = "paused"; controls(); return; }
  phase = "polling"; controls();
  poll(activeId, session, revision);
}
for (const name of ["visibilitychange", "fire-counsel:admin-panel", "fire-counsel:upload-mode"]) document.addEventListener(name, resumePolling);

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("The browser could not read this file. Choose it again."));
    reader.readAsDataURL(file);
  });
}
$("#station-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!verified || busy() || approvalSnapshot) return;
  if (activeId) { pollFailures = 0; pollExhausted = false; phase = "polling"; controls(); poll(activeId, session, revision); return; }
  const mySession = session; const myRevision = ++revision;
  const file = selectedFile;
  const pasted = $("#station-paste").value.trim();
  const text = pasted || $("#station-output").value.trim();
  const instructions = $("#station-input").value.trim();
  const operation = $("#station-tool").value;
  if ((!file && !text) || (file && pasted)) { setText("#station-status", file && pasted ? "Choose one source: remove the attachment or clear the pasted text." : "Attach a PDF/TXT document or paste its source text first.", "error"); return; }
  if (operation === "custom" && !instructions) { setText("#station-status", "Tell Counsel what to do in the instruction box.", "error"); return; }
  phase = "starting"; $("#station-approval").checked = false; controls();
  setText("#station-status", "Preparing your document for the private admin queue…");
  try {
    const payload = { operation, provider: $("#station-provider").value, instructions, name: file?.name || docName };
    if (file) payload.attachment = { name: file.name, mimeType: file.type || (file.name.toLowerCase().endsWith(".txt") ? "text/plain" : "application/pdf"), data: await readFile(file) };
    else {
      payload.text = text;
      if (!pasted && readyId) payload.parent_id = readyId;
    }
    if (!verified || mySession !== session || myRevision !== revision) return;
    const job = await api("/api/v1/admin/workstation/jobs", { method: "POST", body: JSON.stringify(payload) });
    if (!verified || mySession !== session || myRevision !== revision) return;
    activeId = job.id; activeInstructions = instructions; pollNotBefore = 0; pollFailures = 0; pollExhausted = false; phase = "polling";
    message("user", `${file ? file.name : "Current document text"}\n${instructions || ({ correct: "Clean up OCR errors and spacing; preserve all substantive content.", extract: "Extract faithfully, without correction or summarising.", format: "Improve headings, paragraphs and lists without shortening." })[operation]}`);
    $("#station-input").value = "";
    controls(); poll(job.id, mySession, myRevision);
  } catch (error) {
    if (!verified || mySession !== session || myRevision !== revision) return;
    phase = "idle";
    setText("#station-status", `${error.message} No save was requested.`, "error"); controls();
  }
});

$("#station-attach").addEventListener("click", () => $("#station-file-input").click());
$("#station-file-input").addEventListener("change", () => {
  const file = $("#station-file-input").files?.[0];
  if (!verified || !file) return;
  if (file.size > 8 * 1024 * 1024) { selectedFile = null; $("#station-file").hidden = true; $("#station-file-input").value = ""; setText("#station-status", "This file exceeds 8 MB. Split it or use Classic upload, which is still available.", "error"); return; }
  selectedFile = file;
  $("#station-file-name").textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  $("#station-file").hidden = false;
  setText("#station-status", "File attached. Choose a tool or describe your instructions, then Process.");
});
$("#station-remove-file").addEventListener("click", () => { selectedFile = null; $("#station-file-input").value = ""; $("#station-file").hidden = true; });
for (const button of document.querySelectorAll("[data-station-tool]")) button.addEventListener("click", () => {
  $("#station-tool").value = button.dataset.stationTool;
  const prompts = { correct: "Correct obvious OCR mistakes and spacing. Keep all facts, legal citations and original page markers; do not summarise.", format: "Organise headings, paragraphs and numbered lists. Preserve every substantive word and [Page N] marker.", extract: "" };
  $("#station-input").value = prompts[button.dataset.stationTool];
  $("#station-input").focus();
});
$("#station-tool").addEventListener("change", () => {
  if ($("#station-tool").value === "extract") $("#station-input").value = "";
});
$("#station-new").addEventListener("click", () => {
  if (!verified || phase === "saving" || approvalSnapshot) return;
  if ((readyId || activeId || selectedFile || $("#station-paste").value.trim()) && !window.confirm("Start a new document? Download any unsaved text first. Earlier saved library versions are not deleted.")) return;
  const ids = [...new Set([activeId, readyId].filter(Boolean))];
  reset(); setText("#station-status", "Ready for a new document. Classic uploads and saved versions are unchanged.");
  for (const id of ids) api(`/api/v1/admin/workstation/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
});

$("#station-output").addEventListener("input", () => { $("#station-approval").checked = false; $("#station-incomplete").checked = false; controls(); });
for (const id of ["station-purpose", "station-course", "station-material", "station-type", "station-publish", "station-title"]) document.getElementById(id).addEventListener("change", () => { $("#station-approval").checked = false; controls(); });
for (const id of ["station-approval", "station-incomplete"]) document.getElementById(id).addEventListener("change", controls);
$("#station-save-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!verified || !readyId || !result || busy() || activeId || saved) return;
  if (!approvalSnapshot && (!$("#station-approval").checked || (result.truncated && !$("#station-incomplete").checked))) return;
  const mySession = session; const myRevision = revision;
  const purpose = $("#station-purpose").value;
  approvalSnapshot ||= { approved: true, acknowledge_incomplete: $("#station-incomplete").checked,
    text: $("#station-output").value, title: $("#station-title").value.trim(), purpose,
    material_type: $("#station-type").value, publish: purpose === "material" && $("#station-publish").checked,
    ...(purpose === "material_version" ? { material_id: $("#station-material").value } : { course_id: $("#station-course").value }) };
  phase = "saving"; controls();
  setText("#station-save-status", "Confirming the reviewed TXT, version and searchable parts in Neon…");
  try {
    const data = await api(`/api/v1/admin/workstation/jobs/${encodeURIComponent(readyId)}/save`, { method: "POST", body: JSON.stringify(approvalSnapshot) });
    if (!verified || mySession !== session || myRevision !== revision) return;
    phase = "idle"; saved = true; approvalSnapshot = null;
    setText("#station-save-status", `Saved to Neon · ${data.title || "Reviewed document"} · version ${data.version_number} · ${data.chunks} searchable parts. Earlier versions are kept.`, "ok");
    message("assistant", "The server confirmed your approved text was saved to Neon. Your original file and this conversation were not saved by Working Station.");
    document.dispatchEvent(new CustomEvent("fire-counsel:uploads-changed"));
  } catch (error) {
    if (!verified || mySession !== session || myRevision !== revision) return;
    phase = "idle";
    // Known rejections made no write; transport/5xx replies may have lost the
    // acknowledgement. Freeze the exact approval and retry the SAME job id.
    if (error.status && error.status < 500) approvalSnapshot = null;
    setText("#station-save-status", approvalSnapshot ? `${error.message} The save outcome is unconfirmed. Retry the same save (it is idempotent) or check Recent uploads; do not start another copy.` : error.message, "error");
  }
  controls();
});
$("#station-download").addEventListener("click", () => {
  if (!verified || !$("#station-output").value.trim()) return;
  const url = URL.createObjectURL(new Blob([$("#station-output").value], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url;
  link.download = `${($("#station-title").value || docName.replace(/\.[^.]+$/, "")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 180)}.txt`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("#station-refresh-connections").addEventListener("click", () => { if (verified) loadConnections(session); });
for (const button of document.querySelectorAll("[data-station-test]")) button.addEventListener("click", async () => {
  if (!verified || testingProvider || busy()) return;
  const mySession = session;
  testingProvider = true; controls();
  setText("#station-test-status", `Testing ${button.dataset.stationTest === "gemini" ? "Admin Gemini" : "Cloudflare Workers AI"} with one small admin-only text request…`);
  try {
    const data = await api("/api/v1/admin/workstation/providers/test", { method: "POST", body: JSON.stringify({ provider: button.dataset.stationTest }) });
    if (!verified || mySession !== session) return;
    if (data?.ok !== true) throw new Error("The provider test was not confirmed.");
    setText("#station-test-status", `${data.provider === "gemini" ? "Admin Gemini" : "Cloudflare Workers AI"} accepted the test · ${data.model}. This does not publish documents or prove a photo/large PDF will fit the provider's limits.`, "ok");
  } catch (error) {
    if (!verified || mySession !== session) return;
    setText("#station-test-status", `${error.message}${error.code ? ` (${error.code})` : ""} No document was saved and the student key was not used.`, "error");
  } finally { if (mySession === session) { testingProvider = false; controls(); } }
});

function adminState(state) {
  session++;
  verified = state === "verified" && Boolean(authClient);
  reset(); config = null;
  setText("#station-providers", "Admin provider status is available after sign-in.");
  setText("#station-neon", "Neon is checked separately from document processing.");
  setText("#station-connection-summary", verified ? "Checking admin connections…" : "Admin access required");
  // Do not leave another administrator's course/material labels in the DOM.
  $("#station-course").replaceChildren(new Option("No specific course", ""));
  $("#station-material").replaceChildren(new Option("Choose an existing material", ""));
  setText("#station-status", verified ? "Checking your admin document connections…" : "Sign in as an administrator to start working.");
  if (verified) {
    loadConnections(session);
    loadOptions("courses", "station-course", "No specific course", session);
    loadOptions("materials", "station-material", "Choose an existing material", session);
  }
  controls();
}
document.addEventListener("fire-counsel:admin-state", event => adminState(event.detail?.state));
window.addEventListener("beforeunload", event => {
  if (verified && ((result && !saved) || activeId || approvalSnapshot)) { event.preventDefault(); event.returnValue = ""; }
});
try {
  authClient = await import("./firebase/auth-client.mjs");
  adminState($("#admin-auth-status")?.dataset.state);
} catch { adminState("offline"); }
