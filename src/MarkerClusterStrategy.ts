import {
    AbstractMarkerRenderingStrategy,
    ColorDefaultIcon,
    createGeoPoint,
    createGeoRectBounds,
    createMarkerEntity,
    createMarkerState,
    Earth,
    expandBounds,
    fingerPrintEquals,
    HexGeocellImpl,
    MarkerManager,
    Mutex,
    Spherical,
    type AddParams,
    type ChangeParams,
    type GeoPoint,
    type GeoPointInterface,
    type GeoRectBounds,
    type HexGeocell,
    type MapCameraPosition,
    type MarkerEntity,
    type MarkerFingerPrint,
    type MarkerIcon,
    type MarkerOverlayRenderer,
    type MarkerState,
    type Offset,
    type Serializable,
} from '@mapconductor/js-sdk-core';
import type { MarkerCluster, MarkerClusterDebugInfo, SpiderfyLeg } from './MarkerCluster';
import { MutableStateFlow, type StateFlow } from './StateFlow';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_CLUSTER_RADIUS_PX = 90.0;
export const DEFAULT_MIN_CLUSTER_SIZE = 3;
export const DEFAULT_EXPAND_MARGIN = 0.2;
export const DEFAULT_TILE_SIZE = 256.0;
export const DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS = 300;
export const DEFAULT_CAMERA_DEBOUNCE_MILLIS = 100;
export const DEFAULT_SPIDERFY_MARKER_SIZE_PX = 52.0;
export const DEFAULT_SPIDERFY_MARKER_MARGIN_PX = 8.0;

const SPIDERFY_LAYOUT_MAX_ITERATIONS = 150;
const SPIDERFY_LAYOUT_CONVERGENCE_THRESHOLD = 0.15;
const MAX_DENSE_CELLS = 4;
const MAX_DENSE_CANDIDATES = 50;
const PAN_ANIMATION_MIN_DISTANCE_METERS = 1.0;
const CAMERA_ANGLE_EPSILON = 1e-2;
const ANIMATION_FRAME_MILLIS_60_FPS = 16;
const ANIMATION_FRAME_MILLIS_30_FPS = 33;
const ANIMATION_FRAME_MILLIS_8_FPS = 125;
const ANIMATION_FRAME_MILLIS_4_FPS = 250;
const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;
const MAX_SIN_LAT = 0.9999;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClusterIconProvider = (count: number) => MarkerIcon;
export type ClusterIconProviderWithTurn = (count: number, turn: number) => MarkerIcon;

export const DEFAULT_ICON_PROVIDER: ClusterIconProvider = (count) =>
    new ColorDefaultIcon({ fillColor: '#2563EB', label: String(count) });

export interface MarkerClusterOptions {
    clusterRadiusPx?: number;
    minClusterSize?: number;
    expandMargin?: number;
    clusterIconProvider?: ClusterIconProvider;
    /** Takes precedence over `clusterIconProvider`; `turn` increments on every zoom change. */
    clusterIconProviderWithTurn?: ClusterIconProviderWithTurn | null;
    onClusterClick?: ((cluster: MarkerCluster) => void) | null;
    /**
     * Called before newly appearing individual (non-cluster) markers are
     * rendered — e.g. when a cluster expands after a zoom. Applying the new
     * cluster state is deferred until the returned promise settles, so the app
     * can preload marker icon images (and show a loading indicator) before the
     * markers pop in. A newer recluster supersedes any pending deferred apply.
     */
    prepareExpand?: ((appearing: MarkerState[]) => Promise<void>) | null;
    /**
     * At or above this zoom, clicking a cluster fans its members out around the
     * (kept) cluster marker, connected by leg polylines — useful when multiple
     * markers share the same location and can never be separated by zooming.
     * Clicking the same cluster again, or any recluster (camera move / data
     * change), collapses the fan. Below this zoom the click falls through to
     * `onClusterClick`. Undefined disables the feature.
     */
    spiderfyMinZoom?: number | null;
    /** Marker diameter in px used by the overlap-avoiding spiderfy layout. */
    spiderfyMarkerSizePx?: number;
    /** Extra gap between fanned-out markers in px. */
    spiderfyMarkerMarginPx?: number;
    /**
     * Called when a spiderfy fan opens (true) or collapses (false) — e.g. to
     * close an info bubble when the user clicks another cluster or the fan is
     * dismissed by a camera move.
     */
    onSpiderfyChange?: ((open: boolean) => void) | null;
    enableZoomAnimation?: boolean;
    enablePanAnimation?: boolean;
    zoomAnimationDurationMillis?: number;
    /**
     * Accepted for parity with the Android strategy, which likewise ignores it:
     * hull points are always computed, and `MarkerClusterGroup` decides whether
     * to draw them.
     */
    debugHullPolygons?: boolean;
    cameraIdleDebounceMillis?: number;
    tileSize?: number;
    geocell?: HexGeocell;
}

interface ClusterCell { x: number; y: number }
interface ClusterCandidate { cell: ClusterCell; center: GeoPoint; members: MarkerState[] }
interface MergedCluster { center: GeoPoint; members: MarkerState[] }
interface HullPoint { x: number; y: number }
interface PixelPoint { member: MarkerState; x: number; y: number }

interface RenderRequest {
    cameraPosition: MapCameraPosition;
    viewport: GeoRectBounds;
    renderer: MarkerOverlayRenderer<MarkerState>;
    token: number;
}

interface AnimatedRemove { entity: MarkerEntity<MarkerState>; target: GeoPoint }
interface AnimatedAdd { state: MarkerState; start: GeoPoint }

interface AnimatedMove {
    id: string;
    start: GeoPoint;
    end: GeoPoint;
    baseState: MarkerState;
    entity: MarkerEntity<MarkerState>;
    /**
     * True for appearing markers, whose `baseState` already carries the final
     * position and is the app-owned instance: hand that instance back on the
     * last frame instead of a positional copy, so later app-side mutations of
     * the marker still reach the map.
     */
    restoreBaseStateAtEnd: boolean;
}

function delay(millis: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

// ── Strategy ──────────────────────────────────────────────────────────────────

/**
 * Grid-based greedy marker clustering, ported from `MarkerClusterStrategy.kt`.
 *
 * As on Android, the strategy owns the whole pipeline — source states, camera
 * debouncing, cluster computation, expand/shrink animation and spiderfy — and
 * pushes its output through a `MarkerOverlayRenderer`. `MarkerClusterGroup` only
 * feeds it markers and camera events and mirrors `debugInfoFlow` /
 * `spiderfyLegsFlow` into the polygon and polyline collectors.
 */
export class MarkerClusterStrategy extends AbstractMarkerRenderingStrategy<MarkerState> {
    private readonly clusterRadiusPx: number;
    private readonly minClusterSize: number;
    private readonly expandMargin: number;
    private readonly clusterIconProvider: ClusterIconProvider;
    private readonly clusterIconProviderWithTurn: ClusterIconProviderWithTurn | null;
    private readonly onClusterClick: ((cluster: MarkerCluster) => void) | null;
    private readonly prepareExpand: ((appearing: MarkerState[]) => Promise<void>) | null;
    private readonly spiderfyMinZoom: number | null;
    private readonly spiderfyMarkerSizePx: number;
    private readonly spiderfyMarkerMarginPx: number;
    private readonly onSpiderfyChange: ((open: boolean) => void) | null;
    private readonly enableZoomAnimation: boolean;
    private readonly enablePanAnimation: boolean;
    private readonly zoomAnimationDurationMillis: number;
    private readonly cameraIdleDebounceMillis: number;
    private readonly tileSize: number;

    private readonly sourceStates = new Map<string, MarkerState>();

    // Full marker fingerprints of the source states. `!==` on a MarkerState is a
    // reference check, so an in-place `markerState.position = …` compares the
    // instance against itself and would never look changed; comparing
    // fingerprints catches it. Mirrors `sourceFingerprints` on iOS/Android.
    private readonly sourceFingerprints = new Map<string, MarkerFingerPrint>();
    private sourceStateVersion = 0;
    private lastCameraPosition: MapCameraPosition | null = null;
    private lastKnownViewport: GeoRectBounds | null = null;
    private lastKnownViewportZoom: number | null = null;
    private clusteringTurn = 0;
    private lastZoomKey: number | null = null;
    private cameraUpdateToken = 0;
    private lastRenderer: MarkerOverlayRenderer<MarkerState> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // JS has no threads, but `await` points inside renderClusters() interleave
    // just like Android's coroutines do, so the same critical section applies.
    private readonly semaphore = new Mutex();
    /** Conflated: only the newest pending request survives, as on Android. */
    private pendingRequest: RenderRequest | null = null;
    private renderWorkerActive = false;
    private lastRenderCameraPosition: MapCameraPosition | null = null;
    private readonly _debugInfoFlow = new MutableStateFlow<MarkerClusterDebugInfo[]>([]);
    private lastUsedViewport: GeoRectBounds | null = null;
    private forceNextRender = false;

    /**
     * Called after cluster computation and before marker animations start. Set
     * by `MarkerClusterGroup` to commit hull polygon updates first, so polygon
     * rendering and marker animation cannot race each other.
     */
    onBeforeAnimation: ((debugInfos: MarkerClusterDebugInfo[]) => Promise<void> | void) | null = null;

    private lastClusterMemberCenters = new Map<string, GeoPoint>();
    private lastClusterPositions = new Map<string, GeoPoint>();
    private lastClusterAssignments = new Map<string, string>();
    private lastClusterCoverageBounds: GeoRectBounds | null = null;
    private lastSourceStateVersion = 0;
    private lastSourceFingerprints = new Map<string, string>();
    private renderCount = 0;

    private readonly renderedMarkerEntities = new Map<string, MarkerEntity<MarkerState>>();

    // ── Spiderfy (click-to-fan-out) state ─────────────────────────────────
    private readonly _spiderfyLegsFlow = new MutableStateFlow<SpiderfyLeg[]>([]);
    private readonly spiderfyMutex = new Mutex();
    private spiderfyToken = 0;
    private spiderfyClusterKey: string | null = null;
    private spiderfyEntities: MarkerEntity<MarkerState>[] = [];

    constructor(options: MarkerClusterOptions = {}) {
        super(new MarkerManager<MarkerState>(options.geocell ?? HexGeocellImpl.defaultGeocell(), 0));
        this.clusterRadiusPx = options.clusterRadiusPx ?? DEFAULT_CLUSTER_RADIUS_PX;
        this.minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
        this.expandMargin = options.expandMargin ?? DEFAULT_EXPAND_MARGIN;
        this.clusterIconProvider = options.clusterIconProvider ?? DEFAULT_ICON_PROVIDER;
        this.clusterIconProviderWithTurn = options.clusterIconProviderWithTurn ?? null;
        this.onClusterClick = options.onClusterClick ?? null;
        this.prepareExpand = options.prepareExpand ?? null;
        this.spiderfyMinZoom = options.spiderfyMinZoom ?? null;
        this.spiderfyMarkerSizePx = options.spiderfyMarkerSizePx ?? DEFAULT_SPIDERFY_MARKER_SIZE_PX;
        this.spiderfyMarkerMarginPx = options.spiderfyMarkerMarginPx ?? DEFAULT_SPIDERFY_MARKER_MARGIN_PX;
        this.onSpiderfyChange = options.onSpiderfyChange ?? null;
        this.enableZoomAnimation = options.enableZoomAnimation ?? false;
        this.enablePanAnimation = options.enablePanAnimation ?? false;
        this.zoomAnimationDurationMillis =
            options.zoomAnimationDurationMillis ?? DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS;
        this.cameraIdleDebounceMillis = options.cameraIdleDebounceMillis ?? DEFAULT_CAMERA_DEBOUNCE_MILLIS;
        this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
    }

    /**
     * True when this source marker has already been handed to the strategy via
     * `onAdd`. Lets the group tell a genuine edit from the fingerprint replay a
     * fresh state subscription emits.
     */
    hasSourceMarker(id: string): boolean {
        return this.sourceStates.has(id);
    }

    /** Hull polygons of the clusters produced by the latest computation. */
    get debugInfoFlow(): StateFlow<MarkerClusterDebugInfo[]> {
        return this._debugInfoFlow;
    }

    /**
     * Leg polylines of the currently open spiderfy fan (empty when no fan is
     * open). `MarkerClusterGroup` observes this to draw the leg polylines.
     */
    get spiderfyLegsFlow(): StateFlow<SpiderfyLeg[]> {
        return this._spiderfyLegsFlow;
    }

    override clear(): void {
        this.sourceStates.clear();
        this.sourceFingerprints.clear();
        this.sourceStateVersion = 0;
        this.markerManager.clear();
        this._debugInfoFlow.value = [];
        this.lastClusterMemberCenters = new Map();
        this.lastClusterPositions = new Map();
        this.lastClusterAssignments = new Map();
        this.lastClusterCoverageBounds = null;
        this.lastSourceStateVersion = 0;
        this.lastSourceFingerprints = new Map();
        this.lastZoomKey = null;
        this.clusteringTurn = 0;
        this.renderCount = 0;
        this.renderedMarkerEntities.clear();
        this.lastRenderCameraPosition = null;
        this.lastKnownViewport = null;
        this.lastKnownViewportZoom = null;
        this.lastUsedViewport = null;
        this.forceNextRender = false;
        this.spiderfyToken++;
        this.spiderfyClusterKey = null;
        this.spiderfyEntities = [];
        this._spiderfyLegsFlow.value = [];
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingRequest = null;
    }

    /**
     * Forces a full cluster recompute on the next render, bypassing the
     * coverage-bounds early return. Used by `MarkerClusterGroup` so debug hull
     * polygons reflect the current camera position as soon as they are enabled.
     */
    forceRender(): void {
        this.forceNextRender = true;
        const cameraPosition = this.lastCameraPosition;
        if (!cameraPosition) return;
        const viewport = this.lastKnownViewport ?? this.lastUsedViewport;
        if (!viewport) return;
        const renderer = this.lastRenderer;
        if (!renderer) return;
        this.enqueueRender(cameraPosition, viewport, renderer, ++this.cameraUpdateToken);
    }

    override async onAdd(params: {
        data: MarkerState[];
        viewport: GeoRectBounds;
        renderer: MarkerOverlayRenderer<MarkerState>;
    }): Promise<boolean> {
        // renderClusters() iterates `sourceStates`; guard mutations with the
        // same lock so a render in flight never sees a half-applied update.
        await this.semaphore.withLock(() => {
            this.updateSourceStates(params.data);
        });
        this.lastRenderer = params.renderer;
        if (!this.lastCameraPosition) return true;
        this.enqueueRender(this.lastCameraPosition, params.viewport, params.renderer, this.cameraUpdateToken);
        return true;
    }

    override async onUpdate(params: {
        state: MarkerState;
        viewport: GeoRectBounds;
        renderer: MarkerOverlayRenderer<MarkerState>;
    }): Promise<boolean> {
        await this.semaphore.withLock(() => {
            const nextFingerPrint = params.state.fingerPrint();
            const prevFingerPrint = this.sourceFingerprints.get(params.state.id);
            this.sourceStates.set(params.state.id, params.state);
            this.sourceFingerprints.set(params.state.id, nextFingerPrint);
            if (!prevFingerPrint || !fingerPrintEquals(prevFingerPrint, nextFingerPrint)) {
                this.sourceStateVersion++;
            }
        });
        this.lastRenderer = params.renderer;
        if (!this.lastCameraPosition) return true;
        this.enqueueRender(this.lastCameraPosition, params.viewport, params.renderer, this.cameraUpdateToken);
        return true;
    }

    async onCameraChanged(
        cameraPosition: MapCameraPosition,
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<void> {
        this.lastCameraPosition = cameraPosition;
        const bounds = cameraPosition.visibleRegion?.bounds;
        if (bounds && !bounds.isEmpty) {
            this.lastKnownViewport = bounds;
            this.lastKnownViewportZoom = cameraPosition.zoom;
        }
        this.lastRenderer = renderer;
        const token = ++this.cameraUpdateToken;
        // A pending timer can only ever fire with a stale token now, so dropping
        // it is equivalent to Android letting the superseded job run and bail.
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (token !== this.cameraUpdateToken) return;
            const currentCamera = this.lastCameraPosition;
            if (!currentCamera) return;
            // Some providers (e.g. ArcGIS) emit camera changes with a null
            // visibleRegion during animations; scaling the last known viewport
            // by 2^(zoomDelta) preserves the correct screen-space coverage so
            // markers newly visible after a zoom-out are still clustered.
            const currentViewport =
                (currentCamera.visibleRegion?.bounds && !currentCamera.visibleRegion.bounds.isEmpty
                    ? currentCamera.visibleRegion.bounds
                    : null) ?? this.estimateViewport(currentCamera.zoom, currentCamera.position);
            if (!currentViewport) return;
            const currentRenderer = this.lastRenderer;
            if (!currentRenderer) return;
            this.enqueueRender(currentCamera, currentViewport, currentRenderer, token);
        }, Math.max(0, this.cameraIdleDebounceMillis));
    }

    private enqueueRender(
        cameraPosition: MapCameraPosition,
        viewport: GeoRectBounds,
        renderer: MarkerOverlayRenderer<MarkerState>,
        token: number,
    ): void {
        this.pendingRequest = { cameraPosition, viewport, renderer, token };
        if (this.renderWorkerActive) return;
        this.renderWorkerActive = true;
        void this.runRenderWorker();
    }

    private async runRenderWorker(): Promise<void> {
        try {
            while (this.pendingRequest) {
                const request = this.pendingRequest;
                this.pendingRequest = null;
                try {
                    await this.renderClusters(request);
                } catch (error) {
                    console.warn('[MapConductor] marker clustering render failed', error);
                }
            }
        } finally {
            this.renderWorkerActive = false;
        }
    }

    private updateSourceStates(data: MarkerState[]): void {
        const nextIds = new Set(data.map((state) => state.id));
        let changed = false;
        for (const id of [...this.sourceStates.keys()]) {
            if (nextIds.has(id)) continue;
            this.sourceStates.delete(id);
            this.sourceFingerprints.delete(id);
            changed = true;
        }
        for (const state of data) {
            const nextFingerPrint = state.fingerPrint();
            const prevFingerPrint = this.sourceFingerprints.get(state.id);
            if (!prevFingerPrint || !fingerPrintEquals(prevFingerPrint, nextFingerPrint)) changed = true;
            this.sourceStates.set(state.id, state);
            this.sourceFingerprints.set(state.id, nextFingerPrint);
        }
        if (changed) this.sourceStateVersion++;
    }

    // ── Cluster computation ───────────────────────────────────────────────────

    private async renderClusters(request: RenderRequest): Promise<void> {
        const { cameraPosition, viewport, renderer, token } = request;
        await this.semaphore.withLock(async () => {
            if (token !== this.cameraUpdateToken) return;
            this.renderCount++;
            const expandedBounds = expandBounds(viewport, this.expandMargin);
            const zoom = cameraPosition.zoom;
            const effectiveRadiusPx = this.effectiveClusterRadiusPx(zoom);
            const { turn, zoomChanged } = this.updateClusteringTurn(zoom);
            const sourceStateVersionSnapshot = this.sourceStateVersion;
            const lastSourceFingerprintsSnapshot = this.lastSourceFingerprints;
            const currentFingerprints = new Map<string, string>();
            const stableSource = sourceStateVersionSnapshot === this.lastSourceStateVersion;
            const cameraMoved = this.lastRenderCameraPosition != null &&
                this.hasCameraMoved(this.lastRenderCameraPosition, cameraPosition);
            const animateTransitions =
                (this.enableZoomAnimation && zoomChanged) ||
                (this.enablePanAnimation && cameraMoved);
            const forced = this.forceNextRender;
            this.forceNextRender = false;
            this.lastUsedViewport = viewport;

            // Any recluster (camera move / data change) collapses an open
            // spiderfy fan and supersedes a pending fan open.
            this.spiderfyToken++;
            await this.spiderfyMutex.withLock(() => this.collapseSpiderfyLocked(renderer));

            if (
                !forced &&
                !zoomChanged &&
                this.lastClusterCoverageBounds != null &&
                this.containsBounds(this.lastClusterCoverageBounds, expandedBounds) &&
                stableSource
            ) {
                this.lastRenderCameraPosition = cameraPosition;
                return;
            }

            await this.cleanupStaleMarkers(zoom, renderer, animateTransitions);

            const debugInfos: MarkerClusterDebugInfo[] = [];
            const clusterMemberCenters = new Map<string, GeoPoint>();
            const clusterPositions = new Map<string, GeoPoint>();

            if (zoomChanged) {
                this.lastClusterAssignments = new Map();
            }

            // ── Partition markers into cached / new ───────────────────────────
            const cachedMarkers: MarkerState[] = [];
            const newMarkers: MarkerState[] = [];

            for (const state of this.sourceStates.values()) {
                if (!this.containsInViewport(expandedBounds, state.position, zoom)) continue;

                const fingerPrint = this.markerFingerPrint(state.position);
                currentFingerprints.set(state.id, fingerPrint);
                const movedSinceLastRender =
                    (lastSourceFingerprintsSnapshot.get(state.id) ?? '\0') !== fingerPrint;

                if (
                    !zoomChanged &&
                    this.containsInViewport(this.lastClusterCoverageBounds, state.position, zoom) &&
                    this.lastClusterAssignments.has(state.id) &&
                    !movedSinceLastRender
                ) {
                    cachedMarkers.push(state);
                } else {
                    newMarkers.push(state);
                }
            }

            // Rebuild cached cluster / individual groups from last assignments.
            const cachedClusterGroups = new Map<string, MarkerState[]>();
            const cachedMarkerGroups = new Map<string, MarkerState[]>();
            for (const marker of cachedMarkers) {
                const clusterId = this.lastClusterAssignments.get(marker.id);
                if (clusterId && clusterId.startsWith('cluster_')) {
                    const group = cachedClusterGroups.get(clusterId);
                    if (group) group.push(marker);
                    else cachedClusterGroups.set(clusterId, [marker]);
                } else {
                    const key = clusterId ?? marker.id;
                    const group = cachedMarkerGroups.get(key);
                    if (group) group.push(marker);
                    else cachedMarkerGroups.set(key, [marker]);
                }
            }

            // ── Grid-bucket new markers ────────────────────────────────────────
            const desiredMarkerStates: MarkerState[] = [];
            const clustered = new Map<string, { cell: ClusterCell; members: MarkerState[] }>();
            for (const state of newMarkers) {
                const [px, py] = this.projectToPixel(state.position, zoom);
                const cell: ClusterCell = {
                    x: Math.floor(px / effectiveRadiusPx),
                    y: Math.floor(py / effectiveRadiusPx),
                };
                const key = `${cell.x},${cell.y}`;
                const entry = clustered.get(key);
                if (entry) entry.members.push(state);
                else clustered.set(key, { cell, members: [state] });
            }

            const candidates: ClusterCandidate[] = [];
            for (const { cell, members } of clustered.values()) {
                const first = members[0];
                if (!first) continue;
                candidates.push({
                    cell,
                    center: createGeoPoint({
                        latitude: first.position.latitude,
                        longitude: first.position.longitude,
                    }),
                    members,
                });
            }
            candidates.sort((a, b) => (a.cell.x !== b.cell.x ? a.cell.x - b.cell.x : a.cell.y - b.cell.y));

            const mergedClusters = this.mergeClusters(candidates, zoom, effectiveRadiusPx);

            // ── Merge with cached clusters ─────────────────────────────────────
            const finalMergedClusters: MergedCluster[] = [];
            const usedCachedClusters = new Set<string>();

            for (const merged of mergedClusters) {
                let mergedWithCached = false;

                for (const [cachedClusterId, cachedMembers] of cachedClusterGroups) {
                    if (mergedWithCached || usedCachedClusters.has(cachedClusterId)) continue;
                    const cachedPosition = this.lastClusterPositions.get(cachedClusterId);
                    if (!cachedPosition) continue;
                    const thresholdMeters = effectiveRadiusPx * this.metersPerPixel(merged.center, zoom);
                    if (Spherical.computeDistanceBetween(merged.center, cachedPosition) <= thresholdMeters) {
                        finalMergedClusters.push({
                            center: cachedPosition,
                            members: [...cachedMembers, ...merged.members],
                        });
                        usedCachedClusters.add(cachedClusterId);
                        mergedWithCached = true;
                    }
                }

                if (!mergedWithCached) finalMergedClusters.push(merged);
            }

            for (const [cachedClusterId, cachedMembers] of cachedClusterGroups) {
                if (usedCachedClusters.has(cachedClusterId)) continue;
                const cachedPosition = this.lastClusterPositions.get(cachedClusterId);
                if (!cachedPosition) continue;
                finalMergedClusters.push({ center: cachedPosition, members: cachedMembers });
            }

            for (const cachedMembers of cachedMarkerGroups.values()) {
                const first = cachedMembers[0];
                if (!first) continue;
                finalMergedClusters.push({
                    center: createGeoPoint({
                        latitude: first.position.latitude,
                        longitude: first.position.longitude,
                    }),
                    members: cachedMembers,
                });
            }

            // ── Build the desired output ───────────────────────────────────────
            const coverageBounds = createGeoRectBounds();
            const nextClusterAssignments = new Map<string, string>();

            for (const merged of finalMergedClusters) {
                if (merged.members.length >= this.minClusterSize) {
                    // Centroid via the convex hull's shoelace formula (in pixel
                    // space). Degenerate hulls (all members at nearly the same
                    // point) fall back to the member average, so a same-venue
                    // cluster renders at that venue rather than at the first
                    // member or a cached position.
                    const hull = this.convexHullProjected(merged.members, zoom);
                    const centroidPx = this.polygonCentroidProjected(hull);
                    const center = centroidPx
                        ? this.unprojectPixel(centroidPx, zoom)
                        : this.averagePosition(merged.members);

                    // The rendered center is recomputed from the CURRENT members
                    // on every recluster, so membership-stable pans yield the
                    // identical centroid (no flicker) while membership changes
                    // move the cluster to its true center.
                    const [cx, cy] = this.projectToPixel(center, zoom);
                    const cell: ClusterCell = {
                        x: Math.floor(cx / effectiveRadiusPx),
                        y: Math.floor(cy / effectiveRadiusPx),
                    };
                    const clusterId = this.buildClusterId(cell, zoom);
                    const radiusMeters = this.calculateClusterRadiusMeters(center, merged.members);
                    const cluster: MarkerCluster = {
                        count: merged.members.length,
                        markerIds: merged.members.map((member) => member.id),
                    };

                    debugInfos.push({
                        id: clusterId,
                        center,
                        radiusMeters,
                        count: merged.members.length,
                        cellX: cell.x,
                        cellY: cell.y,
                        hullPoints: hull.length >= 3
                            ? hull.map((point) => this.unprojectPixel(point, zoom))
                            : [],
                    });

                    for (const member of merged.members) {
                        clusterMemberCenters.set(member.id, center);
                        nextClusterAssignments.set(member.id, clusterId);
                    }
                    clusterPositions.set(clusterId, center);
                    this.extendCoverageBounds(coverageBounds, center, radiusMeters);

                    const clusterIcon =
                        this.clusterIconProviderWithTurn?.(merged.members.length, turn) ??
                        this.clusterIconProvider(merged.members.length);
                    // Cluster clicks first try spiderfy (when configured and
                    // zoomed in enough), then fall through to onClusterClick.
                    const clusterClickable = this.onClusterClick != null || this.spiderfyMinZoom != null;
                    desiredMarkerStates.push(createMarkerState({
                        id: clusterId,
                        position: center,
                        extra: cluster as unknown as Serializable,
                        icon: clusterIcon,
                        clickable: clusterClickable,
                        draggable: false,
                        onClick: clusterClickable
                            ? () => {
                                if (!this.tryToggleSpiderfy(cluster)) {
                                    this.onClusterClick?.(cluster);
                                }
                            }
                            : null,
                    }));
                } else {
                    for (const member of merged.members) {
                        coverageBounds.extend(member.position);
                        nextClusterAssignments.set(member.id, member.id);
                    }
                    desiredMarkerStates.push(...merged.members);
                }
            }

            if (token !== this.cameraUpdateToken) return;
            this._debugInfoFlow.value = debugInfos;

            // Keep the current (clustered) rendering on screen until the app has
            // prepared the newly appearing individual markers (e.g. icon
            // preloading). A newer camera update supersedes this deferred apply
            // through the token check below.
            if (this.prepareExpand) {
                const appearing = desiredMarkerStates.filter(
                    (state) => !state.id.startsWith('cluster_') && !this.renderedMarkerEntities.has(state.id),
                );
                if (appearing.length > 0) {
                    // A failed prepare must not block rendering.
                    await this.prepareExpand(appearing).catch(() => undefined);
                    if (token !== this.cameraUpdateToken) return;
                }
            }

            const previousClusterMemberCenters = this.lastClusterMemberCenters;
            // Commit hull polygon updates before animation starts, so polygon
            // rendering and marker animation cannot race each other.
            await this.onBeforeAnimation?.(debugInfos);
            await this.updateRenderedMarkers({
                desiredStates: desiredMarkerStates,
                renderer,
                token,
                animateTransitions,
                previousClusterMemberCenters,
                nextClusterMemberCenters: clusterMemberCenters,
            });

            this.lastClusterMemberCenters = clusterMemberCenters;
            this.lastClusterPositions = clusterPositions;
            this.lastClusterAssignments = nextClusterAssignments;
            this.lastRenderCameraPosition = cameraPosition;
            this.lastClusterCoverageBounds = coverageBounds.isEmpty ? null : coverageBounds;
            this.lastSourceStateVersion = sourceStateVersionSnapshot;
            this.lastSourceFingerprints = currentFingerprints;
        });
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    private async updateRenderedMarkers(params: {
        desiredStates: MarkerState[];
        renderer: MarkerOverlayRenderer<MarkerState>;
        token: number;
        animateTransitions: boolean;
        previousClusterMemberCenters: ReadonlyMap<string, GeoPoint>;
        nextClusterMemberCenters: ReadonlyMap<string, GeoPoint>;
    }): Promise<void> {
        const {
            desiredStates, renderer, token, animateTransitions,
            previousClusterMemberCenters, nextClusterMemberCenters,
        } = params;

        const desiredById = new Map(desiredStates.map((state) => [state.id, state]));
        const animateZoom = animateTransitions && this.zoomAnimationDurationMillis > 0;

        if (!animateZoom) {
            const orphaned = this.markerManager.allEntities()
                .filter((entity) => !desiredById.has(entity.state.id))
                .map((entity) => this.renderedMarkerEntities.get(entity.state.id))
                .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
            if (orphaned.length > 0) {
                await renderer.onRemove(orphaned);
                for (const entity of orphaned) this.dropEntity(entity.state.id);
                await renderer.onPostProcess();
            }
        }

        const existingById = new Map(
            this.markerManager.allEntities().map((entity) => [entity.state.id, entity]),
        );

        const removeIds = [...existingById.keys()].filter((id) => !desiredById.has(id));
        const addStates = desiredStates.filter((state) => !existingById.has(state.id));
        const updateStates = desiredStates.filter((state) => existingById.has(state.id));

        const animatedRemoveEntries: AnimatedRemove[] = animateZoom
            ? removeIds.flatMap((id) => {
                const entity = existingById.get(id);
                if (!entity) return [];
                const target = id.startsWith('cluster_')
                    ? this.averageOfMemberCenters(entity.state, nextClusterMemberCenters)
                    : nextClusterMemberCenters.get(id) ?? null;
                return target ? [{ entity, target }] : [];
            })
            : [];
        const animatedRemoveIds = new Set(animatedRemoveEntries.map((entry) => entry.entity.state.id));

        const animatedAddEntries: AnimatedAdd[] = animateZoom
            ? addStates.flatMap((state) => {
                const start = state.id.startsWith('cluster_')
                    ? this.averageOfMemberCenters(state, previousClusterMemberCenters)
                    : previousClusterMemberCenters.get(state.id) ?? null;
                return start ? [{ state, start }] : [];
            })
            : [];
        const animatedAddIds = new Set(animatedAddEntries.map((entry) => entry.state.id));

        const immediateRemoveIds = removeIds.filter((id) => !animatedRemoveIds.has(id));
        const immediateAddStates = addStates.filter((state) => !animatedAddIds.has(state.id));

        let didImmediateChange = false;
        if (immediateRemoveIds.length > 0) {
            const removedEntities = immediateRemoveIds
                .map((id) => this.renderedMarkerEntities.get(id))
                .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
            if (removedEntities.length > 0) {
                await renderer.onRemove(removedEntities);
                for (const entity of removedEntities) this.dropEntity(entity.state.id);
                didImmediateChange = true;
            }
        }
        if (immediateAddStates.length > 0) {
            await this.addStatesToRenderer(immediateAddStates, renderer);
            didImmediateChange = true;
        }

        const changeParams: ChangeParams<MarkerState>[] = [];
        for (const state of updateStates) {
            const prev = existingById.get(state.id);
            if (!prev) continue;
            const nextEntity = createMarkerEntity<MarkerState>({
                marker: prev.marker,
                state,
                isRendered: true,
            });
            this.markerManager.registerEntity(nextEntity);

            if (fingerPrintEquals(prev.fingerPrint, state.fingerPrint())) continue;

            changeParams.push({
                current: nextEntity,
                prev,
                bitmapIcon: state.icon?.toBitmapIcon() ?? this.defaultMarkerIcon,
            });
        }

        if (changeParams.length > 0) {
            const actualMarkers = await renderer.onChange(changeParams);
            actualMarkers.forEach((actual, index) => {
                if (actual == null) return;
                const entity = createMarkerEntity<MarkerState>({
                    marker: actual,
                    state: changeParams[index].current.state,
                    isRendered: true,
                });
                this.markerManager.registerEntity(entity);
                this.renderedMarkerEntities.set(entity.state.id, entity);
            });
            didImmediateChange = true;
        }

        if (didImmediateChange) {
            await renderer.onPostProcess();
        }

        if (!animateZoom || (animatedRemoveEntries.length === 0 && animatedAddEntries.length === 0)) {
            return;
        }
        if (token !== this.cameraUpdateToken) return;

        let animatedStartEntities: MarkerEntity<MarkerState>[] = [];
        if (animatedAddEntries.length > 0) {
            animatedStartEntities = await this.addStatesToRenderer(
                animatedAddEntries.map((entry) => entry.state.copy({ position: entry.start })),
                renderer,
            );
            await renderer.onPostProcess();
        }

        const moves: AnimatedMove[] = [];
        for (const entry of animatedAddEntries) {
            const entity = this.markerManager.getEntity(entry.state.id);
            if (!entity) continue;
            moves.push({
                id: entry.state.id,
                start: entry.start,
                end: entry.state.position,
                baseState: entry.state,
                entity,
                restoreBaseStateAtEnd: true,
            });
        }
        for (const entry of animatedRemoveEntries) {
            moves.push({
                id: entry.entity.state.id,
                start: entry.entity.state.position,
                end: entry.target,
                baseState: entry.entity.state,
                entity: entry.entity,
                restoreBaseStateAtEnd: false,
            });
        }

        const completed = await this.animateMarkerMoves(moves, renderer, this.zoomAnimationDurationMillis, token);

        if (animatedRemoveEntries.length > 0) {
            const entitiesToRemove = animatedRemoveEntries
                .map((entry) => this.renderedMarkerEntities.get(entry.entity.state.id))
                .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
            if (entitiesToRemove.length > 0) {
                await renderer.onRemove(entitiesToRemove);
                for (const entity of entitiesToRemove) this.dropEntity(entity.state.id);
                await renderer.onPostProcess();
            }
        }

        if (!completed && animatedStartEntities.length > 0) {
            const entitiesToRemoveOnCancel = animatedStartEntities
                .map((entity) => this.renderedMarkerEntities.get(entity.state.id))
                .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
            if (entitiesToRemoveOnCancel.length > 0) {
                await renderer.onRemove(entitiesToRemoveOnCancel);
                for (const entity of entitiesToRemoveOnCancel) this.dropEntity(entity.state.id);
                await renderer.onPostProcess();
            }
        }
    }

    private async addStatesToRenderer(
        states: MarkerState[],
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<MarkerEntity<MarkerState>[]> {
        if (states.length === 0) return [];
        const addParams: AddParams[] = states.map((state) => ({
            state,
            bitmapIcon: state.icon?.toBitmapIcon() ?? this.defaultMarkerIcon,
        }));
        const actualMarkers = await renderer.onAdd(addParams);
        const addedEntities: MarkerEntity<MarkerState>[] = [];
        actualMarkers.forEach((actual, index) => {
            if (actual == null) return;
            const entity = createMarkerEntity<MarkerState>({
                marker: actual,
                state: addParams[index].state,
                isRendered: true,
            });
            this.markerManager.registerEntity(entity);
            this.renderedMarkerEntities.set(entity.state.id, entity);
            addedEntities.push(entity);
        });
        return addedEntities;
    }

    private async animateMarkerMoves(
        moves: AnimatedMove[],
        renderer: MarkerOverlayRenderer<MarkerState>,
        durationMillis: number,
        token: number,
    ): Promise<boolean> {
        if (moves.length === 0) return true;
        const frameMillis = this.animationFrameMillis(moves.length);
        const steps = Math.max(1, Math.ceil(durationMillis / frameMillis));
        const stepDelayMillis = steps <= 1 ? durationMillis : Math.max(1, Math.floor(durationMillis / steps));

        for (let step = 1; step <= steps; step++) {
            if (token !== this.cameraUpdateToken) return false;
            const t = step / steps;

            const changeParams: ChangeParams<MarkerState>[] = moves.map((move) => {
                // On the final frame the interpolated position already equals
                // the target, so appearing markers can be handed back as the
                // app-owned instance instead of a copy.
                const nextState = step === steps && move.restoreBaseStateAtEnd
                    ? move.baseState
                    : move.baseState.copy({ position: this.interpolatePosition(move.start, move.end, t) });
                return {
                    current: createMarkerEntity<MarkerState>({
                        marker: move.entity.marker,
                        state: nextState,
                        isRendered: true,
                    }),
                    prev: move.entity,
                    bitmapIcon: move.baseState.icon?.toBitmapIcon() ?? this.defaultMarkerIcon,
                };
            });

            const actualMarkers = await renderer.onChange(changeParams);
            actualMarkers.forEach((actual, index) => {
                const nextEntity = changeParams[index].current;
                nextEntity.marker = actual ?? nextEntity.marker;
                this.markerManager.updateEntity(nextEntity);
                this.renderedMarkerEntities.set(nextEntity.state.id, nextEntity);
                moves[index].entity = nextEntity;
            });
            await renderer.onPostProcess();

            if (step < steps) await delay(stepDelayMillis);
        }
        return true;
    }

    private async cleanupStaleMarkers(
        currentZoom: number,
        renderer: MarkerOverlayRenderer<MarkerState>,
        skipClusterRemoval: boolean,
    ): Promise<void> {
        const currentZoomKey = Math.round(currentZoom);
        const staleEntities: MarkerEntity<MarkerState>[] = [];

        for (const entity of this.renderedMarkerEntities.values()) {
            const id = entity.state.id;
            let isStale: boolean;
            if (id.startsWith('cluster_')) {
                if (skipClusterRemoval) {
                    isStale = false;
                } else {
                    const parts = id.split('_');
                    const markerZoomKey = parts.length >= 4 ? Number.parseInt(parts[1], 10) : Number.NaN;
                    isStale = parts.length >= 4 && (Number.isNaN(markerZoomKey) ? -1 : markerZoomKey) !== currentZoomKey;
                }
            } else {
                isStale = !this.sourceStates.has(id);
            }
            if (isStale) staleEntities.push(entity);
        }

        if (staleEntities.length === 0) return;
        await renderer.onRemove(staleEntities);
        for (const entity of staleEntities) this.dropEntity(entity.state.id);
        await renderer.onPostProcess();
    }

    private dropEntity(id: string): void {
        this.renderedMarkerEntities.delete(id);
        this.markerManager.removeEntity(id);
    }

    // ── Spiderfy (click-to-fan-out) ───────────────────────────────────────────

    /**
     * Handles a click on a cluster marker. Returns true when the click was
     * consumed by spiderfy (toggling the fan), false when it should fall
     * through to `onClusterClick`. The rendering itself runs asynchronously.
     */
    private tryToggleSpiderfy(cluster: MarkerCluster): boolean {
        const minZoom = this.spiderfyMinZoom;
        if (minZoom == null) return false;
        const camera = this.lastCameraPosition;
        if (!camera || camera.zoom < minZoom) return false;
        const renderer = this.lastRenderer;
        const holder = renderer?.holder;
        if (!renderer || !holder) return false;

        const clusterKey = [...cluster.markerIds].sort().join(',');
        if (this.spiderfyClusterKey === clusterKey) {
            // Clicking the open cluster again collapses the fan.
            this.spiderfyToken++;
            void this.spiderfyMutex.withLock(() => this.collapseSpiderfyLocked(renderer));
            return true;
        }

        const members = cluster.markerIds
            .map((id) => this.sourceStates.get(id))
            .filter((state): state is MarkerState => state != null);
        if (members.length === 0) return false;

        // Fan out around the cluster marker's actual rendered position (it can
        // deviate from the member average), so the legs meet the marker's base.
        let centerGeo = this.averagePosition(members);
        for (const entity of this.renderedMarkerEntities.values()) {
            if (entity.state.extra !== (cluster as unknown)) continue;
            centerGeo = createGeoPoint({
                latitude: entity.state.position.latitude,
                longitude: entity.state.position.longitude,
            });
            break;
        }
        const centerPx = this.resolveScreenOffset(holder.toScreenOffset(centerGeo));
        if (!centerPx) return false;

        // Already rendered output markers (other clusters / individual markers)
        // near the fan act as fixed obstacles so the fanned members do not
        // overlap them. The clicked cluster itself (at the center) is excluded;
        // instead the head of a pin-shaped cluster icon is added as a pseudo
        // obstacle above the center.
        const obstacles: Offset[] = [];
        for (const entity of this.renderedMarkerEntities.values()) {
            const px = this.resolveScreenOffset(holder.toScreenOffset(entity.state.position));
            if (!px) continue;
            const relX = px.x - centerPx.x;
            const relY = px.y - centerPx.y;
            const distance = Math.hypot(relX, relY);
            if (distance < 2.0 || distance > 300.0) continue;
            obstacles.push({ x: relX, y: relY });
        }
        obstacles.push({ x: 0, y: -Math.round(this.spiderfyMarkerSizePx / 2.0) });

        const offsets = this.spiderfyLayout(
            members.length,
            this.spiderfyMarkerSizePx,
            this.spiderfyMarkerMarginPx,
            obstacles,
        );
        const token = ++this.spiderfyToken;
        void (async () => {
            await this.spiderfyMutex.withLock(() => this.collapseSpiderfyLocked(renderer));
            if (token !== this.spiderfyToken) return;
            await this.openSpiderfy({ clusterKey, members, centerGeo, centerPx, offsets, renderer, token });
        })();
        return true;
    }

    private async openSpiderfy(params: {
        clusterKey: string;
        members: MarkerState[];
        centerGeo: GeoPoint;
        centerPx: Offset;
        offsets: Offset[];
        renderer: MarkerOverlayRenderer<MarkerState>;
        token: number;
    }): Promise<void> {
        const { clusterKey, members, centerGeo, centerPx, offsets, renderer, token } = params;
        const holder = renderer.holder;
        if (!holder) return;

        const clones: MarkerState[] = [];
        const legs: SpiderfyLeg[] = [];
        members.forEach((member, index) => {
            const geo = holder.fromScreenOffsetSync({
                x: centerPx.x + offsets[index].x,
                y: centerPx.y + offsets[index].y,
            });
            if (!geo) return;
            clones.push(member.copy({ id: `spider_${member.id}`, position: geo, zIndex: 2000 }));
            legs.push({ id: `spiderleg_${member.id}`, start: centerGeo, end: geo });
        });
        if (clones.length === 0) return;

        // Keep the cluster rendering unchanged until the app has prepared the
        // fanned-out markers (e.g. icon preloading). A newer toggle / recluster
        // supersedes this open through the token check below.
        if (this.prepareExpand) {
            // A failed prepare must not block rendering.
            await this.prepareExpand(clones).catch(() => undefined);
        }

        await this.spiderfyMutex.withLock(async () => {
            if (token !== this.spiderfyToken) return;
            const addParams: AddParams[] = clones.map((state) => ({
                state,
                bitmapIcon: state.icon?.toBitmapIcon() ?? this.defaultMarkerIcon,
            }));
            const actualMarkers = await renderer.onAdd(addParams);
            actualMarkers.forEach((actual, index) => {
                if (actual == null) return;
                const entity = createMarkerEntity<MarkerState>({
                    marker: actual,
                    state: addParams[index].state,
                    isRendered: true,
                });
                this.markerManager.registerEntity(entity);
                this.spiderfyEntities.push(entity);
            });
            await renderer.onPostProcess();
            this._spiderfyLegsFlow.value = legs;
            this.spiderfyClusterKey = clusterKey;
            this.onSpiderfyChange?.(true);
        });
    }

    /** Must be called while holding `spiderfyMutex`. */
    private async collapseSpiderfyLocked(renderer: MarkerOverlayRenderer<MarkerState>): Promise<void> {
        if (this.spiderfyClusterKey == null && this.spiderfyEntities.length === 0) return;
        this.spiderfyClusterKey = null;
        this._spiderfyLegsFlow.value = [];
        if (this.spiderfyEntities.length > 0) {
            const entities = this.spiderfyEntities;
            this.spiderfyEntities = [];
            await renderer.onRemove(entities);
            for (const entity of entities) this.markerManager.removeEntity(entity.state.id);
            await renderer.onPostProcess();
        }
        this.onSpiderfyChange?.(false);
    }

    /**
     * Screen-space fan-out layout for spiderfy. Members start on an even circle
     * around the cluster and then iteratively repel each other (and the cluster
     * marker itself) until no pair is closer than markerSize + margin, while a
     * weak spring toward the center keeps the fan compact. Converges to a ring
     * for small counts and to packed shells for larger ones.
     */
    private spiderfyLayout(
        count: number,
        markerSizePx: number,
        marginPx: number,
        obstacles: Offset[],
    ): Offset[] {
        const desired = markerSizePx + marginPx;
        // Base distance from the cluster center: far enough for the legs to be
        // visible, close enough for the fan to stay compact.
        const centerClearance = Math.round(markerSizePx * 1.3) + marginPx;
        const xs = new Float64Array(count);
        const ys = new Float64Array(count);
        for (let i = 0; i < count; i++) {
            // Evenly spaced starting at 0 degrees (to the right); two members
            // end up side by side, avoiding the head of a pin-shaped cluster.
            const angle = (2.0 * Math.PI * i) / count;
            xs[i] = Math.cos(angle) * centerClearance;
            ys[i] = Math.sin(angle) * centerClearance;
        }
        for (let iteration = 0; iteration < SPIDERFY_LAYOUT_MAX_ITERATIONS; iteration++) {
            let maxMove = 0.0;
            for (let i = 0; i < count; i++) {
                let fx = 0.0;
                let fy = 0.0;
                // Repulsion between fanned-out members.
                for (let j = 0; j < count; j++) {
                    if (i === j) continue;
                    const dx = xs[i] - xs[j];
                    const dy = ys[i] - ys[j];
                    const d = Math.hypot(dx, dy) || 0.01;
                    if (d < desired) {
                        const push = (desired - d) / 2.0;
                        fx += (dx / d) * push;
                        fy += (dy / d) * push;
                    }
                }
                // Repulsion from already rendered markers nearby (fixed obstacles).
                for (const obstacle of obstacles) {
                    const dx = xs[i] - obstacle.x;
                    const dy = ys[i] - obstacle.y;
                    const d = Math.hypot(dx, dy) || 0.01;
                    if (d < desired) {
                        const push = desired - d;
                        fx += (dx / d) * push;
                        fy += (dy / d) * push;
                    }
                }
                const dc = Math.hypot(xs[i], ys[i]) || 0.01;
                if (dc < centerClearance) {
                    // Repulsion from the cluster marker itself.
                    const push = centerClearance - dc;
                    fx += (xs[i] / dc) * push;
                    fy += (ys[i] / dc) * push;
                } else {
                    // Weak spring toward the center (prevents drifting too far).
                    const pull = (dc - centerClearance) * 0.15;
                    fx -= (xs[i] / dc) * pull;
                    fy -= (ys[i] / dc) * pull;
                }
                xs[i] += fx * 0.6;
                ys[i] += fy * 0.6;
                maxMove = Math.max(maxMove, Math.abs(fx), Math.abs(fy));
            }
            if (maxMove < SPIDERFY_LAYOUT_CONVERGENCE_THRESHOLD) break;
        }
        return Array.from({ length: count }, (_, i) => ({ x: xs[i], y: ys[i] }));
    }

    /**
     * `toScreenOffset()` resolves asynchronously on some holders; spiderfy needs
     * a synchronous answer, so an async result is treated as unavailable.
     */
    private resolveScreenOffset(result: Offset | null | Promise<Offset | null>): Offset | null {
        if (result != null && typeof (result as Promise<Offset | null>).then === 'function') return null;
        return result as Offset | null;
    }

    // ── Clustering helpers ────────────────────────────────────────────────────

    /**
     * Greedy (seed-based) merge. Merges only neighbours within `clusterRadiusPx`
     * of the *seed* candidate to prevent chaining artefacts.
     */
    private mergeClusters(
        candidates: ClusterCandidate[],
        zoom: number,
        clusterRadiusPx: number,
    ): MergedCluster[] {
        if (candidates.length === 0) return [];

        const indexByCell = new Map<string, number>();
        candidates.forEach((candidate, index) => indexByCell.set(`${candidate.cell.x},${candidate.cell.y}`, index));

        const visited = new Uint8Array(candidates.length);
        const result: MergedCluster[] = [];

        for (let i = 0; i < candidates.length; i++) {
            if (visited[i]) continue;
            visited[i] = 1;

            const seed = candidates[i];
            const seedMpp = this.metersPerPixel(seed.center, zoom);
            const members: MarkerState[] = seed.members.slice();

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const neighborIndex = indexByCell.get(`${seed.cell.x + dx},${seed.cell.y + dy}`);
                    if (neighborIndex === undefined || visited[neighborIndex]) continue;

                    const neighbor = candidates[neighborIndex];
                    const neighborMpp = this.metersPerPixel(neighbor.center, zoom);
                    const threshold = clusterRadiusPx * Math.max(seedMpp, neighborMpp);
                    if (Spherical.computeDistanceBetween(seed.center, neighbor.center) <= threshold) {
                        visited[neighborIndex] = 1;
                        members.push(...neighbor.members);
                    }
                }
            }

            result.push({ center: this.selectDenseCenter(members, zoom, clusterRadiusPx), members });
        }

        return result;
    }

    /**
     * Selects the densest member as the cluster center, falling back to the
     * first member when only one exists.
     */
    private selectDenseCenter(members: MarkerState[], zoom: number, clusterRadiusPx: number): GeoPoint {
        if (members.length === 0) return createGeoPoint({ latitude: 0, longitude: 0 });
        if (members.length === 1) {
            return createGeoPoint({
                latitude: members[0].position.latitude,
                longitude: members[0].position.longitude,
            });
        }

        const points: PixelPoint[] = members.map((member) => {
            const [x, y] = this.projectToPixel(member.position, zoom);
            return { member, x, y };
        });

        const cellSize = clusterRadiusPx;
        const cellMap = new Map<string, PixelPoint[]>();
        for (const point of points) {
            const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
            const bucket = cellMap.get(key);
            if (bucket) bucket.push(point);
            else cellMap.set(key, [point]);
        }

        const candidatePoints = [...cellMap.values()]
            .sort((a, b) => b.length - a.length)
            .slice(0, MAX_DENSE_CELLS)
            .flat()
            .slice(0, MAX_DENSE_CANDIDATES);

        const radiusSq = cellSize * cellSize;
        let best = candidatePoints[0] ?? points[0];
        let bestNeighborCount = -1;
        let bestTotalDistance = Number.MAX_VALUE;

        for (const candidate of candidatePoints) {
            let neighborCount = 0;
            let totalDistance = 0;

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const key = `${Math.floor(candidate.x / cellSize) + dx},${Math.floor(candidate.y / cellSize) + dy}`;
                    const neighbors = cellMap.get(key);
                    if (!neighbors) continue;
                    for (const other of neighbors) {
                        const dxp = candidate.x - other.x;
                        const dyp = candidate.y - other.y;
                        const distSq = dxp * dxp + dyp * dyp;
                        if (distSq <= radiusSq) {
                            neighborCount++;
                            totalDistance += Math.sqrt(distSq);
                        }
                    }
                }
            }

            if (
                neighborCount > bestNeighborCount ||
                (neighborCount === bestNeighborCount && totalDistance < bestTotalDistance)
            ) {
                bestNeighborCount = neighborCount;
                bestTotalDistance = totalDistance;
                best = candidate;
            }
        }

        return createGeoPoint({
            latitude: best.member.position.latitude,
            longitude: best.member.position.longitude,
        });
    }

    /** Andrew's monotone chain convex hull, in Web Mercator pixel space. */
    private convexHullProjected(members: MarkerState[], zoom: number): HullPoint[] {
        if (members.length < 3) return [];

        // Deduplicate by rounding to 3 decimal places.
        const seen = new Set<string>();
        const points: HullPoint[] = [];
        for (const member of members) {
            const [x, y] = this.projectToPixel(member.position, zoom);
            const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push({ x, y });
        }
        if (points.length < 3) return [];

        points.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

        const cross = (o: HullPoint, a: HullPoint, b: HullPoint): number =>
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        const lower: HullPoint[] = [];
        for (const point of points) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
                lower.pop();
            }
            lower.push(point);
        }

        const upper: HullPoint[] = [];
        for (const point of [...points].reverse()) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
                upper.pop();
            }
            upper.push(point);
        }

        // Drop the last point of each half (duplicate of the other's first).
        const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
        return hull.length >= 3 ? hull : [];
    }

    /** Shoelace formula centroid of a polygon in pixel space. */
    private polygonCentroidProjected(hull: HullPoint[]): HullPoint | null {
        if (hull.length < 3) return null;

        let twiceArea = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < hull.length; i++) {
            const a = hull[i];
            const b = hull[(i + 1) % hull.length];
            const cross = a.x * b.y - b.x * a.y;
            twiceArea += cross;
            cx += (a.x + b.x) * cross;
            cy += (a.y + b.y) * cross;
        }

        if (Math.abs(twiceArea) < 1e-6) {
            // Degenerate — fall back to the average.
            return {
                x: hull.reduce((sum, point) => sum + point.x, 0) / hull.length,
                y: hull.reduce((sum, point) => sum + point.y, 0) / hull.length,
            };
        }

        return { x: cx / (3.0 * twiceArea), y: cy / (3.0 * twiceArea) };
    }

    // ── Geometry / projection helpers ─────────────────────────────────────────

    private projectToPixel(position: GeoPointInterface, zoom: number): [number, number] {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const sinLat = Math.max(-MAX_SIN_LAT, Math.min(MAX_SIN_LAT, Math.sin(position.latitude * DEG_TO_RAD)));
        const x = ((position.longitude + 180.0) / 360.0) * scale;
        const y = (0.5 - Math.log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * Math.PI)) * scale;
        return [x, y];
    }

    private unprojectPixel(point: HullPoint, zoom: number): GeoPoint {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const longitude = (point.x / scale) * 360.0 - 180.0;
        const t = Math.exp(4.0 * Math.PI * (0.5 - point.y / scale));
        const sinLat = Math.max(-MAX_SIN_LAT, Math.min(MAX_SIN_LAT, (t - 1.0) / (t + 1.0)));
        return createGeoPoint({ latitude: Math.asin(sinLat) * RAD_TO_DEG, longitude });
    }

    private effectiveClusterRadiusPx(zoom: number): number {
        const referenceZoom = 10.0;
        const minScale = 0.35;
        const minRadiusPx = 18.0;
        const scale = Math.max(minScale, Math.min(1.0, zoom / referenceZoom));
        return Math.max(minRadiusPx, this.clusterRadiusPx * scale);
    }

    private metersPerPixel(position: GeoPointInterface, zoom: number): number {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        return (Earth.CIRCUMFERENCE_METERS * Math.cos(position.latitude * DEG_TO_RAD)) / scale;
    }

    /**
     * Viewport containment check that handles antimeridian-crossing bounds.
     * At zoom ≤ 4 the crossing representation is interpreted as a large span
     * covering the complement longitude range, as on Android.
     */
    private containsInViewport(
        bounds: GeoRectBounds | null,
        point: GeoPointInterface,
        zoom: number,
    ): boolean {
        if (!bounds || bounds.isEmpty) return false;
        const sw = bounds.southWest;
        const ne = bounds.northEast;
        if (!sw || !ne) return false;

        const latitude = point.latitude;
        const longitude = this.wrapLongitude(point.longitude);
        const west = this.wrapLongitude(sw.longitude);
        const east = this.wrapLongitude(ne.longitude);

        if (latitude < sw.latitude || latitude > ne.latitude) return false;
        if (west <= east) return longitude >= west && longitude <= east;

        // Antimeridian-crossing bounds (west > east). GeoRectBounds prefers the
        // minimal longitudinal arc, which is right for small viewports near the
        // dateline; zoomed far out the visible region can exceed 180° and the
        // minimal arc becomes the complement, so accept the complement range.
        if (zoom <= 4.0) return longitude >= east && longitude <= west;
        return longitude >= west || longitude <= east;
    }

    private wrapLongitude(longitude: number): number {
        return ((longitude + 540.0) % 360.0) - 180.0;
    }

    private buildClusterId(cell: ClusterCell, zoom: number): string {
        return `cluster_${Math.round(zoom)}_${cell.x}_${cell.y}`;
    }

    private calculateClusterRadiusMeters(center: GeoPoint, members: MarkerState[]): number {
        let max = 0;
        for (const member of members) {
            const distance = Spherical.computeDistanceBetween(center, member.position);
            if (distance > max) max = distance;
        }
        return max;
    }

    private extendCoverageBounds(bounds: GeoRectBounds, center: GeoPoint, radiusMeters: number): void {
        const latPad = (radiusMeters / Earth.RADIUS_METERS) * RAD_TO_DEG;
        const cosLat = Math.max(1e-6, Math.cos(center.latitude * DEG_TO_RAD));
        const lonPad = (radiusMeters / (Earth.RADIUS_METERS * cosLat)) * RAD_TO_DEG;
        bounds.extend(createGeoPoint({ latitude: center.latitude - latPad, longitude: center.longitude - lonPad }));
        bounds.extend(createGeoPoint({ latitude: center.latitude + latPad, longitude: center.longitude + lonPad }));
    }

    private containsBounds(container: GeoRectBounds, target: GeoRectBounds): boolean {
        if (container.isEmpty || target.isEmpty) return false;
        const sw = target.southWest;
        const ne = target.northEast;
        if (!sw || !ne) return false;
        return container.contains(sw) && container.contains(ne);
    }

    private updateClusteringTurn(zoom: number): { turn: number; zoomChanged: boolean } {
        const zoomKey = Math.round(zoom * 100);
        if (this.lastZoomKey === null) {
            this.clusteringTurn = 1;
            this.lastZoomKey = zoomKey;
            return { turn: this.clusteringTurn, zoomChanged: false };
        }
        const zoomChanged = this.lastZoomKey !== zoomKey;
        if (zoomChanged) {
            this.clusteringTurn++;
            this.lastZoomKey = zoomKey;
        }
        return { turn: this.clusteringTurn, zoomChanged };
    }

    private hasCameraMoved(previous: MapCameraPosition, current: MapCameraPosition): boolean {
        if (Spherical.computeDistanceBetween(previous.position, current.position) > PAN_ANIMATION_MIN_DISTANCE_METERS) {
            return true;
        }
        if (Math.abs(previous.bearing - current.bearing) > CAMERA_ANGLE_EPSILON) return true;
        return Math.abs(previous.tilt - current.tilt) > CAMERA_ANGLE_EPSILON;
    }

    /**
     * Estimates the viewport when `visibleRegion` is null (e.g. during ArcGIS
     * animations). Scales the last known viewport span by 2^(baseZoom − zoom).
     */
    private estimateViewport(zoom: number, center: GeoPointInterface): GeoRectBounds | null {
        const base = this.lastKnownViewport;
        const baseZoom = this.lastKnownViewportZoom;
        if (!base || baseZoom == null) return null;

        const sw = base.southWest;
        const ne = base.northEast;
        if (!sw || !ne) return base;

        const scale = Math.pow(2.0, baseZoom - zoom);
        const centerLon = this.wrapLongitude(center.longitude);

        const halfLat = (Math.abs(ne.latitude - sw.latitude) / 2.0) * scale;
        const lonSpan = sw.longitude <= ne.longitude
            ? ne.longitude - sw.longitude
            : ne.longitude + 360.0 - sw.longitude;
        const halfLon = Math.min(180.0, (lonSpan / 2.0) * scale);

        const result = createGeoRectBounds();
        result.extend(createGeoPoint({
            latitude: Math.max(-90, Math.min(90, center.latitude - halfLat)),
            longitude: this.wrapLongitude(centerLon - halfLon),
        }));
        result.extend(createGeoPoint({
            latitude: Math.max(-90, Math.min(90, center.latitude + halfLat)),
            longitude: this.wrapLongitude(centerLon + halfLon),
        }));
        return result;
    }

    private markerFingerPrint(position: GeoPointInterface): string {
        return `${position.latitude}_${position.longitude}`;
    }

    private animationFrameMillis(moveCount: number): number {
        if (moveCount < 50) return ANIMATION_FRAME_MILLIS_60_FPS;
        if (moveCount < 100) return ANIMATION_FRAME_MILLIS_30_FPS;
        if (moveCount < 300) return ANIMATION_FRAME_MILLIS_8_FPS;
        return ANIMATION_FRAME_MILLIS_4_FPS;
    }

    private interpolatePosition(start: GeoPoint, end: GeoPoint, t: number): GeoPoint {
        return createGeoPoint({
            latitude: start.latitude + (end.latitude - start.latitude) * t,
            longitude: start.longitude + (end.longitude - start.longitude) * t,
        });
    }

    private averagePosition(states: MarkerState[]): GeoPoint {
        if (states.length === 0) return createGeoPoint({ latitude: 0, longitude: 0 });
        let sumLat = 0;
        let sumLon = 0;
        for (const state of states) {
            sumLat += state.position.latitude;
            sumLon += state.position.longitude;
        }
        return createGeoPoint({ latitude: sumLat / states.length, longitude: sumLon / states.length });
    }

    /**
     * Average of the centers the members of `clusterState` map to. Returns null
     * when none of them is known — such markers transition without animation.
     */
    private averageOfMemberCenters(
        clusterState: MarkerState,
        centers: ReadonlyMap<string, GeoPoint>,
    ): GeoPoint | null {
        const markerIds = (clusterState.extra as unknown as MarkerCluster | null)?.markerIds;
        if (!markerIds || markerIds.length === 0) return null;
        let sumLat = 0;
        let sumLon = 0;
        let count = 0;
        for (const id of markerIds) {
            const center = centers.get(id);
            if (!center) continue;
            sumLat += center.latitude;
            sumLon += center.longitude;
            count++;
        }
        if (count === 0) return null;
        return createGeoPoint({ latitude: sumLat / count, longitude: sumLon / count });
    }
}
