import type { Offset } from '@mapconductor/js-sdk-core';

const MAX_ITERATIONS = 150;
const CONVERGENCE_THRESHOLD = 0.15;
const CENTER_CLEARANCE_RATIO = 1.3;
const CENTER_SPRING = 0.15;
const STEP_RATIO = 0.6;
const MIN_DISTANCE = 0.01;

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
export class SpiderfyLayout {
    /**
     * @param count 開くメンバー数
     * @param markerSizePx マーカーの直径
     * @param marginPx マーカー間に空ける余白
     * @param obstacles 既に描かれているマーカーのクラスタ中心からの相対座標
     * @returns クラスタ中心からの相対オフセット（`count` 件）
     */
    compute(count: number, markerSizePx: number, marginPx: number, obstacles: Offset[]): Offset[] {
        const desired = markerSizePx + marginPx;
        // クラスタ中心からの基準距離。脚が見える程度に離し、広がりすぎない程度に近く。
        const centerClearance = Math.round(markerSizePx * CENTER_CLEARANCE_RATIO) + marginPx;
        const xs = new Float64Array(count);
        const ys = new Float64Array(count);
        for (let i = 0; i < count; i++) {
            // 0 度（右）から等間隔に置く。2 件のときに左右へ並ぶので、
            // ピン型クラスタアイコンの頭を避けられる。
            const angle = (2.0 * Math.PI * i) / count;
            xs[i] = Math.cos(angle) * centerClearance;
            ys[i] = Math.sin(angle) * centerClearance;
        }
        for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
            let maxMove = 0.0;
            for (let i = 0; i < count; i++) {
                let fx = 0.0;
                let fy = 0.0;
                // 開いたメンバーどうしの反発。
                for (let j = 0; j < count; j++) {
                    if (i === j) continue;
                    const dx = xs[i] - xs[j];
                    const dy = ys[i] - ys[j];
                    const d = Math.hypot(dx, dy) || MIN_DISTANCE;
                    if (d < desired) {
                        const push = (desired - d) / 2.0;
                        fx += (dx / d) * push;
                        fy += (dy / d) * push;
                    }
                }
                // 既に描かれている近くのマーカー（固定の障害物）からの反発。
                for (const obstacle of obstacles) {
                    const dx = xs[i] - obstacle.x;
                    const dy = ys[i] - obstacle.y;
                    const d = Math.hypot(dx, dy) || MIN_DISTANCE;
                    if (d < desired) {
                        const push = desired - d;
                        fx += (dx / d) * push;
                        fy += (dy / d) * push;
                    }
                }
                const dc = Math.hypot(xs[i], ys[i]) || MIN_DISTANCE;
                if (dc < centerClearance) {
                    // クラスタマーカー自身からの反発。
                    const push = centerClearance - dc;
                    fx += (xs[i] / dc) * push;
                    fy += (ys[i] / dc) * push;
                } else {
                    // 中心へ向かう弱いばね（離れすぎを防ぐ）。
                    const pull = (dc - centerClearance) * CENTER_SPRING;
                    fx -= (xs[i] / dc) * pull;
                    fy -= (ys[i] / dc) * pull;
                }
                xs[i] += fx * STEP_RATIO;
                ys[i] += fy * STEP_RATIO;
                maxMove = Math.max(maxMove, Math.abs(fx), Math.abs(fy));
            }
            if (maxMove < CONVERGENCE_THRESHOLD) break;
        }
        return Array.from({ length: count }, (_, i) => ({ x: xs[i], y: ys[i] }));
    }
}
