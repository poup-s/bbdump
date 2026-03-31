/**
 * PostgreSQL wire protocol helpers for the proxy.
 * Handles parsing/building of startup messages and authentication
 * (cleartext, MD5, SCRAM-SHA-256).
 */
import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';
import { logger } from './logger';

// Protocol constants
const PG_PROTOCOL_VERSION = 196608; // 3.0
const SSL_REQUEST_CODE = 80877103;

// Backend message type bytes
const MSG_AUTH = 0x52;           // 'R'
const MSG_ERROR = 0x45;          // 'E'
const _MSG_READY = 0x5A;          // 'Z'

// Auth subtypes (inside 'R' messages)
const AUTH_OK = 0;
const AUTH_CLEARTEXT = 3;
const AUTH_MD5 = 5;
const AUTH_SASL = 10;
const AUTH_SASL_CONTINUE = 11;
const AUTH_SASL_FINAL = 12;

export interface BackendMessage {
    type: number;
    data: Buffer;
}

// ---------------------------------------------------------------------------
//  Low-level socket read helpers (paused-mode / 'readable' API)
// ---------------------------------------------------------------------------

/**
 * Read exactly `n` bytes from socket using the pull-based 'readable' API.
 * The socket stays in paused mode throughout — no data loss possible.
 */
function readBytes(socket: net.Socket | tls.TLSSocket, n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (socket.destroyed) {
            reject(new Error('Socket already destroyed'));
            return;
        }

        let collected: Buffer = Buffer.alloc(0);
        let settled = false;

        const tryRead = () => {
            while (collected.length < n) {
                const remaining = n - collected.length;
                const chunk = socket.read(remaining) as Buffer | null;
                if (chunk === null) {
                    // Not enough data yet — wait for more
                    return;
                }
                collected = collected.length === 0 ? Buffer.from(chunk) : Buffer.concat([collected, chunk]);
            }
            // Got all bytes we need
            cleanup();
            resolve(collected);
        };

        const onReadable = () => { tryRead(); };
        const onError = (err: Error) => { if (!settled) { cleanup(); reject(err); } };
        const onClose = () => { if (!settled) { cleanup(); reject(new Error('Socket closed while reading')); } };
        const onEnd = () => { if (!settled) { cleanup(); reject(new Error('Socket ended while reading')); } };

        const cleanup = () => {
            settled = true;
            socket.removeListener('readable', onReadable);
            socket.removeListener('error', onError);
            socket.removeListener('close', onClose);
            socket.removeListener('end', onEnd);
        };

        socket.on('readable', onReadable);
        socket.on('error', onError);
        socket.on('close', onClose);
        socket.on('end', onEnd);

        // Try reading immediately — data may already be buffered
        tryRead();
    });
}

// ---------------------------------------------------------------------------
//  Public read helpers
// ---------------------------------------------------------------------------

/**
 * Read the initial client message (SSLRequest or StartupMessage).
 * These are length-prefixed with NO type byte.
 */
export async function readInitialMessage(socket: net.Socket): Promise<Buffer> {
    const lenBuf = await readBytes(socket, 4);
    const length = lenBuf.readInt32BE(0);
    if (length < 8 || length > 10000) throw new Error(`Invalid initial message length: ${length}`);
    const rest = await readBytes(socket, length - 4);
    return Buffer.concat([lenBuf, rest]);
}

/** Read a single backend message (type byte + int32 length + data). */
export async function readBackendMessage(socket: net.Socket | tls.TLSSocket): Promise<BackendMessage> {
    const header = await readBytes(socket, 5);
    const type = header[0];
    const length = header.readInt32BE(1);
    const data = length > 4 ? await readBytes(socket, length - 4) : Buffer.alloc(0);
    return { type, data };
}

// ---------------------------------------------------------------------------
//  Checks
// ---------------------------------------------------------------------------

export function isSSLRequest(buf: Buffer): boolean {
    return buf.length >= 8 && buf.readInt32BE(0) === 8 && buf.readInt32BE(4) === SSL_REQUEST_CODE;
}

// ---------------------------------------------------------------------------
//  Message builders (server → client)
// ---------------------------------------------------------------------------

export function buildAuthenticationOk(): Buffer {
    const buf = Buffer.alloc(9);
    buf[0] = MSG_AUTH;
    buf.writeInt32BE(8, 1);
    buf.writeInt32BE(AUTH_OK, 5);
    return buf;
}

export function buildErrorResponse(message: string): Buffer {
    // 'E' message: severity + message + null terminator
    const fields = Buffer.from(`SERROR\0MERROR\0C08006\0M${message}\0\0`, 'utf8');
    const buf = Buffer.alloc(1 + 4 + fields.length);
    buf[0] = MSG_ERROR;
    buf.writeInt32BE(4 + fields.length, 1);
    fields.copy(buf, 5);
    return buf;
}

// ---------------------------------------------------------------------------
//  Message builders (client → server)
// ---------------------------------------------------------------------------

export function buildSSLRequest(): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeInt32BE(8, 0);
    buf.writeInt32BE(SSL_REQUEST_CODE, 4);
    return buf;
}

export function buildStartupMessage(user: string, database: string): Buffer {
    const pairs: [string, string][] = [
        ['user', user],
        ['database', database],
        ['client_encoding', 'UTF8'],
    ];
    let dataLen = 0;
    for (const [k, v] of pairs) dataLen += Buffer.byteLength(k) + 1 + Buffer.byteLength(v) + 1;
    dataLen += 1; // trailing null

    const total = 4 + 4 + dataLen;
    const buf = Buffer.alloc(total);
    let off = 0;
    buf.writeInt32BE(total, off); off += 4;
    buf.writeInt32BE(PG_PROTOCOL_VERSION, off); off += 4;
    for (const [k, v] of pairs) {
        off += buf.write(k, off); buf[off++] = 0;
        off += buf.write(v, off); buf[off++] = 0;
    }
    buf[off] = 0;
    return buf;
}

function buildPasswordMessage(payload: string): Buffer {
    const payloadBuf = Buffer.from(payload + '\0', 'utf8');
    const buf = Buffer.alloc(1 + 4 + payloadBuf.length);
    buf[0] = 0x70; // 'p'
    buf.writeInt32BE(4 + payloadBuf.length, 1);
    payloadBuf.copy(buf, 5);
    return buf;
}

// ---------------------------------------------------------------------------
//  Server-side authentication handler
// ---------------------------------------------------------------------------

export interface TargetCredentials {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl?: boolean;
}

/**
 * Connect to the real PostgreSQL server, perform auth, and return the
 * authenticated socket. After this call the next messages on the socket
 * will be ParameterStatus / BackendKeyData / ReadyForQuery.
 */
export async function connectAndAuthenticate(target: TargetCredentials): Promise<net.Socket | tls.TLSSocket> {
    // 1. TCP connect (with 15s timeout)
    logger.info(`[pgProto] TCP connecting to ${target.host}:${target.port}...`);
    let socket: net.Socket | tls.TLSSocket = net.createConnection({ host: target.host, port: target.port });
    socket.setTimeout(15000);
    await new Promise<void>((res, rej) => {
        socket.once('connect', res);
        socket.once('error', rej);
        socket.once('timeout', () => { socket.destroy(); rej(new Error(`Connection timeout to ${target.host}:${target.port}`)); });
    });
    socket.setTimeout(0);
    logger.info(`[pgProto] TCP connected to ${target.host}:${target.port}`);

    // 2. SSL negotiation — always attempt (sslmode=prefer).
    logger.info(`[pgProto] Sending SSLRequest...`);
    socket.write(buildSSLRequest());
    const sslResp = await readBytes(socket, 1);
    logger.info(`[pgProto] SSL response: 0x${sslResp[0].toString(16)} (${sslResp[0] === 0x53 ? 'SSL ok' : 'no SSL'})`);
    if (sslResp[0] === 0x53) { // 'S' — server supports SSL
        socket = tls.connect({ socket: socket as net.Socket, rejectUnauthorized: false });
        await new Promise<void>((res, rej) => {
            (socket as tls.TLSSocket).once('secureConnect', res);
            (socket as tls.TLSSocket).once('error', rej);
        });
        logger.info(`[pgProto] TLS handshake done`);
    } else if (target.ssl) {
        socket.destroy();
        throw new Error('Server does not support SSL but ssl=true is required');
    }

    // 3. Send StartupMessage
    logger.info(`[pgProto] Sending StartupMessage (user=${target.user}, db=${target.database})...`);
    socket.write(buildStartupMessage(target.user, target.database));

    // 4. Auth loop
    let scram: ScramState | null = null;

    while (true) {
        const msg = await readBackendMessage(socket);
        if (msg.type === MSG_ERROR) {
            const errText = msg.data.toString('utf8').replace(/\0/g, ' ').trim();
            throw new Error(`Server auth error: ${errText}`);
        }
        if (msg.type !== MSG_AUTH) {
            throw new Error(`Unexpected message during auth: 0x${msg.type.toString(16)}`);
        }

        const authType = msg.data.readInt32BE(0);
        logger.info(`[pgProto] Auth message type: ${authType}`);

        switch (authType) {
            case AUTH_OK:
                logger.info(`[pgProto] AuthenticationOk received`);
                return socket; // done

            case AUTH_CLEARTEXT:
                logger.info(`[pgProto] Sending cleartext password`);
                socket.write(buildPasswordMessage(target.password));
                break;

            case AUTH_MD5: {
                logger.info(`[pgProto] Sending MD5 password`);
                const salt = msg.data.subarray(4, 8);
                const inner = crypto.createHash('md5').update(target.password + target.user).digest('hex');
                const outer = 'md5' + crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
                socket.write(buildPasswordMessage(outer));
                break;
            }

            case AUTH_SASL: {
                logger.info(`[pgProto] Starting SCRAM-SHA-256`);
                scram = new ScramState();
                socket.write(scram.buildInitialResponse());
                break;
            }

            case AUTH_SASL_CONTINUE: {
                logger.info(`[pgProto] SCRAM continue`);
                if (!scram) throw new Error('SCRAM state missing');
                socket.write(scram.buildClientFinal(msg.data.subarray(4), target.password));
                break;
            }

            case AUTH_SASL_FINAL:
                logger.info(`[pgProto] SCRAM final`);
                break;

            default:
                throw new Error(`Unsupported auth type: ${authType}`);
        }
    }
}

// ---------------------------------------------------------------------------
//  SCRAM-SHA-256 implementation
// ---------------------------------------------------------------------------

class ScramState {
    private clientNonce: string;
    private clientFirstBare: string;
    private serverFirstMsg = '';
    private saltedPassword: Buffer = Buffer.alloc(0) as Buffer;

    constructor() {
        this.clientNonce = crypto.randomBytes(18).toString('base64');
        this.clientFirstBare = `n=,r=${this.clientNonce}`;
    }

    /** Build the SASLInitialResponse message ('p'). */
    buildInitialResponse(): Buffer {
        const clientFirst = `n,,${this.clientFirstBare}`;
        const mechanism = 'SCRAM-SHA-256\0';
        const mechBuf = Buffer.from(mechanism, 'utf8');
        const dataBuf = Buffer.from(clientFirst, 'utf8');

        const totalPayload = mechBuf.length + 4 + dataBuf.length;
        const buf = Buffer.alloc(1 + 4 + totalPayload);
        let off = 0;
        buf[off++] = 0x70; // 'p'
        buf.writeInt32BE(4 + totalPayload, off); off += 4;
        mechBuf.copy(buf, off); off += mechBuf.length;
        buf.writeInt32BE(dataBuf.length, off); off += 4;
        dataBuf.copy(buf, off);
        return buf;
    }

    /** Process server-first-message, compute proof, return SASLResponse. */
    buildClientFinal(serverData: Buffer, password: string): Buffer {
        this.serverFirstMsg = serverData.toString('utf8');

        const parts = this.serverFirstMsg.split(',');
        const serverNonce = parts.find(p => p.startsWith('r='))!.slice(2);
        const salt = Buffer.from(parts.find(p => p.startsWith('s='))!.slice(2), 'base64');
        const iterations = parseInt(parts.find(p => p.startsWith('i='))!.slice(2));

        this.saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
        const clientKey = crypto.createHmac('sha256', this.saltedPassword).update('Client Key').digest();
        const storedKey = crypto.createHash('sha256').update(clientKey).digest();

        const channelBinding = Buffer.from('n,,').toString('base64'); // biws
        const clientFinalNoProof = `c=${channelBinding},r=${serverNonce}`;
        const authMessage = `${this.clientFirstBare},${this.serverFirstMsg},${clientFinalNoProof}`;

        const clientSig = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
        const proof = Buffer.alloc(clientKey.length);
        for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSig[i];

        const clientFinal = `${clientFinalNoProof},p=${proof.toString('base64')}`;
        const dataBuf = Buffer.from(clientFinal, 'utf8');

        const buf = Buffer.alloc(1 + 4 + dataBuf.length);
        buf[0] = 0x70;
        buf.writeInt32BE(4 + dataBuf.length, 1);
        dataBuf.copy(buf, 5);
        return buf;
    }
}

// ---------------------------------------------------------------------------
//  Helper: serialise a BackendMessage back to wire format
// ---------------------------------------------------------------------------

export function backendMessageToBuffer(msg: BackendMessage): Buffer {
    const buf = Buffer.alloc(1 + 4 + msg.data.length);
    buf[0] = msg.type;
    buf.writeInt32BE(4 + msg.data.length, 1);
    msg.data.copy(buf, 5);
    return buf;
}
