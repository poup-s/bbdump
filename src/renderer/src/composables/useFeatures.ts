/**
 * Feature flags in the renderer: the levels come from the main process once (features.json),
 * then the shared resolver says what a database can do. Only hides; the main process enforces.
 */
import { ref } from 'vue';
import { ipcRenderer } from '../electron';
import { DEFAULT_ENGINE, DEFAULT_ROLLOUT, engineOf, resolveFeature, sanitizeRollout, type FeatureKey } from '../../../shared/engines/features';
import type { FeatureRollout, FeatureState, RolloutLevel } from '../../../shared/engines/types';

const rollout = ref<FeatureRollout>(DEFAULT_ROLLOUT);
let requested = false;

function load() {
    if (requested) return;
    requested = true;
    ipcRenderer.invoke('features-get')
        .then(levels => { rollout.value = sanitizeRollout(levels); })
        .catch(() => { requested = false; });
}

type WithEngine = { engine?: string } | null | undefined;

export function useFeatures() {
    load();
    const feature = (db: WithEngine, key: FeatureKey): FeatureState => resolveFeature(engineOf(db), key, rollout.value);
    return {
        feature,
        isEnabled: (db: WithEngine, key: FeatureKey) => feature(db, key).enabled,
        /** off / beta / on, as set in Settings (PostgreSQL is always on) */
        engineLevel: (engine: string): RolloutLevel => (engine === DEFAULT_ENGINE ? 'on' : rollout.value.engines[engine] ?? 'off'),
        /** Saved in features.json by the main process; every screen follows at once */
        setEngineLevel: async (engine: string, level: RolloutLevel) => {
            rollout.value = sanitizeRollout(await ipcRenderer.invoke('features-set-engine', engine, level));
        },
    };
}
