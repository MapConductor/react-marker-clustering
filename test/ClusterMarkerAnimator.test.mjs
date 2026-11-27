import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeoPoint, createMarkerEntity, createMarkerState } from '@mapconductor/js-sdk-core';
import { buildSources } from './buildSources.mjs';

// 移動アニメーションの途中フレームは baseState を位置だけ変えて複製する。
// MarkerState.copy() は id を計算し直すので、id を渡さないとフレームごとに別のマーカーに
// なり、元のマーカーは置き去りにされる。全フレームで元の id を保つことを固定する。
const {
    animator: { ClusterMarkerAnimator },
    geometry: { ClusterGeometry },
} = await buildSources({ animator: 'src/ClusterMarkerAnimator.ts', geometry: 'src/ClusterGeometry.ts' });

const p = (latitude, longitude) => createGeoPoint({ latitude, longitude });

test('animate: 途中フレームの状態は元のマーカーの id を保つ', async () => {
    const baseState = createMarkerState({ id: 'member-1', position: p(35.0, 139.0) });
    const entity = createMarkerEntity({ marker: 'native-1', state: baseState, isRendered: true });
    const updated = [];
    const markerManager = { updateEntity: (e) => updated.push(e.state.id) };
    const rendered = new Map();
    const seen = [];
    const renderer = {
        onChange: async (params) => {
            for (const c of params) seen.push(c.current.state.id);
            return params.map((c) => c.prev.marker);
        },
        onPostProcess: async () => {},
    };
    const animator = new ClusterMarkerAnimator(new ClusterGeometry(256), markerManager, rendered, null, () => true);

    const finished = await animator.animate(
        [{ id: 'member-1', start: p(35.0, 139.0), end: p(36.0, 140.0), baseState, entity, restoreBaseStateAtEnd: false }],
        renderer,
        48,
        0,
    );

    assert.equal(finished, true);
    assert.ok(seen.length > 1, `複数フレーム描くはず: ${seen.length}`);
    assert.deepEqual(new Set(seen), new Set(['member-1']));
    assert.deepEqual(new Set(updated), new Set(['member-1']));
    assert.deepEqual([...rendered.keys()], ['member-1']);
});
