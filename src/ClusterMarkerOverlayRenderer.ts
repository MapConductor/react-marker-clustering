import type {
    AddParams,
    ChangeParams,
    MapViewHolder,
    MarkerAnimationOverlayHost,
    MarkerEntity,
    MarkerOverlayRenderer,
    MarkerState,
    OnMarkerEventHandler,
    OverlayCollector,
} from '@mapconductor/js-sdk-core';

/**
 * Marker renderer backed by a `MapViewScope` marker collector.
 *
 * `MarkerClusterStrategy` only ever talks to `MarkerOverlayRenderer`, the same
 * contract `MarkerClusterStrategy.kt` uses on Android — the platform decides how
 * the resulting markers reach the map. Android gets a provider-supplied renderer
 * from the `MarkerRenderingSupport` service; on the web the parent scope's
 * collector already is the marker pipeline, so this adapter fills that slot.
 *
 * Add / change / remove are staged and committed as a single `applyDiff()` in
 * `onPostProcess()` — the same commit point Android uses. Notifying per marker
 * instead would re-run the provider's entire marker composition once per marker,
 * which reconstructs the tile renderer thousands of times on large datasets.
 *
 * `ActualMarker` is `MarkerState`: the collector is the "native" marker layer
 * here, so a rendered marker is identified by the state that was written to it.
 */
export class ClusterMarkerOverlayRenderer implements MarkerOverlayRenderer<MarkerState> {
    animateStartListener: OnMarkerEventHandler | null = null;
    animateEndListener: OnMarkerEventHandler | null = null;
    animationOverlayHost: MarkerAnimationOverlayHost | null = null;

    private readonly pendingUpserts = new Map<string, MarkerState>();
    private readonly pendingRemoveIds = new Set<string>();
    /** Ids currently written to the collector, so unmount can take them all back. */
    private readonly renderedIds = new Set<string>();

    constructor(
        private readonly collector: OverlayCollector<MarkerState>,
        readonly holder: MapViewHolder<unknown, unknown> | undefined,
    ) {}

    onAdd(data: AddParams[]): Promise<(MarkerState | null)[]> {
        for (const params of data) this.stage(params.state);
        return Promise.resolve(data.map((params) => params.state));
    }

    onChange(data: ChangeParams<MarkerState>[]): Promise<(MarkerState | null)[]> {
        for (const change of data) this.stage(change.current.state);
        return Promise.resolve(data.map((change) => change.current.state));
    }

    onRemove(data: MarkerEntity<MarkerState>[]): Promise<void> {
        for (const entity of data) {
            const id = entity.state.id;
            this.pendingUpserts.delete(id);
            this.pendingRemoveIds.add(id);
        }
        return Promise.resolve();
    }

    /**
     * Animation is driven by the strategy (it interpolates positions and calls
     * `onChange()` per frame), exactly as on Android — there is nothing for the
     * renderer to play back on its own.
     */
    onAnimate(_entity: MarkerEntity<MarkerState>): Promise<void> {
        return Promise.resolve();
    }

    onPostProcess(): Promise<void> {
        if (this.pendingUpserts.size === 0 && this.pendingRemoveIds.size === 0) {
            return Promise.resolve();
        }
        const upserts = [...this.pendingUpserts.values()];
        const removeIds = [...this.pendingRemoveIds];
        this.pendingUpserts.clear();
        this.pendingRemoveIds.clear();
        for (const id of removeIds) this.renderedIds.delete(id);
        for (const state of upserts) this.renderedIds.add(state.id);
        this.collector.applyDiff(upserts, removeIds);
        return Promise.resolve();
    }

    setMarkerVisible(_entity: MarkerEntity<MarkerState>, _visible: boolean): void {
        // The collector has no visibility channel: a hidden marker is simply
        // one that has not been written. Nothing to toggle.
    }

    /** Drops every marker this renderer wrote. Used when the group unmounts. */
    reset(): void {
        this.pendingUpserts.clear();
        this.pendingRemoveIds.clear();
        if (this.renderedIds.size === 0) return;
        const removeIds = [...this.renderedIds];
        this.renderedIds.clear();
        this.collector.applyDiff([], removeIds);
    }

    private stage(state: MarkerState): void {
        this.pendingRemoveIds.delete(state.id);
        this.pendingUpserts.set(state.id, state);
    }
}
