const $ = (selector) => document.querySelector(selector);
const resourceSelect = $("#database-resource");
const searchInput = $("#database-search");
const tableHead = $("#database-table-head");
const tableBody = $("#database-table-body");
const recordForm = $("#database-record-form");
const fieldsHolder = $("#database-fields");
const versionPanel = $("#database-version-panel");
let authClient;
let catalog = [];
let activeDataset = null;
let activeRecord = null;
let databaseReady = false;
let serverAdmin = false;
let offset = 0;
const pageSize = 50;
let searchTimer;

function setStatus(text, kind = "") {
  const node = $("#database-status");
  node.textContent = text;
  node.dataset.kind = kind;
}

function setSystemState(selector, state, text) {
  const node = $(selector);
  node.dataset.state = state;
  node.textContent = text;
}

async function safeJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

function apiPath(suffix = "") {
  return `/api/v1/admin/database${suffix}`;
}

async function getDatabaseHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await safeJson(response);
    databaseReady = response.ok && data.database === "connected";
    if (databaseReady) {
      setSystemState("#database-neon-state", "ready", "Neon connected · TLS verified by backend");
    } else if (data.database === "not_configured") {
      setSystemState("#database-neon-state", "offline", "Neon not configured · backend/.env needed");
    } else {
      setSystemState("#database-neon-state", "offline", "Neon unavailable · check backend health");
    }
  } catch {
    databaseReady = false;
    setSystemState("#database-neon-state", "offline", "Neon API is not connected on this origin");
  }
}

function setControlsEnabled(enabled) {
  const locked = !enabled || !databaseReady;
  resourceSelect.disabled = locked;
  searchInput.disabled = locked;
  $("#database-new").disabled = locked || !activeDataset;
  $("#database-save").disabled = locked;
  $("#database-delete").disabled = locked;
  $("#database-prev").disabled = locked || offset === 0;
  $("#database-next").disabled = locked;
  recordForm.querySelectorAll("input, select, textarea").forEach((control) => { control.disabled = locked; });
  $("#database-version-text").disabled = locked;
  $("#database-version-form button[type=submit]").disabled = locked;
}

function clearAdminDataState() {
  catalog = [];
  activeDataset = null;
  activeRecord = null;
  resourceSelect.replaceChildren();
  tableHead.replaceChildren();
  tableBody.replaceChildren();
  closeRecordForm();
  setPageStatus(0);
}

function fillResourceSelect() {
  resourceSelect.replaceChildren();
  for (const dataset of catalog) {
    const option = document.createElement("option");
    option.value = dataset.key;
    option.textContent = dataset.label;
    resourceSelect.append(option);
  }
  resourceSelect.disabled = !catalog.length || !serverAdmin || !databaseReady;
  if (catalog.length) selectDataset(resourceSelect.value || catalog[0].key);
}

function setPageStatus(total) {
  const first = total ? offset + 1 : 0;
  const last = Math.min(offset + pageSize, total);
  $("#database-page-status").textContent = total ? `${first}–${last} of ${total}` : "No matching records";
  $("#database-prev").disabled = !serverAdmin || offset === 0;
  $("#database-next").disabled = !serverAdmin || offset + pageSize >= total;
}

function friendlyError(body, response) {
  if (body?.error) return body.error;
  if (response.status === 401) return "Sign in again to continue.";
  if (response.status === 403) return "The server did not verify administrator permission.";
  if (response.status === 503) return "The API or Neon database is not ready.";
  return `Request failed (${response.status}).`;
}

async function apiRequest(path, options = {}) {
  if (!authClient) throw new Error("Firebase Auth is not configured.");
  const response = await authClient.apiRequest(path, options);
  const body = await safeJson(response);
  if (!response.ok) throw new Error(friendlyError(body, response));
  return body;
}

function selectDataset(key) {
  activeDataset = catalog.find((dataset) => dataset.key === key) || null;
  resourceSelect.value = activeDataset?.key || "";
  offset = 0;
  closeRecordForm();
  renderRows().catch((error) => setStatus(error.message, "error"));
  $("#database-new").disabled = !serverAdmin || !databaseReady || !activeDataset;
}

function labelFor(dataset, name) {
  return dataset.fields.find((field) => field.name === name)?.label || name.replaceAll("_", " ");
}

function displayValue(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value).slice(0, 180);
  const text = String(value);
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function makeCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function renderTableHeader(dataset) {
  tableHead.replaceChildren();
  const row = document.createElement("tr");
  for (const name of dataset.displayColumns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = labelFor(dataset, name);
    row.append(th);
  }
  const actions = document.createElement("th");
  actions.scope = "col";
  actions.textContent = "Actions";
  row.append(actions);
  tableHead.append(row);
}

function renderTableRows(dataset, rows) {
  tableBody.replaceChildren();
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = dataset.displayColumns.length + 1;
    cell.className = "database-empty";
    cell.textContent = "No records found. Use New record to add the first one.";
    row.append(cell);
    tableBody.append(row);
    return;
  }

  for (const record of rows) {
    const row = document.createElement("tr");
    for (const column of dataset.displayColumns) row.append(makeCell(displayValue(record[column])));
    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "database-table-actions";
    const edit = document.createElement("button");
    edit.className = "button button-light";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openRecordForm(record.id));
    const remove = document.createElement("button");
    remove.className = "button button-light";
    remove.type = "button";
    remove.textContent = dataset.deleteMode === "deactivate" ? "Deactivate" : "Delete";
    remove.addEventListener("click", () => removeRecord(record));
    actions.append(edit, remove);
    actionsCell.append(actions);
    row.append(actionsCell);
    tableBody.append(row);
  }
}

async function renderRows() {
  if (!activeDataset || !serverAdmin) {
    tableBody.replaceChildren();
    setPageStatus(0);
    return;
  }
  renderTableHeader(activeDataset);
  setStatus(databaseReady ? "Loading Neon records…" : "The server is authenticated, but Neon is not connected. Add DATABASE_URL to the ignored backend/.env to enable records.");
  if (!databaseReady) {
    tableBody.replaceChildren();
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = activeDataset.displayColumns.length + 1;
    cell.className = "database-empty";
    cell.textContent = "No database records can be loaded until Neon is configured on the backend.";
    row.append(cell);
    tableBody.append(row);
    setPageStatus(0);
    return;
  }
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
  if (searchInput.value.trim()) query.set("q", searchInput.value.trim());
  const result = await apiRequest(`${apiPath(`/${encodeURIComponent(activeDataset.key)}`)}?${query}`);
  renderTableRows(activeDataset, result.data || []);
  setPageStatus(result.pagination?.total || 0);
  setStatus(`Showing ${activeDataset.label.toLowerCase()} from Neon. Changes are written through the verified backend.`, "ok");
}

function formControl(field, value, options = []) {
  let control;
  if (field.type === "textarea") {
    control = document.createElement("textarea");
    control.rows = field.virtual && field.name === "content_text" ? 12 : 5;
    control.maxLength = field.maxLength || 40_000;
  } else if (field.type === "select" || field.type === "reference") {
    control = document.createElement("select");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = field.type === "reference" ? `Choose ${field.label.toLowerCase()}` : `Choose ${field.label.toLowerCase()}`;
    control.append(placeholder);
    const entries = field.type === "reference" ? options : (field.options || []).map((entry) => ({ id: entry, label: entry }));
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label;
      control.append(option);
    }
    if (value != null && !entries.some((entry) => entry.id === value)) {
      const linked = document.createElement("option");
      linked.value = String(value);
      linked.textContent = `Linked record ${String(value).slice(0, 12)}…`;
      control.append(linked);
    }
  } else if (field.type === "boolean") {
    const wrapper = document.createElement("span");
    wrapper.className = "checkbox-row";
    control = document.createElement("input");
    control.type = "checkbox";
    control.name = field.name;
    control.checked = value === true;
    control.dataset.boolean = "true";
    wrapper.append(control);
    const caption = document.createElement("span");
    caption.textContent = "Yes";
    wrapper.append(caption);
    return wrapper;
  } else {
    control = document.createElement("input");
    control.type = field.type === "number" ? "number" : field.type;
    if (field.type === "number") {
      control.step = field.integer ? "1" : "any";
      if (field.min != null) control.min = String(field.min);
      if (field.max != null) control.max = String(field.max);
    }
    if (field.maxLength && ["text", "url"].includes(field.type)) control.maxLength = field.maxLength;
  }
  control.name = field.name;
  control.required = Boolean(field.required);
  if (value != null) control.value = String(value);
  if (field.type === "reference") control.dataset.referenceResource = field.resource;
  return control;
}

async function buildForm(dataset, record = null) {
  fieldsHolder.replaceChildren();
  const detail = record?.latest_version?.extracted_text;
  for (const field of dataset.fields) {
    let options = [];
    if (field.type === "reference" && databaseReady) {
      try {
        const result = await apiRequest(apiPath(`/options/${encodeURIComponent(field.resource)}?limit=500`));
        options = result.data || [];
      } catch (error) {
        setFormStatus(`Could not load ${field.label.toLowerCase()} choices: ${error.message}`, "error");
      }
    }
    const label = document.createElement("label");
    label.className = `database-field${field.type === "textarea" || field.virtual ? " is-wide" : ""}`;
    label.append(document.createTextNode(field.label));
    const value = field.name === "content_text" ? (record?.content_text ?? detail ?? "") : record ? record[field.name] : field.default;
    const control = formControl(field, value, options);
    label.append(control);
    if (field.type === "reference") {
      const hint = document.createElement("small");
      hint.textContent = "Choose an existing related record. Create that parent data first if it is not listed.";
      label.append(hint);
    } else if (field.name === "content_text") {
      const hint = document.createElement("small");
      hint.textContent = "Text is versioned in Neon and split into plain searchable chunks; embeddings and AI calls remain off.";
      label.append(hint);
    }
    fieldsHolder.append(label);
  }
  $("#database-form-title").textContent = record ? `Edit ${dataset.label.toLowerCase()}` : `New ${dataset.label.toLowerCase()} record`;
  $("#database-form-description").textContent = record ? `Record ID: ${record.id}` : "Complete the fields below. Required relationships must already exist.";
  $("#database-form-eyebrow").textContent = `NEON · ${dataset.label.toUpperCase()}`;
  $("#database-delete").hidden = !record;
  $("#database-delete").textContent = dataset.deleteMode === "deactivate" ? "Deactivate record" : "Delete record";
  $("#database-save").textContent = record ? "Save changes to Neon" : "Save to Neon";
  recordForm.hidden = false;
  versionPanel.hidden = !(dataset.key === "materials" && record?.id);
  if (versionPanel.hidden) return;
  $("#database-version-text").value = "";
  setVersionStatus("Loading saved versions…");
  await renderVersions(record.id);
}

function setFormStatus(text, kind = "") {
  const node = $("#database-form-status");
  node.textContent = text;
  node.dataset.kind = kind;
}

function setVersionStatus(text) {
  $("#database-version-status").textContent = text;
}

async function openRecordForm(id = null) {
  if (!activeDataset || !databaseReady || !serverAdmin) return;
  activeRecord = null;
  setFormStatus("Loading form…");
  recordForm.hidden = false;
  versionPanel.hidden = true;
  try {
    let record = null;
    if (id) {
      const result = await apiRequest(apiPath(`/${encodeURIComponent(activeDataset.key)}/${encodeURIComponent(id)}`));
      record = result.data;
    }
    activeRecord = record;
    await buildForm(activeDataset, record);
    setFormStatus("Only the fields defined for this Neon table can be saved.");
    recordForm.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    recordForm.hidden = true;
    setStatus(error.message, "error");
  }
}

function closeRecordForm() {
  recordForm.hidden = true;
  versionPanel.hidden = true;
  activeRecord = null;
  fieldsHolder.replaceChildren();
  setFormStatus("");
}

function collectRecord() {
  const result = {};
  for (const field of activeDataset.fields) {
    const control = fieldsHolder.querySelector(`[name="${CSS.escape(field.name)}"]`);
    if (!control) continue;
    if (field.type === "boolean") {
      const checkbox = control.matches("input[type=checkbox]") ? control : control.querySelector("input[type=checkbox]");
      result[field.name] = checkbox.checked;
    } else if (field.type === "number") {
      result[field.name] = control.value === "" ? null : Number(control.value);
    } else {
      result[field.name] = control.value === "" && !field.required ? null : control.value;
    }
  }
  return result;
}

async function submitRecord(event) {
  event.preventDefault();
  if (!activeDataset || !databaseReady || !serverAdmin) return;
  $("#database-save").disabled = true;
  setFormStatus("Saving in Neon…");
  try {
    const method = activeRecord ? "PATCH" : "POST";
    const suffix = activeRecord ? `/${encodeURIComponent(activeDataset.key)}/${encodeURIComponent(activeRecord.id)}` : `/${encodeURIComponent(activeDataset.key)}`;
    await apiRequest(apiPath(suffix), { method, body: JSON.stringify(collectRecord()) });
    closeRecordForm();
    await renderRows();
    setStatus("Saved to Neon.", "ok");
  } catch (error) {
    setFormStatus(error.message, "error");
  } finally {
    $("#database-save").disabled = !databaseReady || !serverAdmin;
  }
}

async function removeRecord(record) {
  if (!activeDataset || !databaseReady || !serverAdmin) return;
  const column = activeDataset.displayColumns.find((name) => record[name] != null);
  const label = column ? displayValue(record[column]) : record.id;
  const action = activeDataset.deleteMode === "deactivate" ? "deactivate" : "permanently delete";
  const warning = activeDataset.deleteWarning || "This action cannot be undone.";
  if (!window.confirm(`Do you want to ${action} “${label}”?\n\n${warning}\n\nContinue?`)) return;
  try {
    const response = await authClient.apiRequest(apiPath(`/${encodeURIComponent(activeDataset.key)}/${encodeURIComponent(record.id)}`), {
      method: "DELETE",
      body: JSON.stringify({ confirm: true })
    });
    const body = await safeJson(response);
    if (!response.ok) throw new Error(friendlyError(body, response));
    closeRecordForm();
    await renderRows();
    setStatus(activeDataset.deleteMode === "deactivate" ? "Record deactivated." : "Record deleted from Neon.", "ok");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function renderVersions(materialId) {
  const holder = $("#database-version-list");
  holder.replaceChildren();
  try {
    const result = await apiRequest(apiPath(`/materials/${encodeURIComponent(materialId)}/versions`));
    const versions = result.data || [];
    if (!versions.length) {
      const item = document.createElement("div");
      item.className = "database-version-item";
      item.textContent = "No text versions saved yet.";
      holder.append(item);
    }
    for (const version of versions) {
      const item = document.createElement("div");
      item.className = "database-version-item";
      const date = version.created_at ? new Date(version.created_at).toLocaleString() : "date unavailable";
      item.textContent = `Version ${version.version_number} · ${version.extraction_status} · ${String(version.extracted_text || "").length.toLocaleString()} characters · ${date}`;
      holder.append(item);
    }
    setVersionStatus(versions.length ? `${versions.length} saved text version${versions.length === 1 ? "" : "s"}. Saving creates a new version.` : "No text versions saved yet.");
  } catch (error) {
    setVersionStatus(error.message);
  }
}

async function saveMaterialVersion(event) {
  event.preventDefault();
  if (!activeRecord?.id || !databaseReady || !serverAdmin) return;
  const text = $("#database-version-text").value;
  if (!text.trim()) return setVersionStatus("Paste material text before saving.");
  setVersionStatus("Saving a new version in Neon…");
  try {
    const result = await apiRequest(apiPath(`/materials/${encodeURIComponent(activeRecord.id)}/versions`), {
      method: "POST",
      body: JSON.stringify({ extracted_text: text })
    });
    $("#database-version-text").value = "";
    setVersionStatus(`Saved version ${result.data.version_number} with ${result.data.chunk_count} plain-text chunks. No AI call was made.`);
    await renderVersions(activeRecord.id);
  } catch (error) { setVersionStatus(error.message); }
}

async function removeRecordFromForm() {
  if (activeRecord) await removeRecord(activeRecord);
}

async function loadAdminData() {
  await getDatabaseHealth();
  setControlsEnabled(false);
  if (!authClient?.firebaseAuth.currentUser) {
    serverAdmin = false;
    clearAdminDataState();
    setSystemState("#database-firebase-state", "denied", "Sign in with a Firebase administrator account");
    setStatus("Sign in first. Firebase Auth and the server-side admin claim are separate from Neon data.");
    return;
  }
  try {
    const adminResponse = await authClient.apiRequest("/api/v1/admin/me");
    if (!adminResponse.ok) {
      serverAdmin = false;
      clearAdminDataState();
      setSystemState("#database-firebase-state", "denied", adminResponse.status === 403 ? "Firebase account is not an administrator" : "Admin API could not verify this account");
      setStatus("The server did not verify administrator access. Database forms are locked.", "error");
      return;
    }
    serverAdmin = true;
    setSystemState("#database-firebase-state", "ready", "Firebase Auth active · server verified admin claim");
    if (!databaseReady) {
      setStatus("Admin verified. Neon is not connected yet; set DATABASE_URL in the ignored backend/.env. No DB write has occurred.");
    }
    const result = await apiRequest(apiPath("/catalog"));
    catalog = result.data || [];
    fillResourceSelect();
    setControlsEnabled(serverAdmin && databaseReady);
  } catch (error) {
    serverAdmin = false;
    clearAdminDataState();
    setSystemState("#database-firebase-state", "offline", "Firebase or admin API unavailable");
    setStatus(`${error.message} Database forms remain locked.`, "error");
    setControlsEnabled(false);
  }
}

async function refresh() {
  await loadAdminData();
  if (serverAdmin && activeDataset) await renderRows();
}

$("#database-refresh").addEventListener("click", refresh);
resourceSelect.addEventListener("change", () => selectDataset(resourceSelect.value));
$("#database-new").addEventListener("click", () => openRecordForm());
$("#database-prev").addEventListener("click", () => { offset = Math.max(0, offset - pageSize); renderRows().catch((error) => setStatus(error.message, "error")); });
$("#database-next").addEventListener("click", () => { offset += pageSize; renderRows().catch((error) => setStatus(error.message, "error")); });
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { offset = 0; renderRows().catch((error) => setStatus(error.message, "error")); }, 220);
});
recordForm.addEventListener("submit", submitRecord);
$("#database-form-close").addEventListener("click", closeRecordForm);
$("#database-form-cancel").addEventListener("click", closeRecordForm);
$("#database-delete").addEventListener("click", removeRecordFromForm);
$("#database-version-form").addEventListener("submit", saveMaterialVersion);

try {
  authClient = await import("./firebase/auth-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, () => refresh().catch((error) => setStatus(error.message, "error")));
  await refresh();
} catch (error) {
  setSystemState("#database-firebase-state", "offline", "Firebase configuration is missing");
  setSystemState("#database-neon-state", "offline", "Waiting for verified server API");
  setStatus("Firebase client configuration could not load. Add the ignored firebase/firebase-config.local.mjs and reload.", "error");
  console.warn("Neon database panel unavailable:", error.message);
}
