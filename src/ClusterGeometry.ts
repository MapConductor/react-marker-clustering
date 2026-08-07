import {
    createGeoPoint,
    createGeoRectBounds,
    Earth,
    Spherical,
    type GeoPoint,
    type GeoPointInterface,
    type GeoRectBounds,
    type MapCameraPosition,
    type MarkerState,
} from '@mapconductor/js-sdk-core';
import type { MarkerCluster } from './MarkerCluster';

const DEG_TO_RAD = Math.PI / 180.0;
const RAD_TO_DEG = 180.0 / Math.PI;
const MAX_SIN_LAT = 0.9999;
const LOW_ZOOM_THRESHOLD = 4.0;
const PAN_ANIMATION_MIN_DISTANCE_METERS = 1.0;
const CAMERA_ANGLE_EPSILON = 1e-2;

/** 投影座標上の 1 点。凸包と重心の計算にだけ使う。 */
export interface HullPoint {
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
export class ClusterGeometry {
    constructor(private readonly tileSize: number) {}

    projectToPixel(position: GeoPointInterface, zoom: number): [number, number] {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const sinLat = Math.max(-MAX_SIN_LAT, Math.min(MAX_SIN_LAT, Math.sin(position.latitude * DEG_TO_RAD)));
        const x = ((position.longitude + 180.0) / 360.0) * scale;
        const y = (0.5 - Math.log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * Math.PI)) * scale;
        return [x, y];
    }

    unprojectPixel(point: HullPoint, zoom: number): GeoPoint {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        const longitude = (point.x / scale) * 360.0 - 180.0;
        const t = Math.exp(4.0 * Math.PI * (0.5 - point.y / scale));
        const sinLat = Math.max(-MAX_SIN_LAT, Math.min(MAX_SIN_LAT, (t - 1.0) / (t + 1.0)));
        return createGeoPoint({ latitude: Math.asin(sinLat) * RAD_TO_DEG, longitude });
    }

    metersPerPixel(position: GeoPointInterface, zoom: number): number {
        const scale = this.tileSize * Math.pow(2.0, zoom);
        return (Earth.CIRCUMFERENCE_METERS * Math.cos(position.latitude * DEG_TO_RAD)) / scale;
    }

    wrapLongitude(longitude: number): number {
        return ((longitude + 540.0) % 360.0) - 180.0;
    }

    /**
     * 日付変更線をまたぐ表現に対応した内外判定。
     *
     * `GeoRectBounds` は経度方向の最小の弧を選ぶ。日付変更線近くの小さな
     * ビューポートではそれが正しいが、大きく引いた表示では実際の可視範囲が
     * 180 度を超え、最小の弧が補集合になってしまう。そのため低ズームでは
     * 「またいでいる境界＝広い範囲」とみなして補集合側を採る。
     */
    containsInViewport(bounds: GeoRectBounds | null, point: GeoPointInterface, zoom: number): boolean {
        if (!bounds || bounds.isEmpty) return false;
        const sw = bounds.southWest;
        const ne = bounds.northEast;
        if (!sw || !ne) return false;

        const latitude = point.latitude;
        const longitude = this.wrapLongitude(point.longitude);
        const west = this.wrapLongitude(sw.longitude);
        const east = this.wrapLongitude(ne.longitude);

        if (latitude < sw.latitude || latitude > ne.latitude) return false;
        if (west <= east) return longitude >= west && longitude <= east;

        if (zoom <= LOW_ZOOM_THRESHOLD) return longitude >= east && longitude <= west;
        return longitude >= west || longitude <= east;
    }

    containsBounds(container: GeoRectBounds, target: GeoRectBounds): boolean {
        if (container.isEmpty || target.isEmpty) return false;
        const sw = target.southWest;
        const ne = target.northEast;
        if (!sw || !ne) return false;
        return container.contains(sw) && container.contains(ne);
    }

    extendCoverageBounds(bounds: GeoRectBounds, center: GeoPoint, radiusMeters: number): void {
        const latPad = (radiusMeters / Earth.RADIUS_METERS) * RAD_TO_DEG;
        const cosLat = Math.max(1e-6, Math.cos(center.latitude * DEG_TO_RAD));
        const lonPad = (radiusMeters / (Earth.RADIUS_METERS * cosLat)) * RAD_TO_DEG;
        bounds.extend(createGeoPoint({ latitude: center.latitude - latPad, longitude: center.longitude - lonPad }));
        bounds.extend(createGeoPoint({ latitude: center.latitude + latPad, longitude: center.longitude + lonPad }));
    }

    /**
     * 実際の visibleRegion が取れないときのビューポート推定。
     *
     * 直前のビューポートの広さを 2^(baseZoom − zoom) で伸縮し、現在のカメラ位置を
     * 中心に置き直す。ArcGIS はアニメーション中に visibleRegion が null の
     * カメラ更新を出すため、これが無いとズームアウト後に見えるようになった
     * マーカーがクラスタリングに入らない。
     */
    estimateViewport(
        zoom: number,
        center: GeoPointInterface,
        lastKnownViewport: GeoRectBounds | null,
        lastKnownViewportZoom: number | null,
    ): GeoRectBounds | null {
        const base = lastKnownViewport;
        if (!base || lastKnownViewportZoom == null) return null;

        const sw = base.southWest;
        const ne = base.northEast;
        if (!sw || !ne) return base;

        const scale = Math.pow(2.0, lastKnownViewportZoom - zoom);
        const centerLon = this.wrapLongitude(center.longitude);

        const halfLat = (Math.abs(ne.latitude - sw.latitude) / 2.0) * scale;
        const lonSpan = sw.longitude <= ne.longitude
            ? ne.longitude - sw.longitude
            : ne.longitude + 360.0 - sw.longitude;
        const halfLon = Math.min(180.0, (lonSpan / 2.0) * scale);

        const result = createGeoRectBounds();
        result.extend(createGeoPoint({
            latitude: Math.max(-90, Math.min(90, center.latitude - halfLat)),
            longitude: this.wrapLongitude(centerLon - halfLon),
        }));
        result.extend(createGeoPoint({
            latitude: Math.max(-90, Math.min(90, center.latitude + halfLat)),
            longitude: this.wrapLongitude(centerLon + halfLon),
        }));
        return result;
    }

    hasCameraMoved(previous: MapCameraPosition, current: MapCameraPosition): boolean {
        if (Spherical.computeDistanceBetween(previous.position, current.position) > PAN_ANIMATION_MIN_DISTANCE_METERS) {
            return true;
        }
        if (Math.abs(previous.bearing - current.bearing) > CAMERA_ANGLE_EPSILON) return true;
        return Math.abs(previous.tilt - current.tilt) > CAMERA_ANGLE_EPSILON;
    }

    interpolatePosition(start: GeoPoint, end: GeoPoint, t: number): GeoPoint {
        return createGeoPoint({
            latitude: start.latitude + (end.latitude - start.latitude) * t,
            longitude: start.longitude + (end.longitude - start.longitude) * t,
        });
    }

    averagePosition(states: MarkerState[]): GeoPoint {
        if (states.length === 0) return createGeoPoint({ latitude: 0, longitude: 0 });
        let sumLat = 0;
        let sumLon = 0;
        for (const state of states) {
            sumLat += state.position.latitude;
            sumLon += state.position.longitude;
        }
        return createGeoPoint({ latitude: sumLat / states.length, longitude: sumLon / states.length });
    }

    /**
     * `clusterState` のメンバーが対応づけられている中心の平均。
     * どれも分からないときは null（そのマーカーはアニメーション無しで切り替わる）。
     */
    averageOfMemberCenters(
        clusterState: MarkerState,
        centers: ReadonlyMap<string, GeoPoint>,
    ): GeoPoint | null {
        const markerIds = (clusterState.extra as unknown as MarkerCluster | null)?.markerIds;
        if (!markerIds || markerIds.length === 0) return null;
        let sumLat = 0;
        let sumLon = 0;
        let count = 0;
        for (const id of markerIds) {
            const center = centers.get(id);
            if (!center) continue;
            sumLat += center.latitude;
            sumLon += center.longitude;
            count++;
        }
        if (count === 0) return null;
        return createGeoPoint({ latitude: sumLat / count, longitude: sumLon / count });
    }

    calculateClusterRadiusMeters(center: GeoPoint, members: MarkerState[]): number {
        let max = 0;
        for (const member of members) {
            const distance = Spherical.computeDistanceBetween(center, member.position);
            if (distance > max) max = distance;
        }
        return max;
    }

    /**
     * 位置だけの指紋。前回の描画からマーカーが動いたかを見るために使う。
     * マーカー全体を見る `MarkerFingerPrint` とは別物。
     */
    positionFingerPrint(position: GeoPointInterface): string {
        return `${position.latitude}_${position.longitude}`;
    }

    /** 投影座標の凸包（Andrew's monotone chain）。3 点未満に潰れる場合は空を返す。 */
    convexHullProjected(members: MarkerState[], zoom: number): HullPoint[] {
        if (members.length < 3) return [];

        // Deduplicate by rounding to 3 decimal places.
        const seen = new Set<string>();
        const points: HullPoint[] = [];
        for (const member of members) {
            const [x, y] = this.projectToPixel(member.position, zoom);
            const key = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push({ x, y });
        }
        if (points.length < 3) return [];

        points.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));

        const cross = (o: HullPoint, a: HullPoint, b: HullPoint): number =>
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

        const lower: HullPoint[] = [];
        for (const point of points) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
                lower.pop();
            }
            lower.push(point);
        }

        const upper: HullPoint[] = [];
        for (const point of [...points].reverse()) {
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
                upper.pop();
            }
            upper.push(point);
        }

        // Drop the last point of each half (duplicate of the other's first).
        const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
        return hull.length >= 3 ? hull : [];
    }

    /** 靴ひも公式による多角形重心。面積が潰れている場合は頂点平均へ落とす。 */
    polygonCentroidProjected(hull: HullPoint[]): HullPoint | null {
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
            // Degenerate — fall back to the average.
            return {
                x: hull.reduce((sum, point) => sum + point.x, 0) / hull.length,
                y: hull.reduce((sum, point) => sum + point.y, 0) / hull.length,
            };
        }

        return { x: cx / (3.0 * twiceArea), y: cy / (3.0 * twiceArea) };
    }
}
