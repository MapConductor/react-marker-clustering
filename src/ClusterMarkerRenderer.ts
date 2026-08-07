import {
    createMarkerEntity,
    fingerPrintEquals,
    type AddParams,
    type BitmapIcon,
    type ChangeParams,
    type GeoPoint,
    type MarkerEntity,
    type MarkerManager,
    type MarkerOverlayRenderer,
    type MarkerState,
} from '@mapconductor/js-sdk-core';
import { CLUSTER_ID_PREFIX } from './ClusterBuilder';
import type { ClusterGeometry } from './ClusterGeometry';
import type { AnimatedMove, ClusterMarkerAnimator } from './ClusterMarkerAnimator';

/** `cluster_{zoom}_{x}_{y}` を `_` で割った要素数。 */
const CLUSTER_ID_PART_COUNT = 4;

interface AnimatedRemove {
    entity: MarkerEntity<MarkerState>;
    target: GeoPoint;
}

interface AnimatedAdd {
    state: MarkerState;
    start: GeoPoint;
}

export interface UpdateRenderedMarkersParams {
    desiredStates: MarkerState[];
    renderer: MarkerOverlayRenderer<MarkerState>;
    token: number;
    animateTransitions: boolean;
    previousClusterMemberCenters: ReadonlyMap<string, GeoPoint>;
    nextClusterMemberCenters: ReadonlyMap<string, GeoPoint>;
}

/**
 * 計画された最終形（`ClusterPlan` から作られたマーカー列）に、実際の描画を合わせる部分。
 *
 * 追加・更新・削除の差分を取り、アニメーションが要るものは
 * `ClusterMarkerAnimator` に渡す。**どれをクラスタにするかは決めない** —
 * それは `ClusterPlanner` の担当で、ここは「今出ているもの」と
 * 「出したいもの」の差を埋めるだけ。
 *
 * android-sdk の `ClusterMarkerRenderer.kt` /
 * ios-sdk の `MarkerClusterStrategy+Rendering.swift` と同じ差分の取り方。
 */
export class ClusterMarkerRenderer {
    constructor(
        private readonly geometry: ClusterGeometry,
        private readonly animator: ClusterMarkerAnimator,
        private readonly markerManager: MarkerManager<MarkerState>,
        private readonly renderedMarkerEntities: Map<string, MarkerEntity<MarkerState>>,
        private readonly defaultMarkerIcon: BitmapIcon,
        private readonly zoomAnimationDurationMillis: number,
        /** 呼び出し時のトークンがまだ最新か。古くなったら描画を打ち切る。 */
        private readonly isCurrent: (token: number) => boolean,
    ) {}

    async updateRenderedMarkers(params: UpdateRenderedMarkersParams): Promise<void> {
        const {
            desiredStates, renderer, token, animateTransitions,
            previousClusterMemberCenters, nextClusterMemberCenters,
        } = params;

        const desiredById = new Map(desiredStates.map((state) => [state.id, state]));
        const animateZoom = animateTransitions && this.zoomAnimationDurationMillis > 0;

        if (!animateZoom) {
            await this.removeOrphansBeforeDiff(desiredById, renderer);
        }

        const existingById = new Map(
            this.markerManager.allEntities().map((entity) => [entity.state.id, entity]),
        );

        const removeIds = [...existingById.keys()].filter((id) => !desiredById.has(id));
        const addStates = desiredStates.filter((state) => !existingById.has(state.id));
        const updateStates = desiredStates.filter((state) => existingById.has(state.id));

        const animatedRemoveEntries: AnimatedRemove[] = animateZoom
            ? this.planAnimatedRemoves(removeIds, existingById, nextClusterMemberCenters)
            : [];
        const animatedRemoveIds = new Set(animatedRemoveEntries.map((entry) => entry.entity.state.id));

        const animatedAddEntries: AnimatedAdd[] = animateZoom
            ? this.planAnimatedAdds(addStates, previousClusterMemberCenters)
            : [];
        const animatedAddIds = new Set(animatedAddEntries.map((entry) => entry.state.id));

        let didImmediateChange = false;
        if (await this.applyImmediateRemoves(removeIds.filter((id) => !animatedRemoveIds.has(id)), renderer)) {
            didImmediateChange = true;
        }
        const immediateAddStates = addStates.filter((state) => !animatedAddIds.has(state.id));
        if (immediateAddStates.length > 0) {
            await this.addStatesToRenderer(immediateAddStates, renderer);
            didImmediateChange = true;
        }
        if (await this.applyUpdates(updateStates, existingById, renderer)) {
            didImmediateChange = true;
        }

        if (didImmediateChange) {
            await renderer.onPostProcess();
        }

        if (!animateZoom || (animatedRemoveEntries.length === 0 && animatedAddEntries.length === 0)) {
            return;
        }
        if (!this.isCurrent(token)) return;

        await this.runTransitionAnimation(animatedAddEntries, animatedRemoveEntries, renderer, token);
    }

    /**
     * アニメーションしない回は、差分を取る前に「消えるもの」を先に消してしまう。
     *
     * 先に消しておかないと、同じ ID が再登場したときに前の実マーカーが残り、
     * 二重に出たまま参照だけ差し替わって回収できなくなる。
     */
    private async removeOrphansBeforeDiff(
        desiredById: ReadonlyMap<string, MarkerState>,
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<void> {
        const orphaned = this.markerManager.allEntities()
            .filter((entity) => !desiredById.has(entity.state.id))
            .map((entity) => this.renderedMarkerEntities.get(entity.state.id))
            .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
        if (orphaned.length === 0) return;
        await renderer.onRemove(orphaned);
        for (const entity of orphaned) this.dropEntity(entity.state.id);
        await renderer.onPostProcess();
    }

    /**
     * 消えるマーカーの行き先を決める。クラスタが消える場合は、
     * そのメンバーたちの新しい行き先の平均へ吸い込ませる。
     */
    private planAnimatedRemoves(
        removeIds: string[],
        existingById: ReadonlyMap<string, MarkerEntity<MarkerState>>,
        nextClusterMemberCenters: ReadonlyMap<string, GeoPoint>,
    ): AnimatedRemove[] {
        return removeIds.flatMap((id) => {
            const entity = existingById.get(id);
            if (!entity) return [];
            const target = id.startsWith(CLUSTER_ID_PREFIX)
                ? this.geometry.averageOfMemberCenters(entity.state, nextClusterMemberCenters)
                : nextClusterMemberCenters.get(id) ?? null;
            return target ? [{ entity, target }] : [];
        });
    }

    /** 出てくるマーカーの出発点を決める。クラスタなら、前回のメンバー位置の平均から広がる。 */
    private planAnimatedAdds(
        addStates: MarkerState[],
        previousClusterMemberCenters: ReadonlyMap<string, GeoPoint>,
    ): AnimatedAdd[] {
        return addStates.flatMap((state) => {
            const start = state.id.startsWith(CLUSTER_ID_PREFIX)
                ? this.geometry.averageOfMemberCenters(state, previousClusterMemberCenters)
                : previousClusterMemberCenters.get(state.id) ?? null;
            return start ? [{ state, start }] : [];
        });
    }

    private async applyImmediateRemoves(
        ids: string[],
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<boolean> {
        if (ids.length === 0) return false;
        const removedEntities = ids
            .map((id) => this.renderedMarkerEntities.get(id))
            .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
        if (removedEntities.length === 0) return false;
        await renderer.onRemove(removedEntities);
        for (const entity of removedEntities) this.dropEntity(entity.state.id);
        return true;
    }

    /** 位置や見た目が変わったものだけを `onChange` に載せる（指紋が同じものは飛ばす）。 */
    private async applyUpdates(
        updateStates: MarkerState[],
        existingById: ReadonlyMap<string, MarkerEntity<MarkerState>>,
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<boolean> {
        const changeParams: ChangeParams<MarkerState>[] = [];
        for (const state of updateStates) {
            const prev = existingById.get(state.id);
            if (!prev) continue;
            const nextEntity = createMarkerEntity<MarkerState>({
                marker: prev.marker,
                state,
                isRendered: true,
            });
            this.markerManager.registerEntity(nextEntity);

            if (fingerPrintEquals(prev.fingerPrint, state.fingerPrint())) continue;

            changeParams.push({
                current: nextEntity,
                prev,
                bitmapIcon: state.icon?.toBitmapIcon() ?? this.defaultMarkerIcon,
            });
        }

        if (changeParams.length === 0) return false;

        const actualMarkers = await renderer.onChange(changeParams);
        actualMarkers.forEach((actual, index) => {
            if (actual == null) return;
            const entity = createMarkerEntity<MarkerState>({
                marker: actual,
                state: changeParams[index].current.state,
                isRendered: true,
            });
            this.markerManager.registerEntity(entity);
            this.renderedMarkerEntities.set(entity.state.id, entity);
        });
        return true;
    }

    /**
     * 出発点に置いてから目的地へ動かし、消えるものは動かし終えてから消す。
     *
     * 追い越されて途中で止まった場合は、出発点に置いたばかりのマーカーを
     * 取り下げる（放置すると出発点に取り残される）。
     */
    private async runTransitionAnimation(
        animatedAddEntries: AnimatedAdd[],
        animatedRemoveEntries: AnimatedRemove[],
        renderer: MarkerOverlayRenderer<MarkerState>,
        token: number,
    ): Promise<void> {
        let animatedStartEntities: MarkerEntity<MarkerState>[] = [];
        if (animatedAddEntries.length > 0) {
            animatedStartEntities = await this.addStatesToRenderer(
                animatedAddEntries.map((entry) => entry.state.copy({ position: entry.start })),
                renderer,
            );
            await renderer.onPostProcess();
        }

        const moves: AnimatedMove[] = [];
        for (const entry of animatedAddEntries) {
            const entity = this.markerManager.getEntity(entry.state.id);
            if (!entity) continue;
            moves.push({
                id: entry.state.id,
                start: entry.start,
                end: entry.state.position,
                baseState: entry.state,
                entity,
                restoreBaseStateAtEnd: true,
            });
        }
        for (const entry of animatedRemoveEntries) {
            moves.push({
                id: entry.entity.state.id,
                start: entry.entity.state.position,
                end: entry.target,
                baseState: entry.entity.state,
                entity: entry.entity,
                restoreBaseStateAtEnd: false,
            });
        }

        const completed = await this.animator.animate(moves, renderer, this.zoomAnimationDurationMillis, token);

        if (animatedRemoveEntries.length > 0) {
            await this.removeIfStillRendered(animatedRemoveEntries.map((entry) => entry.entity), renderer);
        }
        if (!completed && animatedStartEntities.length > 0) {
            await this.removeIfStillRendered(animatedStartEntities, renderer);
        }
    }

    private async removeIfStillRendered(
        entities: MarkerEntity<MarkerState>[],
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<void> {
        const target = entities
            .map((entity) => this.renderedMarkerEntities.get(entity.state.id))
            .filter((entity): entity is MarkerEntity<MarkerState> => entity != null);
        if (target.length === 0) return;
        await renderer.onRemove(target);
        for (const entity of target) this.dropEntity(entity.state.id);
        await renderer.onPostProcess();
    }

    async addStatesToRenderer(
        states: MarkerState[],
        renderer: MarkerOverlayRenderer<MarkerState>,
    ): Promise<MarkerEntity<MarkerState>[]> {
        if (states.length === 0) return [];
        const addParams: AddParams[] = states.map((state) => ({
            state,
            bitmapIcon: state.icon?.toBitmapIcon() ?? this.defaultMarkerIcon,
        }));
        const actualMarkers = await renderer.onAdd(addParams);
        const addedEntities: MarkerEntity<MarkerState>[] = [];
        actualMarkers.forEach((actual, index) => {
            if (actual == null) return;
            const entity = createMarkerEntity<MarkerState>({
                marker: actual,
                state: addParams[index].state,
                isRendered: true,
            });
            this.markerManager.registerEntity(entity);
            this.renderedMarkerEntities.set(entity.state.id, entity);
            addedEntities.push(entity);
        });
        return addedEntities;
    }

    /**
     * 前のズームで作られたクラスタと、元データから消えたマーカーを取り下げる。
     *
     * クラスタ ID にはズームが埋まっているので、ズームが変われば前のクラスタは
     * 必ず作り直しになる。
     */
    async cleanupStaleMarkers(
        currentZoom: number,
        renderer: MarkerOverlayRenderer<MarkerState>,
        skipClusterRemoval: boolean,
        isKnownSourceMarker: (id: string) => boolean,
    ): Promise<void> {
        const currentZoomKey = Math.round(currentZoom);
        const staleEntities: MarkerEntity<MarkerState>[] = [];

        for (const entity of this.renderedMarkerEntities.values()) {
            const id = entity.state.id;
            let isStale: boolean;
            if (id.startsWith(CLUSTER_ID_PREFIX)) {
                if (skipClusterRemoval) {
                    isStale = false;
                } else {
                    const parts = id.split('_');
                    const markerZoomKey = parts.length >= CLUSTER_ID_PART_COUNT
                        ? Number.parseInt(parts[1], 10)
                        : Number.NaN;
                    isStale = parts.length >= CLUSTER_ID_PART_COUNT &&
                        (Number.isNaN(markerZoomKey) ? -1 : markerZoomKey) !== currentZoomKey;
                }
            } else {
                isStale = !isKnownSourceMarker(id);
            }
            if (isStale) staleEntities.push(entity);
        }

        if (staleEntities.length === 0) return;
        await renderer.onRemove(staleEntities);
        for (const entity of staleEntities) this.dropEntity(entity.state.id);
        await renderer.onPostProcess();
    }

    private dropEntity(id: string): void {
        this.renderedMarkerEntities.delete(id);
        this.markerManager.removeEntity(id);
    }
}
