// Turns the values pasted into oracle-start.sh into the server's private
// settings file (/etc/fire-counsel/app.env, read through DOTENV_CONFIG_PATH).
// It forgives common pasting mistakes (quotes, a leading "psql", spaces) and
// refuses anything that would break the file or the server.
//
//   node make-env.mjs --secrets FILE [--firebase FILE] [--previous FILE] --host HOST --out FILE
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from "node:fs";

const REQUIRED = ["DATABASE_URL", "GEMINI_API_KEY", "ADMIN_EMAILS"];
const OPTIONAL = ["ADMIN_GEMINI_API_KEY", "ADMIN_GEMINI_MODEL", "ADMIN_CLOUDFLARE_ACCOUNT_ID", "ADMIN_CLOUDFLARE_API_TOKEN", "ADMIN_CLOUDFLARE_MODEL", "ADMIN_AI_TIMEOUT_MS", "OPENROUTER_API_KEY", "FC_DOMAIN", "GEMINI_MODELS", "GEMINI_SEARCH_MODELS", "OPENROUTER_MODELS", "AI_TIMEZONE", "AI_MAX_CONCURRENT_JOBS"];
const ALLOWED = new Set([...REQUIRED, ...OPTIONAL, "FIREBASE_SERVICE_ACCOUNT_JSON"]);

export function cleanValue(key, raw) {
  let value = String(raw ?? "").trim();
  // psql 'postgresql://…' as copied from Neon's "psql" tab.
  if (key === "DATABASE_URL") value = value.replace(/^psql\s+/i, "").trim();
  if (/^(['"]).*\1$/s.test(value)) value = value.slice(1, -1).trim();
  if (/[\r\n]/.test(value)) throw new Error(`${key} must be on one line.`);
  if (value.includes("'")) throw new Error(`${key} must not contain a ' character.`);
  if (/^(paste|your|xxx|todo|change.?me)/i.test(value) || /^<.*>$/.test(value)) return "";
  if (!value) return "";
  if (key === "DATABASE_URL") {
    let url;
    try { url = new URL(value); } catch { throw new Error("DATABASE_URL is not a valid address. Copy the whole connection string from Neon."); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("DATABASE_URL must start with postgresql:// (copy it from Neon → Connect).");
  }
  if (key === "ADMIN_EMAILS") {
    const emails = value.split(",").map((email) => email.trim()).filter(Boolean);
    if (!emails.length || emails.some((email) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email))) throw new Error("ADMIN_EMAILS must be one or more email addresses separated by commas.");
    value = emails.join(",");
  }
  if (key === "FC_DOMAIN" && !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) throw new Error("FC_DOMAIN must be a plain domain name such as study.example.com.");
  if (/^(?:ADMIN_GEMINI_API_KEY|ADMIN_CLOUDFLARE_API_TOKEN|GEMINI_API_KEY|OPENROUTER_API_KEY)$/.test(key) && /\s/.test(value)) throw new Error(`${key} must not contain spaces.`);
  return value;
}

export function parseSecrets(text) {
  const values = {};
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Line ${index + 1} of the settings is not in NAME=value form.`);
    const [, key, raw] = match;
    if (!ALLOWED.has(key)) throw new Error(`Unknown setting ${key} on line ${index + 1}.`);
    values[key] = cleanValue(key, raw);
  }
  return values;
}

// The Firebase key file is pasted as-is (many lines). Store it on one line;
// "\n" inside the private key stays as the two characters JSON expects.
export function firebaseJson(text, projectId = "fire-counsel") {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || /^paste/i.test(trimmed)) return "";
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { throw new Error("The Firebase key is not valid JSON. Paste the whole downloaded .json file, from { to }."); }
  if (parsed.type !== "service_account" || !parsed.private_key || !parsed.client_email) throw new Error("That JSON is not a Firebase service-account key (Project settings → Service accounts → Generate new private key).");
  if (parsed.project_id !== projectId) throw new Error(`The Firebase key is for project "${parsed.project_id}", but this site uses "${projectId}". Download the key from the fire-counsel project.`);
  const line = JSON.stringify(parsed);
  if (line.includes("'")) throw new Error("The Firebase key contains an unexpected ' character.");
  return line;
}

function readEnvFile(path) {
  const values = {};
  if (!path || !existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)='(.*)'$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function buildEnv({ secrets = {}, firebase = "", previous = {}, host }) {
  const pick = (key) => secrets[key] || previous[key] || "";
  const domain = pick("FC_DOMAIN") || host;
  if (!domain) throw new Error("No web address: the public IP could not be found and FC_DOMAIN is empty.");
  const settings = {
    NODE_ENV: "staging",
    BIND_ADDRESS: "127.0.0.1",
    PORT: "4000",
    SERVE_WEBSITE: "true",
    FIREBASE_PROJECT_ID: "fire-counsel",
    STUDENT_PROFILES_ENABLED: "false",
    TRUSTED_PROXY_CIDRS: "127.0.0.1",
    CORS_ORIGINS: `https://${domain}`,
    AI_TIMEZONE: pick("AI_TIMEZONE") || "Africa/Lagos",
    PUBLIC_HOST: domain
  };
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    if (key === "AI_TIMEZONE" || key === "FC_DOMAIN") continue;
    const value = pick(key);
    if (value) settings[key] = value;
  }
  if (secrets.FC_DOMAIN || previous.FC_DOMAIN) settings.FC_DOMAIN = domain;
  const serviceAccount = firebase || secrets.FIREBASE_SERVICE_ACCOUNT_JSON || previous.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (serviceAccount) settings.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount;
  const missing = REQUIRED.filter((key) => !settings[key]);
  if (!settings.FIREBASE_SERVICE_ACCOUNT_JSON) missing.push("FIREBASE key file");
  const text = "# FIRE COUNSEL private settings. Written by deploy/oracle/setup.sh — keep secret.\n" +
    Object.entries(settings).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n";
  return { text, settings, missing };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = args(process.argv.slice(2));
    const secrets = opts.secrets && existsSync(opts.secrets) ? parseSecrets(readFileSync(opts.secrets, "utf8")) : {};
    const firebase = opts.firebase && existsSync(opts.firebase) ? firebaseJson(readFileSync(opts.firebase, "utf8")) : "";
    const { text, missing, settings } = buildEnv({ secrets, firebase, previous: readEnvFile(opts.previous), host: opts.host });
    const tmp = `${opts.out}.tmp`;
    writeFileSync(tmp, text, { mode: 0o640 });
    chmodSync(tmp, 0o640);
    renameSync(tmp, opts.out);
    console.log(`PUBLIC_HOST=${settings.PUBLIC_HOST}`);
    if (missing.length) console.log(`MISSING=${missing.join(", ")}`);
  } catch (error) {
    console.error(`SETTINGS ERROR: ${error.message}`);
    process.exit(2);
  }
}
