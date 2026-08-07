export type { MarkerCluster, MarkerClusterDebugInfo, SpiderfyLeg } from './MarkerCluster';
export {
    MarkerClusterStrategy,
    DEFAULT_CLUSTER_RADIUS_PX,
    DEFAULT_MIN_CLUSTER_SIZE,
    DEFAULT_EXPAND_MARGIN,
    DEFAULT_TILE_SIZE,
    DEFAULT_CAMERA_DEBOUNCE_MILLIS,
    DEFAULT_ZOOM_ANIMATION_DURATION_MILLIS,
    DEFAULT_SPIDERFY_MARKER_SIZE_PX,
    DEFAULT_SPIDERFY_MARKER_MARGIN_PX,
    DEFAULT_ICON_PROVIDER,
    type ClusterIconProvider,
    type ClusterIconProviderWithTurn,
    type MarkerClusterOptions,
} from './MarkerClusterStrategy';
// レンダラ本体は js-sdk-core へ移した（プロバイダが MarkerRenderingSupport 経由で配るため、
// プロバイダがクラスタリングパッケージに依存しないようにする必要がある）。
// 旧名での import を壊さないよう別名で再エクスポートする。
export { CollectorMarkerOverlayRenderer as ClusterMarkerOverlayRenderer } from '@mapconductor/js-sdk-core';
export { MutableStateFlow, type StateFlow } from './StateFlow';
export {
    MarkerClusterGroup,
    DEFAULT_SPIDERFY_LEG_COLOR,
    DEFAULT_SPIDERFY_LEG_WIDTH,
    type MarkerClusterGroupProps,
} from './MarkerClusterGroup';
