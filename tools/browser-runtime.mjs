import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { brotliDecompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import chromium from "@sparticuz/chromium";

export async function browserLaunchOptions() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH };
  }
  if (process.platform !== "linux") return {};

  // Minimal Linux sandboxes may lack NSS/NSPR. The pinned npm browser already
  // ships these libraries; unpack them to temporary storage, not into Git or
  // system directories. No additional binary download or elevated access.
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(dirname(require.resolve("@sparticuz/chromium")));
  const runtime = join(tmpdir(), "fire-counsel-chromium-153");
  if (!existsSync(join(runtime, "lib/libnss3.so"))) {
    mkdirSync(runtime, { recursive: true });
    const archive = brotliDecompressSync(readFileSync(join(packageRoot, "bin/al2023.tar.br")));
    execFileSync("tar", ["-xf", "-", "-C", runtime], { input: archive });
  }
  process.env.LD_LIBRARY_PATH = [join(runtime, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  // Keep actual web security and multi-context isolation on in regression tests.
  const unsafeFlags = new Set([
    "--disable-web-security", "--allow-running-insecure-content", "--single-process",
    "--disable-site-isolation-trials", "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process"
  ]);
  return {
    executablePath: await chromium.executablePath(),
    args: chromium.args.filter(arg => !unsafeFlags.has(arg)),
    env: { ...process.env }
  };
}
