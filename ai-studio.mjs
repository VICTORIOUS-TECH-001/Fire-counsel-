// FIRE COUNSEL AI studio (student side, ai.html). Talks only to this site's
// /api/v1/ai routes with the signed-in Firebase token; the server holds the AI
// keys, checks daily allowances and runs long jobs in the background. While a
// job runs the page shows "Fire is coming" with the live step from the server,
// and it stops waiting (with a retry button) if a reply takes far too long.
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
  const MODE_NAMES = { chat: "Fire Counsel", case: "Case analysis", notes: "Exam notes", questions: "Question setter" };
  // Quick study tools: they use the chat allowance with a special instruction.
  const TASKS = {
    mnemonics: { label: "🧠 Mnemonics", title: "Create mnemonics", help: "Type a topic, a list of elements or cases (or upload notes) and get memorable mnemonics with authorities and a quick self-test.", placeholder: "e.g. Elements of a valid contract…" },
    flashcards: { label: "🃏 Flashcards", title: "Flashcards from my notes", help: "Paste or upload notes, or name a topic, and get 10–20 question-and-answer cards.", placeholder: "Paste notes or type a topic…" },
    summary: { label: "📄 Summary", title: "Summarise a case or notes", help: "Name a case or paste/upload material. You get facts, issues, holding, ratio and key takeaways.", placeholder: "e.g. Summarise Salomon v Salomon, or paste notes…" },
    irac: { label: "🧩 IRAC answer", title: "Solve a problem question", help: "Paste the problem question. The answer follows Issue, Rule, Application and Conclusion with authorities.", placeholder: "Paste the problem question…" },
    explain: { label: "📷 Explain simply", title: "Explain my notes simply", help: "Upload a photo of your notes or type a topic and get a simple step-by-step explanation.", placeholder: "What should be explained? (or just upload a photo)" },
    library: { label: "📚 Course library", title: "Ask my course library", help: "Answers come mainly from the books and notes your administrator uploaded, cited as [Library: title, p. N].", placeholder: "Ask about something in your course materials…" },
    compare: { label: "⚔️ Compare cases", title: "Compare & distinguish cases", help: "Name two or more cases or doctrines. You get a comparison table and how they are reconciled or distinguished.", placeholder: "e.g. Compare Carlill v Carbolic with Partridge v Crittenden…" },
    statute: { label: "📜 Explain a section", title: "Explain a section or statute", help: "Name the section and the law (e.g. Section 36 of the 1999 Constitution).", placeholder: "e.g. Section 36 of the 1999 Constitution…" },
    essay: { label: "✍️ Essay plan", title: "Plan an essay answer", help: "Paste the essay question. You get a thesis, headed sections with authorities, counter-arguments and a conclusion.", placeholder: "Paste the essay question…" }
  };
  // Stop waiting (and offer a retry) a little after the server's own deadline.
  const MAX_WAIT_MS = { chat: 5.5 * 60_000, case: 15.5 * 60_000, notes: 13.5 * 60_000, questions: 11.5 * 60_000 };
  const STAGES = {
    reading: "Reading your files…",
    library: "Searching the Fire Counsel library…",
    searching: "Searching the web for trusted sources…",
    checking: "Opening and checking every source…",
    researching_case: "Researching the case…",
    detecting_course: "Finding your course and its past-question style…",
    writing: "Writing your answer…",
    finishing: "Checking the final links…"
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
  let task = null;
  let tickTimer = null;
  const firstSeen = new Map();
  const stalled = new Set();

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
    if (conversationId && ![...historySelect.options].some((o) => o.value === conversationId)) {
      historySelect.insertAdjacentHTML("beforeend", `<option value="${escapeHTML(conversationId)}">Current conversation</option>`);
    }
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
      const fire = `<div class="fc-fire" aria-hidden="true"><i class="fl fl1"></i><i class="fl fl2"></i><i class="fl fl3"></i><i class="fl fl4"></i><i class="em em1"></i><i class="em em2"></i><i class="em em3"></i></div>`;
      if (stalled.has(message.id)) {
        return `<div class="ai-msg ai-msg-ai"><span class="ai-avatar">🔥</span><div class="ai-bubble ai-pending" data-stalled="true">${fire}<div class="fc-wait-text"><strong class="fc-wait-title">The fire is taking too long…</strong><span class="fc-wait-stage">The AI service seems overloaded. Your request was not counted if it fails.</span><div class="fc-wait-actions"><button class="button soft" type="button" data-check="true">Check again</button><button class="button primary" type="button" data-retry="${escapeHTML(message.id)}" data-fresh="true">Send again</button></div></div></div></div>`;
      }
      const meta = message.meta || {};
      const long = mode === "case" || mode === "notes";
      let stage = STAGES[meta.stage] || "Getting ready…";
      if (meta.stage_detail && (meta.stage === "researching_case" || meta.stage === "checking")) stage = meta.stage === "checking" ? `Opening and checking ${meta.stage_detail}…` : `Researching case ${meta.stage_detail}…`;
      return `<div class="ai-msg ai-msg-ai"><span class="ai-avatar">🔥</span><div class="ai-bubble ai-pending" role="status">${fire}<div class="fc-wait-text"><strong class="fc-wait-title">🔥 Fire is coming…</strong><span class="fc-wait-stage">${escapeHTML(stage)}</span><small class="fc-wait-time" data-wait="${escapeHTML(message.id)}">${escapeHTML(waitText(message))}${long ? " · this can take 1–4 minutes" : ""} · you can leave this page; the answer is saved.</small></div></div></div>`;
    }
    if (message.status === "failed") {
      return `<div class="ai-msg ai-msg-ai"><span class="ai-avatar">FC</span><div class="ai-bubble ai-failed">${escapeHTML(message.content)}<div class="fc-wait-actions fc-retry"><button class="button soft" type="button" data-retry="${escapeHTML(message.id)}">↻ Try again</button></div></div></div>`;
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

  function startedAt(message) {
    if (!firstSeen.has(message.id)) firstSeen.set(message.id, Date.now());
    const server = Date.parse(message.created_at || "");
    const now = Date.now();
    // Trust the server time unless the phone clock is clearly different.
    return Number.isFinite(server) && server <= now + 60_000 && now - server < 60 * 60_000 ? Math.min(server, now) : firstSeen.get(message.id);
  }

  function waitText(message) {
    const seconds = Math.max(0, Math.round((Date.now() - startedAt(message)) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  function tick() {
    const pending = messages.filter((m) => m.status === "pending" && !stalled.has(m.id));
    if (!pending.length) { clearInterval(tickTimer); tickTimer = null; return; }
    for (const message of pending) {
      if (Date.now() - startedAt(message) > (MAX_WAIT_MS[mode] || MAX_WAIT_MS.case)) {
        stalled.add(message.id);
        stopPolling();
        setBusy(false);
        setStatus("This is taking much longer than usual. Check again in a moment or send it again.", "error");
        renderThread();
        return;
      }
      const node = thread.querySelector(`[data-wait="${CSS.escape(message.id)}"]`);
      if (node) node.textContent = node.textContent.replace(/^[^·]+/, `${waitText(message)} `);
    }
  }

  function renderThread() {
    const workspaceView = messages.length || mode !== "chat" || task ? "chat" : "home";
    document.body.dataset.view = workspaceView;
    if (!messages.length) {
      const info = task && mode === "chat" ? TASKS[task] : MODES[mode];
      thread.innerHTML = workspaceView === "home" ? "" : `<div class="ai-empty"><span>🔥</span><strong>${escapeHTML(info.title)}</strong><p>${escapeHTML(info.help)}</p></div>`;
      return;
    }
    thread.innerHTML = messages.map(messageHtml).join("");
    const scroller = workspace.scrollHeight > workspace.clientHeight ? workspace : thread;
    scroller.scrollTop = scroller.scrollHeight;
    if (messages.some((m) => m.status === "pending" && !stalled.has(m.id)) && !tickTimer) tickTimer = setInterval(tick, 1000);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function resetWaiting() {
    stopPolling();
    clearInterval(tickTimer);
    tickTimer = null;
    stalled.clear();
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
          const stageOf = (list) => list.map((m) => `${m.id}:${m.status}:${m.meta?.stage || ""}:${m.meta?.stage_detail || ""}`).join("|");
          if (!pending || stageOf(body.data.messages) !== stageOf(messages)) { messages = body.data.messages; renderThread(); }
          if (pending && messages.some((m) => stalled.has(m.id))) return;
          if (pending) return schedulePoll(mySession, id, Math.min(delay + 1000, 6000));
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
    sendButton.dataset.busy = String(busy);
    sendButton.setAttribute("aria-label", busy ? "Working…" : "Send");
  }

  function options() {
    const result = {};
    if (mode === "chat") result.webSearch = $("#ai-web-search").checked;
    if (mode === "chat" && task) result.task = task;
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
      stalled.clear();
      const newConversation = conversationId !== body.data.conversation.id;
      conversationId = body.data.conversation.id;
      messages = newConversation ? body.data.messages : [...messages, ...body.data.messages];
      input.value = "";
      autosize();
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
    if (event.target.closest("[data-check]")) {
      stalled.clear();
      setStatus("Checking again…");
      openConversation(conversationId, { quiet: false }).catch(() => {});
      return;
    }
    const retry = event.target.closest("[data-retry]");
    if (retry) {
      const fresh = retry.dataset.fresh === "true";
      if (lastRequest) {
        // A request still marked "pending" blocks its conversation, so a stuck one is resent in a new conversation.
        send({ ...lastRequest, conversationId: fresh ? null : conversationId });
      } else {
        const index = messages.findIndex((m) => m.id === retry.dataset.retry);
        const question = [...messages.slice(0, index)].reverse().find((m) => m.role === "user");
        input.value = question?.content || "";
        autosize();
        if (fresh) { conversationId = null; messages = []; renderThread(); }
        input.focus();
        setStatus("Press send to try again. Re-attach any files you used.", "");
      }
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
  function setMode(next, { task: nextTask = null, fresh = false } = {}) {
    if (!MODES[next]) return;
    nextTask = next === "chat" && TASKS[nextTask] ? nextTask : null;
    if (next !== mode || fresh) {
      resetWaiting();
      conversationId = null;
      messages = [];
      setBusy(false);
    }
    mode = next;
    task = nextTask;
    workspace.dataset.mode = mode;
    document.body.dataset.mode = mode;
    document.querySelectorAll("[data-ai-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.aiMode === mode && (b.dataset.aiTask || null) === task)));
    document.querySelectorAll(".ai-option[data-for]").forEach((o) => { o.hidden = !o.dataset.for.split(" ").includes(mode); });
    const info = task ? TASKS[task] : MODES[mode];
    $("#ai-mode-eyebrow").textContent = task ? `FIRE COUNSEL AI · ${TASKS[task].label.replace(/^\S+\s/, "").toUpperCase()}` : MODES[mode].eyebrow;
    $("#ai-workspace-title").textContent = info.title;
    $("#ai-mode-help").textContent = info.help;
    $("#fc-mode-name").textContent = task ? TASKS[task].title : MODE_NAMES[mode];
    $("#fc-history-mode").textContent = { chat: "Chat", case: "Case analysis", notes: "Exam notes", questions: "Question setter" }[mode];
    $("#fc-task").hidden = !task;
    $("#fc-task-label").textContent = task ? TASKS[task].label : "";
    input.placeholder = mode === "chat" && !task ? "Ask me anytime…" : info.placeholder;
    renderThread();
    if (user) {
      loadHistory().catch(() => {});
      loadMe(session).catch(() => {});
    }
  }

  historySelect.addEventListener("change", () => { resetWaiting(); setBusy(false); openConversation(historySelect.value).catch(() => {}); closeDrawer(); });
  $("#ai-new-conversation").addEventListener("click", () => { historySelect.value = ""; resetWaiting(); setBusy(false); openConversation(null); closeDrawer(); input.focus(); });
  $("#ai-delete-conversation").addEventListener("click", async () => {
    if (!conversationId || !window.confirm("Delete this conversation and its answers? This cannot be undone.")) return;
    const { response } = await api(`/api/v1/ai/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
    if (response.ok || response.status === 404) { await openConversation(null); loadHistory().catch(() => {}); setStatus("Conversation deleted.", "ok"); }
  });

  // ------------------------------------------------------------ page controls
  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener("input", autosize);

  const drawer = $("#fc-drawer");
  const scrim = $("#fc-scrim");
  const menuButton = $("#fc-menu");
  function openDrawer() { drawer.hidden = false; scrim.hidden = false; menuButton.setAttribute("aria-expanded", "true"); $("#fc-drawer-close").focus(); }
  function closeDrawer() { drawer.hidden = true; scrim.hidden = true; menuButton.setAttribute("aria-expanded", "false"); }
  menuButton.addEventListener("click", openDrawer);
  $("#fc-drawer-close").addEventListener("click", () => { closeDrawer(); menuButton.focus(); });
  scrim.addEventListener("click", closeDrawer);

  const functionsSheet = $("#fc-functions");
  const researchSheet = $("#fc-research");
  let sheetOpener = null;
  function openSheet(sheet) {
    sheetOpener = document.activeElement;
    closeDrawer();
    sheet.hidden = false;
    sheet.scrollTop = 0;
    sheet.querySelector(".fc-sheet-top button")?.focus();
  }
  function closeSheet(sheet) {
    sheet.hidden = true;
    if (sheetOpener && document.contains(sheetOpener) && !sheetOpener.closest("[hidden]")) sheetOpener.focus();
  }
  for (const id of ["#fc-open-functions", "#fc-open-functions-top", "#fc-mode-switch", "#fc-drawer-functions"]) $(id).addEventListener("click", () => openSheet(functionsSheet));
  $("#fc-functions-back").addEventListener("click", () => closeSheet(functionsSheet));
  $("#fc-open-research").addEventListener("click", () => openSheet(researchSheet));
  $("#fc-research-back").addEventListener("click", () => closeSheet(researchSheet));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!researchSheet.hidden) closeSheet(researchSheet);
    else if (!functionsSheet.hidden) closeSheet(functionsSheet);
    else if (!drawer.hidden) closeDrawer();
  });

  // Tabs: Must-Try / What's New / Advanced
  const tabs = [...document.querySelectorAll(".fc-tabs [role=tab]")];
  function selectTab(tab) {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      selectTab(next);
      next.focus();
    });
  });

  // Every function row and quick-start chip.
  document.addEventListener("click", (event) => {
    const item = event.target.closest("[data-ai-mode],[data-open-research],[data-open-drawer]");
    if (!item || item.closest("#ai-thread")) return;
    if (item.dataset.openResearch) { functionsSheet.hidden = true; openSheet(researchSheet); return; }
    if (item.dataset.openDrawer) { functionsSheet.hidden = true; openDrawer(); return; }
    functionsSheet.hidden = true;
    setMode(item.dataset.aiMode, { task: item.dataset.aiTask || null, fresh: true });
    const webSearch = $("#ai-web-search");
    if (!webSearch.disabled) webSearch.checked = item.dataset.webSearch !== "false";
    if (item.dataset.prompt) {
      if (mode === "case") { $("#ai-case-query").value = item.dataset.prompt; input.value = ""; }
      else input.value = item.dataset.prompt;
      autosize();
    }
    if (item.dataset.openFiles) fileInput.click();
    else input.focus();
  });
  $("#fc-task-clear").addEventListener("click", () => { setMode("chat", { fresh: !messages.length }); input.focus(); });

  // Light / dark theme (remembered on this device only).
  const THEME_KEY = "fire-counsel-ai-theme";
  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#07060c" : "#f3f4f8");
  }
  try { applyTheme(localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"); } catch { applyTheme("dark"); }
  $("#fc-theme").addEventListener("click", () => {
    const theme = document.body.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  });

  $("#fc-share").addEventListener("click", async () => {
    const data = { title: "Fire Counsel AI", text: "Study law faster with Fire Counsel AI", url: new URL("./ai.html", location.href).href };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.url); setStatus("Link copied.", "ok"); }
    } catch { /* cancelled */ }
  });

  // Voice typing (Chrome on Android supports this).
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("#fc-mic");
  if (Recognition) {
    mic.hidden = false;
    let recognizer = null;
    mic.addEventListener("click", () => {
      if (recognizer) { recognizer.stop(); return; }
      recognizer = new Recognition();
      recognizer.lang = navigator.language || "en-NG";
      recognizer.interimResults = false;
      recognizer.onresult = (event) => {
        const words = [...event.results].map((r) => r[0].transcript).join(" ").trim();
        input.value = `${input.value ? `${input.value.trimEnd()} ` : ""}${words}`;
        autosize();
      };
      recognizer.onerror = () => setStatus("Voice typing is not available right now. Please type instead.", "error");
      recognizer.onend = () => { recognizer = null; mic.dataset.listening = "false"; };
      mic.dataset.listening = "true";
      recognizer.start();
    });
  }

  const params = new URLSearchParams(location.search);
  setMode(MODES[params.get("mode")] ? params.get("mode") : "chat", { task: params.get("task") });

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
      resetWaiting();
      user = nextUser;
      document.body.dataset.signedIn = String(Boolean(user));
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
        renderThread();
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
