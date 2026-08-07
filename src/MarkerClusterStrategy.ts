import {
    AbstractMarkerRenderingStrategy,
    createMarkerState,
    expandBounds,
    fingerPrintEquals,
    HexGeocellImpl,
    MarkerManager,
    Mutex,
    type GeoRectBounds,
    type MapCameraPosition,
    type MarkerEntity,
    type MarkerFingerPrint,
    type MarkerOverlayRenderer,
    type MarkerState,
    type Serializable,
} from '@mapconductor/js-sdk-core';
import { CLUSTER_ID_PREFIX } from './ClusterBuilder';
import {
    DEFAULT_CAMERA_DEBOUNCE_MILLIS,
    DEFAULT_CLUSTER_RADIUS_PX,
    DEFAULT_EXPAND_MARGIN,
    DEFAULT_ICON_PROVIDER,
    DEFAULT_MIN_CLUSTER_SIZE,
    DEFAULT_SPIDERFY_MARKER_MARGIN_PX,
    DEFAULT_SPIDERFY_MARKER_SIZE_PX,
    DEFAULT_TILE_SIZE,
    DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS,
    type ClusterIconProvider,
    type ClusterIconProviderWithTurn,
    type MarkerClusterOptions,
} from './MarkerClusterOptions';
import { ClusterComponents, type ClusterComponentOverrides } from './ClusterComponents';
import type { PlannedCluster } from './ClusterPlanner';
import { ClusterRenderState } from './ClusterRenderState';
import type { RenderRequest } from './ClusterRenderScheduler';
import type { MarkerCluster, MarkerClusterDebugInfo, SpiderfyLeg } from './MarkerCluster';
import { MutableStateFlow, type StateFlow } from './StateFlow';

// 定数とオプションは MarkerClusterOptions.ts にある。以前からこのモジュール名で
// 公開しているので、そのまま再エクスポートして import 元を変えずに済ませる。
export {
    DEFAULT_CAMERA_DEBOUNCE_MILLIS,
    DEFAULT_CLUSTER_RADIUS_PX,
    DEFAULT_EXPAND_MARGIN,
    DEFAULT_ICON_PROVIDER,
    DEFAULT_MIN_CLUSTER_SIZE,
    DEFAULT_SPIDERFY_MARKER_MARGIN_PX,
    DEFAULT_SPIDERFY_MARKER_SIZE_PX,
    DEFAULT_TILE_SIZE,
    DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS,
    type ClusterIconProvider,
    type ClusterIconProviderWithTurn,
    type MarkerClusterOptions,
} from './MarkerClusterOptions';

// ── Strategy ──────────────────────────────────────────────────────────────────

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
export class MarkerClusterStrategy extends AbstractMarkerRenderingStrategy<MarkerState> {
    private readonly minClusterSize: number;
    private readonly expandMargin: number;
    private readonly clusterIconProvider: ClusterIconProvider;
    private readonly clusterIconProviderWithTurn: ClusterIconProviderWithTurn | null;
    private readonly onClusterClick: ((cluster: MarkerCluster) => void) | null;
    private readonly prepareExpand: ((appearing: MarkerState[]) => Promise<void>) | null;
    private readonly enableZoomAnimation: boolean;
    private readonly enablePanAnimation: boolean;

    private readonly sourceStates = new Map<string, MarkerState>();

    // Full marker fingerprints of the source states. `!==` on a MarkerState is a
    // reference check, so an in-place `markerState.position = …` compares the
    // instance against itself and would never look changed; comparing
    // fingerprints catches it. Mirrors `sourceFingerprints` on iOS/Android.
    private readonly sourceFingerprints = new Map<string, MarkerFingerPrint>();
    private sourceStateVersion = 0;

    // JS has no threads, but `await` points inside renderClusters() interleave
    // just like Android's coroutines do, so the same critical section applies.
    private readonly semaphore = new Mutex();

    private readonly _debugInfoFlow = new MutableStateFlow<MarkerClusterDebugInfo[]>([]);
    private forceNextRender = false;
    private readonly renderState = new ClusterRenderState();
    private readonly renderedMarkerEntities = new Map<string, MarkerEntity<MarkerState>>();
    private readonly components: ClusterComponents;

    /**
     * Called after cluster computation and before marker animations start. Set
     * by `MarkerClusterGroup` to commit hull polygon updates first, so polygon
     * rendering and marker animation cannot race each other.
     */
    onBeforeAnimation: ((debugInfos: MarkerClusterDebugInfo[]) => Promise<void> | void) | null = null;

    constructor(options: MarkerClusterOptions = {}, overrides?: ClusterComponentOverrides) {
        super(new MarkerManager<MarkerState>(options.geocell ?? HexGeocellImpl.defaultGeocell(), 0));
        this.minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
        this.expandMargin = options.expandMargin ?? DEFAULT_EXPAND_MARGIN;
        this.clusterIconProvider = options.clusterIconProvider ?? DEFAULT_ICON_PROVIDER;
        this.clusterIconProviderWithTurn = options.clusterIconProviderWithTurn ?? null;
        this.onClusterClick = options.onClusterClick ?? null;
        this.prepareExpand = options.prepareExpand ?? null;
        this.enableZoomAnimation = options.enableZoomAnimation ?? false;
        this.enablePanAnimation = options.enablePanAnimation ?? false;

        this.components = new ClusterComponents({
            clusterRadiusPx: options.clusterRadiusPx ?? DEFAULT_CLUSTER_RADIUS_PX,
            tileSize: options.tileSize ?? DEFAULT_TILE_SIZE,
            cameraIdleDebounceMillis: options.cameraIdleDebounceMillis ?? DEFAULT_CAMERA_DEBOUNCE_MILLIS,
            zoomAnimationDurationMillis:
                options.zoomAnimationDurationMillis ?? DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS,
            spiderfyMinZoom: options.spiderfyMinZoom ?? null,
            spiderfyMarkerSizePx: options.spiderfyMarkerSizePx ?? DEFAULT_SPIDERFY_MARKER_SIZE_PX,
            spiderfyMarkerMarginPx: options.spiderfyMarkerMarginPx ?? DEFAULT_SPIDERFY_MARKER_MARGIN_PX,
            prepareExpand: this.prepareExpand,
            onSpiderfyChange: options.onSpiderfyChange ?? null,
            markerManager: this.markerManager,
            renderedMarkerEntities: this.renderedMarkerEntities,
            defaultMarkerIcon: this.defaultMarkerIcon,
            onRender: (request) => this.renderClusters(request),
            sourceStateProvider: (id) => this.sourceStates.get(id),
            overrides,
        });
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
        return this.components.spiderfy.legsFlow;
    }

    override clear(): void {
        this.sourceStates.clear();
        this.sourceFingerprints.clear();
        this.sourceStateVersion = 0;
        this.markerManager.clear();
        this._debugInfoFlow.value = [];
        this.renderedMarkerEntities.clear();
        this.renderState.reset();
        this.components.scheduler.reset();
        this.components.spiderfy.reset();
        this.forceNextRender = false;
    }

    /**
     * Forces a full cluster recompute on the next render, bypassing the
     * coverage-bounds early return. Used by `MarkerClusterGroup` so debug hull
     * polygons reflect the current camera position as soon as they are enabled.
     */
    forceRender(): void {
        this.forceNextRender = true;
        const scheduler = this.components.scheduler;
        const cameraPosition = scheduler.lastCameraPosition;
        if (!cameraPosition) return;
        const viewport = scheduler.lastKnownViewport ?? scheduler.lastUsedViewport;
        if (!viewport) return;
        const renderer = scheduler.lastRenderer;
        if (!renderer) return;
        scheduler.enqueue(cameraPosition, viewport, renderer, scheduler.nextToken());
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
        const scheduler = this.components.scheduler;
        scheduler.lastRenderer = params.renderer;
        if (!scheduler.lastCameraPosition) return true;
        scheduler.enqueue(scheduler.lastCameraPosition, params.viewport, params.renderer, scheduler.currentToken);
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
        const scheduler = this.components.scheduler;
        scheduler.lastRenderer = params.renderer;
        if (!scheduler.lastCameraPosition) return true;
        scheduler.enqueue(scheduler.lastCameraPosition, params.viewport, params.renderer, scheduler.currentToken);
        return true;
    }

    async onCameraChanged(
        cameraPosition: MapCameraPosition,
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<void> {
        this.components.scheduler.onCameraChanged(cameraPosition, renderer);
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
        const { scheduler, geometry, builder, planner, markerRenderer, spiderfy } = this.components;

        await this.semaphore.withLock(async () => {
            if (!scheduler.isCurrent(token)) return;

            const zoom = cameraPosition.zoom;
            const expandedBounds = expandBounds(viewport, this.expandMargin);
            const { turn, zoomChanged } = this.renderState.updateClusteringTurn(zoom);
            const sourceStateVersionSnapshot = this.sourceStateVersion;
            const stableSource = sourceStateVersionSnapshot === this.renderState.sourceStateVersion;
            const cameraMoved = this.renderState.renderCameraPosition != null &&
                geometry.hasCameraMoved(this.renderState.renderCameraPosition, cameraPosition);
            const animateTransitions =
                (this.enableZoomAnimation && zoomChanged) ||
                (this.enablePanAnimation && cameraMoved);
            const forced = this.forceNextRender;
            this.forceNextRender = false;
            scheduler.lastUsedViewport = viewport;

            // 再クラスタ（カメラ移動・データ変更）は開いている扇を必ず閉じ、
            // 開きかけの処理も無効にする。
            await spiderfy.invalidateAndCollapse(renderer);

            const covered = this.renderState.coverageBounds != null &&
                geometry.containsBounds(this.renderState.coverageBounds, expandedBounds);
            if (!forced && !zoomChanged && covered && stableSource) {
                this.renderState.renderCameraPosition = cameraPosition;
                return;
            }

            await markerRenderer.cleanupStaleMarkers(
                zoom,
                renderer,
                animateTransitions,
                (id) => this.sourceStates.has(id),
            );

            // クラスタ ID にはズームが埋まっているので、ズームが変われば前回の
            // 割り当ては使えない。計画が途中で打ち切られてもここで捨ててある。
            if (zoomChanged) {
                this.renderState.assignments = new Map();
            }

            const plan = planner.plan({
                sourceStates: this.sourceStates.values(),
                expandedBounds,
                zoom,
                effectiveRadiusPx: builder.effectiveClusterRadiusPx(zoom),
                zoomChanged,
                minClusterSize: this.minClusterSize,
                cache: this.renderState.toPlanCache(),
            });

            const debugInfos: MarkerClusterDebugInfo[] = [];
            const desiredMarkerStates: MarkerState[] = [];
            for (const entry of plan.entries) {
                if (entry.kind === 'singles') {
                    desiredMarkerStates.push(...entry.states);
                    continue;
                }
                debugInfos.push(this.toDebugInfo(entry.cluster));
                desiredMarkerStates.push(this.toClusterMarkerState(entry.cluster, turn));
            }

            if (!scheduler.isCurrent(token)) return;
            this._debugInfoFlow.value = debugInfos;

            if (!(await this.awaitPrepareExpand(desiredMarkerStates, token))) return;

            const previousClusterMemberCenters = this.renderState.clusterMemberCenters;
            // 凸包ポリゴンの更新をアニメーション開始前に確定させる
            // （ポリゴンの描画とマーカーのアニメーションを競合させないため）。
            await this.onBeforeAnimation?.(debugInfos);
            await markerRenderer.updateRenderedMarkers({
                desiredStates: desiredMarkerStates,
                renderer,
                token,
                animateTransitions,
                previousClusterMemberCenters,
                nextClusterMemberCenters: plan.clusterMemberCenters,
            });

            this.renderState.commit(plan, cameraPosition, sourceStateVersionSnapshot);
        });
    }

    /**
     * 新しく現れる個別マーカーの準備をアプリ側に任せ、終わるまで待つ。
     *
     * @returns 反映を続けてよいとき true。待っている間に新しいカメラ更新に
     *   追い越されたら false。
     */
    private async awaitPrepareExpand(desiredStates: MarkerState[], token: number): Promise<boolean> {
        if (!this.prepareExpand) return true;
        const appearing = desiredStates.filter(
            (state) => !state.id.startsWith(CLUSTER_ID_PREFIX) && !this.renderedMarkerEntities.has(state.id),
        );
        if (appearing.length === 0) return true;
        // A failed prepare must not block rendering.
        await this.prepareExpand(appearing).catch(() => undefined);
        return this.components.scheduler.isCurrent(token);
    }

    private toClusterMarkerState(cluster: PlannedCluster, turn: number): MarkerState {
        const markerCluster: MarkerCluster = {
            count: cluster.members.length,
            markerIds: cluster.members.map((member) => member.id),
        };
        const clusterIcon =
            this.clusterIconProviderWithTurn?.(cluster.members.length, turn) ??
            this.clusterIconProvider(cluster.members.length);
        // クラスタのクリックは、条件を満たせばまず spiderfy が受け取り、
        // 受け取らなかったときだけ onClusterClick へ落ちる。
        const clickable = this.onClusterClick != null || this.components.spiderfy.isEnabled;
        return createMarkerState({
            id: cluster.id,
            position: cluster.center,
            extra: markerCluster as unknown as Serializable,
            icon: clusterIcon,
            clickable,
            draggable: false,
            onClick: clickable
                ? () => {
                    if (!this.components.spiderfy.tryToggle(markerCluster)) {
                        this.onClusterClick?.(markerCluster);
                    }
                }
                : null,
        });
    }

    private toDebugInfo(cluster: PlannedCluster): MarkerClusterDebugInfo {
        return {
            id: cluster.id,
            center: cluster.center,
            radiusMeters: cluster.radiusMeters,
            count: cluster.members.length,
            cellX: cluster.cell.x,
            cellY: cluster.cell.y,
            hullPoints: cluster.hullPoints,
        };
    }
}
