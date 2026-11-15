import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const excluded = new Set([".git", "node_modules", ".firebase", "test-results", "playwright-report", "__pycache__"]);
function sources(directory = ".") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith(".") || excluded.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const paths = sources();
for (const path of paths) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
const python = spawnSync("python3", ["-m", "compileall", "-q", "tools"], { stdio: "inherit" });
if (python.status !== 0) process.exit(python.status || 1);
console.log(`Syntax checks passed: ${paths.length} JavaScript modules and Python development/test tools.`);
