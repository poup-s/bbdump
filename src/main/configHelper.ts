import { AppConfig, DatabaseConfig, ProjectConfig } from '../types/config';
import * as crypto from 'crypto';

/**
 * Sanitizes and normalizes a database configuration object.
 * Ensures that critical flags like `isLocalBbdump` are preserved and defaults are applied.
 */
export function sanitizeDatabaseConfig(db: any): DatabaseConfig {
    // Ensure isLocalBbdump is explicitly preserved as a boolean
    // If it's undefined, default to false, but if it exists, keep it.
    const isLocalBbdump = db.isLocalBbdump === true;

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
        ssl: db.ssl === true, // Default to false if undefined
        masked: db.masked === true, // Default to false if undefined
    };
}

/**
 * Sanitizes and normalizes a project configuration object.
 */
export function sanitizeProjectConfig(project: any): ProjectConfig {
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

/**
 * Sanitizes the entire application configuration.
 */
export function sanitizeAppConfig(config: any): AppConfig {
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
        language: config.language === 'fr' ? 'fr' : 'en'
    };
}
