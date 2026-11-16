import express from "express";
import { getPool } from "../config/database.js";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken.js";
import {
  firebaseProfileIdentity, installationHash, observedAddress, profileResponse,
  readBoundStudent, requireProfileSetup, studentAccountError, StudentAccountError,
  validateProfileName, writeStudentProfile, INSTALLATION_POLICY
} from "../services/studentAccounts.js";

function profileInput(body, create) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "full_name" && !(create && key === "installation_policy"))) {
    throw new StudentAccountError(400, "Only full_name can be edited here. Email and passwords are managed by Firebase; IP and identity are server-controlled.", "VALIDATION_ERROR");
  }
  if (create && body.installation_policy !== INSTALLATION_POLICY) throw new StudentAccountError(400, "Accept the browser-installation policy before creating or syncing your profile.", "INSTALLATION_POLICY_REQUIRED");
  if (!create && !Object.hasOwn(body, "full_name")) throw new StudentAccountError(400, "Provide full_name to update your profile.", "VALIDATION_ERROR");
  return Object.hasOwn(body, "full_name") ? validateProfileName(body.full_name) : undefined;
}

export function createStudentProfileRouter({
  poolProvider = getPool, verifyToken = verifyFirebaseToken,
  identityProvider = firebaseProfileIdentity,
  configured = () => Boolean(process.env.DATABASE_URL),
  enabled = () => process.env.STUDENT_PROFILES_ENABLED === "true"
} = {}) {
  async function verifiedIdentity(uid) {
    const identity = await identityProvider(uid);
    if (identity?.uid !== uid || typeof identity.email !== "string" || !identity.email || identity.email.length > 254) {
      throw new StudentAccountError(403, "A matching, email-backed Firebase account is required.", "EMAIL_ACCOUNT_REQUIRED");
    }
    return identity;
  }
  const router = express.Router();
  router.use(verifyToken);
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { requireProfileSetup(configured, enabled); next(); }
    catch (error) { studentAccountError(res, error); }
  });

  router.get("/", async (req, res) => {
    try {
      const account = await readBoundStudent(poolProvider(), req.user.uid, installationHash(req));
      const identity = await verifiedIdentity(req.user.uid);
      res.json({ data: profileResponse(account, identity) });
    } catch (error) { studentAccountError(res, error); }
  });

  for (const method of ["post", "patch"]) {
    router[method]("/", async (req, res) => {
      try {
        const name = profileInput(req.body, method === "post");
        const hash = installationHash(req);
        const identity = await verifiedIdentity(req.user.uid);
        const result = await writeStudentProfile(poolProvider(), {
          user: req.user, identity, hash, name, address: observedAddress(req), create: method === "post"
        });
        res.status(result.created ? 201 : 200).json({ data: profileResponse(result.account, identity) });
      } catch (error) { studentAccountError(res, error); }
    });
  }
  return router;
}
