[English](./README.md) | 日本語 | [Español (Latinoamérica)](./README.es-419.md)

# @mapconductor/react-marker-clustering

MapConductor React SDK のマーカークラスタリング拡張です。近接するマーカーをクラスターにまとめ、任意のプロバイダのマップビュー(`react-for-googlemaps`、`react-for-maplibre`、`react-for-here` など)の中に描画します。カスタムクラスターアイコン、クリックハンドリング、展開/収縮のアニメーションに対応します。Web と、同梱の Android/iOS モジュールを通じて React Native の両方で動作します。

## インストール

```shell
npm install @mapconductor/react-marker-clustering
```

`@mapconductor/js-sdk-core` と `@mapconductor/js-sdk-react` は依存関係として自動的にインストールされます。ただしアプリケーションコードはこの2つから直接 import するため、pnpm の strict(isolated)な `node_modules` を使う場合や、import するものをすべて明示的に宣言したい場合は、次のように明示的にインストールしてください:

```shell
npm install @mapconductor/react-marker-clustering @mapconductor/js-sdk-core @mapconductor/js-sdk-react
```

マップビューをホストするプロバイダパッケージ(いずれかの `@mapconductor/react-for-*`)も必要です。

## クイックスタート

以下は MapLibre の例ですが、クラスターグループはどのプロバイダビューでもそのまま動作します:

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

`examples/basic` の郵便局サンプルは、この方法で 24,526 件のマーカーをクラスタリングしています。

## API 概要

- `MarkerClusterGroup` — 渡した `markers`(`@mapconductor/js-sdk-core` の `MarkerState` 配列)をクラスタリングします。主な props:
  - `clusterRadiusPx`、`minClusterSize`、`expandMargin`、`tileSize`、`cameraIdleDebounceMs` — クラスタリングの挙動
  - `clusterIconProvider` — クラスターのサイズに応じた独自アイコンの提供
  - `onClusterClick` — `MarkerCluster`(`count`、`markerIds`)を受け取ります。典型的なハンドラはカメラをズームインさせます
  - `enableZoomAnimation`、`enablePanAnimation`、`zoomAnimationDurationMs` — クラスター遷移のアニメーション
  - `debugHullPolygons` — チューニング時にクラスターの外周を可視化
- `MarkerClusterStrategy` — 基盤となるクラスタリングエンジン。カスタム統合で直接使用できます。エクスポートされたデフォルト値(`DEFAULT_CLUSTER_RADIUS_PX` など)が組み込みのチューニングを示します。

## 関連パッケージ

- [`@mapconductor/js-sdk-core`](../js-sdk-core) — ジオメトリ・カメラ・状態のプリミティブ
- [`@mapconductor/js-sdk-react`](../js-sdk-react) — 共有の `Marker`・`Markers`・シェイプ・インフォバブル
- `@mapconductor/react-for-*` — プロバイダパッケージ(Google Maps、MapLibre、Mapbox、Leaflet、OpenLayers、ArcGIS、Cesium、HERE)
