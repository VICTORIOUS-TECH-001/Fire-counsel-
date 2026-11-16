import { defineConfig } from "@playwright/test";
import { browserLaunchOptions } from "./tools/browser-runtime.mjs";

const launchOptions = await browserLaunchOptions();

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8081",
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
    launchOptions,
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: "npm --prefix backend start",
      url: "http://127.0.0.1:4001/healthz",
      env: {
        PORT: "4001", NODE_ENV: "test", DATABASE_URL: "",
        FIREBASE_PROJECT_ID: "", FIREBASE_SERVICE_ACCOUNT_JSON: "",
        GEMINI_API_KEY: "", STUDENT_PROFILES_ENABLED: "false", TRUSTED_PROXY_CIDRS: ""
      },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe"
    },
    {
      command: "python3 tools/dev_server.py --port 8081 --api-port 4001",
      url: "http://127.0.0.1:8081/",
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "ignore"
    }
  ]
});
