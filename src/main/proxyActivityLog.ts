export interface ProxyActivityEvent {
    id: number;
    timestamp: string;
    projectId: string;
    type: 'started' | 'stopped' | 'connected' | 'disconnected' | 'target-switched';
    port?: number;
    targetDbId?: string;
    targetHost?: string;
    targetPort?: number;
    remoteAddress?: string;
    message: string;
}

const MAX_EVENTS_PER_PROJECT = 500;

class ProxyActivityLog {
    private events = new Map<string, ProxyActivityEvent[]>();
    private nextId = 1;

    /**
     * Add an activity event for a project.
     */
    addEvent(
        projectId: string,
        type: ProxyActivityEvent['type'],
        details: Omit<ProxyActivityEvent, 'id' | 'timestamp' | 'projectId' | 'type' | 'message'> & { message: string }
    ): void {
        if (!this.events.has(projectId)) {
            this.events.set(projectId, []);
        }

        const events = this.events.get(projectId)!;
        events.push({
            id: this.nextId++,
            timestamp: new Date().toISOString(),
            projectId,
            type,
            ...details,
        });

        // FIFO: keep only the most recent events
        if (events.length > MAX_EVENTS_PER_PROJECT) {
            events.splice(0, events.length - MAX_EVENTS_PER_PROJECT);
        }
    }

    /**
     * Get events for a project (most recent first).
     */
    getEvents(projectId: string, limit = 200): ProxyActivityEvent[] {
        const events = this.events.get(projectId) || [];
        // Return most recent first, limited
        return events.slice(-limit).reverse();
    }

    /**
     * Clear events for a project.
     */
    clearEvents(projectId: string): void {
        this.events.delete(projectId);
    }

    /**
     * Clear all events.
     */
    clearAll(): void {
        this.events.clear();
    }
}

export const proxyActivityLog = new ProxyActivityLog();
