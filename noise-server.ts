import net from 'net';
import {
    err,
    isCreateBrowserPayload,
    isIdPayload,
    isUserPayload,
    ok,
    parsePayload,
    type NoiseRequest,
    type NoiseResponse,
} from './noise-protocol.js';
import {
    hexToBytes,
    keypairFromSecret,
    readMessage1,
    responderHandshake,
    toTransport,
    transportRead,
    transportWrite,
    writeMessage2,
} from './noise-crypto.js';
import {
    createSession,
    deleteAllForUser,
    deleteSession,
    getSession,
    health,
    hibernateSession,
    listHibernated,
    listSessions,
    restoreSession,
} from './service.js';

const MAX_FRAME = 1024 * 1024;

export function startNoiseServer(host: string, port: number) {
    const localPrivate = process.env.NOISE_LOCAL_PRIVATE_KEY?.trim();
    if (!localPrivate) {
        console.warn('[browser-manager] Noise disabled: missing NOISE_LOCAL_PRIVATE_KEY');
        return null;
    }

    const serverStatic = keypairFromSecret(hexToBytes(localPrivate));

    const server = net.createServer(socket => {
        handleConnection(socket, serverStatic).catch(err => {
            console.warn('[browser-manager] noise connection failed:', err instanceof Error ? err.message : err);
            socket.destroy();
        });
    });

    server.listen(port, host, () => console.log(`🔐 Noise RPC :${port}`));
    return server;
}

async function handleConnection(socket: net.Socket, serverStatic: ReturnType<typeof keypairFromSecret>) {
    const handshake = responderHandshake(serverStatic);
    readMessage1(handshake, await readFrame(socket));
    socket.write(writeFrame(writeMessage2(handshake)));
    const transport = toTransport(handshake);

    while (!socket.destroyed) {
        const frame = await readFrame(socket).catch(() => null);
        if (!frame) return;
        const req = JSON.parse(transportRead(transport, frame).toString('utf8')) as NoiseRequest;
        const res = await dispatch(req);
        socket.write(writeFrame(transportWrite(transport, Buffer.from(JSON.stringify(res)))));
    }
}

async function dispatch(req: NoiseRequest): Promise<NoiseResponse> {
    try {
        switch (req.type) {
            case 'health.get':
                return ok(req.id, health());
            case 'browser.create':
                return ok(req.id, await createSession(parsePayload(req.payload ?? {}, isCreateBrowserPayload), req.token));
            case 'browser.list': {
                const payload = parsePayload(req.payload ?? {}, isUserPayload);
                return ok(req.id, await listSessions(payload.user_id, req.token));
            }
            case 'browser.get': {
                const payload = parsePayload(req.payload ?? {}, isIdPayload);
                const result = await getSession(payload.id, req.token);
                return result ? ok(req.id, result) : err(req.id, 'not_found', 'Session not found');
            }
            case 'browser.delete': {
                const payload = parsePayload(req.payload ?? {}, isIdPayload);
                await deleteSession(payload.id, req.token);
                return ok(req.id, { success: true });
            }
            case 'browser.delete_all': {
                const payload = parsePayload(req.payload ?? {}, isUserPayload);
                if (!payload.user_id) return err(req.id, 'bad_request', 'user_id required');
                return ok(req.id, { deleted: await deleteAllForUser(payload.user_id, req.token) });
            }
            case 'browser.hibernate': {
                const payload = parsePayload(req.payload ?? {}, isIdPayload);
                const result = await hibernateSession(payload.id, req.token);
                return result ? ok(req.id, { success: true }) : err(req.id, 'not_found', 'Session not found');
            }
            case 'browser.restore': {
                const payload = parsePayload(req.payload ?? {}, isIdPayload);
                const result = await restoreSession(payload.id, req.token);
                return result ? ok(req.id, result) : err(req.id, 'not_found', 'No hibernated session found');
            }
            case 'browser.hibernated.list': {
                const payload = parsePayload(req.payload ?? {}, isUserPayload);
                return ok(req.id, await listHibernated(payload.user_id, req.token));
            }
            default:
                return err(req.id, 'bad_request', `Unknown request type: ${req.type}`);
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = message === 'invalid payload' ? 'bad_request' : message === 'invalid api key' ? 'unauthorized' : 'internal';
        return err(req.id, code, message);
    }
}

function writeFrame(data: Buffer): Buffer {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    return Buffer.concat([header, data]);
}

async function readFrame(socket: net.Socket): Promise<Buffer> {
    const lenBuf = await readExact(socket, 4);
    const len = lenBuf.readUInt32BE(0);
    if (len === 0 || len > MAX_FRAME) throw new Error(`invalid frame length: ${len}`);
    return readExact(socket, len);
}

function readExact(socket: net.Socket, len: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;

        const cleanup = () => {
            socket.off('data', onData);
            socket.off('close', onClose);
            socket.off('error', onError);
        };

        const onClose = () => { cleanup(); reject(new Error('connection closed')); };
        const onError = (err: Error) => { cleanup(); reject(err); };
        const onData = (chunk: Buffer) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total < len) return;
            cleanup();
            const buffer = Buffer.concat(chunks);
            const need = buffer.subarray(0, len);
            const rest = buffer.subarray(len);
            if (rest.length) socket.unshift(rest);
            resolve(need);
        };

        socket.on('data', onData);
        socket.once('close', onClose);
        socket.once('error', onError);
        socket.resume();
    });
}
