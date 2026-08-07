import {
    createGeoPoint,
    Spherical,
    type GeoPoint,
    type GeoPointInterface,
    type MarkerState,
} from '@mapconductor/js-sdk-core';
import type { ClusterGeometry } from './ClusterGeometry';

const MAX_DENSE_CELLS = 4;
const MAX_DENSE_CANDIDATES = 50;
const RADIUS_REFERENCE_ZOOM = 10.0;
const RADIUS_MIN_SCALE = 0.35;
const RADIUS_MIN_PX = 18.0;

/** クラスタマーカーの ID 接頭辞。個別マーカーとの区別に使う。 */
export const CLUSTER_ID_PREFIX = 'cluster_';

/** クラスタリング格子のセル座標。 */
export interface ClusterCell {
    x: number;
    y: number;
}

/** 格子セル 1 つ分のまとまり。`mergeClusters` の入力。 */
export interface ClusterCandidate {
    cell: ClusterCell;
    center: GeoPoint;
    members: MarkerState[];
}

/** 近傍セルを吸収したあとのまとまり。`mergeClusters` の出力。 */
export interface MergedCluster {
    center: GeoPoint;
    members: MarkerState[];
}

interface PixelPoint {
    member: MarkerState;
    x: number;
    y: number;
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
export class ClusterBuilder {
    constructor(
        private readonly geometry: ClusterGeometry,
        private readonly clusterRadiusPx: number,
    ) {}

    /**
     * ズームに応じて実効クラスタ半径を縮める。
     *
     * 低ズームでは画面上の固定半径が数百 km に相当してしまい、まとめすぎに見える。
     */
    effectiveClusterRadiusPx(zoom: number): number {
        const scale = Math.max(RADIUS_MIN_SCALE, Math.min(1.0, zoom / RADIUS_REFERENCE_ZOOM));
        return Math.max(RADIUS_MIN_PX, this.clusterRadiusPx * scale);
    }

    buildClusterId(cell: ClusterCell, zoom: number): string {
        return `${CLUSTER_ID_PREFIX}${Math.round(zoom)}_${cell.x}_${cell.y}`;
    }

    /** マーカー 1 件が属する格子セルを返す。 */
    cellOf(position: GeoPointInterface, zoom: number, effectiveRadiusPx: number): ClusterCell {
        const [x, y] = this.geometry.projectToPixel(position, zoom);
        return {
            x: Math.floor(x / effectiveRadiusPx),
            y: Math.floor(y / effectiveRadiusPx),
        };
    }

    /**
     * 近い候補どうしをまとめる。
     *
     * 連鎖的な併合（A-B が近く B-C が近いだけで A-C まで 1 つになる）を避けるため、
     * 種となる候補の半径に入るものだけを貪欲に吸収する。
     */
    mergeClusters(candidates: ClusterCandidate[], zoom: number, clusterRadiusPx: number): MergedCluster[] {
        if (candidates.length === 0) return [];

        const indexByCell = new Map<string, number>();
        candidates.forEach((candidate, index) => indexByCell.set(`${candidate.cell.x},${candidate.cell.y}`, index));

        const visited = new Uint8Array(candidates.length);
        const result: MergedCluster[] = [];

        for (let i = 0; i < candidates.length; i++) {
            if (visited[i]) continue;
            visited[i] = 1;

            const seed = candidates[i];
            const seedMpp = this.geometry.metersPerPixel(seed.center, zoom);
            const members: MarkerState[] = seed.members.slice();

            // 候補は clusterRadiusPx 幅の格子に入れてあるので、併合距離に入るものは
            // 必ず同じセルか 8 近傍のどれかにいる。
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const neighborIndex = indexByCell.get(`${seed.cell.x + dx},${seed.cell.y + dy}`);
                    if (neighborIndex === undefined || visited[neighborIndex]) continue;

                    const neighbor = candidates[neighborIndex];
                    const neighborMpp = this.geometry.metersPerPixel(neighbor.center, zoom);
                    const threshold = clusterRadiusPx * Math.max(seedMpp, neighborMpp);
                    if (Spherical.computeDistanceBetween(seed.center, neighbor.center) <= threshold) {
                        visited[neighborIndex] = 1;
                        members.push(...neighbor.members);
                    }
                }
            }

            result.push({ center: this.selectDenseCenter(members, zoom, clusterRadiusPx), members });
        }

        return result;
    }

    /**
     * まとまりの中で最も密なところにいるメンバーの位置を返す。
     *
     * 単純な平均だと、外れ値ひとつでクラスタの見かけ上の中心が誰もいない場所へ動く。
     * 格子で粗く数えてから上位セルの中だけを総当たりするので、メンバー数に対して線形。
     */
    selectDenseCenter(members: MarkerState[], zoom: number, clusterRadiusPx: number): GeoPoint {
        if (members.length === 0) return createGeoPoint({ latitude: 0, longitude: 0 });
        if (members.length === 1) {
            return createGeoPoint({
                latitude: members[0].position.latitude,
                longitude: members[0].position.longitude,
            });
        }

        const points: PixelPoint[] = members.map((member) => {
            const [x, y] = this.geometry.projectToPixel(member.position, zoom);
            return { member, x, y };
        });

        const cellSize = clusterRadiusPx;
        const cellMap = new Map<string, PixelPoint[]>();
        for (const point of points) {
            const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)}`;
            const bucket = cellMap.get(key);
            if (bucket) bucket.push(point);
            else cellMap.set(key, [point]);
        }

        const candidatePoints = [...cellMap.values()]
            .sort((a, b) => b.length - a.length)
            .slice(0, MAX_DENSE_CELLS)
            .flat()
            .slice(0, MAX_DENSE_CANDIDATES);

        const radiusSq = cellSize * cellSize;
        let best = candidatePoints[0] ?? points[0];
        let bestNeighborCount = -1;
        let bestTotalDistance = Number.MAX_VALUE;

        for (const candidate of candidatePoints) {
            let neighborCount = 0;
            let totalDistance = 0;

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const key = `${Math.floor(candidate.x / cellSize) + dx},${Math.floor(candidate.y / cellSize) + dy}`;
                    const neighbors = cellMap.get(key);
                    if (!neighbors) continue;
                    for (const other of neighbors) {
                        const dxp = candidate.x - other.x;
                        const dyp = candidate.y - other.y;
                        const distSq = dxp * dxp + dyp * dyp;
                        if (distSq <= radiusSq) {
                            neighborCount++;
                            totalDistance += Math.sqrt(distSq);
                        }
                    }
                }
            }

            if (
                neighborCount > bestNeighborCount ||
                (neighborCount === bestNeighborCount && totalDistance < bestTotalDistance)
            ) {
                bestNeighborCount = neighborCount;
                bestTotalDistance = totalDistance;
                best = candidate;
            }
        }

        return createGeoPoint({
            latitude: best.member.position.latitude,
            longitude: best.member.position.longitude,
        });
    }
}
