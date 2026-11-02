/**
 * The project proxy for SQL Server (TDS). The app connects to 127.0.0.1 with any login and
 * without encryption (Encrypt=false); bbdump answers its PRELOGIN itself, logs in to the real
 * server with the saved account (TLS when the database asks for it, the TLS handshake carried in
 * TDS packets as the protocol wants), into the saved database, keeping the app's own options
 * (packet size, language, features). After that the bytes are piped both ways: commands and
 * results are never read. Windows and Entra ID logins are not relayed (the saved SQL login is used).
 */
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as net from 'net';
import * as tls from 'tls';
import { Duplex } from 'stream';
import type { SqlServerConnection } from '../shared/engines/sqlserverUri';
import { readExact } from './pgProtocol';

/** TDS message types */
export const TDS = { PRELOGIN: 0x12, LOGIN7: 0x10, RESPONSE: 0x04 } as const;
const EOM = 0x01;
const HEADER = 8;
const PACKET_SIZE = 4096;

/** PRELOGIN options and encryption values */
const OPT = { VERSION: 0, ENCRYPTION: 1, INSTOPT: 2, THREADID: 3, MARS: 4, TERMINATOR: 0xff } as const;
export const ENCRYPT = { OFF: 0, ON: 1, NOT_SUP: 2, REQ: 3 } as const;

/** The app's login and the server's together must finish in this time */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Payload cut into the TDS packets of one message (the last one flagged end of message) */
export function tdsPackets(type: number, payload: Buffer, size = PACKET_SIZE): Buffer {
    const room = size - HEADER;
    const parts: Buffer[] = [];
    let id = 1;
    let at = 0;
    do {
        const chunk = payload.subarray(at, at + room);
        const header = Buffer.alloc(HEADER);
        header[0] = type;
        header[1] = at + room >= payload.length ? EOM : 0;
        header.writeUInt16BE(HEADER + chunk.length, 2);
        header[6] = id++ & 0xff;
        parts.push(header, chunk);
        at += room;
    } while (at < payload.length);
    return Buffer.concat(parts);
}

export interface TdsMessage { type: number; payload: Buffer; raw: Buffer }

/** One whole TDS message (its packets until the end-of-message flag) */
export async function readTdsMessage(socket: net.Socket | tls.TLSSocket, first?: Buffer): Promise<TdsMessage> {
    const payloads: Buffer[] = [];
    const raw: Buffer[] = [];
    let type = -1;
    for (;;) {
        const header = first ?? await readExact(socket, HEADER);
        first = undefined;
        const length = header.readUInt16BE(2);
        if (length < HEADER || length > 32768) throw new Error(`Not a TDS packet (length ${length})`);
        const body = length > HEADER ? await readExact(socket, length - HEADER) : Buffer.alloc(0);
        if (type === -1) type = header[0];
        payloads.push(body);
        raw.push(header, body);
        if (header[1] & EOM) return { type, payload: Buffer.concat(payloads), raw: Buffer.concat(raw) };
    }
}

// --- PRELOGIN ------------------------------------------------------------------------------------

export function parsePrelogin(payload: Buffer): Map<number, Buffer> {
    const options = new Map<number, Buffer>();
    for (let at = 0; at < payload.length && payload[at] !== OPT.TERMINATOR; at += 5) {
        if (at + 5 > payload.length) throw new Error('Truncated PRELOGIN');
        const offset = payload.readUInt16BE(at + 1);
        const length = payload.readUInt16BE(at + 3);
        options.set(payload[at], payload.subarray(offset, offset + length));
    }
    return options;
}

export function buildPrelogin(options: Array<[number, Buffer]>): Buffer {
    const table = Buffer.alloc(options.length * 5 + 1);
    let offset = table.length;
    options.forEach(([token, data], i) => {
        table[i * 5] = token;
        table.writeUInt16BE(offset, i * 5 + 1);
        table.writeUInt16BE(data.length, i * 5 + 3);
        offset += data.length;
    });
    table[table.length - 1] = OPT.TERMINATOR;
    return Buffer.concat([table, ...options.map(([, data]) => data)]);
}

// --- LOGIN7 --------------------------------------------------------------------------------------

/** The password as TDS sends it: UCS-2, each byte's halves swapped then XOR 0xA5 */
export function scramblePassword(password: string): Buffer {
    const bytes = Buffer.from(password, 'utf16le');
    for (let i = 0; i < bytes.length; i++) bytes[i] = (((bytes[i] << 4) & 0xf0) | (bytes[i] >> 4)) ^ 0xa5;
    return bytes;
}

// Offset / length pairs of LOGIN7's variable part, in their order (bytes 36 to 71)
const FIELDS = ['host', 'user', 'password', 'app', 'server', 'extension', 'library', 'language', 'database'] as const;
const FIXED = 36;
const VARIABLE = 94;
const FEATURE_FEDAUTH = 0x02;

export interface Login7 {
    /** The first 36 bytes: length, TDS version, packet size, flags, time zone, LCID */
    fixed: Buffer;
    strings: Record<string, string>;
    clientId: Buffer;
    /** Feature extensions as sent (id, data), when the app sent some */
    features: Array<{ id: number; data: Buffer }> | null;
}

/** The app's LOGIN7, read for its options (its user, password and SSPI data are not kept) */
export function parseLogin7(payload: Buffer): Login7 {
    if (payload.length < VARIABLE) throw new Error('Truncated LOGIN7');
    const strings: Record<string, string> = {};
    let features: Login7['features'] = null;
    FIELDS.forEach((name, i) => {
        const offset = payload.readUInt16LE(FIXED + i * 4);
        const count = payload.readUInt16LE(FIXED + i * 4 + 2);
        if (name === 'extension') {
            // fExtension: a 4-byte offset to the feature extensions
            if (payload[27] & 0x10 && count >= 4 && offset + 4 <= payload.length) {
                let at = payload.readUInt32LE(offset);
                features = [];
                while (at + 5 <= payload.length && payload[at] !== 0xff) {
                    const length = payload.readUInt32LE(at + 1);
                    features.push({ id: payload[at], data: Buffer.from(payload.subarray(at + 5, at + 5 + length)) });
                    at += 5 + length;
                }
            }
            return;
        }
        if (name !== 'password') strings[name] = payload.subarray(offset, offset + count * 2).toString('utf16le');
    });
    return { fixed: Buffer.from(payload.subarray(0, FIXED)), strings, clientId: Buffer.from(payload.subarray(72, 78)), features };
}

/** A LOGIN7 with the app's options and the saved login, server name and database */
export function buildLogin7(app: Login7, login: { user: string; password: string; server: string; database: string }): Buffer {
    const fixed = Buffer.from(app.fixed);
    // A SQL login: no integrated security
    fixed[25] &= ~0x80;
    if (app.features) fixed[27] |= 0x10;
    else fixed[27] &= ~0x10;
    const values: Record<string, Buffer> = {
        host: Buffer.from(app.strings.host ?? '', 'utf16le'),
        user: Buffer.from(login.user, 'utf16le'),
        password: scramblePassword(login.password),
        app: Buffer.from(app.strings.app ?? '', 'utf16le'),
        server: Buffer.from(login.server, 'utf16le'),
        library: Buffer.from(app.strings.library ?? '', 'utf16le'),
        language: Buffer.from(app.strings.language ?? '', 'utf16le'),
        database: Buffer.from(login.database || app.strings.database || '', 'utf16le'),
    };
    const table = Buffer.alloc(VARIABLE - FIXED);
    const data: Buffer[] = [];
    let offset = VARIABLE;
    let pointer: Buffer | null = null;
    FIELDS.forEach((name, i) => {
        table.writeUInt16LE(offset, i * 4);
        if (name === 'extension') {
            if (!app.features) return;
            pointer = Buffer.alloc(4);
            table.writeUInt16LE(4, i * 4 + 2);
            data.push(pointer);
            offset += 4;
            return;
        }
        const value = values[name];
        table.writeUInt16LE(value.length / 2, i * 4 + 2);
        data.push(value);
        offset += value.length;
    });
    app.clientId.copy(table, 72 - FIXED);
    // SSPI, file to attach, new password: none (their offset at the end, no length)
    for (const at of [78, 82, 86]) table.writeUInt16LE(offset, at - FIXED);
    if (app.features && pointer) {
        // Entra ID tokens are not relayed: the saved SQL login is used
        const kept = app.features.filter((f) => f.id !== FEATURE_FEDAUTH);
        const block = Buffer.concat([
            ...kept.map((f) => {
                const head = Buffer.alloc(5);
                head[0] = f.id;
                head.writeUInt32LE(f.data.length, 1);
                return Buffer.concat([head, f.data]);
            }),
            Buffer.from([0xff]),
        ]);
        (pointer as Buffer).writeUInt32LE(offset, 0);
        data.push(block);
    }
    const out = Buffer.concat([fixed, table, ...data]);
    out.writeUInt32LE(out.length, 0);
    return out;
}

function u16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(value, 0); return b; }
function u32(value: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0, 0); return b; }

/** A login error the app shows: an ERROR token, then DONE (error) */
export function errorResponse(message: string, number = 18456): Buffer {
    const server = Buffer.from('bbdump', 'utf16le');
    const body = Buffer.concat([
        u32(number), Buffer.from([1, 14]),
        u16(message.length), Buffer.from(message, 'utf16le'),
        Buffer.from([server.length / 2]), server,
        Buffer.from([0]),
        u32(0),
    ]);
    const token = Buffer.concat([Buffer.from([0xaa]), u16(body.length), body]);
    const done = Buffer.concat([Buffer.from([0xfd]), u16(0x0002), u16(0), Buffer.alloc(8)]);
    return tdsPackets(TDS.RESPONSE, Buffer.concat([token, done]));
}

// --- TLS carried in TDS packets ------------------------------------------------------------------

/**
 * The transport TLS runs on: during the handshake its records travel inside PRELOGIN packets,
 * after it they go on the connection as they are
 */
export class TdsTlsTransport extends Duplex {
    private pending = Buffer.alloc(0);
    private wrapped = true;

    constructor(private readonly socket: net.Socket) {
        super();
        socket.on('data', (chunk: Buffer) => this.receive(chunk));
        socket.on('end', () => this.push(null));
        socket.on('error', (error) => this.destroy(error));
        socket.on('close', () => this.destroy());
        // Read until now with readExact (paused): let the data flow to TLS
        socket.resume();
    }

    /** The handshake is over: records go as they are, both ways */
    unwrap(): void {
        this.wrapped = false;
        if (this.pending.length) {
            this.push(this.pending);
            this.pending = Buffer.alloc(0);
        }
    }

    private receive(chunk: Buffer): void {
        if (!this.wrapped) {
            this.push(chunk);
            return;
        }
        this.pending = Buffer.concat([this.pending, chunk]);
        while (this.pending.length >= HEADER) {
            const length = this.pending.readUInt16BE(2);
            if (length < HEADER) {
                this.destroy(new Error('Not a TDS packet during the TLS handshake'));
                return;
            }
            if (this.pending.length < length) return;
            // Taken out before it is pushed: TLS may finish its handshake (and unwrap) inside push
            const record = this.pending.subarray(HEADER, length);
            this.pending = this.pending.subarray(length);
            this.push(record);
            if (!this.wrapped) {
                if (this.pending.length) this.push(this.pending);
                this.pending = Buffer.alloc(0);
                return;
            }
        }
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
        this.socket.write(this.wrapped ? tdsPackets(TDS.PRELOGIN, chunk) : chunk, done);
    }

    _read(): void { /* data is pushed as it comes */ }

    _destroy(error: Error | null, done: (error: Error | null) => void): void {
        this.socket.destroy();
        done(error);
    }
}

// --- The server ----------------------------------------------------------------------------------

/** The TCP port of a named instance, asked to the SQL Server Browser (UDP 1434) */
export function instancePort(host: string, instance: string, timeoutMs = 5000): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
        const timer = setTimeout(() => { socket.close(); reject(new Error(`The SQL Server Browser of ${host} did not answer for ${instance}`)); }, timeoutMs);
        socket.on('message', (message) => {
            clearTimeout(timer);
            socket.close();
            const port = /;tcp;(\d+)/i.exec(message.subarray(3).toString('latin1'));
            if (port) resolve(Number(port[1]));
            else reject(new Error(`The instance ${instance} does not accept TCP connections`));
        });
        socket.on('error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
        socket.send(Buffer.concat([Buffer.from([0x04]), Buffer.from(instance, 'latin1'), Buffer.from([0])]), 1434, host);
    });
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
        socket.once('connect', () => { socket.setTimeout(0); resolve(socket); });
        socket.once('error', reject);
        socket.once('timeout', () => { socket.destroy(); reject(new Error(`Connection timeout to ${host}:${port}`)); });
    });
}

/** A server connection after its PRELOGIN (and TLS when used), ready for the LOGIN7, with its version */
async function openServer(conn: SqlServerConnection): Promise<{ stream: net.Socket | tls.TLSSocket; version: Buffer }> {
    const port = conn.port ?? await instancePort(conn.server, conn.instanceName ?? '');
    const socket = await connectTcp(conn.server, port);
    try {
        const thread = Buffer.alloc(4);
        thread.writeUInt32BE(process.pid >>> 0, 0);
        socket.write(tdsPackets(TDS.PRELOGIN, buildPrelogin([
            [OPT.VERSION, Buffer.from([0, 0, 0, 0, 0, 0])],
            [OPT.ENCRYPTION, Buffer.from([conn.encrypt ? ENCRYPT.ON : ENCRYPT.NOT_SUP])],
            [OPT.INSTOPT, Buffer.concat([Buffer.from(conn.instanceName ?? '', 'latin1'), Buffer.from([0])])],
            [OPT.THREADID, thread],
            [OPT.MARS, Buffer.from([0])],
        ])));
        const answer = await readTdsMessage(socket);
        if (answer.type !== TDS.RESPONSE) throw new Error('The server did not answer the PRELOGIN');
        const options = parsePrelogin(answer.payload);
        const version = options.get(OPT.VERSION) ?? Buffer.from([0, 0, 0, 0, 0, 0]);
        const encryption = options.get(OPT.ENCRYPTION)?.[0] ?? ENCRYPT.NOT_SUP;
        if (encryption === ENCRYPT.NOT_SUP) {
            if (conn.encrypt) throw new Error('The server does not offer encryption, which this database requires');
            return { stream: socket, version };
        }
        if (encryption !== ENCRYPT.ON && encryption !== ENCRYPT.REQ) throw new Error('The server answered an unexpected encryption mode');
        // A server that requires encryption when the database is saved without it: the certificate is not checked
        const trust = conn.trustServerCertificate || !conn.encrypt;
        const transport = new TdsTlsTransport(socket);
        const name = conn.serverName || conn.server;
        const secure = tls.connect({
            socket: transport as unknown as net.Socket,
            // Through TDS 7, SQL Server speaks TLS 1.2 at most
            maxVersion: 'TLSv1.2',
            rejectUnauthorized: !trust,
            ca: conn.caFile ? fs.readFileSync(conn.caFile) : undefined,
            servername: net.isIP(name) ? undefined : name,
            checkServerIdentity: trust ? () => undefined : (_host, cert) => tls.checkServerIdentity(name, cert),
        });
        await new Promise<void>((resolve, reject) => {
            secure.once('secureConnect', () => { transport.unwrap(); resolve(); });
            secure.once('error', reject);
        });
        return { stream: secure, version };
    } catch (error) {
        socket.destroy();
        throw error;
    }
}

/**
 * One connection of the app: its PRELOGIN answered, its LOGIN7 rewritten with the saved login.
 * Returns the server stream, ready to be piped; on failure the app gets a login error and this throws.
 */
export async function proxySqlServerConnection(client: net.Socket, conn: SqlServerConnection, log: (message: string) => void): Promise<net.Socket | tls.TLSSocket> {
    let server: { stream: net.Socket | tls.TLSSocket; version: Buffer } | null = null;
    let timedOut = false;
    let answered = false;
    const deadline = setTimeout(() => { timedOut = true; server?.stream.destroy(); client.destroy(); }, HANDSHAKE_TIMEOUT_MS);
    try {
        const head = await readExact(client, HEADER);
        // TDS 8 (Encrypt=strict) starts with TLS: not on 127.0.0.1
        if (head[0] === 0x16) throw new Error('the app asks for strict encryption: connect it with Encrypt=false');
        let message = await readTdsMessage(client, head);
        if (message.type === TDS.PRELOGIN) {
            const asked = parsePrelogin(message.payload).get(OPT.ENCRYPTION)?.[0] ?? ENCRYPT.OFF;
            let failure: unknown = null;
            try {
                server = await openServer(conn);
            } catch (error) {
                failure = error;
            }
            client.write(tdsPackets(TDS.RESPONSE, buildPrelogin([
                [OPT.VERSION, server?.version ?? Buffer.from([16, 0, 0, 0, 0, 0])],
                [OPT.ENCRYPTION, Buffer.from([ENCRYPT.NOT_SUP])],
                [OPT.INSTOPT, Buffer.from([0])],
                [OPT.THREADID, Buffer.alloc(0)],
                [OPT.MARS, Buffer.from([0])],
            ])));
            if (asked === ENCRYPT.ON || asked === ENCRYPT.REQ) {
                log('The app asks for encryption, which the proxy does not offer on 127.0.0.1: connect it with Encrypt=false');
            }
            message = await readTdsMessage(client);
            // The app gets the reason with its login
            if (failure) throw failure;
        } else {
            server = await openServer(conn);
        }
        if (message.type !== TDS.LOGIN7) throw new Error('the app did not send a login');
        const login = buildLogin7(parseLogin7(message.payload), {
            user: conn.user, password: conn.password, server: conn.serverName || conn.server, database: conn.database,
        });
        server!.stream.write(tdsPackets(TDS.LOGIN7, login));
        // The server's answer (login acknowledged, or its error) goes to the app as it is
        const answer = await readTdsMessage(server!.stream);
        client.write(answer.raw);
        answered = true;
        clearTimeout(deadline);
        log(`Logged in to ${conn.label} as ${conn.user}`);
        return server!.stream;
    } catch (error) {
        clearTimeout(deadline);
        const reason = timedOut ? 'the login did not finish in time' : error instanceof Error ? error.message : String(error);
        if (!answered && !client.destroyed) {
            try { client.write(errorResponse(`bbdump proxy: ${reason}`)); } catch { /* closed */ }
        }
        server?.stream.destroy();
        throw timedOut ? new Error(reason) : error;
    }
}
