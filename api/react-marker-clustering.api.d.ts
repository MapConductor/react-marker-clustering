import { g as MarkerClusterDebugInfo, h as MarkerClusterOptions, S as SpiderfyLeg, C as ClusterIconProvider, i as ClusterIconProviderWithTurn, a as MarkerCluster } from './MarkerClusterOptions-DLzq6xvj.js';
export { D as DEFAULT_CAMERA_DEBOUNCE_MILLIS, b as DEFAULT_CLUSTER_RADIUS_PX, c as DEFAULT_EXPAND_MARGIN, j as DEFAULT_ICON_PROVIDER, d as DEFAULT_MIN_CLUSTER_SIZE, k as DEFAULT_SPIDERFY_MARKER_MARGIN_PX, l as DEFAULT_SPIDERFY_MARKER_SIZE_PX, e as DEFAULT_TILE_SIZE, f as DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS } from './MarkerClusterOptions-DLzq6xvj.js';
import { GeoPointInterface, GeoPoint, GeoRectBounds, MapCameraPosition, MarkerState, MarkerManager, MarkerEntity, BitmapIcon, MarkerOverlayRenderer, Offset, AbstractMarkerRenderingStrategy } from '@mapconductor/js-sdk-core';
export { CollectorMarkerOverlayRenderer as ClusterMarkerOverlayRenderer } from '@mapconductor/js-sdk-core';
import React from 'react';

/** 投影座標上の 1 点。凸包と重心の計算にだけ使う。 */
interface HullPoint {
    x: number;
    y: number;
}
/**
 * クラスタリングが使う投影・境界・平均・凸包の計算。
 *
 * ここにあるのは**すべて副作用のない計算**で、状態を持たない
 * （`tileSize` は投影の縮尺として受け取るだけ）。
 *
 * android-sdk の `ClusterGeometry.kt` / ios-sdk の `ClusterGeometry.swift` と
 * 同じ関数を同じ名前で持つ。片方だけ直すと 3 者の描画結果がずれるので、
 * 式を変えるときは必ず 3 つとも直すこと。
 */
declare class ClusterGeometry {
    private readonly tileSize;
    constructor(tileSize: number);
    projectToPixel(position: GeoPointInterface, zoom: number): [number, number];
    unprojectPixel(point: HullPoint, zoom: number): GeoPoint;
    metersPerPixel(position: GeoPointInterface, zoom: number): number;
    wrapLongitude(longitude: number): number;
    /**
     * 日付変更線をまたぐ表現に対応した内外判定。
     *
     * `GeoRectBounds` は経度方向の最小の弧を選ぶ。日付変更線近くの小さな
     * ビューポートではそれが正しいが、大きく引いた表示では実際の可視範囲が
     * 180 度を超え、最小の弧が補集合になってしまう。そのため低ズームでは
     * 「またいでいる境界＝広い範囲」とみなして補集合側を採る。
     */
    containsInViewport(bounds: GeoRectBounds | null, point: GeoPointInterface, zoom: number): boolean;
    containsBounds(container: GeoRectBounds, target: GeoRectBounds): boolean;
    extendCoverageBounds(bounds: GeoRectBounds, center: GeoPoint, radiusMeters: number): void;
    /**
     * 実際の visibleRegion が取れないときのビューポート推定。
     *
     * 直前のビューポートの広さを 2^(baseZoom − zoom) で伸縮し、現在のカメラ位置を
     * 中心に置き直す。ArcGIS はアニメーション中に visibleRegion が null の
     * カメラ更新を出すため、これが無いとズームアウト後に見えるようになった
     * マーカーがクラスタリングに入らない。
     */
    estimateViewport(zoom: number, center: GeoPointInterface, lastKnownViewport: GeoRectBounds | null, lastKnownViewportZoom: number | null): GeoRectBounds | null;
    hasCameraMoved(previous: MapCameraPosition, current: MapCameraPosition): boolean;
    interpolatePosition(start: GeoPoint, end: GeoPoint, t: number): GeoPoint;
    averagePosition(states: MarkerState[]): GeoPoint;
    /**
     * `clusterState` のメンバーが対応づけられている中心の平均。
     * どれも分からないときは null（そのマーカーはアニメーション無しで切り替わる）。
     */
    averageOfMemberCenters(clusterState: MarkerState, centers: ReadonlyMap<string, GeoPoint>): GeoPoint | null;
    calculateClusterRadiusMeters(center: GeoPoint, members: MarkerState[]): number;
    /**
     * 位置だけの指紋。前回の描画からマーカーが動いたかを見るために使う。
     * マーカー全体を見る `MarkerFingerPrint` とは別物。
     */
    positionFingerPrint(position: GeoPointInterface): string;
    /** 投影座標の凸包（Andrew's monotone chain）。3 点未満に潰れる場合は空を返す。 */
    convexHullProjected(members: MarkerState[], zoom: number): HullPoint[];
    /** 靴ひも公式による多角形重心。面積が潰れている場合は頂点平均へ落とす。 */
    polygonCentroidProjected(hull: HullPoint[]): HullPoint | null;
}

/** クラスタリング格子のセル座標。 */
interface ClusterCell {
    x: number;
    y: number;
}
/** 格子セル 1 つ分のまとまり。`mergeClusters` の入力。 */
interface ClusterCandidate {
    cell: ClusterCell;
    center: GeoPoint;
    members: MarkerState[];
}
/** 近傍セルを吸収したあとのまとまり。`mergeClusters` の出力。 */
interface MergedCluster {
    center: GeoPoint;
    members: MarkerState[];
}
/**
 * 「どのマーカーを 1 つのクラスタにまとめるか」を決める部分。
 *
 * 状態を持たず、渡された候補だけから結果を決める。カメラや描画の都合は
 * `MarkerClusterStrategy` と `ClusterPlanner` 側にあり、ここには入れない。
 *
 * android-sdk の `ClusterBuilder.kt` / ios-sdk の `ClusterBuilder.swift` と同じ計算。
 * しきい値や走査順を変えるときは 3 つとも直すこと。
 */
declare class ClusterBuilder {
    private readonly geometry;
    private readonly clusterRadiusPx;
    constructor(geometry: ClusterGeometry, clusterRadiusPx: number);
    /**
     * ズームに応じて実効クラスタ半径を縮める。
     *
     * 低ズームでは画面上の固定半径が数百 km に相当してしまい、まとめすぎに見える。
     */
    effectiveClusterRadiusPx(zoom: number): number;
    buildClusterId(cell: ClusterCell, zoom: number): string;
    /** マーカー 1 件が属する格子セルを返す。 */
    cellOf(position: GeoPointInterface, zoom: number, effectiveRadiusPx: number): ClusterCell;
    /**
     * 近い候補どうしをまとめる。
     *
     * 連鎖的な併合（A-B が近く B-C が近いだけで A-C まで 1 つになる）を避けるため、
     * 種となる候補の半径に入るものだけを貪欲に吸収する。
     */
    mergeClusters(candidates: ClusterCandidate[], zoom: number, clusterRadiusPx: number): MergedCluster[];
    /**
     * まとまりの中で最も密なところにいるメンバーの位置を返す。
     *
     * 単純な平均だと、外れ値ひとつでクラスタの見かけ上の中心が誰もいない場所へ動く。
     * 格子で粗く数えてから上位セルの中だけを総当たりするので、メンバー数に対して線形。
     */
    selectDenseCenter(members: MarkerState[], zoom: number, clusterRadiusPx: number): GeoPoint;
}

/** アニメーションで動かす 1 件分。`entity` は 1 フレームごとに差し替わる。 */
interface AnimatedMove {
    id: string;
    start: GeoPoint;
    end: GeoPoint;
    baseState: MarkerState;
    entity: MarkerEntity<MarkerState>;
    /**
     * 出てくるマーカーで true。`baseState` は既に最終位置を持つアプリ所有の
     * インスタンスなので、最後のフレームでは位置を写した複製ではなくその
     * インスタンス自体を返す。こうしないと、あとからアプリがそのマーカーを
     * 書き換えても地図に届かなくなる。
     */
    restoreBaseStateAtEnd: boolean;
}
/**
 * ズーム／パン時にクラスタとメンバーの間をマーカーが移動するアニメーション。
 *
 * フレームごとに `onChange` + `onPostProcess` を呼ぶだけで、どのマーカーを
 * どこへ動かすかは `ClusterMarkerRenderer` が決める。
 *
 * **件数でフレームレートを落とす**のが要点。数百件を 60fps で動かすと
 * `onChange` が間に合わずカクつくので、件数に応じて 60/30/8/4fps へ落とす。
 * 動きは粗くなるが、止まって見えるよりは良い。
 *
 * android-sdk の `ClusterMarkerAnimator.kt` /
 * ios-sdk の `MarkerClusterStrategy+Animation.swift` と同じ段階分け。
 */
declare class ClusterMarkerAnimator {
    private readonly geometry;
    private readonly markerManager;
    private readonly renderedMarkerEntities;
    private readonly defaultMarkerIcon;
    /** 呼び出し時のトークンがまだ最新か。古くなったらアニメーションを打ち切る。 */
    private readonly isCurrent;
    constructor(geometry: ClusterGeometry, markerManager: MarkerManager<MarkerState>, renderedMarkerEntities: Map<string, MarkerEntity<MarkerState>>, defaultMarkerIcon: BitmapIcon, 
    /** 呼び出し時のトークンがまだ最新か。古くなったらアニメーションを打ち切る。 */
    isCurrent: (token: number) => boolean);
    /**
     * @returns 最後まで再生できたとき true。新しいカメラ更新に追い越されて
     *   途中で止めたときは false（呼び出し側が後始末する）。
     */
    animate(moves: AnimatedMove[], renderer: MarkerOverlayRenderer<MarkerState>, durationMillis: number, token: number): Promise<boolean>;
    private animationFrameMillis;
}

/** 1 つのクラスタとして描くと決まったまとまり。 */
interface PlannedCluster {
    id: string;
    center: GeoPoint;
    members: MarkerState[];
    radiusMeters: number;
    cell: ClusterCell;
    hullPoints: GeoPoint[];
}
/**
 * 計画の 1 要素。**元の並び順を保つため**にクラスタと素通しを 1 つの列で持つ。
 *
 * 並び順は描画側の追加順になり、プロバイダによっては重なり順に影響する。
 * クラスタだけ・素通しだけを別々のリストにすると順序が変わってしまう。
 */
type PlannedEntry = {
    kind: 'cluster';
    cluster: PlannedCluster;
} | {
    kind: 'singles';
    states: MarkerState[];
};
/** `ClusterPlanner.plan` の結果一式。 */
interface ClusterPlan {
    entries: PlannedEntry[];
    clusterMemberCenters: Map<string, GeoPoint>;
    clusterPositions: Map<string, GeoPoint>;
    assignments: Map<string, string>;
    coverageBounds: GeoRectBounds;
    sourceFingerprints: Map<string, string>;
}
/** 前回の描画結果のうち、今回の計算で再利用するもの。 */
interface ClusterPlanCache {
    assignments: ReadonlyMap<string, string>;
    clusterPositions: ReadonlyMap<string, GeoPoint>;
    coverageBounds: GeoRectBounds | null;
    sourceFingerprints: ReadonlyMap<string, string>;
}
interface ClusterPlanInput {
    sourceStates: Iterable<MarkerState>;
    expandedBounds: GeoRectBounds;
    zoom: number;
    effectiveRadiusPx: number;
    zoomChanged: boolean;
    minClusterSize: number;
    cache: ClusterPlanCache;
}
/**
 * 「今の画面に何をどう描くか」を決める部分。マーカーの状態から計画を作るだけで、
 * 描画も状態の書き換えもしない。
 *
 * 前回の割り当てをできるだけ再利用するのが要点で、これが無いとパンのたびに
 * クラスタの中心が微妙に動いてちらつく。動いていないマーカーは前回の
 * クラスタに置いたまま、新しく入ってきたものだけを `ClusterBuilder` にかける。
 *
 * android-sdk の `ClusterPlanner.kt` /
 * ios-sdk の `MarkerClusterStrategy+Planning.swift` と同じ手順。
 */
declare class ClusterPlanner {
    private readonly geometry;
    private readonly builder;
    constructor(geometry: ClusterGeometry, builder: ClusterBuilder);
    plan(input: ClusterPlanInput): ClusterPlan;
    /** 前回の割り当てから、クラスタ単位／素通し単位のまとまりを組み直す。 */
    private groupCachedMarkers;
    /** 新しいマーカーを格子セルへ入れ、セル座標順に並べた候補にする。 */
    private bucketNewMarkers;
    /**
     * 新しく計算したまとまりを、位置が近い前回のクラスタへ吸収させる。
     *
     * 吸収できたものは**前回の中心をそのまま使う**。メンバーが変わっていないのに
     * 中心だけ動くと、パンのたびにクラスタマーカーが小刻みに揺れて見えるため。
     */
    private absorbCachedClusters;
    /** まとまりごとに「クラスタにする／そのまま描く」を決め、中心と半径を確定させる。 */
    private buildPlan;
}

/**
 * spiderfy で開いたメンバーを画面上のどこへ置くかを決める、力学モデルの配置計算。
 *
 * クラスタの周りの等間隔な円から始めて、メンバーどうし・既に出ている他のマーカー
 * （固定の障害物）・クラスタ自身を押しのけ合わせる。同時に中心へ向かう弱いばねを
 * かけて広がりすぎを抑える。少数なら円、多いと同心の層に収束する。
 *
 * 純粋な計算で、地図にもマーカーにも触らない。座標はクラスタ中心からの相対 px。
 *
 * android-sdk の `SpiderfyLayout.kt` / ios-sdk の `SpiderfyLayout.swift` と同じ式。
 */
declare class SpiderfyLayout {
    /**
     * @param count 開くメンバー数
     * @param markerSizePx マーカーの直径
     * @param marginPx マーカー間に空ける余白
     * @param obstacles 既に描かれているマーカーのクラスタ中心からの相対座標
     * @returns クラスタ中心からの相対オフセット（`count` 件）
     */
    compute(count: number, markerSizePx: number, marginPx: number, obstacles: Offset[]): Offset[];
}

/**
 * Minimal observable value, the web counterpart of the Kotlin `StateFlow`s that
 * `MarkerClusterStrategy.kt` publishes (`debugInfoFlow`, `spiderfyLegsFlow`).
 *
 * The strategy owns the state and only ever writes; `MarkerClusterGroup`
 * subscribes and mirrors the value into the polygon / polyline collectors —
 * exactly the split Android uses with `collectAsState()`.
 */
interface StateFlow<T> {
    readonly value: T;
    /** Invokes `subscriber` with the current value, then on every change. */
    subscribe(subscriber: (value: T) => void): () => void;
}
declare class MutableStateFlow<T> implements StateFlow<T> {
    private current;
    private readonly subscribers;
    constructor(initialValue: T);
    get value(): T;
    set value(next: T);
    subscribe(subscriber: (value: T) => void): () => void;
}

/** 差し替えたい部品だけを入れる。未指定のものは既定の実装が使われる。 */
interface ClusterComponentOverrides {
    geometry?: ClusterGeometry;
    builder?: ClusterBuilder;
    planner?: ClusterPlanner;
    animator?: ClusterMarkerAnimator;
    spiderfyLayout?: SpiderfyLayout;
}

/**
 * 近くのマーカーを 1 つにまとめて描くマーカーレンダリングストラテジ。
 *
 * このクラスが持つのは**元データの保持と段取り**だけで、実際の仕事は
 * `ClusterComponents` が組み立てた責務ごとの部品へ渡す:
 *
 * | 部品                      | 担当                                        |
 * |---------------------------|---------------------------------------------|
 * | `ClusterRenderScheduler`  | いつ再クラスタするか（デバウンス・打ち切り）|
 * | `ClusterPlanner`          | 何をどこにまとめるか（前回結果の再利用）    |
 * | `ClusterBuilder`          | 近い候補の併合と中心の選び方                |
 * | `ClusterGeometry`         | 投影・境界・平均・凸包                      |
 * | `ClusterMarkerRenderer`   | 計画と現状の差を描画へ反映                  |
 * | `ClusterMarkerAnimator`   | クラスタとメンバーの間の移動アニメーション  |
 * | `SpiderfyController`      | クリックでメンバーを扇状に開く              |
 *
 * `MarkerClusterGroup` はマーカーとカメライベントを流し込み、`debugInfoFlow` /
 * `spiderfyLegsFlow` をポリゴン・ポリラインのコレクタへ写すだけ。
 */
declare class MarkerClusterStrategy extends AbstractMarkerRenderingStrategy<MarkerState> {
    private readonly minClusterSize;
    private readonly expandMargin;
    private readonly clusterIconProvider;
    private readonly clusterIconProviderWithTurn;
    private readonly onClusterClick;
    private readonly prepareExpand;
    private readonly enableZoomAnimation;
    private readonly enablePanAnimation;
    private readonly sourceStates;
    private readonly sourceFingerprints;
    private sourceStateVersion;
    private readonly semaphore;
    private readonly _debugInfoFlow;
    private forceNextRender;
    private readonly renderState;
    private readonly renderedMarkerEntities;
    private readonly components;
    /**
     * Called after cluster computation and before marker animations start. Set
     * by `MarkerClusterGroup` to commit hull polygon updates first, so polygon
     * rendering and marker animation cannot race each other.
     */
    onBeforeAnimation: ((debugInfos: MarkerClusterDebugInfo[]) => Promise<void> | void) | null;
    constructor(options?: MarkerClusterOptions, overrides?: ClusterComponentOverrides);
    /**
     * True when this source marker has already been handed to the strategy via
     * `onAdd`. Lets the group tell a genuine edit from the fingerprint replay a
     * fresh state subscription emits.
     */
    hasSourceMarker(id: string): boolean;
    /** Hull polygons of the clusters produced by the latest computation. */
    get debugInfoFlow(): StateFlow<MarkerClusterDebugInfo[]>;
    /**
     * Leg polylines of the currently open spiderfy fan (empty when no fan is
     * open). `MarkerClusterGroup` observes this to draw the leg polylines.
     */
    get spiderfyLegsFlow(): StateFlow<SpiderfyLeg[]>;
    clear(): void;
    /**
     * Forces a full cluster recompute on the next render, bypassing the
     * coverage-bounds early return. Used by `MarkerClusterGroup` so debug hull
     * polygons reflect the current camera position as soon as they are enabled.
     */
    forceRender(): void;
    onAdd(params: {
        data: MarkerState[];
        viewport: GeoRectBounds;
        renderer: MarkerOverlayRenderer<MarkerState>;
    }): Promise<boolean>;
    onUpdate(params: {
        state: MarkerState;
        viewport: GeoRectBounds;
        renderer: MarkerOverlayRenderer<MarkerState>;
    }): Promise<boolean>;
    onCameraChanged(cameraPosition: MapCameraPosition, renderer: MarkerOverlayRenderer<MarkerState>): Promise<void>;
    private updateSourceStates;
    private renderClusters;
    /**
     * 新しく現れる個別マーカーの準備をアプリ側に任せ、終わるまで待つ。
     *
     * @returns 反映を続けてよいとき true。待っている間に新しいカメラ更新に
     *   追い越されたら false。
     */
    private awaitPrepareExpand;
    private toClusterMarkerState;
    private toDebugInfo;
}

/** Leg polyline defaults, matching `MarkerClusterGroupState` on Android. */
declare const DEFAULT_SPIDERFY_LEG_COLOR = "#666666";
declare const DEFAULT_SPIDERFY_LEG_WIDTH = 1.5;
/**
 * Options of `MarkerClusterGroup`.
 *
 * The clustering options mirror `MarkerClusterGroupState` in the Android SDK
 * one-for-one — same names, same defaults, same meaning — the way Compose's
 * parameter overload of `MarkerClusterGroup` does.
 */
interface MarkerClusterGroupProps {
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
declare function MarkerClusterGroup(props: MarkerClusterGroupProps): React.ReactElement | null;

export { ClusterIconProvider, ClusterIconProviderWithTurn, DEFAULT_SPIDERFY_LEG_COLOR, DEFAULT_SPIDERFY_LEG_WIDTH, MarkerCluster, MarkerClusterDebugInfo, MarkerClusterGroup, type MarkerClusterGroupProps, MarkerClusterOptions, MarkerClusterStrategy, MutableStateFlow, SpiderfyLeg, type StateFlow };
