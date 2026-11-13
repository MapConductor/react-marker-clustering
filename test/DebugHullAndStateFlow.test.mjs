import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeoPoint } from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// デバッグ用の凸包ポリゴン（buildHullPolygonStates）と、ストラテジが結果を
// 公開する最小の StateFlow を確かめる。凸包の色は Android と同じ
// String.hashCode() から選び、隣接セルどうしで色が被らないこと。
const { hull: { buildHullPolygonStates }, flow: { MutableStateFlow } } = await buildSources({
    hull: 'src/ClusterDebugHullPolygons.ts',
    flow: 'src/StateFlow.ts',
});

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });
const TRIANGLE = [p(0, 0), p(0, 1), p(1, 0)];
const info = (id, cellX, cellY, hullPoints = TRIANGLE) => ({
    id, center: p(0, 0), radiusMeters: 1, count: 3, cellX, cellY, hullPoints,
});
const baseColor = (rgba) => rgba.replace(/,[^,]*\)$/, '');

test('凸包が 3 点未満のクラスタは描かない、空なら空', () => {
    assert.deepEqual(buildHullPolygonStates([]), []);
    assert.deepEqual(buildHullPolygonStates([info('x', 0, 0, [p(0, 0), p(1, 1)])]), []);
    const states = buildHullPolygonStates([info('x', 0, 0, []), info('y', 5, 5)]);
    assert.deepEqual(states.map((s) => s.id), ['cluster-hull-y']);
});

test('ポリゴンの見た目: 固定の線幅・zIndex・半透明の塗り', () => {
    const [state] = buildHullPolygonStates([info('a', 0, 0)]);
    assert.equal(state.id, 'cluster-hull-a');
    assert.deepEqual(state.points.map((pt) => [pt.latitude, pt.longitude]), [[0, 0], [0, 1], [1, 0]]);
    assert.equal(state.strokeWidth, 2);
    assert.equal(state.zIndex, 9);
    assert.equal(state.geodesic, false);
    // 'a'.hashCode() = 97 → 97 % 14 = 13 → 最後の色 #FB8C00 (orange)。
    assert.equal(state.strokeColor, 'rgba(251,140,0,0.8)');
    assert.equal(state.fillColor, 'rgba(251,140,0,0.18)');
});

test('隣接する 8 セルとは別の色を選ぶ', () => {
    // 同じ ID 接頭辞でも hash の開始位置は散らばるが、隣接どうしは必ず別色になる。
    const infos = [];
    for (let x = 0; x < 4; x++) {
        for (let y = 0; y < 4; y++) infos.push(info(`cluster_10_${x}_${y}`, x, y));
    }
    const states = buildHullPolygonStates(infos);
    const colorByCell = new Map(states.map((s, i) => [`${infos[i].cellX},${infos[i].cellY}`, baseColor(s.strokeColor)]));
    for (const { cellX, cellY } of infos) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const neighbor = colorByCell.get(`${cellX + dx},${cellY + dy}`);
                if (!neighbor) continue;
                assert.notEqual(colorByCell.get(`${cellX},${cellY}`), neighbor, `${cellX},${cellY} vs +${dx},${dy}`);
            }
        }
    }
});

test('描かない（凸包の無い）クラスタも隣の色決めには参加する', () => {
    // 'a' は単独なら #FB8C00 だが、隣のセルが先にその色を取っていれば避ける。
    const alone = buildHullPolygonStates([info('a', 1, 0)]);
    assert.equal(baseColor(alone[0].strokeColor), 'rgba(251,140,0');
    const withNeighbor = buildHullPolygonStates([info('a', 1, 0), info('a', 0, 0, [])]);
    assert.equal(withNeighbor.length, 1);
    assert.notEqual(baseColor(withNeighbor[0].strokeColor), 'rgba(251,140,0');
});

test('MutableStateFlow: 購読時に現在値、変化時だけ通知、解除後は届かない', () => {
    const flow = new MutableStateFlow(1);
    const seen = [];
    const unsubscribe = flow.subscribe((v) => seen.push(v));
    assert.deepEqual(seen, [1]);
    flow.value = 2;
    flow.value = 2; // 同じ値（Object.is）は通知しない
    flow.value = 3;
    assert.equal(flow.value, 3);
    assert.deepEqual(seen, [1, 2, 3]);
    unsubscribe();
    flow.value = 4;
    assert.deepEqual(seen, [1, 2, 3]);
});

test('MutableStateFlow: 同じ中身でも別の配列なら通知する（参照比較）', () => {
    const flow = new MutableStateFlow([]);
    let calls = 0;
    flow.subscribe(() => calls++);
    flow.value = [];
    assert.equal(calls, 2);
});

test('MutableStateFlow: 通知中に購読解除しても他の購読者には届く', () => {
    const flow = new MutableStateFlow(0);
    const seen = [];
    let unsubscribeFirst = () => {};
    unsubscribeFirst = flow.subscribe((v) => { if (v === 1) unsubscribeFirst(); });
    flow.subscribe((v) => seen.push(v));
    flow.value = 1;
    flow.value = 2;
    assert.deepEqual(seen, [0, 1, 2]);
});
