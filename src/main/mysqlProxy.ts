/**
 * The project proxy for MySQL and MariaDB. The app connects to 127.0.0.1 with any user and
 * password; bbdump answers the handshake itself, then logs in to the real server with the saved
 * account (mysql_native_password or caching_sha2_password, TLS when the database asks for it),
 * into the target database, with the client's own capabilities. After that the bytes are piped
 * both ways: commands and results are never read.
 */
import * as crypto from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs';
import type { MysqlConnection } from '../shared/engines/mysqlUri';
import { readExact } from './pgProtocol';

// Capability flags (https://dev.mysql.com/doc/dev/mysql-server/latest/group__group__cs__capabilities__flags.html)
export const CAP = {
    LONG_PASSWORD: 1,
    CONNECT_WITH_DB: 8,
    COMPRESS: 0x20,
    PROTOCOL_41: 0x200,
    SSL: 0x800,
    SECURE_CONNECTION: 0x8000,
    PLUGIN_AUTH: 0x80000,
    CONNECT_ATTRS: 0x100000,
    PLUGIN_AUTH_LENENC_CLIENT_DATA: 0x200000,
    ZSTD: 0x4000000,
    MFA: 0x10000000,
} as const;

/** What the app must never negotiate with the proxy (no TLS or compression on 127.0.0.1) */
const HIDDEN_FROM_CLIENT = CAP.SSL | CAP.COMPRESS | CAP.ZSTD | CAP.MFA;

export interface Packet { seq: number; payload: Buffer }

export async function readPacket(socket: net.Socket | tls.TLSSocket): Promise<Packet> {
    const header = await readExact(socket, 4);
    const length = header.readUIntLE(0, 3);
    return { seq: header[3], payload: length ? await readExact(socket, length) : Buffer.alloc(0) };
}

export function packet(seq: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = seq & 0xff;
    return Buffer.concat([header, payload]);
}

export interface Greeting {
    serverVersion: string;
    /** 32-bit capabilities (lower and upper halves) */
    caps: number;
    charset: number;
    /** MariaDB's extended capabilities (in the reserved bytes when CLIENT_MYSQL is off) */
    mariaCaps: number;
    salt: Buffer;
    plugin: string;
    raw: Buffer;
    /** Where the two halves of the capabilities sit in `raw` */
    capsLowerAt: number;
    capsUpperAt: number;
}

function cstring(buf: Buffer, at: number): { value: string; next: number } {
    const end = buf.indexOf(0, at);
    const stop = end === -1 ? buf.length : end;
    return { value: buf.subarray(at, stop).toString('utf8'), next: stop + 1 };
}

export function parseGreeting(payload: Buffer): Greeting {
    if (payload[0] === 0xff) throw new Error(errorText(payload));
    if (payload[0] !== 10) throw new Error(`Unsupported MySQL protocol version ${payload[0]}`);
    const version = cstring(payload, 1);
    let at = version.next + 4; // thread id
    const salt1 = payload.subarray(at, at + 8);
    at += 9; // + filler
    const capsLowerAt = at;
    const lower = payload.readUInt16LE(at);
    at += 2;
    const charset = payload[at];
    at += 3; // charset + status
    const capsUpperAt = at;
    const upper = payload.readUInt16LE(at);
    at += 2;
    const caps = (lower | (upper << 16)) >>> 0;
    const saltLength = payload[at];
    at += 1;
    const mariaCaps = (caps & CAP.LONG_PASSWORD) === 0 ? payload.readUInt32LE(at + 6) : 0;
    at += 10;
    let salt2: Buffer = Buffer.alloc(0);
    if (caps & CAP.SECURE_CONNECTION) {
        const length = Math.max(13, saltLength - 8);
        salt2 = payload.subarray(at, at + length);
        at += length;
    }
    // The second part ends with a NUL that is not part of the scramble
    if (salt2.length && salt2[salt2.length - 1] === 0) salt2 = salt2.subarray(0, salt2.length - 1);
    const plugin = caps & CAP.PLUGIN_AUTH ? cstring(payload, at).value : 'mysql_native_password';
    return { serverVersion: version.value, caps, charset, mariaCaps, salt: Buffer.concat([salt1, salt2]), plugin: plugin || 'mysql_native_password', raw: payload, capsLowerAt, capsUpperAt };
}

/** The server's greeting as the app sees it: the same, without TLS, compression or MFA */
export function greetingForClient(greeting: Greeting): Buffer {
    const raw = Buffer.from(greeting.raw);
    const caps = (greeting.caps & ~HIDDEN_FROM_CLIENT) >>> 0;
    raw.writeUInt16LE(caps & 0xffff, greeting.capsLowerAt);
    raw.writeUInt16LE(caps >>> 16, greeting.capsUpperAt);
    return raw;
}

export interface HandshakeResponse {
    caps: number;
    maxPacket: number;
    charset: number;
    mariaCaps: number;
    user: string;
    database?: string;
}

/** The app's login (only its capabilities, packet size and character set are kept) */
export function parseHandshakeResponse(payload: Buffer): HandshakeResponse {
    if (payload.length < 32) throw new Error('This client is too old for the bbdump proxy (protocol 4.1 needed)');
    const caps = payload.readUInt32LE(0);
    if (!(caps & CAP.PROTOCOL_41)) throw new Error('This client is too old for the bbdump proxy (protocol 4.1 needed)');
    if (caps & CAP.SSL && payload.length === 32) throw new Error('The bbdump proxy runs on 127.0.0.1 without TLS: turn TLS off in the app (ssl-mode=DISABLED)');
    const user = cstring(payload, 32);
    let at = user.next;
    let authLength = 0;
    if (caps & CAP.PLUGIN_AUTH_LENENC_CLIENT_DATA) {
        const length = readLenenc(payload, at);
        authLength = length.value;
        at = length.next;
    } else {
        authLength = payload[at];
        at += 1;
    }
    at += authLength;
    const database = caps & CAP.CONNECT_WITH_DB && at < payload.length ? cstring(payload, at).value : undefined;
    return { caps, maxPacket: payload.readUInt32LE(4), charset: payload[8], mariaCaps: payload.readUInt32LE(28), user: user.value, database };
}

function readLenenc(buf: Buffer, at: number): { value: number; next: number } {
    const first = buf[at];
    if (first < 0xfb) return { value: first, next: at + 1 };
    if (first === 0xfc) return { value: buf.readUInt16LE(at + 1), next: at + 3 };
    if (first === 0xfd) return { value: buf.readUIntLE(at + 1, 3), next: at + 4 };
    return { value: Number(buf.readBigUInt64LE(at + 1)), next: at + 9 };
}

function lenenc(n: number): Buffer {
    if (n < 0xfb) return Buffer.from([n]);
    if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xfc; b.writeUInt16LE(n, 1); return b; }
    const b = Buffer.alloc(4); b[0] = 0xfd; b.writeUIntLE(n, 1, 3); return b;
}

const sha1 = (...parts: Buffer[]) => { const h = crypto.createHash('sha1'); for (const p of parts) h.update(p); return h.digest(); };
const sha256 = (...parts: Buffer[]) => { const h = crypto.createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
const xor = (a: Buffer, b: Buffer) => Buffer.from(a.map((byte, i) => byte ^ b[i % b.length]));

/** The scramble a plugin sends for `password` (empty password: empty answer) */
export function scramble(plugin: string, password: string, salt: Buffer): Buffer {
    if (plugin === 'mysql_clear_password') return Buffer.from(`${password}\0`, 'utf8');
    if (!password) return Buffer.alloc(0);
    const pw = Buffer.from(password, 'utf8');
    if (plugin === 'mysql_native_password') {
        const stage1 = sha1(pw);
        return xor(stage1, sha1(salt.subarray(0, 20), sha1(stage1)));
    }
    if (plugin === 'caching_sha2_password') {
        const stage1 = sha256(pw);
        return xor(stage1, sha256(sha256(stage1), salt.subarray(0, 20)));
    }
    throw new Error(`The bbdump proxy cannot log in with the ${plugin} method`);
}

/** The proxy's login to the real server, with the app's capabilities */
export function buildHandshakeResponse(args: {
    caps: number; maxPacket: number; charset: number; mariaCaps: number; user: string; auth: Buffer; database: string; plugin: string;
}): Buffer {
    const head = Buffer.alloc(32);
    head.writeUInt32LE(args.caps >>> 0, 0);
    head.writeUInt32LE(args.maxPacket >>> 0, 4);
    head[8] = args.charset;
    if (!(args.caps & CAP.LONG_PASSWORD)) head.writeUInt32LE(args.mariaCaps >>> 0, 28);
    const parts: Buffer[] = [head, Buffer.from(`${args.user}\0`, 'utf8')];
    if (args.caps & CAP.PLUGIN_AUTH_LENENC_CLIENT_DATA) parts.push(lenenc(args.auth.length), args.auth);
    else parts.push(Buffer.from([args.auth.length]), args.auth);
    if (args.caps & CAP.CONNECT_WITH_DB) parts.push(Buffer.from(`${args.database}\0`, 'utf8'));
    if (args.caps & CAP.PLUGIN_AUTH) parts.push(Buffer.from(`${args.plugin}\0`, 'utf8'));
    return Buffer.concat(parts);
}

/** Capabilities of the proxy's login: the app's, plus what the login itself needs */
export function upstreamCaps(client: number, server: number, useTls: boolean, hasDatabase: boolean): number {
    let caps = client & server;
    caps |= CAP.PROTOCOL_41 | (server & (CAP.SECURE_CONNECTION | CAP.PLUGIN_AUTH | CAP.PLUGIN_AUTH_LENENC_CLIENT_DATA));
    caps &= ~(CAP.COMPRESS | CAP.ZSTD | CAP.SSL | CAP.CONNECT_ATTRS | CAP.MFA | CAP.CONNECT_WITH_DB);
    if (hasDatabase) caps |= CAP.CONNECT_WITH_DB;
    if (useTls) caps |= CAP.SSL;
    // CLIENT_MYSQL (bit 0) off: MariaDB reads the extended capabilities; keep the app's choice
    if (client & CAP.LONG_PASSWORD) caps |= CAP.LONG_PASSWORD;
    return caps >>> 0;
}

export function errorText(payload: Buffer): string {
    if (payload[0] !== 0xff) return 'Unexpected answer from the server';
    const code = payload.readUInt16LE(1);
    const text = payload[3] === 0x23 ? payload.subarray(9) : payload.subarray(3);
    return `${text.toString('utf8')} (MySQL error ${code})`;
}

/** An error packet for the app (code 1045: access denied, 2013: lost connection…) */
export function errorPacket(seq: number, message: string, code = 2013): Buffer {
    const body = Buffer.alloc(9);
    body[0] = 0xff;
    body.writeUInt16LE(code, 1);
    body.write('#HY000', 3, 'ascii');
    return packet(seq, Buffer.concat([body, Buffer.from(message.slice(0, 400), 'utf8')]));
}

async function connectTcp(host: string, port: number): Promise<net.Socket> {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(15000);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('timeout', () => { socket.destroy(); reject(new Error(`Connection timeout to ${host}:${port}`)); });
    });
    socket.setTimeout(0);
    return socket;
}

async function startTls(socket: net.Socket, conn: MysqlConnection): Promise<tls.TLSSocket> {
    const options = conn.tls!;
    const secure = tls.connect({
        socket,
        rejectUnauthorized: options.verifyServer,
        ca: options.caFile ? fs.readFileSync(options.caFile) : undefined,
        servername: net.isIP(conn.host) ? undefined : conn.host,
        checkServerIdentity: options.verifyName ? tls.checkServerIdentity : () => undefined,
    });
    await new Promise<void>((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', reject);
    });
    return secure;
}

/**
 * One connection of the app: handshake with it, login to the real server. Returns the server
 * socket, ready to be piped; on failure the app gets an error packet and this throws.
 */
export async function proxyMysqlConnection(client: net.Socket, conn: MysqlConnection, log: (message: string) => void): Promise<net.Socket | tls.TLSSocket> {
    let server: net.Socket | tls.TLSSocket = await connectTcp(conn.host, conn.port);
    let clientSeq = 0;
    try {
        const first = await readPacket(server);
        const greeting = parseGreeting(first.payload);
        log(`server ${greeting.serverVersion}, ${greeting.plugin}`);
        if (conn.tls && !(greeting.caps & CAP.SSL)) throw new Error('The server does not offer TLS, which this database requires');

        // The app logs in to the proxy (its password is not checked: the proxy only listens on 127.0.0.1)
        client.write(packet(0, greetingForClient(greeting)));
        const answer = await readPacket(client);
        clientSeq = answer.seq;
        const app = parseHandshakeResponse(answer.payload);

        // The proxy logs in to the server
        let seq = 1;
        const useTls = !!conn.tls;
        const caps = upstreamCaps(app.caps, greeting.caps, useTls, !!conn.database);
        if (useTls) {
            const request = Buffer.alloc(32);
            request.writeUInt32LE(caps, 0);
            request.writeUInt32LE(app.maxPacket >>> 0, 4);
            request[8] = app.charset;
            if (!(caps & CAP.LONG_PASSWORD)) request.writeUInt32LE(app.mariaCaps >>> 0, 28);
            server.write(packet(seq++, request));
            server = await startTls(server as net.Socket, conn);
        }
        let plugin = greeting.plugin;
        let salt = greeting.salt;
        server.write(packet(seq++, buildHandshakeResponse({
            caps, maxPacket: app.maxPacket, charset: app.charset, mariaCaps: app.mariaCaps,
            user: conn.user, auth: scramble(plugin, conn.password, salt), database: conn.database, plugin,
        })));

        for (let round = 0; round < 8; round++) {
            const reply = await readPacket(server);
            seq = reply.seq + 1;
            const kind = reply.payload[0];
            if (kind === 0x00) {
                // Logged in: the app gets the server's OK, numbered after its own login
                client.write(packet(clientSeq + 1, reply.payload));
                return server;
            }
            if (kind === 0xff) throw new Error(errorText(reply.payload));
            if (kind === 0xfe) {
                // The server asks for another method
                const next = cstring(reply.payload, 1);
                plugin = next.value;
                salt = reply.payload.subarray(next.next);
                if (salt.length && salt[salt.length - 1] === 0) salt = salt.subarray(0, salt.length - 1);
                server.write(packet(seq, scramble(plugin, conn.password, salt)));
                continue;
            }
            if (kind === 0x01) {
                const data = reply.payload.subarray(1);
                if (data.length === 1 && data[0] === 0x03) continue; // fast login: the OK follows
                if (data.length === 1 && data[0] === 0x04) {
                    // Full login: the password in clear over TLS, else encrypted with the server's key
                    server.write(packet(seq, useTls ? Buffer.from(`${conn.password}\0`, 'utf8') : Buffer.from([0x02])));
                    continue;
                }
                if (data.toString('latin1').includes('BEGIN PUBLIC KEY')) {
                    const secret = xor(Buffer.from(`${conn.password}\0`, 'utf8'), salt.subarray(0, 20));
                    const encrypted = crypto.publicEncrypt({ key: data.toString('latin1'), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, secret);
                    server.write(packet(seq, encrypted));
                    continue;
                }
            }
            throw new Error('Unexpected answer from the server during login');
        }
        throw new Error('The login to the server did not finish');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { client.write(errorPacket(clientSeq + 1, `bbdump proxy: ${message}`, /denied/i.test(message) ? 1045 : 2013)); } catch { /* closed */ }
        server.destroy();
        throw error;
    }
}
