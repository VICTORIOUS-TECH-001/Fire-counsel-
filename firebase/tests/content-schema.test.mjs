import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SITE_CONTENT_LIMITS,
  STUDENT_PAGE_LIMITS,
  cleanStudentPage,
  siteContentFromDocument,
  validateSiteContent,
  validateStudentPage
} from "../content-schema.mjs";

import { DEFAULT_WORKSPACE } from "../../workspace-config.mjs";

const bundled = JSON.parse(readFileSync(new URL("../../data/site-content.json", import.meta.url), "utf8"));

function validPage(overrides = {}) {
  return {
    displayName: "Ada Student",
    headline: "300-level law student",
    bio: "Working through tort and contract.",
    links: ["https://example.org/ada"],
    focusAreas: ["Tort"],
    published: true,
    ...overrides
  };
}

test("the bundled homepage content passes publish validation unchanged", () => {
  const result = validateSiteContent(bundled);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("site content rejects missing sections, extra sections and bad brands", () => {
  assert.equal(validateSiteContent(null).ok, false);
  assert.equal(validateSiteContent({}).ok, false);
  for (const key of ["articles", "footer", "hero"]) {
    const copy = structuredClone(bundled);
    delete copy[key];
    assert.equal(validateSiteContent(copy).ok, false, `missing ${key} rejected`);
  }
  const extra = structuredClone(bundled);
  extra.adminPanel = {};
  assert.equal(validateSiteContent(extra).ok, false);
  const unnamed = structuredClone(bundled);
  unnamed.brand.name = "";
  assert.equal(validateSiteContent(unnamed).ok, false);
});

test("stored site content strips only Firestore metadata, never unknown editor fields", () => {
  const document = { ...bundled, updatedAt: { seconds: 1234 }, updatedBy: "synthetic-admin" };
  assert.deepEqual(siteContentFromDocument(document), bundled);
  assert.equal(validateSiteContent(document).ok, false, "editors cannot supply server-owned metadata");
  assert.equal(siteContentFromDocument({ ...document, privateKeys: {} }), null);
  assert.equal(siteContentFromDocument({ ...document, hero: {} }), null);
  assert.equal(siteContentFromDocument(null), null);
  assert.equal(document.updatedBy, "synthetic-admin", "the stored snapshot is not mutated");
});

test("the optional workspace section can publish with homepage content and is bounded", () => {
  const content = { ...bundled, workspace: structuredClone(DEFAULT_WORKSPACE) };
  assert.deepEqual(validateSiteContent(content), { ok: true, errors: [] });
  assert.deepEqual(siteContentFromDocument({ ...content, updatedAt: {}, updatedBy: "admin" }), content);
  for (const workspace of [null, [], "not a map", { notices: ["x".repeat(SITE_CONTENT_LIMITS.DEEP_STRING + 1)] }, { menu: Array(41).fill({}) }]) {
    assert.equal(validateSiteContent({ ...bundled, workspace }).ok, false);
  }
});

test("nested field whitelists and required text match the Firestore write schema", () => {
  for (const change of [
    c => { c.brand.extra = true; },
    c => { delete c.brand.markAlt; },
    c => { c.brand.tagline = null; },
    c => { c.brand.name = 123; },
    c => { c.navigation[0].extra = true; },
    c => { delete c.navigation[0].href; },
    c => { c.navigation[0].label = 123; },
    c => { c.hero.extra = true; },
    c => { c.hero.slides[0].eyebrow = null; },
    c => { c.hero.slides[0].title = 123; },
    c => { c.hero.slides[0].primaryLabel = null; }
  ]) {
    const copy = structuredClone(bundled);
    change(copy);
    const result = validateSiteContent(copy);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length, "bad imports produce a validation message, not a TypeError");
  }
});

test("slide validation bounds counts, text sizes, images and links", () => {
  const noSlides = structuredClone(bundled);
  noSlides.hero.slides = [];
  assert.match(validateSiteContent(noSlides).errors[0], /between 1 and/);

  const tooMany = structuredClone(bundled);
  tooMany.hero.slides = Array.from({ length: SITE_CONTENT_LIMITS.MAX_SLIDES + 1 }, () => ({ ...bundled.hero.slides[0] }));
  assert.equal(validateSiteContent(tooMany).ok, false);

  const longTitle = structuredClone(bundled);
  longTitle.hero.slides[0].title = "x".repeat(SITE_CONTENT_LIMITS.SHORT_TEXT + 1);
  assert.equal(validateSiteContent(longTitle).ok, false);

  for (const image of [
    "https://evil.example/photo.png",
    "data:image/png;base64,AAAA",
    "https://firebasestorage.googleapis.com/v0/b/other-bucket.appspot.com/o/site%2Fslides%2Fx.png?alt=media",
    "/etc/passwd"
  ]) {
    const copy = structuredClone(bundled);
    copy.hero.slides[0].image = image;
    assert.equal(validateSiteContent(copy).ok, false, `${image} rejected`);
  }

  const storageUrl = structuredClone(bundled);
  storageUrl.hero.slides[0].image = "https://firebasestorage.googleapis.com/v0/b/fire-counsel.firebasestorage.app/o/site%2Fslides%2Fslide-1.jpg?alt=media&token=ab12-CD_34";
  assert.equal(validateSiteContent(storageUrl).ok, true);
  const mediaUrl = structuredClone(bundled);
  mediaUrl.hero.slides[0].image = "/media/123e4567-e89b-42d3-a456-426614174000.webp";
  assert.equal(validateSiteContent(mediaUrl).ok, true);

  const jsLink = structuredClone(bundled);
  jsLink.hero.slides[0].primaryHref = "javascript:alert(1)";
  assert.equal(validateSiteContent(jsLink).ok, false);

  const missingField = structuredClone(bundled);
  delete missingField.hero.slides[0].secondaryHref;
  assert.equal(validateSiteContent(missingField).ok, false);
  const extraField = structuredClone(bundled);
  extraField.hero.slides[0].onclick = "alert(1)";
  assert.equal(validateSiteContent(extraField).ok, false);
});

test("navigation and deep sections are bounded", () => {
  const nav = structuredClone(bundled);
  nav.navigation = Array.from({ length: SITE_CONTENT_LIMITS.MAX_NAVIGATION + 1 }, (_, i) => ({ label: `N${i}`, href: "#home" }));
  assert.equal(validateSiteContent(nav).ok, false);
  const badHref = structuredClone(bundled);
  badHref.navigation[0].href = "javascript:alert(1)";
  assert.equal(validateSiteContent(badHref).ok, false);
  const deep = structuredClone(bundled);
  deep.articles.items[0].body = "x".repeat(SITE_CONTENT_LIMITS.DEEP_STRING + 1);
  assert.equal(validateSiteContent(deep).ok, false);
});

test("cleanStudentPage normalizes and bounds every field", () => {
  const page = cleanStudentPage({
    displayName: "  Ada   Lovelace ",
    headline: "  Law student  ",
    bio: " Year 2 ",
    links: [" https://example.org/me ", "", "   "],
    focusAreas: [" Tort ", "", "Contract"],
    published: "yes"
  });
  assert.deepEqual(page, {
    displayName: "Ada Lovelace",
    headline: "Law student",
    bio: "Year 2",
    links: ["https://example.org/me"],
    focusAreas: ["Tort", "Contract"],
    published: false // only the boolean true publishes
  });
  assert.equal(validateStudentPage(page).ok, true);
});

test("cleanStudentPage rejects empty names, oversize text and unsafe links", () => {
  assert.throws(() => cleanStudentPage({ displayName: "" }), /display name/);
  assert.throws(() => cleanStudentPage({ displayName: "x".repeat(STUDENT_PAGE_LIMITS.DISPLAY_NAME + 1) }), /display name/);
  assert.throws(() => cleanStudentPage({ displayName: "A", bio: "x".repeat(STUDENT_PAGE_LIMITS.BIO + 1) }), /bio/);
  assert.throws(() => cleanStudentPage({ displayName: "A", links: ["http://insecure.example"] }), /https/);
  assert.throws(() => cleanStudentPage({ displayName: "A", links: ["javascript:alert(1)"] }), /https/);
  assert.throws(() => cleanStudentPage({ displayName: "A", links: Array.from({ length: STUDENT_PAGE_LIMITS.MAX_LINKS + 1 }, (_, i) => `https://e.example/${i}`) }), /at most 5/);
  assert.throws(() => cleanStudentPage({ displayName: "A", focusAreas: Array.from({ length: STUDENT_PAGE_LIMITS.MAX_FOCUS_AREAS + 1 }, (_, i) => `Area ${i}`) }), /at most 8/);
  const control = cleanStudentPage({ displayName: "A", bio: "line one\nline two" });
  assert.equal(control.bio, "line one\nline two", "ordinary newlines stay");
});

test("validateStudentPage accepts any rules-passing stored page and rejects broken ones", () => {
  assert.equal(validateStudentPage(validPage()).ok, true);
  assert.equal(validateStudentPage(validPage({ published: false })).ok, true);
  assert.equal(validateStudentPage(validPage({ displayName: "  unpadded " })).ok, true);
  assert.equal(validateStudentPage(validPage({ displayName: "" })).ok, false);
  assert.equal(validateStudentPage(validPage({ published: "yes" })).ok, false);
  assert.equal(validateStudentPage(validPage({ links: ["ftp://old.example"] })).ok, false);
  assert.equal(validateStudentPage(validPage({ focusAreas: ["x".repeat(41)] })).ok, false);
  assert.equal(validateStudentPage("not an object").ok, false);
});
