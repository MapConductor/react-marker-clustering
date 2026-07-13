import type { GeoPoint } from '@mapconductor/js-sdk-core';

/**
 * Represents a group of markers collapsed into a single cluster marker.
 * Stored as `MarkerState.extra` on the rendered cluster marker.
 * Mirrors `MarkerCluster.kt` in the Android SDK.
 */
export interface MarkerCluster {
    readonly count: number;
    readonly markerIds: string[];
}

/**
 * Debug information for a single cluster.
 * Emitted via `MarkerClusterStrategy.onDebugInfoChanged` when `debugHullPolygons` is true.
 * Mirrors `MarkerClusterDebugInfo.kt` in the Android SDK.
 */
export interface MarkerClusterDebugInfo {
    readonly id: string;
    readonly center: GeoPoint;
    readonly radiusMeters: number;
    readonly count: number;
    readonly cellX: number;
    readonly cellY: number;
    readonly hullPoints: GeoPoint[];
}

/** Declarative native cluster icon options. Functions cannot cross the RN bridge. */
export interface MarkerClusterIconOptions {
    fillColor?: string;
    strokeColor?: string;
    strokeWidth?: number;
    scale?: number;
    labelTextColor?: string | null;
    labelTextSize?: number;
    labelStrokeColor?: string;
    iconSize?: number;
    debug?: boolean;
}
