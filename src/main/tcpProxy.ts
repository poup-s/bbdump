/**
 * PostgreSQL-aware proxy.
 *
 * Each project gets a local listening port (e.g. 54320).
 * Clients connect with any credentials — the proxy always replies AuthOk.
 * Behind the scenes, the proxy connects to the real target DB with real
 * credentials, authenticates (MD5 / SCRAM-SHA-256), then pipes traffic
 * bidirectionally.
 *
 * Fixed client URL example: postgresql://proxy:proxy@localhost:54320/proxy
 */
import * as net from 'net';
import * as tls from 'tls';
import { logger } from './logger';
import { proxyActivityLog } from './proxyActivityLog';
import {
    TargetCredentials,
    isSSLRequest,
    readInitialMessage,
    readBackendMessage,
    backendMessageToBuffer,
    buildAuthenticationOk,
    buildErrorResponse,
    connectAndAuthenticate,
} from './pgProtocol';

export { TargetCredentials } from './pgProtocol';

interface ProxyInstance {
    server: net.Server;
    port: number;
    target: TargetCredentials;
    activeConnections: Set<net.Socket>;
}

export interface ProxyStatus {
    running: boolean;
    port: number;
    targetHost: string;
    targetPort: number;
    activeConnections: number;
}

class TcpProxyManager {
    private proxies = new Map<string, ProxyInstance>();

    /**
     * Start a PG proxy for a project.
     */
    startProxy(projectId: string, port: number, target: TargetCredentials, dbName?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.proxies.has(projectId)) {
                this.stopProxy(projectId);
            }

            const activeConnections = new Set<net.Socket>();

            const server = net.createServer({ pauseOnConnect: true }, (clientSocket) => {
                const instance = this.proxies.get(projectId);
                if (!instance) { clientSocket.destroy(); return; }

                const remoteAddress = clientSocket.remoteAddress || 'unknown';
                activeConnections.add(clientSocket);

                proxyActivityLog.addEvent(projectId, 'connected', {
                    port: instance.port,
                    targetHost: instance.target.host,
                    targetPort: instance.target.port,
                    remoteAddress,
                    message: `Client connected from ${remoteAddress} → ${instance.target.host}:${instance.target.port}`,
                });

                this.handleConnection(projectId, clientSocket, instance.target, activeConnections, remoteAddress);
            });

            server.on('error', (err) => {
                logger.error(`Proxy server error [${projectId}]: ${err.message}`);
                reject(err);
            });

            server.listen(port, '127.0.0.1', () => {
                const instance: ProxyInstance = {
                    server,
                    port,
                    target: { ...target },
                    activeConnections,
                };
                this.proxies.set(projectId, instance);
                const label = dbName || target.database;
                logger.info(`PG proxy started for ${projectId} on 127.0.0.1:${port} → ${label} (${target.host}:${target.port})`);
                proxyActivityLog.addEvent(projectId, 'started', {
                    port,
                    targetHost: target.host,
                    targetPort: target.port,
                    message: `Proxy started on port ${port} → ${label} (${target.host}:${target.port})`,
                });
                resolve();
            });
        });
    }

    // -----------------------------------------------------------------------
    //  Per-connection handler
    // -----------------------------------------------------------------------

    private async handleConnection(
        projectId: string,
        clientSocket: net.Socket,
        target: TargetCredentials,
        activeConnections: Set<net.Socket>,
        remoteAddress: string,
    ) {
        let serverSocket: net.Socket | tls.TLSSocket | null = null;
        let disconnectLogged = false;

        const cleanup = () => {
            activeConnections.delete(clientSocket);
            if (serverSocket) activeConnections.delete(serverSocket);
            clientSocket.destroy();
            if (serverSocket) serverSocket.destroy();
            if (!disconnectLogged) {
                disconnectLogged = true;
                proxyActivityLog.addEvent(projectId, 'disconnected', {
                    remoteAddress,
                    message: `Client disconnected from ${remoteAddress}`,
                });
            }
        };

        clientSocket.on('error', (err) => {
            logger.warn(`Proxy client error [${projectId}]: ${err.message}`);
            cleanup();
        });
        clientSocket.on('close', cleanup);

        try {
            // --- Phase 1: Read & discard client startup (fake creds) ---
            logger.info(`[proxy:${projectId}] Phase 1: reading client initial message...`);
            let msg = await readInitialMessage(clientSocket);
            if (isSSLRequest(msg)) {
                logger.info(`[proxy:${projectId}] Client sent SSLRequest, replying N`);
                clientSocket.write(Buffer.from([0x4E])); // 'N' — no SSL on localhost
                msg = await readInitialMessage(clientSocket);
            }
            logger.info(`[proxy:${projectId}] Phase 1 done: got StartupMessage (${msg.length} bytes)`);

            // --- Phase 2: Connect to real server, authenticate ---
            logger.info(`[proxy:${projectId}] Phase 2: connecting to ${target.host}:${target.port} as ${target.user}/${target.database} (ssl=${target.ssl || false})`);
            serverSocket = await connectAndAuthenticate(target);
            activeConnections.add(serverSocket);
            logger.info(`[proxy:${projectId}] Phase 2 done: server authenticated`);

            serverSocket.on('error', (err) => {
                logger.warn(`Proxy server socket error [${projectId}]: ${err.message}`);
                cleanup();
            });
            serverSocket.on('close', cleanup);

            // --- Phase 3: Send AuthOk to client, then forward server post-auth messages ---
            clientSocket.write(buildAuthenticationOk());
            logger.info(`[proxy:${projectId}] Phase 3: sent AuthOk to client, forwarding server params...`);

            // Server now sends ParameterStatus × N, BackendKeyData, ReadyForQuery
            let ready = false;
            while (!ready) {
                const serverMsg = await readBackendMessage(serverSocket);
                clientSocket.write(backendMessageToBuffer(serverMsg));
                if (serverMsg.type === 0x5A) { // 'Z' = ReadyForQuery
                    ready = true;
                }
                if (serverMsg.type === 0x45) { // 'E' = ErrorResponse
                    logger.error(`[proxy:${projectId}] Server sent ErrorResponse during init`);
                    cleanup();
                    return;
                }
            }

            // --- Phase 4: Bidirectional pipe ---
            logger.info(`[proxy:${projectId}] Phase 4: pipe active`);
            clientSocket.pipe(serverSocket);
            serverSocket.pipe(clientSocket);

        } catch (err: any) {
            logger.error(`[proxy:${projectId}] Connection error: ${err.message}`);
            // Try to inform the client
            try { clientSocket.write(buildErrorResponse(err.message)); } catch {}
            cleanup();
        }
    }

    // -----------------------------------------------------------------------
    //  Target management
    // -----------------------------------------------------------------------

    /**
     * Switch the target of an existing proxy.
     * New connections use the new target; existing connections stay on the old one.
     */
    switchTarget(projectId: string, target: TargetCredentials, dbName?: string): void {
        const instance = this.proxies.get(projectId);
        if (!instance) throw new Error(`No proxy running for project ${projectId}`);
        instance.target = { ...target };
        const label = dbName || target.database;
        logger.info(`PG proxy target switched for ${projectId} → ${label} (${target.host}:${target.port})`);
        proxyActivityLog.addEvent(projectId, 'target-switched', {
            port: instance.port,
            targetHost: target.host,
            targetPort: target.port,
            message: `Target switched to ${label} (${target.host}:${target.port})`,
        });
    }

    stopProxy(projectId: string): void {
        const instance = this.proxies.get(projectId);
        if (!instance) return;

        for (const socket of instance.activeConnections) socket.destroy();
        instance.activeConnections.clear();
        instance.server.close();
        this.proxies.delete(projectId);
        logger.info(`PG proxy stopped for ${projectId}`);
        proxyActivityLog.addEvent(projectId, 'stopped', {
            port: instance.port,
            message: `Proxy stopped (was on port ${instance.port})`,
        });
    }

    getStatus(projectId: string): ProxyStatus | null {
        const instance = this.proxies.get(projectId);
        if (!instance) return null;
        return {
            running: true,
            port: instance.port,
            targetHost: instance.target.host,
            targetPort: instance.target.port,
            activeConnections: Math.floor(instance.activeConnections.size / 2),
        };
    }

    getAllStatuses(): Record<string, ProxyStatus> {
        const statuses: Record<string, ProxyStatus> = {};
        for (const [id] of this.proxies) {
            const s = this.getStatus(id);
            if (s) statuses[id] = s;
        }
        return statuses;
    }

    isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const s = net.createServer();
            s.once('error', () => resolve(false));
            s.listen(port, '127.0.0.1', () => { s.close(() => resolve(true)); });
        });
    }

    stopAll(): void {
        for (const [id] of this.proxies) this.stopProxy(id);
        logger.info('All PG proxies stopped');
    }

    isRunning(projectId: string): boolean {
        return this.proxies.has(projectId);
    }
}

export const tcpProxyManager = new TcpProxyManager();
