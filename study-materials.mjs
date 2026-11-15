const status = document.querySelector("#server-materials-status");
const list = document.querySelector("#server-material-list");
const refreshButton = document.querySelector("#refresh-server-materials");
let authClient;
let currentUser = null;

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "ready";
}

function clearList(message) {
  list.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "server-material-empty";
  empty.textContent = message;
  list.append(empty);
}

async function readJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

function materialCard(material) {
  const article = document.createElement("article");
  article.className = "server-material-card";

  const header = document.createElement("header");
  const title = document.createElement("h3");
  title.textContent = material.title || "Untitled course material";
  header.append(title);
  article.append(header);

  const meta = document.createElement("div");
  meta.className = "server-material-meta";
  for (const value of [material.course_title, material.topic_title, material.material_type, material.version_number ? `Version ${material.version_number}` : null]) {
    if (!value) continue;
    const chip = document.createElement("span");
    chip.textContent = String(value).replaceAll("_", " ");
    meta.append(chip);
  }
  article.append(meta);

  if (material.description) {
    const description = document.createElement("p");
    description.className = "server-material-description";
    description.textContent = material.description;
    article.append(description);
  }

  const details = document.createElement("details");
  details.className = "server-material-content";
  const summary = document.createElement("summary");
  summary.textContent = "Read approved material text";
  const content = document.createElement("pre");
  content.textContent = "Open to load this material from the authenticated Neon API.";
  details.append(summary, content);
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    if (!currentUser || !authClient) {
      content.textContent = "Sign in again to read this material.";
      return;
    }
    content.textContent = "Loading approved text…";
    try {
      const response = await authClient.apiRequest(`/api/v1/materials/${encodeURIComponent(material.id)}`);
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
      content.textContent = body.data?.extracted_text || "No text version is available for this material yet.";
      loaded = true;
    } catch (error) {
      content.textContent = error.message || "Material could not be loaded.";
    }
  });
  article.append(details);
  return article;
}

async function loadMaterials() {
  if (!currentUser || !authClient) {
    setStatus("Sign in to load materials approved for your account.");
    clearList("Published Neon materials appear here only when your course or institution access allows them.");
    return;
  }
  refreshButton.disabled = true;
  setStatus("Checking your approved course materials…");
  try {
    const response = await authClient.apiRequest("/api/v1/materials?limit=25");
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || `Materials API is not ready (${response.status}).`);
    const materials = Array.isArray(body.data) ? body.data : [];
    list.replaceChildren();
    if (!materials.length) {
      setStatus("No published materials are currently available for this account.");
      clearList("Ask an administrator to check the material's approval, publication and course access settings.");
      return;
    }
    for (const material of materials) list.append(materialCard(material));
    setStatus(`${materials.length} published material${materials.length === 1 ? "" : "s"} available. Your personal files remain local to this device.`);
  } catch (error) {
    setStatus(error.message || "The Neon materials API could not be reached.", true);
    clearList("This does not affect your local documents or IndexedDB study data.");
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadMaterials);

try {
  authClient = await import("./firebase/auth-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, (user) => {
    currentUser = user;
    loadMaterials();
  }, () => {
    currentUser = null;
    setStatus("Firebase Auth could not verify this session.", true);
    clearList("Reload or sign in again to check course materials.");
  });
} catch (error) {
  setStatus("Firebase client configuration is not available. Local study files are unaffected.", true);
  clearList("Create the ignored Firebase Web config locally and reload to connect to approved Neon materials.");
  console.warn("Neon course materials unavailable:", error.message);
}
