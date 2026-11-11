import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSources } from './buildSources.mjs';

// SpiderfyLayout: クラスタを扇状に開くときの力学モデル配置。
// 少数なら等間隔の円、多数でも互いに・障害物に・クラスタ自身に重ならないこと、
// 決定的であることを確かめる（同じ入力から android / ios と同じ配置になる前提）。
const { layout: { SpiderfyLayout } } = await buildSources({ layout: 'src/SpiderfyLayout.ts' });
const layout = new SpiderfyLayout();

const SIZE = 52;
const MARGIN = 8;
const DESIRED = SIZE + MARGIN;
const CLEARANCE = Math.round(SIZE * 1.3) + MARGIN; // 76

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const minPairDistance = (points) => {
    let min = Infinity;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) min = Math.min(min, dist(points[i], points[j]));
    }
    return min;
};

test('0 件なら空', () => {
    assert.deepEqual(layout.compute(0, SIZE, MARGIN, []), []);
});

test('2 件は 0 度（右）から始めて左右に並ぶ', () => {
    const [a, b] = layout.compute(2, SIZE, MARGIN, []);
    assert.ok(Math.abs(a.x - CLEARANCE) < 1e-9 && Math.abs(a.y) < 1e-9, JSON.stringify(a));
    assert.ok(Math.abs(b.x + CLEARANCE) < 1e-9 && Math.abs(b.y) < 1e-9, JSON.stringify(b));
});

test('少数は基準距離の円上に等間隔のまま', () => {
    const points = layout.compute(4, SIZE, MARGIN, []);
    for (const pt of points) assert.ok(Math.abs(Math.hypot(pt.x, pt.y) - CLEARANCE) < 1e-6);
    // 隣どうしは 90 度ずつ。
    assert.ok(Math.abs(dist(points[0], points[1]) - CLEARANCE * Math.SQRT2) < 1e-6);
});

test('16 件程度までは互いにおおむね重ならず、クラスタ自身からも離れる', () => {
    for (const count of [3, 5, 8, 12, 16]) {
        const points = layout.compute(count, SIZE, MARGIN, []);
        assert.equal(points.length, count);
        assert.ok(points.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)));
        // 力の釣り合いで止まるので完全に DESIRED 以上とは限らないが、大きく食い込まない。
        assert.ok(minPairDistance(points) > DESIRED * 0.8, `count=${count}: ${minPairDistance(points)}`);
        for (const pt of points) {
            assert.ok(Math.hypot(pt.x, pt.y) > CLEARANCE * 0.85, `count=${count} too close to the cluster`);
        }
    }
});

test('多数は単一の円より外側の層へ広がる', () => {
    const points = layout.compute(30, SIZE, MARGIN, []);
    const maxRadius = Math.max(...points.map((pt) => Math.hypot(pt.x, pt.y)));
    assert.ok(maxRadius > CLEARANCE * 1.5, `maxRadius=${maxRadius}`);
});

test('既に出ているマーカー（障害物）を避ける', () => {
    const free = layout.compute(1, SIZE, MARGIN, []);
    assert.ok(Math.abs(free[0].x - CLEARANCE) < 1e-9);

    const obstacle = { x: CLEARANCE - 4, y: 6 };
    const [moved] = layout.compute(1, SIZE, MARGIN, [obstacle]);
    assert.ok(dist(moved, obstacle) > DESIRED * 0.75, `distance=${dist(moved, obstacle)}`);
    assert.ok(Math.hypot(moved.x, moved.y) > CLEARANCE * 0.9);
});

test('決定的: 同じ入力なら同じ配置', () => {
    const obstacles = [{ x: 10, y: -26 }, { x: 120, y: 40 }];
    assert.deepEqual(
        layout.compute(12, SIZE, MARGIN, obstacles),
        layout.compute(12, SIZE, MARGIN, obstacles),
    );
});
