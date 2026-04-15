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

## API

```
POST   /api/sessions              { userId, viewport? } → SessionInfo
GET    /api/sessions?userId=      → SessionInfo[]
GET    /api/sessions/:sessionId   → SessionInfo
DELETE /api/sessions/:sessionId   → { success }
DELETE /api/sessions?userId=      → { deleted: N }

GET    /health                    → { status, uptime, memory }

WS     /cdp/:sessionId            raw CDP WebSocket proxy (admin port)
```

## Noise RPC

The CLI talks to `browser-manager` over `Noise_NX_25519_ChaChaPoly_BLAKE2s` TCP.

Request envelope:

```json
{ "id": "abc123", "type": "browser.create", "token": "tfa_...", "payload": { "user_id": "user123" } }
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

Noise transport authenticates the server. Set `BROWSER_MANAGER_API_KEY` to require `token` on business operations.

## CLI

C CLI:

```sh
cd cli
make linux
./build/browser-linux-x86_64 health
./build/browser-linux-x86_64 create --user user123 --width 1280 --height 720
```

CLI env:

- `NOISE_ADDR` default: `127.0.0.1:8087`
- `NOISE_REMOTE_PUBLIC_KEY` required
- `--token <api-key>` optional, used when `BROWSER_MANAGER_API_KEY` is set

## Dev

```sh
npm install
npm run install-browsers
npm run dev
```
