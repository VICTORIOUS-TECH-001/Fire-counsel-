import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getFirebaseAuth } from "../config/firebaseAdmin.js";

export const INSTALLATION_HEADER = "X-Fire-Counsel-Installation";
export const INSTALLATION_POLICY = "browser-installation-v1";

export class StudentAccountError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireProfileSetup(configured, enabled) {
  if (!configured()) throw new StudentAccountError(503, "Neon is not configured on this server.", "DATABASE_NOT_CONFIGURED");
  if (!enabled()) throw new StudentAccountError(503, "Student profiles are not enabled. Review the staging schema and profile migration first.", "STUDENT_PROFILES_DISABLED");
}

export function installationHash(req) {
  const value = req.get(INSTALLATION_HEADER);
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new StudentAccountError(400, "A persistent browser installation identifier is required. Use the same browser and do not clear its saved data.", "INSTALLATION_REQUIRED");
  }
  // Per-user domain separation avoids using a shared installation to link users.
  return createHash("sha256").update(`${req.user.uid}\0${value}`).digest("hex");
}

export function observedAddress(req) {
  // Express derives req.ip using the explicitly configured trusted proxy list.
  // Never read an IP from JSON, a device token, or an arbitrary custom header.
  let address = req.ip || req.socket?.remoteAddress || "";
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) address = address.slice(7);
  return {
    ip: isIP(address) ? address : null,
    source: isIP(address) ? (req.ips?.length ? "trusted_proxy" : "connection_peer") : "unavailable"
  };
}

export function validateProfileName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new StudentAccountError(400, "Enter a name from 1 to 120 characters, without control characters.", "VALIDATION_ERROR");
  }
  return value.trim();
}

export async function firebaseProfileIdentity(uid) {
  const user = await getFirebaseAuth().getUser(uid);
  if (user.uid !== uid || user.disabled || !user.email) {
    throw new StudentAccountError(403, "An active Firebase account with an email address is required.", "EMAIL_ACCOUNT_REQUIRED");
  }
  return { uid: user.uid, email: user.email, name: user.displayName || "", emailVerified: user.emailVerified === true, photoUrl: user.photoURL || null };
}

export function safeGooglePhoto(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname.endsWith(".googleusercontent.com")) return url.href;
  } catch { /* initials are used instead */ }
  return null;
}

function assertActive(account) {
  if (account.account_status !== "active") throw new StudentAccountError(403, "This student account is not active. Signing in cannot reactivate it.", "STUDENT_ACCOUNT_DISABLED");
}

function assertBinding(account, hash) {
  if (!account.installation_hash) throw new StudentAccountError(404, "Create your student profile on this browser first.", "PROFILE_NOT_CREATED");
  if (!/^[0-9a-f]{64}$/.test(account.installation_hash)) throw new Error("Invalid stored installation binding.");
  if (!timingSafeEqual(Buffer.from(account.installation_hash, "hex"), Buffer.from(hash, "hex"))) {
    throw new StudentAccountError(403, "This account is registered to another browser installation. Use a separate account for a new installation; changing IP does not change this restriction.", "INSTALLATION_MISMATCH");
  }
}

export async function readBoundStudent(db, uid, hash) {
  const result = await db.query(
    `SELECT account.id, account.firebase_uid, account.email, account.full_name, account.account_status,
            binding.installation_hash, binding.bound_at, binding.last_seen_at,
            host(binding.last_observed_ip) AS observed_ip, binding.ip_source
     FROM app_users account
     LEFT JOIN student_account_installations binding ON binding.user_id = account.id
     WHERE account.firebase_uid = $1`, [uid]
  );
  const account = result.rows[0];
  if (!account) throw new StudentAccountError(404, "Create your student profile on this browser first.", "PROFILE_NOT_CREATED");
  assertActive(account);
  assertBinding(account, hash);
  return account;
}

export function profileResponse(account, identity) {
  // Explicit projection: never expose the installation hash, roles, passwords,
  // another user's profile, or any student study data.
  return {
    id: account.id,
    full_name: account.full_name,
    email: identity.email,
    email_verified: identity.emailVerified === true,
    photo_url: safeGooglePhoto(identity.photoUrl),
    installation: {
      policy: INSTALLATION_POLICY, registered: true, bound_at: account.bound_at,
      last_seen_at: account.last_seen_at, observed_ip: account.observed_ip || null,
      ip_source: account.ip_source
    }
  };
}

export async function writeStudentProfile(pool, { user, identity, hash, name, address, create = false, now = Date.now() }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = false;
    if (create) {
      const seed = name || String(identity.name || identity.email.split("@")[0]).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) || "Student";
      const result = await client.query(
        `INSERT INTO app_users (firebase_uid, email, full_name, account_status)
         VALUES ($1, $2, $3, 'active') ON CONFLICT (firebase_uid) DO NOTHING RETURNING id`,
        [user.uid, identity.email, seed]
      );
      inserted = result.rows.length > 0;
    }
    // Serializes first binding and all profile edits for this UID, including
    // concurrent requests from two different installations. No last-write wins.
    const locked = await client.query("SELECT id, account_status FROM app_users WHERE firebase_uid = $1 FOR UPDATE", [user.uid]);
    const row = locked.rows[0];
    if (!row) throw new StudentAccountError(404, "Create your student profile first.", "PROFILE_NOT_CREATED");
    assertActive(row);
    const existing = await client.query("SELECT installation_hash FROM student_account_installations WHERE user_id = $1", [row.id]);
    const binding = existing.rows[0];
    if (binding) {
      assertBinding(binding, hash);
    } else {
      if (!create) throw new StudentAccountError(404, "Create your student profile first.", "PROFILE_NOT_CREATED");
      if (!Number.isInteger(user.authTime) || user.authTime * 1000 < now - 5 * 60_000 || user.authTime * 1000 > now + 60_000) {
        throw new StudentAccountError(401, "Sign out and sign in again before registering this browser. A recent Firebase sign-in is required.", "RECENT_SIGN_IN_REQUIRED");
      }
      await client.query(
        `INSERT INTO student_account_installations (user_id, installation_hash, ip_source)
         VALUES ($1, $2, 'unavailable')`, [row.id, hash]
      );
    }
    // Email is obtained from Firebase Admin, never from the profile request body
    // or an old ID-token email. Existing edited names survive future Google logins.
    await client.query(
      `UPDATE app_users SET email = $2, full_name = COALESCE($3::text, full_name), updated_at = NOW()
       WHERE id = $1`, [row.id, identity.email, name || null]
    );
    await client.query(
      `UPDATE student_account_installations
       SET last_seen_at = NOW(), last_observed_ip = $2::inet, ip_source = $3 WHERE user_id = $1`,
      [row.id, address.ip, address.source]
    );
    const account = await readBoundStudent(client, user.uid, hash);
    await client.query("COMMIT");
    return { account, created: inserted || !binding };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export function studentAccountError(res, error) {
  if (error instanceof StudentAccountError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error?.code === "23505") return res.status(409).json({ error: "This Firebase identity conflicts with an existing profile. No accounts were linked or transferred.", code: "PROFILE_IDENTITY_CONFLICT" });
  if (["42P01", "42703"].includes(error?.code)) return res.status(503).json({ error: "The reviewed student-profile schema migration is not ready on this server.", code: "PROFILE_SCHEMA_NOT_READY" });
  console.error("Student profile service unavailable:", error?.code || error?.name || "unknown");
  return res.status(503).json({ error: "Student profiles are temporarily unavailable. Your local study data is unaffected.", code: "PROFILE_UNAVAILABLE" });
}
