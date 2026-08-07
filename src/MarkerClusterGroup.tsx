import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
    CollectorMarkerOverlayRenderer,
    createPolygonState,
    createPolylineState,
    MarkerRenderingSupportKey,
    StrategyMarkerController,
    type MarkerState,
    type PolygonState,
} from '@mapconductor/js-sdk-core';
import {
  MapContext,
  MapViewScope,
  MapViewScopeProvider,
  useMapServiceRegistry,
} from '@mapconductor/js-sdk-react';
import {
  useMapViewScope,
} from '@mapconductor/js-sdk-react/internal';
import type { MarkerCluster, MarkerClusterDebugInfo } from './MarkerCluster';
import {
    MarkerClusterStrategy,
    type ClusterIconProvider,
    type ClusterIconProviderWithTurn,
} from './MarkerClusterStrategy';

/** Leg polyline defaults, matching `MarkerClusterGroupState` on Android. */
export const DEFAULT_SPIDERFY_LEG_COLOR = '#666666';
export const DEFAULT_SPIDERFY_LEG_WIDTH = 1.5;

// Debug hull polygon styling. Fixed rather than configurable: `debugHullPolygons`
// is the only debug knob the public API exposes on all three platforms.
const DEBUG_HULL_STROKE_WIDTH = 2;
const DEBUG_HULL_STROKE_ALPHA = 0.8;
const DEBUG_HULL_FILL_ALPHA = 0.18;

const DEBUG_HULL_PALETTE = [
    '#E53935', // red
    '#D81B60', // pink
    '#8E24AA', // purple
    '#5E35B1', // deep purple
    '#3949AB', // indigo
    '#1E88E5', // blue
    '#039BE5', // light blue
    '#00ACC1', // cyan
    '#00897B', // teal
    '#43A047', // green
    '#7CB342', // light green
    '#FDD835', // yellow
    '#FFB300', // amber
    '#FB8C00', // orange
];

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/** Java's `String.hashCode()`, so colour assignment matches Android exactly. */
function javaStringHashCode(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
    }
    return hash;
}

/**
 * Picks a palette colour per grid cell, avoiding the colours already used by the
 * eight neighbouring cells so adjacent hulls stay visually distinct.
 * Ports `assignDistinctDebugColors()` from the Android SDK.
 */
function assignDistinctDebugColors(infos: MarkerClusterDebugInfo[]): Map<string, string> {
    const result = new Map<string, string>();
    if (infos.length === 0) return result;

    const sorted = [...infos].sort((a, b) => (a.cellX !== b.cellX ? a.cellX - b.cellX : a.cellY - b.cellY));

    for (const info of sorted) {
        const used = new Set<string>();
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const neighbor = result.get(`${info.cellX + dx},${info.cellY + dy}`);
                if (neighbor) used.add(neighbor);
            }
        }
        const start = (javaStringHashCode(info.id) & 0x7fffffff) % DEBUG_HULL_PALETTE.length;
        let chosen: string | null = null;
        for (let i = 0; i < DEBUG_HULL_PALETTE.length; i++) {
            const candidate = DEBUG_HULL_PALETTE[(start + i) % DEBUG_HULL_PALETTE.length];
            if (!used.has(candidate)) {
                chosen = candidate;
                break;
            }
        }
        result.set(`${info.cellX},${info.cellY}`, chosen ?? DEBUG_HULL_PALETTE[start]);
    }

    return result;
}

function buildHullPolygonStates(debugInfos: MarkerClusterDebugInfo[]): PolygonState[] {
    const drawable = debugInfos.filter((info) => info.hullPoints.length >= 3);
    if (drawable.length === 0) return [];
    const colorsByCell = assignDistinctDebugColors(debugInfos);
    return drawable.map((info) => {
        const base = colorsByCell.get(`${info.cellX},${info.cellY}`) ?? '#FF00FF';
        return createPolygonState({
            id: `cluster-hull-${info.id}`,
            points: info.hullPoints,
            strokeColor: hexToRgba(base, DEBUG_HULL_STROKE_ALPHA),
            strokeWidth: DEBUG_HULL_STROKE_WIDTH,
            fillColor: hexToRgba(base, DEBUG_HULL_FILL_ALPHA),
            geodesic: false,
            zIndex: 9,
        });
    });
}

/**
 * Options of `MarkerClusterGroup`.
 *
 * The clustering options mirror `MarkerClusterGroupState` in the Android SDK
 * one-for-one — same names, same defaults, same meaning — the way Compose's
 * parameter overload of `MarkerClusterGroup` does.
 */
export interface MarkerClusterGroupProps {
    /**
     * Markers to cluster. Combines with `children`-based markers rather than
     * replacing them: both feed the same collector, exactly as Android's
     * `markers` overload does with `Markers(markers)` inside the group.
     */
    markers?: MarkerState[];
    children?: React.ReactNode;
    /**
     * Re-cluster and re-render a marker when the app mutates its state
     * in place (`markerState.position = …`). Applies to both `markers` and
     * children-supplied markers.
     */
    trackMarkerUpdates?: boolean;

    // ── Clustering options ────────────────────────────────────────────────────
    clusterRadiusPx?: number;
    minClusterSize?: number;
    expandMargin?: number;
    clusterIconProvider?: ClusterIconProvider;
    /** Takes precedence over `clusterIconProvider`; `turn` increments on every zoom change. */
    clusterIconProviderWithTurn?: ClusterIconProviderWithTurn | null;
    onClusterClick?: ((cluster: MarkerCluster) => void) | null;
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
    /** Marker diameter in px used by the overlap-avoiding layout. */
    spiderfyMarkerSizePx?: number;
    /** Extra gap between fanned-out markers in px. */
    spiderfyMarkerMarginPx?: number;
    /** Leg polyline color. */
    spiderfyLegColor?: string;
    /** Leg polyline width. */
    spiderfyLegWidth?: number;
    /**
     * Called when a spiderfy fan opens (true) or collapses (false) — e.g. to
     * close an info bubble when the user clicks another cluster or the fan
     * is dismissed by a camera move.
     */
    onSpiderfyChange?: (open: boolean) => void;

    // ── Animation / misc ─────────────────────────────────────────────────────
    /** Animate cluster expand/shrink transitions on zoom change. */
    enableZoomAnimation?: boolean;
    /** Animate cluster transitions on camera pan. */
    enablePanAnimation?: boolean;
    /** Duration of the expand/shrink animation in milliseconds. */
    zoomAnimationDurationMillis?: number;
    /** Render convex-hull polygons for debug. */
    debugHullPolygons?: boolean;
    cameraIdleDebounceMillis?: number;
    tileSize?: number;
}

/**
 * Clusters markers using a grid-based greedy merge algorithm.
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
 * Structurally this is the Android `MarkerClusterGroup` Composable: the
 * component owns no clustering logic of its own. It builds a
 * `MarkerClusterStrategy`, hands it a renderer and a `StrategyMarkerController`,
 * feeds it markers and camera events, and mirrors the strategy's
 * `debugInfoFlow` / `spiderfyLegsFlow` into the parent scope's polygon and
 * polyline collectors.
 */
export function MarkerClusterGroup(props: MarkerClusterGroupProps): React.ReactElement | null {
    const {
        markers: markersProp,
        children,
        trackMarkerUpdates = true,
        clusterRadiusPx,
        minClusterSize,
        expandMargin,
        clusterIconProvider,
        clusterIconProviderWithTurn,
        onClusterClick,
        prepareExpand,
        spiderfyMinZoom,
        spiderfyMarkerSizePx,
        spiderfyMarkerMarginPx,
        spiderfyLegColor = DEFAULT_SPIDERFY_LEG_COLOR,
        spiderfyLegWidth = DEFAULT_SPIDERFY_LEG_WIDTH,
        onSpiderfyChange,
        enableZoomAnimation,
        enablePanAnimation,
        zoomAnimationDurationMillis,
        debugHullPolygons = false,
        cameraIdleDebounceMillis,
        tileSize,
    } = props;

    const parentScope = useMapViewScope();
    const mapCtx = useContext(MapContext);
    const controller = mapCtx?.controller ?? null;

    // Local scope so that child <Marker> components write to our collector,
    // not the parent's.
    const localScope = useMemo(() => new MapViewScope(), []);

    // Re-created whenever a clustering option changes, matching the
    // `remember(...)` key list of the Android Composable. `debugHullPolygons`
    // is deliberately not a key: the strategy always computes hull points and
    // only this component decides whether to draw them.
    const strategy = useMemo(
        () => new MarkerClusterStrategy({
            clusterRadiusPx,
            minClusterSize,
            expandMargin,
            clusterIconProvider,
            clusterIconProviderWithTurn,
            onClusterClick,
            prepareExpand,
            spiderfyMinZoom,
            spiderfyMarkerSizePx,
            spiderfyMarkerMarginPx,
            onSpiderfyChange,
            enableZoomAnimation,
            enablePanAnimation,
            zoomAnimationDurationMillis,
            cameraIdleDebounceMillis,
            tileSize,
        }),
        [
            clusterRadiusPx, minClusterSize, expandMargin, clusterIconProvider,
            clusterIconProviderWithTurn, onClusterClick, prepareExpand, spiderfyMinZoom,
            spiderfyMarkerSizePx, spiderfyMarkerMarginPx, onSpiderfyChange,
            enableZoomAnimation, enablePanAnimation, zoomAnimationDurationMillis,
            cameraIdleDebounceMillis, tileSize,
        ],
    );

    // ── Rendering pipeline (the Android `MarkerRenderingGroup`) ───────────────

    // レンダラはプロバイダから受け取る。android-sdk の `MarkerRenderingGroup` が
    // `LocalMapServiceRegistry.current.get(MarkerRenderingSupportKey)` で解決するのと同じ経路で、
    // ios-sdk の `MapServiceRegistryScope.current.get(MarkerRenderingSupportKey.self)` にも対応する。
    // 以前は parentScope.markerCollector を直接掴んでレンダラを自前で組み立てていたが、
    // それだとプラグインがマップ内部の実装に手を伸ばす形になり、プロバイダ側が
    // 描画経路を差し替える余地も無かった。
    const services = useMapServiceRegistry();
    const renderingSupport = services.get(MarkerRenderingSupportKey);

    const renderer = useMemo(
        () => (renderingSupport ? renderingSupport.createMarkerRenderer(strategy) : null),
        [renderingSupport, strategy],
    );

    const markerController = useMemo(
        () => (renderer ? new StrategyMarkerController<MarkerState>({ strategy, renderer }) : null),
        [strategy, renderer],
    );

    // イベントコントローラもプロバイダが作り、プロバイダへ登録し返す
    // （android-sdk の MarkerRenderingGroup と同じ 2 段）。
    useEffect(() => {
        if (!renderingSupport || !markerController || !renderer) return;
        const eventController = renderingSupport.createMarkerEventController(markerController, renderer);
        renderingSupport.registerMarkerEventController(eventController);
    }, [renderingSupport, markerController, renderer]);

    // ── Camera subscription (chain with the existing single-slot listener) ────

    useEffect(() => {
        if (!controller || !markerController) return;

        // オーバーレイコントローラとして登録すればカメラ変更が伝播してくる
        // （android-sdk の MarkerClusterGroup が registerOverlayController するのと同じ）。
        // 以前はコントローラの protected な cameraMoveEndCallback を覗いて単一スロットの
        // リスナーに相乗りしていたが、レジストリができたので不要になった。
        controller.registerOverlayController?.(markerController);

        // 初回のクラスタ計算を走らせるため、現在のカメラを 1 度だけ流し込む。
        // 取得元は state（`mapViewState.cameraPosition`）で、コントローラの
        // `getCameraPosition()` はプロバイダ内部用なので拡張からは触らない。
        // 以降の変化は登録済みオーバーレイへの `onCameraChanged` で届く。
        const initial = mapCtx?.state?.cameraPosition ?? null;
        if (initial) void markerController.onCameraChanged(initial);

        return () => {
            controller.unregisterOverlayController?.(markerController);
        };
    }, [controller, markerController, mapCtx]);

    // ── Markers prop ─────────────────────────────────────────────────────────

    // Written into the same collector children `<Marker>` components use, the
    // way Android's `markers` overload calls `Markers(markers)` inside the
    // group. Going through the collector is what makes `trackMarkerUpdates`
    // work for these markers too — a direct hand-off to the controller would
    // never see an in-place `markerState.position = …`.
    const propMarkerIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        const nextStates = markersProp ?? [];
        const nextIds = new Set(nextStates.map((state) => state.id));
        const removeIds = [...propMarkerIdsRef.current].filter((id) => !nextIds.has(id));
        if (nextStates.length === 0 && removeIds.length === 0) return;
        propMarkerIdsRef.current = nextIds;
        localScope.markerCollector.applyDiff(nextStates, removeIds);
    }, [localScope, markersProp]);

    // ── Single feed into the controller ──────────────────────────────────────

    useEffect(() => {
        if (!markerController) return;
        return localScope.markerCollector.subscribe((markerMap) => {
            void markerController.add([...markerMap.values()]);
        });
    }, [markerController, localScope]);

    useEffect(() => {
        if (!markerController || !trackMarkerUpdates) {
            localScope.markerCollector.setUpdateHandler(null);
            return;
        }
        // Subscribing to a state replays its current fingerprint, and those
        // replays are not edits. Forwarding them would feed the strategy one
        // marker at a time ahead of the batch add, and its per-marker assignment
        // cache would pin each one as "individual" — no cluster could ever form.
        // Only a marker the strategy already tracks can have genuinely changed.
        //
        // Android gates the same handler on `getEntity(id) != null`, which also
        // filters the replay but additionally drops every member swallowed by a
        // cluster, so moving one never re-clusters. Gating on the source set
        // instead keeps the replay out without losing real edits.
        localScope.markerCollector.setUpdateHandler((state) => {
            if (!strategy.hasSourceMarker(state.id)) return;
            void markerController.update(state);
        });
        return () => {
            localScope.markerCollector.setUpdateHandler(null);
        };
    }, [markerController, strategy, trackMarkerUpdates, localScope]);

    // ── Debug hull polygons ──────────────────────────────────────────────────

    const hullPolygonIdsRef = useRef<Set<string>>(new Set());

    const syncHullPolygons = useCallback((debugInfos: MarkerClusterDebugInfo[]) => {
        const nextStates = debugHullPolygons ? buildHullPolygonStates(debugInfos) : [];
        const nextIds = new Set(nextStates.map((state) => state.id));
        const removeIds = [...hullPolygonIdsRef.current].filter((id) => !nextIds.has(id));
        if (nextStates.length === 0 && removeIds.length === 0) return;
        parentScope.polygonCollector.applyDiff(nextStates, removeIds);
        hullPolygonIdsRef.current = nextIds;
    }, [parentScope, debugHullPolygons]);

    // Force a fresh cluster recompute so polygons reflect the current camera
    // position rather than whatever the coverage-bounds cache holds.
    useEffect(() => {
        if (debugHullPolygons) strategy.forceRender();
    }, [strategy, debugHullPolygons]);

    useEffect(
        () => strategy.debugInfoFlow.subscribe(syncHullPolygons),
        [strategy, syncHullPolygons],
    );

    // Commit polygon updates before the strategy starts animating markers, so
    // polygon rendering and marker animation cannot race each other.
    useEffect(() => {
        if (!debugHullPolygons) {
            strategy.onBeforeAnimation = null;
            return;
        }
        strategy.onBeforeAnimation = (debugInfos) => {
            syncHullPolygons(debugInfos);
        };
        return () => {
            strategy.onBeforeAnimation = null;
        };
    }, [strategy, debugHullPolygons, syncHullPolygons]);

    // ── Spiderfy leg polylines ───────────────────────────────────────────────

    const legPolylineIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => strategy.spiderfyLegsFlow.subscribe((legs) => {
        const nextStates = legs.map((leg) => createPolylineState({
            id: leg.id,
            points: [leg.start, leg.end],
            strokeColor: spiderfyLegColor,
            strokeWidth: spiderfyLegWidth,
            geodesic: false,
        }));
        const nextIds = new Set(nextStates.map((state) => state.id));
        const removeIds = [...legPolylineIdsRef.current].filter((id) => !nextIds.has(id));
        if (nextStates.length === 0 && removeIds.length === 0) return;
        parentScope.polylineCollector.applyDiff(nextStates, removeIds);
        legPolylineIdsRef.current = nextIds;
    }), [strategy, parentScope, spiderfyLegColor, spiderfyLegWidth]);

    // ── Teardown ─────────────────────────────────────────────────────────────

    useEffect(() => () => {
        // コレクタ連動レンダラは自分が書き込んだマーカーを回収する必要がある。
        // プロバイダが独自のレンダラを返している場合はその後始末はプロバイダ側の責務
        // （android-sdk / ios-sdk も、プラグインはレンダラの内部後始末をしない）。
        if (renderer instanceof CollectorMarkerOverlayRenderer) renderer.reset();
        parentScope.polygonCollector.applyDiff([], hullPolygonIdsRef.current);
        parentScope.polylineCollector.applyDiff([], legPolylineIdsRef.current);
        hullPolygonIdsRef.current = new Set();
        legPolylineIdsRef.current = new Set();
        strategy.clear();
    }, [renderer, strategy, parentScope]);

    return (
        <MapViewScopeProvider scope={localScope}>
            {children ?? null}
        </MapViewScopeProvider>
    );
}
