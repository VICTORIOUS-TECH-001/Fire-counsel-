import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA8dUZ2F2cMVVxN8j9DoplnOqDBaCi0-gg",
  authDomain: "fire-counsel.firebaseapp.com",
  projectId: "fire-counsel",
  storageBucket: "fire-counsel.firebasestorage.app",
  messagingSenderId: "754484132934",
  appId: "1:754484132934:web:d39c2075187f754a195e47",
  measurementId: "G-8ETFZVZS7W"
};

let authInstance;

export async function initializeFirebase() {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  authInstance = getAuth(app);
  await setPersistence(authInstance, browserLocalPersistence);

  return {
    signIn: (email, password) => signInWithEmailAndPassword(authInstance, email, password),
    signUp: (email, password) => createUserWithEmailAndPassword(authInstance, email, password),
    signOut: () => firebaseSignOut(authInstance),
    onAuthStateChanged: callback => onAuthStateChanged(authInstance, callback),
    getIdToken: async () => {
      if (!authInstance.currentUser) throw new Error("Please sign in first.");
      return authInstance.currentUser.getIdToken();
    }
  };
}
