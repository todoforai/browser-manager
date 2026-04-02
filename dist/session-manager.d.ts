/**
 * session-manager.ts
 *
 * In-memory CRUD for browser sessions.
 * Each session = one Chromium process launched with --remote-debugging-port.
 * The raw Chrome CDP WebSocket URL is stored internally and exposed only to
 * the cdp-proxy (never sent to external callers).
 */
import type { SessionInfo, BrowserSession, Viewport } from './types.js';
export declare function createSession(sessionId: string, opts: {
    userId: string;
    viewport?: Viewport;
}): Promise<SessionInfo>;
export declare function getSession(sessionId: string): Promise<SessionInfo | null>;
export declare function listSessions(userId?: string): Promise<SessionInfo[]>;
export declare function sessionIdsForUser(userId: string): string[];
export declare function deleteSession(sessionId: string): Promise<void>;
export declare function deleteAllForUser(userId: string): Promise<number>;
export declare function getRawSession(sessionId: string): BrowserSession | undefined;
export declare function touchSession(sessionId: string): void;
export declare function setConnections(sessionId: string, delta: 1 | -1): void;
