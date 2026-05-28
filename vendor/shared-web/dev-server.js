// @shared/web/dev-server.js — reusable Bun dev server for *-manager web UIs.
//
// Each manager's web/dev-server.js imports `makeDevServer` and supplies:
//   - port         (per-manager, see packages/shared-web/README.md master port plan)
//   - api          (upstream e.g. "http://127.0.0.1:8200")
//   - apiPrefixes  (paths proxied to `api`)
//   - apiRoutes    (optional: { "/path/prefix": "http://upstream" } for routes
//                  that need a different upstream, e.g. admin REST on its own
//                  socket. Checked before `apiPrefixes`. Longest prefix wins.)
//   - pages        (path → file map for SPA-ish routes, e.g. { "/admin/": "/admin.html" })
//   - root         (URL of the manager's web/ dir, pass new URL("./", import.meta.url))
//
// Static files are served from `root`. The manager is expected to ship a
// vendored snapshot of theme.css + auth.js at web/shared/ (run
// scripts/sync-shared-web.sh to refresh from packages/shared-web/).

import { serve } from "bun";

export function makeDevServer({
  port = 8190,
  api,
  apiPrefixes = [],
  apiRoutes = {},
  pages = {},
  root,
  label,
}) {
  if (!root) throw new Error("makeDevServer: root URL required");
  if (!api) throw new Error("makeDevServer: api URL required");

  // Pre-sort apiRoutes by descending prefix length so longest wins.
  const routes = Object.entries(apiRoutes).sort((a, b) => b[0].length - a[0].length);

  const matchPrefix = (path, p) =>
    path === p || path.startsWith(p.endsWith("/") ? p : p + "/");

  const server = serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Per-prefix upstream first (longest match wins).
      for (const [prefix, upstream] of routes) {
        if (matchPrefix(url.pathname, prefix)) {
          return fetch(upstream + url.pathname + url.search, {
            method: req.method, headers: req.headers, body: req.body,
          });
        }
      }

      // Default upstream.
      if (apiPrefixes.some(p => matchPrefix(url.pathname, p))) {
        return fetch(api + url.pathname + url.search, {
          method: req.method, headers: req.headers, body: req.body,
        });
      }

      // Page routes (e.g. "/" → "/index.html", "/admin/" → "/admin.html")
      let path = url.pathname;
      if (pages[path]) path = pages[path];
      else if (path === "/") path = "/index.html";

      const file = Bun.file(new URL("." + path, root).pathname);
      return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
    },
  });

  console.log(`→ http://127.0.0.1:${port}/${label ? "   (" + label + ")" : ""}`);
  for (const [route, target] of Object.entries(pages)) {
    if (route !== "/") console.log(`→ http://127.0.0.1:${port}${route}   → ${target}`);
  }
  if (apiPrefixes.length) console.log(`   proxying ${apiPrefixes.join(", ")}  → ${api}`);
  for (const [prefix, upstream] of routes) console.log(`   proxying ${prefix}  → ${upstream}`);
  return server;
}
