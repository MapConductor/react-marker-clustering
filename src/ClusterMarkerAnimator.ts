import {
    createMarkerEntity,
    type BitmapIcon,
    type ChangeParams,
    type GeoPoint,
    type MarkerEntity,
    type MarkerManager,
    type MarkerOverlayRenderer,
    type MarkerState,
} from '@mapconductor/js-sdk-core';
import type { ClusterGeometry } from './ClusterGeometry';

const ANIMATION_FRAME_MILLIS_60_FPS = 16;
const ANIMATION_FRAME_MILLIS_30_FPS = 33;
const ANIMATION_FRAME_MILLIS_8_FPS = 125;
const ANIMATION_FRAME_MILLIS_4_FPS = 250;

function delay(millis: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

/** アニメーションで動かす 1 件分。`entity` は 1 フレームごとに差し替わる。 */
export interface AnimatedMove {
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
export class ClusterMarkerAnimator {
    constructor(
        private readonly geometry: ClusterGeometry,
        private readonly markerManager: MarkerManager<MarkerState>,
        private readonly renderedMarkerEntities: Map<string, MarkerEntity<MarkerState>>,
        private readonly defaultMarkerIcon: BitmapIcon,
        /** 呼び出し時のトークンがまだ最新か。古くなったらアニメーションを打ち切る。 */
        private readonly isCurrent: (token: number) => boolean,
    ) {}

    /**
     * @returns 最後まで再生できたとき true。新しいカメラ更新に追い越されて
     *   途中で止めたときは false（呼び出し側が後始末する）。
     */
    async animate(
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
            if (!this.isCurrent(token)) return false;
            const t = step / steps;

            const changeParams: ChangeParams<MarkerState>[] = moves.map((move) => {
                // 最後のフレームでは補間位置が目的地と一致するので、出てくる
                // マーカーは複製ではなくアプリ所有のインスタンスを返せる。
                const nextState = step === steps && move.restoreBaseStateAtEnd
                    ? move.baseState
                    : move.baseState.copy({ position: this.geometry.interpolatePosition(move.start, move.end, t) });
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

    private animationFrameMillis(moveCount: number): number {
        if (moveCount < 50) return ANIMATION_FRAME_MILLIS_60_FPS;
        if (moveCount < 100) return ANIMATION_FRAME_MILLIS_30_FPS;
        if (moveCount < 300) return ANIMATION_FRAME_MILLIS_8_FPS;
        return ANIMATION_FRAME_MILLIS_4_FPS;
    }
}
