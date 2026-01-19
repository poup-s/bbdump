import { ref } from 'vue';
import { Toast } from '../types';

const toasts = ref<Toast[]>([]);
let nextId = 1;

export function useToast() {
    const addToast = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', actionUrl?: string) => {
        const id = nextId++;
        toasts.value.push({ id, message, type, actionUrl });
        setTimeout(() => removeToast(id), actionUrl ? 10000 : 5000); // Longer duration if there's an action
    };

    const removeToast = (id: number) => {
        toasts.value = toasts.value.filter(t => t.id !== id);
    };

    return {
        toasts,
        addToast,
        removeToast
    };
}
