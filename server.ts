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
import { startNoiseServer } from './noise-server.js';
import { health } from './service.js';
import { deleteAllSessions } from './session-manager.js';

const config = getConfig();

// ── HTTP server (REST API) ────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: config.cors.origins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json(health()));
app.use('/api/sessions', sessionsRouter);

const httpServer = createServer(app);

// ── Admin server (CDP proxy, internal only) ───────────────────────────────────

const adminServer = createServer();
attachCDPProxy(adminServer);
const noiseServer = startNoiseServer(config.host, config.noisePort);

// ── Start ─────────────────────────────────────────────────────────────────────

function listen(srv: ReturnType<typeof createServer>, port: number, label: string) {
    return new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, config.host, () => { console.log(`🌐 ${label} :${port}`); resolve(); });
    });
}

async function start() {
    await listen(adminServer, config.adminPort, 'CDP proxy (admin)');
    await listen(httpServer,  config.port,      'REST API');
    console.log(`📊 Health: http://localhost:${config.port}/health`);

    const shutdown = async (sig: string) => {
        console.log(`\n🛑 ${sig}`);
        await deleteAllSessions();
        httpServer.close();
        adminServer.close();
        noiseServer?.close();
        process.exit(0);
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(e => { console.error('❌', e); process.exit(1); });
