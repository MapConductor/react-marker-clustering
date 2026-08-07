import { createPolygonState, type PolygonState } from '@mapconductor/js-sdk-core';
import type { MarkerClusterDebugInfo } from './MarkerCluster';

// Debug hull polygon styling. Fixed rather than configurable: `debugHullPolygons`
// is the only debug knob the public API exposes on all three platforms.
const DEBUG_HULL_STROKE_WIDTH = 2;
const DEBUG_HULL_STROKE_ALPHA = 0.8;
const DEBUG_HULL_FILL_ALPHA = 0.18;

const DEBUG_HULL_PALETTE = [
    '#E53935', // red
    '#D81B60', // pink
    '#8E24AA', // purple
    '#5E35B1', // deep purple
    '#3949AB', // indigo
    '#1E88E5', // blue
    '#039BE5', // light blue
    '#00ACC1', // cyan
    '#00897B', // teal
    '#43A047', // green
    '#7CB342', // light green
    '#FDD835', // yellow
    '#FFB300', // amber
    '#FB8C00', // orange
];

function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/** Java's `String.hashCode()`, so colour assignment matches Android exactly. */
function javaStringHashCode(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
    }
    return hash;
}

/**
 * Picks a palette colour per grid cell, avoiding the colours already used by the
 * eight neighbouring cells so adjacent hulls stay visually distinct.
 * Ports `assignDistinctDebugColors()` from the Android SDK.
 */
function assignDistinctDebugColors(infos: MarkerClusterDebugInfo[]): Map<string, string> {
    const result = new Map<string, string>();
    if (infos.length === 0) return result;

    const sorted = [...infos].sort((a, b) => (a.cellX !== b.cellX ? a.cellX - b.cellX : a.cellY - b.cellY));

    for (const info of sorted) {
        const used = new Set<string>();
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const neighbor = result.get(`${info.cellX + dx},${info.cellY + dy}`);
                if (neighbor) used.add(neighbor);
            }
        }
        const start = (javaStringHashCode(info.id) & 0x7fffffff) % DEBUG_HULL_PALETTE.length;
        let chosen: string | null = null;
        for (let i = 0; i < DEBUG_HULL_PALETTE.length; i++) {
            const candidate = DEBUG_HULL_PALETTE[(start + i) % DEBUG_HULL_PALETTE.length];
            if (!used.has(candidate)) {
                chosen = candidate;
                break;
            }
        }
        result.set(`${info.cellX},${info.cellY}`, chosen ?? DEBUG_HULL_PALETTE[start]);
    }

    return result;
}

export function buildHullPolygonStates(debugInfos: MarkerClusterDebugInfo[]): PolygonState[] {
    const drawable = debugInfos.filter((info) => info.hullPoints.length >= 3);
    if (drawable.length === 0) return [];
    const colorsByCell = assignDistinctDebugColors(debugInfos);
    return drawable.map((info) => {
        const base = colorsByCell.get(`${info.cellX},${info.cellY}`) ?? '#FF00FF';
        return createPolygonState({
            id: `cluster-hull-${info.id}`,
            points: info.hullPoints,
            strokeColor: hexToRgba(base, DEBUG_HULL_STROKE_ALPHA),
            strokeWidth: DEBUG_HULL_STROKE_WIDTH,
            fillColor: hexToRgba(base, DEBUG_HULL_FILL_ALPHA),
            geodesic: false,
            zIndex: 9,
        });
    });
}
