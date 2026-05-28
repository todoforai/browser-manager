# @shared/web

Vanilla browser assets + tiny server-side helpers shared across the `*-manager` services (`sandbox-manager`, `storage-manager`, `browser-manager`, `vault-manager`).

No bundler, no TypeScript, no framework — the browser fetches these files directly.

## Two-socket pattern (every manager)

Every manager binds **two sockets**:

| Socket | Bind | Purpose |
|---|---|---|
| Public REST | `0.0.0.0:<base>` | What nginx proxies; user-scoped auth |
| Admin REST  | `127.0.0.1:<base+10>` | Cross-tenant ops; localhost-only is the security boundary |

The 127.0.0.1 bind is the actual security boundary. Public nginx vhosts additionally `return 404` for `/admin/` as defense-in-depth, so leaking the admin port requires both a 0.0.0.0 bind AND an nginx misconfig.

Dev mirrors the split with two dev servers per manager:

| Dev socket | Port | Proxies to |
|---|---|---|
| User UI | `<base+50>` | public REST `<base>` |
| Admin UI | `<base+80>` | admin REST `<base+10>` |

**Server side** (Node services): `import { startAdminServer } from '@shared/web/server-helpers'`. Wraps `express()` + `app.listen(port, '127.0.0.1')` with the localhost-bind invariant baked in.

**Dev side**: each manager's `web/dev-server.js` calls `makeDevServer(...)` twice — one user, one admin. See `storage-manager/web/dev-server.js` for the canonical shape.

## Master port plan (all `*-manager` services)

Each manager owns an 8`X`00 block: `+10` = admin REST, `+20` = noise (internal), `+50` = dev user UI, `+80` = dev admin UI. Blue/green slots use `+2` (so `8200` slot A, `8202` slot B). **Public** noise stream listeners stay at their historical ports (4110/4120) — those are external contracts.

| Manager | REST | Admin REST | Noise (internal) | Public Noise stream | Dev user | Dev admin |
|---|---|---|---|---|---|---|
| **sandbox-manager** | 8200 / 8202 | 8210 / 8212 | 8220 / 8222 | 4110 | 8250 | 8280 |
| **storage-manager** | 8400 | 8410 | 8420 | — | 8450 | 8480 |
| **browser-manager** | 8600 / 8602 | 8610 / 8612 | 8630 / 8632 | 4120 | 8650 | 8680 |
| **vault-manager** | 8800 | 8810 | — | — | 8850 | 8880 |

Browser-manager also has a **CDP proxy** at 8620 / 8622 (slot A/B) — formerly the misnamed `BROWSER_MANAGER_ADMIN_PORT`, now `BROWSER_MANAGER_CDP_PORT`.

Single-instance managers (`storage-manager`, `vault-manager`) don't use blue/green today; slot B is reserved for future use.

### Previous (pre-migration) values

For grep convenience during the cutover: 9000/9002, 9010/9012, 8488/8489, 8086, 8085, 8087, 8090/8092, 8091/8093, 8094/8095, 8290, 8190.

### Env-var contract

| Service | New env vars |
|---|---|
| sandbox-manager | `BIND_ADDR` (REST, default `0.0.0.0:8200`), `ADMIN_BIND_ADDR` (default `127.0.0.1:8210`), `NOISE_BIND_ADDR` (default `0.0.0.0:8220`) |
| storage-manager | `STORAGE_MANAGER_PORT=8400`, `STORAGE_MANAGER_ADMIN_PORT=8410`, `STORAGE_MANAGER_NOISE_PORT=8420` |
| browser-manager | `BROWSER_MANAGER_PORT=8600`, `BROWSER_MANAGER_ADMIN_PORT=8610`, `BROWSER_MANAGER_CDP_PORT=8620` (renamed from `_ADMIN_PORT`), `BROWSER_MANAGER_NOISE_PORT=8630` |
| vault-manager   | `VAULT_MANAGER_PORT=8800`, `VAULT_MANAGER_ADMIN_PORT=8810` |

## Contents

| File | Purpose |
|---|---|
| `theme.css`        | Dark theme tokens (matches `frontend/src/app/globals.css`) + base components (buttons, inputs, tables, stats, sign-in card, top bar, footer) |
| `auth.js`          | `makeAuth(appKey)` → `{ api, getToken, setToken }` with cookie-first / Bearer-fallback auth, 401-aware. Plus `el()`, `$`, `fmtAge/Size/Date`, `renderSignIn()`, `renderTopBar()`, `renderFooter()` |
| `dev-server.js`    | `makeDevServer({ port, api, apiPrefixes, apiRoutes, pages, root })` — Bun dev server: serves `root` statically, proxies API paths to upstream(s) |
| `server-helpers.js`| `startAdminServer(adminApp, port)` — binds an Express admin app to `127.0.0.1:<port>` (the two-socket invariant, codified once) |

## Auth model

- **Prod**: Better Auth shares a session cookie across `*.todofor.ai`. `fetch` includes `credentials: 'include'`; the service auth_extractor accepts the cookie via Redis.
- **Dev / cross-origin**: paste an API key into the sign-in panel; saved to `localStorage` under `<appKey>_panel_token` and sent as `Authorization: Bearer <token>`.
- **401** → `api()` throws `Error('unauthenticated')` with `err.unauth = true`; host page re-renders to show `renderSignIn()`.

## Vendoring model

Each manager lives in its own git repo, so we **vendor** the shared files
into the manager's `web/shared/` directory and commit them. Refresh by running
the manager's `scripts/sync-shared-web.sh` (which copies from
`../packages/shared-web/`).

This means the production deploy needs no extra step — nginx just serves
`web/shared/theme.css` and `web/shared/auth.js` as static files.

## Usage from a manager

In `web/index.html`:

```html
<link rel="stylesheet" href="shared/theme.css">
<script type="module">
  import { makeAuth, el, $, renderSignIn, renderTopBar, renderFooter } from './shared/auth.js';
  const { api, setToken } = makeAuth('sandbox');
  // ...
</script>
```

In `web/dev-server.js` — two `makeDevServer` calls, one per socket:

```js
import { makeDevServer } from "@shared/web/dev-server.js";

const root = new URL("./", import.meta.url);

makeDevServer({                                 // user UI
  port: 8250,
  api: "http://127.0.0.1:8200",
  apiPrefixes: ["/sandbox", "/templates", "/stats", "/health"],
  root,
  label: "sandbox-manager dev (user)",
});

makeDevServer({                                 // admin UI
  port: 8280,
  api: "http://127.0.0.1:8210",
  apiPrefixes: ["/admin/api/"],
  pages: { "/": "/admin.html", "/admin": "/admin.html", "/admin/": "/admin.html" },
  root,
  label: "sandbox-manager dev (admin)",
});
```

In `server.ts` (Node managers — sandbox-manager binds the admin socket in Rust):

```ts
import express from 'express';
import { startAdminServer } from '@shared/web/server-helpers';

const adminApp = express();
adminApp.use(express.json());
adminApp.use('/admin/api', adminRouter);
const adminServer = await startAdminServer(adminApp, config.adminPort);  // 127.0.0.1:8x10
```

## Adding to a manager

1. `package.json`: `"@shared/web": "file:../packages/shared-web"` under `devDependencies`.
2. Add `scripts/sync-shared-web.sh` (one-liner copying `theme.css` + `auth.js` into `web/shared/`).
3. Run it once, commit `web/shared/`.
4. `web/index.html`: reference `shared/theme.css` + `./shared/auth.js`.
5. `web/dev-server.js`: import `makeDevServer` from `@shared/web/dev-server.js`.
