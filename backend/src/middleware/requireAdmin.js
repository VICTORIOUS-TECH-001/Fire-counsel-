export function requireAdmin(req, res, next) {
  if (!req.user?.uid) {
    return res.status(401).json({ error: "Authentication required." });
  }

  // req.user is populated only by verifyFirebaseToken, which verifies the ID
  // token and custom claim with Firebase Admin. Never accept a client-supplied
  // role, email, query parameter, or request-body flag as admin authorization.
  if (req.user.admin !== true) {
    return res.status(403).json({ error: "Administrator permission required." });
  }

  return next();
}
