import { ref, computed } from 'vue';
import { translations } from '../i18n';

type Language = keyof typeof translations;

const FALLBACK_LANGUAGE: Language = 'en';
const currentLanguage = ref<Language>('en');

// Walks a dotted path ("settings.title") through a translation tree.
// Returns undefined when any segment is missing or the leaf is empty.
const lookup = (lang: Language, path: string): unknown => {
    let value: unknown = translations[lang];
    for (const key of path.split('.')) {
        if (value && typeof value === 'object' && (value as Record<string, unknown>)[key]) {
            value = (value as Record<string, unknown>)[key];
        } else {
            return undefined;
        }
    }
    return value;
};

// Current language first, then English, so a key missing in one
// translation still shows readable text instead of the raw key.
const resolve = (path: string): unknown => {
    const value = lookup(currentLanguage.value, path);
    if (value !== undefined || currentLanguage.value === FALLBACK_LANGUAGE) return value;
    return lookup(FALLBACK_LANGUAGE, path);
};

export function useI18n() {
    const t = (path: string, args?: Record<string, unknown>): string => {
        let value = resolve(path);
        if (value === undefined) return path;

        if (typeof value === 'string' && args) {
            for (const [key, val] of Object.entries(args)) {
                value = (value as string).replace(`{${key}}`, String(val));
            }
        }

        return value as string;
    };

    const te = (path: string): boolean => resolve(path) !== undefined;

    const setLanguage = (lang: Language) => {
        currentLanguage.value = lang;
    };

    return {
        t,
        te,
        currentLanguage: computed(() => currentLanguage.value),
        setLanguage
    };
}
