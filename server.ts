#!/usr/bin/env node

/**
 * server.ts — entry point
 * 
 * Two servers:
 *   cdpServer  (:8620) — CDP WebSocket proxy (internal, no auth)
 *   httpServer (:8600) — REST API for session CRUD + health
 */

import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'crypto';
import cors from 'cors';
import 'dotenv/config';

import { getConfig } from './config.js';
import sessionsRouter from './api.js';
import { attachCDPProxy } from './cdp-proxy.js';
import { startNoiseServer } from './noise-server.js';
import { startAdminServer } from '@shared/web/server-helpers';
import { health, adminListAll, adminListHibernated, adminStats } from './service.js';
import {
    deleteAllSessions,
    deleteSession as deleteBrowserSession,
    hibernateSession as hibernateBrowserSession,
    restoreSession as restoreBrowserSession,
} from './session-manager.js';

const config = getConfig();

// ── HTTP server (REST API) ────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: config.cors.origins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json(health()));
app.use('/api/sessions', sessionsRouter);

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

// Admin UI is served only by adminApp; keep it out of the public static mount.
app.use('/admin', (_req, res) => res.status(404).end());

// Static user UI — see web/index.html. Mounted last so API routes win.
app.use(express.static(webDir));

const httpServer = createServer(app);

// ── Admin server (cross-user dashboard) ──────────────────────────────────────
// Bound to 127.0.0.1:<adminPort> via startAdminServer (two-socket pattern,
// see packages/shared-web/README.md). Loopback is the primary gate; the
// bearer middleware below + nginx `/admin/` 404 are defense-in-depth.

const adminApp = express();
adminApp.use(express.json());

// Bearer admin-key gate on /admin/api/*. Mirrors vault-manager/storage-manager.
// The loopback bind is the primary boundary; this is defense-in-depth.
function safeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}
adminApp.use('/admin/api', (req, res, next) => {
    if (!config.adminKey) return res.status(503).json({ error: 'admin API disabled: BROWSER_MANAGER_ADMIN_KEY not configured' });
    const bearer = (req.headers.authorization || '').trim().match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer || !safeEq(bearer, config.adminKey)) return res.status(401).json({ error: 'admin: invalid token' });
    return next();
});

const wrapA = (fn: (q: express.Request, r: express.Response) => Promise<unknown>) =>
    async (q: express.Request, r: express.Response) => {
        try { await fn(q, r); }
        catch (e) { r.status(500).json({ error: (e as Error).message }); }
    };
adminApp.get   ('/admin/api/stats',               wrapA(async (_q, r) => { r.json(await adminStats()); }));
adminApp.get   ('/admin/api/sessions',            wrapA(async (_q, r) => { r.json(await adminListAll()); }));
adminApp.get   ('/admin/api/sessions/hibernated', wrapA(async (_q, r) => { r.json(await adminListHibernated()); }));
adminApp.post  ('/admin/api/sessions/:id/hibernate', wrapA(async (q, r) => {
    const result = await hibernateBrowserSession(String(q.params.id));
    if (result === 'not_found') return r.status(404).json({ error: 'Session not found' });
    if (result === 'in_use')    return r.status(409).json({ error: 'Session has active connections' });
    r.json({ success: true });
}));
adminApp.post  ('/admin/api/sessions/:id/restore', wrapA(async (q, r) => {
    const info = await restoreBrowserSession(String(q.params.id));
    if (!info) return r.status(404).json({ error: 'No hibernated session found' });
    r.json(info);
}));
adminApp.delete('/admin/api/sessions/:id', wrapA(async (q, r) => {
    await deleteBrowserSession(String(q.params.id));
    r.json({ success: true });
}));
// Serve the admin static UI on the same private socket (so an SSH tunnel
// against :8610 gets both the admin REST + the admin dashboard).
adminApp.get('/', (_req, res) => res.redirect('/admin/'));
adminApp.get('/admin', (_req, res) => res.sendFile(path.join(webDir, 'admin', 'index.html')));
adminApp.get('/admin/', (_req, res) => res.sendFile(path.join(webDir, 'admin', 'index.html')));
adminApp.use('/admin', express.static(path.join(webDir, 'admin')));
adminApp.use('/shared', express.static(path.join(webDir, 'shared')));

// ── CDP proxy server (internal only) ──────────────────────────────────────────

const cdpServer = createServer();
attachCDPProxy(cdpServer);
const noiseServer = startNoiseServer(config.host, config.noisePort);

// ── Start ─────────────────────────────────────────────────────────────────────

function listen(srv: ReturnType<typeof createServer>, port: number, label: string) {
    return new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, config.host, () => { console.log(`🌐 ${label} :${port}`); resolve(); });
    });
}

async function start() {
    await listen(cdpServer,  config.cdpPort, 'CDP proxy');
    await listen(httpServer, config.port,    'REST API');
    const adminServer = await startAdminServer(adminApp, config.adminPort);
    console.log(`📊 Health: http://localhost:${config.port}/health`);

    const shutdown = async (sig: string) => {
        console.log(`\n🛑 ${sig}`);
        await deleteAllSessions();
        httpServer.close();
        adminServer.close();
        cdpServer.close();
        noiseServer?.close();
        process.exit(0);
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(e => { console.error('❌', e); process.exit(1); });
