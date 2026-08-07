import type {
    GeoRectBounds,
    MapCameraPosition,
    MarkerOverlayRenderer,
    MarkerState,
} from '@mapconductor/js-sdk-core';
import type { ClusterGeometry } from './ClusterGeometry';

export interface RenderRequest {
    cameraPosition: MapCameraPosition;
    viewport: GeoRectBounds;
    renderer: MarkerOverlayRenderer<MarkerState>;
    token: number;
}

/**
 * 「いつ再クラスタするか」だけを持つ部分。何をどう描くかは知らない。
 *
 * カメラは 1 回の操作で何十回もイベントを出すので、そのたびに数千件の
 * クラスタリングを走らせるわけにいかない。2 段構えで抑えている:
 *
 * 1. **デバウンス** — 最後のカメライベントから `debounceMillis` 静まるまで待つ。
 * 2. **1 件だけの保留** — 待っている間に新しい要求が来たら古い方を捨てる。
 *    途中の状態を描いても一瞬で上書きされるだけなので、最新だけ処理すれば足りる。
 *
 * 発行したトークンより新しいものが出ていれば、途中の処理はいつでも打ち切ってよい
 * （`isCurrent` を各所で確認している）。
 *
 * android-sdk の `ClusterRenderScheduler.kt` /
 * ios-sdk の `MarkerClusterStrategy+Scheduling.swift` と同じ throttle 方針。
 */
export class ClusterRenderScheduler {
    private updateToken = 0;
    private pendingRequest: RenderRequest | null = null;
    private workerActive = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    lastCameraPosition: MapCameraPosition | null = null;
    lastRenderer: MarkerOverlayRenderer<MarkerState> | null = null;
    lastKnownViewport: GeoRectBounds | null = null;
    private lastKnownViewportZoom: number | null = null;

    /** 直近に実際に使ったビューポート。カメラ更新が来ていないときの再描画に使う。 */
    lastUsedViewport: GeoRectBounds | null = null;

    constructor(
        private readonly geometry: ClusterGeometry,
        private readonly debounceMillis: number,
        /** 実際のクラスタリングと描画。この中で `isCurrent` を見て打ち切ってよい。 */
        private readonly onRender: (request: RenderRequest) => Promise<void>,
    ) {}

    get currentToken(): number {
        return this.updateToken;
    }

    nextToken(): number {
        return ++this.updateToken;
    }

    isCurrent(token: number): boolean {
        return token === this.updateToken;
    }

    onCameraChanged(cameraPosition: MapCameraPosition, renderer: MarkerOverlayRenderer<MarkerState>): void {
        this.lastCameraPosition = cameraPosition;
        const bounds = cameraPosition.visibleRegion?.bounds;
        if (bounds && !bounds.isEmpty) {
            this.lastKnownViewport = bounds;
            this.lastKnownViewportZoom = cameraPosition.zoom;
        }
        this.lastRenderer = renderer;
        const token = ++this.updateToken;
        // 保留中のタイマーはもう古いトークンでしか発火しないので、捨ててよい。
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (token !== this.updateToken) return;
            const currentCamera = this.lastCameraPosition;
            if (!currentCamera) return;
            // visibleRegion が取れないプロバイダ（ArcGIS のアニメーション中など）
            // では直前のビューポートから推定する。
            const currentViewport =
                (currentCamera.visibleRegion?.bounds && !currentCamera.visibleRegion.bounds.isEmpty
                    ? currentCamera.visibleRegion.bounds
                    : null) ?? this.geometry.estimateViewport(
                        currentCamera.zoom,
                        currentCamera.position,
                        this.lastKnownViewport,
                        this.lastKnownViewportZoom,
                    );
            if (!currentViewport) return;
            const currentRenderer = this.lastRenderer;
            if (!currentRenderer) return;
            this.enqueue(currentCamera, currentViewport, currentRenderer, token);
        }, Math.max(0, this.debounceMillis));
    }

    enqueue(
        cameraPosition: MapCameraPosition,
        viewport: GeoRectBounds,
        renderer: MarkerOverlayRenderer<MarkerState>,
        token: number,
    ): void {
        this.pendingRequest = { cameraPosition, viewport, renderer, token };
        if (this.workerActive) return;
        this.workerActive = true;
        void this.runWorker();
    }

    private async runWorker(): Promise<void> {
        try {
            while (this.pendingRequest) {
                const request = this.pendingRequest;
                this.pendingRequest = null;
                try {
                    await this.onRender(request);
                } catch (error) {
                    console.warn('[MapConductor] marker clustering render failed', error);
                }
            }
        } finally {
            this.workerActive = false;
        }
    }

    /** カメラの記憶と保留中の要求を捨てる。 */
    reset(): void {
        this.lastCameraPosition = null;
        this.lastKnownViewport = null;
        this.lastKnownViewportZoom = null;
        this.lastUsedViewport = null;
        if (this.debounceTimer !== null) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingRequest = null;
    }
}
