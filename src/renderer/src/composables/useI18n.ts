import { ref, computed } from 'vue';
import { translations } from '../i18n';

const currentLanguage = ref('en');

export function useI18n() {
    const t = (path: string, args?: Record<string, any>): string => {
        const keys = path.split('.');
        let value: any = (translations as any)[currentLanguage.value];

        for (const key of keys) {
            if (value && value[key]) {
                value = value[key];
            } else {
                return path;
            }
        }

        if (typeof value === 'string' && args) {
            for (const [key, val] of Object.entries(args)) {
                value = value.replace(`{${key}}`, String(val));
            }
        }

        return value;
    };

    const te = (path: string): boolean => {
        const keys = path.split('.');
        let value: any = (translations as any)[currentLanguage.value];

        for (const key of keys) {
            if (value && value[key]) {
                value = value[key];
            } else {
                return false;
            }
        }
        return true;
    };

    const setLanguage = (lang: 'en' | 'fr') => {
        currentLanguage.value = lang;
    };

    return {
        t,
        te,
        currentLanguage: computed(() => currentLanguage.value),
        setLanguage
    };
}
