import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page, context, baseURL }, use) => {
    // A regression run must never contact live Firebase, Google or Neon services.
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(baseURL).origin) return route.continue();
      return route.abort("blockedbyclient");
    });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "no uncaught page errors").toEqual([]);
  }
});
export { expect };

export async function expectNoHorizontalOverflow(page) {
  // Resize and same-document navigation update viewport/styles on render frames.
  // Wait on that actual browser condition instead of issuing timed CDP samples
  // through expect.poll (which could time out without completing a measurement).
  // No fixed sleep, clipping CSS, relaxed width threshold or whole-test retry.
  // Headless Chromium may otherwise throttle render frames on an occluded tab.
  await page.bringToFront();
  try {
    const fits = await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth,
      null, { polling: "raf", timeout: 7_000 });
    await fits.dispose();
  } catch (error) {
    // Collect bounds once on failure; do not force layout on every descendant
    // for every passing check. Evaluation errors are not swallowed by a poll.
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      width: document.documentElement.scrollWidth,
      visibility: document.visibilityState,
      readyState: document.readyState,
      overflowing: [...document.querySelectorAll("body *")].flatMap(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > window.innerWidth + 0.5
          ? [{ element: element.id ? `#${element.id}` : element.tagName.toLowerCase(), right: Math.round(rect.right), width: Math.round(rect.width) }]
          : [];
      }).slice(0, 12)
    }));
    throw new Error(`Responsive layout fits the viewport without horizontal overflow: ${JSON.stringify(layout)}`, { cause: error });
  }
}

export const student = { uid: "synthetic-student", email: "student@example.invalid", displayName: "Synthetic Student", emailVerified: true, providerData: [{ providerId: "google.com" }, { providerId: "password" }], signInProvider: "google.com" };
export const admin = { uid: "synthetic-admin", email: "admin@example.invalid", providerData: [{ providerId: "google.com" }], signInProvider: "google.com" };
export const rowId = "223e4567-e89b-42d3-a456-426614174000";

export async function stubAuth(page, { user = null } = {}) {
  await page.route("**/firebase/auth-client.mjs", route => route.fulfill({
    contentType: "text/javascript",
    body: `
      import { browserInstallation, INSTALLATION_HEADER, needsStudentInstallation } from '/installation.mjs';
      export const firebaseAuth = { currentUser: ${JSON.stringify(user)} };
      window.__firebaseAuth = firebaseAuth;
      const listeners = new Set();
      window.__auth = {
        googleCalls: 0, emailChanges: [], passwordChanges: 0, verificationCalls: 0, refreshCalls: 0,
        setUser(user) { firebaseAuth.currentUser = user; for (const fn of listeners) fn(user); },
        async checkGoogleSession(user) { return user?.signInProvider === 'google.com'; }
      };
      export function onAuthStateChanged(_auth, callback) {
        listeners.add(callback);
        queueMicrotask(() => callback(firebaseAuth.currentUser));
        return () => listeners.delete(callback);
      }
      export const onIdTokenChanged = onAuthStateChanged;
      export function hasPasswordProvider(user = firebaseAuth.currentUser) { return Boolean(user?.providerData?.some(provider => provider.providerId === 'password')); }
      export async function getRedirectResult() { return null; }
      export async function hasGoogleSession(user = firebaseAuth.currentUser) { return window.__auth.checkGoogleSession(user); }
      export async function signInWithGoogle() { window.__auth.googleCalls++; window.__auth.setUser({ uid: 'synthetic-student', email: 'google@example.invalid', displayName: 'Google Student', emailVerified: true, providerData: [{ providerId: 'google.com' }], signInProvider: 'google.com' }); }
      export async function requestAccountEmailChange(email) { window.__auth.emailChanges.push(email); }
      export async function changeAccountPassword() { window.__auth.passwordChanges++; }
      export async function requestAccountVerification() { window.__auth.verificationCalls++; }
      export async function refreshAccount() { window.__auth.refreshCalls++; return firebaseAuth.currentUser; }
      export async function signOut() { window.__auth.setUser(null); }
      export async function apiRequest(path, options = {}) {
        const headers = new Headers(options.headers);
        headers.set('Authorization', 'Bearer synthetic-test-token');
        if (needsStudentInstallation(new URL(path, location.origin).pathname)) headers.set(INSTALLATION_HEADER, await browserInstallation());
        if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
        return fetch(path, { ...options, headers, cache: 'no-store' });
      }
    `
  }));
}

// Stub only the SDK/network boundary, not firestore-client.mjs: publishing,
// validation, metadata stripping and fresh-claim checks run the production code.
export async function stubFirestore(page, { content = null } = {}) {
  await page.route("**/firebase/client.mjs", route => route.fulfill({ contentType: "text/javascript", body: `
    export const firebaseApp = { options: { projectId: 'fire-counsel' } };
    export const firebaseSetupError = () => '';
  ` }));
  await page.route("https://www.gstatic.com/firebasejs/*/firebase-firestore-lite.js", route => route.fulfill({ contentType: "text/javascript", body: `
    window.__firestore = { document: ${JSON.stringify(content && { ...content, updatedAt: { seconds: 1000 }, updatedBy: "synthetic-admin" })}, writes: [], tokenRefreshes: [], failWrites: null, adminClaim: true };
    export const getFirestore = () => ({});
    export const doc = (_db, collection, id) => ({ collection, id });
    export const serverTimestamp = () => ({ seconds: 2000 });
    export async function getDoc() {
      const data = window.__firestore.document;
      return { exists: () => Boolean(data), data: () => structuredClone(data) };
    }
    export async function setDoc(reference, content) {
      if (window.__firestore.failWrites) throw Object.assign(new Error('Synthetic rule denial'), { code: window.__firestore.failWrites });
      window.__firestore.document = structuredClone(content);
      window.__firestore.writes.push({ reference, content: structuredClone(content) });
    }
  ` }));
  await page.route("https://www.gstatic.com/firebasejs/*/firebase-auth.js", route => route.fulfill({ contentType: "text/javascript", body: `
    export function getAuth() {
      const auth = window.__firebaseAuth;
      if (auth?.currentUser) auth.currentUser.getIdTokenResult = async (refresh) => {
        window.__firestore.tokenRefreshes.push(refresh);
        return { claims: { admin: window.__firestore.adminClaim && auth.currentUser?.uid === 'synthetic-admin', firebase: { sign_in_provider: auth.currentUser?.signInProvider } } };
      };
      return auth;
    }
  ` }));
}

export function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export const catalog = [{
  key: "universities", label: "Universities", deleteMode: "deactivate",
  displayColumns: ["name", "slug", "is_active"],
  fields: [
    { name: "name", label: "University name", type: "text", required: true, maxLength: 160 },
    { name: "slug", label: "Slug", type: "text", required: true, maxLength: 160 },
    { name: "is_active", label: "Active", type: "boolean", default: true }
  ]
}];
