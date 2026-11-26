(() => {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) return;

  document.documentElement.classList.add("fc-motion-ready");

  const revealTargets = [
    ".welcome-row", ".hero-panel", ".section-heading",
    ".stats-grid .stat-card", ".content-grid > .panel",
    ".page-title-row", ".subject-card", ".notice",
    ".library-panel", ".memory-layout > .panel",
    ".exam-grid > .panel", ".auth-panel", ".ai-question-panel"
  ].join(",");

  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("fc-visible");
      currentObserver.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: "0px 0px -35px 0px" });

  function prepare(root = document) {
    if (root.matches?.(revealTargets) && !root.dataset.fcReveal) {
      root.dataset.fcReveal = "true";
      root.classList.add("fc-reveal");
      observer.observe(root);
    }
    root.querySelectorAll?.(revealTargets).forEach(element => {
      if (element.dataset.fcReveal) return;
      element.dataset.fcReveal = "true";
      element.classList.add("fc-reveal");
      observer.observe(element);
    });
  }

  prepare();
  const mutations = new MutationObserver(records => {
    records.forEach(record => {
      if (record.type === "childList") {
        record.addedNodes.forEach(node => {
          if (node.nodeType === 1) prepare(node);
        });
      } else if (record.type === "attributes" && record.target.classList.contains("active-page")) {
        prepare(record.target);
      }
    });
  });
  mutations.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class"]
  });
})();
