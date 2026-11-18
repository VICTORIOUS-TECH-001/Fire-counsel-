import { getFirebaseAuth } from "../config/firebaseAdmin.js";

// These codes mean the server's own key failed (deleted/disabled key, wrong
// account, no permission), not that the user's sign-in token is bad.
const SERVER_CREDENTIAL_CODES = new Set(["auth/insufficient-permission", "auth/internal-error", "auth/invalid-credential", "auth/project-not-found"]);
function isServerCredentialError(error) {
  const code = String(error?.code || "");
  return code.startsWith("app/") || SERVER_CREDENTIAL_CODES.has(code);
}

export function createFirebaseTokenVerifier(authProvider = getFirebaseAuth) {
  return async function verifyFirebaseToken(req, res, next) {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);

    if (!match) {
      return res.status(401).json({
        error: "Authentication required. Supply a Firebase ID token as a Bearer token."
      });
    }

    let auth;
    try {
      auth = authProvider();
    } catch (error) {
      console.error("Firebase authentication is not configured:", error.reason || error.message);
      return res.status(503).json({
        error: "Authentication service is unavailable. The server's Firebase Admin key (FIREBASE_SERVICE_ACCOUNT_JSON) is not usable; /api/health shows why.",
        code: "FIREBASE_ADMIN_NOT_READY",
        ...(error.reason ? { reason: error.reason } : {})
      });
    }

    try {
      // Revocation checking keeps disabled/revoked accounts from continuing to
      // use protected routes with an otherwise unexpired ID token.
      const decodedToken = await auth.verifyIdToken(match[1], true);
      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email ?? null,
        name: decodedToken.name ?? null,
        emailVerified: decodedToken.email_verified === true,
        authTime: Number.isInteger(decodedToken.auth_time) ? decodedToken.auth_time : null,
        // Custom claims are trusted only after Firebase Admin verifies the token.
        admin: decodedToken.admin === true
      };
      return next();
    } catch (error) {
      console.error("Firebase token verification failed:", error?.code || "", error?.message);
      if (isServerCredentialError(error)) {
        return res.status(503).json({
          error: "Google rejected the server's Firebase Admin key. Create a new key in Firebase (Service accounts) and paste it into FIREBASE_SERVICE_ACCOUNT_JSON on Render.",
          code: "FIREBASE_ADMIN_KEY_REJECTED"
        });
      }
      return res.status(401).json({ error: "Invalid, expired, revoked, or disabled authentication token." });
    }
  };
}

export const verifyFirebaseToken = createFirebaseTokenVerifier();
