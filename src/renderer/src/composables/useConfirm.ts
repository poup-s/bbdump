import { reactive } from 'vue';

interface ConfirmOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'success' | 'error' | 'warning' | 'info' | 'danger';
    onConfirm: () => void;
}

const state = reactive({
    show: false,
    title: '',
    message: '',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    type: 'warning' as 'success' | 'error' | 'warning' | 'info' | 'danger',
    onConfirm: () => { }
});

// File d'attente pour les confirms en attente
const pendingQueue: ConfirmOptions[] = [];

export function useConfirm() {
    const showConfirm = (options: ConfirmOptions) => {
        if (state.show) {
            // Si un confirm est déjà affiché, mettre en file d'attente
            pendingQueue.push(options);
            return;
        }
        applyOptions(options);
    };

    const applyOptions = (options: ConfirmOptions) => {
        state.title = options.title;
        state.message = options.message;
        state.confirmText = options.confirmText || 'Confirm';
        state.cancelText = options.cancelText || 'Cancel';
        state.type = options.type || 'warning';
        state.onConfirm = options.onConfirm;
        state.show = true;
    };

    const hideConfirm = () => {
        state.show = false;
        state.onConfirm = () => { };
        // Afficher le prochain confirm en attente
        if (pendingQueue.length > 0) {
            const next = pendingQueue.shift()!;
            // Utiliser nextTick via setTimeout pour laisser le DOM se mettre à jour
            setTimeout(() => applyOptions(next), 100);
        }
    };

    const confirm = () => {
        state.onConfirm();
        hideConfirm();
    };

    return {
        state,
        showConfirm,
        hideConfirm,
        cancel: hideConfirm,
        confirm
    };
}
