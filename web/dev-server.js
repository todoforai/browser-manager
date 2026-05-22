// Dev server: serves web/ and proxies API paths to the browser-manager service.
// Usage:  bun web/dev-server.js   (from browser-manager/)
//
// In dev there is no shared cookie. Paste a session token / API key into the
// panel's auth field; it will be sent as `Authorization: Bearer …`.
import { makeDevServer } from "../../packages/shared-web/dev-server.js";

makeDevServer({
  port: 8650,
  api: "http://127.0.0.1:8600",
  apiPrefixes: ["/api/", "/health"],
  pages: {},
  root: new URL("./", import.meta.url),
  label: "browser-manager dev",
});
