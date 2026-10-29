/**
 * The project proxy for MongoDB. The app connects to 127.0.0.1 without a user
 * (mongodb://127.0.0.1:<port>/<any name>?directConnection=true); bbdump opens a connection to
 * the real server (TLS, SCRAM login with the saved account), then forwards the app's messages,
 * with the database each command names ($db) replaced by the target's. Answers go back as
 * they are. A replica set or an SRV address is reached through its primary.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as tls from 'tls';
import { once } from 'events';
import { readExact } from './pgProtocol';

const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_COMPRESSED = 2012;
const OP_MSG = 2013;

/** Databases left as the app names them (server administration, not the app's data) */
const SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);
/** Fields of the app's hello the proxy removes: compression and the app's own login */
const DROPPED_HELLO_FIELDS = new Set(['compression', 'speculativeAuthenticate', 'saslSupportedMechs']);

export interface MongoProxyTarget {
    /** Where to connect: the server itself, or the primary found from `discoveryUri` */
    host: string;
    port: number;
    /** Set for a replica set / SRV address: the primary is looked up with the driver */
    discoveryUri?: string;
    tls?: { verifyServer: boolean; verifyName: boolean; caFile?: string; servername?: string };
    user?: string;
    password?: string;
    authSource: string;
    /** SCRAM-SHA-256, SCRAM-SHA-1, or undefined (SHA-256 then SHA-1) */
    mechanism?: string;
    database: string;
}

// --- BSON, the few bits the proxy needs ------------------------------------------------------

const malformed = () => new Error('Malformed BSON document');

/** A non-negative int32 length read at `at` (a negative or absent one is malformed) */
function lengthAt(doc: Buffer, at: number, min = 0): number {
    if (at + 4 > doc.length) throw malformed();
    const length = doc.readInt32LE(at);
    if (length < min) throw malformed();
    return length;
}

/** Size of an element's value at `at` (type `type`), from the BSON spec */
function valueSize(doc: Buffer, type: number, at: number): number {
    switch (type) {
        case 0x01: case 0x09: case 0x11: case 0x12: return 8;
        case 0x02: case 0x0d: case 0x0e: return 4 + lengthAt(doc, at, 1);
        case 0x03: case 0x04: return lengthAt(doc, at, 5);
        case 0x0f: return lengthAt(doc, at, 14);
        case 0x05: return 5 + lengthAt(doc, at);
        case 0x06: case 0x0a: case 0x7f: case 0xff: return 0;
        case 0x07: return 12;
        case 0x08: return 1;
        case 0x0b: {
            const first = doc.indexOf(0, at);
            const second = first === -1 ? -1 : doc.indexOf(0, first + 1);
            if (second === -1) throw malformed();
            return second + 1 - at;
        }
        case 0x0c: return 4 + lengthAt(doc, at, 1) + 12;
        case 0x10: return 4;
        case 0x13: return 16;
        default: throw new Error(`Unknown BSON type 0x${type.toString(16)}`);
    }
}

export interface BsonElement { type: number; key: string; start: number; valueAt: number; end: number }

/** The top-level elements of a document (no copy) */
export function topLevel(doc: Buffer): BsonElement[] {
    const elements: BsonElement[] = [];
    // Its declared length is its real one, ending with a NUL; each element moves forward inside it
    const length = lengthAt(doc, 0, 5);
    if (length !== doc.length || doc[length - 1] !== 0) throw malformed();
    let at = 4;
    while (at < length - 1) {
        const type = doc[at];
        const keyEnd = doc.indexOf(0, at + 1);
        if (keyEnd === -1 || keyEnd >= length - 1) throw malformed();
        const key = doc.subarray(at + 1, keyEnd).toString('utf8');
        const valueAt = keyEnd + 1;
        const end = valueAt + valueSize(doc, type, valueAt);
        if (end <= at || end > length - 1) throw malformed();
        elements.push({ type, key, start: at, valueAt, end });
        at = end;
    }
    return elements;
}

export function readString(doc: Buffer, element: BsonElement): string {
    const length = doc.readInt32LE(element.valueAt);
    return doc.subarray(element.valueAt + 4, element.valueAt + 4 + length - 1).toString('utf8');
}

function stringElement(key: string, value: string): Buffer {
    const text = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeInt32LE(text.length + 1);
    return Buffer.concat([Buffer.from([0x02]), Buffer.from(`${key}\0`, 'utf8'), length, text, Buffer.from([0])]);
}

function documentOf(parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    const length = Buffer.alloc(4);
    length.writeInt32LE(body.length + 5);
    return Buffer.concat([length, body, Buffer.from([0])]);
}

/**
 * The app's command for the target: `$db` names the target (unless it is admin, config or
 * local), the hello fields of compression and login removed. Same bytes when nothing changes.
 */
export function rewriteCommand(doc: Buffer, database: string): Buffer {
    let changed = false;
    const parts: Buffer[] = [];
    for (const element of topLevel(doc)) {
        if (DROPPED_HELLO_FIELDS.has(element.key)) {
            changed = true;
            continue;
        }
        if (element.key === '$db' && element.type === 0x02) {
            const current = readString(doc, element);
            if (!SYSTEM_DATABASES.has(current) && current !== database) {
                parts.push(stringElement('$db', database));
                changed = true;
                continue;
            }
        }
        parts.push(doc.subarray(element.start, element.end));
    }
    return changed ? documentOf(parts) : doc;
}

type Field = string | number | boolean | Buffer | { [key: string]: Field };

/** A small document: strings, numbers (int32 when whole, else double), booleans, binary data, documents */
export function bson(fields: Record<string, Field>): Buffer {
    const parts: Buffer[] = [];
    for (const [key, value] of Object.entries(fields)) {
        const name = Buffer.from(`${key}\0`, 'utf8');
        if (typeof value === 'string') parts.push(stringElement(key, value));
        else if (typeof value === 'number' && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
            const number = Buffer.alloc(4);
            number.writeInt32LE(value);
            parts.push(Buffer.from([0x10]), name, number);
        } else if (typeof value === 'number') {
            const number = Buffer.alloc(8);
            number.writeDoubleLE(value);
            parts.push(Buffer.from([0x01]), name, number);
        } else if (typeof value === 'boolean') parts.push(Buffer.from([0x08]), name, Buffer.from([value ? 1 : 0]));
        else if (Buffer.isBuffer(value)) {
            const length = Buffer.alloc(4);
            length.writeInt32LE(value.length);
            parts.push(Buffer.from([0x05]), name, length, Buffer.from([0]), value);
        } else parts.push(Buffer.from([0x03]), name, bson(value));
    }
    return documentOf(parts);
}

/** The fields of a reply the login reads (strings, numbers, booleans, binary data) */
export function readFields(doc: Buffer): Record<string, string | number | boolean | Buffer> {
    const fields: Record<string, string | number | boolean | Buffer> = {};
    for (const element of topLevel(doc)) {
        const at = element.valueAt;
        if (element.type === 0x02) fields[element.key] = readString(doc, element);
        else if (element.type === 0x01) fields[element.key] = doc.readDoubleLE(at);
        else if (element.type === 0x10) fields[element.key] = doc.readInt32LE(at);
        else if (element.type === 0x12) fields[element.key] = Number(doc.readBigInt64LE(at));
        else if (element.type === 0x08) fields[element.key] = doc[at] === 1;
        else if (element.type === 0x05) fields[element.key] = doc.subarray(at + 5, at + 5 + doc.readInt32LE(at));
    }
    return fields;
}

// --- Messages ----------------------------------------------------------------------------------

export interface Message { requestId: number; responseTo: number; opCode: number; body: Buffer }

export async function readMessage(socket: net.Socket | tls.TLSSocket): Promise<Message> {
    const header = await readExact(socket, 16);
    const length = header.readInt32LE(0);
    if (length < 16 || length > 48 * 1024 * 1024) throw new Error(`Invalid MongoDB message length ${length}`);
    return { requestId: header.readInt32LE(4), responseTo: header.readInt32LE(8), opCode: header.readInt32LE(12), body: await readExact(socket, length - 16) };
}

export function messageBytes(message: Message): Buffer {
    const header = Buffer.alloc(16);
    header.writeInt32LE(16 + message.body.length, 0);
    header.writeInt32LE(message.requestId, 4);
    header.writeInt32LE(message.responseTo, 8);
    header.writeInt32LE(message.opCode, 12);
    return Buffer.concat([header, message.body]);
}

/** An OP_MSG of one document */
export function opMsg(requestId: number, responseTo: number, doc: Buffer): Buffer {
    return messageBytes({ requestId, responseTo, opCode: OP_MSG, body: Buffer.concat([Buffer.alloc(4), Buffer.from([0]), doc]) });
}

/** The document of an OP_MSG body (its section of kind 0) */
export function bodyDocument(body: Buffer): Buffer {
    let at = 4;
    while (at < body.length) {
        const kind = body[at];
        const length = lengthAt(body, at + 1, 5);
        if (at + 1 + length > body.length) throw malformed();
        if (kind === 0) return body.subarray(at + 1, at + 1 + length);
        at += 1 + length;
    }
    throw new Error('MongoDB message without a body');
}

/** The app's message for the target (OP_MSG and OP_QUERY rewritten, the rest unchanged) */
export function rewriteMessage(message: Message, database: string): Message {
    if (message.opCode === OP_MSG) {
        const flags = message.body.readUInt32LE(0);
        // A checksum would no longer match: dropped, with its flag
        const end = flags & 1 ? message.body.length - 4 : message.body.length;
        const head = Buffer.alloc(4);
        head.writeUInt32LE((flags & ~1) >>> 0);
        const parts: Buffer[] = [head];
        let at = 4;
        while (at < end) {
            const kind = message.body[at];
            if (kind !== 0 && kind !== 1) throw malformed();
            const length = lengthAt(message.body, at + 1, 5);
            if (at + 1 + length > end) throw malformed();
            if (kind === 0) parts.push(Buffer.from([0]), rewriteCommand(message.body.subarray(at + 1, at + 1 + length), database));
            else parts.push(message.body.subarray(at, at + 1 + length));
            at += 1 + length;
        }
        return { ...message, body: Buffer.concat(parts) };
    }
    if (message.opCode === OP_QUERY) {
        // flags, "<db>.$cmd", skip, return, query document[, fields]
        const nameEnd = message.body.indexOf(0, 4);
        if (nameEnd === -1) throw malformed();
        const fullName = message.body.subarray(4, nameEnd).toString('utf8');
        const dot = fullName.indexOf('.');
        const db = dot === -1 ? fullName : fullName.slice(0, dot);
        const name = SYSTEM_DATABASES.has(db) ? fullName : `${database}${dot === -1 ? '' : fullName.slice(dot)}`;
        const queryAt = nameEnd + 9;
        const queryLength = lengthAt(message.body, queryAt, 5);
        if (queryAt + queryLength > message.body.length) throw malformed();
        const query = rewriteCommand(message.body.subarray(queryAt, queryAt + queryLength), database);
        return {
            ...message,
            body: Buffer.concat([
                message.body.subarray(0, 4), Buffer.from(`${name}\0`, 'utf8'), message.body.subarray(nameEnd + 1, queryAt),
                query, message.body.subarray(queryAt + queryLength),
            ]),
        };
    }
    if (message.opCode === OP_COMPRESSED) throw new Error('Compressed messages are not supported by the bbdump proxy: remove compressors from the URL');
    // The legacy opcodes (OP_INSERT, OP_UPDATE…) name their namespace themselves: refused
    throw new Error(`MongoDB opcode ${message.opCode} is not supported by the bbdump proxy`);
}

/** An error answer to the app's request (OP_REPLY for OP_QUERY, OP_MSG otherwise) */
export function errorReply(request: Message, text: string, code = 18): Buffer {
    const doc = bson({ ok: 0, errmsg: `bbdump proxy: ${text}`, code });
    if (request.opCode === OP_QUERY) {
        const head = Buffer.alloc(20);
        head.writeInt32LE(1, 16); // one document
        return messageBytes({ requestId: 0, responseTo: request.requestId, opCode: OP_REPLY, body: Buffer.concat([head, doc]) });
    }
    return opMsg(0, request.requestId, doc);
}

// --- Login (SCRAM) -----------------------------------------------------------------------------

let nextRequestId = 1;

async function command(socket: net.Socket | tls.TLSSocket, doc: Buffer): Promise<Record<string, string | number | boolean | Buffer>> {
    socket.write(opMsg(nextRequestId++, 0, doc));
    const reply = await readMessage(socket);
    if (reply.opCode !== OP_MSG) throw new Error('Unexpected answer from the server');
    return readFields(bodyDocument(reply.body));
}

const escapeUser = (user: string) => user.replace(/=/g, '=3D').replace(/,/g, '=2C');

/** SCRAM-SHA-256 or SCRAM-SHA-1 with the saved account (RFC 5802, MongoDB's variant for SHA-1) */
export async function scramLogin(socket: net.Socket | tls.TLSSocket, target: MongoProxyTarget, mechanism: 'SCRAM-SHA-256' | 'SCRAM-SHA-1'): Promise<void> {
    const sha256 = mechanism === 'SCRAM-SHA-256';
    const hash = sha256 ? 'sha256' : 'sha1';
    const user = target.user ?? '';
    const nonce = crypto.randomBytes(24).toString('base64');
    const clientFirstBare = `n=${escapeUser(user)},r=${nonce}`;
    const start = await command(socket, bson({
        saslStart: 1, mechanism, payload: Buffer.from(`n,,${clientFirstBare}`, 'utf8'), autoAuthorize: 1,
        options: { skipEmptyExchange: true }, $db: target.authSource,
    }));
    if (start.ok !== 1) throw new Error(String(start.errmsg ?? 'Authentication failed'));
    const serverFirst = (start.payload as Buffer).toString('utf8');
    const attributes: Record<string, string> = Object.fromEntries(serverFirst.split(',').map(part => [part[0], part.slice(2)]));
    if (!attributes.r?.startsWith(nonce)) throw new Error('The server answered the login with another nonce');
    const password = sha256 ? (target.password ?? '').normalize('NFKC') : crypto.createHash('md5').update(`${user}:mongo:${target.password ?? ''}`).digest('hex');
    // The server sets the cost: bounded, so a server cannot freeze bbdump nor make it trivial
    const iterations = Number(attributes.i);
    const salt = Buffer.from(attributes.s ?? '', 'base64');
    if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000 || salt.length < 8) throw new Error('The server asked for unusual login settings: refused');
    const salted = await new Promise<Buffer>((resolve, reject) => crypto.pbkdf2(password, salt, iterations, sha256 ? 32 : 20, hash, (error, key) => (error ? reject(error) : resolve(key))));
    const clientKey = crypto.createHmac(hash, salted).update('Client Key').digest();
    const storedKey = crypto.createHash(hash).update(clientKey).digest();
    const finalNoProof = `c=biws,r=${attributes.r}`;
    const authMessage = `${clientFirstBare},${serverFirst},${finalNoProof}`;
    const signature = crypto.createHmac(hash, storedKey).update(authMessage).digest();
    const proof = Buffer.from(clientKey.map((byte, i) => byte ^ signature[i])).toString('base64');
    let reply = await command(socket, bson({
        saslContinue: 1, conversationId: Number(start.conversationId), payload: Buffer.from(`${finalNoProof},p=${proof}`, 'utf8'), $db: target.authSource,
    }));
    if (reply.ok !== 1) throw new Error(String(reply.errmsg ?? 'Authentication failed'));
    const serverFinal = Buffer.isBuffer(reply.payload) ? reply.payload.toString('utf8') : '';
    const expected = crypto.createHmac(hash, crypto.createHmac(hash, salted).update('Server Key').digest()).update(authMessage).digest('base64');
    // The server proves it knows the password too: without that proof, it may be another one
    if (!serverFinal.split(',').includes(`v=${expected}`)) throw new Error('The server could not prove it knows the password');
    for (let round = 0; !reply.done && round < 3; round++) {
        reply = await command(socket, bson({ saslContinue: 1, conversationId: Number(start.conversationId), payload: Buffer.alloc(0), $db: target.authSource }));
        if (reply.ok !== 1) throw new Error(String(reply.errmsg ?? 'Authentication failed'));
    }
}

// --- Connections -------------------------------------------------------------------------------

const primaries = new Map<string, { host: string; port: number; at: number }>();

/** The primary of a replica set or SRV address (kept a minute), found with the official driver */
async function primaryOf(uri: string): Promise<{ host: string; port: number }> {
    const known = primaries.get(uri);
    if (known && Date.now() - known.at < 60_000) return known;
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(uri, { appName: 'bbdump-proxy', serverSelectionTimeoutMS: 10_000 });
    try {
        await client.connect();
        const hello = await client.db('admin').command({ hello: 1 });
        const address = String(hello.primary ?? hello.me ?? '');
        const colon = address.lastIndexOf(':');
        if (colon === -1) throw new Error('The primary of this cluster could not be found');
        const found = { host: address.slice(0, colon), port: Number(address.slice(colon + 1)) || 27017, at: Date.now() };
        primaries.set(uri, found);
        return found;
    } finally {
        await client.close().catch(() => {});
    }
}

async function openServer(target: MongoProxyTarget): Promise<net.Socket | tls.TLSSocket> {
    const where = target.discoveryUri ? await primaryOf(target.discoveryUri) : { host: target.host, port: target.port };
    const plain = net.createConnection({ host: where.host, port: where.port });
    plain.setTimeout(15000);
    await new Promise<void>((resolve, reject) => {
        plain.once('connect', resolve);
        plain.once('error', reject);
        plain.once('timeout', () => { plain.destroy(); reject(new Error(`Connection timeout to ${where.host}:${where.port}`)); });
    });
    plain.setTimeout(0);
    if (!target.tls) return plain;
    const name = target.tls.servername ?? where.host;
    const secure = tls.connect({
        socket: plain,
        rejectUnauthorized: target.tls.verifyServer,
        ca: target.tls.caFile ? fs.readFileSync(target.tls.caFile) : undefined,
        servername: net.isIP(name) ? undefined : name,
        checkServerIdentity: target.tls.verifyName ? tls.checkServerIdentity : () => undefined,
    });
    await new Promise<void>((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', reject);
    });
    return secure;
}

async function login(server: net.Socket | tls.TLSSocket, target: MongoProxyTarget): Promise<void> {
    if (!target.user) return;
    const mechanism = target.mechanism?.toUpperCase();
    if (mechanism && mechanism !== 'SCRAM-SHA-256' && mechanism !== 'SCRAM-SHA-1') {
        throw new Error(`The bbdump proxy cannot log in with ${target.mechanism}`);
    }
    if (mechanism) return scramLogin(server, target, mechanism as 'SCRAM-SHA-256' | 'SCRAM-SHA-1');
    try {
        await scramLogin(server, target, 'SCRAM-SHA-256');
    } catch (error) {
        // An account with SCRAM-SHA-1 credentials only (older servers, some hosts)
        if (!/mechanism|SCRAM-SHA-256/i.test(error instanceof Error ? error.message : String(error))) throw error;
        await scramLogin(server, target, 'SCRAM-SHA-1');
    }
}

/**
 * One connection of the app: a logged-in connection to the server, then the app's messages
 * forwarded (rewritten) and the answers piped back. Resolves with the server socket once the
 * forwarding runs; on failure the app's first request gets the reason and this throws.
 */
export async function proxyMongoConnection(client: net.Socket, target: MongoProxyTarget, log: (message: string) => void): Promise<net.Socket | tls.TLSSocket> {
    let server: net.Socket | tls.TLSSocket | undefined;
    // A silent server during the login does not hold the app forever
    const deadline = setTimeout(() => server?.destroy(new Error('The login to the server did not finish in time')), 15_000);
    try {
        server = await openServer(target);
        await login(server, target);
        clearTimeout(deadline);
        log('logged in');
    } catch (error) {
        clearTimeout(deadline);
        server?.destroy();
        // After a failover the primary changed: looked up again next time
        if (target.discoveryUri) primaries.delete(target.discoveryUri);
        const text = error instanceof Error ? error.message : String(error);
        // The app waits for the answer to its hello: it gets the reason
        try {
            const request = await Promise.race([readMessage(client), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]);
            client.write(errorReply(request, text));
        } catch { /* the app left */ }
        throw error;
    }

    const upstream = server;
    upstream.pipe(client);
    // The app's messages, one at a time, in order
    void (async () => {
        try {
            for (;;) {
                const message = await readMessage(client);
                // The server reads slower than the app writes: wait, instead of keeping it all in memory
                if (!upstream.write(messageBytes(rewriteMessage(message, target.database)))) await once(upstream, 'drain');
            }
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (!/closed|ended|destroyed/i.test(text)) log(`stopped: ${text}`);
            client.destroy();
            upstream.destroy();
        }
    })();
    return upstream;
}
