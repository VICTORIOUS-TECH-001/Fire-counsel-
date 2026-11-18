(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const DB_NAME = "lexmaster-ai-stage1";
  const DB_VERSION = 1;
  const subjectSeeds = [
    {name:"Contract Law", area:"Private law", symbol:"◇", color:"#a995ff", bg:"#29264b"},
    {name:"Constitutional Law", area:"Public law", symbol:"§", color:"#63d7e7", bg:"#183c4b"},
    {name:"Criminal Law", area:"Public law", symbol:"⚖", color:"#f2bd78", bg:"#473522"},
    {name:"Tort Law", area:"Private law", symbol:"✧", color:"#f18db3", bg:"#47283d"},
    {name:"Land Law", area:"Property law", symbol:"⌂", color:"#79d6a9", bg:"#1d4038"},
    {name:"Legal System & Method", area:"Foundations", symbol:"⌘", color:"#83b7ff", bg:"#203650"}
  ];
  let db;
  let subjects = [];
  let documents = [];
  let cards = [];
  let currentCardIndex = 0;
  let showingAnswer = false;
  let deferredInstallPrompt = null;
  let timerInterval = null;
  let timerRemaining = 25 * 60;
  let timerRunning = false;
  let firebaseClient = null;
  let currentUser = null;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB is unavailable in this browser."));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("documents")) database.createObjectStore("documents", {keyPath:"id"});
        if (!database.objectStoreNames.contains("cards")) database.createObjectStore("cards", {keyPath:"id"});
        if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", {keyPath:"key"});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function storeRequest(store, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const objectStore = tx.objectStore(store);
      const request = operation(objectStore);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  const getAll = name => storeRequest(name, "readonly", s => s.getAll());
  const put = (name, value) => storeRequest(name, "readwrite", s => s.put(value));
  const remove = (name, key) => storeRequest(name, "readwrite", s => s.delete(key));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const formatSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
  function toast(message) {
    const el = $("#toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.classList.remove("show"), 2600);
  }
  function subjectCard(subject, index) {
    const color = subject.color || subjectSeeds[index % subjectSeeds.length].color;
    const bg = subject.bg || subjectSeeds[index % subjectSeeds.length].bg;
    return `<button class="subject-card" data-subject="${escapeHTML(subject.name)}" style="--card-accent:${color};--card-bg:${bg};--card-glow:${color}22"><span class="subject-symbol">${escapeHTML(subject.symbol || "§")}</span><strong>${escapeHTML(subject.name)}</strong><small>${escapeHTML(subject.area || "Law subject")}</small></button>`;
  }
  function renderSubjects() {
    $("#dashboard-subjects").innerHTML = subjects.slice(0,6).map(subjectCard).join("");
    $("#all-subjects").innerHTML = subjects.map(subjectCard).join("");
    $("#stat-subjects").textContent = subjects.length;
    $("#card-subject").innerHTML = subjects.map(s => `<option value="${escapeHTML(s.name)}">${escapeHTML(s.name)}</option>`).join("");
    const aiCourse = $("#ai-course");
    if (aiCourse) {
      const selected = aiCourse.value;
      aiCourse.innerHTML = '<option value="">General legal research</option>' + subjects.map(s => `<option value="${escapeHTML(s.name)}">${escapeHTML(s.name)}</option>`).join("");
      aiCourse.value = selected;
    }
  }
  function renderDocuments() {
    $("#stat-materials").textContent = documents.length;
    $("#library-count").textContent = `${documents.length} ${documents.length === 1 ? "file" : "files"}`;
    const list = $("#document-list");
    if (!documents.length) {
      list.innerHTML = `<div class="empty-state"><span>▤</span><strong>Your library is ready</strong><p>Add a PDF, text file or Markdown note to start building your personal collection.</p></div>`;
      return;
    }
    list.innerHTML = documents.sort((a,b) => b.addedAt-a.addedAt).map(doc => `<div class="document-item"><span class="file-icon">▤</span><div class="document-meta"><strong>${escapeHTML(doc.name)}</strong><small>${formatSize(doc.size)} · Added ${new Date(doc.addedAt).toLocaleDateString()}</small></div><button class="delete-file" data-delete-doc="${doc.id}" aria-label="Delete ${escapeHTML(doc.name)}" title="Delete">×</button></div>`).join("");
  }
  function renderCards() {
    $("#stat-cards").textContent = cards.length;
    $("#memory-count").textContent = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
    if (!cards.length) {
      $("#recall-area").innerHTML = `<div class="empty-state"><span>✳</span><strong>Your memory bank is empty</strong><p>Create a card to begin practising active recall.</p></div>`;
      return;
    }
    currentCardIndex = ((currentCardIndex % cards.length) + cards.length) % cards.length;
    const card = cards[currentCardIndex];
    $("#recall-area").innerHTML = `<article class="flashcard"><div><div class="card-label">${showingAnswer ? "RECALL · ANSWER" : "RECALL · QUESTION"} · ${currentCardIndex+1} OF ${cards.length}</div>${showingAnswer ? `<p>${escapeHTML(card.back).replace(/\n/g,"<br>")}</p>` : `<h3>${escapeHTML(card.front)}</h3>`}</div><div class="flashcard-actions"><button class="primary-button" id="flip-card">${showingAnswer ? "Show question" : "Reveal answer"}</button><button class="secondary-button" id="next-card">Next card →</button></div></article>`;
    $("#flip-card").addEventListener("click", () => { showingAnswer = !showingAnswer; renderCards(); });
    $("#next-card").addEventListener("click", () => { currentCardIndex++; showingAnswer = false; renderCards(); });
  }
  function updateStats() {
    $("#stat-sessions").textContent = Number(localStorage.getItem("lexmaster-sessions") || 0);
  }
  function showPage(name) {
    const valid = ["dashboard","subjects","library","memory","exams","ai"].includes(name) ? name : "dashboard";
    $$(".page").forEach(page => page.classList.toggle("active-page", page.id === `${valid}-page`));
    $$(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.page === valid));
    $("#page-breadcrumb").textContent = valid === "dashboard" ? "Dashboard" : valid === "ai" ? "Legal AI" : valid[0].toUpperCase()+valid.slice(1);
    $("#sidebar").classList.remove("open");
    if (location.hash !== `#${valid}`) history.replaceState(null,"",`#${valid}`);
    window.scrollTo({top:0,behavior:"smooth"});
  }
  function openModal(title, body, onConfirm, confirmText="Save") {
    $("#modal-title").textContent = title; $("#modal-body").innerHTML = body;
    $("#modal-confirm").textContent = confirmText; $("#modal-backdrop").hidden = false;
    const close = () => { $("#modal-backdrop").hidden = true; $("#modal-confirm").onclick = null; };
    $("#modal-close").onclick = close; $("#modal-cancel").onclick = close;
    $("#modal-confirm").onclick = async () => { const result = await onConfirm(); if (result !== false) close(); };
  }
  function addSubject() {
    openModal("Add a law subject", `<p>Create a subject space for a course, jurisdiction or area of legal study.</p><input id="new-subject-name" maxlength="48" placeholder="e.g. Equity and Trusts" aria-label="Subject name">`, async () => {
      const name = $("#new-subject-name").value.trim();
      if (!name) { toast("Enter a subject name first."); return false; }
      if (subjects.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast("That subject already exists."); return false; }
      const seed = subjectSeeds[subjects.length % subjectSeeds.length];
      subjects.push({name,area:"Custom subject",symbol:seed.symbol,color:seed.color,bg:seed.bg});
      await put("settings",{key:"subjects",value:subjects});
      renderSubjects(); toast("Subject added.");
    });
  }
  async function handleFiles(fileList) {
    const allowed = [".pdf",".txt",".md"];
    for (const file of [...fileList]) {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!allowed.includes(ext)) { toast(`Unsupported file: ${file.name}`); continue; }
      try {
        await put("documents",{id:uid(),name:file.name,type:file.type || ext,size:file.size,addedAt:Date.now(),blob:file});
      } catch (error) {
        console.error(error); toast("Could not save this file. Check available device storage."); continue;
      }
    }
    documents = await getAll("documents"); renderDocuments(); $("#file-input").value = "";
    toast("Library updated on this device.");
  }
  function updateConnection() {
    const online = navigator.onLine;
    $("#connection-label").textContent = online ? "Ready to study" : "Offline study mode";
    $("#connection-detail").textContent = online ? "Device is connected" : "Your saved tools remain available";
  }
  function formatTime(seconds) { return `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`; }
  function updateTimer() { $("#timer-display").textContent = formatTime(timerRemaining); }
  function stopTimer() { clearInterval(timerInterval); timerInterval = null; timerRunning = false; $("#timer-pause").disabled = true; $("#timer-pause").textContent = "Pause"; }
  function startTimer() {
    if (timerRunning) return;
    timerRunning = true; $("#timer-pause").disabled = false; $("#timer-status").textContent = "Focus on one task. You can do this.";
    timerInterval = setInterval(() => {
      timerRemaining--; updateTimer();
      if (timerRemaining <= 0) {
        stopTimer(); $("#timer-status").textContent = "Session complete. Take a short break.";
        localStorage.setItem("lexmaster-sessions", String(Number(localStorage.getItem("lexmaster-sessions") || 0)+1)); updateStats(); toast("Focus session complete!");
      }
    },1000);
  }
  function resetTimer() { stopTimer(); timerRemaining = Number($("#timer-duration").value)*60; updateTimer(); $("#timer-status").textContent = "Ready when you are."; }

  function updateAuthUI(user) {
    currentUser = user || null;
    const signedIn = Boolean(currentUser);
    $("#ai-auth-gate").hidden = signedIn;
    $("#ai-chat-workspace").hidden = !signedIn;
    $("#auth-signout").hidden = !signedIn;
    $("#ai-user-label").textContent = signedIn ? (currentUser.email || "Authenticated student") : "Not signed in";
    if (signedIn) $("#ai-auth-status").textContent = "Your student account is connected.";
  }

  async function setupFirebase() {
    try {
      const firebaseModule = await import("./firebase-client.mjs");
      firebaseClient = await firebaseModule.initializeFirebase();
      firebaseClient.onAuthStateChanged(updateAuthUI);
    } catch (error) {
      console.warn("Firebase client could not initialise", error);
      $("#ai-auth-status").textContent = "Account sign-in needs an internet connection. Your offline study tools remain available.";
    }
  }

  function renderLegalAnswer(answer) {
    const text = value => escapeHTML(value ?? "").replace(/\\n/g, "<br>");
    const sectionHtml = (answer.sections || []).map(section =>
      `<section class="answer-section"><h3>${text(section.heading)}</h3><p>${text(section.content)}</p></section>`
    ).join("");
    const caseHtml = (answer.cases || []).map(item => {
      const rows = [
        ["Facts", item.facts], ["Issue", item.issue], ["Rule", item.rule],
        ["Application", item.application], ["Conclusion", item.conclusion], ["Ratio decidendi", item.ratio]
      ].filter(([, value]) => value);
      return `<details class="case-analysis"><summary><strong>${text(item.case_name)}</strong><span>${text(item.citation || "Citation not supplied")}</span></summary>
        <div class="case-meta">${text(item.court || "")} ${text(item.year || "")} · Status: ${text(item.status || "not assessed")}</div>
        ${rows.map(([label, value]) => `<div class="irac-row"><b>${label}</b><p>${text(value)}</p></div>`).join("")}
        ${item.source_url ? `<a href="${text(item.source_url)}" target="_blank" rel="noopener noreferrer">Open case source ↗</a>` : ""}
      </details>`;
    }).join("");
    const statutesHtml = (answer.statutes || []).map(item =>
      `<div class="authority-row"><strong>${text(item.title)} ${text(item.provision || "")}</strong><p>${text(item.proposition)}</p>${item.source_url ? `<a href="${text(item.source_url)}" target="_blank" rel="noopener noreferrer">Open legislation source ↗</a>` : ""}</div>`
    ).join("");
    const list = values => (values || []).map(value => `<li>${text(value)}</li>`).join("");
    const questionsHtml = (answer.practice_questions || []).map(item =>
      `<div class="practice-question"><span>${text(item.question_type)}</span><p>${text(item.question)}</p>${item.examiner_focus?.length ? `<small>Examiner focus: ${text(item.examiner_focus.join(" · "))}</small>` : ""}</div>`
    ).join("");
    const sourcesHtml = (answer.research_sources || []).map(source =>
      `<li><a href="${text(source.url)}" target="_blank" rel="noopener noreferrer">${text(source.title || source.url)} ↗</a></li>`
    ).join("");
    $("#ai-response-title").textContent = answer.title || "Legal research answer";
    $("#ai-response-jurisdiction").textContent = answer.jurisdiction || "";
    $("#ai-response").innerHTML = `
      <div class="answer-direct"><span class="section-overline">DIRECT ANSWER</span><p>${text(answer.direct_answer)}</p></div>
      ${sectionHtml}
      ${caseHtml ? `<section class="answer-section"><h3>Judicial authorities · IRAC</h3>${caseHtml}</section>` : ""}
      ${statutesHtml ? `<section class="answer-section"><h3>Statutory authorities</h3>${statutesHtml}</section>` : ""}
      ${answer.big_ideas?.length ? `<section class="answer-section"><h3>Big ideas to understand</h3><ul>${list(answer.big_ideas)}</ul></section>` : ""}
      ${answer.exam_tips?.length ? `<section class="answer-section"><h3>Examination guidance</h3><ul>${list(answer.exam_tips)}</ul></section>` : ""}
      ${answer.mnemonics?.length ? `<section class="answer-section"><h3>Memory aids</h3><ul>${list(answer.mnemonics)}</ul></section>` : ""}
      ${questionsHtml ? `<section class="answer-section"><h3>Practice questions</h3>${questionsHtml}</section>` : ""}
      ${sourcesHtml ? `<section class="answer-section"><h3>Online research sources</h3><ul class="source-list">${sourcesHtml}</ul></section>` : ""}
      ${answer.limitations?.length ? `<section class="answer-limitations"><strong>Research limitations</strong><ul>${list(answer.limitations)}</ul></section>` : ""}
    `;
    $("#ai-response-wrap").hidden = false;
    $("#ai-api-notice").hidden = true;
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!firebaseClient) return toast("Firebase sign-in is not available yet. Check your internet connection.");
    const email = $("#ai-email").value.trim();
    const password = $("#ai-password").value;
    const action = event.submitter?.dataset.authAction || "signin";
    try {
      if (action === "signup") await firebaseClient.signUp(email, password);
      else await firebaseClient.signIn(email, password);
      $("#ai-auth-form").reset();
      toast(action === "signup" ? "Student account created." : "Signed in successfully.");
    } catch (error) {
      const messages = {
        "auth/email-already-in-use": "An account already exists for this email. Sign in instead.",
        "auth/invalid-credential": "Email or password is incorrect.",
        "auth/weak-password": "Choose a stronger password.",
        "auth/invalid-email": "Enter a valid email address.",
        "auth/network-request-failed": "Network connection failed. Try again when online."
      };
      $("#ai-auth-status").textContent = messages[error.code] || error.message || "Sign-in failed.";
    }
  }

  async function handleAIQuestion(event) {
    event.preventDefault();
    const apiBase = String(window.FIRE_COUNSEL_CONFIG?.apiBaseUrl || "").trim().replace(/\\/+$/, "");
    if (!apiBase) {
      $("#ai-api-notice").hidden = false;
      return toast("The AI backend URL has not been configured yet.");
    }
    if (!firebaseClient || !currentUser) return toast("Sign in to continue.");
    const question = $("#ai-question").value.trim();
    if (question.length < 3) return toast("Enter a legal question.");
    const button = $("#ai-ask-button");
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = "Researching authorities…";
    $("#ai-response-wrap").hidden = true;
    try {
      const token = await firebaseClient.getIdToken();
      const response = await fetch(`${apiBase}/api/ask`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": `Bearer ${token}`},
        body: JSON.stringify({
          question,
          jurisdiction: $("#ai-jurisdiction").value,
          course: $("#ai-course").value || null,
          topic: $("#ai-topic").value.trim() || null
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "The legal research request failed.");
      renderLegalAnswer(data);
      $("#ai-response-wrap").scrollIntoView({behavior:"smooth",block:"start"});
    } catch (error) {
      toast(error.message || "Could not reach FIRE COUNSEL AI.");
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }
  async function init() {
    $("#today-label").textContent = new Intl.DateTimeFormat(undefined,{weekday:"long",month:"short",day:"numeric"}).format(new Date());
    subjects = [...subjectSeeds];
    try {
      db = await openDatabase();
      const savedSubjects = await storeRequest("settings","readonly",s=>s.get("subjects"));
      if (savedSubjects?.value?.length) subjects = savedSubjects.value;
      documents = await getAll("documents"); cards = await getAll("cards");
    } catch (error) {
      console.error(error); toast("Local database unavailable. Some saving features may not work.");
    }
    renderSubjects(); renderDocuments(); renderCards(); updateStats(); updateConnection();
    showPage(location.hash.replace("#","") || "dashboard");
    setupFirebase();
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./sw.js").then(() => console.info("FIRE COUNSEL service worker registered")).catch(err => console.warn("Service worker registration failed",err));
    }
  }
  document.addEventListener("click", async event => {
    const nav = event.target.closest("[data-page]");
    if (nav) { event.preventDefault(); showPage(nav.dataset.page); }
    const go = event.target.closest("[data-go]");
    if (go) showPage(go.dataset.go);
    const subject = event.target.closest("[data-subject]");
    if (subject) toast(`${subject.dataset.subject} workspace will be expanded in a later stage.`);
    const del = event.target.closest("[data-delete-doc]");
    if (del && db) { await remove("documents",del.dataset.deleteDoc); documents = await getAll("documents"); renderDocuments(); toast("Document removed from this device."); }
  });
  $("#menu-toggle").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
  $("#add-subject-button").addEventListener("click",addSubject);
  $("#file-input").addEventListener("change",e=>handleFiles(e.target.files));
  $("#memory-form").addEventListener("submit",async e=>{
    e.preventDefault(); if (!db) return toast("Local storage is unavailable.");
    const card = {id:uid(),front:$("#card-front").value.trim(),back:$("#card-back").value.trim(),subject:$("#card-subject").value,createdAt:Date.now()};
    if (!card.front || !card.back) return;
    await put("cards",card); cards = await getAll("cards"); e.target.reset(); renderCards(); renderSubjects(); toast("Recall card saved.");
  });
  $("#timer-duration").addEventListener("change",resetTimer);
  $("#timer-start").addEventListener("click",()=>{if(timerRemaining<=0)resetTimer();startTimer();});
  $("#timer-pause").addEventListener("click",()=>{if(timerRunning){stopTimer();$("#timer-status").textContent="Paused. Resume when ready.";}else startTimer();});
  $("#timer-reset").addEventListener("click",resetTimer);
  $("#help-button").addEventListener("click",()=>openModal("Welcome to FIRE COUNSEL",`<p>FIRE COUNSEL now includes its offline study workspace and a secure Legal AI backend foundation.</p><p>Sign in to use the legal assistant when the backend URL is configured. Your local documents and recall cards remain stored on this device.</p><p><strong>Research rule:</strong> AI answers should cite legal authorities, not textbook page references.</p>`,async()=>{},"Got it"));
  $("#ai-auth-form").addEventListener("submit",handleAuthSubmit);
  $("#ai-question-form").addEventListener("submit",handleAIQuestion);
  $("#auth-signout").addEventListener("click",async()=>{if(firebaseClient){await firebaseClient.signOut();toast("Signed out.");}});
  window.addEventListener("online",updateConnection); window.addEventListener("offline",updateConnection);
  window.addEventListener("beforeinstallprompt",event=>{event.preventDefault();deferredInstallPrompt=event;$("#install-button").hidden=false;});
  $("#install-button").addEventListener("click",async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$("#install-button").hidden=true;});
  window.addEventListener("hashchange",()=>showPage(location.hash.slice(1)));
  init();
})();
