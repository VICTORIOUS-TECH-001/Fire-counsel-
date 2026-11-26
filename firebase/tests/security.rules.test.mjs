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
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc
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

// All accepted application sessions originate with Google, including admins.
function googleContext(uid, claims = {}) {
  return testEnv.authenticatedContext(uid, { ...claims, firebase: { sign_in_provider: "google.com" } });
}

// Canonical public-page fixture. Only the protected API may persist it;
// browser writes are denied independently of payload shape or admin claims.
function validSiteContent(uid) {
  return {
    brand: { name: "FIRE COUNSEL", tagline: "Ignite your legal intelligence", markImage: "./assets/images/fire-counsel-flame.png", markAlt: "Brand" },
    navigation: [{ label: "Home", href: "#home" }],
    hero: {
      autoplayMs: 6500,
      slides: [{
        eyebrow: "A FRESH WAY TO STUDY LAW", title: "Build legal clarity.", accent: "Move with confidence.",
        body: "A focused home for your law courses.", image: "./assets/images/pexels-law-judge.jpg",
        imageAlt: "A judge writing", imageCredit: "Photo · Pexels",
        primaryLabel: "Open student workspace", primaryHref: "./study.html#dashboard",
        secondaryLabel: "See the study tools", secondaryHref: "#learning"
      }]
    },
    quickFacts: [], learning: {}, caseNotes: {}, articles: {}, resources: {}, footer: {},
    updatedAt: serverTimestamp(),
    updatedBy: uid
  };
}

function validStudentPage() {
  return {
    displayName: "Ada Student",
    headline: "300-level law student",
    bio: "Working through tort and contract.",
    links: ["https://example.org/ada"],
    focusAreas: ["Tort", "Contract"],
    published: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
}

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

test("Firestore allows public content reads but denies every browser homepage write", async () => {
  const contexts = [testEnv.unauthenticatedContext(), googleContext("test-student"), googleContext("test-admin", { admin: true })];
  for (const context of contexts) {
    const db = context.firestore();
    const reference = doc(db, "siteContent", "public");
    const content = await assertSucceeds(getDoc(reference));
    assert.deepEqual(content.data(), { title: "Emulator fixture" });
    // Even a valid Google admin must use the validated API. Both creates and
    // replacements/patches/deletes are closed; a manipulated UI cannot bypass it.
    await assertFails(setDoc(reference, validSiteContent("test-admin")));
    await assertFails(setDoc(doc(db, "siteContent", "new-page"), validSiteContent("test-admin")));
    await assertFails(updateDoc(reference, { title: "Forged", updatedBy: "test-admin", updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(reference));
    assert.deepEqual((await assertSucceeds(getDoc(reference))).data(), { title: "Emulator fixture" });
  }
});

test("Firestore keeps server-published 12-slide workspace content public and immutable to browser admins", async () => {
  const content = validSiteContent("test-admin");
  content.workspace = { welcome: { title: "Server published workspace" } };
  content.navigation = Array.from({ length: 8 }, () => ({ label: "Home", href: "#home" }));
  content.hero.slides = Array.from({ length: 12 }, () => ({ ...content.hero.slides[0] }));
  content.updatedAt = Timestamp.fromMillis(5000);
  // This trusted emulator seed is not a live Admin SDK credential test. The
  // API suite separately checks verified tokens, schema and server metadata.
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "siteContent", "public"), content);
  });
  const publicRef = doc(testEnv.unauthenticatedContext().firestore(), "siteContent", "public");
  const published = (await assertSucceeds(getDoc(publicRef))).data();
  assert.equal(published.workspace.welcome.title, "Server published workspace");
  assert.equal(published.hero.slides.length, 12);
  assert.equal(published.navigation.length, 8);
  assert.equal(published.updatedBy, "test-admin");
  assert.equal(published.updatedAt.toMillis(), 5000);
  const adminRef = doc(googleContext("test-admin", { admin: true }).firestore(), "siteContent", "public");
  await assertFails(setDoc(adminRef, { ...content, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(adminRef, { "workspace.welcome.title": "Browser override" }));
  await assertFails(deleteDoc(adminRef));
  assert.deepEqual((await assertSucceeds(getDoc(publicRef))).data(), published);
});

test("Firestore student pages are owned, validated and publish-gated", async () => {
  const ownerDb = googleContext("test-student").firestore();
  const otherDb = googleContext("other-student").firestore();
  const adminDb = googleContext("test-admin", { admin: true }).firestore();
  const anonymousDb = testEnv.unauthenticatedContext().firestore();
  const pageRef = db => doc(db, "studentPages", "test-student");

  // The owner creates their page; preserve createdAt on EVERY later check,
  // otherwise an immutable-timestamp denial could mask a broken field rule.
  await assertSucceeds(setDoc(pageRef(ownerDb), validStudentPage()));
  const createdAt = (await assertSucceeds(getDoc(pageRef(ownerDb)))).data().createdAt;
  const validUpdate = () => ({ ...validStudentPage(), createdAt });
  await assertFails(setDoc(pageRef(otherDb), validUpdate()));
  await assertFails(setDoc(pageRef(anonymousDb), validUpdate()));
  await assertFails(deleteDoc(pageRef(otherDb)));
  await assertFails(deleteDoc(pageRef(anonymousDb)));

  // A fully populated page at every advertised bound stays editable.
  const maximum = { ...validUpdate(), displayName: "x".repeat(120), headline: "x".repeat(160), bio: "x".repeat(2000),
    links: Array(5).fill("https://example.org/" + "x".repeat(280)), focusAreas: Array(8).fill("x".repeat(40)) };
  await assertSucceeds(setDoc(pageRef(ownerDb), maximum));
  await assertSucceeds(setDoc(pageRef(adminDb), validUpdate()));

  // Field shape is enforced independently of ownership and timestamps.
  for (const change of [{ role: "admin" }, { bio: "x".repeat(2001) }, { headline: "x".repeat(161) }, { published: "true" },
    { links: ["http://insecure.example"] }, { links: Array(6).fill("https://example.org") },
    { focusAreas: Array(9).fill("Law") }, { focusAreas: ["x".repeat(41)] }, { displayName: "" }]) {
    await assertFails(setDoc(pageRef(ownerDb), { ...validUpdate(), ...change }));
    await assertFails(setDoc(pageRef(adminDb), { ...validUpdate(), ...change }));
  }
  for (const key of Object.keys(validUpdate())) {
    const incomplete = validUpdate();
    delete incomplete[key];
    await assertFails(setDoc(pageRef(ownerDb), incomplete));
  }
  await assertFails(setDoc(pageRef(ownerDb), { ...validUpdate(), updatedAt: Timestamp.fromMillis(1) }));
  await assertSucceeds(setDoc(pageRef(ownerDb), validUpdate()));

  // Unpublished pages are visible only to the owner and admins.
  await assertSucceeds(getDoc(pageRef(ownerDb)));
  await assertSucceeds(getDoc(pageRef(adminDb)));
  await assertFails(getDoc(pageRef(otherDb)));
  await assertFails(getDoc(pageRef(anonymousDb)));

  // The creation timestamp is immutable for owners and admins alike. The
  // withSecurityRulesDisabled helper resolves to void, so the seed timestamp is
  // known and the preserved value is simply reused.
  const seedCreatedAt = Timestamp.fromMillis(5000);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "studentPages", "test-student"), { ...validStudentPage(), published: true, createdAt: seedCreatedAt, updatedAt: Timestamp.fromMillis(5000) });
  });
  await assertSucceeds(getDoc(pageRef(anonymousDb)));

  for (const db of [ownerDb, adminDb]) {
    await assertFails(setDoc(pageRef(db), { ...validStudentPage(), published: true, createdAt: Timestamp.fromMillis(9999), updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(pageRef(db), { ...validStudentPage(), published: true, createdAt: seedCreatedAt, updatedAt: serverTimestamp() }));
  }

  // The collection cannot be listed by students or visitors.
  await assertFails(getDocs(collection(anonymousDb, "studentPages")));
  await assertFails(getDocs(collection(ownerDb, "studentPages")));
  await assertSucceeds(getDocs(collection(adminDb, "studentPages")));
  await assertSucceeds(deleteDoc(pageRef(ownerDb)));
  await assertSucceeds(setDoc(pageRef(adminDb), validStudentPage()));
  await assertSucceeds(deleteDoc(pageRef(adminDb)));
});

test("Firestore restricts account and quota reads to the admin claim and denies client writes", async () => {
  const studentDb = googleContext("test-student").firestore();
  const anonymousDb = testEnv.unauthenticatedContext().firestore();
  const adminDb = googleContext("test-admin", { admin: true }).firestore();
  const paths = [["accounts", "test-student"], ["aiQuotaPolicies", "default"], ["aiEntitlements", "test-student"],
    ["aiUsage", "test-student_test-period"], ["adminAudit", "test-event"]];
  for (const path of paths) {
    for (const db of [studentDb, anonymousDb, adminDb]) {
      const reference = doc(db, ...path);
      if (db === adminDb) await assertSucceeds(getDoc(reference));
      else await assertFails(getDoc(reference));
      await assertFails(setDoc(reference, { forged: true }));
      await assertFails(setDoc(doc(db, path[0], "new-document"), { forged: true }));
      await assertFails(updateDoc(reference, { forged: true }));
      await assertFails(deleteDoc(reference));
    }
    await assertSucceeds(getDoc(doc(adminDb, ...path)));
  }
});

test("Firestore denies unlisted collections to students and admins", async () => {
  const studentDb = googleContext("test-student").firestore();
  const adminDb = googleContext("test-admin", { admin: true }).firestore();

  await assertFails(getDoc(doc(studentDb, "unlistedCollection", "private")));
  await assertFails(getDoc(doc(adminDb, "unlistedCollection", "private")));
});

test("Storage allows public slide reads and admin-only valid image uploads", async () => {
  const path = `site/slides/rules-test-${randomUUID()}.png`;
  const adminStorage = googleContext("test-admin", { admin: true }).storage();
  const studentStorage = googleContext("test-student").storage();
  const anonymousStorage = testEnv.unauthenticatedContext().storage();
  const pngBytes = new Uint8Array([137, 80, 78, 71]);

  await assertFails(uploadBytes(ref(studentStorage, path), pngBytes, { contentType: "image/png" }));
  await assertFails(uploadBytes(ref(anonymousStorage, path), pngBytes, { contentType: "image/png" }));
  await assertSucceeds(uploadBytes(ref(adminStorage, path), pngBytes, { contentType: "image/png" }));

  const downloaded = await assertSucceeds(getBytes(ref(anonymousStorage, path)));
  // The Storage SDK returns an ArrayBuffer, which is not itself iterable.
  assert.equal(downloaded.byteLength, pngBytes.byteLength);
  assert.deepEqual([...new Uint8Array(downloaded)], [...pngBytes]);
});

test("Storage rejects non-image types, oversized images, and non-slide paths", async () => {
  const adminStorage = googleContext("test-admin", { admin: true }).storage();
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
  const studentStorage = googleContext("test-student").storage();
  const adminStorage = googleContext("test-admin", { admin: true }).storage();
  const anonymousStorage = testEnv.unauthenticatedContext().storage();
  const pngBytes = new Uint8Array([1, 2, 3]);

  await testEnv.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(ref(context.storage(), path), pngBytes, { contentType: "image/png" });
  });

  await assertFails(deleteObject(ref(studentStorage, path)));
  await assertFails(deleteObject(ref(anonymousStorage, path)));
  const retained = await assertSucceeds(getBytes(ref(anonymousStorage, path)));
  assert.deepEqual([...new Uint8Array(retained)], [...pngBytes]);
  await assertSucceeds(deleteObject(ref(adminStorage, path)));
  // Public reads remain allowed; a successfully deleted object is missing,
  // not permission-denied. assertFails deliberately accepts permission errors only.
  await assert.rejects(getBytes(ref(anonymousStorage, path)), { code: "storage/object-not-found" });
});


test("non-Google sessions cannot access private Firestore data or change slides, even as admins", async () => {
  const path = `site/slides/provider-test-${randomUUID()}.png`;
  const bytes = new Uint8Array([1, 2, 3]);
  await testEnv.withSecurityRulesDisabled(async context => {
    await uploadBytes(ref(context.storage(), path), bytes, { contentType: "image/png" });
  });
  for (const provider of ["password", "anonymous", "custom"]) {
    const legacy = testEnv.authenticatedContext("test-student", {
      admin: true,
      firebase: { sign_in_provider: provider, identities: { "google.com": ["linked-google-id"] } }
    });
    const db = legacy.firestore();
    await assertSucceeds(getDoc(doc(db, "siteContent", "public"))); // public remains public
    await assertFails(getDoc(doc(db, "accounts", "test-student")));
    await assertFails(setDoc(doc(db, "siteContent", "public"), validSiteContent("test-student")));
    await assertFails(setDoc(doc(db, "studentPages", "test-student"), validStudentPage()));
    await assertFails(uploadBytes(ref(legacy.storage(), path), bytes, { contentType: "image/png" }));
    await assertFails(deleteObject(ref(legacy.storage(), path)));
  }
  const retained = await assertSucceeds(getBytes(ref(testEnv.unauthenticatedContext().storage(), path)));
  assert.deepEqual([...new Uint8Array(retained)], [...bytes]);
});
