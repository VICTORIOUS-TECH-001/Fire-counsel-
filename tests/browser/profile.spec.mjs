import { test, expect, expectNoHorizontalOverflow, stubAuth, student, json, rowId } from "./fixtures.mjs";

const installationKey = "fire-counsel-installation-v1";
const baseProfile = {
  id: rowId, full_name: "Synthetic Student", email: student.email, email_verified: true, photo_url: null,
  installation: { registered: true, policy: "browser-installation-v1", bound_at: "2026-11-15T10:00:00Z", last_seen_at: "2026-11-15T10:00:00Z", observed_ip: "192.0.2.10", ip_source: "connection_peer" }
};
const google = { ...student, email: "google@example.invalid", displayName: "Google Student", providerData: [{ providerId: "google.com" }] };

async function profileApi(page, { initial = baseProfile, lock = false, identity = student } = {}) {
  let saved = initial ? structuredClone(initial) : null;
  let installation;
  const requests = [];
  await page.route("**/api/v1/materials?*", route => json(route, { data: [] }));
  await page.route("**/api/v1/profile", route => {
    const request = route.request();
    const id = request.headers()["x-fire-counsel-installation"];
    requests.push({ method: request.method(), headers: request.headers(), body: request.postDataJSON() });
    if (!id) return json(route, { code: "INSTALLATION_REQUIRED", error: "Persistent installation required." }, 400);
    if (lock && saved && installation && installation !== id) return json(route, { code: "INSTALLATION_MISMATCH", error: "This account is registered to another browser installation. Existing profiles are never transferred automatically." }, 403);
    if (!installation && saved) installation = id;
    if (request.method() === "GET") return saved ? json(route, { data: saved }) : json(route, { code: "PROFILE_NOT_CREATED", error: "Create your profile first." }, 404);
    const creating = !saved;
    const body = request.postDataJSON();
    if (!saved) {
      saved = { ...structuredClone(baseProfile), full_name: identity.displayName, email: identity.email, email_verified: identity.emailVerified };
      installation = id;
    }
    saved.full_name = body.full_name || saved.full_name;
    return json(route, { data: saved }, creating ? 201 : 200);
  });
  return { requests, get saved() { return saved; }, get installation() { return installation; } };
}

async function readyProfile(page) {
  await page.goto("/study.html#profile");
  await expect(page.locator("#profile-page")).toBeVisible();
  await expect(page.locator("#student-profile-form")).toBeVisible();
  await expect(page.locator("#profile-save")).not.toHaveText("Checking");
}

async function finish(page, response) {
  await response.finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("Google sign-in shows the name, photo and welcome before the optional server profile replies or is enabled", async ({ page }) => {
  const photo = "https://lh3.googleusercontent.com/a/synthetic-student=s96-c";
  await stubAuth(page, { user: { ...google, photoURL: photo } });
  await page.route(photo, route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") }));
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  const methods = [];
  await page.route("**/api/v1/profile", async route => {
    methods.push(route.request().method());
    started();
    await blocked;
    return json(route, { code: "STUDENT_PROFILES_DISABLED", error: "Student profiles are not enabled. Review the staging schema and profile migration first." }, 503);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/study.html#profile");
  await requested;
  await expect(page.locator("#student-profile-title")).toHaveText("Google Student");
  await expect(page.locator("#profile-welcome")).toHaveText("Welcome, Google Student!");
  await expect(page.locator("#profile-display-email")).toHaveText(google.email);
  await expect(page.locator("#profile-photo")).toBeVisible();
  await expect(page.locator("#student-profile-photo")).toBeVisible();
  await expect(page.locator("#ws-signin")).toBeHidden();
  release();
  await expect(page.locator("#student-profile-status")).toHaveAttribute("data-code", "STUDENT_PROFILES_DISABLED");
  await expect(page.locator("#student-profile-status")).toContainText("signed in with Google");
  await expect(page.locator("#student-profile-status")).not.toContainText("migration");
  await expect(page.locator("#student-profile-title")).toHaveText("Google Student");
  await expect(page.locator("#profile-photo")).toHaveAttribute("src", photo);
  await expect(page.locator("#student-profile-form")).toBeHidden();
  await expect(page.locator("#profile-security")).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.locator("#profile-refresh").click();
  await expect(page.locator("#student-profile-status")).toHaveAttribute("data-code", "STUDENT_PROFILES_DISABLED");
  await expect(page.locator("#student-profile-name")).toHaveText("Google Student");
  expect(methods).toEqual(["GET", "GET"], "Google identity never auto-creates a server profile or registers an installation");
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  for (const value of [google.displayName, google.email, photo]) expect(storage).not.toContain(value);
  await page.locator("#menu-toggle").click();
  await page.locator("#student-nav [data-page=dashboard]").click();
  await expect(page.locator("#ws-account-welcome")).toHaveText("Welcome, Google Student!");
  await expect(page.locator("#ws-welcome-title")).toHaveText("Welcome to FIRE COUNSEL,");
  await expectNoHorizontalOverflow(page);
});

test("Google provider details and safe photo fallbacks survive outages, account switches and sign-out", async ({ page }) => {
  const photo = "https://lh3.googleusercontent.com/a/provider-photo=s96-c";
  const broken = "https://lh3.googleusercontent.com/a/missing-photo=s96-c";
  const providerUser = { ...google, displayName: "", photoURL: null, providerData: [{ providerId: "google.com", displayName: "Provider Student", photoURL: photo }] };
  await stubAuth(page, { user: providerUser });
  await page.route(photo, route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") }));
  await page.route(broken, route => route.fulfill({ status: 404, body: "Missing" }));
  await page.route("**/api/v1/profile", route => json(route, { code: "PROFILE_UNAVAILABLE", error: "Synthetic profile outage" }, 503));
  await page.goto("/study.html#profile");
  await expect(page.locator("#student-profile-title")).toHaveText("Provider Student");
  await expect(page.locator("#student-profile-status")).toContainText("Synthetic profile outage");
  await expect(page.locator("#profile-photo")).toBeVisible();
  await expect(page.locator("#student-profile-photo")).toBeVisible();
  await expect(page.locator("#student-profile-link")).toHaveAttribute("aria-label", "Open profile for Provider Student");
  await expect(page.locator("#student-profile-form")).toBeHidden();

  const unsafe = ["http://lh3.googleusercontent.com/photo", "https://lh3.googleusercontent.com.evil.invalid/photo", "https://user@lh3.googleusercontent.com/photo", "data:image/png;base64,invalid"];
  const requested = [];
  page.on("request", request => requested.push(request.url()));
  for (const photoURL of unsafe) {
    const name = "Ada <img src=x onerror=unsafe()> Student";
    await page.evaluate(user => window.__auth.setUser(user), { ...google, uid: "next-google-user", displayName: name, photoURL });
    await expect(page.locator("#student-profile-title")).toHaveText(name);
    await expect(page.locator("#student-profile-title img, #profile-welcome img")).toHaveCount(0);
    for (const id of ["profile-photo", "student-profile-photo"]) {
      await expect(page.locator(`#${id}`)).toBeHidden();
      expect(await page.locator(`#${id}`).getAttribute("src")).toBeNull();
    }
    await expect(page.locator("#profile-initials")).toHaveText("A<");
  }
  expect(requested.some(url => unsafe.includes(url))).toBe(false);
  await page.evaluate(user => window.__auth.setUser(user), { ...google, uid: "missing-name-user", displayName: "", photoURL: null });
  await expect(page.locator("#student-profile-title")).toHaveText("Student");
  await expect(page.locator("#profile-welcome")).toHaveText("Welcome, Student!");
  await page.evaluate(user => window.__auth.setUser(user), { ...google, uid: "broken-photo-user", displayName: "Photo Fallback", photoURL: broken });
  await expect(page.locator("#student-profile-title")).toHaveText("Photo Fallback");
  for (const id of ["profile-photo", "student-profile-photo"]) {
    await expect(page.locator(`#${id}`)).toHaveAttribute("src", broken);
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  await expect(page.locator("#student-profile-avatar")).toHaveText("PF");
  await page.locator("#profile-signout").click();
  await expect(page.locator("#auth-gate-signin")).toBeVisible();
  await expect(page.locator("#student-profile-name")).toHaveText("Student workspace");
  for (const id of ["profile-welcome", "ws-account-welcome"]) {
    await expect(page.locator(`#${id}`)).toHaveText("");
    await expect(page.locator(`#${id}`)).toBeHidden();
  }
  for (const id of ["profile-photo", "student-profile-photo"]) expect(await page.locator(`#${id}`).getAttribute("src")).toBeNull();
  expect(await page.locator("#ws-signin").getAttribute("hidden")).toBeNull();
});

test("Google details prefill a new profile and creation requires explicit installation acceptance", async ({ page }) => {
  await stubAuth(page, { user: google });
  const api = await profileApi(page, { initial: null, identity: google });
  const mutations = [];
  page.on("request", request => { if (request.url().includes("/api/") && !request.url().includes("/api/v1/presence") && !["GET", "HEAD"].includes(request.method())) mutations.push(request); });
  await readyProfile(page);
  await expect(page.locator("#student-full-name")).toHaveValue("Google Student");
  await expect(page.locator("#student-email")).toHaveValue("google@example.invalid");
  await expect(page.locator("#student-email")).toHaveAttribute("readonly", "");
  await expect(page.locator("#student-profile-form input")).toHaveCount(3);
  await expect(page.locator("#profile-save")).toBeDisabled();
  await expect(page.locator("#profile-installation-consent")).toContainText("cleared site data");
  await page.locator("#accept-installation-policy").check();
  await page.locator("#profile-save").click();
  await expect(page.locator("#student-profile-status")).toContainText("profile is created");
  await expect(page.locator("#student-profile-name")).toHaveText("Google Student");
  await expect(page.locator("#profile-google-password")).toBeVisible();
  await expect(page.locator("#profile-password-form")).toBeHidden();
  await expect(page.locator("#profile-observed-ip")).toHaveText("192.0.2.10");
  await expect(page.locator("#profile-ip-source")).toContainText("not your public IP");
  expect(mutations.map(request => new URL(request.url()).pathname)).toEqual(["/api/v1/profile"]);
  expect(mutations[0].postDataJSON()).toEqual({ full_name: "Google Student", installation_policy: "browser-installation-v1" });
  const id = await page.evaluate(key => localStorage.getItem(key), installationKey);
  expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(api.requests.every(request => request.headers["x-fire-counsel-installation"] === id)).toBe(true);
});

test("students can edit and reload their own name as safe text, without identity/privilege fields", async ({ page }) => {
  await stubAuth(page, { user: student });
  const api = await profileApi(page);
  await readyProfile(page);
  const name = "Chosen <img src=x onerror=unsafe()> Name";
  await page.locator("#student-full-name").fill(name);
  await page.locator("#profile-save").click();
  await expect(page.locator("#student-profile-status")).toHaveText("Your profile has been saved.");
  await expect(page.locator("#student-profile-title")).toHaveText(name);
  await expect(page.locator("#student-profile-title img")).toHaveCount(0);
  expect(api.requests.find(request => request.method === "PATCH").body).toEqual({ full_name: name });
  await page.locator("#student-nav [data-page=dashboard]").click();
  await expect(page.locator("#profile-role")).toHaveText("Student profile · this browser");
  // Rehydrate from the actual GET after reload, not a prior document or a
  // background tab's throttled render frame. The API and text checks remain strict.
  await page.bringToFront();
  const [reloaded] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/v1/profile") && response.request().method() === "GET"),
    page.reload()
  ]);
  expect(reloaded.ok()).toBe(true);
  expect((await reloaded.json()).data.full_name).toBe(name);
  await expect(page.locator("#student-profile-name")).toHaveText(name);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(storage).not.toContain(name);
  expect(storage).not.toContain(student.email);
});

test("Firebase security actions clear password inputs and never send passwords in a profile API body", async ({ page }) => {
  await stubAuth(page, { user: student });
  const api = await profileApi(page);
  await readyProfile(page);
  await page.locator("#profile-current-password").fill("synthetic-current-password");
  await page.locator("#profile-new-password").fill("synthetic-new-password");
  await page.locator("#profile-confirm-password").fill("synthetic-new-password");
  await page.locator("#profile-password-save").click();
  await expect(page.locator("#profile-security-status")).toContainText("Firebase updated your password");
  expect(await page.evaluate(() => window.__auth.passwordChanges)).toBe(1);
  for (const id of ["profile-current-password", "profile-new-password", "profile-confirm-password"]) await expect(page.locator(`#${id}`)).toHaveValue("");
  await page.locator("#profile-new-email").fill("new@example.invalid");
  await page.locator("#profile-email-password").fill("synthetic-current-password");
  await page.locator("#profile-email-save").click();
  await expect(page.locator("#profile-security-status")).toContainText("verification link");
  expect(await page.evaluate(() => window.__auth.emailChanges)).toEqual(["new@example.invalid"]);
  await expect(page.locator("#student-email")).toHaveValue(student.email);
  await expect(page.locator("#profile-email-password")).toHaveValue("");
  expect(api.requests.every(request => request.method === "GET")).toBe(true);
  expect(JSON.stringify(api.requests)).not.toContain("synthetic-current-password");
  expect(JSON.stringify(api.requests)).not.toContain("synthetic-new-password");
});

test("email verification is explicit and refresh syncs only verified Firebase identity metadata", async ({ page }) => {
  await stubAuth(page, { user: { ...student, emailVerified: false } });
  const api = await profileApi(page, { initial: { ...baseProfile, email_verified: false } });
  await readyProfile(page);
  await expect(page.locator("#profile-verification")).toBeVisible();
  expect(await page.evaluate(() => window.__auth.verificationCalls)).toBe(0);
  await page.locator("#profile-send-verification").click();
  await expect(page.locator("#profile-security-status")).toContainText("verification email");
  expect(await page.evaluate(() => window.__auth.verificationCalls)).toBe(1);
  api.saved.email_verified = true;
  const synced = page.waitForResponse(response => response.url().endsWith("/api/v1/profile") && response.request().method() === "POST");
  await page.locator("#profile-refresh").click();
  await synced;
  await expect(page.locator("#student-profile-status")).toContainText("profile is ready");
  await expect(page.locator("#profile-verification")).toBeHidden();
  expect(await page.evaluate(() => window.__auth.refreshCalls)).toBe(1);
  expect(api.requests.find(request => request.method === "POST").body).toEqual({ installation_policy: "browser-installation-v1" });
});

test("losing the saved installation blocks the old profile instead of rebinding it or clearing study data", async ({ page }) => {
  await stubAuth(page, { user: student });
  const api = await profileApi(page, { lock: true });
  await readyProfile(page);
  const original = api.installation;
  await page.evaluate(key => { localStorage.setItem("lexmaster-sessions", "7"); localStorage.removeItem(key); }, installationKey);
  await page.reload();
  await expect(page.locator("#student-profile-status")).toHaveAttribute("data-code", "INSTALLATION_MISMATCH");
  await expect(page.locator("#student-profile-form")).toBeHidden();
  await expect(page.locator("#profile-security")).toBeHidden();
  // Google identity is independent of the denied server profile; it grants
  // no installation access and must not label the profile as ready.
  await expect(page.locator("#student-profile-name")).toHaveText(student.displayName);
  await expect(page.locator("#profile-role")).toHaveText("Signed in with Google");
  await expect(page.locator("#profile-device-details")).toBeHidden();
  expect(api.installation).toBe(original);
  expect(await page.evaluate(key => localStorage.getItem(key), installationKey)).not.toBe(original);
  expect(await page.evaluate(() => localStorage.getItem("lexmaster-sessions"))).toBe("7");
  expect(api.requests.every(request => request.method === "GET")).toBe(true);
});

test("a binding denial on the auth screen cannot unlock student continuation", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/profile", route => json(route, { code: "INSTALLATION_MISMATCH", error: "This account is registered to another browser installation." }, 403));
  await page.goto("/auth.html");
  await expect(page.locator("#auth-message")).toContainText("another browser installation");
  await expect(page.locator("#continue-button")).toBeHidden();
  await expect(page.locator("#google-signin-button")).toBeHidden();
});

test("a delayed profile load cannot restore a signed-out user's details", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/materials?*", route => json(route, { data: [] }));
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/profile", async route => { started(); await blocked; await json(route, { data: { ...baseProfile, full_name: "Previous private profile" } }); });
  await page.goto("/study.html#profile");
  await requestStarted;
  await page.locator("#profile-signout").click();
  await expect(page.locator("#auth-gate-signin")).toBeVisible();
  const returned = page.waitForResponse("**/api/v1/profile");
  release(); await finish(page, await returned);
  await expect(page.locator("#student-profile-form")).toBeHidden();
  await expect(page.locator("#student-profile-name")).toHaveText("Student workspace");
  await expect(page.locator("#student-profile-status")).toContainText("Sign in");
  await expect(page.locator("#profile-welcome")).toHaveText("");
  await expect(page.locator("#ws-account-welcome")).toHaveText("");
  await expect(page.locator("#profile-page")).not.toContainText("Previous private profile");
});

test("a delayed profile save cannot replace the next account's profile", async ({ page }) => {
  await stubAuth(page, { user: student });
  await page.route("**/api/v1/materials?*", route => json(route, { data: [] }));
  let release, started, switched = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/profile", async route => {
    if (route.request().method() === "PATCH") { started(); await blocked; return json(route, { data: { ...baseProfile, full_name: "Old account saved name" } }); }
    return json(route, { data: switched ? { ...baseProfile, full_name: "Next Student", email: "next@example.invalid" } : baseProfile });
  });
  await readyProfile(page);
  await page.locator("#student-full-name").fill("Old account saved name");
  await page.locator("#profile-save").click();
  await requestStarted;
  switched = true;
  await page.evaluate(() => window.__auth.setUser({ uid: "next-user", email: "next@example.invalid", displayName: "Next Student", providerData: [{ providerId: "google.com" }], signInProvider: "google.com" }));
  await expect(page.locator("#student-profile-name")).toHaveText("Next Student");
  const returned = page.waitForResponse(response => response.url().endsWith("/api/v1/profile") && response.request().method() === "PATCH");
  release(); await finish(page, await returned);
  await expect(page.locator("#student-full-name")).toHaveValue("Next Student");
  await expect(page.locator("#student-email")).toHaveValue("next@example.invalid");
});

test("profile loading, creation, security and signed-out views fit small screens", async ({ page }) => {
  const identity = { ...student, displayName: "A".repeat(120) };
  await stubAuth(page, { user: identity });
  await profileApi(page, { initial: null, identity });
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route("**/api/v1/profile", async route => {
    if (route.request().method() === "GET") { started(); await blocked; }
    await route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/study.html#profile");
  await requestStarted;
  await expect(page.locator("#student-profile-status")).toContainText("Checking");
  await expectNoHorizontalOverflow(page);
  release();
  await expect(page.locator("#profile-installation-consent")).toBeVisible();

  const checkWidths = async () => {
    for (const width of [320, 390, 768, 1024]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page);
    }
  };
  await checkWidths();
  await page.locator("#accept-installation-policy").check();
  await page.locator("#profile-save").click();
  await expect(page.locator("#profile-security")).toBeVisible();
  await expect(page.locator("#student-profile-title")).toHaveText(identity.displayName);
  await checkWidths();
  await page.locator("#profile-signout").click();
  await expect(page.locator("#auth-gate-signin")).toBeVisible();
  await checkWidths();
});

test("profile editing and sign-out preserve local recall records, session count and the installation marker", async ({ page }) => {
  await stubAuth(page, { user: student });
  await profileApi(page);
  await page.goto("/study.html#memory");
  await page.locator("#card-front").fill("Preserved local question");
  await page.locator("#card-back").fill("Preserved local answer");
  await page.locator("#memory-form button[type=submit]").click();
  await expect(page.locator("#memory-count")).toHaveText("1 card");
  await page.evaluate(() => localStorage.setItem("lexmaster-sessions", "7"));
  const id = await page.evaluate(key => localStorage.getItem(key), installationKey);
  await page.locator("#student-nav [data-page=profile]").click();
  await page.locator("#student-full-name").fill("Edited Profile Only");
  await page.locator("#profile-save").click();
  await expect(page.locator("#student-profile-status")).toContainText("has been saved");
  await page.locator("#profile-signout").click();
  await expect(page.locator("#auth-gate-signin")).toBeVisible();
  await page.reload();
  // The stubbed session is restored on reload (like Firebase persistence), so
  // the gate unlocks — and the local study data must have survived.
  await expect(page.locator("#auth-gate")).toBeHidden();
  await page.locator("#student-nav [data-page=memory]").click();
  await expect(page.locator("#recall-area")).toContainText("Preserved local question");
  await expect(page.locator("#stat-sessions")).toHaveText("7");
  expect(await page.evaluate(key => localStorage.getItem(key), installationKey)).toBe(id);
  await page.setViewportSize({ width: 390, height: 844 });
  // Use the mobile navigation, not a second native fragment navigation while
  // Chromium is resizing/restoring the preceding page's scroll position.
  await page.locator("#menu-toggle").click();
  await page.locator("#student-nav [data-page=profile]").click();
  await expect(page.locator("#sidebar")).not.toHaveClass(/\bopen\b/);
  await expect(page.locator("#profile-page")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("workspace stays locked for a signed-out visitor and unlocks on sign-in", async ({ page }) => {
  await stubAuth(page);
  await page.goto("/study.html#dashboard");
  // No preview: the shell is hidden behind the lock screen.
  await expect(page.locator("#auth-gate")).toBeVisible();
  await expect(page.locator("#auth-gate-signin")).toHaveAttribute("href", "./auth.html?next=study.html");
  await expect(page.locator("#main-content")).toBeHidden();
  await expect(page.locator("#sidebar")).toBeHidden();
  // A late sign-in (e.g. redirect back from the auth page) unlocks it live.
  await page.evaluate(u => window.__auth.setUser(u), student);
  await expect(page.locator("#auth-gate")).toBeHidden();
  await expect(page.locator("#main-content")).toBeVisible();
  // Signing out locks it again and clears the offline-return marker.
  await page.evaluate(() => window.__auth.setUser(null));
  await expect(page.locator("#auth-gate")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("fire-counsel-auth-gate-v2"))).toBe(null);
});

test("workspace opens offline only for a browser that signed in before", async ({ page }) => {
  // Firebase cannot load (offline/blocked): a fresh browser stays locked.
  await page.route("**/firebase/auth-client.mjs", route => route.abort());
  await page.goto("/study.html#dashboard");
  await expect(page.locator("#auth-gate")).toBeVisible();
  await expect(page.locator("#main-content")).toBeHidden();
  // Mark a previous sign-in (what the gate stores after a real sign-in)…
  await page.evaluate(() => localStorage.setItem("fire-counsel-auth-gate-v2", "synthetic-student"));
  await page.reload();
  // …and the local study tools open without a network.
  await expect(page.locator("#auth-gate")).toBeHidden();
  await expect(page.locator("#main-content")).toBeVisible();
});
