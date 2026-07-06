import {
    createGeoPoint,
    createGeoRectBounds,
    computeDistanceBetween,
    expandBounds,
    Earth,
    ColorDefaultIcon,
    createMarkerState,
    type GeoPoint,
    type GeoPointInterface,
    type GeoRectBounds,
    type MapCameraPosition,
    type MarkerIcon,
    type MarkerState,
    type Serializable,
} from '@mapconductor/js-sdk-core';
import type { MarkerCluster, MarkerClusterDebugInfo } from './MarkerCluster';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_CLUSTER_RADIUS_PX = 90.0;
export const DEFAULT_MIN_CLUSTER_SIZE = 3;
export const DEFAULT_EXPAND_MARGIN = 0.2;
export const DEFAULT_TILE_SIZE = 256.0;
export const DEFAULT_CAMERA_DEBOUNCE_MS = 100;
export const DEFAULT_ZOOM_ANIMATION_DURATION_MS = 300;

const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;
const MAX_SIN_LAT = 0.9999;
const MAX_DENSE_CELLS = 4;
const MAX_DENSE_CANDIDATES = 50;
const PAN_ANIMATION_MIN_DISTANCE_METERS = 1.0;
const CAMERA_ANGLE_EPSILON = 1e-2;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClusterIconProvider = (count: number) => MarkerIcon;

const defaultClusterIconProvider: ClusterIconProvider = (count) =>
    new ColorDefaultIcon('#2563EB', { label: String(count) });

export interface MarkerClusterOptions {
    clusterRadiusPx?: number;
    minClusterSize?: number;
    expandMargin?: number;
    clusterIconProvider?: ClusterIconProvider;
    onClusterClick?: ((cluster: MarkerCluster) => void) | null;
    debugHullPolygons?: boolean;
    tileSize?: number;
    /** Animate cluster expand/shrink transitions on zoom change. Mirrors Android's enableZoomAnimation. */
    enableZoomAnimation?: boolean;
    /** Animate cluster transitions on camera pan. Mirrors Android's enablePanAnimation. */
    enablePanAnimation?: boolean;
}

export interface ClusterComputeResult {
    outputMarkers: MarkerState[];
    debugInfos: MarkerClusterDebugInfo[];
    /**
     * True when this transition should be animated (a zoom change with
     * enableZoomAnimation, or a camera pan with enablePanAnimation).
     */
    animateTransitions: boolean;
    /**
     * memberId → cluster center where that source marker was rendered in the
     * PREVIOUS computation. Only contains entries for clustered members.
     * Used as animation start positions for newly appearing markers.
     */
    previousMemberCenters: ReadonlyMap<string, GeoPoint>;
    /**
     * memberId → cluster center where that source marker is rendered in THIS
     * computation. Only contains entries for clustered members.
     * Used as animation target positions for disappearing markers.
     */
    memberCenters: ReadonlyMap<string, GeoPoint>;
}

interface ClusterCell { x: number; y: number }
interface ClusterCandidate { cell: ClusterCell; center: GeoPoint; members: MarkerState[] }
interface MergedCluster { center: GeoPoint; members: MarkerState[] }
interface HullPoint { x: number; y: number }
interface PixelPoint { member: MarkerState; x: number; y: number }

// ── Strategy ──────────────────────────────────────────────────────────────────

/**
 * Grid-based greedy marker clustering algorithm.
 * Ports `MarkerClusterStrategy.kt` from the Android SDK to TypeScript.
 *
 * Instantiate once and call `computeClusters()` whenever markers or the camera
 * change. The strategy maintains an internal cache so unchanged areas are
 * not re-computed.
 */
export class MarkerClusterStrategy {
    private readonly clusterRadiusPx: number;
    private readonly minClusterSize: number;
    private readonly expandMargin: number;
    private readonly clusterIconProvider: ClusterIconProvider;
    private readonly onClusterClick: ((cluster: MarkerCluster) => void) | null;
    readonly debugHullPolygons: boolean;
    private readonly tileSize: number;
    private readonly enableZoomAnimation: boolean;
    private readonly enablePanAnimation: boolean;

    // ── Cache state ───────────────────────────────────────────────────────────
    private lastClusterAssignments = new Map<string, string>();
    private lastClusterPositions = new Map<string, GeoPoint>();
    private lastClusterMemberCenters = new Map<string, GeoPoint>();
    private lastClusterCoverageBounds: GeoRectBounds | null = null;
    private lastRenderCameraPosition: MapCameraPosition | null = null;
    private lastSourceStateVersion = -1;
    private lastSourceFingerprints = new Map<string, string>();
    private lastZoomKey: number | null = null;
    private clusteringTurn = 0;
    private lastKnownViewport: GeoRectBounds | null = null;
    private lastKnownViewportZoom: number | null = null;

    constructor(options: MarkerClusterOptions = {}) {
        this.clusterRadiusPx = options.clusterRadiusPx ?? DEFAULT_CLUSTER_RADIUS_PX;
        this.minClusterSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;
        this.expandMargin = options.expandMargin ?? DEFAULT_EXPAND_MARGIN;
        this.clusterIconProvider = options.clusterIconProvider ?? defaultClusterIconProvider;
        this.onClusterClick = options.onClusterClick ?? null;
        this.debugHullPolygons = options.debugHullPolygons ?? false;
        this.tileSize = options.tileSize ?? DEFAULT_TILE_SIZE;
        this.enableZoomAnimation = options.enableZoomAnimation ?? false;
        this.enablePanAnimation = options.enablePanAnimation ?? false;
    }

    clear(): void {
        this.lastClusterAssignments.clear();
        this.lastClusterPositions.clear();
        this.lastClusterMemberCenters.clear();
        this.lastClusterCoverageBounds = null;
        this.lastRenderCameraPosition = null;
        this.lastSourceStateVersion = -1;
        this.lastSourceFingerprints.clear();
        this.lastZoomKey = null;
        this.clusteringTurn = 0;
        this.lastKnownViewport = null;
        this.lastKnownViewportZoom = null;
    }

    /**
     * Compute the clustered output for the given markers and camera position.
     * Returns cluster markers (with `extra: MarkerCluster`) mixed with individual
     * unclustered markers.
     */
    computeClusters(params: {
        markers: MarkerState[];
        cameraPosition: MapCameraPosition;
        sourceStateVersion: number;
    }): ClusterComputeResult {
        const { markers, cameraPosition, sourceStateVersion } = params;

        const rawViewport = cameraPosition.visibleRegion?.bounds;
        if (rawViewport && !rawViewport.isEmpty()) {
            this.lastKnownViewport = rawViewport;
            this.lastKnownViewportZoom = cameraPosition.zoom;
        }
        const viewport = (rawViewport && !rawViewport.isEmpty())
            ? rawViewport
            : this.estimateViewport(cameraPosition.zoom, cameraPosition.position);

        if (!viewport || viewport.isEmpty()) {
            return {
                outputMarkers: markers.slice(),
                debugInfos: [],
                animateTransitions: false,
                previousMemberCenters: this.lastClusterMemberCenters,
                memberCenters: this.lastClusterMemberCenters,
            };
        }

        const expandedBounds = expandBounds(viewport, this.expandMargin);
        const zoom = cameraPosition.zoom;
        const effectiveRadiusPx = this.effectiveClusterRadiusPx(zoom);
        const { turn: _turn, zoomChanged } = this.updateClusteringTurn(zoom);
        const stableSource = sourceStateVersion === this.lastSourceStateVersion;
        const cameraMoved = this.lastRenderCameraPosition != null &&
            this.hasCameraMoved(this.lastRenderCameraPosition, cameraPosition);
        const animateTransitions =
            (this.enableZoomAnimation && zoomChanged) ||
            (this.enablePanAnimation && cameraMoved);

        // Skip re-clustering when nothing relevant changed and the viewport is already covered.
        if (
            !zoomChanged &&
            this.lastClusterCoverageBounds != null &&
            this.containsBounds(this.lastClusterCoverageBounds, expandedBounds) &&
            stableSource
        ) {
            // Return the existing output by reconstructing from last assignments.
            // For simplicity we fall through to a full re-computation rather than
            // maintaining a separate output cache; the bounds check above keeps
            // this branch cheap by avoiding it in the common case of slow panning.
        }

        if (zoomChanged) {
            this.lastClusterAssignments = new Map();
        }

        // ── Partition markers into cached / new ───────────────────────────────
        const cachedMarkers: MarkerState[] = [];
        const newMarkers: MarkerState[] = [];
        const currentFingerprints = new Map<string, string>();

        for (const state of markers) {
            if (!this.containsInViewport(expandedBounds, state.position, zoom)) continue;

            const fp = this.markerFingerPrint(state.position);
            currentFingerprints.set(state.id, fp);
            const movedSinceLastRender =
                (this.lastSourceFingerprints.get(state.id) ?? '\0') !== fp;

            if (
                !zoomChanged &&
                this.lastClusterCoverageBounds != null &&
                this.containsInViewport(this.lastClusterCoverageBounds, state.position, zoom) &&
                this.lastClusterAssignments.has(state.id) &&
                !movedSinceLastRender
            ) {
                cachedMarkers.push(state);
            } else {
                newMarkers.push(state);
            }
        }

        // Rebuild cached cluster / individual groups from last assignments.
        const cachedClusterGroups = new Map<string, MarkerState[]>();
        const cachedMarkerGroups = new Map<string, MarkerState[]>();
        for (const marker of cachedMarkers) {
            const clusterId = this.lastClusterAssignments.get(marker.id);
            if (clusterId && clusterId.startsWith('cluster_')) {
                const g = cachedClusterGroups.get(clusterId) ?? [];
                g.push(marker);
                cachedClusterGroups.set(clusterId, g);
            } else {
                const key = clusterId ?? marker.id;
                const g = cachedMarkerGroups.get(key) ?? [];
                g.push(marker);
                cachedMarkerGroups.set(key, g);
            }
        }

        // ── Grid-bucket new markers ────────────────────────────────────────────
        const gridMap = new Map<string, { cell: ClusterCell; members: MarkerState[] }>();
        for (const state of newMarkers) {
            const [px, py] = this.projectToPixel(state.position, zoom);
            const cell: ClusterCell = {
                x: Math.floor(px / effectiveRadiusPx),
                y: Math.floor(py / effectiveRadiusPx),
            };
            const key = `${cell.x},${cell.y}`;
            const entry = gridMap.get(key);
            if (entry) {
                entry.members.push(state);
            } else {
                gridMap.set(key, { cell, members: [state] });
            }
        }

        const candidates: ClusterCandidate[] = [];
        for (const { cell, members } of gridMap.values()) {
            const first = members[0];
            if (!first) continue;
            candidates.push({
                cell,
                center: createGeoPoint({ latitude: first.position.latitude, longitude: first.position.longitude }),
                members,
            });
        }
        candidates.sort((a, b) => a.cell.x !== b.cell.x ? a.cell.x - b.cell.x : a.cell.y - b.cell.y);

        const mergedClusters = this.mergeClusters(candidates, zoom, effectiveRadiusPx);

        // ── Merge with cached clusters ─────────────────────────────────────────
        const finalMergedClusters: MergedCluster[] = [];
        const usedCachedClusters = new Set<string>();

        for (const merged of mergedClusters) {
            let mergedWithCached = false;

            for (const [cachedId, cachedMembers] of cachedClusterGroups) {
                if (mergedWithCached || usedCachedClusters.has(cachedId)) continue;
                const cachedPos = this.lastClusterPositions.get(cachedId);
                if (!cachedPos) continue;
                const mpp = this.metersPerPixel(merged.center, zoom);
                const threshold = effectiveRadiusPx * mpp;
                if (computeDistanceBetween(merged.center, cachedPos) <= threshold) {
                    finalMergedClusters.push({ center: cachedPos, members: [...cachedMembers, ...merged.members] });
                    usedCachedClusters.add(cachedId);
                    mergedWithCached = true;
                }
            }

            if (!mergedWithCached) {
                finalMergedClusters.push(merged);
            }
        }

        for (const [cachedId, cachedMembers] of cachedClusterGroups) {
            if (usedCachedClusters.has(cachedId)) continue;
            const cachedPos = this.lastClusterPositions.get(cachedId);
            if (!cachedPos) continue;
            finalMergedClusters.push({ center: cachedPos, members: cachedMembers });
        }

        for (const cachedMembers of cachedMarkerGroups.values()) {
            const first = cachedMembers[0];
            if (!first) continue;
            finalMergedClusters.push({
                center: createGeoPoint({ latitude: first.position.latitude, longitude: first.position.longitude }),
                members: cachedMembers,
            });
        }

        // ── Build output ───────────────────────────────────────────────────────
        const coverageBounds = createGeoRectBounds();
        const nextClusterAssignments = new Map<string, string>();
        const nextClusterPositions = new Map<string, GeoPoint>();
        const memberCenters = new Map<string, GeoPoint>();
        const outputMarkers: MarkerState[] = [];
        const debugInfos: MarkerClusterDebugInfo[] = [];

        for (const merged of finalMergedClusters) {
            if (merged.members.length >= this.minClusterSize) {
                // Compute centroid via convex-hull shoelace formula (in pixel space).
                const hull = this.convexHullProjected(merged.members, zoom);
                const centroidPx = this.polygonCentroidProjected(hull);
                const initialCenter = centroidPx
                    ? this.unprojectPixel(centroidPx, zoom)
                    : merged.center;

                // Stabilize: reuse the last known center for this cell if unchanged.
                const [cx, cy] = this.projectToPixel(initialCenter, zoom);
                const cell: ClusterCell = {
                    x: Math.floor(cx / effectiveRadiusPx),
                    y: Math.floor(cy / effectiveRadiusPx),
                };
                const clusterId = this.buildClusterId(cell, zoom);
                const center = (!zoomChanged && stableSource && this.lastClusterPositions.has(clusterId))
                    ? this.lastClusterPositions.get(clusterId)!
                    : initialCenter;

                const radiusMeters = this.calculateClusterRadiusMeters(center, merged.members);

                const cluster: MarkerCluster = {
                    count: merged.members.length,
                    markerIds: merged.members.map(m => m.id),
                };

                debugInfos.push({
                    id: clusterId,
                    center,
                    radiusMeters,
                    count: merged.members.length,
                    cellX: cell.x,
                    cellY: cell.y,
                    hullPoints: (this.debugHullPolygons && hull.length >= 3)
                        ? hull.map(p => this.unprojectPixel(p, zoom))
                        : [],
                });

                for (const member of merged.members) {
                    nextClusterAssignments.set(member.id, clusterId);
                    memberCenters.set(member.id, center);
                }
                nextClusterPositions.set(clusterId, center);
                this.extendCoverageBounds(coverageBounds, center, radiusMeters);

                const clusterState = createMarkerState({
                    id: clusterId,
                    position: center,
                    extra: cluster as unknown as Serializable,
                    icon: this.clusterIconProvider(merged.members.length),
                    clickable: this.onClusterClick != null,
                    draggable: false,
                    onClick: this.onClusterClick != null
                        ? () => this.onClusterClick!(cluster)
                        : null,
                });
                outputMarkers.push(clusterState);
            } else {
                for (const member of merged.members) {
                    coverageBounds.extend(member.position);
                    nextClusterAssignments.set(member.id, member.id);
                }
                outputMarkers.push(...merged.members);
            }
        }

        // Update cache.
        const previousMemberCenters = this.lastClusterMemberCenters;
        this.lastClusterAssignments = nextClusterAssignments;
        this.lastClusterPositions = nextClusterPositions;
        this.lastClusterMemberCenters = memberCenters;
        this.lastClusterCoverageBounds = coverageBounds.isEmpty() ? null : coverageBounds;
        this.lastRenderCameraPosition = cameraPosition;
        this.lastSourceStateVersion = sourceStateVersion;
        this.lastSourceFingerprints = currentFingerprints;

        return { outputMarkers, debugInfos, animateTransitions, previousMemberCenters, memberCenters };
    }

    // ── Projection helpers ─────────────────────────────────────────────────────

    private projectToPixel(position: GeoPointInterface, zoom: number): [number, number] {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const sinLat = Math.max(-MAX_SIN_LAT, Math.min(MAX_SIN_LAT, Math.sin(position.latitude * DEG_TO_RAD)));
        const x = (position.longitude + 180.0) / 360.0 * scale;
        const y = (0.5 - Math.log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * Math.PI)) * scale;
        return [x, y];
    }

    private unprojectPixel(px: HullPoint, zoom: number): GeoPoint {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const lon = (px.x / scale) * 360.0 - 180.0;
        const t = Math.exp(4.0 * Math.PI * (0.5 - px.y / scale));
        const sinLat = Math.max(-MAX_SIN_LAT, Math.min(MAX_SIN_LAT, (t - 1.0) / (t + 1.0)));
        const lat = Math.asin(sinLat) * RAD_TO_DEG;
        return createGeoPoint({ latitude: lat, longitude: lon });
    }

    // ── Clustering helpers ────────────────────────────────────────────────────

    private effectiveClusterRadiusPx(zoom: number): number {
        const referenceZoom = 10.0;
        const minScale = 0.35;
        const minRadiusPx = 18.0;
        const scale = Math.max(minScale, Math.min(1.0, zoom / referenceZoom));
        return Math.max(minRadiusPx, this.clusterRadiusPx * scale);
    }

    private metersPerPixel(position: GeoPointInterface, zoom: number): number {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const cosLat = Math.cos(position.latitude * DEG_TO_RAD);
        return (Earth.CIRCUMFERENCE_METERS * cosLat) / scale;
    }

    /**
     * Viewport containment check that handles antimeridian-crossing bounds.
     * At zoom ≤ 4 the crossing representation is interpreted as a large span
     * covering the complement longitude range (same logic as the Android SDK).
     */
    private containsInViewport(bounds: GeoRectBounds, point: GeoPointInterface, zoom: number): boolean {
        if (bounds.isEmpty()) return false;
        const sw = bounds.southWest;
        const ne = bounds.northEast;
        if (!sw || !ne) return false;

        const wrap = (lon: number) => ((lon + 540.0) % 360.0) - 180.0;
        const lat = point.latitude;
        const lon = wrap(point.longitude);
        const west = wrap(sw.longitude);
        const east = wrap(ne.longitude);

        if (lat < sw.latitude || lat > ne.latitude) return false;

        if (west <= east) {
            return lon >= west && lon <= east;
        }

        // Antimeridian-crossing bounds (west > east).
        const lowZoom = zoom <= 4.0;
        if (lowZoom) {
            return lon >= east && lon <= west;
        }
        return lon >= west || lon <= east;
    }

    /**
     * Greedy (seed-based) merge — ports `mergeClusters()` from the Android SDK.
     * Merges only neighbours within `clusterRadiusPx` of the *seed* candidate to
     * prevent chaining artefacts.
     */
    private mergeClusters(
        candidates: ClusterCandidate[],
        zoom: number,
        clusterRadiusPx: number,
    ): MergedCluster[] {
        if (candidates.length === 0) return [];

        const indexByCell = new Map<string, number>();
        candidates.forEach((c, i) => indexByCell.set(`${c.cell.x},${c.cell.y}`, i));

        const visited = new Uint8Array(candidates.length);
        const result: MergedCluster[] = [];

        for (let i = 0; i < candidates.length; i++) {
            if (visited[i]) continue;
            visited[i] = 1;

            const seed = candidates[i];
            const seedMpp = this.metersPerPixel(seed.center, zoom);
            const members: MarkerState[] = seed.members.slice();

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const nKey = `${seed.cell.x + dx},${seed.cell.y + dy}`;
                    const ni = indexByCell.get(nKey);
                    if (ni === undefined || visited[ni]) continue;

                    const neighbor = candidates[ni];
                    const neighborMpp = this.metersPerPixel(neighbor.center, zoom);
                    const threshold = clusterRadiusPx * Math.max(seedMpp, neighborMpp);
                    if (computeDistanceBetween(seed.center, neighbor.center) <= threshold) {
                        visited[ni] = 1;
                        members.push(...neighbor.members);
                    }
                }
            }

            const center = this.selectDenseCenter(members, zoom, clusterRadiusPx);
            result.push({ center, members });
        }

        return result;
    }

    /**
     * Selects the densest member as the cluster center, falling back to the
     * first member when only one exists.
     * Ports `selectDenseCenter()` from the Android SDK.
     */
    private selectDenseCenter(
        members: MarkerState[],
        zoom: number,
        clusterRadiusPx: number,
    ): GeoPoint {
        if (members.length === 0) return createGeoPoint({ latitude: 0, longitude: 0 });
        if (members.length === 1) {
            return createGeoPoint({ latitude: members[0].position.latitude, longitude: members[0].position.longitude });
        }

        const points: PixelPoint[] = members.map(m => {
            const [x, y] = this.projectToPixel(m.position, zoom);
            return { member: m, x, y };
        });

        const cellSize = clusterRadiusPx;
        const cellMap = new Map<string, PixelPoint[]>();
        for (const p of points) {
            const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
            const arr = cellMap.get(key) ?? [];
            arr.push(p);
            cellMap.set(key, arr);
        }

        const sortedCells = Array.from(cellMap.values()).sort((a, b) => b.length - a.length);
        const candidatePoints = sortedCells
            .slice(0, MAX_DENSE_CELLS)
            .flatMap(arr => arr)
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

            if (neighborCount > bestNeighborCount ||
                (neighborCount === bestNeighborCount && totalDistance < bestTotalDistance)) {
                bestNeighborCount = neighborCount;
                bestTotalDistance = totalDistance;
                best = candidate;
            }
        }

        return createGeoPoint({ latitude: best.member.position.latitude, longitude: best.member.position.longitude });
    }

    /**
     * Andrew's monotone chain convex hull — ported from the Android SDK.
     * Operates in Web Mercator pixel space.
     */
    private convexHullProjected(members: MarkerState[], zoom: number): HullPoint[] {
        if (members.length < 3) return [];

        const raw = members.map(m => {
            const [x, y] = this.projectToPixel(m.position, zoom);
            return { x, y };
        });

        // Deduplicate by rounding to 3 decimal places.
        const seen = new Set<string>();
        const points: HullPoint[] = [];
        for (const p of raw) {
            const key = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
            if (!seen.has(key)) {
                seen.add(key);
                points.push(p);
            }
        }
        if (points.length < 3) return [];

        points.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);

        const cross = (o: HullPoint, a: HullPoint, b: HullPoint): number =>
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        const lower: HullPoint[] = [];
        for (const p of points) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
                lower.pop();
            }
            lower.push(p);
        }

        const upper: HullPoint[] = [];
        for (const p of [...points].reverse()) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
                upper.pop();
            }
            upper.push(p);
        }

        // Remove the last point of each half (duplicate of the other's first).
        const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
        return hull.length >= 3 ? hull : [];
    }

    /**
     * Shoelace formula centroid of a polygon in pixel space.
     * Ports `polygonCentroidProjected()` from the Android SDK.
     */
    private polygonCentroidProjected(hull: HullPoint[]): HullPoint | null {
        if (hull.length < 3) return null;

        let twiceArea = 0;
        let cx = 0;
        let cy = 0;
        for (let i = 0; i < hull.length; i++) {
            const a = hull[i];
            const b = hull[(i + 1) % hull.length];
            const cross = a.x * b.y - b.x * a.y;
            twiceArea += cross;
            cx += (a.x + b.x) * cross;
            cy += (a.y + b.y) * cross;
        }

        if (Math.abs(twiceArea) < 1e-6) {
            // Degenerate — fall back to average.
            return {
                x: hull.reduce((s, p) => s + p.x, 0) / hull.length,
                y: hull.reduce((s, p) => s + p.y, 0) / hull.length,
            };
        }

        return { x: cx / (3.0 * twiceArea), y: cy / (3.0 * twiceArea) };
    }

    // ── Utility helpers ───────────────────────────────────────────────────────

    private buildClusterId(cell: ClusterCell, zoom: number): string {
        return `cluster_${Math.round(zoom)}_${cell.x}_${cell.y}`;
    }

    private calculateClusterRadiusMeters(center: GeoPoint, members: MarkerState[]): number {
        let max = 0;
        for (const m of members) {
            const d = computeDistanceBetween(center, m.position);
            if (d > max) max = d;
        }
        return max;
    }

    private extendCoverageBounds(bounds: GeoRectBounds, center: GeoPoint, radiusMeters: number): void {
        const latPad = (radiusMeters / Earth.RADIUS_METERS) * RAD_TO_DEG;
        const cosLat = Math.max(1e-6, Math.cos(center.latitude * DEG_TO_RAD));
        const lonPad = (radiusMeters / (Earth.RADIUS_METERS * cosLat)) * RAD_TO_DEG;
        bounds.extend(createGeoPoint({ latitude: center.latitude - latPad, longitude: center.longitude - lonPad }));
        bounds.extend(createGeoPoint({ latitude: center.latitude + latPad, longitude: center.longitude + lonPad }));
    }

    private containsBounds(container: GeoRectBounds, target: GeoRectBounds): boolean {
        if (container.isEmpty() || target.isEmpty()) return false;
        const sw = target.southWest;
        const ne = target.northEast;
        if (!sw || !ne) return false;
        return container.contains(sw) && container.contains(ne);
    }

    private updateClusteringTurn(zoom: number): { turn: number; zoomChanged: boolean } {
        const zoomKey = Math.round(zoom * 100);
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

    private hasCameraMoved(prev: MapCameraPosition, curr: MapCameraPosition): boolean {
        if (computeDistanceBetween(prev.position, curr.position) > PAN_ANIMATION_MIN_DISTANCE_METERS) return true;
        if (Math.abs(prev.bearing - curr.bearing) > CAMERA_ANGLE_EPSILON) return true;
        return Math.abs(prev.tilt - curr.tilt) > CAMERA_ANGLE_EPSILON;
    }

    /**
     * Estimates the viewport when `visibleRegion` is null (e.g. during ArcGIS
     * animations).  Scales the last known viewport span by 2^(baseZoom − zoom).
     * Ports `estimateViewport()` from the Android SDK.
     */
    private estimateViewport(zoom: number, center: GeoPointInterface): GeoRectBounds | null {
        const base = this.lastKnownViewport;
        const baseZoom = this.lastKnownViewportZoom;
        if (!base || baseZoom == null) return null;

        const sw = base.southWest;
        const ne = base.northEast;
        if (!sw || !ne) return base;

        const scale = Math.pow(2.0, baseZoom - zoom);
        const wrap = (lon: number) => ((lon + 540.0) % 360.0) - 180.0;
        const centerLon = wrap(center.longitude);

        const halfLat = Math.abs(ne.latitude - sw.latitude) / 2.0 * scale;
        const lonSpan = sw.longitude <= ne.longitude
            ? ne.longitude - sw.longitude
            : ne.longitude + 360.0 - sw.longitude;
        const halfLon = Math.min(180.0, lonSpan / 2.0 * scale);

        const result = createGeoRectBounds();
        result.extend(createGeoPoint({
            latitude: Math.max(-90, Math.min(90, center.latitude - halfLat)),
            longitude: wrap(centerLon - halfLon),
        }));
        result.extend(createGeoPoint({
            latitude: Math.max(-90, Math.min(90, center.latitude + halfLat)),
            longitude: wrap(centerLon + halfLon),
        }));
        return result;
    }

    private markerFingerPrint(position: GeoPointInterface): string {
        return `${position.latitude}_${position.longitude}`;
    }
}
