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
import type { HibernatedSession, SessionInfo, Viewport } from './types.js';

export interface CreateSessionInput {
    viewport?: Viewport;
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
 */
async function resolveUserFromToken(token: string): Promise<string | null> {
    const hit = tokenCache.get(token);
    if (hit && hit.expiresAt > Date.now()) return hit.userId;
    if (hit) tokenCache.delete(token);

    let res: Response;
    try {
        res = await fetch(`${TODOFORAI_API}/api/v1/auth/resolve`, {
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
    if (adminKey && t === adminKey) {
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

export async function createSession(input: CreateSessionInput, token?: string, actAs?: string): Promise<SessionInfo> {
    const { userId } = await authenticate(token, actAs);
    return createBrowserSession(crypto.randomUUID(), { userId, viewport: input.viewport });
}

export async function getSession(sessionId: string, token?: string, actAs?: string): Promise<SessionInfo | null> {
    const caller = await authenticate(token, actAs);
    await requireOwner(sessionId, caller);
    return getBrowserSession(sessionId);
}

export async function listSessions(token?: string, actAs?: string): Promise<SessionInfo[]> {
    const { userId } = await authenticate(token, actAs);
    return listBrowserSessions(userId);
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
    return restoreBrowserSession(sessionId);
}

export async function listHibernated(token?: string, actAs?: string): Promise<HibernatedSession[]> {
    const { userId } = await authenticate(token, actAs);
    return listBrowserHibernated(userId);
}
