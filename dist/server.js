#!/usr/bin/env node
/**
 * server.ts — entry point
 *
 * Two servers:
 *   adminServer (:8085) — CDP WebSocket proxy (internal, no auth)
 *   httpServer  (:8086) — REST API for session CRUD + health
 */
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import 'dotenv/config';
import { getConfig } from './config.js';
import sessionsRouter from './api.js';
import { attachCDPProxy } from './cdp-proxy.js';
const config = getConfig();
// ── HTTP server (REST API) ────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: config.cors.origins, credentials: true }));
app.use(express.json());
app.get('/health', (_req, res) => res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
}));
app.use('/api/sessions', sessionsRouter);
const httpServer = createServer(app);
// ── Admin server (CDP proxy, internal only) ───────────────────────────────────
const adminServer = createServer();
attachCDPProxy(adminServer);
// ── Start ─────────────────────────────────────────────────────────────────────
function listen(srv, port, label) {
    return new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, config.host, () => { console.log(`🌐 ${label} :${port}`); resolve(); });
    });
}
async function start() {
    await listen(adminServer, config.adminPort, 'CDP proxy (admin)');
    await listen(httpServer, config.port, 'REST API');
    console.log(`📊 Health: http://localhost:${config.port}/health`);
    const shutdown = async (sig) => {
        console.log(`\n🛑 ${sig}`);
        httpServer.close();
        adminServer.close();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
start().catch(e => { console.error('❌', e); process.exit(1); });
//# sourceMappingURL=server.js.map