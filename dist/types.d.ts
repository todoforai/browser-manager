import type { Browser } from 'playwright';
export type SessionStatus = 'starting' | 'active' | 'idle' | 'error';
export interface Viewport {
    width: number;
    height: number;
}
/** Public session info returned to API callers */
export interface SessionInfo {
    sessionId: string;
    userId: string;
    status: SessionStatus;
    createdAt: number;
    lastActiveAt: number;
    viewport: Viewport;
    connections: number;
    url?: string;
    title?: string;
}
/** Internal live session state */
export interface BrowserSession {
    browser: Browser;
    wsUrl: string;
    debugPort: number;
    userId: string;
    createdAt: number;
    lastActiveAt: number;
    viewport: Viewport;
    connections: number;
    status: SessionStatus;
}
export interface ServerConfig {
    port: number;
    adminPort: number;
    host: string;
    cors: {
        origins: string[];
    };
}
