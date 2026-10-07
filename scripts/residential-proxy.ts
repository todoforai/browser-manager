/**
 * Minimal SOCKS5 egress for browser-manager, run on a machine with a residential IP.
 *
 * Cloudflare challenged our Hetzner (datacenter) exit on every test site, while the
 * same CloakBrowser on a home connection passed. Public internet only: destinations
 * are resolved here and private/loopback/link-local IPv4 is refused (IPv6 is not
 * supported), so cloud browser users can't reach this host's LAN or localhost.
 *
 *   bun scripts/residential-proxy.ts                                   # 127.0.0.1:1080
 *   ssh -N -R 127.0.0.1:1080:127.0.0.1:1080 root@browser.todofor.ai
 *
 * and set DEFAULT_PROXY=socks5://127.0.0.1:1080 in browser-manager's shared/.env.
 */
import net from 'net';
import { lookup } from 'dns/promises';

const PORT = Number(process.env.PORT ?? 1080);
const HANDSHAKE_TIMEOUT_MS = 15_000;

const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const)
    blocked.addSubnet(ip, bits, 'ipv4');

// REP codes: 0 ok, 2 not allowed, 4 host unreachable, 7 command unsupported, 8 address type unsupported.
const reply = (rep: number) => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);

function handle(client: net.Socket) {
    let buf = Buffer.alloc(0);
    let upstream: net.Socket | undefined;
    const close = () => { client.destroy(); upstream?.destroy(); };
    const fail = (rep: number) => { client.end(reply(rep)); upstream?.destroy(); };
    client.on('error', close).on('close', close).setTimeout(HANDSHAKE_TIMEOUT_MS, close);

    let stage: 'greeting' | 'request' | 'connecting' = 'greeting';
    const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length > 4096) return close();
        if (stage === 'greeting') {
            if (buf.length < 2 || buf.length < 2 + buf[1]) return;
            if (buf[0] !== 5) return close();
            const methods = buf.subarray(2, 2 + buf[1]);
            buf = buf.subarray(2 + buf[1]);
            // No auth: the port is only reachable through the ssh tunnel.
            if (!methods.includes(0)) return client.end(Buffer.from([5, 0xff]));
            client.write(Buffer.from([5, 0]));
            stage = 'request';
        }
        if (stage === 'request') {
            if (buf.length < 5) return;
            const [ver, cmd, rsv, atyp] = buf;
            if (ver !== 5 || rsv !== 0) return close();
            if (cmd !== 1) return fail(7);
            if (atyp !== 1 && atyp !== 3) return fail(8);
            const addrLen = atyp === 1 ? 4 : 1 + buf[4];
            if (buf.length < 4 + addrLen + 2) return;
            const host = atyp === 1 ? [...buf.subarray(4, 8)].join('.') : buf.subarray(5, 5 + buf[4]).toString();
            const port = buf.readUInt16BE(4 + addrLen);
            buf = buf.subarray(4 + addrLen + 2);
            stage = 'connecting';
            connect(host, port);
        }
        // stage 'connecting': keep buffering early payload until the upstream is up.
    };
    client.on('data', onData);

    async function connect(host: string, port: number) {
        // Connect to the IP we checked, not the name, so DNS rebinding can't slip past.
        const ip = await lookup(host, { family: 4 }).then(r => r.address, () => undefined);
        if (client.destroyed) return;
        if (!ip) return fail(4);
        if (blocked.check(ip, 'ipv4')) return fail(2);
        upstream = net.connect({ host: ip, port });
        upstream.once('error', () => fail(4));
        upstream.once('connect', () => {
            upstream!.removeAllListeners('error').on('error', close).on('close', close);
            client.off('data', onData).setTimeout(0);
            client.write(reply(0));
            if (buf.length) upstream!.write(buf);
            client.pipe(upstream!).pipe(client);
        });
    }
}

net.createServer(handle).listen(PORT, '127.0.0.1', () => console.log(`residential SOCKS5 on 127.0.0.1:${PORT}`));
