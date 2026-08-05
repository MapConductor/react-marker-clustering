English | [日本語](./README.ja.md) | [Español (Latinoamérica)](./README.es-419.md)

# @mapconductor/react-marker-clustering

Marker clustering extension for the MapConductor React SDK. Groups nearby
markers into clusters inside any provider map view (`react-for-googlemaps`,
`react-for-maplibre`, `react-for-here`, …), with custom cluster icons, click
handling, and animated expand/shrink transitions. Works on the web and,
through the bundled Android/iOS modules, in React Native.

## Installation

```shell
npm install @mapconductor/react-marker-clustering
```

`@mapconductor/js-sdk-core` and `@mapconductor/js-sdk-react` are installed
automatically as dependencies. Your code imports from them directly, so with
pnpm's strict (isolated) `node_modules` — or whenever you prefer to declare
everything you import — install them explicitly instead:

```shell
npm install @mapconductor/react-marker-clustering @mapconductor/js-sdk-core @mapconductor/js-sdk-react
```

You also need a provider package (any `@mapconductor/react-for-*`) to host the
map view.

## Quick start

The example uses MapLibre, but the cluster group works unchanged inside any
provider view:

```tsx
import { useMemo } from 'react';
import {
  createGeoPoint,
  createMapCameraPosition,
  createMarkerState,
} from '@mapconductor/js-sdk-core';
import { MarkerClusterGroup } from '@mapconductor/react-marker-clustering';
import {
  MapLibreDesign,
  MapLibreMapView2D,
  useMapLibreViewState,
} from '@mapconductor/react-for-maplibre';
import '@mapconductor/react-for-maplibre/style.css';

const POSITIONS: [number, number][] = [
  [35.6812, 139.7671],
  [35.6815, 139.7665],
  [35.6820, 139.7660],
  [35.6896, 139.7006],
  [35.6586, 139.7454],
];

export function App() {
  const state = useMapLibreViewState({
    mapDesignType: MapLibreDesign.OsmBrightJa,
    cameraPosition: createMapCameraPosition({
      position: createGeoPoint({ latitude: 35.6812, longitude: 139.7671 }),
      zoom: 11,
    }),
  });
  const markers = useMemo(
    () =>
      POSITIONS.map(([latitude, longitude], i) =>
        createMarkerState({
          id: `m-${i}`,
          position: createGeoPoint({ latitude, longitude }),
        }),
      ),
    [],
  );

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <MapLibreMapView2D state={state}>
        <MarkerClusterGroup
          markers={markers}
          minClusterSize={2}
          clusterRadiusPx={80}
          enableZoomAnimation
          onClusterClick={cluster => console.log(cluster.count, 'markers in cluster')}
        />
      </MapLibreMapView2D>
    </div>
  );
}
```

The `examples/basic` post-office sample clusters 24,526 markers this way.

## API overview

The props mirror `MarkerClusterGroupState` in the Android SDK one-for-one —
same names, same defaults, same meaning.

- `MarkerClusterGroup` — clusters the given `markers` (an array of
  `MarkerState` from `@mapconductor/js-sdk-core`). Key props:
  - `clusterRadiusPx`, `minClusterSize`, `expandMargin`, `tileSize`,
    `cameraIdleDebounceMillis` — clustering behavior
  - `clusterIconProvider` / `clusterIconProviderWithTurn` — supply your own
    cluster icon per cluster size (the latter also receives the zoom turn)
  - `onClusterClick` — receives a `MarkerCluster` (`count`, `markerIds`);
    typical handlers zoom the camera in
  - `spiderfyMinZoom`, `spiderfyMarkerSizePx`, `spiderfyMarkerMarginPx`,
    `spiderfyLegColor`, `spiderfyLegWidth`, `onSpiderfyChange` — click a cluster
    to fan its members out, for markers that share a location
  - `prepareExpand` — preload icons before newly appearing markers pop in
  - `enableZoomAnimation`, `enablePanAnimation`,
    `zoomAnimationDurationMillis` — animated cluster transitions
  - `trackMarkerUpdates` (default `true`) — re-cluster when the app mutates a
    `MarkerState` in place (`markerState.position = …`)
  - `debugHullPolygons` — visualize cluster hulls while tuning
- `MarkerClusterStrategy` — the clustering engine. It owns the whole pipeline
  (source states, camera debouncing, clustering, animation, spiderfy) and
  renders through a `MarkerOverlayRenderer`, exactly as on Android; the
  component only feeds it markers and camera events. Usable directly for custom
  integrations, together with `ClusterMarkerOverlayRenderer` and
  `StrategyMarkerController`. Exported defaults (`DEFAULT_CLUSTER_RADIUS_PX`, …)
  document the built-in tuning.

## Related packages

- [`@mapconductor/js-sdk-core`](../js-sdk-core) — geometry, camera, and state primitives
- [`@mapconductor/js-sdk-react`](../js-sdk-react) — shared `Marker`, `Markers`, shapes, and info bubbles
- `@mapconductor/react-for-*` — provider packages (Google Maps, MapLibre, Mapbox, Leaflet, OpenLayers, ArcGIS, Cesium, HERE)
