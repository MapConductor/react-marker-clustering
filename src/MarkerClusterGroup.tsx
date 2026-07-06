import React, {
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
} from 'react';
import {
    createGeoPoint,
    createPolygonState,
    type GeoPoint,
    type MapCameraPosition,
    type MarkerState,
    type PolygonState,
} from '@mapconductor/js-sdk-core';
import {
    MapContext,
    MapViewScope,
    MapViewScopeProvider,
    useMapViewScope,
} from '@mapconductor/js-sdk-react';
import type { MarkerCluster, MarkerClusterDebugInfo } from './MarkerCluster';
import {
    DEFAULT_CAMERA_DEBOUNCE_MS,
    DEFAULT_ZOOM_ANIMATION_DURATION_MS,
    MarkerClusterStrategy,
    type ClusterComputeResult,
    type ClusterIconProvider,
    type MarkerClusterOptions,
} from './MarkerClusterStrategy';

/**
 * Above this many concurrent position animations we skip animating and apply
 * the transition immediately. Beyond this the animation is visual noise, and
 * per-frame updates of that many markers would also thrash providers that
 * switched to tiled rendering.
 */
const MAX_ANIMATED_MOVES = 500;

// ── Debug hull polygon colours ────────────────────────────────────────────────

const DEBUG_HULL_COLORS = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#469990', '#9a6324', '#800000',
    '#ffe119', '#aaffc3', '#808000', '#000075', '#a9a9a9',
];

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function debugColorForCell(cellX: number, cellY: number): string {
    return DEBUG_HULL_COLORS[Math.abs(cellX * 31 + cellY) % DEBUG_HULL_COLORS.length];
}

function buildHullPolygonState(info: MarkerClusterDebugInfo): PolygonState {
    const base = debugColorForCell(info.cellX, info.cellY);
    return createPolygonState({
        id: `cluster-hull-${info.id}`,
        points: info.hullPoints,
        strokeColor: hexToRgba(base, 0.8),
        fillColor: hexToRgba(base, 0.2),
        strokeWidth: 2,
        zIndex: 9,
        geodesic: false,
    });
}

interface AnimatedMove {
    state: MarkerState;
    start: GeoPoint;
    end: GeoPoint;
    /** True for disappearing markers that must be removed once the move ends. */
    removeAfter: boolean;
}

/**
 * The position a marker flies from (expand) or to (shrink) during a
 * transition. For a cluster this is the average of its members' rendered
 * centers in the other generation; for an individual marker it is the center
 * of the cluster it belonged (or now belongs) to. Returns null when the
 * counterpart is unknown — such markers transition without animation.
 */
function transitionAnchor(
    state: MarkerState,
    centers: ReadonlyMap<string, GeoPoint>,
): GeoPoint | null {
    if (state.id.startsWith('cluster_')) {
        const markerIds = (state.extra as unknown as MarkerCluster | null)?.markerIds;
        if (!markerIds || markerIds.length === 0) return null;
        let lat = 0, lon = 0, n = 0;
        for (const id of markerIds) {
            const c = centers.get(id);
            if (!c) continue;
            lat += c.latitude;
            lon += c.longitude;
            n++;
        }
        if (n === 0) return null;
        return createGeoPoint({ latitude: lat / n, longitude: lon / n });
    }
    return centers.get(state.id) ?? null;
}

export interface MarkerClusterGroupProps {
    /**
     * Markers to cluster. Mutually exclusive with `children`-based markers:
     * if this prop is provided, children `<Marker>` components are still
     * rendered inside the cluster scope but their marker states are ignored.
     */
    markers?: MarkerState[];
    children?: React.ReactNode;

    // ── Clustering options ────────────────────────────────────────────────────
    clusterRadiusPx?: number;
    minClusterSize?: number;
    expandMargin?: number;
    clusterIconProvider?: ClusterIconProvider;
    onClusterClick?: ((cluster: MarkerCluster) => void) | null;
    cameraIdleDebounceMs?: number;
    tileSize?: number;
    /** Animate cluster expand/shrink transitions on zoom change. */
    enableZoomAnimation?: boolean;
    /** Animate cluster transitions on camera pan. */
    enablePanAnimation?: boolean;
    /** Duration of the expand/shrink animation in milliseconds. */
    zoomAnimationDurationMs?: number;
    /** Render convex-hull polygons for debug. */
    debugHullPolygons?: boolean;
    /** Called after each cluster computation with debug information. */
    onDebugInfo?: (infos: ReturnType<MarkerClusterStrategy['computeClusters']>['debugInfos']) => void;
}

/**
 * Clusters markers using a grid-based greedy merge algorithm (ported from the
 * Android SDK's `MarkerClusterGroup` Composable).
 *
 * Usage — provide markers via prop:
 * ```tsx
 * <MarkerClusterGroup markers={markerStates} clusterRadiusPx={80} />
 * ```
 *
 * Usage — use child `<Marker>` components:
 * ```tsx
 * <MarkerClusterGroup>
 *   {items.map(item => <Marker key={item.id} state={item.markerState} />)}
 * </MarkerClusterGroup>
 * ```
 *
 * The component intercepts child markers via a local `MapViewScope` and
 * writes clustered output into the parent scope's `markerCollector`.
 */
export function MarkerClusterGroup(props: MarkerClusterGroupProps): React.ReactElement | null {
    const {
        markers: markersProp,
        children,
        clusterRadiusPx,
        minClusterSize,
        expandMargin,
        clusterIconProvider,
        onClusterClick,
        cameraIdleDebounceMs = DEFAULT_CAMERA_DEBOUNCE_MS,
        tileSize,
        enableZoomAnimation,
        enablePanAnimation,
        zoomAnimationDurationMs = DEFAULT_ZOOM_ANIMATION_DURATION_MS,
        debugHullPolygons,
        onDebugInfo,
    } = props;

    const parentScope = useMapViewScope();
    const mapCtx = useContext(MapContext);
    const controller = mapCtx?.controller ?? null;

    // Local scope so that child <Marker> components write to our collector,
    // not the parent's.
    const localScope = useMemo(() => new MapViewScope(), []);

    // Strategy is re-created whenever clustering options change.
    const strategyOptions = useMemo<MarkerClusterOptions>(() => ({
        clusterRadiusPx,
        minClusterSize,
        expandMargin,
        clusterIconProvider,
        onClusterClick,
        debugHullPolygons,
        tileSize,
        enableZoomAnimation,
        enablePanAnimation,
    }), [clusterRadiusPx, minClusterSize, expandMargin, clusterIconProvider, onClusterClick, debugHullPolygons, tileSize, enableZoomAnimation, enablePanAnimation]);

    const strategy = useMemo(
        () => new MarkerClusterStrategy(strategyOptions),
        [strategyOptions],
    );

    // Refs for imperative access inside stable callbacks.
    const cameraRef = useRef<MapCameraPosition | null>(null);
    const markersRef = useRef<MarkerState[]>(markersProp ?? []);
    const sourceVersionRef = useRef(0);
    const ourIdsRef = useRef<Set<string>>(new Set());
    const hullPolygonIdsRef = useRef<Set<string>>(new Set());
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onDebugInfoRef = useRef(onDebugInfo);
    const debugHullPolygonsRef = useRef(debugHullPolygons ?? false);

    // Keep callback/flag refs current without triggering effect deps.
    useLayoutEffect(() => { onDebugInfoRef.current = onDebugInfo; }, [onDebugInfo]);
    useLayoutEffect(() => { debugHullPolygonsRef.current = debugHullPolygons ?? false; }, [debugHullPolygons]);

    // ── Expand / shrink animation ─────────────────────────────────────────────

    // Handle of the currently running transition animation. cancel() finalizes
    // it instantly (pending removals removed, in-flight adds snapped to final).
    const animRef = useRef<{ cancel: () => void } | null>(null);
    // Our current desired output (excludes markers pending animated removal).
    const prevOutputRef = useRef<Map<string, MarkerState>>(new Map());

    const runAnimation = useCallback((flights: Array<AnimatedMove & { clone: MarkerState }>, durationMs: number) => {
        // Per-frame updates go through the collector's update handler one state
        // at a time, so throttle the frame rate as the move count grows.
        const frameMs = flights.length > 200 ? 48 : flights.length > 50 ? 32 : 0;
        let rafId: number | null = null;
        let lastFrame = 0;
        let startTime: number | null = null;
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            if (rafId !== null) cancelAnimationFrame(rafId);
            const removeIds = flights.filter(f => f.removeAfter).map(f => f.state.id);
            // Swap the flight clones of appearing markers back to the original
            // states (true final position, app-owned instance).
            const restores = flights.filter(f => !f.removeAfter).map(f => f.state);
            parentScope.markerCollector.applyDiff(restores, removeIds);
            for (const id of removeIds) ourIdsRef.current.delete(id);
            if (animRef.current?.cancel === finish) animRef.current = null;
        };

        const tick = (now: number) => {
            if (finished) return;
            if (startTime === null) startTime = now;
            const t = Math.min(1, (now - startTime) / durationMs);
            if (t >= 1) { finish(); return; }
            if (now - lastFrame >= frameMs) {
                lastFrame = now;
                for (const f of flights) {
                    f.clone.position = createGeoPoint({
                        latitude: f.start.latitude + (f.end.latitude - f.start.latitude) * t,
                        longitude: f.start.longitude + (f.end.longitude - f.start.longitude) * t,
                    });
                }
            }
            rafId = requestAnimationFrame(tick);
        };

        animRef.current = { cancel: finish };
        rafId = requestAnimationFrame(tick);
    }, [parentScope]);

    // ── Hull polygon update (imperative, mirrors marker applyDiff approach) ────

    const updateHullPolygons = useCallback((debugInfos: MarkerClusterDebugInfo[]) => {
        const newStates = debugInfos
            .filter(info => info.hullPoints.length >= 3)
            .map(buildHullPolygonState);
        const newIds = new Set(newStates.map(s => s.id));
        const removeIds = [...hullPolygonIdsRef.current].filter(id => !newIds.has(id));
        parentScope.polygonCollector.applyDiff(newStates, removeIds);
        hullPolygonIdsRef.current = newIds;
    }, [parentScope]);

    // ── Cluster computation ───────────────────────────────────────────────────

    const applyOutput = useCallback((result: ClusterComputeResult, durationMs: number) => {
        // Finalize any in-flight animation before diffing against our state.
        animRef.current?.cancel();

        const { outputMarkers, previousMemberCenters, memberCenters } = result;
        const newIds = new Set(outputMarkers.map(m => m.id));
        const prevOutputs = prevOutputRef.current;
        const animate = result.animateTransitions && durationMs > 0;

        // Disappearing markers fly INTO the cluster their members joined
        // (shrink); appearing markers fly OUT of the cluster their members
        // left (expand). Markers without a known counterpart transition
        // immediately, as on Android.
        let moves: AnimatedMove[] = [];
        const immediateRemoveIds: string[] = [];
        for (const id of ourIdsRef.current) {
            if (newIds.has(id)) continue;
            const prevState = prevOutputs.get(id);
            const target = animate && prevState
                ? transitionAnchor(prevState, memberCenters)
                : null;
            if (prevState && target) {
                moves.push({ state: prevState, start: prevState.position, end: target, removeAfter: true });
            } else {
                immediateRemoveIds.push(id);
            }
        }

        const upserts: MarkerState[] = [];
        for (const state of outputMarkers) {
            if (animate && !prevOutputs.has(state.id)) {
                const start = transitionAnchor(state, previousMemberCenters);
                if (start) {
                    moves.push({ state, start, end: state.position, removeAfter: false });
                    continue;
                }
            }
            upserts.push(state);
        }

        if (moves.length > MAX_ANIMATED_MOVES) {
            for (const move of moves) {
                if (move.removeAfter) immediateRemoveIds.push(move.state.id);
                else upserts.push(move.state);
            }
            moves = [];
        }

        // Animate disposable clones so app-owned source states are never
        // mutated mid-flight (Android animates state copies the same way).
        const flights = moves.map(m => ({ ...m, clone: m.state.copy({ position: m.start }) }));
        upserts.push(...flights.map(f => f.clone));

        // Batch removals + upserts into ONE collector notification. Per-marker
        // add()/remove() calls would trigger a full controller re-composition
        // each time — with large datasets that reconstructs the marker tile
        // renderer thousands of times in a burst and exhausts memory.
        parentScope.markerCollector.applyDiff(upserts, immediateRemoveIds);

        ourIdsRef.current = newIds;
        for (const f of flights) {
            if (f.removeAfter) ourIdsRef.current.add(f.state.id);
        }
        prevOutputRef.current = new Map(outputMarkers.map(s => [s.id, s]));

        if (flights.length > 0) runAnimation(flights, durationMs);
    }, [parentScope, runAnimation]);

    const runRecluster = useCallback(() => {
        const camera = cameraRef.current;
        if (!camera) return;
        const result = strategy.computeClusters({
            markers: markersRef.current,
            cameraPosition: camera,
            sourceStateVersion: sourceVersionRef.current,
        });
        // 1. Update polygons synchronously (remove old, add new) in one batch.
        // Pass empty array when disabled so any previously drawn polygons are removed.
        updateHullPolygons(debugHullPolygonsRef.current ? result.debugInfos : []);
        // 2. Apply marker diff + start animations.
        applyOutput(result, zoomAnimationDurationMs);
        onDebugInfoRef.current?.(result.debugInfos);
    }, [strategy, updateHullPolygons, applyOutput, zoomAnimationDurationMs]);

    // Stable refs so the camera effect can always call the latest versions
    // without needing to re-register the listener.
    const runReclusterRef = useRef(runRecluster);
    useLayoutEffect(() => { runReclusterRef.current = runRecluster; }, [runRecluster]);

    const scheduleRef = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        scheduleRef.current = () => {
            if (debounceRef.current !== null) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
                debounceRef.current = null;
                runReclusterRef.current();
            }, cameraIdleDebounceMs);
        };
    }, [cameraIdleDebounceMs]);

    // ── Camera subscription (chain with existing single-slot listener) ────────

    useEffect(() => {
        if (!controller) return;

        // Read the protected field from the concrete instance so we can restore
        // it on unmount and chain it on each camera-move-end event.
        type WithCb = { cameraMoveEndCallback?: ((cam: MapCameraPosition) => void) | null };
        const prev = (controller as unknown as WithCb).cameraMoveEndCallback ?? null;

        controller.setCameraMoveEndListener((camera: MapCameraPosition) => {
            cameraRef.current = camera;
            prev?.(camera);
            scheduleRef.current();
        });

        // Seed the initial camera and run immediately.
        const initial = controller.getCameraPosition();
        if (initial) {
            cameraRef.current = initial;
            runReclusterRef.current();
        }

        return () => {
            controller.setCameraMoveEndListener(prev);
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, [controller]); // intentionally only controller — callbacks accessed via refs

    // ── Re-cluster when strategy options change ───────────────────────────────

    useEffect(() => {
        strategy.clear();
        runReclusterRef.current();
    }, [strategy]);

    // ── Markers prop change ───────────────────────────────────────────────────

    useEffect(() => {
        if (markersProp === undefined) return;
        markersRef.current = markersProp;
        sourceVersionRef.current += 1;
        runReclusterRef.current();
    }, [markersProp]);

    // ── Children-based markers via local collector ────────────────────────────

    useEffect(() => {
        if (markersProp !== undefined) return; // prop takes priority

        return localScope.markerCollector.subscribe((markerMap) => {
            markersRef.current = Array.from(markerMap.values());
            sourceVersionRef.current += 1;
            runReclusterRef.current();
        });
    }, [localScope, markersProp]);

    // ── Cleanup on unmount ────────────────────────────────────────────────────

    useEffect(() => {
        return () => {
            animRef.current?.cancel();
            parentScope.markerCollector.applyDiff([], ourIdsRef.current);
            parentScope.polygonCollector.applyDiff([], hullPolygonIdsRef.current);
            ourIdsRef.current = new Set();
            hullPolygonIdsRef.current = new Set();
            prevOutputRef.current = new Map();
            if (debounceRef.current !== null) clearTimeout(debounceRef.current);
        };
    }, [parentScope]);

    return (
        <MapViewScopeProvider scope={localScope}>
            {children ?? null}
        </MapViewScopeProvider>
    );
}
