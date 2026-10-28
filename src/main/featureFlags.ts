/**
 * Feature flags of this installation: <userData>/features.json (apart from config.json, whose
 * format older versions read), absent by default. Every handler that acts on a database checks
 * its feature here: the renderer hiding a button is never the only guard.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { pathManager } from './paths';
import { logger } from './logger';
import { STABLE_ENGINES, applyOverrides, sanitizeRollout, resolveFeature, type FeatureKey } from '../shared/engines/features';
import { manifestFor } from '../shared/engines/manifests';
import type { FeatureRollout, FeatureState, RolloutLevel } from '../shared/engines/types';

const featuresPath = () => path.join(pathManager.appDataPath, 'features.json');

let cache: FeatureRollout | null = null;

/** The levels in force: features.json, then BBDUMP_FEATURES in development only */
export function currentRollout(): FeatureRollout {
    if (cache) return cache;
    let raw: unknown = {};
    try {
        if (fs.existsSync(featuresPath())) raw = JSON.parse(fs.readFileSync(featuresPath(), 'utf8'));
    } catch (error) {
        logger.warn(`features.json unreadable, default features used: ${error}`);
    }
    const devSpec = app.isPackaged ? undefined : process.env.BBDUMP_FEATURES;
    cache = applyOverrides(sanitizeRollout(raw), devSpec);
    return cache;
}

/** Turns an engine in testing on, in beta or off; PostgreSQL and MongoDB stay on */
export function setEngineLevel(engine: string, level: RolloutLevel): FeatureRollout {
    if (STABLE_ENGINES.includes(engine) || !manifestFor(engine) || !['off', 'beta', 'on'].includes(level)) {
        throw new Error(`Cannot set ${engine} to ${level}`);
    }
    let saved: unknown = {};
    try {
        if (fs.existsSync(featuresPath())) saved = JSON.parse(fs.readFileSync(featuresPath(), 'utf8'));
    } catch { /* unreadable: rewritten from defaults */ }
    const current = sanitizeRollout(saved);
    const next = sanitizeRollout({ ...current, engines: { ...current.engines, [engine]: level } });
    // Atomic, like config.json; development overrides are not written
    const tmp = `${featuresPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, featuresPath());
    cache = null;
    logger.info(`Engine ${engine} set to ${level}`);
    return currentRollout();
}

export function featureState(engine: string, key: FeatureKey): FeatureState {
    return resolveFeature(engine, key, currentRollout());
}

export class FeatureUnavailableError extends Error {
    constructor(readonly engine: string, readonly feature: FeatureKey, readonly state: FeatureState) {
        const label = manifestFor(engine)?.label ?? engine;
        super(state.reason === 'engine.unknown'
            ? `This database uses ${engine}, which this version of bbdump does not support`
            : `"${feature}" is not available for ${label} databases`);
        this.name = 'FeatureUnavailableError';
    }
}

/** Throws when the feature is off for this engine */
export function requireFeature(engine: string, key: FeatureKey): void {
    const state = featureState(engine, key);
    if (!state.enabled) throw new FeatureUnavailableError(engine, key, state);
}

export function registerFeatureHandlers(): void {
    ipcMain.handle('features-get', () => currentRollout());
    ipcMain.handle('features-set-engine', (_event, engine: unknown, level: unknown) =>
        setEngineLevel(String(engine), String(level) as RolloutLevel));
}
