/**
 * session-manager.ts
 * 
 * In-memory CRUD for browser sessions.
 * Each session = one Chromium process launched with --remote-debugging-port.
 * The raw Chrome CDP WebSocket URL is stored internally and exposed only to
 * the cdp-proxy (never sent to external callers).
 */

// CloakBrowser ships a custom Chromium with ~58 source-level C++ fingerprint
// patches (canvas/WebGL/audio/fonts/WebRTC/CDP signals) — antibot systems score
// it as a real browser because it is one. We drive it with plain playwright-core:
// buildLaunchOptions() hands us { executablePath, args, ignoreDefaultArgs, proxy }
// pointing at the patched binary, and we still launch with --remote-debugging-port
// so the CDP relay (cdp-proxy.ts) is unchanged.
import { chromium } from 'playwright-core';
import { buildLaunchOptions } from 'cloakbrowser';
import { createServer as createNetServer } from 'net';
import fs from 'fs/promises';
import path from 'path';
import type { SessionInfo, BrowserSession, HibernatedSession, Viewport, StealthOptions } from './types.js';

// Infra-only flags (containerization). Stealth args come from CloakBrowser.
const CHROMIUM_ARGS = [
    '--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-background-timer-throttling', '--mute-audio',
];

// Optional Pro tier: newest binary + anti-bot patches. Empty → free v146.
const CLOAK_LICENSE_KEY = process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || undefined;

const IDLE_TIMEOUT_MS      = 5  * 60 * 1000;  // active → idle after 5 min with 0 connections
const HIBERNATE_TIMEOUT_MS = 30 * 60 * 1000;  // idle → hibernated after 30 min
const IDLE_CHECK_MS        = 60 * 1000;
const HIBERNATE_DIR        = process.env.HIBERNATE_DIR ?? './hibernate-data';
const hibernatePath = (id: string) => path.join(HIBERNATE_DIR, `${id}.json`);

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

// Public base for the CDP reconnect URL. Prod sets CDP_PUBLIC_URL to the
// auth-proxied wss host; dev falls back to the local CDP proxy port.
const CDP_PUBLIC_URL = (process.env.CDP_PUBLIC_URL
    ?? `ws://localhost:${process.env.BROWSER_MANAGER_CDP_PORT || '8620'}`).replace(/\/$/, '');

function toInfo(id: string, s: BrowserSession, extra: { url?: string; title?: string } = {}): SessionInfo {
    return { sessionId: id, userId: s.userId, status: s.status, createdAt: s.createdAt,
             lastActiveAt: s.lastActiveAt, viewport: s.viewport, connections: s.connections,
             cdpUrl: `${CDP_PUBLIC_URL}/cdp/${id}`, ...extra };
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

/** Pull the effective timezone/locale back out of CloakBrowser's launch flags so
 *  the stored identity reflects what geoip actually resolved. Keeps the original
 *  proxy config; pins the resolved tz/locale for stable restores. */
function captureResolvedStealth(stealth: StealthOptions | undefined, args: string[] | undefined): StealthOptions | undefined {
    if (!stealth) return undefined;
    const flag = (name: string) => args?.find(a => a.startsWith(`${name}=`))?.split('=')[1];
    return {
        ...stealth,
        timezone: stealth.timezone ?? flag('--fingerprint-timezone'),
        locale:   stealth.locale   ?? flag('--fingerprint-locale') ?? flag('--lang'),
    };
}

// ── Public CRUD ───────────────────────────────────────────────────────────────

export async function createSession(sessionId: string, opts: { userId: string; viewport?: Viewport; stealth?: StealthOptions }): Promise<SessionInfo> {
    if (sessions.has(sessionId)) return toInfo(sessionId, sessions.get(sessionId)!);

    const viewport  = opts.viewport ?? { width: 1280, height: 720 };
    const stealth   = opts.stealth;
    const debugPort = await freePort();

    // CloakBrowser resolves the patched binary, proxy, and — via geoip — a
    // timezone/locale that matches the proxy's exit IP, all as binary flags (not
    // detectable CDP emulation). A proxy with geoip is what makes a session
    // "better than local": a fresh, geo-consistent residential identity.
    // Derive whichever of tz/locale the caller didn't pin so the identity is
    // never half-set (e.g. GB proxy + en-US locale = a flag).
    const launchOpts = await buildLaunchOptions({
        headless: process.env.HEADLESS !== 'false',
        licenseKey: CLOAK_LICENSE_KEY,
        proxy: stealth?.proxy,
        locale: stealth?.locale,
        timezone: stealth?.timezone,
        geoip: !!(stealth?.proxy && (!stealth.timezone || !stealth.locale)),
    });
    const browser = await chromium.launch({
        ...launchOpts,
        args: [...(launchOpts.args ?? []), ...CHROMIUM_ARGS, `--remote-debugging-port=${debugPort}`],
    });

    const wsUrl = await getCDPUrl(debugPort);

    // Open one page now (CloakBrowser's stealth-safe context defaults are already
    // applied at launch) so the viewport is set and CDP clients attach immediately.
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page    = context.pages()[0]   ?? await context.newPage();
    await page.setViewportSize(viewport).catch(() => {});

    // Capture the *resolved* identity from the launch flags — geoip may have
    // derived tz/locale from the proxy IP. Persisting these (not just the original
    // request) means a hibernate→restore reuses the exact same identity instead of
    // re-resolving geoip against a proxy whose exit IP may have rotated.
    const resolvedStealth = captureResolvedStealth(stealth, launchOpts.args);

    const now = Date.now();
    const session: BrowserSession = {
        browser, wsUrl, debugPort, userId: opts.userId,
        createdAt: now, lastActiveAt: now, viewport, stealth: resolvedStealth, connections: 0, status: 'active',
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
    // Delete from both active and hibernated state — callers shouldn't care which.
    const s = sessions.get(sessionId);
    if (s) {
        sessions.delete(sessionId);
        await s.browser.close().catch(() => {});
    }
    hibernated.delete(sessionId);
    await fs.unlink(hibernatePath(sessionId)).catch(() => {});
}

export async function deleteAllForUser(userId: string): Promise<number> {
    // Hydrate hibernated index from disk so we catch post-restart entries.
    await listHibernated();
    const ids = new Set([
        ...sessionIdsForUser(userId),
        ...[...hibernated.entries()].filter(([, d]) => d.userId === userId).map(([id]) => id),
    ]);
    await Promise.all([...ids].map(deleteSession));
    return ids.size;
}

export async function deleteAllSessions(): Promise<void> {
    await Promise.all([...sessions.keys()].map(deleteSession));
}

// ── Hibernate / Restore ───────────────────────────────────────────────────────

export type HibernateResult = 'ok' | 'not_found' | 'in_use';

export async function hibernateSession(sessionId: string): Promise<HibernateResult> {
    const s = sessions.get(sessionId);
    if (!s) return 'not_found';
    if (s.connections > 0) {
        console.log(`[browser-manager] hibernate ${sessionId} refused — ${s.connections} active connection(s)`);
        return 'in_use';
    }

    const pages = s.browser.contexts()[0]?.pages() ?? [];
    const page  = pages.find(p => !p.url().startsWith('about:')) ?? pages[0];
    const url   = page?.url() ?? 'about:blank';

    const data: HibernatedSession = {
        sessionId, userId: s.userId, url,
        viewport: s.viewport,
        stealth: s.stealth,
        hibernatedAt: Date.now(),
        createdAt: s.createdAt,
    };

    sessions.delete(sessionId);
    await s.browser.close().catch(() => {});

    hibernated.set(sessionId, data);
    await fs.mkdir(HIBERNATE_DIR, { recursive: true });
    await fs.writeFile(hibernatePath(sessionId), JSON.stringify(data));

    console.log(`[browser-manager] ${sessionId} → hibernated (url: ${url})`);
    return 'ok';
}

const inflightRestores = new Map<string, Promise<SessionInfo | null>>();

export function restoreSession(sessionId: string): Promise<SessionInfo | null> {
    // Coalesce concurrent restores first — `sessions.has()` flips to true mid-restore
    // (after createSession's set), so checking in-flight first ensures all callers
    // wait until the post-launch navigation step has finished.
    const existing = inflightRestores.get(sessionId);
    if (existing) return existing;
    // Already active → return current info (idempotent, also unifies API + auto-restore paths)
    if (sessions.has(sessionId)) return getSession(sessionId);
    const p = restoreSessionInner(sessionId).finally(() => inflightRestores.delete(sessionId));
    inflightRestores.set(sessionId, p);
    return p;
}

async function restoreSessionInner(sessionId: string): Promise<SessionInfo | null> {
    const data = await getHibernated(sessionId);
    if (!data) return null;

    const info = await createSession(sessionId, { userId: data.userId, viewport: data.viewport, stealth: data.stealth });

    // Navigate to saved URL
    if (data.url && data.url !== 'about:blank') {
        const s = sessions.get(sessionId);
        const page = s?.browser.contexts()[0]?.pages()[0];
        await page?.goto(data.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    hibernated.delete(sessionId);
    await fs.unlink(hibernatePath(sessionId)).catch(() => {});

    console.log(`[browser-manager] ${sessionId} → restored`);
    return info;
}

/**
 * Look up a hibernated session by id. Memory first, then disk so process
 * restarts and not-yet-listed entries are visible. Hydrates the index on hit.
 */
export async function getHibernated(sessionId: string): Promise<HibernatedSession | undefined> {
    const mem = hibernated.get(sessionId);
    if (mem) return mem;
    try {
        const data: HibernatedSession = JSON.parse(await fs.readFile(hibernatePath(sessionId), 'utf-8'));
        hibernated.set(sessionId, data);
        return data;
    } catch { return undefined; }
}

export async function listHibernated(userId?: string): Promise<HibernatedSession[]> {
    // Merge in-memory + disk (handles process restarts).
    try {
        const files = await fs.readdir(HIBERNATE_DIR);
        await Promise.all(files.filter(f => f.endsWith('.json')).map(f => getHibernated(f.replace('.json', ''))));
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
