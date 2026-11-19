(() => {
  "use strict";
  const PREVIEW = new URLSearchParams(location.search).get("preview") === "1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[ch]));
  const photo = value => {
    const path = String(value || "");
    if (/^(\.\/)?assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(path)) return path.startsWith("./") ? path : `./${path}`;
    // Photos uploaded in the admin studio (stored in Neon, served by this site).
    if (/^\/media\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(path)) return path;
    try {
      const url = new URL(path, location.href);
      const decodedPath = decodeURIComponent(url.pathname);
      if (url.protocol === "https:" && url.hostname === "firebasestorage.googleapis.com" && /^\/v0\/b\/fire-counsel\.firebasestorage\.app\/o\/site\/slides\/[^/]+\.(?:png|jpe?g|webp)$/i.test(decodedPath)) return url.href;
    } catch (_) { /* untrusted image URLs fall back to the local brand image */ }
    return "./assets/images/fire-counsel-brand.jpg";
  };
  const href = value => {
    const link = String(value || "#").trim();
    if (/^#[\w-]*$/.test(link) || /^(\.\/|\.\.\/|\/)[^\s"<>]*$/.test(link)) return esc(link);
    try {
      const url = new URL(link, location.href);
      return ["https:", "http:"].includes(url.protocol) ? esc(url.href) : "#";
    } catch { return "#"; }
  };
  const toast = message => {
    const node = $("#site-toast"); if (!node) return;
    node.textContent = message; node.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 2600);
  };
  let siteData = null;
  let activeSlide = 0;
  let carouselTimer = null;

  // Preview: the admin page that opened this tab sends its unsaved draft. Only
  // messages from this same site (the admin studio) are accepted; the draft is
  // rendered with the same escaping as published content and never stored.
  function receivePreview(timeoutMs = 5000) {
    const opener = window.opener;
    if (!opener) return Promise.resolve(null);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); window.removeEventListener("message", onMessage); resolve(value); };
      const onMessage = event => {
        if (event.origin !== location.origin || event.source !== opener) return;
        const data = event.data;
        if (data?.type === "fire-counsel-preview" && data.content && typeof data.content === "object") done(data.content);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      window.addEventListener("message", onMessage);
      try { opener.postMessage({type:"fire-counsel-preview-ready"}, location.origin); } catch { done(null); }
    });
  }
  function showPreviewBanner(text) {
    let bar = $("#preview-banner");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "preview-banner";
      bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:10px 14px;background:#c55a11;color:#fff;font:600 14px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 -4px 16px rgba(0,0,0,.25)";
      document.body.append(bar);
    }
    bar.textContent = text;
  }
  async function loadContent() {
    if (PREVIEW) {
      const draft = await receivePreview();
      if (draft) { showPreviewBanner("PREVIEW — only you can see this. Go back to the admin tab and press Publish to make it live."); return draft; }
      showPreviewBanner("Preview not received — this shows the live site. Open the preview from the admin page (Pages & JSON → Preview).");
    }
    // The admin studio publishes siteContent/public straight to Firestore, so
    // live slide/content edits come from there first. The bundled JSON remains
    // the fallback for first deploy, offline, or an unconfigured Firebase
    // project. The Firestore attempt is time-boxed so a slow network can
    // never hold the homepage hostage.
    try {
      const { loadPublicSiteContent } = await import("./firebase/firestore-client.mjs");
      const live = await loadPublicSiteContent(); // client time-boxes the read
      if (live) return live;
    } catch { /* Firebase not configured or unreachable — bundled content below */ }
    const response = await fetch("./data/site-content.json", {cache:"no-cache"});
    if (!response.ok) throw new Error(`Content request failed: ${response.status}`);
    return response.json();
  }
  function renderNavigation(data) {
    const nav = $("#main-nav-links");
    nav.innerHTML = (data.navigation || []).map((item, index) => `<a class="${index === 0 ? "active" : ""}" href="${href(item.href)}">${esc(item.label)}</a>`).join("");
    const logo = $("#brand-image");
    if (logo) { logo.src = photo(data.brand?.markImage); logo.alt = esc(data.brand?.markAlt || ""); }
    $("#brand-name").textContent = data.brand?.name || "FIRE COUNSEL";
    $("#brand-tagline").textContent = data.brand?.tagline || "Ignite your legal intelligence";
  }
  function renderHero(data) {
    const holder = $("#hero-slides");
    const slides = Array.isArray(data.hero?.slides) ? data.hero.slides : [];
    if (!slides.length) return;
    holder.innerHTML = slides.map((slide, index) => `<article class="hero-slide ${index === 0 ? "is-active" : ""}" data-slide="${index}" role="group" aria-label="Slide ${index + 1} of ${slides.length}" aria-hidden="${index !== 0}">
      <div class="hero-copy"><span class="eyebrow">${esc(slide.eyebrow)}</span><h1>${esc(slide.title)}<br><em>${esc(slide.accent)}</em></h1><p>${esc(slide.body)}</p><div class="hero-actions"><a class="button button-light" href="${href(slide.primaryHref)}">${esc(slide.primaryLabel)} <span>↗</span></a><a class="button button-ghost" href="${href(slide.secondaryHref)}">${esc(slide.secondaryLabel)}</a></div></div>
      <figure class="hero-photo-wrap"><img class="hero-photo" src="${photo(slide.image)}" alt="${esc(slide.imageAlt)}" width="1100" height="1400" ${index ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async"><figcaption>${esc(slide.imageCredit)}</figcaption></figure>
    </article>`).join("");
    const dots = $("#hero-dots");
    dots.innerHTML = slides.map((_, index) => `<button class="hero-dot ${index === 0 ? "is-active" : ""}" type="button" aria-label="Show slide ${index + 1}" aria-current="${index === 0 ? "true" : "false"}" data-slide-to="${index}"></button>`).join("");
    showSlide(0);
    const interval = Number(data.hero?.autoplayMs);
    initCarousel(Number.isFinite(interval) ? Math.max(4000, Math.min(interval, 15000)) : 6500);
  }
  function showSlide(index) {
    const slides = $$(".hero-slide", $("#hero-slides"));
    if (!slides.length) return;
    activeSlide = (index + slides.length) % slides.length;
    slides.forEach((slide, i) => {
      slide.classList.toggle("is-active", i === activeSlide);
      slide.setAttribute("aria-hidden", String(i !== activeSlide));
    });
    $$(".hero-dot").forEach((dot, i) => {
      const on = i === activeSlide; dot.classList.toggle("is-active", on); dot.setAttribute("aria-current", String(on));
    });
    const count = $("#hero-count");
    if (count) count.textContent = `${String(activeSlide + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
  }
  function initCarousel(interval) {
    const frame = $(".hero-frame");
    if (!frame) return;
    $("#slide-prev").addEventListener("click", () => showSlide(activeSlide - 1));
    $("#slide-next").addEventListener("click", () => showSlide(activeSlide + 1));
    $("#hero-dots").addEventListener("click", event => {
      const dot = event.target.closest("[data-slide-to]"); if (dot) showSlide(Number(dot.dataset.slideTo));
    });
    const stop = () => clearInterval(carouselTimer);
    const start = () => {
      stop();
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || document.hidden) return;
      carouselTimer = setInterval(() => showSlide(activeSlide + 1), interval);
    };
    frame.addEventListener("mouseenter", stop); frame.addEventListener("mouseleave", start);
    frame.addEventListener("focusin", stop); frame.addEventListener("focusout", start);
    document.addEventListener("visibilitychange", () => document.hidden ? stop() : start());
    start();
  }
  function renderQuickFacts(data) {
    $("#quickfacts-grid").innerHTML = (data.quickFacts || []).map(item => `<article><span>${esc(item.number)}</span><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></article>`).join("");
  }
  function renderLearning(data) {
    const learning = data.learning || {};
    $("#learning-intro").textContent = learning.intro || "";
    const heading = $("#learning");
    $(".section-heading .eyebrow", heading).textContent = learning.eyebrow || "LEARNING";
    $(".section-heading h2", heading).innerHTML = `${esc(learning.title || "Study tools")}<br><em>${esc(learning.accent || "")}</em>`;
    $("#learning-cards").innerHTML = (learning.cards || []).map(item => `<a class="feature-card tone-${esc(item.tone)}" href="${href(item.href)}"><div class="feature-top"><span class="feature-icon">${esc(item.icon)}</span><span class="feature-number">${esc(item.number)}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p><span class="feature-arrow" aria-hidden="true">↗</span></a>`).join("");
  }
  function renderCaseNotes(data) {
    const item = data.caseNotes || {};
    $("#case-eyebrow").textContent = item.eyebrow || "CASE NOTES";
    $("#case-title").innerHTML = `${esc(item.title || "Case notes")}<br><em>${esc(item.accent || "")}</em>`;
    $("#case-intro").textContent = item.intro || "";
    $("#case-status").textContent = item.status || "CURATION PENDING";
    $("#case-points").innerHTML = (item.points || []).map(point => `<li>${esc(point)}</li>`).join("");
    const image = $("#case-image"); image.src = photo(item.image); image.alt = esc(item.imageAlt || "Legal study");
    const cta = $("#case-cta"); cta.href = href(item.ctaHref); cta.innerHTML = `${esc(item.ctaLabel || "Explore case notes")} <span>↗</span>`;
  }
  function renderArticles(data) {
    const articles = data.articles || {};
    $("#articles-intro").textContent = articles.intro || "";
    const section = $("#articles");
    $(".section-heading .eyebrow", section).textContent = articles.eyebrow || "ARTICLES";
    $(".section-heading h2", section).innerHTML = `${esc(articles.title || "Articles")}<br><em>${esc(articles.accent || "")}</em>`;
    $("#article-grid").innerHTML = (articles.items || []).map((item, index) => `<article class="article-card"><div class="article-meta"><span class="article-category">${esc(item.category)}</span><span>${esc(item.readTime)}</span></div><h3>${esc(item.title)}</h3><p>${esc(item.excerpt)}</p><button class="article-read" type="button" data-article-index="${index}">Read note <span>→</span></button></article>`).join("");
  }
  function renderResources(data) {
    const resources = data.resources || {};
    $("#resources-title").innerHTML = `${esc(resources.title || "Legal websites")}<br><em>${esc(resources.accent || "")}</em>`;
    $("#resources-intro").textContent = resources.intro || "";
    const list = $("#resource-list");
    if (!resources.items?.length) {
      list.innerHTML = `<div class="resource-empty"><span class="resource-symbol">§</span><strong>Approved links are being prepared</strong><p>No school-domain allowlist has been connected. The live web fallback is off.</p></div>`;
      return;
    }
    list.innerHTML = resources.items.map(item => `<article class="resource-card"><span class="resource-symbol">↗</span><div><a href="${href(item.href)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a><p>${esc(item.description)}${item.domain ? ` · ${esc(item.domain)}` : ""}</p></div></article>`).join("");
  }
  function renderFooter(data) {
    const footer = data.footer || {};
    const brand = data.brand || {};
    const inner = $("#footer-main");
    inner.innerHTML = `<div class="footer-brand"><a class="site-brand footer-mark fc-brand-lockup" href="#home"><span class="brand-image-wrap fc-brand-emblem"><img src="${photo(brand.markImage)}" alt="" width="96" height="64" loading="lazy"></span><span class="brand-copy fc-brand-copy"><strong>${esc(brand.name || "FIRE COUNSEL")}</strong><small>${esc(brand.tagline || "")}</small></span></a><p>${esc(footer.summary || "")}</p></div>${(footer.columns || []).map(column => `<div class="footer-column"><h3>${esc(column.title)}</h3>${(column.items || []).map(link => `<a href="${href(link.href)}">${esc(link.label)}</a>`).join("")}</div>`).join("")}`;
    $("#footer-disclaimer").textContent = footer.disclaimer || "";
    $("#copyright-text").textContent = footer.copyright || "";
  }
  function initArticleDialog(data) {
    const dialog = $("#article-dialog");
    $("#article-grid").addEventListener("click", event => {
      const button = event.target.closest("[data-article-index]"); if (!button) return;
      const article = data.articles?.items?.[Number(button.dataset.articleIndex)]; if (!article) return;
      $("#dialog-category").textContent = article.category || "STUDY NOTE";
      $("#dialog-title").textContent = article.title || "Study note";
      $("#dialog-body").textContent = article.body || article.excerpt || "";
      if (dialog?.showModal) dialog.showModal(); else toast(article.excerpt || "");
    });
    $("#dialog-done").addEventListener("click", () => dialog.close());
  }
  function initNavigation() {
    const button = $("#nav-toggle"), nav = $("#primary-nav");
    // Keep anchor targets clear of the centered masthead, including when a
    // published name/tagline wraps or a mobile viewport changes its height.
    const header = $(".site-header");
    const measureHeader = () => document.documentElement.style.setProperty("--site-header-height", `${Math.ceil(header.getBoundingClientRect().height)}px`);
    measureHeader();
    if ("ResizeObserver" in window) new ResizeObserver(measureHeader).observe(header);
    const close = () => { nav.classList.remove("is-open"); button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-label", "Open navigation"); };
    button.addEventListener("click", () => {
      const open = !nav.classList.contains("is-open"); nav.classList.toggle("is-open", open);
      button.setAttribute("aria-expanded", String(open)); button.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    });
    nav.addEventListener("click", event => { if (event.target.closest("a")) close(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") { close(); $("#article-dialog")?.close?.(); } });
  }
  function initReveal() {
    const nodes = $$(".reveal");
    if (!("IntersectionObserver" in window) || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { nodes.forEach(node => node.classList.add("is-visible")); return; }
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); }
    }), {threshold:.12, rootMargin:"0px 0px -30px 0px"});
    nodes.forEach(node => observer.observe(node));
  }
  async function init() {
    try {
      siteData = await loadContent();
      renderNavigation(siteData); renderHero(siteData); renderQuickFacts(siteData);
      renderLearning(siteData); renderCaseNotes(siteData); renderArticles(siteData); renderResources(siteData); renderFooter(siteData);
      initArticleDialog(siteData);
    } catch (error) {
      console.error("FIRE COUNSEL website content could not be loaded.", error);
      toast("Some page content could not be loaded. Please try refreshing.");
    }
    initNavigation(); initReveal();
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Service worker registration failed", error));
  }
  init();
})();
