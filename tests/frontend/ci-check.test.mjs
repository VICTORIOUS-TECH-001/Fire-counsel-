import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve(import.meta.dirname, "../../tools/ci_check.sh");
function run(code) {
  const cwd = mkdtempSync(join(tmpdir(), "fire-counsel-ci-check-"));
  try {
    const summary = join(cwd, "summary.md");
    const result = spawnSync("bash", [script, "synthetic", process.execPath, "-e", code], {
      cwd, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary }
    });
    return { ...result, summary: result.status === 0 ? "" : readFileSync(summary, "utf8"), log: readFileSync(join(cwd, ".cache/ci/synthetic.log"), "utf8") };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("CI reporting preserves a successful command without generating a failure annotation", () => {
  const result = run("console.log('synthetic pass')");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /synthetic pass/);
  assert.doesNotMatch(result.stdout, /::error/);
});

test("CI reporting preserves failures and escapes multiline check annotations", () => {
  const result = run("console.log('synthetic 100% failure'); console.error('second line'); process.exit(7)");
  assert.equal(result.status, 7);
  assert.match(result.stdout, /::error title=synthetic failed::Command exited with status 7\.%0A/);
  assert.match(result.stdout, /synthetic 100%25 failure%0Asecond line/);
  assert.match(result.summary, /synthetic failed \(exit 7\)/);
  assert.match(result.log, /second line/);
});

test("CI annotations are bounded while the full local log is retained", () => {
  const result = run("console.log('prefix-' + 'x'.repeat(30000)); console.error('last error'); process.exit(1)");
  const annotation = result.stdout.split('\n').find(line => line.startsWith('::error'));
  assert.equal(result.status, 1);
  assert.ok(annotation.length < 3600);
  assert.match(annotation, /last error/);
  assert.ok(result.log.length > 30000);
});
