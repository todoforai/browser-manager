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
import { getRawSession, touchSession, setConnections } from './session-manager.js';
export function attachCDPProxy(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const match = req.url?.match(/^\/cdp\/([^/?]+)/);
        if (!match)
            return;
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, match[1]));
    });
    wss.on('connection', (client, sessionId) => {
        const session = getRawSession(sessionId);
        if (!session) {
            client.close(4404, 'Session not found');
            return;
        }
        setConnections(sessionId, 1);
        touchSession(sessionId);
        const chrome = new WebSocket(session.wsUrl);
        chrome.on('open', () => {
            chrome.on('message', (data, binary) => {
                if (client.readyState === WebSocket.OPEN)
                    client.send(data, { binary });
                touchSession(sessionId);
            });
            client.on('message', (data, binary) => {
                if (chrome.readyState === WebSocket.OPEN)
                    chrome.send(data, { binary });
                touchSession(sessionId);
            });
        });
        const cleanup = () => {
            setConnections(sessionId, -1);
            chrome.close();
        };
        chrome.on('close', () => { client.readyState === WebSocket.OPEN && client.close(); cleanup(); });
        chrome.on('error', () => { client.readyState === WebSocket.OPEN && client.close(4500, 'Chrome error'); cleanup(); });
        client.on('close', () => cleanup());
    });
}
//# sourceMappingURL=cdp-proxy.js.map