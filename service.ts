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
    user_id: string;
    viewport?: Viewport;
}

const configuredApiKey = process.env.BROWSER_MANAGER_API_KEY?.trim();

export function requestToken(headers?: { authorization?: string | undefined; 'x-api-key'?: string | undefined }): string | undefined {
    const bearer = headers?.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    return bearer ?? headers?.['x-api-key'];
}

export function requireAuth(token?: string): void {
    if (!configuredApiKey) return;
    if (token?.trim() === configuredApiKey) return;
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
    requireAuth(token);
    return createBrowserSession(crypto.randomUUID(), { userId: input.user_id, viewport: input.viewport });
}

export async function getSession(sessionId: string, token?: string): Promise<SessionInfo | null> {
    requireAuth(token);
    return getBrowserSession(sessionId);
}

export async function listSessions(userId?: string, token?: string): Promise<SessionInfo[]> {
    requireAuth(token);
    return listBrowserSessions(userId);
}

export async function deleteSession(sessionId: string, token?: string): Promise<void> {
    requireAuth(token);
    await deleteBrowserSession(sessionId);
}

export async function deleteAllForUser(userId: string, token?: string): Promise<number> {
    requireAuth(token);
    return deleteBrowserSessionsForUser(userId);
}

export async function hibernateSession(sessionId: string, token?: string): Promise<boolean> {
    requireAuth(token);
    return hibernateBrowserSession(sessionId);
}

export async function restoreSession(sessionId: string, token?: string): Promise<SessionInfo | null> {
    requireAuth(token);
    return restoreBrowserSession(sessionId);
}

export async function listHibernated(userId?: string, token?: string): Promise<HibernatedSession[]> {
    requireAuth(token);
    return listBrowserHibernated(userId);
}
