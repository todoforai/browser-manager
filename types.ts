import type { Browser } from 'playwright';

export type SessionStatus = 'active' | 'idle' | 'hibernated';

export interface HibernatedSession {
    sessionId: string;
    userId: string;
    url: string;
    viewport: Viewport;
    hibernatedAt: number;
    createdAt: number;
}

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
    wsUrl: string;   // Chrome CDP websocket URL (internal)
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
    noisePort: number;
    host: string;
    cors: { origins: string[] };
}
