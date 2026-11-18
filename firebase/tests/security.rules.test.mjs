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

// A minimal document that satisfies every siteContent rule. Mirrors the
// bundled data/site-content.json shape checked by firebase/content-schema.mjs.
function validSiteContent(uid) {
  return {
    brand: { name: "FIRE COUNSEL", tagline: "Ignite your legal intelligence", markImage: "./assets/images/fire-counsel-brand.jpg", markAlt: "Brand" },
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

test("Firestore allows public site-content reads and verified admin publishing only", async () => {
  const anonymousDb = testEnv.unauthenticatedContext().firestore();
  const studentDb = testEnv.authenticatedContext("test-student").firestore();
  const adminDb = testEnv.authenticatedContext("test-admin", { admin: true }).firestore();

  const publicContent = await assertSucceeds(getDoc(doc(anonymousDb, "siteContent", "public")));
  assert.equal(publicContent.exists(), true);

  // The admin studio publishes directly from the browser, with the full shape
  // and server-owned metadata enforced by the rules.
  await assertSucceeds(setDoc(doc(adminDb, "siteContent", "public"), validSiteContent("test-admin")));

  // Students and visitors can never publish, even with a valid document.
  await assertFails(setDoc(doc(studentDb, "siteContent", "public"), validSiteContent("test-student")));
  await assertFails(setDoc(doc(anonymousDb, "siteContent", "public"), validSiteContent("anon")));

  // An admin write with a broken shape, a forged author, or a forged
  // timestamp is refused.
  const noSlides = { ...validSiteContent("test-admin"), hero: { slides: [] } };
  await assertFails(setDoc(doc(adminDb, "siteContent", "public"), noSlides));
  const badImage = validSiteContent("test-admin");
  badImage.hero.slides[0].image = "https://evil.example/photo.png";
  await assertFails(setDoc(doc(adminDb, "siteContent", "public"), badImage));
  const badLink = validSiteContent("test-admin");
  badLink.hero.slides[0].primaryHref = "javascript:alert(1)";
  await assertFails(setDoc(doc(adminDb, "siteContent", "public"), badLink));
  const forgedMeta = { ...validSiteContent("test-admin"), updatedBy: "someone-else", updatedAt: Timestamp.fromMillis(1000) };
  await assertFails(setDoc(doc(adminDb, "siteContent", "public"), forgedMeta));
  const extraSection = { ...validSiteContent("test-admin"), secrets: {} };
  await assertFails(setDoc(doc(adminDb, "siteContent", "public"), extraSection));

  // Deletion stays server-only so the homepage cannot be removed by a client.
  await assertFails(deleteDoc(doc(adminDb, "siteContent", "public")));
});

test("Firestore student pages are owned, validated and publish-gated", async () => {
  const ownerDb = testEnv.authenticatedContext("test-student").firestore();
  const otherDb = testEnv.authenticatedContext("other-student").firestore();
  const adminDb = testEnv.authenticatedContext("test-admin", { admin: true }).firestore();
  const anonymousDb = testEnv.unauthenticatedContext().firestore();
  const pageRef = db => doc(db, "studentPages", "test-student");

  // The owner creates their page; nobody else can create or edit it.
  await assertSucceeds(setDoc(pageRef(ownerDb), validStudentPage()));
  await assertFails(setDoc(pageRef(otherDb), validStudentPage()));
  await assertFails(setDoc(pageRef(anonymousDb), validStudentPage()));

  // Field shape is enforced: no extra keys, bounded text, https links only.
  await assertFails(setDoc(pageRef(ownerDb), { ...validStudentPage(), role: "admin" }));
  await assertFails(setDoc(pageRef(ownerDb), { ...validStudentPage(), bio: "x".repeat(2001) }));
  await assertFails(setDoc(pageRef(ownerDb), { ...validStudentPage(), links: ["http://insecure.example"] }));
  await assertFails(setDoc(pageRef(ownerDb), { ...validStudentPage(), links: ["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example", "https://f.example"] }));
  await assertFails(setDoc(pageRef(ownerDb), { ...validStudentPage(), displayName: "" }));

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

  await assertFails(setDoc(pageRef(ownerDb), { ...validStudentPage(), published: true, createdAt: Timestamp.fromMillis(9999), updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(pageRef(ownerDb), { ...validStudentPage(), published: true, createdAt: seedCreatedAt, updatedAt: serverTimestamp() }));

  // The collection cannot be listed by students or visitors.
  await assertFails(getDocs(collection(anonymousDb, "studentPages")));
  await assertFails(getDocs(collection(ownerDb, "studentPages")));
  await assertSucceeds(getDocs(collection(adminDb, "studentPages")));
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
  // The Storage SDK returns an ArrayBuffer, which is not itself iterable.
  assert.equal(downloaded.byteLength, pngBytes.byteLength);
  assert.deepEqual([...new Uint8Array(downloaded)], [...pngBytes]);
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
