// tests/annotator-shapes.test.js — src/annotator/shapes.js の幾何計算の単体テスト
//
// buildShapeSvg() など DOM(document)を必要とする関数はここでは扱わない
// (E2E: dev/annotator-harness.mjs で実ブラウザ上から検証する)。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRect,
  computeOutputSize,
  intersectRectFromCenter,
  computeArrowEndpoints,
  distanceToRect,
  findAttachTarget,
  computeCalloutBox,
  getShapeOutlineBox,
  buildCalloutPath,
} from '../src/annotator/shapes.js';

// テスト用の決定的なテキスト幅計測(1文字 = fontSize * 0.5px とみなす)
const fakeMeasureFn = (text, fontSize) => text.length * fontSize * 0.5;

test('normalizeRect: 負の w/h を正の矩形に正規化する', () => {
  assert.deepEqual(normalizeRect({ x: 10, y: 10, w: -5, h: -5 }), { x: 5, y: 5, w: 5, h: 5 });
  assert.deepEqual(normalizeRect({ x: 0, y: 0, w: 100, h: 50 }), { x: 0, y: 0, w: 100, h: 50 });
});

test('computeOutputSize: crop のサイズ × scale を四捨五入する', () => {
  assert.deepEqual(computeOutputSize({ x: 0, y: 0, w: 1920, h: 1080 }, 1), { width: 1920, height: 1080 });
  assert.deepEqual(computeOutputSize({ x: 0, y: 0, w: 1920, h: 1080 }, 0.5), { width: 960, height: 540 });
  assert.deepEqual(computeOutputSize({ x: 0, y: 0, w: 101, h: 101 }, 0.75), { width: 76, height: 76 });
  assert.deepEqual(computeOutputSize({ x: 0, y: 0, w: 1, h: 1 }, 0.01), { width: 1, height: 1 }); // 最低1px
});

test('intersectRectFromCenter: 水平方向・垂直方向・斜め方向の交点', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };
  // 中心(50,25)から真右へ
  assert.deepEqual(intersectRectFromCenter(rect, { x: 10000, y: 25 }), { x: 100, y: 25 });
  // 中心から真上へ
  assert.deepEqual(intersectRectFromCenter(rect, { x: 50, y: -10000 }), { x: 50, y: 0 });

  // 正方形の斜め45度は角に一致する
  const square = { x: 0, y: 0, w: 100, h: 100 };
  const corner = intersectRectFromCenter(square, { x: 1000, y: 1000 });
  assert.equal(corner.x, 100);
  assert.equal(corner.y, 100);
});

test('computeArrowEndpoints: 未接続の端点はそのままの座標を使う', () => {
  const shape = { from: { x: 0, y: 0, attach: null }, to: { x: 400, y: 300, attach: null } };
  const { from, to } = computeArrowEndpoints(shape, {});
  assert.deepEqual(from, { x: 0, y: 0 });
  assert.deepEqual(to, { x: 400, y: 300 });
});

test('computeArrowEndpoints: 片方が rect に接続していると、中心→相手の座標 と外周の交点になる', () => {
  const s1 = { id: 's1', type: 'rect', x: 0, y: 0, w: 100, h: 100 };
  const shape = { from: { x: 0, y: 0, attach: 's1' }, to: { x: 500, y: 500, attach: null } };
  const { from, to } = computeArrowEndpoints(shape, { s1 }, fakeMeasureFn);
  // s1 の中心(50,50)から(500,500)への45度線 → 正方形の角(100,100)
  assert.deepEqual(from, { x: 100, y: 100 });
  assert.deepEqual(to, { x: 500, y: 500 });
});

test('computeArrowEndpoints: 両端が rect に接続していると、互いの中心を結ぶ線と外周の交点になる(枠を動かすと追従する)', () => {
  const s1 = { id: 's1', type: 'rect', x: 0, y: 0, w: 100, h: 100 }; // 中心 (50,50)
  const s2 = { id: 's2', type: 'rect', x: 300, y: 0, w: 100, h: 100 }; // 中心 (350,50)
  const shape = { from: { x: 0, y: 0, attach: 's1' }, to: { x: 0, y: 0, attach: 's2' } };
  const shapesById = { s1, s2 };

  let { from, to } = computeArrowEndpoints(shape, shapesById, fakeMeasureFn);
  assert.deepEqual(from, { x: 100, y: 50 }); // s1 の右辺
  assert.deepEqual(to, { x: 300, y: 50 }); // s2 の左辺

  // s1 を移動すると、追従して交点が変わる
  const s1Moved = { ...s1, x: 100, y: 0 }; // 中心 (150,50)
  ({ from, to } = computeArrowEndpoints(shape, { s1: s1Moved, s2 }, fakeMeasureFn));
  assert.deepEqual(from, { x: 200, y: 50 });
  assert.deepEqual(to, { x: 300, y: 50 });
});

test('computeArrowEndpoints: callout に接続している場合も外周(テキストに合わせた箱)との交点になる', () => {
  // fakeMeasureFn: 1文字 = fontSize*0.5px。text="AB", fontSize=20 → 幅 = 2*20*0.5 = 20
  // padding = round(20*0.6) = 12 → box幅 = 20 + 24 = 44, box高さ = 1*round(20*1.35) + 24 = 27+24 = 51
  const callout = { id: 'c1', type: 'callout', x: 0, y: 0, text: 'AB', fontSize: 20 };
  const box = getShapeOutlineBox(callout, fakeMeasureFn);
  assert.deepEqual(box, computeCalloutBox(callout, fakeMeasureFn));

  const shape = { from: { x: 0, y: 0, attach: 'c1' }, to: { x: box.x + box.w / 2, y: -10000, attach: null } };
  const { from } = computeArrowEndpoints(shape, { c1: callout }, fakeMeasureFn);
  // 中心から真上 → 上辺の中点(浮動小数点の丸め誤差を吸収するため近似比較)
  assert.equal(Math.round(from.x), Math.round(box.x + box.w / 2));
  assert.ok(Math.abs(from.y - box.y) < 1e-9, `from.y が上辺(${box.y})に一致しません: ${from.y}`);
});

test('distanceToRect: 内側は0、外側は最短距離', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(distanceToRect(rect, { x: 50, y: 50 }), 0);
  assert.equal(distanceToRect(rect, { x: 150, y: 50 }), 50);
  assert.equal(distanceToRect(rect, { x: 150, y: 150 }), Math.hypot(50, 50));
});

test('findAttachTarget: 許容距離内なら id を返し、範囲外なら null', () => {
  const shapes = [
    { id: 'r1', type: 'rect', x: 0, y: 0, w: 100, h: 100 },
    { id: 'r2', type: 'rect', x: 300, y: 300, w: 50, h: 50 },
    { id: 'arrowX', type: 'arrow', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, // rect/callout以外は対象外
  ];
  // r1 の右辺から5px外 → 許容距離10なら接続
  assert.equal(findAttachTarget({ x: 105, y: 50 }, shapes, 10), 'r1');
  // 20px外 → 許容距離10では接続しない
  assert.equal(findAttachTarget({ x: 120, y: 50 }, shapes, 10), null);
  // r2 に近い点
  assert.equal(findAttachTarget({ x: 295, y: 320 }, shapes, 10), 'r2');
});

test('computeCalloutBox: テキストの行数・幅に応じて箱のサイズが決まる', () => {
  const shape = { x: 5, y: 7, text: 'A\nBBB', fontSize: 20 };
  const box = computeCalloutBox(shape, fakeMeasureFn);
  // 各行の幅: "A"=10, "BBB"=30 → 最大30
  const padding = Math.round(20 * 0.6); // 12
  const lineHeight = Math.round(20 * 1.35); // 27
  assert.equal(box.x, 5);
  assert.equal(box.y, 7);
  assert.equal(box.w, Math.ceil(30) + padding * 2);
  assert.equal(box.h, 2 * lineHeight + padding * 2);
  assert.deepEqual(box.lines, ['A', 'BBB']);
});

test('buildCalloutPath: しっぽの有無・向きに応じて異なる path 文字列を作る(壊れていないことの確認)', () => {
  const box = { x: 0, y: 0, w: 100, h: 60, fontSize: 20 };
  const noTail = buildCalloutPath(box, null, 10);
  assert.match(noTail, /^M /);
  assert.match(noTail, /Z$/);

  const tailBottom = buildCalloutPath(box, { x: 50, y: 200 }, 10);
  const tailTop = buildCalloutPath(box, { x: 50, y: -200 }, 10);
  assert.notEqual(tailBottom, noTail);
  assert.notEqual(tailBottom, tailTop);
  // しっぽの先端座標が path 文字列に含まれる
  assert.match(tailBottom, /50 200/);
  assert.match(tailTop, /50 -200/);
});
