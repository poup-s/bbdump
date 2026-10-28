/**
 * Engine drivers, loaded on first use (an engine's client library is only loaded when a
 * database of that engine is used). Every call checks the feature flag before the driver.
 */
import { getConfig } from '../ipc/configIpc';
import { requireFeature, FeatureUnavailableError } from '../featureFlags';
import { engineOf, type FeatureKey } from '../../shared/engines/features';
import type { FacetName } from '../../shared/engines/types';
import type { EngineDriver, Facets } from './driver';

const LOADERS: Record<string, () => Promise<EngineDriver>> = {
    postgresql: async () => (await import('./postgresql')).postgresqlDriver,
    mongodb: async () => (await import('./mongodb')).mongodbDriver,
};

/** Engines with a driver in this version */
export const DRIVER_ENGINES = Object.keys(LOADERS);

const loaded = new Map<string, EngineDriver>();

/** Undefined for an engine without a driver here */
export async function getDriver(engine: string): Promise<EngineDriver | undefined> {
    const cached = loaded.get(engine);
    if (cached) return cached;
    const load = LOADERS[engine];
    if (!load) return undefined;
    const driver = await load();
    loaded.set(engine, driver);
    return driver;
}

/** The facet a feature needs, for an engine; throws when the feature is off or not implemented */
export async function facetFor<K extends FacetName>(engine: string, feature: FeatureKey, facet: K): Promise<Facets[K]> {
    requireFeature(engine, feature);
    const found = (await getDriver(engine))?.[facet];
    if (!found) throw new FeatureUnavailableError(engine, feature, { enabled: false, beta: false, reason: 'feature.unsupported' });
    return found as Facets[K];
}

/** Engine of a saved database (PostgreSQL when it has none) */
export function engineOfSaved(dbId: string): string {
    const db = getConfig()?.databases?.find(d => d.id === dbId);
    if (!db) throw new Error(`Database with id "${dbId}" not found in configuration`);
    return engineOf(db);
}

/** The facet a feature needs, for a saved database */
export function facetForDb<K extends FacetName>(dbId: string, feature: FeatureKey, facet: K): Promise<Facets[K]> {
    return facetFor(engineOfSaved(dbId), feature, facet);
}
