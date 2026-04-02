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
const CHROMIUM_ARGS = [
    '--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-background-timer-throttling', '--mute-audio',
];
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // active → idle after 5 min with 0 connections
const IDLE_CHECK_MS = 60 * 1000;
// ── State ─────────────────────────────────────────────────────────────────────
const sessions = new Map();
// ── Helpers ───────────────────────────────────────────────────────────────────
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createNetServer();
        srv.listen(0, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}
async function pageState(s) {
    try {
        const pages = s.browser.contexts()[0]?.pages() ?? [];
        const page = pages.find(p => !p.url().startsWith('about:')) ?? pages[0];
        if (!page)
            return {};
        return { url: page.url(), title: await page.title().catch(() => undefined) };
    }
    catch {
        return {};
    }
}
function toInfo(id, s, extra = {}) {
    return { sessionId: id, userId: s.userId, status: s.status, createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt, viewport: s.viewport, connections: s.connections, ...extra };
}
// ── Public CRUD ───────────────────────────────────────────────────────────────
export async function createSession(sessionId, opts) {
    if (sessions.has(sessionId))
        return toInfo(sessionId, sessions.get(sessionId));
    const viewport = opts.viewport ?? { width: 1280, height: 720 };
    const debugPort = await freePort();
    const browser = await chromium.launch({
        headless: process.env.HEADLESS !== 'false',
        args: [...CHROMIUM_ARGS, `--remote-debugging-port=${debugPort}`],
    });
    const { webSocketDebuggerUrl: wsUrl } = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
        .then(r => r.json());
    const now = Date.now();
    const session = {
        browser, wsUrl, debugPort, userId: opts.userId,
        createdAt: now, lastActiveAt: now, viewport, connections: 0, status: 'active',
    };
    browser.on('disconnected', () => sessions.delete(sessionId));
    sessions.set(sessionId, session);
    const page = browser.contexts()[0]?.pages()[0];
    if (page)
        await page.setViewportSize(viewport).catch(() => { });
    return toInfo(sessionId, session);
}
export async function getSession(sessionId) {
    const s = sessions.get(sessionId);
    return s ? toInfo(sessionId, s, await pageState(s)) : null;
}
export async function listSessions(userId) {
    const out = [];
    for (const [id, s] of sessions) {
        if (userId && s.userId !== userId)
            continue;
        out.push(toInfo(id, s, await pageState(s)));
    }
    return out;
}
export function sessionIdsForUser(userId) {
    return [...sessions.entries()].filter(([, s]) => s.userId === userId).map(([id]) => id);
}
export async function deleteSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s)
        return;
    sessions.delete(sessionId);
    await s.browser.close().catch(() => { });
}
export async function deleteAllForUser(userId) {
    const ids = sessionIdsForUser(userId);
    await Promise.all(ids.map(deleteSession));
    return ids.length;
}
// ── Internal (used by cdp-proxy only) ────────────────────────────────────────
export function getRawSession(sessionId) {
    return sessions.get(sessionId);
}
export function touchSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s)
        return;
    s.lastActiveAt = Date.now();
    if (s.status === 'idle')
        s.status = 'active';
}
export function setConnections(sessionId, delta) {
    const s = sessions.get(sessionId);
    if (s)
        s.connections = Math.max(0, s.connections + delta);
}
// ── Idle checker ──────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions)
        if (s.connections === 0 && s.status === 'active' && now - s.lastActiveAt > IDLE_TIMEOUT_MS) {
            s.status = 'idle';
            console.log(`[browser-manager] ${id} → idle`);
        }
}, IDLE_CHECK_MS);
//# sourceMappingURL=session-manager.js.map