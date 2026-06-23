/**
 * cdp-proxy.ts
 * 
 * Attaches a WebSocket upgrade handler to an HTTP server.
 * Route: /cdp/:sessionId
 * 
 * Looks up the live Chrome CDP WebSocket URL from session-manager and
 * relays messages raw in both directions — pure transparent proxy.
 *
 * Auth: when CDP_REQUIRE_AUTH=true (prod), the upgrade is rejected unless
 * `?token=` resolves to the session's owner. Otherwise (internal/dev) the
 * endpoint stays open and the backend relays with auth on the user's behalf.
 */

import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Server } from 'http';
import { getRawSession, touchSession, setConnections, restoreSession } from './session-manager.js';
import { authorizeCdp } from './service.js';
import type { Duplex } from 'stream';

// Reject an upgrade with a complete HTTP response (Content-Length + Connection:
// close) so the reverse proxy reads a full header instead of seeing a premature
// close (which surfaces as a 502).
function reject(socket: Duplex, code: number, text: string): void {
    const body = `${code} ${text}`;
    socket.end(
        `HTTP/1.1 ${code} ${text}\r\n` +
        `Content-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n` +
        body
    );
}

export function attachCDPProxy(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req, socket, head) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const match = url.pathname.match(/^\/cdp\/([^/?]+)/);
        if (!match) { reject(socket, 400, 'Bad Request'); return; }
        const sessionId = match[1];

        if (!(await authorizeCdp(sessionId, url.searchParams.get('token') ?? undefined))) {
            reject(socket, 401, 'Unauthorized');
            return;
        }

        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, sessionId));
    });

    wss.on('connection', async (client: WebSocket, sessionId: string) => {
        // Buffer any client messages that arrive before Chrome is connected
        // (restore can take hundreds of ms; the WS upgrade has already completed).
        const QUEUE_LIMIT = 1024;
        const queued: Array<{ data: RawData; binary: boolean }> = [];
        const earlyMessage = (data: RawData, binary: boolean) => {
            if (queued.length >= QUEUE_LIMIT) { client.close(1009, 'Pre-connect buffer overflow'); return; }
            queued.push({ data, binary });
        };
        // Install close handler immediately so a disconnect during await restore is observed.
        let clientClosed = false;
        const onClientClose = () => { clientClosed = true; };
        client.on('message', earlyMessage);
        client.on('close', onClientClose);

        let session = getRawSession(sessionId);
        if (!session) {
            console.log(`[browser-manager] ${sessionId} → auto-restore on CDP connect`);
            await restoreSession(sessionId).catch(e => console.error(`[browser-manager] restore ${sessionId} failed:`, e));
            session = getRawSession(sessionId);
        }

        // If client gave up during restore, drop everything — never open Chrome WS or count a connection.
        if (clientClosed) { client.off('message', earlyMessage); queued.length = 0; return; }
        if (!session) {
            client.off('message', earlyMessage); queued.length = 0;
            client.close(4404, 'Session not found');
            return;
        }

        setConnections(sessionId, 1);
        touchSession(sessionId);

        const chrome = new WebSocket(session.wsUrl);

        // One-shot teardown — safe to call from either side
        let torn = false;
        const teardown = (clientCode?: number, clientReason?: string) => {
            if (torn) return;
            torn = true;
            client.off('message', earlyMessage);
            queued.length = 0;
            setConnections(sessionId, -1);
            if (client.readyState === WebSocket.OPEN) clientCode ? client.close(clientCode, clientReason) : client.close();
            if (chrome.readyState !== WebSocket.CLOSED && chrome.readyState !== WebSocket.CLOSING) chrome.close();
        };

        chrome.on('open', () => {
            client.off('message', earlyMessage);
            for (const { data, binary } of queued) chrome.send(data, { binary });
            queued.length = 0;

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
        // onClientClose already fires; teardown also gets the close via the same emitter
        client.on('close', ()  => teardown());
    });
}
