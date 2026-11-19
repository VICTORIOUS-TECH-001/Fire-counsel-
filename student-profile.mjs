import { INSTALLATION_POLICY } from "./installation.mjs";
import { createRequestScope } from "./request-scope.mjs";

const $ = selector => document.querySelector(selector);
const form = $("#student-profile-form");
const status = $("#student-profile-status");
const securityStatus = $("#profile-security-status");
const refreshButton = $("#profile-refresh");
const signOutButton = $("#profile-signout");
const consent = $("#accept-installation-policy");
const sessionScope = createRequestScope();
const profileScope = createRequestScope();
let authClient;
let currentUser = null;
let profile = null;
let state = "guest";
let profileBusy = false;
let securityBusy = false;

function setStatus(text, kind = "", code = "") {
  status.textContent = text;
  status.dataset.kind = kind;
  status.dataset.code = code;
}

function setSecurityStatus(text, kind = "") {
  securityStatus.textContent = text;
  securityStatus.dataset.kind = kind;
}

function initials(name) {
  return String(name || "FC").trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || "").join("").toLocaleUpperCase();
}

// Google supplies these basic identity fields through Firebase Auth. They are
// display-only: no Neon profile, installation binding or extra Google API call.
function googleDetails() {
  const google = currentUser?.providerData?.find(provider => provider.providerId === "google.com");
  const name = [google?.displayName, currentUser?.displayName]
    .find(value => typeof value === "string" && value.trim());
  return {
    name: name?.trim().replace(/\s+/g, " ").slice(0, 120) || "",
    email: currentUser?.email || google?.email || "",
    photos: [google?.photoURL, currentUser?.photoURL]
  };
}

function setPhoto(...candidates) {
  let source = null;
  for (const value of candidates) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname.endsWith(".googleusercontent.com")) {
        source = url.href;
        break;
      }
    } catch { /* keep initials instead of loading arbitrary URLs */ }
  }
  for (const id of ["profile-photo", "student-profile-photo"]) {
    const image = document.getElementById(id);
    if (image.getAttribute("src") === source) continue;
    image.hidden = true;
    if (source) image.src = source;
    else image.removeAttribute("src");
  }
}
for (const id of ["profile-photo", "student-profile-photo"]) {
  const image = document.getElementById(id);
  image.addEventListener("load", () => { image.hidden = !image.getAttribute("src") || image.naturalWidth === 0; });
  image.addEventListener("error", () => { image.hidden = true; });
}

function renderAccountIdentity(saved = null) {
  const signedIn = Boolean(currentUser);
  const google = googleDetails();
  const name = saved?.full_name || google.name || "Student";
  $("#student-profile-title").textContent = signedIn ? name : "My student profile";
  $("#profile-display-email").textContent = signedIn ? saved?.email || google.email : "Sign in with Google to see your account.";
  $("#student-profile-name").textContent = signedIn ? name : "Student workspace";
  $("#profile-role").textContent = saved ? "Student profile · this browser" : signedIn ? "Signed in with Google" : "Local-first workspace";
  $("#profile-initials").textContent = signedIn ? initials(name) : "FC";
  $("#student-profile-avatar").textContent = signedIn ? initials(name) : "FC";
  $("#student-profile-link").setAttribute("aria-label", signedIn ? `Open profile for ${name}` : "Open your profile");
  $("#ws-signin").hidden = signedIn;
  for (const id of ["profile-welcome", "ws-account-welcome"]) {
    const greeting = document.getElementById(id);
    greeting.textContent = signedIn ? `Welcome, ${name}!` : "";
    greeting.hidden = !signedIn;
  }
  setPhoto(...(signedIn ? [saved?.photo_url, ...google.photos] : []));
}

function clearPasswords() {
  for (const input of document.querySelectorAll("#profile-security input[type=password]")) input.value = "";
}

function clearProfileDisplay() {
  profile = null;
  form.hidden = true;
  $("#profile-security").hidden = true;
  $("#profile-device-details").hidden = true;
  renderAccountIdentity();
  $("#student-full-name").value = "";
  $("#student-email").value = "";
  for (const id of ["profile-bound-at", "profile-last-seen", "profile-observed-ip", "profile-ip-source"]) $(`#${id}`).textContent = "—";
}

function updateControls() {
  const canEdit = state === "ready" || state === "create";
  const passwordAccount = authClient?.hasPasswordProvider(currentUser) === true;
  form.hidden = !canEdit;
  for (const input of form.elements) input.disabled = !canEdit || profileBusy || securityBusy;
  $("#profile-installation-consent").hidden = state !== "create";
  consent.disabled = state !== "create" || profileBusy || securityBusy;
  consent.required = state === "create";
  $("#profile-save").disabled = !canEdit || profileBusy || securityBusy || (state === "create" && !consent.checked);
  $("#profile-save").textContent = state === "create" ? "Create my student profile" : "Save profile";
  $("#profile-signin").hidden = Boolean(currentUser);
  refreshButton.hidden = !currentUser;
  refreshButton.disabled = !currentUser || profileBusy || securityBusy;
  signOutButton.hidden = !currentUser;
  $("#profile-security").hidden = state !== "ready";
  $("#profile-password-form").hidden = !passwordAccount;
  $("#profile-google-password").hidden = passwordAccount;
  $("#profile-email-password-row").hidden = !passwordAccount;
  for (const input of document.querySelectorAll("#profile-security input, #profile-security button")) {
    input.disabled = state !== "ready" || profileBusy || securityBusy || (!passwordAccount && input.closest("#profile-password-form")) || (!passwordAccount && input.id === "profile-email-password");
  }
  $("#profile-verification").hidden = profile?.email_verified !== false;
}

function formatDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unavailable";
}

function renderProfile(data) {
  if (!data || typeof data.full_name !== "string" || typeof data.email !== "string" || data.installation?.registered !== true) throw new Error("The profile API returned an incomplete profile.");
  profile = data;
  state = "ready";
  $("#student-full-name").value = data.full_name;
  $("#student-email").value = data.email;
  renderAccountIdentity(data);
  $("#profile-device-details").hidden = false;
  $("#profile-bound-at").textContent = formatDate(data.installation.bound_at);
  $("#profile-last-seen").textContent = formatDate(data.installation.last_seen_at);
  $("#profile-observed-ip").textContent = data.installation.observed_ip || "Unavailable — no address is guessed";
  $("#profile-ip-source").textContent = ({
    connection_peer: "Connection peer — may be an intermediary proxy, not your public IP",
    trusted_proxy: "Explicitly trusted proxy chain — may still include an upstream gateway",
    unavailable: "Unavailable"
  })[data.installation.ip_source] || "Unavailable";
  consent.checked = false;
}

function renderSetup() {
  state = "create";
  const google = googleDetails();
  $("#student-full-name").value = google.name;
  $("#student-email").value = google.email;
  renderAccountIdentity();
  setStatus("Your Firebase account is signed in. Confirm the details supplied by Google, then accept the installation policy to create your student profile. No course or payment is involved.");
}

async function readBody(response) {
  try { return await response.json(); } catch { return {}; }
}

function apiError(body, response) {
  return Object.assign(new Error(body.error || `Student profiles are unavailable (${response.status}).`), { code: body.code || "PROFILE_UNAVAILABLE" });
}

function notifyProfileReady() {
  window.dispatchEvent(new CustomEvent("fire-counsel-profile-ready", { detail: { uid: currentUser.uid } }));
}

async function loadProfile({ refresh = false, sync = false } = {}) {
  if (!currentUser || !authClient) return;
  const isCurrent = profileScope.begin();
  profileBusy = true;
  state = "loading";
  clearProfileDisplay();
  updateControls();
  setStatus(refresh ? "Refreshing your Firebase account and server profile…" : "Checking your profile and registered browser installation…");
  try {
    if (refresh) await authClient.refreshAccount();
    if (!isCurrent()) return;
    renderAccountIdentity();
    const response = await authClient.apiRequest("/api/v1/profile", sync ? {
      method: "POST", body: JSON.stringify({ installation_policy: INSTALLATION_POLICY })
    } : {});
    const body = await readBody(response);
    if (!isCurrent()) return;
    if (response.status === 404 && body.code === "PROFILE_NOT_CREATED") { renderSetup(); return; }
    if (!response.ok) throw apiError(body, response);
    renderProfile(body.data);
    setStatus("Your student profile is ready on this browser. You can edit it without enrolling in a course.", "ok");
    if (refresh) notifyProfileReady();
  } catch (error) {
    if (!isCurrent()) return;
    state = error.code === "STUDENT_PROFILES_DISABLED" ? "account" : "error";
    clearProfileDisplay();
    if (state === "account") {
      setStatus("You are signed in with Google. Your name, email and available profile photo are supplied by your Google account.", "ok", error.code);
    } else {
      setStatus(`${error.message || "Your saved student profile could not be loaded."} Your browser-local study data is unaffected.`, "error", error.code);
    }
  } finally {
    if (isCurrent()) { profileBusy = false; updateControls(); }
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!currentUser || !authClient || profileBusy || securityBusy || !["ready", "create"].includes(state)) return;
  const create = state === "create";
  if (create && !consent.checked) return;
  const payload = { full_name: $("#student-full-name").value.trim(), ...(create ? { installation_policy: INSTALLATION_POLICY } : {}) };
  const isCurrent = profileScope.begin();
  profileBusy = true;
  updateControls();
  setStatus(create ? "Creating your student profile and registering this browser…" : "Saving your profile…");
  try {
    const response = await authClient.apiRequest("/api/v1/profile", { method: create ? "POST" : "PATCH", body: JSON.stringify(payload) });
    const body = await readBody(response);
    if (!isCurrent()) return;
    if (!response.ok) throw apiError(body, response);
    renderProfile(body.data);
    setStatus(create ? "Your student profile is created. No courses, plans or permissions were added." : "Your profile has been saved.", "ok");
    notifyProfileReady();
  } catch (error) {
    if (!isCurrent()) return;
    if (["INSTALLATION_MISMATCH", "STUDENT_ACCOUNT_DISABLED"].includes(error.code)) { state = "error"; clearProfileDisplay(); }
    setStatus(error.message || "Your profile could not be saved.", "error", error.code);
  } finally {
    if (isCurrent()) { profileBusy = false; updateControls(); }
  }
});
consent.addEventListener("change", updateControls);
refreshButton.addEventListener("click", () => loadProfile({ refresh: true, sync: state === "ready" }));

function securityErrorText(error) {
  if (["auth/invalid-credential", "auth/wrong-password"].includes(error?.code)) return "Your current Firebase password was not accepted.";
  if (error?.code === "auth/requires-recent-login") return "Sign out and sign in again on this browser before changing account security.";
  if (["auth/weak-password", "auth/password-does-not-meet-requirements"].includes(error?.code)) return "Choose a stronger password that meets the Firebase project's password policy.";
  if (["auth/popup-blocked", "auth/popup-closed-by-user"].includes(error?.code)) return "Allow the Google confirmation popup and try again.";
  if (error?.code === "auth/user-mismatch") return "Confirm the same Google account that is currently signed in.";
  if (error?.code === "auth/email-already-in-use") return "That email cannot be used for this Firebase account. No profiles were merged.";
  if (error?.code === "auth/too-many-requests") return "Too many attempts. Wait before requesting another Firebase action.";
  return error?.message || "Firebase could not complete this account change.";
}

async function securityAction(action, success) {
  if (state !== "ready" || !currentUser || profileBusy || securityBusy) return;
  const isCurrent = sessionScope.capture();
  securityBusy = true;
  updateControls();
  setSecurityStatus("Confirming this action securely with Firebase…");
  try {
    // Check the application binding again before exposing a credential action.
    // Firebase itself is still the credential authority, not a device-lock API.
    const response = await authClient.apiRequest("/api/v1/profile");
    const body = await readBody(response);
    if (!isCurrent()) return;
    if (!response.ok) throw apiError(body, response);
    await action();
    if (isCurrent()) setSecurityStatus(success, "ok");
  } catch (error) {
    if (!isCurrent()) return;
    if (["INSTALLATION_MISMATCH", "STUDENT_ACCOUNT_DISABLED"].includes(error.code)) { state = "error"; clearProfileDisplay(); }
    setSecurityStatus(securityErrorText(error), "error");
    if (state === "error") setStatus(error.message, "error", error.code);
  } finally {
    if (isCurrent()) { securityBusy = false; updateControls(); }
  }
}

$("#profile-email-form").addEventListener("submit", event => {
  event.preventDefault();
  const email = $("#profile-new-email").value.trim();
  const password = $("#profile-email-password").value;
  clearPasswords();
  securityAction(() => authClient.requestAccountEmailChange(email, password), "Firebase sent a verification link to the new email. Complete it, then select Refresh account to sync the verified address. Your linked Google account is unchanged.");
});
$("#profile-password-form").addEventListener("submit", event => {
  event.preventDefault();
  const currentPassword = $("#profile-current-password").value;
  const password = $("#profile-new-password").value;
  const confirm = $("#profile-confirm-password").value;
  clearPasswords();
  if (password !== confirm) { setSecurityStatus("Your new passwords do not match.", "error"); return; }
  securityAction(() => authClient.changeAccountPassword(currentPassword, password), "Firebase updated your password. It was not sent to Neon or stored in your profile.");
});
$("#profile-send-verification").addEventListener("click", () => securityAction(
  () => authClient.requestAccountVerification(), "Firebase sent a verification email. Follow its link, then select Refresh account."
));
signOutButton.addEventListener("click", async () => {
  if (!authClient) return;
  signOutButton.disabled = true;
  try { await authClient.signOut(authClient.firebaseAuth); }
  catch (error) { setStatus(securityErrorText(error), "error"); }
  finally { signOutButton.disabled = false; }
});

async function accountChanged(user) {
  const isCurrent = sessionScope.begin();
  profileScope.invalidate();
  currentUser = null;
  state = "guest";
  profileBusy = false;
  securityBusy = false;
  clearPasswords();
  $("#profile-new-email").value = "";
  consent.checked = false;
  clearProfileDisplay();
  setSecurityStatus("");
  updateControls();
  if (!user) {
    setStatus("Sign in with Google to see your name, email and profile photo. Your saved local study data is unaffected by signing out.");
    return;
  }
  setStatus("Checking your Google account…");
  try {
    const googleSession = await authClient.hasGoogleSession(user);
    if (!isCurrent()) return;
    if (!googleSession) { setStatus("Sign in with Google again to see your account.", "error"); return; }
    currentUser = user;
    clearProfileDisplay();
    updateControls();
    loadProfile();
  } catch {
    if (isCurrent()) setStatus("Your Google session could not be verified. Connect and sign in again to see your account.", "error");
  }
}

try {
  authClient = await import("./firebase/auth-client.mjs");
  authClient.onAuthStateChanged(authClient.firebaseAuth, accountChanged, () => {
    accountChanged(null);
    setStatus("Firebase Auth could not verify this session. Reload or sign in again.", "error");
  });
} catch (error) {
  accountChanged(null);
  setStatus("Firebase client configuration is not available. Your local study data is unchanged; account and profile creation need the reviewed Firebase and Neon staging setup.", "error");
  console.warn("Student profiles unavailable:", error.message);
}
