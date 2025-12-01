import { AppConfig, DatabaseConfig } from '../types/config';

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
        // Explicitly set isLocalBbdump to ensure it's not lost
        isLocalBbdump: isLocalBbdump,

        // Ensure other required fields have sane defaults if missing (though they should be present)
        encrypted: db.encrypted !== false, // Default to true if undefined
        encryptBackups: db.encryptBackups === true, // Default to false if undefined
        enabled: db.enabled !== false, // Default to true if undefined
        ssl: db.ssl === true, // Default to false if undefined
    };
}

/**
 * Sanitizes the entire application configuration.
 */
export function sanitizeAppConfig(config: any): AppConfig {
    const databases = Array.isArray(config.databases)
        ? config.databases.map(sanitizeDatabaseConfig)
        : [];

    return {
        ...config,
        databases,
        // Ensure onboardingCompleted is preserved or defaulted
        onboardingCompleted: config.onboardingCompleted === true,
        // Ensure language is valid
        language: config.language === 'fr' ? 'fr' : 'en'
    };
}
