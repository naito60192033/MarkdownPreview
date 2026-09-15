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
  getShapeVisualBounds,
  buildCalloutPath,
  unionRect,
  imageVisibleRect,
  imageFullRect,
  resizeImageFromCorner,
  computeOutputBounds,
  nearestSide,
  sidePoint,
  facingSide,
  routeElbow,
  computeElbowRoute,
  ELBOW_STUB,
  ELBOW_BEND_PENALTY,
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

// ---------- 複数画像キャンバス向けの幾何計算 ----------

test('unionRect: 2つの矩形を囲む最小の矩形になる。null はもう片方をそのまま返す', () => {
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 }), { x: 0, y: -5, w: 15, h: 15 });
  assert.deepEqual(unionRect(null, { x: 1, y: 2, w: 3, h: 4 }), { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(unionRect({ x: 1, y: 2, w: 3, h: 4 }, null), { x: 1, y: 2, w: 3, h: 4 });
});

test('imageVisibleRect/imageFullRect: 画像の配置(x,y,scale)と切り抜き(crop)からキャンバス座標の矩形を求める', () => {
  const img = { x: 100, y: 50, scale: 2, width: 200, height: 100, crop: { x: 10, y: 20, w: 80, h: 40 } };
  assert.deepEqual(imageVisibleRect(img), { x: 120, y: 90, w: 160, h: 80 });
  assert.deepEqual(imageFullRect(img), { x: 100, y: 50, w: 400, h: 200 });
});

test('getShapeVisualBounds: rect は線幅の半分だけ外側に広がる', () => {
  const shape = { type: 'rect', x: 10, y: 10, w: 100, h: 50, strokeWidth: 8 };
  assert.deepEqual(getShapeVisualBounds(shape), { x: 6, y: 6, w: 108, h: 58 });
});

test('getShapeVisualBounds: arrow は線の両端(線幅考慮)と矢じりの頂点をすべて含む', () => {
  const shape = { type: 'arrow', from: { x: 0, y: 0, attach: null }, to: { x: 100, y: 0, attach: null }, strokeWidth: 4 };
  const bounds = getShapeVisualBounds(shape, {}, () => 0);
  const half = 2;
  // 矢じりは to(100,0) の手前に三角形として張り出すため、上下(y方向)にもはみ出す
  assert.ok(Math.abs(bounds.x - (0 - half)) < 1e-9, `from 側の線幅半分を含んでいません: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.x + bounds.w > 100 + half - 1e-9, `to 側/矢じりの右端を含んでいません: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.y < -half + 1e-9 && bounds.y + bounds.h > half - 1e-9, `矢じりの上下への張り出しを含んでいません: ${JSON.stringify(bounds)}`);
});

test('getShapeVisualBounds: callout は枠 + しっぽの先端を含み、線幅の半分だけ外側に広がる', () => {
  const shape = { type: 'callout', x: 0, y: 0, text: 'AB', fontSize: 20, strokeWidth: 4, tail: { x: 200, y: 5 } };
  const bounds = getShapeVisualBounds(shape, {}, fakeMeasureFn);
  // computeCalloutBox: w=44, h=51(このファイル先頭の computeCalloutBox テスト参照の式と同じ)
  assert.equal(bounds.x, -2);
  assert.equal(bounds.y, -2);
  assert.equal(bounds.x + bounds.w, 200, 'しっぽの先端(x=200)まで広がっているはずです');
  assert.equal(bounds.y + bounds.h, 53, '枠の下端+線幅半分(51+2)までのはずです');
});

test('computeOutputBounds: 画像1枚・注釈なしならその画像の表示矩形と一致する', () => {
  const img = { id: 'i1', x: 0, y: 0, scale: 1, width: 800, height: 600, crop: { x: 0, y: 0, w: 800, h: 600 } };
  assert.deepEqual(computeOutputBounds([img], []), { x: 0, y: 0, w: 800, h: 600 });
});

test('computeOutputBounds: 画像1枚+内側に収まる図形なら出力は画像の表示矩形のまま(= v1と同じ出力)', () => {
  const img = { id: 'i1', x: 0, y: 0, scale: 1, width: 800, height: 600, crop: { x: 0, y: 0, w: 800, h: 600 } };
  const rect = { id: 's1', type: 'rect', x: 100, y: 100, w: 50, h: 50, strokeWidth: 2 };
  assert.deepEqual(computeOutputBounds([img], [rect]), { x: 0, y: 0, w: 800, h: 600 });
});

test('computeOutputBounds: 図形が画像の外にはみ出すと出力範囲が広がる', () => {
  const img = { id: 'i1', x: 0, y: 0, scale: 1, width: 800, height: 600, crop: { x: 0, y: 0, w: 800, h: 600 } };
  const callout = { id: 's1', type: 'callout', x: 50, y: -80, text: 'A', fontSize: 20, strokeWidth: 2 };
  const bounds = computeOutputBounds([img], [callout], fakeMeasureFn);
  assert.ok(bounds.y < 0, `上にはみ出た分だけ出力範囲が広がるはずです: ${JSON.stringify(bounds)}`);
  assert.equal(bounds.x, 0, 'x は画像の左端のまま');
});

test('computeOutputBounds: 複数画像の和集合になる', () => {
  const img1 = { id: 'i1', x: 0, y: 0, scale: 1, width: 100, height: 100, crop: { x: 0, y: 0, w: 100, h: 100 } };
  const img2 = { id: 'i2', x: 124, y: 50, scale: 1, width: 50, height: 50, crop: { x: 0, y: 0, w: 50, h: 50 } };
  assert.deepEqual(computeOutputBounds([img1, img2], []), { x: 0, y: 0, w: 174, h: 100 });
});

test('resizeImageFromCorner: se ハンドルをちょうど2倍の対角点まで引くと nw(反対の角)が固定されscaleが2倍になる', () => {
  const img = { x: 0, y: 0, scale: 1, width: 200, height: 100, crop: { x: 0, y: 0, w: 200, h: 100 } };
  const result = resizeImageFromCorner(img, 'se', { x: 400, y: 200 }, 16);
  assert.deepEqual(result, { x: 0, y: 0, scale: 2 });
});

test('resizeImageFromCorner: nw ハンドルを引くと se(反対の角)が固定される(縮小)', () => {
  const img = { x: 0, y: 0, scale: 1, width: 200, height: 100, crop: { x: 0, y: 0, w: 200, h: 100 } };
  // se(固定角)= (200,100)。半分の位置(100,50)まで nw を引くと scale=0.5 になる
  const result = resizeImageFromCorner(img, 'nw', { x: 100, y: 50 }, 16);
  assert.deepEqual(result, { x: 100, y: 50, scale: 0.5 });
  // 反対側の角(se)が動かないことを確認する
  const rect = imageVisibleRect({ ...img, ...result });
  assert.equal(rect.x + rect.w, 200);
  assert.equal(rect.y + rect.h, 100);
});

test('resizeImageFromCorner: 縦横比は常に crop.w/crop.h のまま保たれる(自由な方向にドラッグしても)', () => {
  const img = { x: 10, y: 20, scale: 1.5, width: 300, height: 100, crop: { x: 0, y: 0, w: 300, h: 100 } };
  const result = resizeImageFromCorner(img, 'se', { x: 500, y: 150 }, 16); // 対角線から外れた点
  const newImg = { ...img, ...result };
  const rect = imageVisibleRect(newImg);
  assert.ok(Math.abs(rect.w / rect.h - img.width / img.height) < 1e-9, `縦横比が変わってしまっています: ${rect.w}/${rect.h}`);
});

test('resizeImageFromCorner: 表示矩形の短辺が minSize を下回らないようクランプする', () => {
  const img = { x: 0, y: 0, scale: 1, width: 200, height: 100, crop: { x: 0, y: 0, w: 200, h: 100 } };
  // se を nw のすぐ近く(ほぼ0サイズ)まで引こうとしても、短辺が16px未満にはならない
  const result = resizeImageFromCorner(img, 'se', { x: 1, y: 0.5 }, 16);
  const rect = imageVisibleRect({ ...img, ...result });
  assertMinSize(rect, 16);
});

function assertMinSize(rect, minSize) {
  assert.ok(Math.min(rect.w, rect.h) >= minSize - 1e-6, `短辺が最小サイズを下回っています: ${JSON.stringify(rect)}`);
}

test('resizeImageFromCorner: 既に切り抜き・オフセットのある画像でも対角の角が固定される', () => {
  const img = { x: 50, y: 30, scale: 2, width: 400, height: 300, crop: { x: 20, y: 10, w: 100, h: 80 } };
  const before = imageVisibleRect(img);
  const neFixed = { x: before.x + before.w, y: before.y }; // sw をドラッグしたときの固定角(ne)
  const result = resizeImageFromCorner(img, 'sw', { x: before.x - 20, y: before.y + before.h + 20 }, 16);
  const after = imageVisibleRect({ ...img, ...result });
  assertClosePoint({ x: after.x + after.w, y: after.y }, neFixed);
});

function assertClosePoint(actual, expected, tol = 1e-6) {
  assert.ok(Math.abs(actual.x - expected.x) < tol && Math.abs(actual.y - expected.y) < tol, `点が一致しません: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
}

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

// ---------- カギ線(elbow)矢印の経路計算 ----------

// 隣り合う点がすべて水平・垂直で、重複点が無いことを確認する
function assertAxisAlignedNoDup(points) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    assert.ok(!(a.x === b.x && a.y === b.y), `隣り合う点が重複しています: ${JSON.stringify(points)}`);
    assert.ok(a.x === b.x || a.y === b.y, `隣り合う点が水平・垂直になっていません: ${JSON.stringify(points)}`);
  }
}

// 水平/垂直な線分 a→b が rect の内側(境界・角は含まない)を通るか(テスト用の簡易チェック。
// shapes.js 内部の axisSegmentCrossesRect と同じ考え方)
function segmentEntersRect(a, b, rect) {
  if (a.x === b.x) {
    if (a.x <= rect.x || a.x >= rect.x + rect.w) return false;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return hi > rect.y && lo < rect.y + rect.h;
  }
  if (a.y === b.y) {
    if (a.y <= rect.y || a.y >= rect.y + rect.h) return false;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return hi > rect.x && lo < rect.x + rect.w;
  }
  return false;
}

function assertNoRectCrossing(points, rects) {
  for (let i = 0; i < points.length - 1; i++) {
    for (const rect of rects) {
      assert.ok(
        !segmentEntersRect(points[i], points[i + 1], rect),
        `線分が矩形の内側を通っています: ${JSON.stringify(points[i])}-${JSON.stringify(points[i + 1])} rect=${JSON.stringify(rect)}`
      );
    }
  }
}

// a→b の移動方向('top'|'right'|'bottom'|'left')
function dirOf(a, b) {
  if (a.x === b.x) return b.y > a.y ? 'bottom' : 'top';
  return b.x > a.x ? 'right' : 'left';
}

test('ELBOW_STUB・ELBOW_BEND_PENALTY: 既定値', () => {
  assert.equal(ELBOW_STUB, 16);
  assert.ok(ELBOW_BEND_PENALTY > ELBOW_STUB, 'ペナルティはスタブより大きく、曲がりを避けさせる程度の値のはず');
});

test('nearestSide: 点に一番近い辺を返す。同距離なら top, right, bottom, left の順', () => {
  const box = { x: 0, y: 0, w: 100, h: 50 };
  assert.equal(nearestSide(box, { x: 50, y: -10 }), 'top');
  assert.equal(nearestSide(box, { x: 110, y: 25 }), 'right');
  assert.equal(nearestSide(box, { x: 50, y: 60 }), 'bottom');
  assert.equal(nearestSide(box, { x: -10, y: 25 }), 'left');
  // 正方形の右下の角の外側 → right/bottom が同距離。right が先なので right を選ぶ
  const square = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(nearestSide(square, { x: 110, y: 110 }), 'right');
});

test('sidePoint: 指定した辺の中点', () => {
  const box = { x: 10, y: 20, w: 100, h: 50 };
  assert.deepEqual(sidePoint(box, 'top'), { x: 60, y: 20 });
  assert.deepEqual(sidePoint(box, 'right'), { x: 110, y: 45 });
  assert.deepEqual(sidePoint(box, 'bottom'), { x: 60, y: 70 });
  assert.deepEqual(sidePoint(box, 'left'), { x: 10, y: 45 });
});

test('facingSide: box の縦横比で正規化した方向に一番近い辺を選ぶ', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 }; // 中心 (50,50)
  assert.equal(facingSide(box, { x: 500, y: 60 }), 'right');
  assert.equal(facingSide(box, { x: -500, y: 40 }), 'left');
  assert.equal(facingSide(box, { x: 55, y: 500 }), 'bottom');
  assert.equal(facingSide(box, { x: 45, y: -500 }), 'top');
});

test('routeElbow: 両端とも未接続・横長 → 横→縦→横。mid で中央の縦線の位置が変わる', () => {
  const start = { x: 0, y: 0, dir: null };
  const end = { x: 200, y: 50, dir: null };
  const half = routeElbow(start, end, [], 0.5);
  assert.deepEqual(half.points, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 50 }]);
  assertAxisAlignedNoDup(half.points);
  assert.deepEqual(half.midSegment, { axis: 'x', lo: 0, hi: 200, index: 1 });

  const quarter = routeElbow(start, end, [], 0.25);
  assert.deepEqual(quarter.points, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 200, y: 50 }]);
});

test('routeElbow: 両端とも未接続・縦長 → 縦→横→縦', () => {
  const result = routeElbow({ x: 0, y: 0, dir: null }, { x: 50, y: 200, dir: null }, [], 0.5);
  assert.deepEqual(result.points, [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 50, y: 100 }, { x: 50, y: 200 }]);
  assertAxisAlignedNoDup(result.points);
  assert.deepEqual(result.midSegment, { axis: 'y', lo: 0, hi: 200, index: 1 });
});

test('routeElbow: 両端とも未接続で dx か dy が0なら1本の直線(midSegment は null)', () => {
  const result = routeElbow({ x: 0, y: 0, dir: null }, { x: 200, y: 0, dir: null }, [], 0.5);
  assert.deepEqual(result.points, [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
  assert.equal(result.midSegment, null);
});

test('routeElbow: 向かい合う辺(A の right → 右下にずれた B の left)は Z字になり、中央の縦線を mid で調整できる', () => {
  const A = { x: 0, y: 0, w: 100, h: 100 };
  const B = { x: 300, y: 150, w: 100, h: 100 };
  const S = sidePoint(A, 'right'); // (100, 50)
  const E = sidePoint(B, 'left'); // (300, 200)

  const half = routeElbow({ ...S, dir: 'right' }, { ...E, dir: 'left' }, [A, B], 0.5);
  assert.equal(half.points.length, 4, 'Z字(簡約後4点)になるはず');
  assert.deepEqual(half.points[0], S, '先頭は A の右辺の中点');
  assert.deepEqual(half.points[half.points.length - 1], E, '末尾は B の左辺の中点');
  assertAxisAlignedNoDup(half.points);
  assert.ok(half.midSegment, 'midSegment が非null のはず');
  assert.equal(half.midSegment.axis, 'x');
  // 中央の縦線はスタブ(ELBOW_STUB)の先どうしの中間
  assert.equal(half.midSegment.lo, S.x + ELBOW_STUB);
  assert.equal(half.midSegment.hi, E.x - ELBOW_STUB);
  const midX = (half.midSegment.lo + half.midSegment.hi) / 2;
  assert.equal(half.points[1].x, midX);
  assert.equal(half.points[2].x, midX);

  const quarter = routeElbow({ ...S, dir: 'right' }, { ...E, dir: 'left' }, [A, B], 0.2);
  assert.notEqual(quarter.points[1].x, half.points[1].x, 'mid を変えると位置が変わるはず');
  const expectedX = half.midSegment.lo + (half.midSegment.hi - half.midSegment.lo) * 0.2;
  assert.equal(quarter.points[1].x, expectedX);
});

test('routeElbow: A の right → 右下の B の top は L字(簡約後3点・曲がり1回)', () => {
  const A = { x: 0, y: 0, w: 100, h: 100 };
  const B = { x: 200, y: 200, w: 100, h: 100 };
  const S = sidePoint(A, 'right');
  const E = sidePoint(B, 'top');
  const result = routeElbow({ ...S, dir: 'right' }, { ...E, dir: 'top' }, [A, B], 0.5);
  assert.equal(result.points.length, 3, 'L字(簡約後3点)になるはず');
  assertAxisAlignedNoDup(result.points);
  assert.equal(result.midSegment, null, 'L字には中央の線のハンドルは無い');
  assertNoRectCrossing(result.points, [A, B]);
});

test('routeElbow: 後ろ向き(A の right → A より左にある B の left)でも枠の内側を通り抜けない', () => {
  const A = { x: 0, y: 0, w: 100, h: 100 };
  const B = { x: -300, y: 20, w: 100, h: 100 }; // A より左
  const S = sidePoint(A, 'right');
  const E = sidePoint(B, 'left');
  const result = routeElbow({ ...S, dir: 'right' }, { ...E, dir: 'left' }, [A, B], 0.5);
  assertAxisAlignedNoDup(result.points);
  assertNoRectCrossing(result.points, [A, B]);
  const pts = result.points;
  assert.equal(dirOf(pts[0], pts[1]), 'right', '最初の線分は right 向き(A から出る向き)');
  assert.equal(dirOf(pts[pts.length - 2], pts[pts.length - 1]), 'right', '最後の線分は right 向き(B の left 辺に入る向き)');
});

test('routeElbow: 同じ向きの辺(A の right → B の right)でも枠の内側を通り抜けない(コの字)', () => {
  const A = { x: 0, y: 0, w: 100, h: 100 };
  const B = { x: 300, y: 20, w: 100, h: 100 };
  const S = sidePoint(A, 'right');
  const E = sidePoint(B, 'right');
  const result = routeElbow({ ...S, dir: 'right' }, { ...E, dir: 'right' }, [A, B], 0.5);
  assertAxisAlignedNoDup(result.points);
  assertNoRectCrossing(result.points, [A, B]);
  const pts = result.points;
  assert.equal(dirOf(pts[0], pts[1]), 'right', '最初の線分は right 向き(A から出る向き)');
  assert.equal(dirOf(pts[pts.length - 2], pts[pts.length - 1]), 'left', '最後の線分は left 向き(B の right 辺に入る向き)');
});

test('routeElbow: 経路が見つからない極端なケースでも何かしらの経路を返す(フォールバック)', () => {
  // 巨大な障害物を混ぜて、P・Q が格子上のどのノードにもつながらない(完全に孤立する)
  // 状況を作る → ダイクストラで E に到達できず、フォールバックの Z字が使われるはず
  const A = { x: 0, y: 0, w: 10, h: 10 };
  const B = { x: 1000, y: 1000, w: 10, h: 10 };
  const huge = { x: -100000, y: -100000, w: 200000, h: 200000 };
  const S = sidePoint(A, 'right');
  const E = sidePoint(B, 'left');
  const result = routeElbow({ ...S, dir: 'right' }, { ...E, dir: 'left' }, [A, B, huge], 0.5);
  assert.ok(Array.isArray(result.points) && result.points.length >= 2, '経路が見つからなくても必ず何か返す');
  assertAxisAlignedNoDup(result.points);
  // フォールバックは S→P→(中央)→Q→E の Z字(障害物は無視)になる
  const P = { x: S.x + ELBOW_STUB, y: S.y };
  const Q = { x: E.x - ELBOW_STUB, y: E.y };
  assert.deepEqual(result.points[0], S);
  assert.deepEqual(result.points[1], P);
  assert.deepEqual(result.points[result.points.length - 2], Q);
  assert.deepEqual(result.points[result.points.length - 1], E);
});

test('computeElbowRoute: 接続している端は対応する枠の辺の中点・向きになる。side 未指定なら facingSide で自動選択される', () => {
  const A = { id: 'A', type: 'rect', x: 0, y: 0, w: 100, h: 100 };
  const B = { id: 'B', type: 'rect', x: 300, y: 150, w: 100, h: 100 };
  const shapesById = { A, B };
  const shape = {
    id: 's1',
    type: 'arrow',
    routing: 'elbow',
    from: { x: 0, y: 0, attach: 'A', side: null },
    to: { x: 0, y: 0, attach: 'B', side: null },
    mid: 0.5,
  };
  const result = computeElbowRoute(shape, shapesById, fakeMeasureFn);
  // B は A から見て右下 → A は 'right' 辺、B は A から見た逆方向('left' 辺)を自動選択
  assert.deepEqual(result.points[0], sidePoint(A, 'right'));
  assert.deepEqual(result.points[result.points.length - 1], sidePoint(B, 'left'));

  // side を明示すればそちらが優先される
  const shapeWithSide = { ...shape, from: { ...shape.from, side: 'bottom' } };
  const resultWithSide = computeElbowRoute(shapeWithSide, shapesById, fakeMeasureFn);
  assert.deepEqual(resultWithSide.points[0], sidePoint(A, 'bottom'));
});

test('computeElbowRoute: 未接続の端は生の座標をそのまま使う(障害物にも含めない)', () => {
  const shape = {
    id: 's2',
    type: 'arrow',
    routing: 'elbow',
    from: { x: 0, y: 0, attach: null },
    to: { x: 200, y: 80, attach: null },
    mid: 0.5,
  };
  const result = computeElbowRoute(shape, {}, fakeMeasureFn);
  assert.deepEqual(result.points[0], { x: 0, y: 0 });
  assert.deepEqual(result.points[result.points.length - 1], { x: 200, y: 80 });
});

test('computeArrowEndpoints: routing が elbow の矢印は経路の先頭・末尾を使う(直線の矢印の挙動は変わらない)', () => {
  const A = { id: 'A', type: 'rect', x: 0, y: 0, w: 100, h: 100 };
  const B = { id: 'B', type: 'rect', x: 300, y: 150, w: 100, h: 100 };
  const shapesById = { A, B };
  const shape = {
    id: 's1',
    type: 'arrow',
    routing: 'elbow',
    from: { x: 0, y: 0, attach: 'A', side: null },
    to: { x: 0, y: 0, attach: 'B', side: null },
    mid: 0.5,
  };
  const { from, to } = computeArrowEndpoints(shape, shapesById, fakeMeasureFn);
  assert.deepEqual(from, sidePoint(A, 'right'));
  assert.deepEqual(to, sidePoint(B, 'left'));
});

test('getShapeVisualBounds: routing が elbow の矢印は折れ点(バウンディングボックス)もすべて含む', () => {
  const A = { id: 'A', type: 'rect', x: 0, y: 0, w: 100, h: 100 };
  const B = { id: 'B', type: 'rect', x: 300, y: 150, w: 100, h: 100 };
  const shapesById = { A, B };
  const shape = {
    id: 's1',
    type: 'arrow',
    routing: 'elbow',
    from: { x: 0, y: 0, attach: 'A', side: null },
    to: { x: 0, y: 0, attach: 'B', side: null },
    mid: 0.5,
    strokeWidth: 2,
  };
  const bounds = getShapeVisualBounds(shape, shapesById, fakeMeasureFn);
  const half = 1;
  // 経路は (100,50) → (200,50) → (200,200) → (300,200) の Z字。折れ点(200,50)・(200,200)を含む
  assert.ok(Math.abs(bounds.x - (100 - half)) < 1e-9, `始点側の線幅半分を含んでいません: ${JSON.stringify(bounds)}`);
  assert.ok(Math.abs(bounds.y - (50 - half)) < 1e-9, `折れ点(200,50)の上端を含んでいません: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.x + bounds.w > 300 + half - 1e-9, `終点側の線幅半分を含んでいません: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.y + bounds.h > 200 + half - 1e-9, `折れ点(200,200)・終点付近を含んでいません: ${JSON.stringify(bounds)}`);
});
