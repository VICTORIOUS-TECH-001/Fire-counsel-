// In-app document reader for students: PDFs (rendered with pdf.js, served by
// this site at /vendor/pdfjs/), photos and text notes. Works offline for files
// saved on the device. Pages are drawn only when they scroll near the screen,
// so long law reports stay light on phones.
const PDFJS = "/vendor/pdfjs";
let pdfjsPromise = null;
let active = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS}/build/pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
      return lib;
    }).catch((error) => { pdfjsPromise = null; throw error; });
  }
  return pdfjsPromise;
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function kindOf(name = "", type = "") {
  const lower = name.toLowerCase();
  if (type === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (/^image\//.test(type) || /\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
  if (/^text\//.test(type) || /\.(txt|md|markdown)$/.test(lower)) return "text";
  return "other";
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = name || "document";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function buildShell(title) {
  const overlay = el("div", "reader-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", `Reading ${title}`);
  const bar = el("div", "reader-bar");
  const close = el("button", "reader-btn reader-close", "← Back");
  close.type = "button";
  close.setAttribute("aria-label", "Close the reader");
  const name = el("strong", "reader-title", title);
  const tools = el("div", "reader-tools");
  bar.append(close, name, tools);
  const body = el("div", "reader-body");
  body.tabIndex = 0;
  const status = el("p", "reader-status", "Opening…");
  status.setAttribute("role", "status");
  body.append(status);
  overlay.append(bar, body);
  return { overlay, close, tools, body, status };
}

function button(label, title, onClick) {
  const node = el("button", "reader-btn", label);
  node.type = "button";
  node.title = title;
  node.setAttribute("aria-label", title);
  node.addEventListener("click", onClick);
  return node;
}

async function renderPdf(shell, blob, name) {
  const { tools, body, status } = shell;
  let lib;
  try {
    lib = await loadPdfjs();
  } catch {
    // The PDF engine only ships with the main (Render) site. Fall back to the
    // phone's own PDF viewer.
    status.textContent = "The built-in reader is not available here. Opening the file with your phone's PDF viewer…";
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, "_blank", "noopener");
    if (!opened) download(blob, name);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  }
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: `${PDFJS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    wasmUrl: `${PDFJS}/wasm/`,
    iccUrl: `${PDFJS}/iccs/`,
    isEvalSupported: false,
    enableXfa: false
  });
  task.onPassword = (update, reason) => {
    const again = reason === lib.PasswordResponses?.INCORRECT_PASSWORD;
    const password = window.prompt(again ? "Wrong password. Try again:" : "This PDF is locked. Enter its password:");
    if (password == null) { task.destroy(); return; }
    update(password);
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    status.textContent = error?.name === "PasswordException" ? "This PDF is locked with a password." :
      error?.name === "InvalidPDFException" ? "This file is damaged or is not a real PDF." : `The PDF could not be opened (${error?.message || "unknown error"}).`;
    tools.append(button("Download", "Download the file", () => download(blob, name)));
    return task;
  }

  const total = pdf.numPages;
  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: 1 });
  let zoom = 1;
  let textMode = false;
  const pages = [];
  const rendering = new Map();
  const pageList = el("div", "reader-pages");
  const textPane = el("div", "reader-text");
  textPane.hidden = true;
  status.remove();
  body.append(pageList, textPane);

  const counter = button(`1 / ${total}`, "Go to page", () => {
    const answer = window.prompt(`Go to page (1–${total}):`, String(current));
    const number = Number.parseInt(answer, 10);
    if (number >= 1 && number <= total) {
      if (textMode) textPane.querySelector(`[data-text-page="${number}"]`)?.scrollIntoView();
      else pages[number - 1].scrollIntoView();
    }
  });
  counter.classList.add("reader-counter");
  let current = 1;
  const width = () => Math.max(200, Math.min(body.clientWidth - 16, 1400));
  const sizeOf = (viewport) => (width() / viewport.width) * zoom;

  for (let number = 1; number <= total; number++) {
    const holder = el("div", "reader-page");
    holder.dataset.page = String(number);
    holder.style.aspectRatio = `${base.width} / ${base.height}`;
    holder.style.width = `${Math.round(width() * zoom)}px`;
    holder.append(el("span", "reader-page-label", `Page ${number}`));
    pageList.append(holder);
    pages.push(holder);
  }

  async function draw(holder) {
    const number = Number(holder.dataset.page);
    if (holder.dataset.drawn === String(zoom) || rendering.has(number)) return;
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: sizeOf(page.getViewport({ scale: 1 })) });
    holder.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    // Keep each canvas under ~12 megapixels so phones do not run out of memory.
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12e6 / (viewport.width * viewport.height)));
    const canvas = el("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.setAttribute("aria-label", `Page ${number}`);
    const job = page.render({ canvas, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
    rendering.set(number, job);
    try {
      await job.promise;
      holder.querySelector("canvas")?.remove();
      holder.append(canvas);
      holder.dataset.drawn = String(zoom);
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") holder.querySelector(".reader-page-label").textContent = `Page ${number} could not be drawn`;
    } finally {
      rendering.delete(number);
    }
  }
  function release(holder) {
    const number = Number(holder.dataset.page);
    rendering.get(number)?.cancel();
    const canvas = holder.querySelector("canvas");
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
    delete holder.dataset.drawn;
  }

  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) draw(entry.target);
      else release(entry.target);
    }
  }, { root: body, rootMargin: "1200px 0px" });
  const visible = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        current = Number(entry.target.dataset.page);
        counter.textContent = `${current} / ${total}`;
      }
    }
  }, { root: body, threshold: 0.4 });
  pages.forEach((holder) => { near.observe(holder); visible.observe(holder); });

  function setZoom(next) {
    const keep = current;
    zoom = Math.min(3, Math.max(0.5, Math.round(next * 100) / 100));
    pages.forEach((holder) => {
      holder.style.width = `${Math.round(width() * zoom)}px`;
      if (holder.dataset.drawn) { release(holder); }
    });
    pages[keep - 1].scrollIntoView();
    // Re-draw what is on screen now.
    near.disconnect();
    pages.forEach((holder) => near.observe(holder));
  }

  async function showText() {
    textMode = !textMode;
    textButton.textContent = textMode ? "Pages" : "Text";
    textButton.setAttribute("aria-pressed", String(textMode));
    pageList.hidden = textMode;
    textPane.hidden = !textMode;
    if (!textMode || textPane.dataset.loaded) return;
    textPane.dataset.loaded = "1";
    let empty = 0;
    for (let number = 1; number <= total && active?.shell === shell; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n").trim();
      if (!text) empty++;
      const block = el("section", "reader-text-page");
      block.dataset.textPage = String(number);
      block.append(el("h3", "", `Page ${number}`), el("p", "", text || "(No text on this page — it is probably a scanned image. Switch back to Pages to read it.)"));
      textPane.append(block);
    }
    if (empty === total) textPane.prepend(el("p", "reader-status", "This PDF is scanned (pictures of pages), so there is no text to copy. Ask the AI tutor to read it, or switch back to Pages."));
  }
  const textButton = button("Text", "Show the text so you can copy it", showText);
  tools.append(
    button("−", "Zoom out", () => setZoom(zoom - 0.25)),
    button("+", "Zoom in", () => setZoom(zoom + 0.25)),
    counter,
    textButton,
    button("⇩", "Download", () => download(blob, name))
  );
  let resizeTimer;
  shell.onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => setZoom(zoom), 250); };
  window.addEventListener("resize", shell.onResize);
  shell.cleanup = () => {
    near.disconnect();
    visible.disconnect();
    rendering.forEach((job) => job.cancel());
    pages.forEach(release);
    window.removeEventListener("resize", shell.onResize);
  };
  return task;
}

/**
 * Opens the reader.
 * @param {{ name: string, type?: string, blob?: Blob, load?: () => Promise<Blob> }} file
 */
export async function openReader(file) {
  const replacing = Boolean(active);
  closeReader();
  const name = file.name || "Document";
  const shell = buildShell(name);
  document.body.append(shell.overlay);
  document.documentElement.classList.add("reader-open");
  const opener = document.activeElement;
  active = { shell, task: null, urls: [], opener };
  if (replacing) history.replaceState({ fireCounselReader: true }, "");
  else history.pushState({ fireCounselReader: true }, "");
  shell.close.addEventListener("click", () => history.back());
  shell.overlay.addEventListener("keydown", (event) => { if (event.key === "Escape") history.back(); });
  shell.close.focus();

  let blob = file.blob;
  try {
    if (!blob && file.load) blob = await file.load();
  } catch (error) {
    shell.status.textContent = error?.message || "The file could not be loaded.";
    return;
  }
  if (!blob || active?.shell !== shell) return;
  const kind = kindOf(name, file.type || blob.type);
  if (kind === "pdf") {
    active.task = await renderPdf(shell, blob, name);
  } else if (kind === "image") {
    const url = URL.createObjectURL(blob);
    active.urls.push(url);
    const image = el("img", "reader-image");
    image.src = url;
    image.alt = name;
    shell.status.replaceWith(image);
    shell.tools.append(button("⇩", "Download", () => download(blob, name)));
  } else if (kind === "text") {
    const pre = el("pre", "reader-plain", await blob.text());
    shell.status.replaceWith(pre);
    shell.tools.append(button("⇩", "Download", () => download(blob, name)));
  } else {
    shell.status.textContent = "This type of file cannot be shown here. Download it to open it with another app.";
    shell.tools.append(button("Download", "Download the file", () => download(blob, name)));
  }
}

export function closeReader() {
  if (!active) return;
  const { shell, task, urls, opener } = active;
  active = null;
  shell.cleanup?.();
  try { task?.destroy(); } catch { /* already closed */ }
  urls.forEach((url) => URL.revokeObjectURL(url));
  shell.overlay.remove();
  document.documentElement.classList.remove("reader-open");
  if (opener && typeof opener.focus === "function") opener.focus();
}

// The phone's Back button closes the reader instead of leaving the page.
window.addEventListener("popstate", () => { if (active) closeReader(); });
