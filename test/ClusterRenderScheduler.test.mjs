import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGeoPoint, createGeoRectBounds, createMapCameraPosition } from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// ClusterRenderScheduler: 「いつ再クラスタするか」。カメライベントのデバウンス、
// 処理中に来た要求は最新 1 件だけ残すこと、visibleRegion が無いときの
// ビューポート推定、トークンによる打ち切り判定を確かめる。
const { geometry: { ClusterGeometry }, scheduler: { ClusterRenderScheduler } } = await buildSources({
    geometry: 'src/ClusterGeometry.ts',
    scheduler: 'src/ClusterRenderScheduler.ts',
});
const geo = new ClusterGeometry(256);

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });
const bounds = (s, w, n, e) => createGeoRectBounds({ southWest: p(s, w), northEast: p(n, e) });
const camera = (lat, lon, zoom, region = bounds(lat - 1, lon - 1, lat + 1, lon + 1)) =>
    createMapCameraPosition({ position: p(lat, lon), zoom, visibleRegion: region ? { bounds: region } : null });
const renderer = { name: 'fake-renderer' };

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

test('トークン: nextToken で進み、isCurrent は最新だけ真', () => {
    const scheduler = new ClusterRenderScheduler(geo, 0, async () => {});
    assert.equal(scheduler.currentToken, 0);
    const t1 = scheduler.nextToken();
    const t2 = scheduler.nextToken();
    assert.equal(scheduler.isCurrent(t1), false);
    assert.equal(scheduler.isCurrent(t2), true);
    assert.equal(scheduler.currentToken, t2);
});

test('デバウンス: 連続したカメラ更新は最後の 1 回だけ描く', async () => {
    const requests = [];
    const scheduler = new ClusterRenderScheduler(geo, 20, async (r) => { requests.push(r); });
    scheduler.onCameraChanged(camera(0, 0, 5), renderer);
    scheduler.onCameraChanged(camera(1, 1, 6), renderer);
    const last = camera(2, 2, 7);
    scheduler.onCameraChanged(last, renderer);
    assert.equal(requests.length, 0, 'デバウンス中はまだ描かない');
    await sleep(60);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].cameraPosition, last);
    assert.equal(requests[0].viewport, last.visibleRegion.bounds);
    assert.equal(requests[0].renderer, renderer);
    assert.equal(scheduler.isCurrent(requests[0].token), true);
    assert.equal(scheduler.lastCameraPosition, last);
    assert.equal(scheduler.lastKnownViewport, last.visibleRegion.bounds);
});

test('visibleRegion が無いカメラ更新は、直前のビューポートから推定する', async () => {
    const requests = [];
    const scheduler = new ClusterRenderScheduler(geo, 0, async (r) => { requests.push(r); });
    scheduler.onCameraChanged(camera(0, 0, 5, bounds(-10, -20, 10, 20)), renderer);
    await sleep(10);
    scheduler.onCameraChanged(camera(0, 100, 4, null), renderer);
    await sleep(10);
    assert.equal(requests.length, 2);
    const vp = requests[1].viewport;
    assert.ok(Math.abs(vp.southWest.longitude - 60) < 1e-9);
    assert.ok(Math.abs(vp.northEast.longitude - 140) < 1e-9);
    assert.ok(Math.abs(vp.northEast.latitude - 20) < 1e-9);
});

test('ビューポートを一度も知らないまま visibleRegion 無しなら描かない', async () => {
    const requests = [];
    const scheduler = new ClusterRenderScheduler(geo, 0, async (r) => { requests.push(r); });
    scheduler.onCameraChanged(camera(0, 0, 5, null), renderer);
    await sleep(10);
    assert.equal(requests.length, 0);
});

test('処理中に来た要求は最新 1 件だけ残して順に処理する', async () => {
    const gate = deferred();
    const seen = [];
    const scheduler = new ClusterRenderScheduler(geo, 0, async (r) => {
        seen.push(r.token);
        if (r.token === 1) await gate.promise;
    });
    const vp = bounds(-1, -1, 1, 1);
    const cam = camera(0, 0, 5);
    scheduler.enqueue(cam, vp, renderer, 1);
    scheduler.enqueue(cam, vp, renderer, 2);
    scheduler.enqueue(cam, vp, renderer, 3);
    await sleep(5);
    assert.deepEqual(seen, [1], '1 件目の処理中');
    gate.resolve();
    await sleep(5);
    assert.deepEqual(seen, [1, 3], '2 は 3 に追い越されて捨てられる');
});

test('描画で例外が出てもワーカーは止まらない', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const seen = [];
    const scheduler = new ClusterRenderScheduler(geo, 0, async (r) => {
        seen.push(r.token);
        if (r.token === 1) throw new Error('boom');
    });
    const vp = bounds(-1, -1, 1, 1);
    scheduler.enqueue(camera(0, 0, 5), vp, renderer, 1);
    await sleep(5);
    scheduler.enqueue(camera(0, 0, 5), vp, renderer, 2);
    await sleep(5);
    assert.deepEqual(seen, [1, 2]);
    assert.equal(warn.mock.callCount(), 1);
});

test('reset: 保留中のデバウンスを取り消し、カメラの記憶を捨てる', async () => {
    const requests = [];
    const scheduler = new ClusterRenderScheduler(geo, 20, async (r) => { requests.push(r); });
    scheduler.onCameraChanged(camera(0, 0, 5), renderer);
    scheduler.lastUsedViewport = bounds(-1, -1, 1, 1);
    scheduler.reset();
    await sleep(50);
    assert.equal(requests.length, 0);
    assert.equal(scheduler.lastCameraPosition, null);
    assert.equal(scheduler.lastKnownViewport, null);
    assert.equal(scheduler.lastUsedViewport, null);
});
