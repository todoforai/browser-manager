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

import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import { getRawSession, touchSession, setConnections } from './session-manager.js';

export function attachCDPProxy(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const match = req.url?.match(/^\/cdp\/([^/?]+)/);
        if (!match) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, match[1]));
    });

    wss.on('connection', (client: WebSocket, sessionId: string) => {
        const session = getRawSession(sessionId);
        if (!session) { client.close(4404, 'Session not found'); return; }

        setConnections(sessionId, 1);
        touchSession(sessionId);

        const chrome = new WebSocket(session.wsUrl);

        // One-shot teardown — safe to call from either side
        let torn = false;
        const teardown = (clientCode?: number, clientReason?: string) => {
            if (torn) return;
            torn = true;
            setConnections(sessionId, -1);
            if (client.readyState === WebSocket.OPEN) clientCode ? client.close(clientCode, clientReason) : client.close();
            if (chrome.readyState !== WebSocket.CLOSED && chrome.readyState !== WebSocket.CLOSING) chrome.close();
        };

        chrome.on('open', () => {
            chrome.on('message', (data, binary) => {
                if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
                touchSession(sessionId);
            });
            client.on('message', (data, binary) => {
                if (chrome.readyState === WebSocket.OPEN) chrome.send(data, { binary });
                touchSession(sessionId);
            });
        });

        chrome.on('close', ()  => teardown());
        chrome.on('error', ()  => teardown(4500, 'Chrome error'));
        client.on('close', ()  => teardown());
    });
}
