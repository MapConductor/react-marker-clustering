/**
 * Minimal observable value, the web counterpart of the Kotlin `StateFlow`s that
 * `MarkerClusterStrategy.kt` publishes (`debugInfoFlow`, `spiderfyLegsFlow`).
 *
 * The strategy owns the state and only ever writes; `MarkerClusterGroup`
 * subscribes and mirrors the value into the polygon / polyline collectors —
 * exactly the split Android uses with `collectAsState()`.
 */
export interface StateFlow<T> {
    readonly value: T;
    /** Invokes `subscriber` with the current value, then on every change. */
    subscribe(subscriber: (value: T) => void): () => void;
}

export class MutableStateFlow<T> implements StateFlow<T> {
    private current: T;
    private readonly subscribers = new Set<(value: T) => void>();

    constructor(initialValue: T) {
        this.current = initialValue;
    }

    get value(): T {
        return this.current;
    }

    set value(next: T) {
        if (Object.is(this.current, next)) return;
        this.current = next;
        for (const subscriber of [...this.subscribers]) subscriber(next);
    }

    subscribe(subscriber: (value: T) => void): () => void {
        this.subscribers.add(subscriber);
        subscriber(this.current);
        return () => {
            this.subscribers.delete(subscriber);
        };
    }
}
