import type { Browser } from 'playwright-core';

export type SessionStatus = 'active' | 'idle' | 'hibernated';

/** Upstream proxy for a session. Set once at launch so the whole browser process
 *  egresses through one IP; persisted so restore reuses the same sticky identity. */
export interface ProxyConfig {
    server: string;        // http://host:port or socks5://host:port
    username?: string;
    password?: string;
    bypass?: string;       // comma-separated hosts that skip the proxy
}

/** Per-session stealth/identity knobs. Kept together so create → hibernate →
 *  restore all carry the same identity (a session that changes IP/timezone on
 *  restore is an instant anti-bot flag). */
export interface StealthOptions {
    proxy?: ProxyConfig;
    locale?: string;       // e.g. 'en-US' — drives navigator.language + Accept-Language
    timezone?: string;     // IANA id, e.g. 'America/New_York' — must match proxy geo
}

export interface HibernatedSession {
    sessionId: string;
    userId: string;
    url: string;
    viewport: Viewport;
    stealth?: StealthOptions;
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
    cdpUrl: string;   // Reconnect endpoint: <CDP_PUBLIC_URL>/cdp/<sessionId>
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
    stealth?: StealthOptions;
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
