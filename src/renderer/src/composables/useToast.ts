import { ref } from 'vue';
import { Toast } from '../types';

const toasts = ref<Toast[]>([]);
let nextId = 1;

export function useToast() {
    const addToast = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info') => {
        const id = nextId++;
        toasts.value.push({ id, message, type });
        setTimeout(() => removeToast(id), 5000);
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
