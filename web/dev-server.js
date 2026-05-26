// Dev server: serves web/ and proxies API paths to the browser-manager service.
// Usage:  bun web/dev-server.js   (from browser-manager/)
//
// Two dev servers (mirror prod's two-socket pattern):
//   :8650  user UI    → /api/*, /health    → 127.0.0.1:8600 (public REST)
//   :8680  admin UI   → /admin/api/*       → 127.0.0.1:8610 (admin REST)
//
// In dev there is no shared cookie. Paste a session token / API key into the
// panel's auth field; it will be sent as `Authorization: Bearer …`.
import { makeDevServer } from "../../packages/shared-web/dev-server.js";

const root = new URL("./", import.meta.url);

makeDevServer({
  port: 8650,
  api: "http://127.0.0.1:8600",
  apiPrefixes: ["/api/", "/health"],
  root,
  label: "browser-manager dev (user)",
});

makeDevServer({
  port: 8680,
  api: "http://127.0.0.1:8610",
  apiPrefixes: ["/admin/api/"],
  pages: { "/": "/admin.html", "/admin": "/admin.html", "/admin/": "/admin.html" },
  root,
  label: "browser-manager dev (admin)",
});
