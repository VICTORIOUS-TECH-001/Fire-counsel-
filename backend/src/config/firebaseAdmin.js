import { createPrivateKey } from "node:crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const APP_NAME = "fire-counsel-api";
let firebaseAuth;
let firebaseFirestore;

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

// Invisible or "typographic" characters that phone keyboards and text viewers
// insert when copying. None of them can appear in a real key file.
function cleanCopiedText(value) {
  return String(value ?? "")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, "\"")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u2028\u2029]/g, "\n");
}

function unwrap(value) {
  let text = cleanCopiedText(value).trim();
  text = text.replace(/^(?:export\s+)?FIREBASE_SERVICE_ACCOUNT_JSON\s*=\s*/i, "").trim();
  for (let i = 0; i < 2; i += 1) {
    const first = text[0];
    if (text.length > 1 && (first === "\"" || first === "'" || first === "`") && text.at(-1) === first) text = text.slice(1, -1).trim();
  }
  if (text && !text.includes("{") && /^[A-Za-z0-9+/=_\s-]+$/.test(text)) {
    // Some hosts suggest storing the file base64-encoded; accept that too.
    const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8").trim();
    if (decoded.startsWith("{")) text = decoded;
  }
  // Drop anything copied around the file itself (viewer labels, ``` fences).
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open > 0 && close > open) text = text.slice(open, close + 1);
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
      if (ch === "\t") { out += "\\t"; continue; }
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

const PEM_PATTERN = /-----BEGIN(RSA)?PRIVATEKEY-----([A-Za-z0-9+/=]+)-----END\1PRIVATEKEY-----/;

// Rebuilds the PEM block even if line breaks were lost, doubled, escaped or
// inserted at random (long-line wrapping in phone viewers).
function findPrivateKey(text) {
  // Whitespace first: a wrapped line can split a "\n" escape into "\" + break + "n".
  const compact = String(text ?? "").replace(/\s+/g, "").replace(/\\[nr]/g, "");
  const match = compact.match(PEM_PATTERN);
  if (!match) return null;
  const label = match[1] ? "RSA PRIVATE KEY" : "PRIVATE KEY";
  const body = match[2].match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function findField(text, name) {
  const compact = text.replace(/\s+/g, "").replace(/\\[nr]/g, "");
  const match = compact.match(new RegExp(`"${name}":"([^"]+)"`));
  return match ? match[1] : null;
}

// Last resort when the JSON itself is broken: the Admin SDK only needs these
// three values, so pull them out of whatever was pasted.
function salvageAccount(text) {
  const projectId = findField(text, "project_id");
  const clientEmail = findField(text, "client_email");
  const privateKey = findPrivateKey(text);
  if (!projectId || !clientEmail || !privateKey) return null;
  return { type: "service_account", project_id: projectId, client_email: clientEmail, private_key: privateKey };
}

export function parseServiceAccount(raw) {
  const text = unwrap(raw);
  if (!text) throw adminError("missing_key");
  if (/\bapiKey\b/.test(text) && /\bauthDomain\b/.test(text) && !/PRIVATE\s*KEY/.test(text)) throw adminError("web_config_not_admin_key");
  let account = parseJson(text);
  if (account === undefined) {
    account = salvageAccount(text);
    if (!account) throw adminError(text.startsWith("{") && !text.endsWith("}") ? "key_cut_off" : "invalid_json");
  }
  if (!account || typeof account !== "object" || Array.isArray(account) || account.type !== "service_account") throw adminError("not_a_service_account");
  for (const field of ["project_id", "client_email", "private_key"]) {
    if (typeof account[field] !== "string" || !account[field].trim()) throw adminError("key_incomplete");
  }
  let privateKey = account.private_key.replace(/\r/g, "");
  // Double-escaped keys arrive with literal backslash-n instead of line breaks.
  if (!privateKey.includes("\n") && privateKey.includes("\\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  try { createPrivateKey(privateKey); } catch {
    const rebuilt = findPrivateKey(privateKey);
    try { if (!rebuilt) throw new Error(); createPrivateKey(rebuilt); privateKey = rebuilt; } catch { throw adminError("private_key_damaged"); }
  }
  return {
    ...account,
    project_id: account.project_id.replace(/\s+/g, ""),
    client_email: account.client_email.replace(/\s+/g, ""),
    private_key: privateKey
  };
}

// Yes/no facts about what was pasted, to tell a bad copy apart from a wrong
// file. Never includes any part of the key itself.
export function describePastedKey(raw) {
  const text = unwrap(raw);
  return {
    characters: text.length,
    starts_with_brace: text.startsWith("{"),
    ends_with_brace: text.endsWith("}"),
    found_project_id: Boolean(findField(text, "project_id")),
    found_client_email: Boolean(findField(text, "client_email")),
    found_private_key: Boolean(findPrivateKey(text))
  };
}

function configuredProjectId(env, account) {
  const fromEnv = unwrap(env.FIREBASE_PROJECT_ID).replace(/\s+/g, "");
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

// Same explicit service account and checked project as token verification;
// never select a project or document path from browser-controlled input.
export function getFirebaseFirestore() {
  if (!firebaseFirestore) firebaseFirestore = getFirestore(getFirebaseAdminApp());
  return firebaseFirestore;
}
