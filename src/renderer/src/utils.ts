import { Database } from './types';

export function getErrorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function getDbDisplayName(db: Database): string {
    if (db.displayName && db.displayName.trim() !== '') {
        return db.displayName;
    }
    return db.name;
}

export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDate(dateStr: string): string {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleString();
}

export function getLogClass(level: string): string {
    switch (level) {
        case 'error': return 'text-red-600 bg-red-50 border-l-4 border-red-500';
        case 'warn': return 'text-yellow-600 bg-yellow-50 border-l-4 border-yellow-500';
        case 'info':
        default: return 'text-gray-700 bg-gray-50 border-l-4 border-gray-500';
    }
}

export function getLevelClass(level: string): string {
    switch (level) {
        case 'error': return 'text-red-700';
        case 'warn': return 'text-yellow-700';
        case 'info':
        default: return 'text-blue-700';
    }
}
