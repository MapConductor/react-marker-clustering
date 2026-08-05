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
 * Published through `MarkerClusterStrategy.debugInfoFlow`; `MarkerClusterGroup`
 * turns it into hull polygons when `debugHullPolygons` is enabled.
 * Mirrors `MarkerClusterDebugInfo` in the Android SDK.
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

/**
 * A leg polyline of an open spiderfy fan, connecting the cluster marker
 * (`start`) to one fanned-out member marker (`end`).
 * Mirrors `SpiderfyLeg` in the Android SDK.
 */
export interface SpiderfyLeg {
    readonly id: string;
    readonly start: GeoPoint;
    readonly end: GeoPoint;
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
