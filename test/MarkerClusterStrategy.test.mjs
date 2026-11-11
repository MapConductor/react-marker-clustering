import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    createGeoPoint,
    createGeoRectBounds,
    createMapCameraPosition,
    createMarkerState,
} from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// MarkerClusterStrategy を、地図の代わりに記録だけする偽レンダラーで動かす。
// マーカー投入 → カメラ更新 → 再クラスタ → レンダラーへの追加・削除、という
// 一連の段取りと、クラスタマーカーのクリック配線・周回数・clear を確かめる。
const { strategy: { MarkerClusterStrategy } } = await buildSources({ strategy: 'src/MarkerClusterStrategy.ts' });

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });
const marker = (id, latitude, longitude) => createMarkerState({ id, position: p(latitude, longitude) });
const bounds = (s, w, n, e) => createGeoRectBounds({ southWest: p(s, w), northEast: p(n, e) });
const VIEW = bounds(-1, -1, 1, 1);
const camera = (zoom, region = VIEW) =>
    createMapCameraPosition({ position: p(0, 0), zoom, visibleRegion: { bounds: region } });

/** 地図の代わり。描かれているマーカーの ID 集合と呼び出し履歴だけを持つ。 */
function fakeRenderer() {
    const shown = new Map();
    const log = [];
    return {
        shown,
        log,
        animateStartListener: null,
        animateEndListener: null,
        animationOverlayHost: null,
        async onAdd(params) {
            log.push(['add', params.map((d) => d.state.id)]);
            return params.map((d) => {
                assert.ok(d.bitmapIcon, `${d.state.id} has a bitmap icon`);
                const actual = { id: d.state.id };
                shown.set(d.state.id, actual);
                return actual;
            });
        },
        async onChange(params) {
            log.push(['change', params.map((d) => d.current.state.id)]);
            return params.map((d) => d.prev.marker);
        },
        async onRemove(entities) {
            log.push(['remove', entities.map((e) => e.state.id)]);
            for (const e of entities) shown.delete(e.state.id);
        },
        async onAnimate() {},
        async onPostProcess() {},
        setMarkerVisible() {},
    };
}

async function until(predicate, label, timeoutMs = 1000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${label}`);
        await sleep(2);
    }
}

const fixture = () => [
    marker('a1', 0, 0), marker('a2', 0.002, 0), marker('a3', 0, 0.002),
    marker('b1', 0.5, 0.5),
    marker('out', 5, 5),
];
const ids = (renderer) => [...renderer.shown.keys()].sort();
const clusterIdOf = (renderer) => [...renderer.shown.keys()].find((id) => id.startsWith('cluster_'));

test('カメラが来るまでは描かず、来たらクラスタと単独マーカーを描く', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    assert.equal(await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer }), true);
    assert.equal(strategy.hasSourceMarker('a1'), true);
    assert.equal(strategy.hasSourceMarker('zzz'), false);
    await sleep(10);
    assert.equal(renderer.log.length, 0, 'カメラ未到着');

    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => renderer.shown.size > 0, 'first render');
    const clusterId = clusterIdOf(renderer);
    assert.match(clusterId, /^cluster_10_/);
    assert.deepEqual(ids(renderer), ['b1', clusterId].sort(), '範囲外の out は描かない');

    const debug = strategy.debugInfoFlow.value;
    assert.equal(debug.length, 1);
    assert.equal(debug[0].id, clusterId);
    assert.equal(debug[0].count, 3);
    assert.equal(debug[0].hullPoints.length, 3);
});

test('クラスタマーカーは extra にメンバーを持ち、クリックで onClusterClick へ渡る', async () => {
    const clicked = [];
    const strategy = new MarkerClusterStrategy({
        cameraIdleDebounceMillis: 0,
        onClusterClick: (cluster) => clicked.push(cluster),
    });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => clusterIdOf(renderer), 'cluster');

    const entity = strategy.markerManager.allEntities().find((e) => e.state.id === clusterIdOf(renderer));
    const cluster = entity.state.extra;
    assert.equal(cluster.count, 3);
    assert.deepEqual([...cluster.markerIds].sort(), ['a1', 'a2', 'a3']);
    assert.equal(entity.state.clickable, true);
    assert.equal(entity.state.draggable, false);
    entity.state.onClick?.(entity.state);
    assert.equal(clicked.length, 1);
    assert.equal(clicked[0], cluster);
});

test('onClusterClick も spiderfy も無ければクラスタマーカーはクリック不可', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => clusterIdOf(renderer), 'cluster');
    const entity = strategy.markerManager.allEntities().find((e) => e.state.id.startsWith('cluster_'));
    assert.equal(entity.state.clickable, false);
    assert.equal(entity.state.onClick ?? null, null);
});

test('データの差し替えで消えたマーカーはレンダラーから外れる', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => renderer.shown.has('b1'), 'b1 shown');

    // a3 と b1 を外す → a1, a2 だけでは minClusterSize(3) に届かず単独に戻る。
    await strategy.onAdd({ data: [marker('a1', 0, 0), marker('a2', 0.002, 0)], viewport: VIEW, renderer });
    await until(() => !renderer.shown.has('b1'), 'b1 removed');
    await until(() => renderer.shown.has('a1'), 'a1 shown');
    assert.deepEqual(ids(renderer), ['a1', 'a2']);
    assert.equal(strategy.hasSourceMarker('b1'), false);
    assert.deepEqual(strategy.debugInfoFlow.value, []);
});

test('ズームインで分かれるとクラスタは消えメンバーが個別に出る、周回数も進む', async () => {
    const turns = [];
    const strategy = new MarkerClusterStrategy({
        cameraIdleDebounceMillis: 0,
        clusterIconProviderWithTurn: (count, turn) => {
            turns.push([count, turn]);
            return null; // null なら clusterIconProvider（既定アイコン）へ落ちる
        },
    });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => clusterIdOf(renderer), 'cluster at z10');
    assert.deepEqual(turns, [[3, 1]]);

    // z18 では 0.002 度 ≒ 数百 px 離れるのでクラスタにならない。
    await strategy.onCameraChanged(camera(18, bounds(-0.01, -0.01, 0.01, 0.01)), renderer);
    await until(() => renderer.shown.has('a1'), 'members at z18');
    assert.equal(clusterIdOf(renderer), undefined);
    assert.deepEqual(ids(renderer), ['a1', 'a2', 'a3']);

    // z10 → z18 → z10 とズームが 2 回変わったので、周回数は 3。
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => clusterIdOf(renderer), 'cluster again');
    assert.deepEqual(turns.at(-1), [3, 3]);
});

test('同じビューポートでの再クラスタは前回の割り当てを再利用し、出し入れしない', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => renderer.shown.size > 0, 'first render');
    await sleep(10);
    const before = renderer.log.length;
    strategy.forceRender();
    await strategy.onCameraChanged(camera(10), renderer);
    await sleep(20);
    const after = renderer.log.slice(before).filter(([kind]) => kind !== 'change');
    assert.deepEqual(after, []);
});

test('ビューポート外（+20% の余白の外）に出たマーカーは外し、範囲内だけで組み直す', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => renderer.shown.size > 0, 'first render');

    // a1 (0,0) だけが入る狭い範囲。a2 / a3 は 0.002 度先で余白を含めても外。
    await strategy.onCameraChanged(camera(10, bounds(-0.001, -0.001, 0.001, 0.001)), renderer);
    await until(() => renderer.shown.has('a1'), 'a1 alone');
    assert.deepEqual(ids(renderer), ['a1']);
    assert.deepEqual(strategy.debugInfoFlow.value, []);
});

test('onUpdate: 位置が変われば再クラスタ、外れたメンバーは単独で出る', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    const states = fixture();
    await strategy.onAdd({ data: states, viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => clusterIdOf(renderer), 'cluster');

    await strategy.onUpdate({ state: marker('a3', -0.5, 0.5), viewport: VIEW, renderer });
    await until(() => renderer.shown.has('a3'), 'a3 alone');
    assert.equal(clusterIdOf(renderer), undefined);
    assert.deepEqual(ids(renderer), ['a1', 'a2', 'a3', 'b1']);
});

test('clear: 元データ・デバッグ情報・描画済みの記憶を捨てる', async () => {
    const strategy = new MarkerClusterStrategy({ cameraIdleDebounceMillis: 0 });
    const renderer = fakeRenderer();
    await strategy.onAdd({ data: fixture(), viewport: VIEW, renderer });
    await strategy.onCameraChanged(camera(10), renderer);
    await until(() => strategy.debugInfoFlow.value.length === 1, 'debug info');

    strategy.clear();
    assert.equal(strategy.hasSourceMarker('a1'), false);
    assert.deepEqual(strategy.debugInfoFlow.value, []);
    assert.equal(strategy.markerManager.allEntities().length, 0);
    assert.deepEqual(strategy.spiderfyLegsFlow.value, []);
});
