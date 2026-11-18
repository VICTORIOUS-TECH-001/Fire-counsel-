import { createPrivateKey } from "node:crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const APP_NAME = "fire-counsel-api";
let firebaseAuth;

// Secret-free reasons, shown on /api/health and in API errors so the owner can
// fix the Render setting without anyone seeing the key itself.
export const FIREBASE_ADMIN_ERRORS = Object.freeze({
  missing_key: "FIREBASE_SERVICE_ACCOUNT_JSON is empty.",
  web_config_not_admin_key: "This is the website config (apiKey, authDomain). Paste the downloaded service-account key file instead.",
  key_cut_off: "The key text is incomplete. Copy the whole file, from the first { to the last }.",
  invalid_json: "The key is not valid JSON. Paste the whole downloaded .json file without changes.",
  not_a_service_account: "This JSON is not a service-account key (\"type\": \"service_account\").",
  key_incomplete: "The key is missing project_id, client_email or private_key.",
  private_key_damaged: "The private_key inside the key is damaged. Download a new key and paste it again.",
  project_mismatch: "The key belongs to a different Firebase project than FIREBASE_PROJECT_ID."
});

function adminError(code) {
  return Object.assign(new Error(FIREBASE_ADMIN_ERRORS[code]), { code: `firebase-admin/${code}`, reason: code });
}

function unwrap(value) {
  let text = String(value ?? "").replace(/^\uFEFF/, "").trim();
  text = text.replace(/^(?:export\s+)?FIREBASE_SERVICE_ACCOUNT_JSON\s*=\s*/i, "").trim();
  for (let i = 0; i < 2; i += 1) {
    const first = text[0];
    if (text.length > 1 && (first === "\"" || first === "'" || first === "`") && text.at(-1) === first) text = text.slice(1, -1).trim();
  }
  if (text && !text.startsWith("{") && /^[A-Za-z0-9+/=_\s-]+$/.test(text)) {
    // Some hosts suggest storing the file base64-encoded; accept that too.
    const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8").trim();
    if (decoded.startsWith("{")) text = decoded;
  }
  return text;
}

// Phones often turn the "\n" escapes inside private_key into real line breaks,
// which JSON forbids inside strings. Re-escape only characters inside strings.
function escapeRawNewlinesInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === "\\") { escaped = true; out += ch; continue; }
      if (ch === "\"") { inString = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") continue;
      out += ch;
    } else {
      if (ch === "\"") inString = true;
      out += ch;
    }
  }
  return out;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { /* try the newline repair */ }
  try { return JSON.parse(escapeRawNewlinesInStrings(text)); } catch { return undefined; }
}

export function parseServiceAccount(raw) {
  const text = unwrap(raw);
  if (!text) throw adminError("missing_key");
  if (/\bapiKey\b/.test(text) && /\bauthDomain\b/.test(text)) throw adminError("web_config_not_admin_key");
  const account = parseJson(text);
  if (account === undefined) throw adminError(text.startsWith("{") && !text.endsWith("}") ? "key_cut_off" : "invalid_json");
  if (!account || typeof account !== "object" || Array.isArray(account) || account.type !== "service_account") throw adminError("not_a_service_account");
  for (const field of ["project_id", "client_email", "private_key"]) {
    if (typeof account[field] !== "string" || !account[field].trim()) throw adminError("key_incomplete");
  }
  let privateKey = account.private_key.replace(/\r/g, "");
  // Double-escaped keys arrive with literal backslash-n instead of line breaks.
  if (!privateKey.includes("\n") && privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  try { createPrivateKey(privateKey); } catch { throw adminError("private_key_damaged"); }
  return { ...account, project_id: account.project_id.trim(), client_email: account.client_email.trim(), private_key: privateKey };
}

function configuredProjectId(env, account) {
  const fromEnv = unwrap(env.FIREBASE_PROJECT_ID);
  return fromEnv || account.project_id;
}

// Checks the Render setting locally (no network, no secrets in the result).
export function firebaseAdminStatus(env = process.env) {
  try {
    const account = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (account.project_id !== configuredProjectId(env, account)) throw adminError("project_mismatch");
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.reason || "invalid_json" };
  }
}

function getFirebaseAdminApp() {
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const projectId = configuredProjectId(process.env, account);
  if (account.project_id !== projectId) throw adminError("project_mismatch");

  const existingApp = getApps().find((app) => app.name === APP_NAME);
  if (existingApp) return existingApp;

  return initializeApp({ credential: cert(account), projectId }, APP_NAME);
}

export function getFirebaseAuth() {
  if (!firebaseAuth) firebaseAuth = getAuth(getFirebaseAdminApp());
  return firebaseAuth;
}
