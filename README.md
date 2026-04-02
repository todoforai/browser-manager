# browser-manager

Spawns Chromium instances on demand and exposes each as a raw CDP WebSocket.

## Files

```
browser-manager/
├── types.ts           — SessionInfo, BrowserSession, ServerConfig
├── config.ts          — port/cors config from env
├── session-manager.ts — session CRUD (create/get/list/delete), idle checker
├── cdp-proxy.ts       — WebSocket relay: /cdp/:sessionId ↔ Chrome CDP WS
├── api.ts             — Express REST routes for session CRUD
└── server.ts          — entry point, wires HTTP + admin servers
```

## Two servers

| Server | Port | Purpose |
|--------|------|---------|
| REST API | `8086` | session CRUD (`/api/sessions`), health |
| CDP proxy | `8085` | raw CDP WS relay (`/cdp/:sessionId`) — **internal only** |

The CDP proxy port should never be exposed publicly — the backend proxies it with auth/billing.

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

## Dev

```sh
npm install
npm run install-browsers
npm run dev
```
