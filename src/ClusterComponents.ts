import type {
    BitmapIcon,
    MapCameraPosition,
    MarkerEntity,
    MarkerManager,
    MarkerOverlayRenderer,
    MarkerState,
} from '@mapconductor/js-sdk-core';
import { ClusterBuilder } from './ClusterBuilder';
import { ClusterGeometry } from './ClusterGeometry';
import { ClusterMarkerAnimator } from './ClusterMarkerAnimator';
import { ClusterMarkerRenderer } from './ClusterMarkerRenderer';
import { ClusterPlanner } from './ClusterPlanner';
import { ClusterRenderScheduler, type RenderRequest } from './ClusterRenderScheduler';
import { SpiderfyController } from './SpiderfyController';
import { SpiderfyLayout } from './SpiderfyLayout';

/** 差し替えたい部品だけを入れる。未指定のものは既定の実装が使われる。 */
export interface ClusterComponentOverrides {
    geometry?: ClusterGeometry;
    builder?: ClusterBuilder;
    planner?: ClusterPlanner;
    animator?: ClusterMarkerAnimator;
    spiderfyLayout?: SpiderfyLayout;
}

export interface ClusterComponentsOptions {
    clusterRadiusPx: number;
    tileSize: number;
    cameraIdleDebounceMillis: number;
    zoomAnimationDurationMillis: number;
    spiderfyMinZoom: number | null;
    spiderfyMarkerSizePx: number;
    spiderfyMarkerMarginPx: number;
    prepareExpand: ((appearing: MarkerState[]) => Promise<void>) | null;
    onSpiderfyChange: ((open: boolean) => void) | null;
    markerManager: MarkerManager<MarkerState>;
    renderedMarkerEntities: Map<string, MarkerEntity<MarkerState>>;
    defaultMarkerIcon: BitmapIcon;
    onRender: (request: RenderRequest) => Promise<void>;
    sourceStateProvider: (id: string) => MarkerState | undefined;
    overrides?: ClusterComponentOverrides;
}

/**
 * `MarkerClusterStrategy` が使う内部部品の組み立て。
 *
 * 部品どうしはコンストラクタで注入し合う（`ClusterBuilder` は `ClusterGeometry` を、
 * `ClusterMarkerRenderer` は `ClusterMarkerAnimator` を受け取る、など）。
 * その配線をストラテジ本体から切り離しておくことで、本体は段取りだけを持つ。
 *
 * 差し替えは `ClusterComponentOverrides` から行う。**公開オプションには出していない** —
 * 出すと android / ios / react で公開 API の形が食い違い、「同じ API」を保てなくなるため。
 */
export class ClusterComponents {
    readonly geometry: ClusterGeometry;
    readonly builder: ClusterBuilder;
    readonly planner: ClusterPlanner;
    readonly scheduler: ClusterRenderScheduler;
    readonly animator: ClusterMarkerAnimator;
    readonly markerRenderer: ClusterMarkerRenderer;
    readonly spiderfy: SpiderfyController;

    constructor(options: ClusterComponentsOptions) {
        const overrides = options.overrides ?? {};

        this.geometry = overrides.geometry ?? new ClusterGeometry(options.tileSize);
        this.builder = overrides.builder ?? new ClusterBuilder(this.geometry, options.clusterRadiusPx);
        this.planner = overrides.planner ?? new ClusterPlanner(this.geometry, this.builder);

        this.scheduler = new ClusterRenderScheduler(
            this.geometry,
            options.cameraIdleDebounceMillis,
            options.onRender,
        );

        const isCurrent = (token: number): boolean => this.scheduler.isCurrent(token);

        this.animator = overrides.animator ?? new ClusterMarkerAnimator(
            this.geometry,
            options.markerManager,
            options.renderedMarkerEntities,
            options.defaultMarkerIcon,
            isCurrent,
        );

        this.markerRenderer = new ClusterMarkerRenderer(
            this.geometry,
            this.animator,
            options.markerManager,
            options.renderedMarkerEntities,
            options.defaultMarkerIcon,
            options.zoomAnimationDurationMillis,
            isCurrent,
        );

        this.spiderfy = new SpiderfyController({
            geometry: this.geometry,
            layout: overrides.spiderfyLayout ?? new SpiderfyLayout(),
            markerManager: options.markerManager,
            renderedMarkerEntities: options.renderedMarkerEntities,
            defaultMarkerIcon: options.defaultMarkerIcon,
            minZoom: options.spiderfyMinZoom,
            markerSizePx: options.spiderfyMarkerSizePx,
            markerMarginPx: options.spiderfyMarkerMarginPx,
            prepareExpand: options.prepareExpand,
            onChange: options.onSpiderfyChange,
            cameraProvider: (): MapCameraPosition | null => this.scheduler.lastCameraPosition,
            rendererProvider: (): MarkerOverlayRenderer<MarkerState> | null => this.scheduler.lastRenderer,
            sourceStateProvider: options.sourceStateProvider,
        });
    }
}
