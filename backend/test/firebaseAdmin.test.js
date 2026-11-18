import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { firebaseAdminStatus, parseServiceAccount } from "../src/config/firebaseAdmin.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const account = { type: "service_account", project_id: "fire-counsel", private_key_id: "abc", private_key: pem, client_email: "firebase-adminsdk-x@fire-counsel.iam.gserviceaccount.com", client_id: "1" };
const json = JSON.stringify(account, null, 2);
const status = (value, projectId = "fire-counsel") => firebaseAdminStatus({ FIREBASE_SERVICE_ACCOUNT_JSON: value, FIREBASE_PROJECT_ID: projectId });

test("accepts the downloaded key file and common phone paste damage", () => {
  const variants = {
    exact: json,
    oneLine: JSON.stringify(account),
    quoted: `'${json}'`,
    doubleQuoted: `"${JSON.stringify(account)}"`,
    withName: `FIREBASE_SERVICE_ACCOUNT_JSON=${json}`,
    spaces: `\n  ${json}  \n`,
    // "\n" escapes turned into real line breaks inside the private_key string.
    realNewlines: json.replace(/\\n/g, "\n"),
    // private_key double-escaped (literal backslash-n characters).
    doubleEscaped: JSON.stringify({ ...account, private_key: pem.replace(/\n/g, "\\n") }),
    base64: Buffer.from(json).toString("base64")
  };
  for (const [name, value] of Object.entries(variants)) {
    assert.deepEqual(status(value), { ok: true }, name);
    assert.equal(parseServiceAccount(value).private_key.trim(), pem.trim(), name);
  }
  // FIREBASE_PROJECT_ID may be left out (taken from the key) or typed with quotes.
  assert.deepEqual(status(json, ""), { ok: true });
  assert.deepEqual(status(json, " \"fire-counsel\" "), { ok: true });
});

test("names the exact problem without ever echoing the key", () => {
  const cases = [
    ["", "missing_key"],
    ["const firebaseConfig = { apiKey: \"AIza-secret\", authDomain: \"fire-counsel.firebaseapp.com\" };", "web_config_not_admin_key"],
    [json.slice(0, 400), "key_cut_off"],
    ["hello world", "invalid_json"],
    [JSON.stringify({ project_id: "fire-counsel" }), "not_a_service_account"],
    [JSON.stringify({ ...account, client_email: "" }), "key_incomplete"],
    [JSON.stringify({ ...account, private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" }), "private_key_damaged"]
  ];
  for (const [value, code] of cases) {
    const result = status(value);
    assert.deepEqual(result, { ok: false, code }, code);
    assert.doesNotMatch(JSON.stringify(result), /AIza|PRIVATE KEY|gserviceaccount/);
  }
  assert.deepEqual(status(json, "another-project"), { ok: false, code: "project_mismatch" });
});
