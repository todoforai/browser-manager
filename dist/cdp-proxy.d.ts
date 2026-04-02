/**
 * cdp-proxy.ts
 *
 * Attaches a WebSocket upgrade handler to an HTTP server.
 * Route: /cdp/:sessionId
 *
 * Looks up the live Chrome CDP WebSocket URL from session-manager and
 * relays messages raw in both directions — pure transparent proxy.
 * No auth here; this endpoint is internal only (backend proxies it with auth).
 */
import type { Server } from 'http';
export declare function attachCDPProxy(server: Server): void;
