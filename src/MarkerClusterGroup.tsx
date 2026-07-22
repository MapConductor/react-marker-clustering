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
    createPolylineState,
    type GeoPoint,
    type MapCameraPosition,
    type MarkerState,
    type Offset,
    type PolygonState,
    type PolylineState,
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


/**
 * Screen-space fan-out layout for spiderfy. Members start on an even circle
 * around the cluster and then iteratively repel each other (and the cluster
 * marker itself) until no pair is closer than markerSize + margin, while a
 * weak spring toward the center keeps the fan compact. Converges to a ring
 * for small counts and to packed shells for larger ones.
 */
function spiderfyLayout(
    count: number,
    markerSizePx: number,
    marginPx: number,
    obstacles: Offset[] = [],
): Offset[] {
    const desired = markerSizePx + marginPx;
    // クラスタ中心からの基本距離。脚線が見え、かつ離れすぎない程度
    const centerClearance = Math.round(markerSizePx * 1.3) + marginPx;
    const points: Array<{ x: number; y: number }> = Array.from({ length: count }, (_, i) => {
        // 右方向(0°)基準で均等配置。2件なら左右に並び、ピン形クラスタの頭上を避けやすい
        const angle = (2 * Math.PI * i) / count;
        return { x: Math.cos(angle) * centerClearance, y: Math.sin(angle) * centerClearance };
    });
    for (let iter = 0; iter < 150; iter++) {
        let maxMove = 0;
        for (let i = 0; i < count; i++) {
            let fx = 0;
            let fy = 0;
            // 展開メンバー同士の反発
            for (let j = 0; j < count; j++) {
                if (i === j) continue;
                const dx = points[i].x - points[j].x;
                const dy = points[i].y - points[j].y;
                const d = Math.hypot(dx, dy) || 0.01;
                if (d < desired) {
                    const push = (desired - d) / 2;
                    fx += (dx / d) * push;
                    fy += (dy / d) * push;
                }
            }
            // 周囲に既に表示されているマーカー等(固定障害物)からの反発
            for (const ob of obstacles) {
                const dx = points[i].x - ob.x;
                const dy = points[i].y - ob.y;
                const d = Math.hypot(dx, dy) || 0.01;
                if (d < desired) {
                    const push = desired - d;
                    fx += (dx / d) * push;
                    fy += (dy / d) * push;
                }
            }
            const dc = Math.hypot(points[i].x, points[i].y) || 0.01;
            if (dc < centerClearance) {
                // クラスタマーカーからの反発
                const push = centerClearance - dc;
                fx += (points[i].x / dc) * push;
                fy += (points[i].y / dc) * push;
            } else {
                // 中心へ弱いばね(離れすぎ防止)
                const pull = (dc - centerClearance) * 0.15;
                fx -= (points[i].x / dc) * pull;
                fy -= (points[i].y / dc) * pull;
            }
            points[i].x += fx * 0.6;
            points[i].y += fy * 0.6;
            maxMove = Math.max(maxMove, Math.abs(fx), Math.abs(fy));
        }
        if (maxMove < 0.15) break;
    }
    return points;
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
    /**
     * Called before newly appearing individual (non-cluster) markers are
     * rendered — e.g. when a cluster expands after a zoom. Rendering of the
     * new cluster state is deferred until the returned promise settles, so
     * the app can preload marker icon images (and show a loading indicator)
     * before the markers pop in. A newer recluster supersedes any pending
     * deferred apply.
     */
    prepareExpand?: (appearing: MarkerState[]) => Promise<void>;

    // ── Spiderfy (click-to-fan-out) ──────────────────────────────────────────
    /**
     * At or above this zoom, clicking a cluster fans its members out around
     * the (kept) cluster marker, connected by leg polylines — useful when
     * multiple markers share the same location and can never be separated by
     * zooming. Clicking the same cluster again, or any recluster (camera
     * move / data change), collapses the fan. Below this zoom the click
     * falls through to `onClusterClick`. Undefined disables the feature.
     */
    spiderfyMinZoom?: number;
    /** Marker diameter in px used by the overlap-avoiding layout (default 52). */
    spiderfyMarkerSizePx?: number;
    /** Extra gap between fanned-out markers in px (default 8). */
    spiderfyMarkerMarginPx?: number;
    /** Leg polyline color (default '#666666'). */
    spiderfyLegColor?: string;
    /** Leg polyline width (default 1.5). */
    spiderfyLegWidth?: number;
    /**
     * Called when a spiderfy fan opens (true) or collapses (false) — e.g. to
     * close an info bubble when the user clicks another cluster or the fan
     * is dismissed by a camera move.
     */
    onSpiderfyChange?: (open: boolean) => void;
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
        prepareExpand,
        spiderfyMinZoom,
        spiderfyMarkerSizePx = 52,
        spiderfyMarkerMarginPx = 8,
        spiderfyLegColor = '#666666',
        spiderfyLegWidth = 1.5,
        onSpiderfyChange,
    } = props;

    const parentScope = useMapViewScope();
    const mapCtx = useContext(MapContext);
    const controller = mapCtx?.controller ?? null;

    // Local scope so that child <Marker> components write to our collector,
    // not the parent's.
    const localScope = useMemo(() => new MapViewScope(), []);

    // Cluster clicks first try spiderfy (when configured & zoomed in enough),
    // then fall through to the app's onClusterClick. Stable identity so the
    // strategy is not re-created on every render.
    const onClusterClickRef = useRef(onClusterClick);
    useLayoutEffect(() => { onClusterClickRef.current = onClusterClick; }, [onClusterClick]);
    const handleClusterMarkerClick = useCallback((cluster: MarkerCluster) => {
        if (trySpiderfyRef.current(cluster)) return;
        onClusterClickRef.current?.(cluster);
    }, []);
    const clusterClickable = onClusterClick != null || spiderfyMinZoom != null;

    // Strategy is re-created whenever clustering options change.
    const strategyOptions = useMemo<MarkerClusterOptions>(() => ({
        clusterRadiusPx,
        minClusterSize,
        expandMargin,
        clusterIconProvider,
        onClusterClick: clusterClickable ? handleClusterMarkerClick : null,
        debugHullPolygons,
        tileSize,
        enableZoomAnimation,
        enablePanAnimation,
    }), [clusterRadiusPx, minClusterSize, expandMargin, clusterIconProvider, clusterClickable, handleClusterMarkerClick, debugHullPolygons, tileSize, enableZoomAnimation, enablePanAnimation]);

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

    const prepareExpandRef = useRef(prepareExpand);
    useLayoutEffect(() => { prepareExpandRef.current = prepareExpand; }, [prepareExpand]);

    // ── Spiderfy ──────────────────────────────────────────────────────────────
    const spiderfyStateRef = useRef<{ clusterKey: string; markerIds: string[]; legIds: string[] } | null>(null);
    const spiderfyTokenRef = useRef(0);

    const onSpiderfyChangeRef = useRef(onSpiderfyChange);
    useLayoutEffect(() => { onSpiderfyChangeRef.current = onSpiderfyChange; }, [onSpiderfyChange]);

    const collapseSpiderfy = useCallback(() => {
        spiderfyTokenRef.current += 1;
        const current = spiderfyStateRef.current;
        if (!current) return;
        spiderfyStateRef.current = null;
        parentScope.markerCollector.applyDiff([], current.markerIds);
        parentScope.polylineCollector.applyDiff([], current.legIds);
        onSpiderfyChangeRef.current?.(false);
    }, [parentScope]);

    // 最新の props/コンテキストを閉じ込めた spiderfy 実装(ref 経由で安定参照)
    const trySpiderfyRef = useRef<(cluster: MarkerCluster) => boolean>(() => false);
    trySpiderfyRef.current = (cluster: MarkerCluster): boolean => {
        if (spiderfyMinZoom == null) return false;
        const camera = cameraRef.current;
        if (!camera || camera.zoom < spiderfyMinZoom) return false;

        const clusterKey = cluster.markerIds.slice().sort().join(',');
        if (spiderfyStateRef.current?.clusterKey === clusterKey) {
            collapseSpiderfy();
            return true;
        }
        collapseSpiderfy();

        const holder = (controller as unknown as { holder?: {
            toScreenOffset(p: GeoPoint): Offset | null;
            fromScreenOffsetSync(o: Offset): GeoPoint | null;
        } } | null)?.holder;
        if (!holder) return false;

        const sourceById = new Map(markersRef.current.map((m) => [m.id, m]));
        const members = cluster.markerIds
            .map((id) => sourceById.get(id))
            .filter((m): m is MarkerState => m != null);
        if (members.length === 0) return false;

        // 展開・脚線の中心はクラスタマーカーの「実際の描画位置」を使う。
        // (中心キャッシュの安定化により、描画位置がメンバー平均から
        // ずれることがあるため。ずれていても脚線がピンの根元に刺さる)
        let centerGeo = createGeoPoint({
            latitude: members.reduce((s, m) => s + m.position.latitude, 0) / members.length,
            longitude: members.reduce((s, m) => s + m.position.longitude, 0) / members.length,
        });
        for (const state of prevOutputRef.current.values()) {
            if (state.extra === (cluster as unknown)) {
                centerGeo = createGeoPoint({ latitude: state.position.latitude, longitude: state.position.longitude });
                break;
            }
        }
        const centerPx = holder.toScreenOffset(centerGeo);
        if (!centerPx) return false;

        // 周囲に既に描画されている出力マーカー(他クラスタ・他の個別マーカー)を
        // 障害物として渡し、展開メンバーが重ならないようにする。
        // クリックされたクラスタ自身(中心とほぼ同位置)は除外し、代わりに
        // ピン形クラスタの頭部を疑似障害物として加える
        const obstacles: Offset[] = [];
        for (const state of prevOutputRef.current.values()) {
            const px = holder.toScreenOffset(state.position);
            if (!px) continue;
            const rel = { x: px.x - centerPx.x, y: px.y - centerPx.y };
            const d = Math.hypot(rel.x, rel.y);
            if (d < 2 || d > 300) continue; // 自分自身 or 遠すぎるものは無視
            obstacles.push(rel);
        }
        obstacles.push({ x: 0, y: -Math.round(spiderfyMarkerSizePx / 2) });

        const offsets = spiderfyLayout(members.length, spiderfyMarkerSizePx, spiderfyMarkerMarginPx, obstacles);
        const clones: MarkerState[] = [];
        const legs: PolylineState[] = [];
        members.forEach((member, index) => {
            const geo = holder.fromScreenOffsetSync({
                x: centerPx.x + offsets[index].x,
                y: centerPx.y + offsets[index].y,
            });
            if (!geo) return;
            clones.push(member.copy({ id: `spider_${member.id}`, position: geo, zIndex: 2000 }));
            legs.push(createPolylineState({
                id: `spiderleg_${member.id}`,
                points: [centerGeo, geo],
                strokeColor: spiderfyLegColor,
                strokeWidth: spiderfyLegWidth,
                geodesic: false,
            }));
        });
        if (clones.length === 0) return false;

        const apply = () => {
            spiderfyStateRef.current = { clusterKey, markerIds: clones.map((c) => c.id), legIds: legs.map((l) => l.id) };
            parentScope.polylineCollector.applyDiff(legs, []);
            parentScope.markerCollector.applyDiff(clones, []);
            onSpiderfyChangeRef.current?.(true);
        };
        const prepare = prepareExpandRef.current;
        if (prepare) {
            const token = ++spiderfyTokenRef.current;
            void Promise.resolve(prepare(clones))
                .catch(() => undefined)
                .then(() => {
                    if (spiderfyTokenRef.current === token) apply();
                });
        } else {
            apply();
        }
        return true;
    };
    // Monotonic token: a newer recluster invalidates any apply still waiting
    // on prepareExpand, so a stale cluster state is never rendered.
    const pendingPrepareTokenRef = useRef(0);

    const runRecluster = useCallback(() => {
        const camera = cameraRef.current;
        if (!camera) return;
        // Any recluster (camera move / data change) collapses an open spiderfy.
        collapseSpiderfy();
        const result = strategy.computeClusters({
            markers: markersRef.current,
            cameraPosition: camera,
            sourceStateVersion: sourceVersionRef.current,
        });
        // 1. Update polygons synchronously (remove old, add new) in one batch.
        // Pass empty array when disabled so any previously drawn polygons are removed.
        updateHullPolygons(debugHullPolygonsRef.current ? result.debugInfos : []);
        // 2. Apply marker diff + start animations.
        const finish = () => {
            applyOutput(result, zoomAnimationDurationMs);
            onDebugInfoRef.current?.(result.debugInfos);
        };
        const prepare = prepareExpandRef.current;
        const appearing = prepare
            ? result.outputMarkers.filter((m) => !m.id.startsWith('cluster_') && !prevOutputRef.current.has(m.id))
            : [];
        if (prepare && appearing.length > 0) {
            // Keep the current (clustered) rendering on screen until the app
            // finishes preparing the appearing markers (e.g. icon preloading).
            const token = ++pendingPrepareTokenRef.current;
            void Promise.resolve(prepare(appearing))
                .catch(() => undefined)
                .then(() => {
                    if (pendingPrepareTokenRef.current === token) finish();
                });
            return;
        }
        pendingPrepareTokenRef.current += 1;
        finish();
    }, [strategy, updateHullPolygons, applyOutput, zoomAnimationDurationMs, collapseSpiderfy]);

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
        // Same states in the same order = nothing changed. Skip the recluster:
        // it would cancel any in-flight expand/shrink animation for no reason
        // (parents often rebuild the array identity on unrelated re-renders).
        const prev = markersRef.current;
        if (prev.length === markersProp.length && prev.every((state, i) => state === markersProp[i])) {
            return;
        }
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
            const spider = spiderfyStateRef.current;
            if (spider) {
                spiderfyStateRef.current = null;
                parentScope.markerCollector.applyDiff([], spider.markerIds);
                parentScope.polylineCollector.applyDiff([], spider.legIds);
            }
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
