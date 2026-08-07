import { ColorDefaultIcon, type HexGeocell, type MarkerIcon, type MarkerState } from '@mapconductor/js-sdk-core';
import type { MarkerCluster } from './MarkerCluster';

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_CLUSTER_RADIUS_PX = 90.0;
export const DEFAULT_MIN_CLUSTER_SIZE = 3;
export const DEFAULT_EXPAND_MARGIN = 0.2;
export const DEFAULT_TILE_SIZE = 256.0;
export const DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS = 300;
export const DEFAULT_CAMERA_DEBOUNCE_MILLIS = 100;
export const DEFAULT_SPIDERFY_MARKER_SIZE_PX = 52.0;
export const DEFAULT_SPIDERFY_MARKER_MARGIN_PX = 8.0;

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClusterIconProvider = (count: number) => MarkerIcon;
export type ClusterIconProviderWithTurn = (count: number, turn: number) => MarkerIcon;

export const DEFAULT_ICON_PROVIDER: ClusterIconProvider = (count) =>
    new ColorDefaultIcon({ fillColor: '#2563EB', label: String(count) });

export interface MarkerClusterOptions {
    clusterRadiusPx?: number;
    minClusterSize?: number;
    expandMargin?: number;
    clusterIconProvider?: ClusterIconProvider;
    /** Takes precedence over `clusterIconProvider`; `turn` increments on every zoom change. */
    clusterIconProviderWithTurn?: ClusterIconProviderWithTurn | null;
    onClusterClick?: ((cluster: MarkerCluster) => void) | null;
    /**
     * Called before newly appearing individual (non-cluster) markers are
     * rendered — e.g. when a cluster expands after a zoom. Applying the new
     * cluster state is deferred until the returned promise settles, so the app
     * can preload marker icon images (and show a loading indicator) before the
     * markers pop in. A newer recluster supersedes any pending deferred apply.
     */
    prepareExpand?: ((appearing: MarkerState[]) => Promise<void>) | null;
    /**
     * At or above this zoom, clicking a cluster fans its members out around the
     * (kept) cluster marker, connected by leg polylines — useful when multiple
     * markers share the same location and can never be separated by zooming.
     * Clicking the same cluster again, or any recluster (camera move / data
     * change), collapses the fan. Below this zoom the click falls through to
     * `onClusterClick`. Undefined disables the feature.
     */
    spiderfyMinZoom?: number | null;
    /** Marker diameter in px used by the overlap-avoiding spiderfy layout. */
    spiderfyMarkerSizePx?: number;
    /** Extra gap between fanned-out markers in px. */
    spiderfyMarkerMarginPx?: number;
    /**
     * Called when a spiderfy fan opens (true) or collapses (false) — e.g. to
     * close an info bubble when the user clicks another cluster or the fan is
     * dismissed by a camera move.
     */
    onSpiderfyChange?: ((open: boolean) => void) | null;
    enableZoomAnimation?: boolean;
    enablePanAnimation?: boolean;
    zoomAnimationDurationMillis?: number;
    /**
     * Accepted for parity with the Android strategy, which likewise ignores it:
     * hull points are always computed, and `MarkerClusterGroup` decides whether
     * to draw them.
     */
    debugHullPolygons?: boolean;
    cameraIdleDebounceMillis?: number;
    tileSize?: number;
    geocell?: HexGeocell;
}
