import { getPool } from "../config/database.js";
import { installationHash, readBoundStudent, requireProfileSetup, studentAccountError, StudentAccountError } from "../services/studentAccounts.js";

// Applied after Firebase verification on every student materials/search route.
// There is no role/body/header escape hatch and no automatic device re-binding.
export function createStudentInstallationGate({
  poolProvider = getPool,
  configured = () => Boolean(process.env.DATABASE_URL),
  enabled = () => process.env.STUDENT_PROFILES_ENABLED === "true"
} = {}) {
  return async function requireStudentInstallation(req, res, next) {
    try {
      if (!req.user?.uid) throw new StudentAccountError(401, "Authentication required.", "AUTHENTICATION_REQUIRED");
      requireProfileSetup(configured, enabled);
      const hash = installationHash(req);
      await readBoundStudent(poolProvider(), req.user.uid, hash);
      if (!req.user.emailVerified) throw new StudentAccountError(403, "Verify your email and refresh your Firebase session before accessing protected student content.", "EMAIL_VERIFICATION_REQUIRED");
      next();
    } catch (error) {
      return studentAccountError(res, error);
    }
  };
}
