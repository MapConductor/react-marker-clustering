import type { GeoPoint, GeoRectBounds, MapCameraPosition } from '@mapconductor/js-sdk-core';
import type { ClusterPlan, ClusterPlanCache } from './ClusterPlanner';

const ZOOM_KEY_SCALE = 100;

export interface ZoomChange {
    turn: number;
    zoomChanged: boolean;
}

/**
 * 前回の再クラスタの結果。次回に再利用するためだけに持つ。
 *
 * ここが空だと毎回ゼロから計算することになり、動作は正しいがパンのたびに
 * クラスタ中心が動いてちらつく。`ClusterPlanner` がこれを見て
 * 「動いていないマーカーは前のクラスタに置いたまま」にする。
 *
 * android-sdk の `ClusterRenderState.kt` /
 * ios-sdk の `MarkerClusterStrategy+Clustering.swift` の `RenderStateSnapshot` に対応。
 */
export class ClusterRenderState {
    clusterMemberCenters: ReadonlyMap<string, GeoPoint> = new Map();
    clusterPositions: ReadonlyMap<string, GeoPoint> = new Map();
    assignments: ReadonlyMap<string, string> = new Map();
    coverageBounds: GeoRectBounds | null = null;
    sourceStateVersion = 0;
    sourceFingerprints: ReadonlyMap<string, string> = new Map();
    renderCameraPosition: MapCameraPosition | null = null;

    private lastZoomKey: number | null = null;
    private clusteringTurn = 0;

    /**
     * ズームが変わったかを見て、変わっていれば周回数を進める。
     *
     * 周回数はアイコン提供側（`clusterIconProviderWithTurn`）へ渡り、
     * 「ズームするたびに色を変える」といった表現に使われる。
     * 小数第 2 位まででズームを丸めるので、わずかな揺れでは進まない。
     */
    updateClusteringTurn(zoom: number): ZoomChange {
        const zoomKey = Math.round(zoom * ZOOM_KEY_SCALE);
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

    /** `ClusterPlanner` に渡す形で取り出す。 */
    toPlanCache(): ClusterPlanCache {
        return {
            assignments: this.assignments,
            clusterPositions: this.clusterPositions,
            coverageBounds: this.coverageBounds,
            sourceFingerprints: this.sourceFingerprints,
        };
    }

    /** 計画の結果を次回のキャッシュとして取り込む。 */
    commit(plan: ClusterPlan, cameraPosition: MapCameraPosition, sourceStateVersion: number): void {
        this.clusterMemberCenters = plan.clusterMemberCenters;
        this.clusterPositions = plan.clusterPositions;
        this.assignments = plan.assignments;
        this.coverageBounds = plan.coverageBounds.isEmpty ? null : plan.coverageBounds;
        this.sourceFingerprints = plan.sourceFingerprints;
        this.renderCameraPosition = cameraPosition;
        this.sourceStateVersion = sourceStateVersion;
    }

    reset(): void {
        this.clusterMemberCenters = new Map();
        this.clusterPositions = new Map();
        this.assignments = new Map();
        this.coverageBounds = null;
        this.sourceStateVersion = 0;
        this.sourceFingerprints = new Map();
        this.renderCameraPosition = null;
        this.lastZoomKey = null;
        this.clusteringTurn = 0;
    }
}
