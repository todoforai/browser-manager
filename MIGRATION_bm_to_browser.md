# Consolidating `bm.todofor.ai` → `browser.todofor.ai`

`browser-manager` historically answered on its own host `bm.todofor.ai`. The
`browsing` service (legacy live-view screencast browser) owns `browser.todofor.ai`
on the **same physical host**. This migration exposes `browser-manager` under a
`/bm/` path prefix on `browser.todofor.ai` so there is **one HTTP hostname** for
browser stuff, while keeping `bm.todofor.ai` alive as a backwards-compat alias.

## Why additive, not a cutover

- The two HTTP apps collide on `/`, `/api/`, `/health`, so `browser-manager` is
  mounted under `/bm/` (nginx strips the prefix).
- **Field CLIs / agents have `bm.todofor.ai:4120` (Noise) compiled in**
  (`browser-manager/cli/main.c:21-22`). Removing `bm.todofor.ai` DNS or the Noise
  port would break every installed binary. So `bm.todofor.ai` stays.
- Noise is L4 TCP on a dedicated port (`noise-stream.conf`) — it does not care
  about the HTTP hostname and needs **no change**.

## What changed in the repos

- `browsing/nginx/browser.todofor.ai.conf` — adds `upstream browser_manager`
  (8600/8602) and a `location ^~ /bm/` that strips the prefix and proxies to it.
  `/bm/admin/` is 404'd at the edge (admin is loopback-only).
- `browser-manager/web/index.html` — panel is now base-path aware: `BASE` is `''`
  on `bm.todofor.ai/` and `/bm` under `browser.todofor.ai/bm/`. All `/api/...`
  calls and the curl/CDP doc examples honour `BASE`.
- `browser-manager/config.ts` — adds `https://browser.todofor.ai` to prod CORS.
- `browser-manager/deploy.sh` — `setup` now hints a SAN cert covering both names.
- `backend/src/config/production.ts` + `backend/nginx/api.todofor.ai.conf` —
  already trust both `browser.todofor.ai` and `bm.todofor.ai`.

## Host-side steps (run on `root@browser.todofor.ai`)

The `browsing` deploy does **not** sync its nginx conf (managed by hand), so apply
the vhost change and cert manually:

```bash
# 1. Issue a SAN cert covering both names (fixes the current "not secure" bug —
#    browser.todofor.ai was serving bm.todofor.ai's cert).
certbot --nginx -d browser.todofor.ai -d bm.todofor.ai

# 2. Install the updated browser.todofor.ai vhost (now with the /bm/ route).
cp /var/www/todoforai/apps/browsing/current/nginx/browser.todofor.ai.conf \
   /etc/nginx/sites-available/browser.todofor.ai
ln -sf /etc/nginx/sites-available/browser.todofor.ai \
   /etc/nginx/sites-enabled/browser.todofor.ai

# 3. Validate + reload (near-zero downtime if nginx -t passes).
nginx -t && systemctl reload nginx

# 4. Verify both surfaces.
curl -sS -o /dev/null -w "%{http_code}\n" https://browser.todofor.ai/bm/health   # browser-manager
curl -sS -o /dev/null -w "%{http_code}\n" https://browser.todofor.ai/health       # browsing
curl -sS -o /dev/null -w "%{http_code}\n" https://bm.todofor.ai/health             # compat alias
```

`browser-manager`'s own deploy keeps managing the `bm.todofor.ai` vhost — leave it
in place as the compat alias.

## Deprecation (later, separate change)

Only after the `/bm/` surface is stable and field CLIs have aged out:

1. Flip the CLI default: `browser-manager/cli/main.c:21`
   `#define DEFAULT_BROWSER_HOST "browser.todofor.ai"` (only affects newly built
   binaries).
2. Optionally redirect `https://bm.todofor.ai/` → `https://browser.todofor.ai/bm/`.
3. Keep `bm.todofor.ai:4120` (Noise) until you can prove no field binary uses it.
