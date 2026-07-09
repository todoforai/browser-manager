/**
 * session-manager.ts
 * 
 * In-memory CRUD for browser sessions.
 * Each session = one Chromium process launched with --remote-debugging-port.
 * The raw Chrome CDP WebSocket URL is stored internally and exposed only to
 * the cdp-proxy (never sent to external callers).
 */

// Launched via CloakBrowser's launchPersistentContext(): a non-incognito profile
// on disk so cookies/localStorage/device-trust survive across sessions and
// hibernation (a cold incognito browser is the biggest bot tell). We still pass
// --remote-debugging-port so the CDP relay (cdp-proxy.ts) is unchanged.
import { launchPersistentContext } from 'cloakbrowser';
import { createServer as createNetServer } from 'net';
import fs from 'fs/promises';
import path from 'path';
import type { SessionInfo, BrowserSession, HibernatedSession, Viewport, StealthOptions } from './types.js';

// Infra-only flags (containerization). Stealth args (incl. --no-sandbox and the
// --enable-automation exclusion) come from CloakBrowser, so we DON'T repeat
// --no-sandbox here — duplicating it is what surfaced Chromium's yellow
// "unsupported command-line flag" infobar, itself an automation tell.
// --disable-infobars hides that bar (and any residual automation banner).
const CHROMIUM_ARGS = [
    '--disable-dev-shm-usage', '--disable-infobars',
    '--disable-background-timer-throttling', '--mute-audio',
];

// Optional Pro tier: newest binary + anti-bot patches. Empty → free v146.
const CLOAK_LICENSE_KEY = process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || undefined;

const IDLE_TIMEOUT_MS      = 5  * 60 * 1000;  // active → idle after 5 min with 0 connections
const HIBERNATE_TIMEOUT_MS = 30 * 60 * 1000;  // idle → hibernated after 30 min
const IDLE_CHECK_MS        = 60 * 1000;
// Session IDs index on-disk paths (hibernate JSON, persistent profile dir), so a
// caller-supplied id must never escape its directory. Service-created ids are
// UUIDs, but delete/restore/hibernate accept arbitrary ids from the API — reject
// anything that isn't a single safe path segment before it reaches the fs.
function safeId(id: string): string {
    if (!id || id.includes('/') || id.includes('\\') || id === '.' || id === '..' || id.includes('\0'))
        throw new Error('invalid session id');
    return id;
}

const HIBERNATE_DIR        = process.env.HIBERNATE_DIR ?? './hibernate-data';
const hibernatePath = (id: string) => path.join(HIBERNATE_DIR, `${safeId(id)}.json`);

// Persistent Chromium profiles live one-per-session on disk. Keeping them keyed
// by sessionId (not userId) lets a user run several independent identities, and
// makes hibernate→restore reuse the exact same warm profile: cookies/localStorage
// are already there, so restore lands already-logged-in instead of cold.
const PROFILE_DIR   = process.env.PROFILE_DIR ?? './profiles';
const profilePath   = (id: string) => path.join(PROFILE_DIR, safeId(id));

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
        const pages = s.context.pages();
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

/** Pull the effective timezone/locale back out of the *running* browser so the
 *  stored identity reflects what geoip actually resolved (launchPersistentContext
 *  resolves geoip internally and doesn't hand us the flags). Keeps the original
 *  proxy + behavioral knobs; pins the resolved tz/locale for stable restores. */
async function captureResolvedStealth(
    stealth: StealthOptions | undefined,
    page: import('playwright-core').Page,
    headless: boolean,
): Promise<StealthOptions | undefined> {
    if (!stealth) return undefined;
    const effective = await page.evaluate(() => {
        const opts = Intl.DateTimeFormat().resolvedOptions();
        return { timezone: opts.timeZone, locale: opts.locale || navigator.language };
    }).catch(() => ({ timezone: undefined as string | undefined, locale: undefined as string | undefined }));
    return {
        ...stealth,
        timezone: stealth.timezone ?? effective.timezone,
        locale:   stealth.locale   ?? effective.locale,
        headless,
    };
}

// ── Public CRUD ───────────────────────────────────────────────────────────────

export async function createSession(sessionId: string, opts: { userId: string; viewport?: Viewport; stealth?: StealthOptions }): Promise<SessionInfo> {
    if (sessions.has(sessionId)) return toInfo(sessionId, sessions.get(sessionId)!);

    const viewport  = opts.viewport ?? { width: 1280, height: 720 };
    const stealth   = opts.stealth;
    const debugPort = await freePort();
    // headless defaults on; a per-session override (headless:false) forces headed
    // for login-gated / hard sites. Env HEADLESS=false flips the global default.
    const headless  = stealth?.headless ?? (process.env.HEADLESS !== 'false');

    // Profile dir: created on first launch, reused on restore. profileIsNew lets a
    // failed create clean up after itself without wiping a warm profile a restore
    // is reopening.
    const userDataDir  = profilePath(sessionId);
    const profileIsNew = !(await fs.access(userDataDir).then(() => true, () => false));
    await fs.mkdir(userDataDir, { recursive: true });

    // geoip derives whichever of tz/locale the caller didn't pin from the proxy's
    // exit IP (a half-set identity — e.g. GB proxy + en-US locale — is a flag).
    // humanize (bezier mouse, typing cadence) is on by default; opt out with false.
    let context;
    try {
        context = await launchPersistentContext({
            userDataDir,
            headless,
            licenseKey: CLOAK_LICENSE_KEY,
            proxy: stealth?.proxy,
            locale: stealth?.locale,
            timezone: stealth?.timezone,
            geoip: !!(stealth?.proxy && (!stealth.timezone || !stealth.locale)),
            humanize: stealth?.humanize ?? true,
            args: [...CHROMIUM_ARGS, `--remote-debugging-port=${debugPort}`],
        });
    } catch (e) {
        if (profileIsNew) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        throw e;
    }

    const browser = context.browser()!;
    let wsUrl: string, page;
    try {
        wsUrl = await getCDPUrl(debugPort);
        page  = context.pages()[0] ?? await context.newPage();
    } catch (e) {
        // Never leak the Chromium process if the CDP endpoint never came up.
        await context.close().catch(() => {});
        if (profileIsNew) await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
        throw e;
    }

    // Open one page now (CloakBrowser's stealth-safe context defaults are already
    // applied at launch) so the viewport is set and CDP clients attach immediately.
    await page.setViewportSize(viewport).catch(() => {});

    // Pin the geoip-resolved tz/locale (read back from the running browser) so a
    // hibernate→restore reuses the exact same identity instead of re-resolving.
    const resolvedStealth = await captureResolvedStealth(stealth, page, headless);

    const now = Date.now();
    const session: BrowserSession = {
        browser, context, wsUrl, debugPort, userId: opts.userId,
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
    // If a restore is materializing this session, let it finish first so we don't
    // remove the profile/JSON out from under a launching Chromium (or have restore
    // resurrect a session we just deleted). Delete then operates on a settled state.
    await inflightRestores.get(sessionId)?.catch(() => {});
    // Delete from both active and hibernated state — callers shouldn't care which.
    const s = sessions.get(sessionId);
    if (s) {
        sessions.delete(sessionId);
        await s.context.close().catch(() => {});
        await s.browser.close().catch(() => {});
    }
    hibernated.delete(sessionId);
    await fs.unlink(hibernatePath(sessionId)).catch(() => {});
    // Delete means gone for good — drop the persistent profile so a reused
    // sessionId can't inherit stale cookies (and disk doesn't leak profiles).
    await fs.rm(profilePath(sessionId), { recursive: true, force: true }).catch(() => {});
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

/** Shutdown-only: close every live browser (flushing its persistent profile to
 *  disk) WITHOUT deleting the profile. A restart/redeploy must keep warm profiles;
 *  only an explicit deleteSession() erases one. */
export async function closeAllSessions(): Promise<void> {
    await Promise.all([...sessions.values()].map(async s => {
        await s.context.close().catch(() => {});
        await s.browser.close().catch(() => {});
    }));
    sessions.clear();
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

    const pages = s.context.pages();
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
    // Close the context (flushes cookies/localStorage to the profile dir on disk)
    // but LEAVE the profile in place — restore reuses it to come back warm.
    await s.context.close().catch(() => {});
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
        const page = s?.context.pages()[0];
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
