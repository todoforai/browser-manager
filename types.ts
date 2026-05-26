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
    adminPort: number;      // Admin REST (cross-user dashboard) — bound to 127.0.0.1, nginx blocks /admin/
    cdpPort: number;        // CDP WebSocket proxy port
    noisePort: number;
    adminKey: string;       // Shared bearer for /admin/api/* (BROWSER_MANAGER_ADMIN_KEY). Empty → admin disabled.
    host: string;
    cors: { origins: string[] };
}
