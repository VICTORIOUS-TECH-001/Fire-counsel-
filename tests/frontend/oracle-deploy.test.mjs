import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { parseSecrets, firebaseJson, buildEnv, cleanValue } from "../../deploy/oracle/make-env.mjs";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const dotenv = createRequire(resolve(root, "backend/package.json"))("dotenv");
const key = { type: "service_account", project_id: "fire-counsel", private_key_id: "abc", private_key: "-----BEGIN PRIVATE KEY-----\nMIIsynthetic\n-----END PRIVATE KEY-----\n", client_email: "firebase-adminsdk@fire-counsel.iam.gserviceaccount.com" };

test("Oracle deployment scripts are valid bash and the paste-in template holds no secrets", () => {
  for (const file of ["deploy/oracle/setup.sh", "deploy/oracle/update.sh", "deploy/oracle/oracle-start.sh"]) {
    const result = spawnSync("bash", ["-n", resolve(root, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
  const template = read("deploy/oracle/oracle-start.sh");
  for (const name of ["ADMIN_EMAILS", "DATABASE_URL", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "SERPAPI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY"]) assert.match(template, new RegExp(`^${name}=$`, "m"), `${name} is left blank`);
  assert.doesNotMatch(template, /AIza|sk-or-|postgres(ql)?:\/\/|BEGIN PRIVATE KEY/);
  assert.match(template, /<<'FIRE_COUNSEL_SETTINGS'/, "quoted heredoc: pasted values are never expanded by the shell");
  assert.match(template, /raw\.githubusercontent\.com\/VICTORIOUS-TECH-001\/Fire-counsel-\/main\/deploy\/oracle\/setup\.sh/);
  const setup = read("deploy/oracle/setup.sh");
  assert.match(setup, /sha256sum -c/, "Node.js download is checksum-verified");
  assert.match(setup, /shred -u/, "pasted copies are removed after use");
  assert.match(setup, /reverse_proxy 127\.0\.0\.1:4000/);
});

test("pasted settings forgive quotes and a psql prefix but reject broken values", () => {
  const values = parseSecrets(`# comment\nADMIN_EMAILS= Me@Gmail.com , other@example.org \nDATABASE_URL=psql 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'\nGEMINI_API_KEY="AIzaSyntheticKey"\nOPENROUTER_API_KEY=\n`);
  assert.equal(values.ADMIN_EMAILS, "Me@Gmail.com,other@example.org");
  assert.equal(values.DATABASE_URL, "postgresql://u:p@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require");
  assert.equal(values.GEMINI_API_KEY, "AIzaSyntheticKey");
  assert.equal(values.OPENROUTER_API_KEY, "");
  assert.throws(() => parseSecrets("DATABASE_URL=https://example.com"), /postgresql:\/\//);
  assert.throws(() => parseSecrets("ADMIN_EMAILS=not-an-email"), /email/);
  assert.throws(() => parseSecrets("NODE_OPTIONS=--require /tmp/x"), /Unknown setting/);
  assert.throws(() => parseSecrets("GEMINI_API_KEY=a'b"), /' character/);
  assert.equal(cleanValue("GEMINI_API_KEY", "PASTE_KEY_HERE"), "");
});

test("the Firebase key file is accepted as downloaded and checked against the project", () => {
  assert.equal(firebaseJson("PASTE THE WHOLE FIREBASE KEY FILE HERE (replace this line)"), "");
  const line = firebaseJson(JSON.stringify(key, null, 2));
  assert.ok(!line.includes("\n"), "stored on one line");
  assert.deepEqual(JSON.parse(line), key);
  assert.throws(() => firebaseJson(JSON.stringify({ ...key, project_id: "other-project" })), /other-project/);
  assert.throws(() => firebaseJson("{ not json"), /not valid JSON/);
  assert.throws(() => firebaseJson(JSON.stringify({ hello: "world" })), /service-account/);
});

test("the generated settings file is read correctly by the server's dotenv loader", () => {
  const secrets = parseSecrets("ADMIN_EMAILS=me@gmail.com\nDATABASE_URL=postgresql://u:p@host.neon.tech/db?sslmode=require&x=1\nGEMINI_API_KEY=AIzaSynthetic\n");
  const { text, missing } = buildEnv({ secrets, firebase: firebaseJson(JSON.stringify(key, null, 2)), host: "129-1-2-3.sslip.io" });
  assert.deepEqual(missing, []);
  const parsed = dotenv.parse(text);
  assert.equal(parsed.DATABASE_URL, "postgresql://u:p@host.neon.tech/db?sslmode=require&x=1");
  assert.equal(parsed.CORS_ORIGINS, "https://129-1-2-3.sslip.io");
  assert.equal(parsed.BIND_ADDRESS, "127.0.0.1");
  assert.equal(parsed.TRUSTED_PROXY_CIDRS, "127.0.0.1");
  assert.equal(JSON.parse(parsed.FIREBASE_SERVICE_ACCOUNT_JSON).private_key, key.private_key, "private key newlines survive");
  assert.equal(parsed.OPENROUTER_API_KEY, undefined);
});

test("re-running setup keeps earlier settings, reports what is missing, and the CLI writes a private file", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-env-"));
  try {
    const out = join(dir, "app.env");
    writeFileSync(join(dir, "secrets"), read("deploy/oracle/oracle-start.sh").split("<<'FIRE_COUNSEL_SETTINGS'\n")[1].split("FIRE_COUNSEL_SETTINGS")[0]);
    writeFileSync(join(dir, "firebase.json"), "PASTE THE WHOLE FIREBASE KEY FILE HERE (replace this line, keep the lines above and below)\n");
    const cli = (extra = []) => spawnSync(process.execPath, [resolve(root, "deploy/oracle/make-env.mjs"), "--secrets", join(dir, "secrets"), "--firebase", join(dir, "firebase.json"), "--previous", out, "--host", "129-1-2-3.sslip.io", "--out", out, ...extra], { encoding: "utf8" });
    let result = cli();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PUBLIC_HOST=129-1-2-3\.sslip\.io/);
    assert.match(result.stdout, /MISSING=DATABASE_URL, ADMIN_EMAILS, AI writer key \(GROQ_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY\), FIREBASE key file/);
    writeFileSync(join(dir, "secrets"), "ADMIN_EMAILS=me@gmail.com\nDATABASE_URL=postgresql://u:p@h.neon.tech/db\nGEMINI_API_KEY=AIzaSynthetic\nFC_DOMAIN=study.example.com\n");
    writeFileSync(join(dir, "firebase.json"), JSON.stringify(key, null, 2));
    result = cli();
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /MISSING/);
    assert.match(result.stdout, /PUBLIC_HOST=study\.example\.com/);
    // Second run with nothing new pasted keeps everything.
    writeFileSync(join(dir, "secrets"), "");
    rmSync(join(dir, "firebase.json"));
    result = cli();
    assert.equal(result.status, 0, result.stderr);
    const parsed = dotenv.parse(readFileSync(out, "utf8"));
    assert.equal(parsed.GEMINI_API_KEY, "AIzaSynthetic");
    assert.equal(parsed.CORS_ORIGINS, "https://study.example.com");
    assert.ok(parsed.FIREBASE_SERVICE_ACCOUNT_JSON);
    writeFileSync(join(dir, "secrets"), "DATABASE_URL=mysql://nope\n");
    result = cli();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /SETTINGS ERROR: DATABASE_URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Oracle settings keep new admin AI resources independent from the student key", () => {
  const secrets = parseSecrets("GEMINI_API_KEY=student-key\nADMIN_GEMINI_API_KEY=admin-key\nADMIN_GEMINI_MODEL=admin-model\nADMIN_CLOUDFLARE_ACCOUNT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nADMIN_CLOUDFLARE_API_TOKEN=admin-cf-token\nADMIN_CLOUDFLARE_MODEL=@cf/meta/model\nADMIN_AI_TIMEOUT_MS=90000\n");
  const { text } = buildEnv({ secrets, host: "study.example.com" });
  const parsed = dotenv.parse(text);
  assert.equal(parsed.GEMINI_API_KEY, "student-key");
  assert.equal(parsed.ADMIN_GEMINI_API_KEY, "admin-key");
  assert.equal(parsed.ADMIN_CLOUDFLARE_API_TOKEN, "admin-cf-token");
  assert.equal(parsed.ADMIN_GEMINI_MODEL, "admin-model");
  assert.throws(() => parseSecrets("ADMIN_CLOUDFLARE_API_TOKEN=bad value"), /spaces/);
});

test("Oracle accepts its current multi-provider template and requires a student writer independently of admin keys", () => {
  for (const name of ["GROQ_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]) {
    const secrets = parseSecrets(`ADMIN_EMAILS=me@example.com\nDATABASE_URL=postgresql://u:p@h.neon.tech/db\n${name}=synthetic-writer\nTAVILY_API_KEY=synthetic-search\nBRAVE_SEARCH_API_KEY=synthetic-brave\nSERPAPI_API_KEY=synthetic-serpapi\nDEEPSEEK_MODELS=deepseek-flash\nAI_WRITER_PROVIDER_ORDER=groq,deepseek,gemini,openrouter\nWEB_SEARCH_PROVIDER_ORDER=tavily,brave,serpapi,gemini\nAI_TIMEOUT_MS=240000\nAI_WRITER_PROVIDER_TIMEOUT_MS=60000\nAI_RESEARCH_CACHE_MINUTES=0\n`);
    const { settings, missing } = buildEnv({ secrets, firebase: firebaseJson(JSON.stringify(key)), host: "study.example.com" });
    assert.deepEqual(missing, []);
    assert.equal(settings[name], "synthetic-writer");
    assert.equal(settings.TAVILY_API_KEY, "synthetic-search");
    assert.equal(settings.AI_RESEARCH_CACHE_MINUTES, "0");
    if (name !== "GEMINI_API_KEY") assert.equal(settings.GEMINI_API_KEY, undefined);
  }
  const { missing } = buildEnv({ secrets: { ADMIN_GEMINI_API_KEY: "admin-only", ADMIN_CLOUDFLARE_API_TOKEN: "admin-cf-only" }, host: "study.example.com" });
  assert.ok(missing.some(value => value.startsWith("AI writer key")), "admin document keys cannot configure student AI");
  assert.throws(() => parseSecrets("GROQ_API_KEY=bad value"), /spaces/);
});
