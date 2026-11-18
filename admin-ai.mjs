// Admin Studio: AI provider status, private prompts, default daily limits and
// the account list with Active/Offline badges. Every call is checked by the
// server (Firebase token + admin claim); nothing here is trusted on its own.
const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const FEATURES = [["chat", "Chats"], ["case", "Cases"], ["notes", "Notes"], ["questions", "Questions"]];

let authClient = null;
let verified = false;
let session = 0;
let users = [];
let defaults = null;
let promptCustom = false;

function setText(selector, text, kind = "") {
  const node = $(selector);
  if (!node) return;
  node.textContent = text;
  if (kind !== undefined) node.dataset.kind = kind;
}

async function api(path, options = {}) {
  const response = await authClient.apiRequest(path, options);
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = body.code;
    throw error;
  }
  return body;
}

function setEnabled(on) {
  for (const id of ["#ai-test-button", "#ai-prompt-save", "#ai-prompt-reset", "#ai-extract-button", "#save-default-limits", "#refresh-accounts", "#ai-instr-save", "#ai-instr-delete", "#ai-instr-key", "#ai-instr-import", "#ai-instr-text"]) {
    const node = $(id);
    if (node) node.disabled = !on;
  }
  const text = $("#ai-prompt-text");
  if (text) text.disabled = !on;
  setText("#ai-panel-status", on ? "LIVE · SERVER VERIFIED" : "SIGN IN AS ADMIN", undefined);
  setText("#plans-panel-status", on ? "LIVE · ENFORCED BY SERVER" : "SIGN IN AS ADMIN", undefined);
}

// ---------------------------------------------------------------- status
function renderStatus(data) {
  const p = data.providers;
  const state = (ok, yes, no) => `<span class="fc-state" data-ok="${ok}">${ok ? yes : no}</span>`;
  $("#ai-provider-status").innerHTML = `<dl class="fc-kv">
    <dt>Google Gemini (main)</dt><dd>${state(p.gemini.configured, "KEY ADDED", "NO KEY")}${p.gemini.warning ? `<br><small class="fc-warn">⚠ ${escapeHTML(p.gemini.warning)}</small>` : ""}</dd>
    <dt>Writing models</dt><dd>${escapeHTML(p.gemini.models.join(", "))}</dd>
    <dt>Web-search model</dt><dd>${escapeHTML(p.gemini.search_models.join(", "))}</dd>
    <dt>Groq (fast backup)</dt><dd>${state(Boolean(p.groq?.configured), "KEY ADDED", "NO KEY")} ${escapeHTML((p.groq?.models || []).join(", "))}${p.groq?.key_name ? ` <small>(${escapeHTML(p.groq.key_name)})</small>` : ""}${p.groq?.warning ? `<br><small class="fc-warn">⚠ ${escapeHTML(p.groq.warning)}</small>` : ""}</dd>
    <dt>OpenRouter (backup)</dt><dd>${state(p.openrouter.configured, "KEY ADDED", "NO KEY")} ${escapeHTML(p.openrouter.models.join(", "))}${p.openrouter.warning ? `<br><small class="fc-warn">⚠ ${escapeHTML(p.openrouter.warning)}</small>` : ""}</dd>
    <dt>Tavily (backup web search)</dt><dd>${state(Boolean(p.tavily?.configured), "KEY ADDED", "NO KEY")}${p.tavily?.key_name ? ` <small>(${escapeHTML(p.tavily.key_name)})</small>` : ""}${p.tavily?.warning ? `<br><small class="fc-warn">⚠ ${escapeHTML(p.tavily.warning)}</small>` : ""}</dd>
    <dt>Database tables</dt><dd>${state(data.schema_ready, "READY", "NOT INSTALLED")}</dd>
  </dl>${data.schema_ready ? "" : `<p class="fc-status" data-kind="error">The AI tables are not in Neon yet. On GitHub open <b>Actions → “Neon database migration (AI, website, uploads)” → Run workflow</b>.</p>`}`;
  if (data.render_service && $("#ai-render-service")) $("#ai-render-service").textContent = data.render_service;
  const missing = ["groq", "tavily"].filter((name) => p[name] && !p[name].configured && !p[name].warning);
  if (missing.length) {
    if (missing.includes("tavily")) $("#ai-provider-status").insertAdjacentHTML("beforeend", `<p class="fc-status" data-kind="error"><b>Web search needs Tavily.</b> Google does not allow web search with Gemini 3 models on the free Gemini plan, so without a Tavily key the AI answers without live web sources. Tavily is free (1,000 searches a month): <a href="https://app.tavily.com" target="_blank" rel="noopener">app.tavily.com</a>.</p>`);
    $("#ai-provider-status").insertAdjacentHTML("beforeend", `<p class="fc-status" data-kind="error">The server cannot see the ${missing.map((name) => name === "groq" ? "Groq" : "Tavily").join(" and ")} key${missing.length > 1 ? "s" : ""}. In Render, open the service <b>${escapeHTML(data.render_service || "fire-counsel-2")}</b> (the one this website runs on) → <b>Environment</b> → add ${missing.map((name) => `<code>${name === "groq" ? "GROQ_API_KEY" : "TAVILY_API_KEY"}</code>`).join(" and ")} → <b>Save, rebuild, and deploy</b>.</p>`);
  }
  const today = data.today || {};
  $("#ai-today").innerHTML = `<dl class="fc-kv">${FEATURES.map(([key, label]) => `<dt>${label}</dt><dd>${today[key]?.used || 0} used${today[key]?.failed ? ` · ${today[key].failed} failed` : ""}</dd>`).join("")}</dl><p>Time zone: ${escapeHTML(data.timezone)}</p>`;
  if (data.limits) {
    defaults = data.limits;
    for (const [key] of FEATURES) $(`#limit-${key}`).value = data.limits[key];
  }
}

async function loadStatus(mySession) {
  try {
    const body = await api("/api/v1/admin/ai/status");
    if (mySession !== session) return;
    renderStatus(body.data);
  } catch (error) {
    if (mySession === session) $("#ai-provider-status").innerHTML = `<p class="fc-status" data-kind="error">${escapeHTML(error.message)}</p>`;
  }
}

// ---------------------------------------------------------------- prompts
async function loadPrompt(mySession = session) {
  const kind = $("#ai-prompt-kind").value;
  setText("#ai-prompt-status", "Loading…", "");
  try {
    const body = await api(`/api/v1/admin/ai/prompts/${encodeURIComponent(kind)}`);
    if (mySession !== session || kind !== $("#ai-prompt-kind").value) return;
    promptCustom = body.data.custom;
    $("#ai-prompt-text").value = body.data.content;
    const state = $("#ai-prompt-state");
    state.textContent = body.data.custom ? "YOUR PROMPT IS IN USE" : "BUILT-IN PROMPT IN USE";
    state.dataset.ok = String(body.data.custom);
    setText("#ai-prompt-status", body.data.updated_at ? `Saved ${new Date(body.data.updated_at).toLocaleString()}` : "Not saved yet — the short built-in prompt is used.", "");
  } catch (error) {
    if (mySession === session) setText("#ai-prompt-status", error.message, "error");
  }
}

$("#ai-prompt-kind")?.addEventListener("change", () => { if (verified) loadPrompt(); });
$("#ai-prompt-file")?.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 400_000) { setText("#ai-prompt-status", "That file is too large for a prompt.", "error"); return; }
  $("#ai-prompt-text").value = await file.text();
  setText("#ai-prompt-status", `Loaded ${file.name}. Check it, then press Save prompt.`, "");
});
$("#ai-prompt-save")?.addEventListener("click", async () => {
  const kind = $("#ai-prompt-kind").value;
  const content = $("#ai-prompt-text").value.trim();
  if (content.length < 20) { setText("#ai-prompt-status", "The prompt is too short.", "error"); return; }
  try {
    await api(`/api/v1/admin/ai/prompts/${encodeURIComponent(kind)}`, { method: "PUT", body: JSON.stringify({ content }) });
    setText("#ai-prompt-status", `Saved. Students' next ${$("#ai-prompt-kind").selectedOptions[0].textContent.toLowerCase()} requests use it.`, "ok");
    loadPrompt();
    loadStatus(session);
  } catch (error) {
    setText("#ai-prompt-status", error.message, "error");
  }
});
$("#ai-prompt-reset")?.addEventListener("click", async () => {
  if (!promptCustom) { setText("#ai-prompt-status", "The built-in prompt is already in use.", ""); return; }
  if (!window.confirm("Delete your saved prompt and go back to the short built-in one?")) return;
  try {
    const response = await authClient.apiRequest(`/api/v1/admin/ai/prompts/${encodeURIComponent($("#ai-prompt-kind").value)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) throw new Error(`Request failed (${response.status}).`);
    await loadPrompt();
  } catch (error) {
    setText("#ai-prompt-status", error.message, "error");
  }
});

// ---------------------------------------------------------------- test & extract
// Plain-language reasons when the test itself cannot reach the server.
function testErrorText(error) {
  const status = Number(error?.status) || 0;
  if (status === 524 || status === 504) return "The test took too long and the website's gateway stopped waiting. Press Test again — the server may have been waking up from sleep.";
  if (status === 502 || (status === 503 && !error.code)) return "The server is starting up or restarting (this happens after a deploy or 15 minutes of no visitors). Wait 1 minute and press Test again.";
  if (status === 401) return "Your sign-in has expired. Sign out and sign in again, then press Test.";
  if (status === 403) return "This account is not an administrator, so it cannot run the AI test.";
  if (status === 429) return "Too many requests in a short time. Wait a few minutes and press Test again.";
  if (!status) return `Could not reach the server (${error?.message || "network error"}). Check your internet connection and press Test again.`;
  return error.message;
}

const PROVIDER_NAMES = { gemini: "Google Gemini", groq: "Groq", openrouter: "OpenRouter", tavily: "Tavily" };

// One row per model/service: healthy or not, how fast, and why it failed.
function renderHealth(models) {
  const holder = $("#ai-test-models");
  if (!holder) return;
  if (!models.length) { holder.innerHTML = ""; return; }
  holder.innerHTML = `<table class="fc-health"><thead><tr><th>Service</th><th>Health</th></tr></thead><tbody>${models.map((m) => `<tr data-ok="${m.ok}">
    <td><strong>${escapeHTML(PROVIDER_NAMES[m.provider] || m.provider)}</strong><small class="fc-health-job">${escapeHTML(m.role)}</small><code>${escapeHTML(m.model)}</code></td>
    <td>${m.ok ? `<span class="fc-state" data-ok="true">HEALTHY</span><small>${(m.ms / 1000).toFixed(1)}s${m.sources ? ` · ${m.sources} sources` : ""}</small>` : `<span class="fc-state" data-ok="false">${escapeHTML(String(m.code || "FAILED").replace(/^PROVIDER_/, "").replace(/_/g, " "))}</span><small>${escapeHTML(m.error || "")}</small>`}</td></tr>`).join("")}</tbody></table>`;
}
$("#ai-test-button")?.addEventListener("click", async () => {
  const button = $("#ai-test-button");
  button.disabled = true;
  setText("#ai-test-result", "Testing every AI service at the same time… this takes up to 1 minute.", "");
  if ($("#ai-test-models")) $("#ai-test-models").innerHTML = "";
  try {
    const body = await api("/api/v1/admin/ai/test", { method: "POST", body: JSON.stringify({ search: $("#ai-test-search").checked }) });
    const d = body.data;
    let text = d.ok ? `Working: ${PROVIDER_NAMES[d.provider] || d.provider} (${d.model}) replied “${d.reply}”.` : "No AI model answered — see the table below.";
    if (d.fallback) text += " Gemini did not answer, so a backup was used.";
    if (d.search) text += d.search.ok ? ` Web search works via ${PROVIDER_NAMES[d.search.provider] || d.search.provider} (${d.search.sources} sources).` : ` Web search failed: ${d.search.error}`;
    setText("#ai-test-result", text, !d.ok || (d.search && !d.search.ok) ? "error" : "ok");
    renderHealth(d.models || []);
  } catch (error) {
    setText("#ai-test-result", testErrorText(error), "error");
  } finally {
    button.disabled = !verified;
  }
});

$("#ai-extract-button")?.addEventListener("click", async () => {
  const file = $("#ai-extract-file").files[0];
  if (!file) { setText("#ai-extract-status", "Choose a file first.", "error"); return; }
  if (file.size > 10 * 1024 * 1024) { setText("#ai-extract-status", "Files must be under 10 MB.", "error"); return; }
  const button = $("#ai-extract-button");
  button.disabled = true;
  setText("#ai-extract-status", "Reading the file… this can take a minute.", "");
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsDataURL(file);
    });
    const mimeType = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "text/plain");
    const body = await api("/api/v1/admin/ai/extract", { method: "POST", body: JSON.stringify({ attachment: { name: file.name, mimeType, data } }) });
    $("#ai-extract-output").value = body.data.text;
    const d = body.data;
    const how = !d.method ? "" : d.method === "pdf_text" ? "read directly from the PDF (no AI needed)" : d.method.includes("ai_ocr") ? "scanned pages read by AI" : d.method.includes("ocr_space") ? "read by OCR.space" : `read as ${d.method}`;
    const info = [d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : "", how, ...(d.warnings || [])].filter(Boolean).join(" · ");
    setText("#ai-extract-status", `${d.truncated ? "Done, but the text was cut short: split the file and try again for the rest." : "Done. Check the text carefully before using it."}${info ? ` (${info})` : ""} To save files into the library, use Upload documents.`, d.truncated ? "error" : "ok");
  } catch (error) {
    setText("#ai-extract-status", error.message, "error");
  } finally {
    button.disabled = !verified;
  }
});

// ---------------------------------------------------------------- limits
$("#default-limits-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(FEATURES.map(([key]) => [key, Number($(`#limit-${key}`).value)]));
  try {
    const result = await api("/api/v1/admin/ai/limits", { method: "PUT", body: JSON.stringify(body) });
    defaults = result.data;
    setText("#default-limits-status", "Saved. These limits apply to every account without its own limit.", "ok");
    renderUsers();
  } catch (error) {
    setText("#default-limits-status", error.message, "error");
  }
});

// ---------------------------------------------------------------- users
function ago(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function renderUsers() {
  const holder = $("#student-account-rows");
  if (!holder) return;
  const query = $("#account-search").value.trim().toLowerCase();
  const list = users.filter((u) => !query || [u.email, u.name, u.uid].some((v) => v && v.toLowerCase().includes(query)));
  if (!list.length) { holder.innerHTML = `<tr><td colspan="5">${users.length ? "No account matches that search." : "No accounts yet."}</td></tr>`; return; }
  holder.innerHTML = list.map((u) => {
    const tags = [u.admin ? `<span class="fc-tag">ADMIN</span>` : "", u.paused ? `<span class="fc-tag warn">AI PAUSED</span>` : "", u.disabled ? `<span class="fc-tag warn">DISABLED</span>` : "", !u.email_verified ? `<span class="fc-tag warn">EMAIL NOT VERIFIED</span>` : ""].join("");
    const usage = FEATURES.map(([key, label]) => {
      const limit = u.admin ? "∞" : u.limits[key] ?? defaults?.[key] ?? "—";
      return `<span>${label}: ${u.usage_today[key] || 0} / ${limit}</span>`;
    }).join("");
    const custom = FEATURES.filter(([key]) => u.limits[key] != null).map(([key, label]) => `${label} ${u.limits[key]}`).join(", ");
    return `<tr>
      <td><strong>${escapeHTML(u.name || u.email || u.uid)}</strong><small>${escapeHTML(u.email || "no email")}</small>${tags}</td>
      <td><span class="fc-badge" data-online="${u.online}">${u.online ? "Active" : "Offline"}</span><small>Last seen ${escapeHTML(ago(u.last_seen_at || u.last_sign_in))}</small></td>
      <td><div class="fc-usage">${usage}</div></td>
      <td>${custom ? escapeHTML(custom) : "Default"}${u.note ? `<small>${escapeHTML(u.note)}</small>` : ""}</td>
      <td><button class="button button-light" type="button" data-edit-account="${escapeHTML(u.uid)}">Change limits</button></td>
    </tr>`;
  }).join("");
}

async function loadUsers(mySession = session) {
  setText("#accounts-summary", "Loading accounts…", "");
  try {
    const body = await api("/api/v1/admin/ai/users");
    if (mySession !== session) return;
    users = body.data.users;
    defaults = body.data.defaults || defaults;
    setText("#accounts-summary", `${body.data.total} account${body.data.total === 1 ? "" : "s"} · ${body.data.online} active now${body.data.truncated ? " · showing the first 5,000" : ""}`, "ok");
    renderUsers();
  } catch (error) {
    if (mySession === session) setText("#accounts-summary", error.message, "error");
  }
}

$("#account-search")?.addEventListener("input", renderUsers);
$("#refresh-accounts")?.addEventListener("click", () => loadUsers());
$("#student-account-rows")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-edit-account]");
  if (!button) return;
  const user = users.find((u) => u.uid === button.dataset.editAccount);
  if (!user) return;
  const form = $("#account-adjustment-form");
  form.hidden = false;
  $("#quota-account-id").value = user.uid;
  $("#adjustment-account-pill").textContent = user.email || user.name || user.uid;
  for (const [key] of FEATURES) {
    const input = $(`#user-limit-${key}`);
    input.value = user.limits[key] ?? "";
    input.placeholder = `Default ${defaults?.[key] ?? ""}`;
  }
  $("#user-paused").checked = user.paused;
  $("#user-note").value = user.note || "";
  setText("#account-adjustment-status", "", "");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#cancel-account-adjustment")?.addEventListener("click", () => { $("#account-adjustment-form").hidden = true; });
$("#account-adjustment-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const uid = $("#quota-account-id").value;
  const body = Object.fromEntries(FEATURES.map(([key]) => [key, $(`#user-limit-${key}`).value.trim() === "" ? null : Number($(`#user-limit-${key}`).value)]));
  body.paused = $("#user-paused").checked;
  body.note = $("#user-note").value.trim();
  try {
    await api(`/api/v1/admin/ai/users/${encodeURIComponent(uid)}/limits`, { method: "PUT", body: JSON.stringify(body) });
    setText("#account-adjustment-status", "Saved. The new limits apply immediately.", "ok");
    loadUsers();
  } catch (error) {
    setText("#account-adjustment-status", error.message, "error");
  }
});

// ------------------------------------------------- background instructions
const GROUP_LABEL = { always: "Always used — sent with every answer", specialist: "Task instructions — added when the question needs them", research: "Web research step", reference: "Reference only (the server routes questions itself — faster, saves your free AI quota)" };
let instructions = [];
let instrSaved = false;

function renderInstructions() {
  const list = $("#ai-instr-list");
  if (!list) return;
  const saved = instructions.filter((item) => item.saved).length;
  const groups = Object.keys(GROUP_LABEL).map((group) => {
    const items = instructions.filter((item) => item.group === group);
    if (!items.length) return "";
    return `<div class="fc-instr-group">${escapeHTML(GROUP_LABEL[group])}</div>` + items.map((item) => `<button class="fc-instr-item" type="button" data-instr="${escapeHTML(item.key)}"><span class="fc-state" data-ok="${item.saved}">${item.saved ? "SAVED" : "NOT SAVED"}</span><b>${escapeHTML(item.label)}</b>${item.saved ? `<small>${Number(item.length).toLocaleString()} characters · ${item.updated_at ? new Date(item.updated_at).toLocaleDateString() : ""}</small>` : ""}</button>`).join("");
  }).join("");
  list.innerHTML = `<p class="fc-status" data-kind="${saved ? "ok" : "error"}">${saved ? `${saved} of ${instructions.length} instructions saved. The AI follows them for every student.` : "No background instructions saved yet — the AI uses short built-in rules. Import your instructions file."}</p>${groups}`;
  const select = $("#ai-instr-key");
  const current = select.value;
  select.innerHTML = instructions.map((item) => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.label)}${item.saved ? "" : " (not saved)"}</option>`).join("");
  if (instructions.some((item) => item.key === current)) select.value = current;
}

async function loadInstructionList(mySession = session) {
  try {
    const body = await api("/api/v1/admin/ai/instructions");
    if (mySession !== session) return;
    instructions = body.data || [];
    renderInstructions();
    await loadInstruction(mySession);
  } catch (error) {
    if (mySession === session && $("#ai-instr-list")) $("#ai-instr-list").innerHTML = `<p class="fc-status" data-kind="error">${escapeHTML(error.message)}</p>`;
  }
}

async function loadInstruction(mySession = session) {
  const key = $("#ai-instr-key")?.value;
  if (!key) return;
  setText("#ai-instr-status", "Loading…", "");
  try {
    const body = await api(`/api/v1/admin/ai/instructions/${encodeURIComponent(key)}`);
    if (mySession !== session || key !== $("#ai-instr-key").value) return;
    instrSaved = body.data.saved;
    $("#ai-instr-text").value = body.data.content;
    $("#ai-instr-text").placeholder = "Not saved yet. Paste or type this instruction, or import your instructions file.";
    const state = $("#ai-instr-state");
    state.textContent = body.data.saved ? "IN USE" : "NOT SAVED";
    state.dataset.ok = String(body.data.saved);
    setText("#ai-instr-status", body.data.updated_at ? `Saved ${new Date(body.data.updated_at).toLocaleString()}` : "", "");
  } catch (error) {
    if (mySession === session) setText("#ai-instr-status", error.message, "error");
  }
}

$("#ai-instr-key")?.addEventListener("change", () => { if (verified) loadInstruction(); });
$("#ai-instr-list")?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-instr]");
  if (!item || !verified) return;
  $("#ai-instr-key").value = item.dataset.instr;
  loadInstruction();
  $("#ai-instr-text").scrollIntoView({ behavior: "smooth", block: "center" });
});
$("#ai-instr-import")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !verified) return;
  if (file.size > 600_000) { setText("#ai-instr-import-status", "That file is too large (over 600 KB).", "error"); return; }
  setText("#ai-instr-import-status", `Reading ${file.name}…`, "");
  try {
    const body = await api("/api/v1/admin/ai/instructions/import", { method: "POST", body: JSON.stringify({ text: await file.text() }) });
    const { saved, missing } = body.data;
    setText("#ai-instr-import-status", `Saved ${saved.length} instruction${saved.length === 1 ? "" : "s"} from ${file.name}.${missing.length ? ` Not in the file: ${missing.map((m) => m.label).join(", ")}.` : " Everything was found."} The AI uses them from the next question.`, "ok");
    await loadInstructionList();
  } catch (error) {
    setText("#ai-instr-import-status", error.message, "error");
  }
});
$("#ai-instr-save")?.addEventListener("click", async () => {
  const key = $("#ai-instr-key").value;
  const content = $("#ai-instr-text").value.trim();
  if (content.length < 20) { setText("#ai-instr-status", "The instruction is too short (at least 20 characters).", "error"); return; }
  try {
    await api(`/api/v1/admin/ai/instructions/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ content }) });
    await loadInstructionList();
    setText("#ai-instr-status", "Saved. The AI follows it from the next question (within a minute).", "ok");
  } catch (error) {
    setText("#ai-instr-status", error.message, "error");
  }
});
$("#ai-instr-delete")?.addEventListener("click", async () => {
  if (!instrSaved) { setText("#ai-instr-status", "This instruction is not saved.", ""); return; }
  if (!window.confirm("Remove this instruction? The AI will stop using it.")) return;
  try {
    const response = await authClient.apiRequest(`/api/v1/admin/ai/instructions/${encodeURIComponent($("#ai-instr-key").value)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) throw new Error(`Request failed (${response.status}).`);
    await loadInstructionList();
    setText("#ai-instr-status", "Removed.", "ok");
  } catch (error) {
    setText("#ai-instr-status", error.message, "error");
  }
});

// ---------------------------------------------------------------- start
function onAdminState(state) {
  session += 1;
  // Until the sign-in client has loaded, wait: the start-up call below re-runs this.
  verified = state === "verified" && Boolean(authClient);
  setEnabled(verified);
  if (!verified) return;
  const mySession = session;
  loadStatus(mySession);
  loadPrompt(mySession);
  loadInstructionList(mySession);
  loadUsers(mySession);
}

document.addEventListener("fire-counsel:admin-state", (event) => onAdminState(event.detail?.state));
try {
  authClient = await import("./firebase/auth-client.mjs");
  onAdminState($("#admin-auth-status")?.dataset.state);
} catch { /* sign-in not configured: panels stay disabled */ }
