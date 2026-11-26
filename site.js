(() => {
  "use strict";
  const PREVIEW = new URLSearchParams(location.search).get("preview") === "1";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[ch]));
  const photo = value => {
    const path = String(value || "");
    // Older published JSON may still name the retired logo. Migrate only that
    // bundled path while preserving administrator-selected photos/custom logos.
    if (/^(?:\.\/|\/)?assets\/images\/fire-counsel-brand\.jpg(?:[?#].*)?$/i.test(path)) return "./assets/images/fire-counsel-flame.png";
    if (/^(\.\/)?assets\/[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp)$/i.test(path)) return path.startsWith("./") ? path : `./${path}`;
    // Photos uploaded in the admin studio (stored in Neon, served by this site).
    if (/^\/media\/[0-9a-f-]{36}\.(?:png|jpg|webp)$/i.test(path)) return path;
    try {
      const url = new URL(path, location.href);
      const decodedPath = decodeURIComponent(url.pathname);
      if (url.protocol === "https:" && url.hostname === "firebasestorage.googleapis.com" && /^\/v0\/b\/fire-counsel\.firebasestorage\.app\/o\/site\/slides\/[^/]+\.(?:png|jpe?g|webp)$/i.test(decodedPath)) return url.href;
    } catch (_) { /* untrusted image URLs fall back to the local brand image */ }
    return "./assets/images/fire-counsel-flame.png";
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
  let copyHelpers = null;

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
    // published content edits come from there first. The bundled JSON remains
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
  function renderHeroCopy(data) {
    const copy = copyHelpers.heroCopy(data);
    const heading = $("#home h1");
    if (heading.textContent !== copy.title) {
      let word = 0;
      heading.innerHTML = copy.title.split(/(\s+)/).map(token => /\S/.test(token)
        ? `<span class="hero-word" style="--word:${word++}">${esc(token)}</span>` : esc(token)).join("");
    }
    const tagline = $("#home .hero-tagline"), introduction = $("#home .hero-introduction");
    tagline.textContent = copy.tagline; tagline.hidden = !copy.tagline;
    introduction.textContent = copy.introduction; introduction.hidden = !copy.introduction;
    // Sign up remains the Google-only account entry; content edits never
    // create extra hero buttons, slides or photos, or change that destination.
  }
  function learningArtwork(index, item) {
    // Labelled illustrations only, never student files or performance claims.
    const preview = copyHelpers.learningPreview(item, index), labels = preview.labels.map(esc);
    const check = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#2ee6a6"/><path d="m5.5 10.2 3 3 6-6.2" stroke="#06231a" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    let art;
    switch (index % 4) {
      case 1:
        art = '<div class="learning-files">' + labels.map(label => `<div class="learning-file"><i>▤</i><span>${label}</span></div>`).join("") + '</div>';
        break;
      case 2:
        art = `<div class="learning-recall"><small>${labels[0]}</small><span>${labels[1]}</span><i></i><span>${labels[2]}</span></div>`;
        break;
      case 3:
        art = '<div class="learning-focus"><div class="learning-focus-ring">↗</div><div class="learning-focus-steps">' + labels.map(label => `<span>${label}</span>`).join("") + '</div></div>';
        break;
      default: {
        const bars = [28, 40, 34, 46, 30, 36, 100, 52, 44, 60, 40, 34, 50, 38];
        art = '<div class="learning-mini-table">' + [0, 2, 4, 6, 8].map(i => `<div class="learning-table-row"><span>${labels[i]}</span><span>${labels[i + 1]}</span></div>`).join("") + '</div>'
          + '<div class="learning-mini-bars">' + bars.map((height, i) => `<i class="${i === 6 ? "is-highlight" : ""}" style="--bar:${height}%;--bar-index:${i}"></i>`).join("") + '</div>';
      }
    }
    return `<div class="learning-art" aria-hidden="true">${art}<div class="learning-badge">${check}${esc(preview.badge)}</div></div>`;
  }
  function renderLearning(data) {
    const learning = data.learning || {};
    $("#learning-intro").textContent = learning.intro || "";
    const section = $("#learning");
    $(".section-heading .eyebrow", section).textContent = learning.eyebrow || "LEARNING";
    $(".section-heading h2", section).innerHTML = `${esc(learning.title || "Study tools")}<br><em>${esc(learning.accent || "")}</em>`;
    const holder = $("#learning-cards"), visual = $("#learning-visual");
    const cards = Array.isArray(learning.cards) ? learning.cards.filter(item => item && typeof item === "object") : [];
    visual.hidden = !cards.length;
    if (!cards.length) {
      holder.innerHTML = '<p class="learning-tools-empty">Study tools are being prepared.</p>';
      holder.dataset.enhanced = "true";
      return;
    }
    holder.setAttribute("role", "tablist");
    holder.setAttribute("aria-label", "Study tools");
    holder.setAttribute("aria-orientation", "vertical");
    holder.innerHTML = cards.map((item, index) => `<button class="learning-tool ${index === 0 ? "is-active" : ""}" id="learning-tab-${index}" data-learning-tab="${index}" type="button" role="tab" aria-label="${esc(item.title)}" aria-controls="learning-pane-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? "0" : "-1"}"><span class="learning-tool-heading"><span class="learning-tool-title">${esc(item.title)}</span><span class="learning-tool-number" aria-hidden="true">${esc(item.number || String(index + 1).padStart(2, "0"))}</span></span><span class="learning-tool-body"><span>${esc(item.text)}</span></span><i class="learning-tool-progress" aria-hidden="true"></i></button>`).join("");
    visual.innerHTML = cards.map((item, index) => `<section class="learning-pane" id="learning-pane-${index}" role="tabpanel" aria-labelledby="learning-tab-${index}" tabindex="0" ${index ? "hidden" : ""}><span class="learning-preview-kicker">${esc(learning.previewLabel ?? "FIRE COUNSEL · TOOL PREVIEW")}</span><h3>${esc(item.title)}</h3>${learningArtwork(index, item)}<a class="learning-open" href="${href(item.href)}">${esc(item.linkLabel || `Open ${item.title || "study tool"}`)} <span aria-hidden="true">↗</span></a></section>`).join("");
    const tabs = $$('[role="tab"]', holder), panes = $$(".learning-pane", visual);
    function select(index, focus = false) {
      if (!Number.isInteger(index) || index < 0 || index >= tabs.length) return;
      tabs.forEach((tab, i) => {
        const active = i === index;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        panes[i].hidden = !active;
      });
      if (focus) tabs[index].focus();
    }
    holder.addEventListener("click", event => {
      const tab = event.target.closest("[data-learning-tab]");
      if (tab) select(Number(tab.dataset.learningTab));
    });
    const hover = event => {
      // Touch keeps native tap-to-select. Hover must not steal keyboard focus
      // or hide a link/panel that a keyboard user is currently reading.
      if (event.pointerType !== "mouse") return;
      const focused = document.activeElement;
      if ((holder.contains(focused) || visual.contains(focused)) && focused.matches(":focus-visible")) return;
      const tab = event.target.closest("[data-learning-tab]");
      if (!tab) return;
      const bounds = tab.getBoundingClientRect();
      tab.style.setProperty("--pointer-x", `${Math.round(event.clientX - bounds.left)}px`);
      tab.style.setProperty("--pointer-y", `${Math.round(event.clientY - bounds.top)}px`);
      tabs.forEach(other => other.classList.toggle("is-pointer-active", other === tab));
      if (tab.getAttribute("aria-selected") !== "true") select(Number(tab.dataset.learningTab));
    };
    holder.addEventListener("pointerover", hover, { passive: true });
    holder.addEventListener("pointermove", hover, { passive: true });
    holder.addEventListener("pointerleave", () => tabs.forEach(tab => {
      tab.classList.remove("is-pointer-active");
      tab.style.removeProperty("--pointer-x"); tab.style.removeProperty("--pointer-y");
    }));
    holder.addEventListener("keydown", event => {
      const tab = event.target.closest("[data-learning-tab]");
      if (!tab) return;
      const current = Number(tab.dataset.learningTab);
      const next = {
        ArrowDown: (current + 1) % tabs.length,
        ArrowUp: (current - 1 + tabs.length) % tabs.length,
        Home: 0, End: tabs.length - 1
      }[event.key];
      if (next === undefined) return;
      event.preventDefault(); select(next, true);
    });
    // Match the reference's floating highlight only while its illustration
    // is in view. Deliberately no text autoplay, timers or recurring JS loop.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => visual.classList.toggle("is-in-view", entry.isIntersecting), { threshold: .1 }).observe(visual);
    } else visual.classList.add("is-in-view");
    holder.dataset.enhanced = "true";
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
    inner.innerHTML = `<div class="footer-brand"><a class="site-brand footer-mark fc-brand-lockup" href="#home"><span class="brand-image-wrap fc-brand-emblem"><img src="${photo(brand.markImage)}" alt="" width="72" height="72" loading="lazy"></span><span class="brand-copy fc-brand-copy"><strong>${esc(brand.name || "FIRE COUNSEL")}</strong><small>${esc(brand.tagline || "")}</small></span></a><p>${esc(footer.summary || "")}</p></div>${(footer.columns || []).map(column => `<div class="footer-column"><h3>${esc(column.title)}</h3>${(column.items || []).map(link => `<a href="${href(link.href)}">${esc(link.label)}</a>`).join("")}</div>`).join("")}`;
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
      [siteData, copyHelpers] = await Promise.all([loadContent(), import("./homepage-copy.mjs")]);
      // Editable single-introduction copy, independent of legacy slide data.
      renderNavigation(siteData); renderHeroCopy(siteData);
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
