import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc
} from "firebase/firestore";
import {
  deleteObject,
  getBytes,
  ref,
  uploadBytes
} from "firebase/storage";

const PROJECT_ID = "demo-fire-counsel-rules";
const MAX_SLIDE_BYTES = 10 * 1024 * 1024;
const firestoreRules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
const storageRules = readFileSync(new URL("../storage.rules", import.meta.url), "utf8");
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: firestoreRules
    },
    storage: {
      host: "127.0.0.1",
      port: 9199,
      rules: storageRules
    }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "siteContent", "public"), { title: "Emulator fixture" });
    await setDoc(doc(db, "accounts", "test-student"), { plan: "synthetic" });
    await setDoc(doc(db, "aiQuotaPolicies", "default"), { active: false });
    await setDoc(doc(db, "aiEntitlements", "test-student"), { state: "synthetic" });
    await setDoc(doc(db, "aiUsage", "test-student_test-period"), { count: 0 });
    await setDoc(doc(db, "adminAudit", "test-event"), { reason: "emulator fixture" });
  });
});

test("Firestore allows public site-content reads but no client publishing", async () => {
  const anonymousDb = testEnv.unauthenticatedContext().firestore();
  const adminDb = testEnv.authenticatedContext("test-admin", { admin: true }).firestore();

  const publicContent = await assertSucceeds(getDoc(doc(anonymousDb, "siteContent", "public")));
  assert.equal(publicContent.exists(), true);
  await assertFails(setDoc(doc(adminDb, "siteContent", "public"), { title: "Client write" }));
});

test("Firestore restricts account and quota reads to the admin claim and denies client writes", async () => {
  const studentDb = testEnv.authenticatedContext("test-student").firestore();
  const adminDb = testEnv.authenticatedContext("test-admin", { admin: true }).firestore();

  await assertFails(getDoc(doc(studentDb, "accounts", "test-student")));
  await assertSucceeds(getDoc(doc(adminDb, "accounts", "test-student")));
  await assertSucceeds(getDoc(doc(adminDb, "aiQuotaPolicies", "default")));
  await assertSucceeds(getDoc(doc(adminDb, "aiEntitlements", "test-student")));
  await assertSucceeds(getDoc(doc(adminDb, "aiUsage", "test-student_test-period")));
  await assertSucceeds(getDoc(doc(adminDb, "adminAudit", "test-event")));

  await assertFails(setDoc(doc(adminDb, "accounts", "test-student"), { plan: "paid" }));
  await assertFails(setDoc(doc(adminDb, "aiQuotaPolicies", "default"), { active: true }));
  await assertFails(setDoc(doc(studentDb, "aiUsage", "test-student_test-period"), { count: 999 }));
});

test("Firestore denies unlisted collections to students and admins", async () => {
  const studentDb = testEnv.authenticatedContext("test-student").firestore();
  const adminDb = testEnv.authenticatedContext("test-admin", { admin: true }).firestore();

  await assertFails(getDoc(doc(studentDb, "unlistedCollection", "private")));
  await assertFails(getDoc(doc(adminDb, "unlistedCollection", "private")));
});

test("Storage allows public slide reads and admin-only valid image uploads", async () => {
  const path = `site/slides/rules-test-${randomUUID()}.png`;
  const adminStorage = testEnv.authenticatedContext("test-admin", { admin: true }).storage();
  const studentStorage = testEnv.authenticatedContext("test-student").storage();
  const anonymousStorage = testEnv.unauthenticatedContext().storage();
  const pngBytes = new Uint8Array([137, 80, 78, 71]);

  await assertFails(uploadBytes(ref(studentStorage, path), pngBytes, { contentType: "image/png" }));
  await assertFails(uploadBytes(ref(anonymousStorage, path), pngBytes, { contentType: "image/png" }));
  await assertSucceeds(uploadBytes(ref(adminStorage, path), pngBytes, { contentType: "image/png" }));

  const downloaded = await assertSucceeds(getBytes(ref(anonymousStorage, path)));
  assert.deepEqual([...downloaded], [...pngBytes]);
});

test("Storage rejects non-image types, oversized images, and non-slide paths", async () => {
  const adminStorage = testEnv.authenticatedContext("test-admin", { admin: true }).storage();
  const pngBytes = new Uint8Array([137, 80, 78, 71]);

  await assertFails(uploadBytes(
    ref(adminStorage, `site/slides/rules-test-${randomUUID()}.pdf`),
    pngBytes,
    { contentType: "application/pdf" }
  ));
  await assertFails(uploadBytes(
    ref(adminStorage, `site/slides/rules-test-${randomUUID()}.png`),
    new Uint8Array(MAX_SLIDE_BYTES + 1),
    { contentType: "image/png" }
  ));
  await assertFails(uploadBytes(
    ref(adminStorage, `private/rules-test-${randomUUID()}.png`),
    pngBytes,
    { contentType: "image/png" }
  ));
});

test("Storage permits deletion only by an admin custom claim", async () => {
  const path = `site/slides/rules-test-${randomUUID()}.png`;
  const studentStorage = testEnv.authenticatedContext("test-student").storage();
  const adminStorage = testEnv.authenticatedContext("test-admin", { admin: true }).storage();

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(ref(context.storage(), path), new Uint8Array([1, 2, 3]), { contentType: "image/png" });
  });

  await assertFails(deleteObject(ref(studentStorage, path)));
  await assertSucceeds(deleteObject(ref(adminStorage, path)));
  await assertFails(getBytes(ref(testEnv.unauthenticatedContext().storage(), path)));
});
