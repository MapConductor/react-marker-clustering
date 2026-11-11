import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createGeoPoint,
    createGeoRectBounds,
    createMapCameraPosition,
    createMarkerState,
    Earth,
    Spherical,
} from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// ClusterGeometry の投影・境界・平均・凸包を確かめる。
// android / ios と同じ式を持つ前提の部品なので、具体的な数値で固定しておく
// （どれかがずれるとクラスタの中心やカバー範囲が 3 者で食い違う）。
const { geometry: { ClusterGeometry } } = await buildSources({ geometry: 'src/ClusterGeometry.ts' });
const geo = new ClusterGeometry(256);

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });
const marker = (id, latitude, longitude, extra) =>
    createMarkerState({ id, position: p(latitude, longitude), extra });
const bounds = (s, w, n, e) => createGeoRectBounds({ southWest: p(s, w), northEast: p(n, e) });
const close = (actual, expected, eps = 1e-9, msg) =>
    assert.ok(Math.abs(actual - expected) <= eps, `${msg ?? ''} expected ${expected}, got ${actual}`);

test('projectToPixel: Web メルカトルの世界座標（zoom 0 で一辺 tileSize）', () => {
    assert.deepEqual(geo.projectToPixel(p(0, 0), 0), [128, 128]);
    const [x, y] = geo.projectToPixel(p(0, 180), 1);
    close(x, 512);
    close(y, 256);
    // 北は y が小さい。
    assert.ok(geo.projectToPixel(p(45, 0), 0)[1] < 128);
    // 極は sin(lat) を 0.9999 で打ち切るので有限値に留まる。
    const [, yPole] = geo.projectToPixel(p(90, 0), 0);
    assert.ok(Number.isFinite(yPole));
});

test('unprojectPixel は projectToPixel の逆変換', () => {
    for (const [lat, lon, zoom] of [[35.681236, 139.767125, 10], [-33.86, 151.2, 3.5], [0, -179.9, 17]]) {
        const [x, y] = geo.projectToPixel(p(lat, lon), zoom);
        const back = geo.unprojectPixel({ x, y }, zoom);
        close(back.latitude, lat, 1e-9, 'lat');
        close(back.longitude, lon, 1e-9, 'lon');
    }
});

test('metersPerPixel: 赤道で 円周/scale、緯度 60 度で半分', () => {
    close(geo.metersPerPixel(p(0, 0), 0), Earth.CIRCUMFERENCE_METERS / 256, 1e-6);
    close(geo.metersPerPixel(p(0, 0), 3), Earth.CIRCUMFERENCE_METERS / 2048, 1e-6);
    close(geo.metersPerPixel(p(60, 0), 3), Earth.CIRCUMFERENCE_METERS / 4096, 1e-6);
});

test('wrapLongitude は [-180, 180) へ畳む', () => {
    assert.equal(geo.wrapLongitude(190), -170);
    assert.equal(geo.wrapLongitude(-190), 170);
    assert.equal(geo.wrapLongitude(180), -180);
    assert.equal(geo.wrapLongitude(45), 45);
    assert.equal(geo.wrapLongitude(720 + 10), 10);
});

test('containsInViewport: 通常の境界と null / 空', () => {
    const b = bounds(-10, -20, 10, 20);
    assert.equal(geo.containsInViewport(b, p(0, 0), 10), true);
    assert.equal(geo.containsInViewport(b, p(10, 20), 10), true, '境界上は内側');
    assert.equal(geo.containsInViewport(b, p(11, 0), 10), false);
    assert.equal(geo.containsInViewport(b, p(0, 21), 10), false);
    // 経度は wrap してから比べる。
    assert.equal(geo.containsInViewport(b, p(0, 360 + 5), 10), true);
    assert.equal(geo.containsInViewport(null, p(0, 0), 10), false);
    assert.equal(geo.containsInViewport(createGeoRectBounds(), p(0, 0), 10), false);
});

test('containsInViewport: 日付変更線またぎは高ズームで狭い側、低ズームで広い側', () => {
    const b = bounds(-10, 170, 10, -170);
    // zoom > 4: 170..180..-170 の狭い弧。
    assert.equal(geo.containsInViewport(b, p(0, 175), 10), true);
    assert.equal(geo.containsInViewport(b, p(0, -175), 10), true);
    assert.equal(geo.containsInViewport(b, p(0, 0), 10), false);
    // zoom <= 4: 実際の可視範囲は 180 度を超えるとみなし補集合を採る。
    assert.equal(geo.containsInViewport(b, p(0, 0), 4), true);
    assert.equal(geo.containsInViewport(b, p(0, 175), 4), false);
});

test('containsBounds: 対角 2 点が両方入っていれば包含', () => {
    const outer = bounds(-10, -10, 10, 10);
    assert.equal(geo.containsBounds(outer, bounds(-5, -5, 5, 5)), true);
    assert.equal(geo.containsBounds(outer, bounds(-5, -5, 11, 5)), false);
    assert.equal(geo.containsBounds(outer, createGeoRectBounds()), false);
    assert.equal(geo.containsBounds(createGeoRectBounds(), outer), false);
});

test('extendCoverageBounds: 半径ぶん緯度・経度方向に広げる', () => {
    const b = createGeoRectBounds();
    const oneDegreeMeters = Earth.RADIUS_METERS * Math.PI / 180;
    geo.extendCoverageBounds(b, p(0, 0), oneDegreeMeters);
    close(b.southWest.latitude, -1, 1e-9);
    close(b.southWest.longitude, -1, 1e-9);
    close(b.northEast.latitude, 1, 1e-9);
    close(b.northEast.longitude, 1, 1e-9);

    // 緯度 60 度では経度方向の余白が 2 倍になる。
    const b60 = createGeoRectBounds();
    geo.extendCoverageBounds(b60, p(60, 0), oneDegreeMeters);
    close(b60.northEast.longitude, 2, 1e-9);
    close(b60.northEast.latitude, 61, 1e-9);
});

test('estimateViewport: 前回の広さを 2^(baseZoom - zoom) 倍してカメラ中心へ置き直す', () => {
    assert.equal(geo.estimateViewport(4, p(0, 0), null, 5), null);
    assert.equal(geo.estimateViewport(4, p(0, 0), bounds(-1, -1, 1, 1), null), null);

    const est = geo.estimateViewport(4, p(0, 100), bounds(-10, -20, 10, 20), 5);
    close(est.southWest.latitude, -20);
    close(est.northEast.latitude, 20);
    close(est.southWest.longitude, 60);
    close(est.northEast.longitude, 140);

    // ズームインなら縮む。
    const zoomIn = geo.estimateViewport(6, p(0, 0), bounds(-10, -20, 10, 20), 5);
    close(zoomIn.northEast.latitude, 5);
    close(zoomIn.northEast.longitude, 10);

    // 緯度は ±90 で止める。
    const huge = geo.estimateViewport(0, p(0, 0), bounds(-40, -20, 40, 20), 5);
    assert.equal(huge.northEast.latitude, 90);
    assert.equal(huge.southWest.latitude, -90);
});

test('estimateViewport: 日付変更線をまたぐ前回範囲の経度幅を正しく測る', () => {
    // 170 → -170 は幅 20 度。
    const est = geo.estimateViewport(5, p(0, 0), bounds(-10, 170, 10, -170), 5);
    close(est.southWest.longitude, -10);
    close(est.northEast.longitude, 10);
});

test('hasCameraMoved: 1m 超の移動、または bearing / tilt が 0.01 度超で動いたとみなす', () => {
    const base = createMapCameraPosition({ position: p(35, 139), zoom: 10, bearing: 0, tilt: 0 });
    assert.equal(geo.hasCameraMoved(base, base), false);
    assert.equal(geo.hasCameraMoved(base, base.copy({ zoom: 12 })), false, 'ズームだけでは動いたとみなさない');
    assert.equal(geo.hasCameraMoved(base, base.copy({ position: p(35.0001, 139) })), true);
    assert.equal(geo.hasCameraMoved(base, base.copy({ position: p(35.000001, 139) })), false);
    assert.equal(geo.hasCameraMoved(base, base.copy({ bearing: 0.02 })), true);
    assert.equal(geo.hasCameraMoved(base, base.copy({ bearing: 0.005 })), false);
    assert.equal(geo.hasCameraMoved(base, base.copy({ tilt: 0.02 })), true);
});

test('interpolatePosition: 緯度経度の線形補間', () => {
    const mid = geo.interpolatePosition(p(0, 0), p(10, 20), 0.25);
    close(mid.latitude, 2.5);
    close(mid.longitude, 5);
});

test('averagePosition: メンバー位置の単純平均、空なら (0, 0)', () => {
    const avg = geo.averagePosition([marker('a', 0, 0), marker('b', 2, 4), marker('c', 4, 8)]);
    close(avg.latitude, 2);
    close(avg.longitude, 4);
    const empty = geo.averagePosition([]);
    assert.equal(empty.latitude, 0);
    assert.equal(empty.longitude, 0);
});

test('averageOfMemberCenters: 分かっている中心だけ平均し、どれも無ければ null', () => {
    const cluster = marker('cluster_10_1_1', 0, 0, { count: 3, markerIds: ['a', 'b', 'c'] });
    const centers = new Map([['a', p(1, 1)], ['b', p(3, 5)]]);
    const avg = geo.averageOfMemberCenters(cluster, centers);
    close(avg.latitude, 2);
    close(avg.longitude, 3);
    assert.equal(geo.averageOfMemberCenters(cluster, new Map()), null);
    assert.equal(geo.averageOfMemberCenters(marker('plain', 0, 0), centers), null);
    assert.equal(geo.averageOfMemberCenters(marker('x', 0, 0, { count: 0, markerIds: [] }), centers), null);
});

test('calculateClusterRadiusMeters: 中心から最も遠いメンバーまでの距離', () => {
    const center = p(0, 0);
    const members = [marker('a', 0, 0.001), marker('b', 0.01, 0), marker('c', -0.002, 0)];
    close(
        geo.calculateClusterRadiusMeters(center, members),
        Spherical.computeDistanceBetween(center, members[1].position),
        1e-6,
    );
    assert.equal(geo.calculateClusterRadiusMeters(center, []), 0);
});

test('positionFingerPrint: 緯度経度だけから決まる', () => {
    assert.equal(geo.positionFingerPrint(p(1.5, -2.25)), '1.5_-2.25');
    assert.equal(geo.positionFingerPrint(p(1.5, -2.25)), geo.positionFingerPrint(p(1.5, -2.25)));
    assert.notEqual(geo.positionFingerPrint(p(1.5, -2.25)), geo.positionFingerPrint(p(1.5, -2.250001)));
});

test('convexHullProjected: 内側の点を除いた凸包を返す', () => {
    const members = [
        marker('sw', -0.01, -0.01), marker('se', -0.01, 0.01),
        marker('ne', 0.01, 0.01), marker('nw', 0.01, -0.01),
        marker('inner', 0.001, 0.002),
    ];
    const hull = geo.convexHullProjected(members, 12);
    assert.equal(hull.length, 4);
    const inner = geo.projectToPixel(members[4].position, 12);
    assert.ok(!hull.some((pt) => pt.x === inner[0] && pt.y === inner[1]));
    // 戻すと元の 4 隅になる。
    const corners = hull.map((pt) => geo.unprojectPixel(pt, 12));
    for (const corner of corners) {
        close(Math.abs(corner.latitude), 0.01, 1e-9);
        close(Math.abs(corner.longitude), 0.01, 1e-9);
    }
});

test('convexHullProjected: 3 点未満・重複・一直線は空', () => {
    assert.deepEqual(geo.convexHullProjected([marker('a', 0, 0), marker('b', 1, 1)], 10), []);
    assert.deepEqual(
        geo.convexHullProjected([marker('a', 0, 0), marker('b', 0, 0), marker('c', 1, 1)], 10),
        [],
        '同じ位置は 1 点として数える',
    );
    assert.deepEqual(
        geo.convexHullProjected([marker('a', 0, 0), marker('b', 0, 1), marker('c', 0, 2)], 10),
        [],
        '一直線は面積が無い',
    );
});

test('polygonCentroidProjected: 靴ひも公式の重心、潰れていれば頂点平均', () => {
    assert.deepEqual(
        geo.polygonCentroidProjected([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]),
        { x: 1, y: 1 },
    );
    const tri = geo.polygonCentroidProjected([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }]);
    close(tri.x, 1);
    close(tri.y, 1);
    // 頂点が偏っていても面積重心になる（頂点平均とは異なる）。
    const lShape = geo.polygonCentroidProjected([
        { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 4 }, { x: 0, y: 4 },
    ]);
    close(lShape.x, 19 / 14, 1e-9);
    close(lShape.y, 19 / 14, 1e-9);
    assert.deepEqual(
        geo.polygonCentroidProjected([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]),
        { x: 1, y: 0 },
    );
    assert.equal(geo.polygonCentroidProjected([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
});

test('polygonCentroidProjected: 数 m 間隔のマーカーでも重心がずれない', () => {
    // 東京付近で約 2m 四方に並べた 4 点。世界 px の絶対座標のまま外積を取ると
    // 桁落ちで重心が数十 km 飛んでいた。ズームによらず 4 隅の中央に来ること。
    const d = 0.00002;
    const members = [
        marker('a', 35.681236, 139.767125),
        marker('b', 35.681236 + d, 139.767125),
        marker('c', 35.681236, 139.767125 + d),
        marker('d', 35.681236 + d, 139.767125 + d),
    ];
    for (const zoom of [10, 15, 21]) {
        const hull = geo.convexHullProjected(members, zoom);
        const center = geo.unprojectPixel(geo.polygonCentroidProjected(hull), zoom);
        close(center.latitude, 35.681236 + d / 2, 1e-8, `zoom ${zoom} lat`);
        close(center.longitude, 139.767125 + d / 2, 1e-8, `zoom ${zoom} lng`);
    }
});
