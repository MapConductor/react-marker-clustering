[English](./README.md) | [日本語](./README.ja.md) | Español (Latinoamérica)

# @mapconductor/react-marker-clustering

Extensión de agrupación de marcadores (clustering) para el SDK de React de MapConductor. Agrupa marcadores cercanos en clústeres dentro de cualquier vista de mapa de proveedor (`react-for-googlemaps`, `react-for-maplibre`, `react-for-here`, …), con íconos de clúster personalizados, manejo de clics y transiciones animadas de expansión/contracción. Funciona en la web y, mediante los módulos de Android/iOS incluidos, en React Native.

## Instalación

```shell
npm install @mapconductor/react-marker-clustering
```

`@mapconductor/js-sdk-core` y `@mapconductor/js-sdk-react` se instalan automáticamente como dependencias. Tu código importa directamente de ambos, así que con el `node_modules` estricto (aislado) de pnpm — o siempre que prefieras declarar todo lo que importas — instálalos explícitamente:

```shell
npm install @mapconductor/react-marker-clustering @mapconductor/js-sdk-core @mapconductor/js-sdk-react
```

También necesitas un paquete de proveedor (cualquier `@mapconductor/react-for-*`) para alojar la vista de mapa.

## Inicio rápido

El ejemplo usa MapLibre, pero el grupo de clústeres funciona sin cambios dentro de cualquier vista de proveedor:

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

El ejemplo de oficinas de correo de `examples/basic` agrupa 24,526 marcadores de esta manera.

## Resumen de la API

- `MarkerClusterGroup` — agrupa los `markers` dados (un arreglo de `MarkerState` de `@mapconductor/js-sdk-core`). Props principales:
  - `clusterRadiusPx`, `minClusterSize`, `expandMargin`, `tileSize`, `cameraIdleDebounceMs` — comportamiento del clustering
  - `clusterIconProvider` — provee tu propio ícono según el tamaño del clúster
  - `onClusterClick` — recibe un `MarkerCluster` (`count`, `markerIds`); los handlers típicos acercan la cámara
  - `enableZoomAnimation`, `enablePanAnimation`, `zoomAnimationDurationMs` — transiciones animadas de clústeres
  - `debugHullPolygons` — visualiza los contornos de los clústeres durante el ajuste
- `MarkerClusterStrategy` — el motor de clustering subyacente, utilizable directamente para integraciones personalizadas; los valores por defecto exportados (`DEFAULT_CLUSTER_RADIUS_PX`, …) documentan el ajuste integrado.

## Paquetes relacionados

- [`@mapconductor/js-sdk-core`](../js-sdk-core) — primitivas de geometría, cámara y estado
- [`@mapconductor/js-sdk-react`](../js-sdk-react) — `Marker`, `Markers`, formas y burbujas de información compartidos
- `@mapconductor/react-for-*` — paquetes de proveedor (Google Maps, MapLibre, Mapbox, Leaflet, OpenLayers, ArcGIS, Cesium, HERE)
