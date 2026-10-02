import { AppConfig, DatabaseConfig, ProjectConfig, SshSettings } from '../types/config';
import { isSafeEnvVar, isSafePort, isSafeSshValue, normalizeSshPorts } from './sshConfig';
import * as crypto from 'crypto';

type SslMode = NonNullable<DatabaseConfig['sslMode']>;
const SSL_MODES: readonly string[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] satisfies SslMode[];

const isSslMode = (value: unknown): value is SslMode => typeof value === 'string' && SSL_MODES.includes(value);

/**
 * Sanitizes and normalizes a database configuration object.
 * Ensures that critical flags like `isLocalBbdump` are preserved and defaults are applied.
 */
/** SSH settings kept only when every value is safe to give to ssh; anything else is dropped */
function sanitizeSsh(ssh: unknown): SshSettings | undefined {
    if (!ssh || typeof ssh !== 'object') return undefined;
    // An emptied port field must not drop the SSH settings
    const s = normalizeSshPorts(ssh as Partial<SshSettings>);
    if (!isSafeSshValue(s.host) || !isSafeSshValue(s.remoteHost) || !isSafePort(s.remotePort)) return undefined;
    if (s.user !== undefined && s.user !== '' && !isSafeSshValue(s.user)) return undefined;
    if (s.port !== undefined && !isSafePort(s.port)) return undefined;
    return {
        host: s.host,
        user: s.user || undefined,
        port: s.port,
        remoteHost: s.remoteHost,
        remotePort: s.remotePort,
        envFile: typeof s.envFile === 'string' && s.envFile.trim() ? s.envFile.trim() : undefined,
        envVar: isSafeEnvVar(s.envVar) ? s.envVar : undefined,
    };
}

export function sanitizeDatabaseConfig(db: Partial<DatabaseConfig>): DatabaseConfig {
    // Ensure isLocalBbdump is explicitly preserved as a boolean
    // If it's undefined, default to false, but if it exists, keep it.
    const isLocalBbdump = db.isLocalBbdump === true;

    // SSL: sslMode is the source of truth; configs from v1.0.2 only have `ssl: boolean`.
    // `ssl` stays in sync so an older version reading this file keeps working.
    const sslMode = isSslMode(db.sslMode) ? db.sslMode : (db.ssl === true ? 'require' : undefined);
    const sslRootCert = typeof db.sslRootCert === 'string' && db.sslRootCert.trim() ? db.sslRootCert.trim() : undefined;
    const ssl = sslMode ? sslMode === 'require' || sslMode.startsWith('verify-') : db.ssl === true;

    return {
        ...db,
        // Ensure id is always present
        id: db.id || crypto.randomUUID(),
        // Explicitly set isLocalBbdump to ensure it's not lost
        isLocalBbdump: isLocalBbdump,

        // Ensure other required fields have sane defaults if missing (though they should be present)
        encrypted: db.encrypted !== false, // Default to true if undefined
        encryptBackups: db.encryptBackups === true, // Default to false if undefined
        enabled: db.enabled !== false, // Default to true if undefined
        ssl,
        sslMode,
        sslRootCert,
        retentionCount: typeof db.retentionCount === 'number' && Number.isInteger(db.retentionCount) && db.retentionCount > 0 ? db.retentionCount : undefined,
        verifyBackups: db.verifyBackups !== false,
        masked: db.masked === true, // Default to false if undefined
        ssh: sanitizeSsh(db.ssh),
        viaTunnel: undefined, // runtime only
    // The remaining required fields (name, host...) are passed through as stored, unvalidated
    } as DatabaseConfig;
}

/**
 * Sanitizes and normalizes a project configuration object.
 */
export function sanitizeProjectConfig(project: Partial<ProjectConfig>): ProjectConfig {
    // Validate proxy port: must be a number between 1024 and 65535
    const proxyPort = typeof project.proxyPort === 'number'
        && project.proxyPort >= 1024
        && project.proxyPort <= 65535
        ? project.proxyPort
        : undefined;

    // Validate proxyTargetDbId: must be a non-empty string
    const proxyTargetDbId = typeof project.proxyTargetDbId === 'string' && project.proxyTargetDbId.length > 0
        ? project.proxyTargetDbId
        : undefined;

    // Validate proxy URL credentials: non-empty trimmed strings or undefined
    const proxyUser = typeof project.proxyUser === 'string' && project.proxyUser.trim().length > 0
        ? project.proxyUser.trim()
        : undefined;
    const proxyPassword = typeof project.proxyPassword === 'string' && project.proxyPassword.trim().length > 0
        ? project.proxyPassword.trim()
        : undefined;
    const proxyDbName = typeof project.proxyDbName === 'string' && project.proxyDbName.trim().length > 0
        ? project.proxyDbName.trim()
        : undefined;

    return {
        id: project.id || crypto.randomUUID(),
        name: project.name || '',
        color: project.color || 'bg-blue-500',
        databaseIds: Array.isArray(project.databaseIds) ? project.databaseIds : [],
        masked: project.masked === true,
        proxyEnabled: project.proxyEnabled === true,
        proxyPort,
        proxyTargetDbId,
        proxyUser,
        proxyPassword,
        proxyDbName,
    };
}

/** Usage modes accepted in config.json ('docker' is not selectable yet). */
export function isUsageMode(value: unknown): value is 'local' | 'remote' {
    return value === 'local' || value === 'remote';
}

/**
 * Sanitizes the entire application configuration.
 */
export function sanitizeAppConfig(config: Partial<AppConfig>): AppConfig {
    const databases = Array.isArray(config.databases)
        ? config.databases.map(sanitizeDatabaseConfig)
        : [];

    const projects = Array.isArray(config.projects)
        ? config.projects.map(sanitizeProjectConfig)
        : [];

    return {
        ...config,
        databases,
        projects,
        viewMode: config.viewMode === 'project' ? 'project' : 'list',
        // Ensure onboardingCompleted is preserved or defaulted
        onboardingCompleted: config.onboardingCompleted === true,
        // Ensure language is valid
        language: config.language === 'fr' ? 'fr' : 'en',
        // Only known modes survive; unset stays unset (migrated in loadConfig)
        usageMode: isUsageMode(config.usageMode) ? config.usageMode : undefined,
        whatsNewSeen: typeof config.whatsNewSeen === 'string' && /^\d+\.\d+\.\d+$/.test(config.whatsNewSeen) ? config.whatsNewSeen : undefined,
    };
}
