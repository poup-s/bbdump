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

export function useConfirm() {
    const showConfirm = (options: ConfirmOptions) => {
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
