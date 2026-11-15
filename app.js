(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  // These names and version are intentionally unchanged: existing student data must remain reachable.
  const DB_NAME = "lexmaster-ai-stage1";
  const DB_VERSION = 1;
  const SESSION_KEY = "lexmaster-sessions";
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
  let activeCourse = "";
  let currentCardIndex = 0;
  let showingAnswer = false;
  let deferredInstallPrompt = null;
  let timerInterval = null;
  let timerRemaining = 25 * 60;
  let timerRunning = false;
  let toastTimer = null;
  let slideIndex = 0;
  let slideTimer = null;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB is unavailable in this browser."));
      // Do not bump DB_VERSION, delete stores, or clear records during the visual rebuild.
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("documents")) database.createObjectStore("documents", {keyPath:"id"});
        if (!database.objectStoreNames.contains("cards")) database.createObjectStore("cards", {keyPath:"id"});
        if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", {keyPath:"key"});
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
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
      tx.onabort = () => reject(tx.error || new Error("The local save was interrupted."));
    });
  }
  const getAll = name => storeRequest(name, "readonly", store => store.getAll());
  const put = (name, value) => storeRequest(name, "readwrite", store => store.put(value));
  const remove = (name, key) => storeRequest(name, "readwrite", store => store.delete(key));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
  const formatSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;

  function toast(message) {
    const element = $("#toast");
    if (!element) return;
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2800);
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#scrim").classList.remove("show");
  }
  function showPage(name, updateHash = true) {
    const studentPages = ["dashboard", "ai-chat", "subjects", "library", "memory", "exams"];
    const valid = studentPages.includes(name) ? name : "dashboard";
    $$(".page").forEach(page => page.classList.toggle("active-page", page.id === `${valid}-page`));
    const studentNav = $("#student-nav");
    if (studentNav) studentNav.hidden = false;
    $$("#student-nav .nav-link").forEach(link => link.classList.toggle("active", link.dataset.page === valid));
    $("#workspace-label").textContent = "Student workspace";
    $("#breadcrumb-workspace").textContent = "Student";
    $("#page-breadcrumb").textContent = ({dashboard:"Overview","ai-chat":"Fire Counsel AI",subjects:"My courses",library:"Study library",memory:"Case flashcards",exams:"Past questions"})[valid];
    $("#mode-label").textContent = "LOCAL STUDY";
    $("#profile-role").textContent = "Local-first workspace";
    closeSidebar();
    if (updateHash && location.hash !== `#${valid}`) history.replaceState(null, "", `#${valid}`);
    window.scrollTo({top:0, behavior:"smooth"});
  }
  function subjectCard(subject, index) {
    const seed = subjectSeeds[index % subjectSeeds.length];
    const color = /^#[\da-f]{3,8}$/i.test(subject.color || "") ? subject.color : seed.color;
    const bg = /^#[\da-f]{3,8}$/i.test(subject.bg || "") ? subject.bg : seed.bg;
    return `<button class="subject-card" type="button" data-subject="${escapeHTML(subject.name)}" style="--card-accent:${color};--card-bg:${bg};--card-glow:${color}22"><span class="subject-symbol">${escapeHTML(subject.symbol || "§")}</span><strong>${escapeHTML(subject.name)}</strong><small>${escapeHTML(subject.area || "Law subject")}</small></button>`;
  }
  function renderSubjects() {
    const dashboard = $("#dashboard-subjects");
    const allSubjects = $("#all-subjects");
    if (dashboard) dashboard.innerHTML = subjects.slice(0, 6).map(subjectCard).join("");
    if (allSubjects) allSubjects.innerHTML = subjects.map(subjectCard).join("");
    const statSubjects = $("#stat-subjects");
    if (statSubjects) statSubjects.textContent = subjects.length;
    const courseCount = $("#course-nav-count");
    if (courseCount) courseCount.textContent = subjects.length;
    const cardSubject = $("#card-subject");
    if (cardSubject) cardSubject.innerHTML = subjects.map(subject => `<option value="${escapeHTML(subject.name)}">${escapeHTML(subject.name)}</option>`).join("");
    const options = subjects.map(subject => `<option value="${escapeHTML(subject.name)}">${escapeHTML(subject.name)}</option>`).join("");
    const courseSelect = $("#active-course-select");
    if (courseSelect) {
      courseSelect.innerHTML = options;
      if (!subjects.some(subject => subject.name === activeCourse)) activeCourse = subjects[0]?.name || "";
      courseSelect.value = activeCourse;
    }
    const chatCourseSelect = $("#chat-course-select");
    if (chatCourseSelect) { chatCourseSelect.innerHTML = options; chatCourseSelect.value = activeCourse; }
  }
  function renderDocuments() {
    $("#stat-materials").textContent = documents.length;
    $("#library-count").textContent = `${documents.length} ${documents.length === 1 ? "file" : "files"}`;
    const list = $("#document-list");
    if (!documents.length) {
      list.innerHTML = `<div class="empty-state"><span>▤</span><strong>Your library is ready</strong><p>Add a PDF, text file or Markdown note to keep a local copy for your own study.</p></div>`;
      return;
    }
    list.innerHTML = documents.sort((a,b) => b.addedAt-a.addedAt).map(document => `<div class="document-item"><span class="file-icon">▤</span><div class="document-meta"><strong>${escapeHTML(document.name)}</strong><small>${formatSize(document.size)} · Added ${new Date(document.addedAt).toLocaleDateString()} · on this device</small></div><button class="delete-file" type="button" data-delete-doc="${escapeHTML(document.id)}" aria-label="Delete ${escapeHTML(document.name)}" title="Delete">×</button></div>`).join("");
  }
  function renderCards() {
    $("#stat-cards").textContent = cards.length;
    $("#memory-count").textContent = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
    if (!cards.length) {
      $("#recall-area").innerHTML = `<div class="empty-state"><span>✧</span><strong>Your memory bank is empty</strong><p>Create a card to begin practising active recall.</p></div>`;
      return;
    }
    currentCardIndex = ((currentCardIndex % cards.length) + cards.length) % cards.length;
    const card = cards[currentCardIndex];
    $("#recall-area").innerHTML = `<article class="flashcard"><div><div class="card-label">${showingAnswer ? "RECALL · ANSWER" : "RECALL · QUESTION"} · ${currentCardIndex+1} OF ${cards.length}</div>${showingAnswer ? `<p>${escapeHTML(card.back).replace(/\n/g,"<br>")}</p>` : `<h3>${escapeHTML(card.front)}</h3>`}</div><div class="flashcard-actions"><button class="button primary" type="button" id="flip-card">${showingAnswer ? "Show question" : "Reveal answer"}</button><button class="button soft" type="button" id="next-card">Next card →</button></div></article>`;
    $("#flip-card").addEventListener("click", () => { showingAnswer = !showingAnswer; renderCards(); });
    $("#next-card").addEventListener("click", () => { currentCardIndex++; showingAnswer = false; renderCards(); });
  }
  function updateStats() {
    try { $("#stat-sessions").textContent = Number(localStorage.getItem(SESSION_KEY) || 0); }
    catch (error) { $("#stat-sessions").textContent = "0"; }
  }
  function renderConnection() {
    const online = navigator.onLine;
    $("#connection-label").textContent = online ? "Ready to study" : "Offline study mode";
    $("#connection-detail").textContent = online ? "This device is connected" : "Your saved tools remain available";
    $("#connection-dot").style.background = online ? "#43b48f" : "#d8a34a";
  }
  function formatTime(seconds) { return `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`; }
  function updateTimer() { $("#timer-display").textContent = formatTime(timerRemaining); }
  function stopTimer() {
    clearInterval(timerInterval); timerInterval = null; timerRunning = false;
    $("#timer-pause").disabled = true; $("#timer-pause").textContent = "Pause";
  }
  function startTimer() {
    if (timerRunning) return;
    timerRunning = true; $("#timer-pause").disabled = false; $("#timer-pause").textContent = "Pause";
    $("#timer-status").textContent = "Focus on one task. You can do this.";
    timerInterval = setInterval(() => {
      timerRemaining--; updateTimer();
      if (timerRemaining <= 0) {
        stopTimer(); $("#timer-status").textContent = "Session complete. Take a short break.";
        try { localStorage.setItem(SESSION_KEY, String(Number(localStorage.getItem(SESSION_KEY) || 0) + 1)); }
        catch (error) { console.warn("Could not update local session count", error); }
        updateStats(); toast("Focus session complete!");
      }
    }, 1000);
  }
  function resetTimer() {
    stopTimer(); timerRemaining = Number($("#timer-duration").value) * 60; updateTimer();
    $("#timer-status").textContent = "Ready when you are.";
  }
  function openModal(title, body, onConfirm, confirmText = "Save") {
    $("#modal-title").textContent = title; $("#modal-body").innerHTML = body;
    $("#modal-confirm").textContent = confirmText; $("#modal-backdrop").hidden = false;
    const close = () => { $("#modal-backdrop").hidden = true; $("#modal-confirm").onclick = null; };
    $("#modal-close").onclick = close; $("#modal-cancel").onclick = close;
    $("#modal-confirm").onclick = async () => {
      try { const result = await onConfirm(); if (result !== false) close(); }
      catch (error) { console.error(error); toast("Could not save that item on this device."); }
    };
  }
  function addSubject() {
    openModal("Add a personal study area", `<p>This subject is saved in the existing local study database on this device. It is not an administrator-managed course.</p><input id="new-subject-name" maxlength="48" placeholder="e.g. Equity and Trusts" aria-label="Subject name">`, async () => {
      const name = $("#new-subject-name").value.trim();
      if (!name) { toast("Enter a subject name first."); return false; }
      if (subjects.some(subject => subject.name.toLowerCase() === name.toLowerCase())) { toast("That subject already exists."); return false; }
      const seed = subjectSeeds[subjects.length % subjectSeeds.length];
      subjects.push({name, area:"Personal study area", symbol:seed.symbol, color:seed.color, bg:seed.bg});
      if (db) await put("settings", {key:"subjects", value:subjects});
      renderSubjects(); toast("Personal study area saved on this device.");
    });
  }
  async function handleFiles(fileList) {
    const allowed = [".pdf", ".txt", ".md"];
    for (const file of [...fileList]) {
      const dot = file.name.lastIndexOf(".");
      const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
      if (!allowed.includes(extension)) { toast(`Unsupported file: ${file.name}`); continue; }
      try {
        await put("documents", {id:uid(), name:file.name, type:file.type || extension, size:file.size, addedAt:Date.now(), blob:file});
      } catch (error) {
        console.error(error); toast("Could not save this file. Check available device storage.");
      }
    }
    documents = await getAll("documents"); renderDocuments(); $("#file-input").value = "";
    toast("Library updated on this device. Nothing was uploaded.");
  }
  function showSlide(index) {
    const slides = $$(".hero-slide");
    const dots = $$(".carousel-dot");
    if (!slides.length) return;
    slideIndex = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => slide.classList.toggle("active", i === slideIndex));
    dots.forEach((dot, i) => dot.classList.toggle("active", i === slideIndex));
  }
  function startCarousel() {
    clearInterval(slideTimer);
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    slideTimer = setInterval(() => showSlide(slideIndex + 1), 7000);
  }
  function setupCarousel() {
    const carousel = $(".hero");
    if (!carousel) return;
    $("#prev-slide").addEventListener("click", () => showSlide(slideIndex - 1));
    $("#next-slide").addEventListener("click", () => showSlide(slideIndex + 1));
    $$(".carousel-dot").forEach((dot, index) => dot.addEventListener("click", () => showSlide(index)));
    carousel.addEventListener("mouseenter", () => clearInterval(slideTimer));
    carousel.addEventListener("mouseleave", startCarousel);
    carousel.addEventListener("focusin", () => clearInterval(slideTimer));
    carousel.addEventListener("focusout", startCarousel);
    startCarousel();
  }
  async function init() {
    $("#today-label").textContent = new Intl.DateTimeFormat(undefined, {weekday:"long", month:"short", day:"numeric"}).format(new Date());
    subjects = [...subjectSeeds];
    try {
      db = await openDatabase();
      const savedSubjects = await storeRequest("settings", "readonly", store => store.get("subjects"));
      const savedCourse = await storeRequest("settings", "readonly", store => store.get("active-course"));
      if (savedSubjects?.value?.length) subjects = savedSubjects.value;
      if (savedCourse?.value) activeCourse = savedCourse.value;
      documents = await getAll("documents"); cards = await getAll("cards");
    } catch (error) {
      console.error(error); toast("Local database unavailable. Some saving features may not work.");
    }
    renderSubjects(); renderDocuments(); renderCards(); updateStats(); renderConnection();
    setupCarousel();
    const initialPage = location.hash.replace("#", "");
    showPage(initialPage, false);
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("./sw.js").then(() => console.info("FIRE COUNSEL service worker registered")).catch(error => console.warn("Service worker registration failed", error));
    }
  }

  document.addEventListener("click", async event => {
    const pageLink = event.target.closest("[data-page]");
    if (pageLink) { event.preventDefault(); showPage(pageLink.dataset.page); return; }
    const go = event.target.closest("[data-go]");
    if (go) { showPage(go.dataset.go); return; }
    const previewAction = event.target.closest("[data-preview-action]");
    if (previewAction) { toast(previewAction.dataset.previewAction); return; }
    const toastButton = event.target.closest("[data-toast]");
    if (toastButton) { toast(toastButton.dataset.toast); return; }
    const subject = event.target.closest("[data-subject]");
    if (subject) { toast(`${subject.dataset.subject} selected. Choose it from the course menu to study.`); return; }
    const deleteButton = event.target.closest("[data-delete-doc]");
    if (deleteButton && db) {
      await remove("documents", deleteButton.dataset.deleteDoc);
      documents = await getAll("documents"); renderDocuments(); toast("Document removed from this device.");
    }
  });
  $("#theme-toggle").addEventListener("click", () => {
    const dark = document.body.dataset.theme !== "dark";
    document.body.dataset.theme = dark ? "dark" : "light";
    toast(dark ? "Dark theme preview enabled." : "Light purple theme restored.");
  });
  $("#menu-toggle").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").classList.add("show"); });
  $("#scrim").addEventListener("click", closeSidebar);
  $("#add-subject-button").addEventListener("click", addSubject);
  $("#file-input").addEventListener("change", event => handleFiles(event.target.files));
  $("#memory-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (!db) return toast("Local study database is unavailable.");
    const card = {id:uid(), front:$("#card-front").value.trim(), back:$("#card-back").value.trim(), subject:$("#card-subject").value, createdAt:Date.now()};
    if (!card.front || !card.back) return;
    await put("cards", card); cards = await getAll("cards"); event.target.reset(); renderCards(); toast("Recall card saved on this device.");
  });
  $("#active-course-select").addEventListener("change", async event => {
    activeCourse = event.target.value;
    $("#chat-course-select").value = activeCourse;
    if (db) await put("settings", {key:"active-course", value:activeCourse});
    toast("Course choice saved locally on this device.");
  });
  $("#chat-course-select").addEventListener("change", async event => {
    activeCourse = event.target.value;
    $("#active-course-select").value = activeCourse;
    if (db) await put("settings", {key:"active-course", value:activeCourse});
    toast("AI study course saved locally on this device.");
  });
  $("#timer-duration").addEventListener("change", resetTimer);
  $("#timer-start").addEventListener("click", () => { if (timerRemaining <= 0) resetTimer(); startTimer(); });
  $("#timer-pause").addEventListener("click", () => {
    if (timerRunning) { stopTimer(); $("#timer-status").textContent = "Paused. Resume when you are ready."; }
    else startTimer();
  });
  $("#timer-reset").addEventListener("click", resetTimer);
  $("#help-button").addEventListener("click", () => openModal("FIRE COUNSEL · Privacy & setup", `<p><strong>Student data:</strong> personal documents, recall cards, subjects, course choice and focus-session count are stored in this browser only.</p><p><strong>AI:</strong> chat, OCR, marking, quota enforcement and payments are not connected. This preview sends no student work to an AI provider.</p><p><strong>Website administration:</strong> open <code>admin.html</code> for the separate content-management preview. Sign-in, cloud publishing and media uploads are not connected.</p>`, async () => {}, "Got it"));
  $("#global-search").addEventListener("input", event => {
    const query = event.target.value.toLowerCase().trim();
    const page = $(".page.active-page");
    if (!page) return;
    $$(".subject-card, .quick-card, .document-item, .today-item", page).forEach(item => {
      item.hidden = Boolean(query) && !item.textContent.toLowerCase().includes(query);
    });
  });
  window.addEventListener("online", renderConnection);
  window.addEventListener("offline", renderConnection);
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredInstallPrompt = event; $("#install-button").hidden = false; });
  $("#install-button").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $("#install-button").hidden = true;
  });
  window.addEventListener("hashchange", () => {
    const requested = location.hash.slice(1);
    showPage(requested, false);
  });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape") { $("#modal-backdrop").hidden = true; closeSidebar(); }
  });
  init();
})();
