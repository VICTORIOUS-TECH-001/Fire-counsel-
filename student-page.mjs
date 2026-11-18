// "My public student page" — a Firestore document at studentPages/{uid} that
// the signed-in owner edits directly from the study page. The private account
// profile beside it still lives in Neon behind the API; this page is only the
// public, owner-published introduction. The deployed Firestore rules enforce
// ownership and the field limits; this module only gives friendly feedback.
import { createRequestScope } from "./request-scope.mjs";

const $ = selector => document.querySelector(selector);
const form = $("#student-page-form");
const statusNode = $("#student-page-status");
const actions = $("#student-page-actions");
const scope = createRequestScope();
let authClient = null;
let firestore = null;
let currentUser = null;
let busy = false;

function setStatus(text, kind = "") {
  statusNode.textContent = text;
  statusNode.dataset.kind = kind;
}

function updateControls() {
  const canEdit = Boolean(currentUser) && !busy;
  form.hidden = !currentUser;
  actions.hidden = !currentUser;
  for (const input of form.elements) input.disabled = !canEdit;
  if (currentUser) $("#student-page-view-link").href = `./student.html?u=${encodeURIComponent(currentUser.uid)}`;
}

function fillForm(page) {
  $("#student-page-name").value = page?.displayName || currentUser?.displayName || "";
  $("#student-page-headline").value = page?.headline || "";
  $("#student-page-bio").value = page?.bio || "";
  $("#student-page-links").value = (page?.links || []).join("\n");
  $("#student-page-focus").value = (page?.focusAreas || []).join(", ");
  $("#student-page-published").checked = page?.published === true;
  const saved = page?.updatedAt?.toDate?.();
  $("#student-page-updated").textContent = saved ? `Last saved ${saved.toLocaleString()}` : "";
}

async function loadPage() {
  const isCurrent = scope.begin();
  setStatus("Loading your page from Firestore…");
  const result = await firestore.getStudentPage(currentUser.uid);
  if (!isCurrent()) return;
  if (result.status === "ok") {
    fillForm(result.page);
    setStatus(result.page.published
      ? "Your page is published. Edit any field and save to update it."
      : "Your page is saved but private. Tick Publish my page to share it.", "ok");
    return;
  }
  fillForm(null);
  if (result.status === "missing") setStatus("No saved page yet — this form creates it. It stays private until you choose to publish.");
  else if (result.status === "invalid") setStatus("The stored page is not in the expected shape. Saving this form replaces it.", "error");
  else setStatus("Firestore could not be reached. Your draft below is safe to edit; save again when the connection returns.", "error");
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || busy) return;
  const isCurrent = scope.begin();
  busy = true;
  updateControls();
  setStatus("Saving your page to Firestore…");
  try {
    const page = await firestore.saveStudentPage(currentUser.uid, {
      displayName: $("#student-page-name").value,
      headline: $("#student-page-headline").value,
      bio: $("#student-page-bio").value,
      links: $("#student-page-links").value.split("\n"),
      focusAreas: $("#student-page-focus").value.split(","),
      published: $("#student-page-published").checked
    });
    if (!isCurrent()) return;
    fillForm(page);
    $("#student-page-updated").textContent = `Last saved ${new Date().toLocaleString()}`;
    setStatus(page.published
      ? "Saved — your page is public at the link below."
      : "Saved. Your page stays private until you tick Publish my page.", "ok");
  } catch (error) {
    if (isCurrent()) setStatus(error.message || "Your page could not be saved.", "error");
  } finally {
    if (isCurrent()) { busy = false; updateControls(); }
  }
});

function accountChanged(user) {
  scope.invalidate();
  currentUser = user;
  busy = false;
  updateControls();
  if (user) loadPage();
  else {
    fillForm(null);
    setStatus("Sign in with Firebase (the profile card above) to edit your public student page.");
  }
}

try {
  authClient = await import("./firebase/auth-client.mjs");
  firestore = await import("./firebase/firestore-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, accountChanged, () => {
    accountChanged(null);
    setStatus("Firebase Auth could not verify this session. Reload or sign in again.", "error");
  });
} catch (error) {
  accountChanged(null);
  setStatus("Firebase could not be loaded (this browser is offline, or Firebase is not configured on this site), so the public student page is unavailable right now.", "error");
  console.warn("Student page unavailable:", error?.message || error);
}
