// Public viewer for a student's Firestore page: student.html?u=<uid>.
// Reads studentPages/{uid} without sign-in; the deployed rules only release a
// document whose owner set published: true. Everything renders through
// textContent and re-validated https links — a page can never inject markup.
const $ = selector => document.querySelector(selector);

function setStatus(text, kind = "") {
  const node = $("#sp-status");
  node.textContent = text;
  node.dataset.kind = kind;
}

function showUnavailable(message) {
  $("#sp-name").textContent = "Student page";
  $("#sp-headline").textContent = "";
  $("#sp-body").hidden = true;
  setStatus(message);
}

function linkLabel(url) {
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${host}${path}`.slice(0, 80);
}

function render(page) {
  document.title = `${page.displayName} · FIRE COUNSEL`;
  $("#sp-name").textContent = page.displayName;
  $("#sp-headline").textContent = page.headline || "Law student at FIRE COUNSEL";
  $("#sp-bio").textContent = page.bio || "";
  $("#sp-bio").hidden = !page.bio;
  const focus = $("#sp-focus");
  focus.replaceChildren();
  for (const area of page.focusAreas || []) {
    const chip = document.createElement("li");
    chip.textContent = area;
    focus.append(chip);
  }
  focus.hidden = !(page.focusAreas || []).length;
  const links = $("#sp-links");
  links.replaceChildren();
  let shown = 0;
  for (const value of page.links || []) {
    let url;
    try { url = new URL(value); } catch { continue; }
    if (url.protocol !== "https:") continue;
    const anchor = document.createElement("a");
    anchor.href = url.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = linkLabel(url);
    const item = document.createElement("li");
    item.append(anchor);
    links.append(item);
    shown += 1;
  }
  links.hidden = shown === 0;
  const saved = page.updatedAt?.toDate?.();
  $("#sp-updated").textContent = saved ? `Updated ${saved.toLocaleDateString(undefined, { dateStyle: "medium" })}` : "";
  $("#sp-body").hidden = false;
  setStatus("Published student page.", "ok");
}

async function main() {
  const uid = new URLSearchParams(location.search).get("u") || "";
  // Firebase Auth UIDs are alphanumeric; anything else is not a page link.
  if (!/^[A-Za-z0-9]{1,128}$/.test(uid)) {
    showUnavailable("This student page link is not valid. Ask the student to share the link shown in their study workspace.");
    return;
  }
  let firestore;
  try {
    firestore = await import("./firebase/firestore-client.mjs");
  } catch {
    showUnavailable("This student page could not be loaded from here.");
    return;
  }
  const result = await firestore.getStudentPage(uid);
  if (result.status !== "ok" || result.page.published !== true) {
    showUnavailable(result.status === "unavailable"
      ? "The page could not be reached. Check the connection and try again."
      : "This student has not published a page (or has made it private again).");
    return;
  }
  render(result.page);
}

main().catch(() => showUnavailable("The page could not be reached. Check the connection and try again."));
