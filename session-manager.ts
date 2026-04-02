/**
 * session-manager.ts
 * 
 * In-memory CRUD for browser sessions.
 * Each session = one Chromium process launched with --remote-debugging-port.
 * The raw Chrome CDP WebSocket URL is stored internally and exposed only to
 * the cdp-proxy (never sent to external callers).
 */

import { chromium } from 'playwright';
import { createServer as createNetServer } from 'net';
import fs from 'fs/promises';
import path from 'path';
import type { SessionInfo, BrowserSession, HibernatedSession, Viewport } from './types.js';

const CHROMIUM_ARGS = [
    '--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-background-timer-throttling', '--mute-audio',
];

const IDLE_TIMEOUT_MS      = 5  * 60 * 1000;  // active → idle after 5 min with 0 connections
const HIBERNATE_TIMEOUT_MS = 30 * 60 * 1000;  // idle → hibernated after 30 min
const IDLE_CHECK_MS        = 60 * 1000;
const HIBERNATE_DIR        = process.env.HIBERNATE_DIR ?? './hibernate-data';

// ── State ─────────────────────────────────────────────────────────────────────

const sessions   = new Map<string, BrowserSession>();
const hibernated = new Map<string, HibernatedSession>();  // in-memory index

// ── Helpers ───────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createNetServer();
        srv.listen(0, () => {
            const port = (srv.address() as import('net').AddressInfo).port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

async function pageState(s: BrowserSession): Promise<{ url?: string; title?: string }> {
    try {
        const pages = s.browser.contexts()[0]?.pages() ?? [];
        const page  = pages.find(p => !p.url().startsWith('about:')) ?? pages[0];
        if (!page) return {};
        return { url: page.url(), title: await page.title().catch(() => undefined) };
    } catch { return {}; }
}

function toInfo(id: string, s: BrowserSession, extra: { url?: string; title?: string } = {}): SessionInfo {
    return { sessionId: id, userId: s.userId, status: s.status, createdAt: s.createdAt,
             lastActiveAt: s.lastActiveAt, viewport: s.viewport, connections: s.connections, ...extra };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Retry fetching Chrome's CDP WS URL — Chrome may not be ready immediately after launch */
async function getCDPUrl(port: number, retries = 10, delayMs = 200): Promise<string> {
    for (let i = 0; i < retries; i++) {
        try {
            const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`)
                .then(r => r.json()) as { webSocketDebuggerUrl: string };
            if (webSocketDebuggerUrl) return webSocketDebuggerUrl;
        } catch {}
        await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error(`Chrome CDP not ready on port ${port} after ${retries} retries`);
}

// ── Public CRUD ───────────────────────────────────────────────────────────────

export async function createSession(sessionId: string, opts: { userId: string; viewport?: Viewport }): Promise<SessionInfo> {
    if (sessions.has(sessionId)) return toInfo(sessionId, sessions.get(sessionId)!);

    const viewport  = opts.viewport ?? { width: 1280, height: 720 };
    const debugPort = await freePort();
    const browser   = await chromium.launch({
        headless: process.env.HEADLESS !== 'false',
        args: [...CHROMIUM_ARGS, `--remote-debugging-port=${debugPort}`],
    });

    const wsUrl = await getCDPUrl(debugPort);

    const now = Date.now();
    const session: BrowserSession = {
        browser, wsUrl, debugPort, userId: opts.userId,
        createdAt: now, lastActiveAt: now, viewport, connections: 0, status: 'active',
    };

    browser.on('disconnected', () => sessions.delete(sessionId));
    sessions.set(sessionId, session);

    return toInfo(sessionId, session);
}

export async function getSession(sessionId: string): Promise<SessionInfo | null> {
    const s = sessions.get(sessionId);
    return s ? toInfo(sessionId, s, await pageState(s)) : null;
}

export async function listSessions(userId?: string): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    for (const [id, s] of sessions) {
        if (userId && s.userId !== userId) continue;
        out.push(toInfo(id, s, await pageState(s)));
    }
    return out;
}

export function sessionIdsForUser(userId: string): string[] {
    return [...sessions.entries()].filter(([, s]) => s.userId === userId).map(([id]) => id);
}

export async function deleteSession(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    await s.browser.close().catch(() => {});
}

export async function deleteAllForUser(userId: string): Promise<number> {
    const ids = sessionIdsForUser(userId);
    await Promise.all(ids.map(deleteSession));
    return ids.length;
}

export async function deleteAllSessions(): Promise<void> {
    await Promise.all([...sessions.keys()].map(deleteSession));
}

// ── Hibernate / Restore ───────────────────────────────────────────────────────

export async function hibernateSession(sessionId: string): Promise<boolean> {
    const s = sessions.get(sessionId);
    if (!s) return false;

    const pages = s.browser.contexts()[0]?.pages() ?? [];
    const page  = pages.find(p => !p.url().startsWith('about:')) ?? pages[0];
    const url   = page?.url() ?? 'about:blank';

    const data: HibernatedSession = {
        sessionId, userId: s.userId, url,
        viewport: s.viewport,
        hibernatedAt: Date.now(),
        createdAt: s.createdAt,
    };

    sessions.delete(sessionId);
    await s.browser.close().catch(() => {});

    hibernated.set(sessionId, data);
    await fs.mkdir(HIBERNATE_DIR, { recursive: true });
    await fs.writeFile(path.join(HIBERNATE_DIR, `${sessionId}.json`), JSON.stringify(data));

    console.log(`[browser-manager] ${sessionId} → hibernated (url: ${url})`);
    return true;
}

export async function restoreSession(sessionId: string): Promise<SessionInfo | null> {
    let data = hibernated.get(sessionId);
    if (!data) {
        // Try loading from disk (e.g. after process restart)
        try {
            data = JSON.parse(await fs.readFile(path.join(HIBERNATE_DIR, `${sessionId}.json`), 'utf-8'));
        } catch { return null; }
    }

    const info = await createSession(sessionId, { userId: data!.userId, viewport: data!.viewport });

    // Navigate to saved URL
    if (data!.url && data!.url !== 'about:blank') {
        const s = sessions.get(sessionId);
        const page = s?.browser.contexts()[0]?.pages()[0];
        await page?.goto(data!.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    hibernated.delete(sessionId);
    await fs.unlink(path.join(HIBERNATE_DIR, `${sessionId}.json`)).catch(() => {});

    console.log(`[browser-manager] ${sessionId} → restored`);
    return info;
}

export function getHibernated(sessionId: string): HibernatedSession | undefined {
    return hibernated.get(sessionId);
}

export async function listHibernated(userId?: string): Promise<HibernatedSession[]> {
    // Merge in-memory + disk (handles process restarts)
    try {
        const files = await fs.readdir(HIBERNATE_DIR);
        for (const f of files.filter(f => f.endsWith('.json'))) {
            const id = f.replace('.json', '');
            if (!hibernated.has(id)) {
                try {
                    const d: HibernatedSession = JSON.parse(await fs.readFile(path.join(HIBERNATE_DIR, f), 'utf-8'));
                    hibernated.set(id, d);
                } catch {}
            }
        }
    } catch {}
    return [...hibernated.values()].filter(d => !userId || d.userId === userId);
}

// ── Internal (used by cdp-proxy only) ────────────────────────────────────────

export function getRawSession(sessionId: string): BrowserSession | undefined {
    return sessions.get(sessionId);
}

export function touchSession(sessionId: string): void {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.lastActiveAt = Date.now();
    if (s.status === 'idle') s.status = 'active';
}

export function setConnections(sessionId: string, delta: 1 | -1): void {
    const s = sessions.get(sessionId);
    if (s) s.connections = Math.max(0, s.connections + delta);
}

// ── Idle checker ──────────────────────────────────────────────────────────────

setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (s.connections > 0) continue;
        const idle = now - s.lastActiveAt;
        if (s.status === 'active' && idle > IDLE_TIMEOUT_MS) {
            s.status = 'idle';
            console.log(`[browser-manager] ${id} → idle`);
        } else if (s.status === 'idle' && idle > HIBERNATE_TIMEOUT_MS) {
            hibernateSession(id).catch(e => console.error(`[browser-manager] hibernate ${id} failed:`, e));
        }
    }
}, IDLE_CHECK_MS).unref();
