import crypto from 'crypto';
import {
    createSession as createBrowserSession,
    deleteAllForUser as deleteBrowserSessionsForUser,
    deleteSession as deleteBrowserSession,
    getRawSession,
    getHibernated,
    getSession as getBrowserSession,
    hibernateSession as hibernateBrowserSession,
    listHibernated as listBrowserHibernated,
    listSessions as listBrowserSessions,
    restoreSession as restoreBrowserSession,
} from './session-manager.js';
import type { HibernatedSession, SessionInfo, Viewport, StealthOptions } from './types.js';

export interface CreateSessionInput {
    viewport?: Viewport;
    stealth?: StealthOptions;
}

// Error codes thrown by authenticate() / requireOwner(). Mapped at the edge (api.ts, noise-server.ts).
export const AUTH_INVALID    = 'invalid api key';
export const AUTH_MISSING_AS = 'admin token requires actAs userId';
export const AUTH_UNAVAIL    = 'auth service unavailable';
export const AUTH_FORBIDDEN  = 'forbidden';

// Server-to-server admin key — when present and matched, the caller bypasses
// per-user token resolution. CLI/agent users never see this key; only the
// TODOforAI backend uses it for ops on behalf of a user (must specify actAs).
const adminKey = process.env.BROWSER_MANAGER_ADMIN_KEY?.trim();

// Constant-time string compare to avoid leaking the admin key via timing.
function safeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a), bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Where to verify per-user CLI/agent tokens. Local dev → local backend, prod → public API.
// Mirrors the NODE_ENV split used in config.ts for CORS.
const TODOFORAI_API = process.env.NODE_ENV === 'production'
    ? 'https://api.todofor.ai'
    : 'http://localhost:4000';

// Token → userId cache. 5 min TTL matches Better Auth's session window.
// Map insertion order = age; oldest evicted first if size exceeds CACHE_LIMIT.
interface CacheEntry { userId: string; expiresAt: number }
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT  = 10_000;
const tokenCache = new Map<string, CacheEntry>();

/**
 * Resolve a token to a userId via the TODOforAI backend's OpenAPI endpoint.
 *   200 → cache + return userId
 *   401/403 → invalid token (return null)
 *   5xx / network → throw AUTH_UNAVAIL
 *
 * Both `Authorization: Bearer` and `X-API-Key` are sent — the backend matches opaque
 * CLI API keys (DB row id) via X-API-Key AND Better Auth session bearers via Authorization
 * in one call. See backend/src/trpc/context.ts:60-90.
 *
 * Device session tokens (`dst_…`, minted for CLIs inside a bridge shell) are not
 * accepted at /api/v1 — they validate only at the /dst/v1 mount. Route by prefix.
 */
async function resolveUserFromToken(token: string): Promise<string | null> {
    const hit = tokenCache.get(token);
    if (hit && hit.expiresAt > Date.now()) return hit.userId;
    if (hit) tokenCache.delete(token);

    const basePath = token.startsWith('dst_') ? '/dst/v1' : '/api/v1';
    let res: Response;
    try {
        res = await fetch(`${TODOFORAI_API}${basePath}/auth/resolve`, {
            headers: { 'authorization': `Bearer ${token}`, 'x-api-key': token },
        });
    } catch (e) {
        console.warn(`[browser-manager] auth.resolve network error: ${e instanceof Error ? e.message : e}`);
        throw new Error(AUTH_UNAVAIL);
    }

    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) {
        console.warn(`[browser-manager] auth.resolve upstream ${res.status}`);
        throw new Error(AUTH_UNAVAIL);
    }

    const body = await res.json().catch(() => null) as { userId?: unknown } | null;
    const userId = body && typeof body.userId === 'string' && body.userId.length > 0 ? body.userId : null;
    if (!userId) return null;

    if (tokenCache.size >= CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value!);
    tokenCache.set(token, { userId, expiresAt: Date.now() + CACHE_TTL_MS });
    return userId;
}

export function requestToken(headers?: { authorization?: string | undefined; 'x-api-key'?: string | undefined }): string | undefined {
    const bearer = headers?.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return bearer ?? headers?.['x-api-key'];
}

/**
 * Resolve caller identity from the bearer token. Two modes:
 *   - Admin: token === BROWSER_MANAGER_ADMIN_KEY → { userId: actAs, isAdmin: true }
 *   - User : token verified via api.todofor.ai → { userId, isAdmin: false }
 * Throws AUTH_INVALID / AUTH_MISSING_AS / AUTH_UNAVAIL.
 */
export async function authenticate(token: string | undefined, actAs?: string): Promise<{ userId: string; isAdmin: boolean }> {
    const t = token?.trim();
    if (!t) throw new Error(AUTH_INVALID);
    if (adminKey && safeEq(t, adminKey)) {
        if (!actAs) throw new Error(AUTH_MISSING_AS);
        return { userId: actAs, isAdmin: true };
    }
    const userId = await resolveUserFromToken(t);
    if (!userId) throw new Error(AUTH_INVALID);
    return { userId, isAdmin: false };
}

/**
 * Ownership check for session-specific ops. Admin bypasses.
 * Checks both the active map and the hibernated index (memory + disk) so a
 * post-restart hibernated session can't be hijacked by a non-owner who guesses
 * the sessionId before listHibernated() is ever called. Silent pass-through if
 * the session doesn't exist anywhere — downstream returns the right 404.
 */
async function requireOwner(sessionId: string, caller: { userId: string; isAdmin: boolean }): Promise<void> {
    if (caller.isAdmin) return;
    const owner = getRawSession(sessionId)?.userId ?? (await getHibernated(sessionId))?.userId;
    if (owner !== undefined && owner !== caller.userId) throw new Error(AUTH_FORBIDDEN);
}

export function health() {
    return {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    };
}

// When CDP auth is enforced, agent-browser must present the caller's token on
// the WS upgrade. Embed it in the returned cdpUrl so `browser connect` works
// out of the box. No-op in dev/internal mode (open proxy). Never embeds the
// server admin key — that's a server-to-server secret, not a browser credential;
// admin callers get a token-less URL and must inject the end-user's token.
function withCdpToken<T extends SessionInfo | null>(info: T, token?: string): T {
    if (!info || process.env.CDP_REQUIRE_AUTH !== 'true') return info;
    if (!token || (adminKey && token === adminKey)) return info;
    const sep = info.cdpUrl.includes('?') ? '&' : '?';
    return { ...info, cdpUrl: `${info.cdpUrl}${sep}token=${encodeURIComponent(token)}` };
}

export async function createSession(input: CreateSessionInput, token?: string, actAs?: string): Promise<SessionInfo> {
    const { userId } = await authenticate(token, actAs);
    return withCdpToken(await createBrowserSession(crypto.randomUUID(), { userId, viewport: input.viewport, stealth: input.stealth }), token);
}

export async function getSession(sessionId: string, token?: string, actAs?: string): Promise<SessionInfo | null> {
    const caller = await authenticate(token, actAs);
    await requireOwner(sessionId, caller);
    return withCdpToken(await getBrowserSession(sessionId), token);
}

export async function listSessions(token?: string, actAs?: string): Promise<SessionInfo[]> {
    const { userId } = await authenticate(token, actAs);
    return (await listBrowserSessions(userId)).map(s => withCdpToken(s, token));
}

export async function deleteSession(sessionId: string, token?: string, actAs?: string): Promise<void> {
    const caller = await authenticate(token, actAs);
    await requireOwner(sessionId, caller);
    await deleteBrowserSession(sessionId);
}

export async function deleteAllForCaller(token?: string, actAs?: string): Promise<number> {
    const { userId } = await authenticate(token, actAs);
    return deleteBrowserSessionsForUser(userId);
}

export async function hibernateSession(sessionId: string, token?: string, actAs?: string) {
    const caller = await authenticate(token, actAs);
    await requireOwner(sessionId, caller);
    return hibernateBrowserSession(sessionId);
}

export async function restoreSession(sessionId: string, token?: string, actAs?: string): Promise<SessionInfo | null> {
    const caller = await authenticate(token, actAs);
    await requireOwner(sessionId, caller);
    return withCdpToken(await restoreBrowserSession(sessionId), token);
}

export async function listHibernated(token?: string, actAs?: string): Promise<HibernatedSession[]> {
    const { userId } = await authenticate(token, actAs);
    return listBrowserHibernated(userId);
}

/**
 * Authorize a CDP WebSocket upgrade for a session.
 * Returns true if the caller's token resolves and they own the session.
 * Enforced only when CDP_REQUIRE_AUTH is set (prod) — internal/dev deploys
 * keep the proxy open so the backend can relay without a user token.
 */
export async function authorizeCdp(sessionId: string, token: string | undefined): Promise<boolean> {
    if (process.env.CDP_REQUIRE_AUTH !== 'true') return true;
    // Unknown session → reject before upgrade (don't leak existence; don't let
    // arbitrary valid tokens reach the connect/restore path for guessed IDs).
    const owner = getRawSession(sessionId)?.userId ?? (await getHibernated(sessionId))?.userId;
    if (owner === undefined) return false;
    let caller: { userId: string; isAdmin: boolean };
    // Admin key has no actAs on a WS upgrade — derive it from the session owner.
    try { caller = await authenticate(token, owner); }
    catch { return false; }
    return caller.isAdmin || owner === caller.userId;
}

// ── Admin-only (cross-user) views ────────────────────────────────────────────
// Used by the /admin/* dashboard. The admin REST server is bound to
// 127.0.0.1:adminPort (nginx returns 404 for /admin/ as defense-in-depth),
// so these functions don't re-authenticate — reachability is the gate.

export async function adminListAll(): Promise<SessionInfo[]> {
    return listBrowserSessions();
}

export async function adminListHibernated(): Promise<HibernatedSession[]> {
    return listBrowserHibernated();
}

export async function adminStats() {
    const [active, hib] = await Promise.all([listBrowserSessions(), listBrowserHibernated()]);
    const users = new Set([...active.map(s => s.userId), ...hib.map(h => h.userId)]);
    return {
        total:      active.length,
        active:     active.filter(s => s.status === 'active').length,
        idle:       active.filter(s => s.status === 'idle').length,
        hibernated: hib.length,
        users:      users.size,
        memory_mb:  Math.round(process.memoryUsage().rss / 1024 / 1024),
        uptime_s:   Math.round(process.uptime()),
    };
}
