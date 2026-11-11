import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createGeoPoint,
    createGeoRectBounds,
    createMapCameraPosition,
    createMarkerState,
} from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// ClusterPlanner と ClusterRenderState: 「何をどこにまとめるか」の計画と、
// 前回の結果を次回に再利用するためのキャッシュ。描画はせず、計画の中身
// （エントリの順序・割り当て・カバー範囲・キャッシュ再利用）だけを見る。
const {
    geometry: { ClusterGeometry },
    builder: { ClusterBuilder },
    planner: { ClusterPlanner },
    renderState: { ClusterRenderState },
} = await buildSources({
    geometry: 'src/ClusterGeometry.ts',
    builder: 'src/ClusterBuilder.ts',
    planner: 'src/ClusterPlanner.ts',
    renderState: 'src/ClusterRenderState.ts',
});
const geo = new ClusterGeometry(256);
const builder = new ClusterBuilder(geo, 90);
const planner = new ClusterPlanner(geo, builder);

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });
const marker = (id, latitude, longitude) => createMarkerState({ id, position: p(latitude, longitude) });
const bounds = (s, w, n, e) => createGeoRectBounds({ southWest: p(s, w), northEast: p(n, e) });
const emptyCache = () => ({
    assignments: new Map(),
    clusterPositions: new Map(),
    coverageBounds: null,
    sourceFingerprints: new Map(),
});
const ZOOM = 10;
const VIEW = bounds(-1, -1, 1, 1);

function plan(states, cache = emptyCache(), extra = {}) {
    return planner.plan({
        sourceStates: states,
        expandedBounds: VIEW,
        zoom: ZOOM,
        effectiveRadiusPx: 90,
        zoomChanged: false,
        minClusterSize: 3,
        cache,
        ...extra,
    });
}

const toCache = (result) => ({
    assignments: result.assignments,
    clusterPositions: result.clusterPositions,
    coverageBounds: result.coverageBounds,
    sourceFingerprints: result.sourceFingerprints,
});

const fixture = () => [
    marker('a1', 0, 0), marker('a2', 0.002, 0), marker('a3', 0, 0.002),
    marker('b1', 0.5, 0.5),
    marker('c1', -0.5, -0.5), marker('c2', -0.5005, -0.5),
    marker('out', 5, 5),
];

test('minClusterSize 以上はクラスタ、未満は素通し、範囲外は無視', () => {
    const result = plan(fixture());
    const shape = result.entries.map((e) =>
        e.kind === 'cluster'
            ? ['cluster', e.cluster.members.map((m) => m.id).sort()]
            : ['singles', e.states.map((s) => s.id)]);
    // 並びはセル座標 (x, y) 順: c (西) → a → b (東)。
    assert.deepEqual(shape, [
        ['singles', ['c1', 'c2']],
        ['cluster', ['a1', 'a2', 'a3']],
        ['singles', ['b1']],
    ]);
    assert.equal(result.sourceFingerprints.has('out'), false);
    assert.equal(result.assignments.has('out'), false);
});

test('クラスタの ID・中心・半径・凸包と割り当て', () => {
    const result = plan(fixture());
    const { cluster } = result.entries.find((e) => e.kind === 'cluster');
    assert.match(cluster.id, /^cluster_10_\d+_\d+$/);
    assert.deepEqual(cluster.cell, builder.cellOf(cluster.center, ZOOM, 90));
    assert.equal(cluster.id, builder.buildClusterId(cluster.cell, ZOOM));

    // 中心は 3 点がなす三角形の面積重心（≒ 頂点平均）。
    assert.ok(Math.abs(cluster.center.latitude - 0.002 / 3) < 1e-9);
    assert.ok(Math.abs(cluster.center.longitude - 0.002 / 3) < 1e-9);
    assert.equal(cluster.hullPoints.length, 3);
    assert.equal(
        cluster.radiusMeters,
        geo.calculateClusterRadiusMeters(cluster.center, cluster.members),
    );

    for (const id of ['a1', 'a2', 'a3']) {
        assert.equal(result.assignments.get(id), cluster.id);
        assert.equal(result.clusterMemberCenters.get(id), cluster.center);
    }
    for (const id of ['b1', 'c1', 'c2']) assert.equal(result.assignments.get(id), id);
    assert.equal(result.clusterPositions.get(cluster.id), cluster.center);
    assert.equal(result.clusterMemberCenters.has('b1'), false);
});

test('coverageBounds は素通しの位置とクラスタの半径ぶんを含む', () => {
    const result = plan(fixture());
    const cov = result.coverageBounds;
    for (const id of ['b1', 'c1', 'c2', 'a1', 'a2', 'a3']) {
        const m = fixture().find((s) => s.id === id);
        assert.ok(cov.contains(m.position), `${id} is covered`);
    }
    assert.equal(cov.contains(p(5, 5)), false);
});

test('全員が同じ点にいると凸包が潰れ、中心はメンバー平均・hullPoints は空', () => {
    const result = plan([marker('x1', 0.1, 0.1), marker('x2', 0.1, 0.1), marker('x3', 0.1, 0.1)]);
    assert.equal(result.entries.length, 1);
    const { cluster } = result.entries[0];
    assert.ok(Math.abs(cluster.center.latitude - 0.1) < 1e-12);
    assert.ok(Math.abs(cluster.center.longitude - 0.1) < 1e-12);
    assert.deepEqual(cluster.hullPoints, []);
    assert.ok(cluster.radiusMeters < 1e-6);
});

test('キャッシュ: 動いていないマーカーは前回のまとまりに留まり、ズームが変われば組み直す', () => {
    // 離れた 3 点を前回 1 つのクラスタに入れていた、という状態を作る。
    const states = [marker('a1', 0, 0), marker('b1', 0.5, 0.5), marker('c1', -0.5, -0.5)];
    const cache = {
        assignments: new Map(states.map((s) => [s.id, 'cluster_10_0_0'])),
        clusterPositions: new Map([['cluster_10_0_0', p(0, 0)]]),
        coverageBounds: VIEW,
        sourceFingerprints: new Map(states.map((s) => [s.id, geo.positionFingerPrint(s.position)])),
    };

    const kept = plan(states, cache);
    assert.equal(kept.entries.length, 1);
    assert.equal(kept.entries[0].kind, 'cluster');
    assert.deepEqual(kept.entries[0].cluster.members.map((m) => m.id).sort(), ['a1', 'b1', 'c1']);

    const rebuilt = plan(states, cache, { zoomChanged: true });
    assert.equal(rebuilt.entries.every((e) => e.kind === 'singles'), true);
    assert.equal(rebuilt.entries.length, 3);
});

test('キャッシュ: 動いたマーカー・カバー範囲外のマーカーは新規扱いで組み直す', () => {
    const states = [marker('a1', 0, 0), marker('b1', 0.5, 0.5), marker('c1', -0.5, -0.5)];
    const baseCache = {
        assignments: new Map(states.map((s) => [s.id, 'cluster_10_0_0'])),
        clusterPositions: new Map([['cluster_10_0_0', p(0, 0)]]),
        coverageBounds: VIEW,
        sourceFingerprints: new Map(states.map((s) => [s.id, geo.positionFingerPrint(s.position)])),
    };

    // c1 が少しだけ動いた → c1 は外れ、残り 2 件は minClusterSize 未満で素通しになる。
    const moved = [states[0], states[1], marker('c1', -0.5001, -0.5)];
    const r1 = plan(moved, baseCache);
    assert.equal(r1.entries.every((e) => e.kind === 'singles'), true);
    assert.equal(r1.assignments.get('c1'), 'c1');

    // カバー範囲が c1 を含まない → 同じく新規扱い。
    const r2 = plan(states, { ...baseCache, coverageBounds: bounds(-0.1, -0.1, 1, 1) });
    assert.equal(r2.entries.every((e) => e.kind === 'singles'), true);
});

test('キャッシュ: 前回のクラスタ近くに新しく来たマーカーはそのクラスタに吸収される', () => {
    const first = plan([marker('a1', 0, 0), marker('a2', 0.002, 0), marker('a3', 0, 0.002)]);
    const clusterId = first.entries[0].cluster.id;

    const second = plan(
        [marker('a1', 0, 0), marker('a2', 0.002, 0), marker('a3', 0, 0.002), marker('a4', 0.002, 0.002)],
        toCache(first),
    );
    assert.equal(second.entries.length, 1);
    const { cluster } = second.entries[0];
    assert.deepEqual(cluster.members.map((m) => m.id).sort(), ['a1', 'a2', 'a3', 'a4']);
    // 正方形になったので中心は 4 隅の重心へ動く（古い位置に貼り付かない）。
    assert.ok(Math.abs(cluster.center.latitude - 0.001) < 1e-9);
    assert.ok(Math.abs(cluster.center.longitude - 0.001) < 1e-9);
    assert.equal(second.assignments.get('a4'), cluster.id);
    assert.match(clusterId, /^cluster_10_/);
});

test('同じ入力・同じキャッシュならパンしても計画は変わらない（ちらつかない）', () => {
    const first = plan(fixture());
    const second = plan(fixture(), toCache(first));
    // 素通しのまとまり方（c1+c2 が 1 エントリか 2 エントリか）は変わりうるが、
    // 描かれるマーカーの集合は同じ。
    const ids = (r) => r.entries.flatMap((e) => (e.kind === 'cluster' ? [e.cluster.id] : e.states.map((s) => s.id)));
    assert.deepEqual(ids(second).sort(), ids(first).sort());
    const c1 = first.entries.find((e) => e.kind === 'cluster').cluster;
    const c2 = second.entries.find((e) => e.kind === 'cluster').cluster;
    assert.equal(c2.center.latitude, c1.center.latitude);
    assert.equal(c2.center.longitude, c1.center.longitude);
});

test('ClusterRenderState.updateClusteringTurn: 小数第 2 位までのズーム変化で周回が進む', () => {
    const state = new ClusterRenderState();
    assert.deepEqual(state.updateClusteringTurn(10), { turn: 1, zoomChanged: false });
    assert.deepEqual(state.updateClusteringTurn(10.004), { turn: 1, zoomChanged: false });
    assert.deepEqual(state.updateClusteringTurn(10.01), { turn: 2, zoomChanged: true });
    assert.deepEqual(state.updateClusteringTurn(10.01), { turn: 2, zoomChanged: false });
    assert.deepEqual(state.updateClusteringTurn(9), { turn: 3, zoomChanged: true });
    state.reset();
    assert.deepEqual(state.updateClusteringTurn(5), { turn: 1, zoomChanged: false });
});

test('ClusterRenderState.commit / toPlanCache / reset', () => {
    const state = new ClusterRenderState();
    const result = plan(fixture());
    const camera = createMapCameraPosition({ position: p(0, 0), zoom: ZOOM });
    state.commit(result, camera, 7);

    const cache = state.toPlanCache();
    assert.equal(cache.assignments, result.assignments);
    assert.equal(cache.clusterPositions, result.clusterPositions);
    assert.equal(cache.coverageBounds, result.coverageBounds);
    assert.equal(cache.sourceFingerprints, result.sourceFingerprints);
    assert.equal(state.clusterMemberCenters, result.clusterMemberCenters);
    assert.equal(state.renderCameraPosition, camera);
    assert.equal(state.sourceStateVersion, 7);

    // 空のカバー範囲は null として持つ（containsBounds の早期 return を誤爆させない）。
    state.commit(plan([]), camera, 8);
    assert.equal(state.coverageBounds, null);

    state.reset();
    assert.equal(state.assignments.size, 0);
    assert.equal(state.coverageBounds, null);
    assert.equal(state.renderCameraPosition, null);
    assert.equal(state.sourceStateVersion, 0);
});
