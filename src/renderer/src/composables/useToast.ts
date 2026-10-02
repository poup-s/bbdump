import { ref } from 'vue';
import { Toast, ToastType } from '../types';

export interface ToastOptions {
    /** Technical detail shown under the message (an error from PostgreSQL, a path…) */
    detail?: string;
    /** One button in the toast, e.g. "See" */
    action?: { label: string; run: () => void };
    /** ms; by default from the type: errors stay longer than confirmations */
    duration?: number;
}

const DURATION: Record<ToastType, number> = { success: 4000, info: 5000, warning: 7000, error: 9000 };
const MAX_VISIBLE = 4;

const toasts = ref<Toast[]>([]);
const timers = new Map<number, { handle: ReturnType<typeof setTimeout> | null; endsAt: number; remaining: number }>();
let nextId = 1;

function schedule(id: number, ms: number) {
    const timer = timers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.set(id, { handle: setTimeout(() => removeToast(id), ms), endsAt: Date.now() + ms, remaining: ms });
}

function removeToast(id: number) {
    const timer = timers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.delete(id);
    toasts.value = toasts.value.filter(t => t.id !== id);
}

/** Hovering a toast keeps it on screen; it resumes where it was */
function pauseToast(id: number) {
    const timer = timers.get(id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle);
    timers.set(id, { handle: null, endsAt: 0, remaining: Math.max(0, timer.endsAt - Date.now()) });
}

function resumeToast(id: number) {
    const timer = timers.get(id);
    if (timer && !timer.handle) schedule(id, Math.max(timer.remaining, 1500));
}

function addToast(message: string, type: ToastType = 'info', options: ToastOptions = {}) {
    const duration = options.duration ?? (options.action ? Math.max(DURATION[type], 10000) : DURATION[type]);
    // The same message again (a second save, a second copy): one toast, counted, timer restarted
    const same = toasts.value.find(t => t.message === message && t.type === type && t.detail === options.detail);
    if (same) {
        same.count += 1;
        same.restartKey += 1;
        same.duration = duration;
        schedule(same.id, duration);
        return same.id;
    }
    const id = nextId++;
    toasts.value = [{ id, message, type, detail: options.detail, action: options.action, duration, count: 1, restartKey: 0 }, ...toasts.value];
    for (const extra of toasts.value.slice(MAX_VISIBLE)) removeToast(extra.id);
    schedule(id, duration);
    return id;
}

export function useToast() {
    return { toasts, addToast, removeToast, pauseToast, resumeToast };
}
