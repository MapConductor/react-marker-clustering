import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeoPoint, createMarkerState } from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// ClusterBuilder: ズームに応じた実効半径、クラスタ ID、格子セル、近傍セルの併合、
// 密なところを選ぶ中心の決め方を確かめる。地図は要らない純粋な計算。
const { geometry: { ClusterGeometry }, builder: { ClusterBuilder, CLUSTER_ID_PREFIX } } = await buildSources({
    geometry: 'src/ClusterGeometry.ts',
    builder: 'src/ClusterBuilder.ts',
});
const geo = new ClusterGeometry(256);
const builder = new ClusterBuilder(geo, 90);

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });
const marker = (id, latitude, longitude) => createMarkerState({ id, position: p(latitude, longitude) });

/** ClusterPlanner と同じく、セルごとに 1 候補へまとめる。 */
function bucket(markers, zoom, radius) {
    const cells = new Map();
    for (const m of markers) {
        const cell = builder.cellOf(m.position, zoom, radius);
        const key = `${cell.x},${cell.y}`;
        if (!cells.has(key)) cells.set(key, { cell, center: m.position, members: [] });
        cells.get(key).members.push(m);
    }
    return [...cells.values()];
}

test('CLUSTER_ID_PREFIX と buildClusterId: ズームは四捨五入して埋め込む', () => {
    assert.equal(CLUSTER_ID_PREFIX, 'cluster_');
    assert.equal(builder.buildClusterId({ x: 3, y: -1 }, 9.6), 'cluster_10_3_-1');
    assert.equal(builder.buildClusterId({ x: 0, y: 7 }, 12.2), 'cluster_12_0_7');
});

test('effectiveClusterRadiusPx: zoom/10 で縮め、0.35 倍と 18px で下げ止まる', () => {
    assert.equal(builder.effectiveClusterRadiusPx(10), 90);
    assert.equal(builder.effectiveClusterRadiusPx(20), 90, '1 倍より大きくはしない');
    assert.equal(builder.effectiveClusterRadiusPx(5), 45);
    assert.equal(builder.effectiveClusterRadiusPx(0), 90 * 0.35);
    assert.equal(new ClusterBuilder(geo, 40).effectiveClusterRadiusPx(0), 18);
});

test('cellOf: 投影 px を半径で割った格子座標', () => {
    assert.deepEqual(builder.cellOf(p(0, 0), 0, 64), { x: 2, y: 2 });
    assert.deepEqual(builder.cellOf(p(0, -180), 0, 64), { x: 0, y: 2 });
    const [x, y] = geo.projectToPixel(p(35.68, 139.76), 12);
    assert.deepEqual(builder.cellOf(p(35.68, 139.76), 12, 90), { x: Math.floor(x / 90), y: Math.floor(y / 90) });
});

test('mergeClusters: 隣のセルでも半径内なら 1 つに、半径外なら別のまま', () => {
    const zoom = 10;
    const a = marker('a', 0, 0);
    const near = marker('near', 0, 0.08); // 約 58px
    const far = marker('far', 0, 0.196); // 約 143px
    // 前提: 3 つとも別セルで、near と far は a の隣 or その先にいる。
    const cellA = builder.cellOf(a.position, zoom, 90);
    const cellNear = builder.cellOf(near.position, zoom, 90);
    const cellFar = builder.cellOf(far.position, zoom, 90);
    assert.equal(cellNear.x - cellA.x, 1);
    assert.equal(cellFar.x - cellA.x, 1, 'far も a の隣のセル（距離で弾かれることを見る）');

    const nearMerged = builder.mergeClusters(bucket([a, near], zoom, 90), zoom, 90);
    assert.equal(nearMerged.length, 1);
    assert.deepEqual(nearMerged[0].members.map((m) => m.id).sort(), ['a', 'near']);

    const farMerged = builder.mergeClusters(bucket([a, far], zoom, 90), zoom, 90);
    assert.equal(farMerged.length, 2);
});

test('mergeClusters: 種の 8 近傍だけを吸収し、2 つ先のセルは連鎖させない', () => {
    const zoom = 10;
    const markers = [marker('a', 0, 0), marker('b', 0, 0.08), marker('c', 0, 0.3)];
    const cells = markers.map((m) => builder.cellOf(m.position, zoom, 90).x);
    assert.deepEqual([cells[1] - cells[0], cells[2] - cells[0]], [1, 2]);
    const merged = builder.mergeClusters(bucket(markers, zoom, 90), zoom, 90);
    assert.deepEqual(merged.map((c) => c.members.map((m) => m.id)), [['a', 'b'], ['c']]);
});

test('mergeClusters: 空なら空', () => {
    assert.deepEqual(builder.mergeClusters([], 10, 90), []);
});

test('selectDenseCenter: 外れ値に引っ張られず、密集の真ん中にいるメンバーの位置を返す', () => {
    const members = [
        marker('outlier', 0, 1.0),
        marker('m1', 0, 0),
        marker('m2', 0, 0.002),
        marker('m3', 0.002, 0),
        marker('m4', 0.002, 0.002),
        marker('mid', 0.001, 0.001),
    ];
    const center = builder.selectDenseCenter(members, 10, 90);
    assert.equal(center.latitude, 0.001);
    assert.equal(center.longitude, 0.001);
});

test('selectDenseCenter: 1 件ならその位置、空なら (0, 0)', () => {
    const single = builder.selectDenseCenter([marker('a', 12, 34)], 10, 90);
    assert.deepEqual([single.latitude, single.longitude], [12, 34]);
    const empty = builder.selectDenseCenter([], 10, 90);
    assert.deepEqual([empty.latitude, empty.longitude], [0, 0]);
});
