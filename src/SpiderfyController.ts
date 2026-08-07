import {
    createGeoPoint,
    createMarkerEntity,
    Mutex,
    type AddParams,
    type BitmapIcon,
    type GeoPoint,
    type MapCameraPosition,
    type MarkerEntity,
    type MarkerManager,
    type MarkerOverlayRenderer,
    type MarkerState,
    type Offset,
} from '@mapconductor/js-sdk-core';
import type { ClusterGeometry } from './ClusterGeometry';
import type { MarkerCluster, SpiderfyLeg } from './MarkerCluster';
import type { SpiderfyLayout } from './SpiderfyLayout';
import { MutableStateFlow, type StateFlow } from './StateFlow';

const CLONE_ID_PREFIX = 'spider_';
const LEG_ID_PREFIX = 'spiderleg_';
const CLONE_Z_INDEX = 2000;
const SELF_DISTANCE_PX = 2.0;
const OBSTACLE_MAX_DISTANCE_PX = 300.0;

export interface SpiderfyControllerOptions {
    geometry: ClusterGeometry;
    layout: SpiderfyLayout;
    markerManager: MarkerManager<MarkerState>;
    renderedMarkerEntities: Map<string, MarkerEntity<MarkerState>>;
    defaultMarkerIcon: BitmapIcon;
    /** これ以上のズームでのみ有効。null なら機能そのものを使わない。 */
    minZoom: number | null;
    markerSizePx: number;
    markerMarginPx: number;
    /** 開く前に呼ばれ、これが返るまで描画を待つ（アイコンの先読み用）。 */
    prepareExpand: ((appearing: MarkerState[]) => Promise<void>) | null;
    /** 開いた(true)／閉じた(false)を知らせる。 */
    onChange: ((open: boolean) => void) | null;
    cameraProvider: () => MapCameraPosition | null;
    rendererProvider: () => MarkerOverlayRenderer<MarkerState> | null;
    sourceStateProvider: (id: string) => MarkerState | undefined;
}

/**
 * クラスタをクリックしたときに、メンバーを扇状に開く機能（spiderfy）。
 *
 * 同じ場所に複数のマーカーがあると、いくらズームしても分離できない。
 * そこで `minZoom` 以上でクラスタをクリックしたら、メンバーの複製を
 * 画面上で開いて脚のポリラインでつなぐ。もう一度クリックするか、
 * 再クラスタ（カメラ移動・データ変更）が起きると閉じる。
 *
 * **複製で描く**のが要点。元のマーカーを動かすと、閉じたときに位置を戻す責任が
 * 発生し、途中で再クラスタが挟まると戻し損ねる。`spider_` 接頭辞の別マーカーを
 * 出し入れするだけなら、閉じる処理は「消す」だけで済む。
 *
 * android-sdk の `SpiderfyController.kt` /
 * ios-sdk の `MarkerClusterStrategy+Spiderfy.swift` と同じ状態遷移。
 */
export class SpiderfyController {
    private readonly _legsFlow = new MutableStateFlow<SpiderfyLeg[]>([]);
    private readonly mutex = new Mutex();
    private token = 0;
    private openClusterKey: string | null = null;
    private entities: MarkerEntity<MarkerState>[] = [];

    constructor(private readonly options: SpiderfyControllerOptions) {}

    /** 開いている扇の脚。閉じているときは空。`MarkerClusterGroup` がこれを描く。 */
    get legsFlow(): StateFlow<SpiderfyLeg[]> {
        return this._legsFlow;
    }

    /** 設定として spiderfy が有効か（ズーム条件は見ない）。 */
    get isEnabled(): boolean {
        return this.options.minZoom != null;
    }

    /**
     * クラスタマーカーのクリックを処理する。
     *
     * @returns spiderfy が受け取ったとき true。false なら呼び出し側の
     *   `onClusterClick` へ落とす。判定だけ同期で行い、描画は非同期に進む。
     */
    tryToggle(cluster: MarkerCluster): boolean {
        const { minZoom, cameraProvider, rendererProvider, sourceStateProvider } = this.options;
        if (minZoom == null) return false;
        const camera = cameraProvider();
        if (!camera || camera.zoom < minZoom) return false;
        const renderer = rendererProvider();
        const holder = renderer?.holder;
        if (!renderer || !holder) return false;

        const clusterKey = [...cluster.markerIds].sort().join(',');
        if (this.openClusterKey === clusterKey) {
            // 開いているクラスタをもう一度クリックしたら閉じる。
            this.token++;
            void this.mutex.withLock(() => this.collapseLocked(renderer));
            return true;
        }

        const members = cluster.markerIds
            .map((id) => sourceStateProvider(id))
            .filter((state): state is MarkerState => state != null);
        if (members.length === 0) return false;

        // 実際に描かれているクラスタマーカーの位置を中心にする（メンバー平均とは
        // ずれることがあり、ずれたままだと脚がマーカーの根元に集まらない）。
        let centerGeo = this.options.geometry.averagePosition(members);
        for (const entity of this.options.renderedMarkerEntities.values()) {
            if (entity.state.extra !== (cluster as unknown)) continue;
            centerGeo = createGeoPoint({
                latitude: entity.state.position.latitude,
                longitude: entity.state.position.longitude,
            });
            break;
        }
        const centerPx = this.resolveScreenOffset(holder.toScreenOffset(centerGeo));
        if (!centerPx) return false;

        const offsets = this.options.layout.compute(
            members.length,
            this.options.markerSizePx,
            this.options.markerMarginPx,
            this.collectObstacles(renderer, centerPx),
        );
        const token = ++this.token;
        void (async () => {
            await this.mutex.withLock(() => this.collapseLocked(renderer));
            if (token !== this.token) return;
            await this.open({ clusterKey, members, centerGeo, centerPx, offsets, renderer, token });
        })();
        return true;
    }

    /**
     * 扇の周りに既に描かれているマーカーを、動かせない障害物として集める。
     *
     * クリックしたクラスタ自身は除く。代わりに、ピン型アイコンの頭に相当する
     * 疑似障害物を中心の真上に置く。
     */
    private collectObstacles(renderer: MarkerOverlayRenderer<MarkerState>, centerPx: Offset): Offset[] {
        const holder = renderer.holder;
        const obstacles: Offset[] = [];
        if (!holder) return obstacles;
        for (const entity of this.options.renderedMarkerEntities.values()) {
            const px = this.resolveScreenOffset(holder.toScreenOffset(entity.state.position));
            if (!px) continue;
            const relX = px.x - centerPx.x;
            const relY = px.y - centerPx.y;
            const distance = Math.hypot(relX, relY);
            // クリックしたクラスタ自身と、遠すぎるものを無視する。
            if (distance < SELF_DISTANCE_PX || distance > OBSTACLE_MAX_DISTANCE_PX) continue;
            obstacles.push({ x: relX, y: relY });
        }
        obstacles.push({ x: 0, y: -Math.round(this.options.markerSizePx / 2.0) });
        return obstacles;
    }

    private async open(params: {
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
            clones.push(member.copy({ id: `${CLONE_ID_PREFIX}${member.id}`, position: geo, zIndex: CLONE_Z_INDEX }));
            legs.push({ id: `${LEG_ID_PREFIX}${member.id}`, start: centerGeo, end: geo });
        });
        if (clones.length === 0) return;

        // アプリ側が開くマーカーの準備（アイコンの先読みなど）を終えるまで、
        // クラスタの表示は変えない。新しい操作や再クラスタが来たら
        // 下のトークン確認で捨てられる。
        if (this.options.prepareExpand) {
            // A failed prepare must not block rendering.
            await this.options.prepareExpand(clones).catch(() => undefined);
        }

        await this.mutex.withLock(async () => {
            if (token !== this.token) return;
            const addParams: AddParams[] = clones.map((state) => ({
                state,
                bitmapIcon: state.icon?.toBitmapIcon() ?? this.options.defaultMarkerIcon,
            }));
            const actualMarkers = await renderer.onAdd(addParams);
            actualMarkers.forEach((actual, index) => {
                if (actual == null) return;
                const entity = createMarkerEntity<MarkerState>({
                    marker: actual,
                    state: addParams[index].state,
                    isRendered: true,
                });
                this.options.markerManager.registerEntity(entity);
                this.entities.push(entity);
            });
            await renderer.onPostProcess();
            this._legsFlow.value = legs;
            this.openClusterKey = clusterKey;
            this.options.onChange?.(true);
        });
    }

    /**
     * 開いている扇を閉じ、進行中の開く処理を無効にする。
     *
     * 再クラスタのたびに `MarkerClusterStrategy` が呼ぶ。
     */
    async invalidateAndCollapse(renderer: MarkerOverlayRenderer<MarkerState>): Promise<void> {
        this.token++;
        await this.mutex.withLock(() => this.collapseLocked(renderer));
    }

    /** `mutex` を保持した状態で呼ぶこと。 */
    private async collapseLocked(renderer: MarkerOverlayRenderer<MarkerState>): Promise<void> {
        if (this.openClusterKey == null && this.entities.length === 0) return;
        this.openClusterKey = null;
        this._legsFlow.value = [];
        if (this.entities.length > 0) {
            const entities = this.entities;
            this.entities = [];
            await renderer.onRemove(entities);
            for (const entity of entities) this.options.markerManager.removeEntity(entity.state.id);
            await renderer.onPostProcess();
        }
        this.options.onChange?.(false);
    }

    /**
     * 描画に触れずに状態だけ捨てる。
     *
     * `MarkerClusterStrategy.clear()` から呼ばれる。あちらは `markerManager` ごと
     * 空にするので、ここでレンダラへ削除を投げる必要はない。
     */
    reset(): void {
        this.token++;
        this.openClusterKey = null;
        this.entities = [];
        this._legsFlow.value = [];
    }

    /**
     * `toScreenOffset()` は holder によっては非同期に解決する。spiderfy は
     * 同期の答えが要るので、Promise が返ってきたら「取れなかった」とみなす。
     */
    private resolveScreenOffset(result: Offset | null | Promise<Offset | null>): Offset | null {
        if (result != null && typeof (result as Promise<Offset | null>).then === 'function') return null;
        return result as Offset | null;
    }
}
