// FIRE COUNSEL AI studio (student side). Talks only to this site's /api/v1/ai
// routes with the signed-in Firebase token; the server holds the AI keys,
// checks daily allowances and runs long jobs in the background.
import { escapeHTML, renderMarkdown, safeHref } from "./ai-markdown.mjs";

const $ = (selector) => document.querySelector(selector);
const workspace = $("#ai-workspace");
if (workspace) initStudio();

function initStudio() {
  const thread = $("#ai-thread");
  const form = $("#ai-form");
  const input = $("#ai-input");
  const sendButton = $("#ai-send");
  const fileInput = $("#ai-file-input");
  const filesHolder = $("#ai-files");
  const historySelect = $("#ai-history-select");
  const courseSelect = $("#ai-course-select");
  const status = $("#ai-status");
  const MAX_FILES = 6;
  const MAX_FILE = 10 * 1024 * 1024;
  const MAX_TOTAL = 18 * 1024 * 1024;

  const MODES = {
    chat: { eyebrow: "FIRE COUNSEL AI · CHAT", title: "Ask Fire Counsel AI", help: "Ask a legal question or upload notes, textbook photos or a PDF. Answers include checked links when web search is on.", placeholder: "Ask a question, or paste your notes…", feature: "chat" },
    case: { eyebrow: "CASE ANALYSIS · MASTER CASE RESEARCH FORMAT", title: "Case analysis", help: "Type a case name or citation, or upload the textbook pages; every case they cite is researched. Each source is opened and checked, and you can download the result as a PDF. This can take 1–4 minutes.", placeholder: "Optional: what your lecturer or textbook says about the case, or the subject (e.g. Law of Contract)…", feature: "case" },
    notes: { eyebrow: "EXAM-READY NOTES", title: "Exam-ready notes", help: "Upload or paste your lecture notes or textbook pages. The notes use only your material unless you allow outside research. Download as Word or PDF.", placeholder: "Paste your notes here, or upload them below…", feature: "notes" },
    questions: { eyebrow: "QUESTION SETTER · YOUR COURSE'S STYLE", title: "Set exam questions", help: "Give the notes or topic to set questions on. FIRE COUNSEL finds your course and copies its past-question format: number of questions, marks, time and style.", placeholder: "Paste the notes or topics to be examined…", feature: "questions" }
  };

  let authClient = null;
  let user = null;
  let session = 0;
  let mode = "chat";
  let conversationId = null;
  let messages = [];
  let files = [];
  let pollTimer = null;
  let lastRequest = null;
  let config = { configured: false, web_search: false };

  function setStatus(text, state = "") {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function api(path, options = {}) {
    const response = await authClient.apiRequest(path, options);
    let body = {};
    if ((response.headers.get("content-type") || "").includes("json")) {
      try { body = await response.json(); } catch { body = {}; }
    }
    return { response, body };
  }

  // ------------------------------------------------------------ allowance
  function renderAllowance(allowance) {
    const list = $("#ai-allowance-list");
    const badge = $("#ai-allowance-badge");
    const inline = $("#ai-allowance-inline");
    if (!allowance) {
      list.innerHTML = `<p class="ai-account-hint">Sign in to see how many AI chats, case analyses, notes and question sets you have left today.</p>`;
      badge.textContent = "SIGN IN";
      inline.textContent = "";
      return;
    }
    badge.textContent = allowance.unlimited ? "ADMIN · UNLIMITED" : allowance.paused ? "PAUSED" : "TODAY";
    list.innerHTML = Object.entries(allowance.features).map(([key, f]) => {
      const pct = f.limit ? Math.min(100, Math.round((f.used / f.limit) * 100)) : 0;
      const value = f.limit == null ? `${f.used} used · no limit` : `${f.remaining} of ${f.limit} left`;
      return `<div class="ai-allowance-row" data-feature="${escapeHTML(key)}"><div><strong>${escapeHTML(f.label)}</strong><span>${escapeHTML(value)}</span></div><div class="ai-meter"><span style="width:${f.limit == null ? 0 : pct}%"></span></div></div>`;
    }).join("") + (allowance.paused ? `<p class="ai-paused-note">AI access is paused for this account. Contact the administrator.</p>` : "");
    const current = allowance.features[MODES[mode].feature];
    inline.textContent = !current ? "" : current.limit == null ? "No daily limit" : `${current.remaining} of ${current.limit} left today`;
  }

  async function loadMe(mySession, { announce = false } = {}) {
    const { response, body } = await api("/api/v1/ai/me");
    if (mySession !== session) return;
    if (!response.ok) {
      renderAllowance(null);
      throw new Error(body.error || `Fire Counsel AI is unavailable (${response.status}).`);
    }
    config = body.data;
    renderAllowance(body.data.allowance);
    const webSearch = $("#ai-web-search");
    webSearch.disabled = !config.web_search;
    if (!config.web_search) webSearch.checked = false;
    if (!announce && config.configured && config.email_verified) return;
    if (!config.configured) setStatus("The AI key has not been added on the server yet. Ask the administrator to add GEMINI_API_KEY in Render.", "error");
    else if (!config.email_verified) setStatus("Verify your email address to use Fire Counsel AI: open the link we emailed you, then sign out and in again.", "error");
    else setStatus("Ready. Choose a tool, then type or upload your material.", "ok");
  }

  async function loadCourses(mySession) {
    const { response, body } = await api("/api/v1/ai/courses");
    if (mySession !== session || !response.ok) return;
    const selected = courseSelect.value;
    courseSelect.innerHTML = `<option value="auto">Detect automatically</option>` + (body.data || []).map((c) => `<option value="${escapeHTML(c.id)}">${escapeHTML([c.course_code, c.title, c.university].filter(Boolean).join(" · "))}</option>`).join("");
    if ([...courseSelect.options].some((o) => o.value === selected)) courseSelect.value = selected;
  }

  async function loadHistory(mySession = session) {
    const { response, body } = await api(`/api/v1/ai/conversations?mode=${encodeURIComponent(mode)}`);
    if (mySession !== session || !response.ok) return;
    historySelect.innerHTML = `<option value="">New conversation</option>` + (body.data || []).map((c) => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.title)} · ${escapeHTML(new Date(c.updated_at).toLocaleDateString())}</option>`).join("");
    historySelect.value = conversationId || "";
    $("#ai-delete-conversation").hidden = !conversationId;
  }

  // ------------------------------------------------------------ thread
  const STATUS_LABEL = { verified: ["Checked", "Opened and mentions the case/topic"], reachable: ["Opens", "Page opens; case name not seen on it"], restricted: ["Check yourself", "Site blocks automatic checks"], broken: ["Broken", "Could not be opened; do not rely on it"] };

  function sourcesHtml(sources) {
    if (!sources?.length) return "";
    return `<details class="ai-sources"${sources.length <= 6 ? " open" : ""}><summary>Verification links (${sources.filter((s) => /^https?:/i.test(String(s.url || ""))).length})</summary><ol>${sources.map((s) => {
      const [label, title] = STATUS_LABEL[s.status] || [s.status, ""];
      // Only http(s) links are ever clickable, whatever the server sends.
      const href = /^https?:/i.test(String(s.url || "")) ? safeHref(s.url) : null;
      if (!href) return "";
      let host = "";
      try { host = new URL(href).hostname; } catch { return ""; }
      return `<li><a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.title || host)}</a> <span class="ai-link-badge" data-status="${escapeHTML(s.status)}" title="${escapeHTML(title)}">${escapeHTML(label)}</span><small>${escapeHTML(host)}</small></li>`;
    }).join("")}</ol></details>`;
  }

  function messageHtml(message) {
    if (message.role === "user") {
      const attachments = (message.attachments || []).map((a) => `<span class="ai-chip">📎 ${escapeHTML(a.name)}</span>`).join("");
      return `<div class="ai-msg ai-msg-user"><div class="ai-bubble">${escapeHTML(message.content || "").replace(/\n/g, "<br>") || "<em>(files only)</em>"}${attachments ? `<div class="ai-chips">${attachments}</div>` : ""}</div></div>`;
    }
    if (message.status === "pending") {
      const long = mode === "case" || mode === "notes";
      return `<div class="ai-msg ai-msg-ai"><span class="ai-avatar">FC</span><div class="ai-bubble ai-pending"><span class="ai-dots"><i></i><i></i><i></i></span> Fire Counsel AI is working${long ? " — researching and checking every source takes 1–4 minutes" : "…"}. You can leave this page; the answer is saved in this conversation.</div></div>`;
    }
    if (message.status === "failed") {
      return `<div class="ai-msg ai-msg-ai"><span class="ai-avatar">FC</span><div class="ai-bubble ai-failed">${escapeHTML(message.content)}</div></div>`;
    }
    const meta = message.meta || {};
    const notes = [];
    if (meta.fallback) notes.push("Answered by a free backup model because Gemini was busy");
    if (meta.web_search === false && mode === "chat") notes.push("Not web-verified");
    if (meta.course?.label) notes.push(`Course: ${meta.course.label}${meta.detection ? " (detected)" : ""}`);
    if (typeof meta.past_questions === "number" && mode === "questions") notes.push(meta.past_questions ? `${meta.past_questions} past questions used as the format` : "No past questions stored yet for this course");
    if (meta.pending_cases?.length) notes.push(`${meta.pending_cases.length} more case(s) waiting — send “continue”`);
    const candidates = (meta.candidates || []).map((c) => `<button class="button soft" type="button" data-pick-course="${escapeHTML(c.id)}">Use ${escapeHTML(c.label)}</button>`).join("");
    const downloads = meta.needs_course ? "" : `<div class="ai-downloads"><button class="button soft" type="button" data-download="${escapeHTML(message.id)}" data-format="pdf">⬇ PDF</button><button class="button soft" type="button" data-download="${escapeHTML(message.id)}" data-format="docx">⬇ Word</button><button class="button soft" type="button" data-copy="${escapeHTML(message.id)}">Copy</button></div>`;
    return `<div class="ai-msg ai-msg-ai"><span class="ai-avatar">FC</span><div class="ai-bubble ai-answer"><div class="ai-markdown">${renderMarkdown(message.content)}</div>${candidates ? `<div class="ai-candidates">${candidates}</div>` : ""}${sourcesHtml(message.sources)}${notes.length ? `<p class="ai-meta">${notes.map(escapeHTML).join(" · ")}</p>` : ""}${downloads}</div></div>`;
  }

  function renderThread() {
    if (!messages.length) {
      thread.innerHTML = `<div class="ai-empty"><span>✦</span><strong>${escapeHTML(MODES[mode].title)}</strong><p>${escapeHTML(MODES[mode].help)}</p></div>`;
      return;
    }
    thread.innerHTML = messages.map(messageHtml).join("");
    thread.scrollTop = thread.scrollHeight;
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function openConversation(id, { quiet = false } = {}) {
    stopPolling();
    const mySession = session;
    conversationId = id || null;
    $("#ai-delete-conversation").hidden = !conversationId;
    if (!conversationId) { messages = []; renderThread(); return; }
    const { response, body } = await api(`/api/v1/ai/conversations/${encodeURIComponent(conversationId)}`);
    if (mySession !== session || conversationId !== id) return;
    if (!response.ok) { if (!quiet) setStatus(body.error || "Could not open that conversation.", "error"); return; }
    messages = body.data.messages;
    renderThread();
    if (messages.some((m) => m.status === "pending")) schedulePoll(mySession, id);
  }

  function schedulePoll(mySession, id, delay = 3000) {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (mySession !== session || conversationId !== id) return;
      try {
        const { response, body } = await api(`/api/v1/ai/conversations/${encodeURIComponent(id)}`);
        if (mySession !== session || conversationId !== id) return;
        if (response.ok) {
          const pending = body.data.messages.some((m) => m.status === "pending");
          if (!pending || body.data.messages.length !== messages.length) { messages = body.data.messages; renderThread(); }
          if (pending) return schedulePoll(mySession, id, Math.min(delay + 1000, 8000));
          setBusy(false);
          setStatus("Answer ready.", "ok");
          loadMe(mySession).catch(() => {});
          return;
        }
      } catch { /* network blip: keep polling */ }
      schedulePoll(mySession, id, 8000);
    }, delay);
  }

  // ------------------------------------------------------------ files
  function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.readAsDataURL(blob);
    });
  }

  async function shrinkImage(file) {
    // Phone photos are often 4–10 MB; 2200px JPEG keeps text readable.
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.2 * 1024 * 1024 || typeof createImageBitmap !== "function") return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
    } catch {
      return file;
    }
  }

  function mimeOf(file) {
    if (file.type) return file.type === "image/jpg" ? "image/jpeg" : file.type;
    if (/\.txt$/i.test(file.name)) return "text/plain";
    if (/\.heic$/i.test(file.name)) return "image/heic";
    if (/\.heif$/i.test(file.name)) return "image/heif";
    if (/\.pdf$/i.test(file.name)) return "application/pdf";
    return "";
  }

  function renderFiles() {
    filesHolder.innerHTML = files.map((f, i) => `<span class="ai-chip">📎 ${escapeHTML(f.name)} <small>${(f.size / 1024 / 1024).toFixed(1)} MB</small><button type="button" data-remove-file="${i}" aria-label="Remove ${escapeHTML(f.name)}">×</button></span>`).join("");
  }

  async function addFiles(list) {
    for (const original of list) {
      if (files.length >= MAX_FILES) { setStatus(`You can attach up to ${MAX_FILES} files at a time.`, "error"); break; }
      const mimeType = mimeOf(original);
      if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "text/plain"].includes(mimeType)) {
        setStatus(`${original.name}: only photos, PDF and .txt files can be sent.`, "error");
        continue;
      }
      const file = await shrinkImage(original);
      if (file.size > MAX_FILE) { setStatus(`${original.name} is larger than 10 MB. Use a smaller photo or split the PDF.`, "error"); continue; }
      if (files.reduce((sum, f) => sum + f.size, 0) + file.size > MAX_TOTAL) { setStatus("Files are more than 18 MB in total. Send fewer pages at a time.", "error"); break; }
      files.push({ name: original.name, mimeType: file === original ? mimeType : "image/jpeg", size: file.size, blob: file });
    }
    renderFiles();
  }

  // ------------------------------------------------------------ sending
  function setBusy(busy) {
    sendButton.disabled = busy;
    sendButton.textContent = busy ? "Working…" : "Send";
  }

  function options() {
    const result = {};
    if (mode === "chat") result.webSearch = $("#ai-web-search").checked;
    if (mode === "case") result.caseQuery = $("#ai-case-query").value.trim();
    if (mode === "notes") {
      result.topic = $("#ai-topic").value.trim();
      result.allowResearch = $("#ai-allow-research").checked;
      result.questionBank = $("#ai-question-bank").checked;
    }
    if (mode === "notes" || mode === "questions") result.courseId = courseSelect.value || "auto";
    if (mode === "notes" && result.courseId === "auto") delete result.courseId;
    if (mode === "questions") {
      const count = Number($("#ai-question-count").value);
      if (Number.isInteger(count) && count > 0) result.count = count;
    }
    return result;
  }

  async function send(request) {
    if (!user || !authClient) { setStatus("Sign in first to use Fire Counsel AI.", "error"); return; }
    const mySession = session;
    setBusy(true);
    setStatus(request.attachments.length ? "Uploading your files…" : "Sending…");
    try {
      const attachments = [];
      for (const f of request.attachments) attachments.push({ name: f.name, mimeType: f.mimeType, data: await readAsBase64(f.blob) });
      const { response, body } = await api("/api/v1/ai/messages", {
        method: "POST",
        body: JSON.stringify({ mode: request.mode, text: request.text, attachments, options: request.options, conversation_id: request.conversationId || undefined })
      });
      if (mySession !== session) return;
      if (!response.ok) {
        setBusy(false);
        setStatus(body.error || `Fire Counsel AI could not take this request (${response.status}).`, "error");
        if (response.status === 429 || response.status === 403) loadMe(mySession).catch(() => {});
        return;
      }
      lastRequest = request;
      const newConversation = conversationId !== body.data.conversation.id;
      conversationId = body.data.conversation.id;
      messages = newConversation ? body.data.messages : [...messages, ...body.data.messages];
      input.value = "";
      files = [];
      renderFiles();
      renderThread();
      setStatus("Fire Counsel AI is working on it…");
      loadHistory(mySession).catch(() => {});
      loadMe(mySession).catch(() => {});
      schedulePoll(mySession, conversationId, 2500);
    } catch (error) {
      if (mySession !== session) return;
      setBusy(false);
      setStatus(error.message || "Could not reach Fire Counsel AI. Check your connection and try again.", "error");
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (sendButton.disabled) return;
    const text = input.value.trim();
    const opts = options();
    if (!text && !files.length && !(mode === "case" && opts.caseQuery)) {
      setStatus(mode === "case" ? "Type a case name or upload the textbook pages." : "Type a message or attach a file.", "error");
      return;
    }
    send({ mode, text, attachments: [...files], options: opts, conversationId });
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });

  fileInput.addEventListener("change", async () => {
    await addFiles([...fileInput.files]);
    fileInput.value = "";
  });

  filesHolder.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-file]");
    if (!button) return;
    files.splice(Number(button.dataset.removeFile), 1);
    renderFiles();
  });

  thread.addEventListener("click", async (event) => {
    const pick = event.target.closest("[data-pick-course]");
    if (pick && lastRequest) {
      if (![...courseSelect.options].some((o) => o.value === pick.dataset.pickCourse)) return;
      courseSelect.value = pick.dataset.pickCourse;
      send({ ...lastRequest, options: { ...lastRequest.options, courseId: pick.dataset.pickCourse }, conversationId });
      return;
    }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const message = messages.find((m) => m.id === copy.dataset.copy);
      try { await navigator.clipboard.writeText(message?.content || ""); setStatus("Answer copied.", "ok"); } catch { setStatus("Copy is not available in this browser.", "error"); }
      return;
    }
    const download = event.target.closest("[data-download]");
    if (!download) return;
    download.disabled = true;
    const label = download.textContent;
    download.textContent = "Preparing…";
    try {
      const response = await authClient.apiRequest(`/api/v1/ai/messages/${encodeURIComponent(download.dataset.download)}/export?format=${encodeURIComponent(download.dataset.format)}`);
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const blob = await response.blob();
      const name = (response.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || `fire-counsel.${download.dataset.format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setStatus(error.message || "Download failed.", "error");
    } finally {
      download.disabled = false;
      download.textContent = label;
    }
  });

  // ------------------------------------------------------------ modes & history
  function setMode(next, { scroll = false } = {}) {
    if (!MODES[next]) return;
    if (next !== mode) {
      stopPolling();
      conversationId = null;
      messages = [];
      setBusy(false);
    }
    mode = next;
    workspace.dataset.mode = mode;
    document.querySelectorAll("[data-ai-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.aiMode === mode)));
    document.querySelectorAll(".ai-option[data-for]").forEach((o) => { o.hidden = !o.dataset.for.split(" ").includes(mode); });
    $("#ai-mode-eyebrow").textContent = MODES[mode].eyebrow;
    $("#ai-workspace-title").textContent = MODES[mode].title;
    $("#ai-mode-help").textContent = MODES[mode].help;
    input.placeholder = MODES[mode].placeholder;
    renderThread();
    if (user) {
      loadHistory().catch(() => {});
      loadMe(session).catch(() => {});
    }
    if (scroll) workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.querySelectorAll("[data-ai-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.aiMode, { scroll: true })));
  historySelect.addEventListener("change", () => { setBusy(false); openConversation(historySelect.value).catch(() => {}); });
  $("#ai-new-conversation").addEventListener("click", () => { historySelect.value = ""; setBusy(false); openConversation(null); input.focus(); });
  $("#ai-delete-conversation").addEventListener("click", async () => {
    if (!conversationId || !window.confirm("Delete this conversation and its answers? This cannot be undone.")) return;
    const { response } = await api(`/api/v1/ai/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
    if (response.ok || response.status === 404) { await openConversation(null); loadHistory().catch(() => {}); setStatus("Conversation deleted.", "ok"); }
  });

  setMode("chat");

  // ------------------------------------------------------------ sign-in
  (async () => {
    try {
      authClient = await import("./firebase/auth-client.mjs");
    } catch {
      setStatus("Sign-in is not configured on this copy of the website, so Fire Counsel AI is unavailable.", "error");
      sendButton.disabled = true;
      return;
    }
    authClient.onAuthStateChanged(authClient.firebaseAuth, (nextUser) => {
      session += 1;
      stopPolling();
      user = nextUser;
      conversationId = null;
      messages = [];
      files = [];
      renderFiles();
      setBusy(false);
      renderThread();
      if (!user) {
        renderAllowance(null);
        historySelect.innerHTML = `<option value="">New conversation</option>`;
        setStatus("Sign in to use Fire Counsel AI.");
        return;
      }
      const mySession = session;
      setStatus("Connecting to Fire Counsel AI…");
      loadMe(mySession, { announce: true }).catch((error) => { if (mySession === session) setStatus(error.message, "error"); });
      loadCourses(mySession).catch(() => {});
      loadHistory(mySession).catch(() => {});
    }, () => setStatus("Firebase could not verify this session. Sign in again.", "error"));
  })();
}
