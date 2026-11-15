import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const APP_NAME = "fire-counsel-api";
let firebaseAuth;

function getFirebaseAdminApp() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is not configured.");
  if (!rawServiceAccount) throw new Error("Firebase Admin credentials are not configured.");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  if (serviceAccount.project_id !== projectId) {
    throw new Error("Firebase service account does not match FIREBASE_PROJECT_ID.");
  }

  const existingApp = getApps().find((app) => app.name === APP_NAME);
  if (existingApp) return existingApp;

  return initializeApp({
    credential: cert(serviceAccount),
    projectId
  }, APP_NAME);
}

export function getFirebaseAuth() {
  if (!firebaseAuth) firebaseAuth = getAuth(getFirebaseAdminApp());
  return firebaseAuth;
}
