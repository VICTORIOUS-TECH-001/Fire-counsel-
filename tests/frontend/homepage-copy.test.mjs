import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_HERO_COPY, heroCopy, learningPreview, updateHomepageCopy } from "../../homepage-copy.mjs";
import { validateSiteContent } from "../../firebase/content-schema.mjs";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const bundled = JSON.parse(read("data/site-content.json"));

test("hero copy prefers explicit admin words without restoring any carousel or old defaults", () => {
  assert.deepEqual(heroCopy(bundled), DEFAULT_HERO_COPY);
  const content = structuredClone(bundled);
  content.hero.copy = { title: 'Learn <law> with purpose', tagline: "Your legal future", introduction: 'Keep <script> as words.' };
  assert.deepEqual(heroCopy(content), content.hero.copy);
  delete content.hero.copy;
  content.hero.slides = [0, 1].map(() => ({ ...bundled.hero.slides[0], title: "Old slide" }));
  assert.deepEqual(heroCopy(content), DEFAULT_HERO_COPY);
  content.hero.slides = [{ ...bundled.hero.slides[0], title: "Build legal clarity.", accent: "Move with confidence." }];
  assert.deepEqual(heroCopy(content), DEFAULT_HERO_COPY);
});

test("single-record legacy slides never restore retired copy; explicit empty optional words are preserved", () => {
  const content = structuredClone(bundled);
  delete content.hero.copy;
  content.hero.slides[0] = { ...content.hero.slides[0], title: "A retired marketing title", accent: "An old tagline", body: "An old paragraph" };
  assert.deepEqual(heroCopy(content), DEFAULT_HERO_COPY);
  content.hero.copy = { title: "An explicit introduction", tagline: "", introduction: "" };
  assert.deepEqual(heroCopy(content), { title: "An explicit introduction", tagline: "", introduction: "" });
});

test("preview labels and badges use editable values, with bounded illustration-specific fallback labels", () => {
  const original = learningPreview({}, 0);
  assert.equal(original.labels.length, 10);
  assert.equal(original.badge, "Your study, better organised.");
  const custom = learningPreview({ preview: { badge: "Custom <badge>", labels: ["Custom table header"] } }, 0);
  assert.equal(custom.badge, "Custom <badge>");
  assert.equal(custom.labels[0], "Custom table header");
  assert.deepEqual(custom.labels.slice(1), original.labels.slice(1));
  for (const i of [1, 2, 3, 5]) assert.equal(learningPreview({}, i).labels.length, 3);
  custom.labels[1] = "Do not mutate defaults";
  assert.deepEqual(learningPreview({}, 0), original);
  assert.deepEqual(learningPreview({ preview: { labels: "not an array", badge: null } }, 0), original);
});

test("structured edits preserve unrelated draft data and legacy pictures without mutating the source", () => {
  const original = structuredClone(bundled);
  const updated = updateHomepageCopy(original, "hero.copy.title", "New legal learning title");
  assert.equal(updated.hero.copy.title, "New legal learning title");
  assert.deepEqual(original, bundled);
  assert.deepEqual(updated.hero.slides, bundled.hero.slides);
  for (const key of Object.keys(bundled).filter(k => k !== "hero")) assert.deepEqual(updated[key], bundled[key]);
  const tool = updateHomepageCopy(updated, "learning.cards.1.preview.badge", "Your edited library badge");
  assert.equal(tool.learning.cards[1].preview.badge, "Your edited library badge");
  assert.equal(learningPreview(tool.learning.cards[1], 1).labels.length, 3);
  const label = updateHomepageCopy(tool, "learning.cards.0.preview.labels.2", "An edited row label");
  assert.equal(label.learning.cards[0].preview.labels[2], "An edited row label");
  assert.equal(validateSiteContent(label).ok, true);
  const withOtherPreviewData = structuredClone(bundled);
  withOtherPreviewData.learning.cards[0].preview = { badge: "Keep this badge", labels: Array(11).fill("Keep this label"), extraText: "Keep this property" };
  const editedLabel = updateHomepageCopy(withOtherPreviewData, "learning.cards.0.preview.labels.0", "Edit only this label");
  assert.equal(editedLabel.learning.cards[0].preview.extraText, "Keep this property");
  assert.equal(editedLabel.learning.cards[0].preview.badge, "Keep this badge");
  assert.equal(editedLabel.learning.cards[0].preview.labels[10], "Keep this label");
  assert.equal(withOtherPreviewData.learning.cards[0].preview.labels[0], "Keep this label");
});

test("structured editing refuses unknown/prototype paths and out-of-range card/label indices", () => {
  for (const path of ["__proto__.polluted", "hero.copy.__proto__", "brand.name", "learning.constructor", "learning.cards.80.title", "learning.cards.1.preview.labels.9", "learning.cards.0.preview.extra"]) {
    assert.throws(() => updateHomepageCopy(bundled, path, "No"), /Unsupported|Invalid|Unknown/);
  }
  assert.equal({}.polluted, undefined);
  const content = updateHomepageCopy(bundled, "hero.copy.introduction", "One paragraph.\nA second line.\tStill plain words.");
  assert.equal(content.hero.copy.introduction, "One paragraph. A second line. Still plain words.");
});

test("the shared protected-publish validator strictly validates optional hero copy", () => {
  const valid = { ...structuredClone(bundled), hero: { ...structuredClone(bundled.hero), copy: { ...DEFAULT_HERO_COPY } } };
  assert.equal(validateSiteContent(valid).ok, true);
  const old = structuredClone(valid); delete old.hero.copy;
  assert.equal(validateSiteContent(old).ok, true, "old published documents need no migration");
  for (const copy of [null, [], {}, { ...DEFAULT_HERO_COPY, unexpected: true }, { ...DEFAULT_HERO_COPY, title: " " }, { ...DEFAULT_HERO_COPY, title: "x".repeat(121) }, { ...DEFAULT_HERO_COPY, tagline: 123 }, { ...DEFAULT_HERO_COPY, introduction: "x".repeat(601) }, { ...DEFAULT_HERO_COPY, introduction: "invalid\u0000text" }]) {
    const content = structuredClone(valid); content.hero.copy = copy;
    assert.equal(validateSiteContent(content).ok, false, JSON.stringify(copy));
  }
});

test("copy modules are explicitly served, while the admin controller stays out of offline caches and data APIs", () => {
  for (const path of ["homepage-copy.mjs", "admin-homepage.mjs"]) {
    for (const server of ["backend/src/website.js", "tools/dev_server.py"]) assert.ok(read(server).includes(path));
  }
  assert.match(read("sw.js"), /\.\/homepage-copy\.mjs/);
  assert.doesNotMatch(read("sw.js"), /admin-homepage\.mjs/);
  assert.match(read("admin.html"), /type="module" src="\.\/admin-homepage\.mjs"/);
  assert.doesNotMatch(read("admin-homepage.mjs"), /fetch\(|localStorage|sessionStorage|indexedDB|apiRequest|\/api\//);
});
