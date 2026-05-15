# browser-manager

Spawns Chromium instances on demand and exposes each as a raw CDP WebSocket.

## Files

```
browser-manager/
├── types.ts           — SessionInfo, BrowserSession, ServerConfig
├── config.ts          — port/cors + noise config from env
├── session-manager.ts — session CRUD (create/get/list/delete), idle checker
├── service.ts         — shared business logic for REST + Noise
├── noise-protocol.ts  — Noise request/response types + payload guards
├── noise-crypto.ts    — minimal Noise NX + transport crypto helpers
├── noise-server.ts    — TCP Noise RPC server
├── cdp-proxy.ts       — WebSocket relay: /cdp/:sessionId ↔ Chrome CDP WS
├── api.ts             — Express REST routes for session CRUD
└── server.ts          — entry point, wires HTTP + admin + Noise servers
```

## Three servers

| Server | Port | Purpose |
|--------|------|---------|
| REST API | `8086` | session CRUD (`/api/sessions`), health |
| CDP proxy | `8085` | raw CDP WS relay (`/cdp/:sessionId`) — **internal only** |
| Noise RPC | `8087` | encrypted TCP RPC for internal CLI/agent use |

The CDP proxy and Noise RPC ports should never be exposed publicly — the backend proxies them with auth/billing.

## Auth model

Two modes, mutually exclusive per request:

| Mode | Token | Identity | Use case |
|------|-------|----------|----------|
| **User** | login token from `api.todofor.ai/trpc/cli.login` | resolved server-side via `/trpc/auth.resolve` (5min cache) | CLI / agent-browser |
| **Admin** | `BROWSER_MANAGER_ADMIN_KEY` env var | caller picks via `X-Act-As` header (REST) or `act_as` field (Noise) | server-to-server, ops |

CLI users never type a userId — it's derived from their login token. Sessions are scoped to the resolved userId; `list` / `delete-all` only see your own.

Per-user verification calls `api.todofor.ai/api/v1/auth/resolve` (or `http://localhost:4000` in dev based on `NODE_ENV`). No env override — local dev hits the local backend automatically.

## API

```
POST   /api/sessions              { viewport? } → SessionInfo
GET    /api/sessions              → SessionInfo[]   (scoped to caller)
GET    /api/sessions/:sessionId   → SessionInfo
DELETE /api/sessions/:sessionId   → { success }
DELETE /api/sessions              → { deleted: N }  (scoped to caller)

GET    /health                    → { status, uptime, memory }

WS     /cdp/:sessionId            raw CDP WebSocket proxy (admin port)
```

Headers:
- `Authorization: Bearer <token>` — required
- `X-Act-As: <userId>` — admin only

## Noise RPC

The CLI talks to `browser-manager` over `Noise_NX_25519_ChaChaPoly_BLAKE2b` TCP.

Request envelope:

```json
{ "id": "abc123", "type": "browser.create", "token": "tfa_...", "payload": { "viewport": { "width": 1280, "height": 720 } } }
```

Admin envelope (server-side only):
```json
{ "id": "abc123", "type": "browser.list", "token": "<ADMIN_KEY>", "act_as": "user_xyz" }
```

Supported request types:

- `health.get`
- `browser.create`
- `browser.list`
- `browser.get`
- `browser.delete`
- `browser.delete_all`
- `browser.hibernate`
- `browser.restore`
- `browser.hibernated.list`

## CLI

```sh
cd cli && make linux
./build/browser-linux-x86_64 login                  # one-time device login
./build/browser-linux-x86_64 create --width 1280 --height 720
./build/browser-linux-x86_64 list
```

CLI env (rarely needed):

- `BROWSER_NOISE_HOST` — browser-manager host (default: `browser.todofor.ai`)
- `BROWSER_NOISE_PORT` — browser-manager port (default: `4120` prod / `8087` dev)

## Dev

```sh
npm install
npm run install-browsers
npm run dev
```
