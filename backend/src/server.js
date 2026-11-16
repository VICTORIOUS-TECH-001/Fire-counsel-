import "dotenv/config";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 4000);
// BIND_ADDRESS=127.0.0.1 keeps the server private behind a local proxy (Oracle setup
// with Caddy). Render and other hosts use the default, all interfaces.
const host = process.env.BIND_ADDRESS?.trim() || "0.0.0.0";
const app = createApp();
app.listen(port, host, () => {
  console.log(`FIRE COUNSEL API listening on ${host}:${port}`);
});
