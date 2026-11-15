import { getFirebaseAuth } from "../config/firebaseAdmin.js";

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
      console.error("Firebase authentication is not configured:", error.message);
      return res.status(503).json({ error: "Authentication service is unavailable." });
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
      console.error("Firebase token verification failed:", error.message);
      return res.status(401).json({ error: "Invalid, expired, revoked, or disabled authentication token." });
    }
  };
}

export const verifyFirebaseToken = createFirebaseTokenVerifier();
