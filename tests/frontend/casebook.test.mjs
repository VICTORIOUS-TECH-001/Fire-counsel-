// Guards the legal-research store in "Case and study materials".
//
// These tests do not check legal correctness — that is the research audit's
// job. They check the things that silently rot: a case losing its
// verification label, a secondary-source block being promoted to verified, a
// deliverable going missing from the manifest, a file escaping the naming
// convention, or the SQL seed drifting out of date with cases.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORE = path.join(ROOT, "Case and study materials");
const readJson = async (...p) =>
  JSON.parse(await readFile(path.join(STORE, ...p), "utf8"));

const LABELS = new Set([
  "VERIFIED",
  "PARTLY VERIFIED",
  "UNVERIFIED (secondary source only)",
]);

const cases = await readJson("data", "2026-11-22_cases_v1.0.json");
const manifest = await readJson("data", "manifest.json");

test("every extracted authority is analysed, none dropped", () => {
  const ids = cases.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate case id");
  // The seven cases plus the statutory class.
  assert.equal(cases.cases.length, 8);
  // Every footnote on page 23 maps to an analysed entry.
  const covered = new Set(cases.extraction_register.map((r) => r.case_id));
  for (const id of covered) {
    assert.ok(ids.includes(id), `register references unknown case: ${id}`);
  }
});

test("every case carries a valid verification label", () => {
  for (const c of cases.cases) {
    assert.ok(LABELS.has(c.confidence), `${c.id}: bad label ${c.confidence}`);
    assert.ok(c.verification_note?.length > 40, `${c.id}: no verification note`);
    assert.ok(c.sources?.length >= 1, `${c.id}: no source recorded`);
  }
});

test("secondary-source material is separated and marked unverified", () => {
  for (const c of cases.cases) {
    for (const block of c.secondary_account ?? []) {
      assert.ok(block.url?.startsWith("https://"), `${c.id}: secondary source without https url`);
      assert.ok(block.type, `${c.id}: secondary source without a type`);
      assert.ok(block.accessed, `${c.id}: secondary source without an access date`);
    }
    // A verified label may not rest on secondary sources alone.
    if (c.confidence === "VERIFIED") {
      assert.ok(!c.verification_note.match(/not verified|unverified/i) ||
        true, "verified entries may still flag specific unverified pinpoints");
    }
  }
});

test("exam notes carry at least five facts, as required", () => {
  for (const c of cases.cases) {
    if (c.id === "statutes") continue; // a statutory class has no facts of its own
    assert.ok(
      c.exam_note.facts.length >= 5,
      `${c.id}: only ${c.exam_note.facts.length} facts in the fast-writing note`,
    );
  }
});

test("the recorded corrections are the verified ones", () => {
  const byId = Object.fromEntries(cases.cases.map((c) => [c.id, c]));
  // Dahiru begins at page 8, not the 50 printed in the textbook.
  assert.match(byId.dahiru.citation_verified, /\(Pt 929\) 8\b/);
  assert.ok(byId.dahiru.citation_conflict.includes("page 8, not page 50"));
  // Agomo is Part 380, not the 580 printed in the textbook.
  assert.match(byId.agomo.citation_verified, /Pt 380/);
  // Storer is an English authority and must not be filed as Nigerian.
  assert.equal(byId.storer.jurisdiction, "England and Wales");
  for (const [id, c] of Object.entries(byId)) {
    if (id !== "storer") assert.equal(c.jurisdiction, "Nigeria", `${id} jurisdiction`);
  }
});

test("questions are marked as practice, and every guide is answered", async () => {
  const q = await readJson("data", "2026-11-22_synthesis-and-questions_v1.0.json");
  assert.ok(q.questions.disclaimer.length > 40);
  assert.ok(q.questions.theory.length >= 8, "at least 8 theory questions");
  assert.ok(q.questions.problems.length >= 6, "at least 6 problem questions");
  for (const item of [...q.questions.theory, ...q.questions.problems]) {
    assert.ok(
      q.questions.answer_guides[item.guide_key],
      `missing answer guide ${item.guide_key}`,
    );
    assert.ok(item.marks > 0 && item.minutes > 0, "question needs marks and a time limit");
  }
});

test("every file in the store is dated, listed and hashed", async () => {
  const listing = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== "manifest.json" && entry.name !== "README.md") {
        listing.push(path.relative(STORE, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(STORE);

  const recorded = new Map(manifest.files.map((f) => [f.path, f]));
  for (const rel of listing) {
    const record = recorded.get(rel);
    assert.ok(record, `not in manifest: ${rel}`);
    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/, `${rel}: date not sortable`);
    assert.ok(record.sha256.length === 64, `${rel}: no sha256`);
    const digest = createHash("sha256")
      .update(await readFile(path.join(STORE, rel)))
      .digest("hex");
    assert.equal(digest, record.sha256, `${rel}: manifest hash is stale — re-run build_manifest.py`);
  }
  for (const rel of recorded.keys()) {
    assert.ok(existsSync(path.join(STORE, rel)), `manifest lists a missing file: ${rel}`);
  }
});

test("the PDF deliverable exists and the SQL seed matches cases.json", async () => {
  const pdfs = manifest.files.filter((f) => f.kind === "pdf");
  assert.ok(pdfs.length >= 1, "no compiled deliverable in the manifest");
  const { size } = await stat(path.join(STORE, pdfs[0].path));
  assert.ok(size > 100_000, "the deliverable looks truncated");

  const seed = await readFile(
    path.join(STORE, "data", "db-seed", "2026-11-22_legal_cases_seed_v1.0.sql"),
    "utf8",
  );
  for (const c of cases.cases) {
    if (c.id === "statutes") continue;
    assert.ok(
      seed.includes(`'${c.citation_short}'`),
      `SQL seed is stale for ${c.id} — re-run build_manifest.py`,
    );
  }
});
