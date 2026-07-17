import React, { useCallback, useEffect, useMemo, useReducer } from 'react';
import { Platform } from 'react-native';
import { createGeoPoint, type MarkerState } from '@mapconductor/js-sdk-core';
import {
    MapViewScope,
    MapViewScopeProvider,
    encodeMarkerBatch,
    markerIconToNative,
    useNativeMapExtension,
    type NativeMapExtensionDescriptor,
    type NativeMapExtensionEvent,
} from '@mapconductor/js-sdk-react/native';
import type { MarkerCluster, MarkerClusterIconOptions } from './MarkerCluster';
import type { ClusterIconProvider } from './MarkerClusterStrategy';

export interface MarkerClusterGroupProps {
    markers?: MarkerState[];
    children?: React.ReactNode;
    clusterRadiusPx?: number;
    minClusterSize?: number;
    expandMargin?: number;
    clusterIcon?: MarkerClusterIconOptions;
    /**
     * On Android, the returned native image is used as a background template. The native
     * cluster provider draws the current count over it using the post-office cluster layout.
     */
    clusterIconProvider?: ClusterIconProvider;
    onClusterClick?: ((cluster: MarkerCluster) => void) | null;
    enableZoomAnimation?: boolean;
    enablePanAnimation?: boolean;
    zoomAnimationDurationMs?: number;
    debugHullPolygons?: boolean;
    cameraIdleDebounceMs?: number;
    tileSize?: number;
}

let nextGroupId = 1;

export function MarkerClusterGroup(props: MarkerClusterGroupProps): React.ReactElement | null {
    if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
        return <>{props.children ?? null}</>;
    }
    return <NativeMarkerClusterGroup {...props} />;
}

function NativeMarkerClusterGroup(props: MarkerClusterGroupProps): React.ReactElement | null {
    const {
        markers,
        children,
        clusterRadiusPx,
        minClusterSize,
        expandMargin,
        clusterIcon,
        clusterIconProvider,
        onClusterClick,
        enableZoomAnimation,
        enablePanAnimation,
        zoomAnimationDurationMs,
        debugHullPolygons,
        cameraIdleDebounceMs,
        tileSize,
    } = props;
    const localScope = useMemo(() => new MapViewScope(), []);
    const groupId = useMemo(() => `marker-cluster-${nextGroupId++}`, []);
    const [revision, invalidate] = useReducer((value: number) => value + 1, 0);

    useEffect(() => {
        const unsubscribe = localScope.markerCollector.subscribe(() => {
            if (markers === undefined) invalidate();
        });
        localScope.markerCollector.setUpdateHandler(() => {
            if (markers === undefined) invalidate();
        });
        return () => {
            unsubscribe();
            localScope.markerCollector.setUpdateHandler(null);
        };
    }, [localScope, markers]);

    useEffect(() => {
        if (markers === undefined) return undefined;
        return subscribeMarkers(markers, invalidate);
    }, [markers]);

    const resolvedMarkers = markers ?? localScope.markerCollector.values();
    const nativeClusterIcon = useMemo(
        () => markerIconToNative(clusterIconProvider?.(0) ?? null),
        [clusterIconProvider],
    );
    const nativeMarkers = useMemo(() => {
        // Reading revision makes observable in-place MarkerState updates invalidate both views.
        void revision;
        return {
            batch: encodeMarkerBatch(resolvedMarkers),
            byId: new Map(resolvedMarkers.map((marker) => [marker.id, marker])),
        };
    }, [resolvedMarkers, revision]);

    const extension = useMemo<NativeMapExtensionDescriptor>(() => ({
        id: groupId,
        type: 'marker-clustering',
        payload: {
            markers: nativeMarkers.batch,
            options: {
                clusterRadiusPx,
                minClusterSize,
                expandMargin,
                clusterIcon,
                clusterIconProvider: nativeClusterIcon,
                onClusterClickEnabled: onClusterClick != null,
                enableZoomAnimation,
                enablePanAnimation,
                zoomAnimationDurationMs,
                debugHullPolygons,
                cameraIdleDebounceMs,
                tileSize,
            },
        },
    }), [
        groupId,
        nativeMarkers.batch,
        clusterRadiusPx,
        minClusterSize,
        expandMargin,
        clusterIcon,
        nativeClusterIcon,
        onClusterClick,
        enableZoomAnimation,
        enablePanAnimation,
        zoomAnimationDurationMs,
        debugHullPolygons,
        cameraIdleDebounceMs,
        tileSize,
    ]);

    const handleEvent = useCallback((event: NativeMapExtensionEvent) => {
        if (event.eventName === 'clusterClick') {
            const count = typeof event.payload.count === 'number' ? event.payload.count : 0;
            const markerIds = Array.isArray(event.payload.markerIds)
                ? event.payload.markerIds.filter((id): id is string => typeof id === 'string')
                : [];
            onClusterClick?.({ count, markerIds });
            return;
        }

        const markerId = event.payload.markerId;
        if (typeof markerId !== 'string') return;
        const marker = nativeMarkers.byId.get(markerId);
        if (!marker) return;
        const latitude = event.payload.latitude;
        const longitude = event.payload.longitude;
        if (
            event.eventName.startsWith('markerDrag') &&
            typeof latitude === 'number' &&
            typeof longitude === 'number'
        ) {
            marker.position = createGeoPoint({ latitude, longitude });
        }
        if (event.eventName === 'markerClick') marker.onClick?.(marker);
        if (event.eventName === 'markerDragStart') marker.onDragStart?.(marker);
        if (event.eventName === 'markerDrag') marker.onDrag?.(marker);
        if (event.eventName === 'markerDragEnd') marker.onDragEnd?.(marker);
    }, [nativeMarkers.byId, onClusterClick]);

    useNativeMapExtension(extension, handleEvent);

    return (
        <MapViewScopeProvider scope={localScope}>
            {children ?? null}
        </MapViewScopeProvider>
    );
}

function subscribeMarkers(markers: MarkerState[], invalidate: () => void): () => void {
    const unsubscribers = markers.map((state) => state.asObservable().subscribe(invalidate));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
