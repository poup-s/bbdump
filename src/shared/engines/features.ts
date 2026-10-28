/**
 * Feature flags: one catalogue of features, what each engine supports (its manifest) and what
 * the user turned on (features.json). The main process enforces them, the renderer hides what is off.
 */
import type { FacetName, FeatureRollout, FeatureState, RolloutLevel } from './types';
import { manifestFor } from './manifests';

/** Every feature bbdump knows, with the driver facets it needs (if any) */
export const FEATURES = {
    'connection.test': { facets: ['connection'] },
    'connection.ssh': {},
    'connection.tls': {},
    'backup.run': { facets: ['backup'] },
    'backup.schedule': { facets: ['backup'] },
    'backup.verify': { facets: ['backup'] },
    'backup.encrypt': { facets: ['backup'] },
    'restore.replace': { facets: ['restore'] },
    'restore.toOther': { facets: ['restore'] },
    'explorer.browse': { facets: ['catalog', 'records'] },
    /** Document databases: collections, documents, sampled schema, indexes */
    'explorer.documents': { facets: ['documents'] },
    /** Document databases: add, change and delete documents one by one */
    'explorer.editDocuments': { facets: ['documentWrites'] },
    /** Document databases: run a read-only aggregation pipeline */
    'explorer.aggregate': { facets: ['documents'] },
    'explorer.edit': { facets: ['records'] },
    'explorer.query': { facets: ['query'] },
    'explorer.diagram': { facets: ['catalog'] },
    'stats.size': { facets: ['stats'] },
    'database.duplicate': {},
    'sync.fromSource': {},
    'sync.anonymize': {},
    'mask.fields': {},
    'chat': {},
    // PostgreSQL: SQL blocks; MongoDB: aggregation blocks (the documents facet)
    'dashboards': {},
    'mcp.read': {},
    'mcp.write': {},
    'mcp.undo': {},
    'proxy.tcp': {},
    'local.server': {},
} as const satisfies Record<string, { facets?: readonly FacetName[] }>;

export type FeatureKey = keyof typeof FEATURES;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function facetsOf(key: FeatureKey): readonly FacetName[] {
    const entry: { facets?: readonly FacetName[] } = FEATURES[key];
    return entry.facets ?? [];
}

export const DEFAULT_ENGINE = 'postgresql';

/** Engine of a saved database: absent means PostgreSQL (every database saved before 1.5) */
export function engineOf(db: { engine?: string } | null | undefined): string {
    return typeof db?.engine === 'string' && db.engine ? db.engine : DEFAULT_ENGINE;
}

/**
 * Engines always on: no switch in Settings, and a level saved while one was in testing
 * (features.json, e.g. mongodb: 'off' or 'beta') no longer applies. MongoDB since 1.5.
 */
export const STABLE_ENGINES: readonly string[] = [DEFAULT_ENGINE, 'mongodb'];

/** Levels before the user changes anything. Engines missing here are off. */
export const DEFAULT_ROLLOUT: FeatureRollout = { engines: Object.fromEntries(STABLE_ENGINES.map(engine => [engine, 'on'])), disabled: [] };

const LEVELS: RolloutLevel[] = ['off', 'beta', 'on'];

/** Keeps only valid entries of a features.json (or of anything else) */
export function sanitizeRollout(raw: unknown): FeatureRollout {
    const value = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const engines: FeatureRollout['engines'] = { ...DEFAULT_ROLLOUT.engines };
    if (value.engines && typeof value.engines === 'object' && !Array.isArray(value.engines)) {
        for (const [engine, level] of Object.entries(value.engines as Record<string, unknown>)) {
            if (/^[a-z][a-z0-9-]{0,31}$/.test(engine) && LEVELS.includes(level as RolloutLevel)) {
                engines[engine] = level as RolloutLevel;
            }
        }
    }
    for (const engine of STABLE_ENGINES) engines[engine] = 'on';
    const disabled = Array.isArray(value.disabled)
        ? [...new Set(value.disabled.filter((key): key is FeatureKey => typeof key === 'string' && key in FEATURES))]
        : [];
    return { engines, disabled };
}

/**
 * Overrides for development, e.g. "mongodb:beta,explorer.edit:off" (BBDUMP_FEATURES, ignored
 * by the packaged app): engine levels, or a feature turned off.
 */
export function applyOverrides(rollout: FeatureRollout, spec: string | undefined): FeatureRollout {
    if (!spec) return rollout;
    const engines = { ...rollout.engines };
    const disabled = new Set(rollout.disabled);
    for (const part of spec.split(',')) {
        const [name, level] = part.trim().split(':');
        if (!name || !level) continue;
        if (name in FEATURES) {
            if (level === 'off') disabled.add(name);
            else disabled.delete(name);
        } else {
            engines[name] = level as RolloutLevel;
        }
    }
    return sanitizeRollout({ engines, disabled: [...disabled] });
}

/** Whether a feature can be used on a database of this engine, and why not */
export function resolveFeature(engine: string, key: FeatureKey, rollout: FeatureRollout = DEFAULT_ROLLOUT): FeatureState {
    const manifest = manifestFor(engine);
    if (!manifest) return { enabled: false, beta: false, reason: 'engine.unknown' };
    const level = STABLE_ENGINES.includes(engine) ? 'on' : rollout.engines[engine] ?? 'off';
    if (level === 'off') return { enabled: false, beta: false, reason: 'engine.off' };
    const support = manifest.features[key] ?? 'no';
    if (support === 'no') return { enabled: false, beta: false, reason: 'feature.unsupported', detail: manifest.reasons?.[key] };
    if (rollout.disabled.includes(key)) return { enabled: false, beta: false, reason: 'feature.disabled' };
    return { enabled: true, beta: level === 'beta' || support === 'beta' };
}
