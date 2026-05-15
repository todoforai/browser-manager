import crypto from 'crypto';
import {
    createSession as createBrowserSession,
    deleteAllForUser as deleteBrowserSessionsForUser,
    deleteSession as deleteBrowserSession,
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

const configuredApiKey = process.env.BROWSER_MANAGER_API_KEY?.trim();

export function requestToken(headers?: { authorization?: string | undefined; 'x-api-key'?: string | undefined }): string | undefined {
    const bearer = headers?.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return bearer ?? headers?.['x-api-key'];
}

// Verify the token and return a stable user identity to scope sessions by.
// Today every CLI ships the same shared `BROWSER_MANAGER_API_KEY`, so all
// callers map to a single "shared" identity. When per-user api_keys land
// (backend HMAC / proxied validation), this is the only place that changes
// — callers already receive a userId and never look at the token directly.
export function requireAuth(token?: string): string {
    if (!configuredApiKey) return 'anonymous';
    if (token?.trim() === configuredApiKey) return 'shared';
    throw new Error('invalid api key');
}

export function health() {
    return {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
    };
}

export async function createSession(input: CreateSessionInput, token?: string): Promise<SessionInfo> {
    const userId = requireAuth(token);
    return createBrowserSession(crypto.randomUUID(), { userId, viewport: input.viewport });
}

export async function getSession(sessionId: string, token?: string): Promise<SessionInfo | null> {
    requireAuth(token);
    return getBrowserSession(sessionId);
}

export async function listSessions(token?: string): Promise<SessionInfo[]> {
    const userId = requireAuth(token);
    return listBrowserSessions(userId);
}

export async function deleteSession(sessionId: string, token?: string): Promise<void> {
    requireAuth(token);
    await deleteBrowserSession(sessionId);
}

export async function deleteAllForCaller(token?: string): Promise<number> {
    const userId = requireAuth(token);
    return deleteBrowserSessionsForUser(userId);
}

export async function hibernateSession(sessionId: string, token?: string) {
    requireAuth(token);
    return hibernateBrowserSession(sessionId);
}

export async function restoreSession(sessionId: string, token?: string): Promise<SessionInfo | null> {
    requireAuth(token);
    return restoreBrowserSession(sessionId);
}

export async function listHibernated(token?: string): Promise<HibernatedSession[]> {
    const userId = requireAuth(token);
    return listBrowserHibernated(userId);
}
