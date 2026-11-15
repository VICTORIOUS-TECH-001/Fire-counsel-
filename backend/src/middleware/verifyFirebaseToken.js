import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

let firebaseAuth;

function getFirebaseAuth() {
  if (firebaseAuth) return firebaseAuth;

  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) {
    throw new Error("Firebase Admin credentials are not configured.");
  }

  const serviceAccount = JSON.parse(rawServiceAccount);

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: cert(serviceAccount) });

  firebaseAuth = getAuth(app);
  return firebaseAuth;
}

export async function verifyFirebaseToken(req, res, next) {
  const authorization = req.headers.authorization || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      error: "Authentication required. Supply a Firebase ID token as a Bearer token."
    });
  }

  try {
    const decodedToken = await getFirebaseAuth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email ?? null,
      emailVerified: decodedToken.email_verified ?? false
    };
    return next();
  } catch (error) {
    console.error("Firebase token verification failed:", error.message);
    return res.status(401).json({ error: "Invalid or expired authentication token." });
  }
}
