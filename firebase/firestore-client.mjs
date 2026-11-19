// Firestore browser client for the two collections written directly from this
// site (see firebase/schema.md and firebase/firestore.rules):
//   siteContent/public  — admin publishes homepage content incl. slides
//   studentPages/{uid}  — a signed-in student edits their own public page
//
// Firestore Lite keeps the public homepage light (no realtime cache). The
// Auth SDK is imported lazily inside write helpers so a first-time visitor
// reading the homepage never pays for it. Every write is independently
// enforced by the deployed security rules — validation here only gives
// early, plain-language feedback.
import { doc, getDoc, getFirestore, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore-lite.js";
import { firebaseApp, firebaseSetupError } from "./client.mjs";
import { cleanStudentPage, siteContentFromDocument, validateSiteContent, validateStudentPage } from "./content-schema.mjs";

export const firestoreDb = firebaseApp ? getFirestore(firebaseApp) : null;
export const SITE_CONTENT_DOC = Object.freeze({ collection: "siteContent", id: "public" });
export const STUDENT_PAGES_COLLECTION = "studentPages";

function requireDb() {
  if (!firestoreDb) throw new Error(firebaseSetupError() || "Firebase is not configured on this site.");
  return firestoreDb;
}

async function requireUser({ admin = false } = {}) {
  const db = requireDb();
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js");
  const auth = getAuth(firebaseApp);
  const user = auth.currentUser;
  if (!user) throw new Error("Your Firebase sign-in is no longer active. Sign in again with Google, then retry.");
  const assertSession = () => {
    if (auth.currentUser !== user) throw new Error("Your session changed. Sign in again, then retry with the current account.");
  };
  // A recently granted admin claim may not be on the cached token yet. Force
  // one refresh before publishing; rules still independently check the token.
  const { claims } = await user.getIdTokenResult(admin);
  assertSession();
  if (claims.firebase?.sign_in_provider !== "google.com") throw new Error("Sign in with Google again before saving to Firebase.");
  if (admin && claims.admin !== true) throw new Error('This Google account has no server-issued admin claim. Use "Make this account the administrator" in Admin sign-in (the verified account must be in Render ADMIN_EMAILS), then retry. Publishing rules alone does not grant this claim.');
  return { db, user, claims, assertSession };
}

export function firestoreErrorText(error) {
  if (error?.code === "permission-denied") return "Firestore refused this request. Check the deployed Firestore rules in the matching Firebase project and the document fields. Publishing needs a Google session with admin: true; a student page needs its owner or an admin.";
  if (error?.code === "unauthenticated") return "Sign in again — Firebase did not accept the current session.";
  if (["unavailable", "deadline-exceeded", "resource-exhausted"].includes(error?.code)) return "Firestore could not be reached right now. Check the connection and try again.";
  if (error?.code === "not-found") return "That Firestore document does not exist.";
  return error?.message || "Firestore could not complete the request.";
}

// ---------------------------------------------------------------------------
// Homepage content (slides live in hero.slides of this document)

// Public read for the homepage. Returns null when Firebase is not configured,
// the document is missing, unreadable, or fails validation — callers fall
// back to the bundled ./data/site-content.json in those cases.
export async function loadPublicSiteContent() {
  if (!firestoreDb) return null;
  let timer;
  try {
    const snapshot = await Promise.race([
      getDoc(doc(firestoreDb, SITE_CONTENT_DOC.collection, SITE_CONTENT_DOC.id)),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2500); })
    ]);
    if (!snapshot?.exists()) return null;
    return siteContentFromDocument(snapshot.data());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Admin publish: writes the reviewed document directly with the caller's
// admin claim. The rules require updatedAt == request.time (the server
// timestamp sentinel) and updatedBy == the caller's uid.
export async function publishSiteContent(content) {
  const check = validateSiteContent(content);
  if (!check.ok) throw new Error(`This content cannot be published: ${check.errors[0]}`);
  const { db, user, assertSession } = await requireUser({ admin: true });
  try {
    assertSession();
    await setDoc(doc(db, SITE_CONTENT_DOC.collection, SITE_CONTENT_DOC.id), {
      ...content,
      updatedAt: serverTimestamp(),
      updatedBy: user.uid
    });
  } catch (error) {
    throw new Error(firestoreErrorText(error));
  }
}

// ---------------------------------------------------------------------------
// Student public pages

export async function getStudentPage(uid) {
  if (!firestoreDb) return { status: "unavailable", page: null };
  try {
    const snapshot = await getDoc(doc(firestoreDb, STUDENT_PAGES_COLLECTION, uid));
    if (!snapshot.exists()) return { status: "missing", page: null };
    const page = snapshot.data();
    if (!validateStudentPage(page).ok) return { status: "invalid", page: null };
    return { status: "ok", page };
  } catch (error) {
    if (error?.code === "permission-denied") return { status: "private", page: null };
    return { status: "unavailable", page: null };
  }
}

// Owner (or admin) save. The owner's page document keeps its original
// createdAt; the rules reject any change to it after creation.
export async function saveStudentPage(uid, input) {
  const { db, user, claims, assertSession } = await requireUser();
  if (user.uid !== uid && claims.admin !== true) throw new Error("You can only edit your own student page.");
  const page = cleanStudentPage(input);
  const reference = doc(db, STUDENT_PAGES_COLLECTION, uid);
  try {
    const existing = await getDoc(reference);
    const createdAt = existing.exists() && existing.data().createdAt ? existing.data().createdAt : serverTimestamp();
    assertSession();
    await setDoc(reference, { ...page, createdAt, updatedAt: serverTimestamp() });
    return page;
  } catch (error) {
    throw new Error(firestoreErrorText(error));
  }
}
