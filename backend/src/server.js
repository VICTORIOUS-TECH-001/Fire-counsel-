import "dotenv/config";
import { createApp } from "./app.js";

// Render's proxy keeps idle connections open longer than Node's default 5 s
// keep-alive, so Node could close a socket the proxy was about to reuse and the
// visitor got a random "502". Keep sockets open longer than the proxy does
// (Render troubleshooting guide), and headers timeout must exceed keep-alive.
export const KEEP_ALIVE_TIMEOUT_MS = 120_000;
export const HEADERS_TIMEOUT_MS = 125_000;

export function applyServerTimeouts(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

// Tests import this file for the helpers above without starting a server.
const underTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.FIRE_COUNSEL_NO_LISTEN === "1";

if (!underTest) {
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason?.code || reason?.message || reason);
  });
  const port = Number(process.env.PORT || 4000);
  // BIND_ADDRESS=127.0.0.1 keeps the server private behind a local proxy (Oracle setup
  // with Caddy). Render and other hosts use the default, all interfaces.
  const host = process.env.BIND_ADDRESS?.trim() || "0.0.0.0";
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`FIRE COUNSEL API listening on ${host}:${port}`);
  });
  applyServerTimeouts(server);
}
