import {
    createGeoPoint,
    createGeoRectBounds,
    Spherical,
    type GeoPoint,
    type GeoRectBounds,
    type MarkerState,
} from '@mapconductor/js-sdk-core';
import {
    CLUSTER_ID_PREFIX,
    type ClusterBuilder,
    type ClusterCandidate,
    type ClusterCell,
    type MergedCluster,
} from './ClusterBuilder';
import type { ClusterGeometry } from './ClusterGeometry';

/** 1 つのクラスタとして描くと決まったまとまり。 */
export interface PlannedCluster {
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
export type PlannedEntry =
    | { kind: 'cluster'; cluster: PlannedCluster }
    | { kind: 'singles'; states: MarkerState[] };

/** `ClusterPlanner.plan` の結果一式。 */
export interface ClusterPlan {
    entries: PlannedEntry[];
    clusterMemberCenters: Map<string, GeoPoint>;
    clusterPositions: Map<string, GeoPoint>;
    assignments: Map<string, string>;
    coverageBounds: GeoRectBounds;
    sourceFingerprints: Map<string, string>;
}

/** 前回の描画結果のうち、今回の計算で再利用するもの。 */
export interface ClusterPlanCache {
    assignments: ReadonlyMap<string, string>;
    clusterPositions: ReadonlyMap<string, GeoPoint>;
    coverageBounds: GeoRectBounds | null;
    sourceFingerprints: ReadonlyMap<string, string>;
}

export interface ClusterPlanInput {
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
export class ClusterPlanner {
    constructor(
        private readonly geometry: ClusterGeometry,
        private readonly builder: ClusterBuilder,
    ) {}

    plan(input: ClusterPlanInput): ClusterPlan {
        const { sourceStates, expandedBounds, zoom, effectiveRadiusPx, zoomChanged, cache } = input;
        const sourceFingerprints = new Map<string, string>();
        const cachedMarkers: MarkerState[] = [];
        const newMarkers: MarkerState[] = [];

        for (const state of sourceStates) {
            if (!this.geometry.containsInViewport(expandedBounds, state.position, zoom)) continue;

            const fingerPrint = this.geometry.positionFingerPrint(state.position);
            sourceFingerprints.set(state.id, fingerPrint);
            const movedSinceLastRender = (cache.sourceFingerprints.get(state.id) ?? '\0') !== fingerPrint;

            if (
                !zoomChanged &&
                this.geometry.containsInViewport(cache.coverageBounds, state.position, zoom) &&
                cache.assignments.has(state.id) &&
                !movedSinceLastRender
            ) {
                cachedMarkers.push(state);
            } else {
                newMarkers.push(state);
            }
        }

        const { cachedClusterGroups, cachedMarkerGroups } = this.groupCachedMarkers(cachedMarkers, cache);
        const candidates = this.bucketNewMarkers(newMarkers, zoom, effectiveRadiusPx);
        const mergedClusters = this.builder.mergeClusters(candidates, zoom, effectiveRadiusPx);

        const finalMergedClusters = this.absorbCachedClusters({
            mergedClusters,
            cachedClusterGroups,
            cachedMarkerGroups,
            cachedClusterPositions: cache.clusterPositions,
            zoom,
            effectiveRadiusPx,
        });

        return this.buildPlan({
            finalMergedClusters,
            zoom,
            effectiveRadiusPx,
            minClusterSize: input.minClusterSize,
            sourceFingerprints,
        });
    }

    /** 前回の割り当てから、クラスタ単位／素通し単位のまとまりを組み直す。 */
    private groupCachedMarkers(
        cachedMarkers: MarkerState[],
        cache: ClusterPlanCache,
    ): { cachedClusterGroups: Map<string, MarkerState[]>; cachedMarkerGroups: Map<string, MarkerState[]> } {
        const cachedClusterGroups = new Map<string, MarkerState[]>();
        const cachedMarkerGroups = new Map<string, MarkerState[]>();
        for (const marker of cachedMarkers) {
            const clusterId = cache.assignments.get(marker.id);
            if (clusterId && clusterId.startsWith(CLUSTER_ID_PREFIX)) {
                const group = cachedClusterGroups.get(clusterId);
                if (group) group.push(marker);
                else cachedClusterGroups.set(clusterId, [marker]);
            } else {
                const key = clusterId ?? marker.id;
                const group = cachedMarkerGroups.get(key);
                if (group) group.push(marker);
                else cachedMarkerGroups.set(key, [marker]);
            }
        }
        return { cachedClusterGroups, cachedMarkerGroups };
    }

    /** 新しいマーカーを格子セルへ入れ、セル座標順に並べた候補にする。 */
    private bucketNewMarkers(
        newMarkers: MarkerState[],
        zoom: number,
        effectiveRadiusPx: number,
    ): ClusterCandidate[] {
        const clustered = new Map<string, { cell: ClusterCell; members: MarkerState[] }>();
        for (const state of newMarkers) {
            const cell = this.builder.cellOf(state.position, zoom, effectiveRadiusPx);
            const key = `${cell.x},${cell.y}`;
            const entry = clustered.get(key);
            if (entry) entry.members.push(state);
            else clustered.set(key, { cell, members: [state] });
        }

        const candidates: ClusterCandidate[] = [];
        for (const { cell, members } of clustered.values()) {
            const first = members[0];
            if (!first) continue;
            candidates.push({
                cell,
                center: createGeoPoint({
                    latitude: first.position.latitude,
                    longitude: first.position.longitude,
                }),
                members,
            });
        }
        candidates.sort((a, b) => (a.cell.x !== b.cell.x ? a.cell.x - b.cell.x : a.cell.y - b.cell.y));
        return candidates;
    }

    /**
     * 新しく計算したまとまりを、位置が近い前回のクラスタへ吸収させる。
     *
     * 吸収できたものは**前回の中心をそのまま使う**。メンバーが変わっていないのに
     * 中心だけ動くと、パンのたびにクラスタマーカーが小刻みに揺れて見えるため。
     */
    private absorbCachedClusters(params: {
        mergedClusters: MergedCluster[];
        cachedClusterGroups: ReadonlyMap<string, MarkerState[]>;
        cachedMarkerGroups: ReadonlyMap<string, MarkerState[]>;
        cachedClusterPositions: ReadonlyMap<string, GeoPoint>;
        zoom: number;
        effectiveRadiusPx: number;
    }): MergedCluster[] {
        const {
            mergedClusters, cachedClusterGroups, cachedMarkerGroups,
            cachedClusterPositions, zoom, effectiveRadiusPx,
        } = params;
        const result: MergedCluster[] = [];
        const usedCachedClusters = new Set<string>();

        for (const merged of mergedClusters) {
            let mergedWithCached = false;

            for (const [cachedClusterId, cachedMembers] of cachedClusterGroups) {
                if (mergedWithCached || usedCachedClusters.has(cachedClusterId)) continue;
                const cachedPosition = cachedClusterPositions.get(cachedClusterId);
                if (!cachedPosition) continue;
                const thresholdMeters = effectiveRadiusPx * this.geometry.metersPerPixel(merged.center, zoom);
                if (Spherical.computeDistanceBetween(merged.center, cachedPosition) <= thresholdMeters) {
                    result.push({
                        center: cachedPosition,
                        members: [...cachedMembers, ...merged.members],
                    });
                    usedCachedClusters.add(cachedClusterId);
                    mergedWithCached = true;
                }
            }

            if (!mergedWithCached) result.push(merged);
        }

        for (const [cachedClusterId, cachedMembers] of cachedClusterGroups) {
            if (usedCachedClusters.has(cachedClusterId)) continue;
            const cachedPosition = cachedClusterPositions.get(cachedClusterId);
            if (!cachedPosition) continue;
            result.push({ center: cachedPosition, members: cachedMembers });
        }

        for (const cachedMembers of cachedMarkerGroups.values()) {
            const first = cachedMembers[0];
            if (!first) continue;
            result.push({
                center: createGeoPoint({
                    latitude: first.position.latitude,
                    longitude: first.position.longitude,
                }),
                members: cachedMembers,
            });
        }

        return result;
    }

    /** まとまりごとに「クラスタにする／そのまま描く」を決め、中心と半径を確定させる。 */
    private buildPlan(params: {
        finalMergedClusters: MergedCluster[];
        zoom: number;
        effectiveRadiusPx: number;
        minClusterSize: number;
        sourceFingerprints: Map<string, string>;
    }): ClusterPlan {
        const { finalMergedClusters, zoom, effectiveRadiusPx, minClusterSize, sourceFingerprints } = params;
        const entries: PlannedEntry[] = [];
        const clusterMemberCenters = new Map<string, GeoPoint>();
        const clusterPositions = new Map<string, GeoPoint>();
        const assignments = new Map<string, string>();
        const coverageBounds = createGeoRectBounds();

        for (const merged of finalMergedClusters) {
            if (merged.members.length < minClusterSize) {
                for (const member of merged.members) {
                    coverageBounds.extend(member.position);
                    assignments.set(member.id, member.id);
                }
                entries.push({ kind: 'singles', states: merged.members });
                continue;
            }

            // 凸包の靴ひも重心を中心にする。全員がほぼ同じ点にいて凸包が潰れる場合は
            // メンバー平均へ落とす（同じ会場のクラスタが最初の 1 人の位置や
            // 前回のキャッシュ位置ではなく、その会場に出るようにするため）。
            const hull = this.geometry.convexHullProjected(merged.members, zoom);
            const centroidPx = this.geometry.polygonCentroidProjected(hull);
            const center = centroidPx
                ? this.geometry.unprojectPixel(centroidPx, zoom)
                : this.geometry.averagePosition(merged.members);

            // 中心は毎回の再クラスタで現在のメンバーから計算し直す。メンバーが
            // 変わらないパンでは同じ重心になるのでちらつかず、メンバーが変われば
            // 古いキャッシュ位置に貼り付かず本来の中心へ動く。
            const cell = this.builder.cellOf(center, zoom, effectiveRadiusPx);
            const clusterId = this.builder.buildClusterId(cell, zoom);
            const radiusMeters = this.geometry.calculateClusterRadiusMeters(center, merged.members);

            for (const member of merged.members) {
                clusterMemberCenters.set(member.id, center);
                assignments.set(member.id, clusterId);
            }
            clusterPositions.set(clusterId, center);
            this.geometry.extendCoverageBounds(coverageBounds, center, radiusMeters);

            entries.push({
                kind: 'cluster',
                cluster: {
                    id: clusterId,
                    center,
                    members: merged.members,
                    radiusMeters,
                    cell,
                    hullPoints: hull.length >= 3
                        ? hull.map((point) => this.geometry.unprojectPixel(point, zoom))
                        : [],
                },
            });
        }

        return {
            entries,
            clusterMemberCenters,
            clusterPositions,
            assignments,
            coverageBounds,
            sourceFingerprints,
        };
    }
}
