/**
 * Database engines bbdump can drive. Shared by the main process, the renderer and the tests:
 * plain data and pure functions only (no Node, no Electron, no DOM).
 */

/** Engines with a driver in this version. A saved database may name another one (written by a newer bbdump). */
export type KnownEngineId = 'postgresql' | 'mongodb' | 'mysql' | 'mariadb' | 'sqlite' | 'duckdb' | 'sqlserver';

/** What the code of an engine supports for one feature */
export type Support = 'yes' | 'beta' | 'no';

/** What the user has turned on for an engine (features.json) */
export type RolloutLevel = 'off' | 'beta' | 'on';

/** Building blocks a driver may provide; a feature can depend on one of them */
export type FacetName = 'connection' | 'catalog' | 'records' | 'documents' | 'documentWrites' | 'query' | 'backup' | 'restore' | 'stats';

export interface EngineManifest {
    id: string;
    /** Product name, shown as is (not translated) */
    label: string;
    defaultPort?: number;
    /** URI schemes of its connection strings */
    uriSchemes: string[];
    /** Language of the query editor and of the AI's queries */
    queryLanguage?: 'sql';
    /** Feature → support. A missing key means 'no'. */
    features: Partial<Record<string, Support>>;
    /** Why a feature is 'no' (an i18n key), when there is something to explain */
    reasons?: Partial<Record<string, string>>;
}

export interface FeatureRollout {
    /** Engine → level. PostgreSQL is always on. */
    engines: Partial<Record<string, RolloutLevel>>;
    /** Features turned off everywhere (a switch to stop one feature without a new release) */
    disabled: string[];
}

export type FeatureOffReason = 'engine.unknown' | 'engine.off' | 'feature.unsupported' | 'feature.disabled';

export interface FeatureState {
    enabled: boolean;
    /** Shown with a "beta" badge */
    beta: boolean;
    reason?: FeatureOffReason;
    /** i18n key from the manifest that explains an unsupported feature */
    detail?: string;
}
