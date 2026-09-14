// tests/annotator-model.test.js — src/annotator/model.js の単体テスト
//
// normalizeLoadedModel() は DOM に依存しない純粋関数なので、node:test からそのまま
// 検証できる(画像の実バイト列を読む部分は annotator.js の loadInitialState 側の
// 責務であり、ここでは扱わない)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoadedModel } from '../src/annotator/model.js';

function v1Json(overrides = {}) {
  return {
    version: 1,
    original: { mime: 'image/png', width: 800, height: 600 },
    crop: { x: 10, y: 20, w: 300, h: 200 },
    scale: 0.75,
    shapes: [{ id: 's1', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#e53935', strokeWidth: 4 }],
    ...overrides,
  };
}

function v2Json(overrides = {}) {
  return {
    version: 2,
    images: [
      { id: 'i1', mime: 'image/png', width: 800, height: 600, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 800, h: 600 } },
      { id: 'i2', mime: 'image/png', width: 100, height: 80, x: 824, y: 0, scale: 1, crop: { x: 0, y: 0, w: 100, h: 80 } },
    ],
    shapes: [],
    scale: 1,
    ...overrides,
  };
}

test('normalizeLoadedModel: v1(version: 1)を images[0] に変換する(座標系はそのまま=キャンバス座標)', () => {
  const result = normalizeLoadedModel(v1Json());
  assert.equal(result.source, 'v1');
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0], {
    id: 'i1',
    mime: 'image/png',
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    scale: 1,
    crop: { x: 10, y: 20, w: 300, h: 200 },
  });
  assert.equal(result.scale, 0.75);
  assert.deepEqual(result.shapes, v1Json().shapes);
});

test('normalizeLoadedModel: version フィールドが無い旧データも v1 として扱う', () => {
  const json = v1Json();
  delete json.version;
  const result = normalizeLoadedModel(json);
  assert.equal(result.source, 'v1');
  assert.equal(result.images[0].id, 'i1');
});

test('normalizeLoadedModel: v2(images配列)をそのまま内部モデルに変換する', () => {
  const result = normalizeLoadedModel(v2Json());
  assert.equal(result.source, 'v2');
  assert.equal(result.images.length, 2);
  assert.equal(result.images[1].id, 'i2');
  assert.equal(result.images[1].x, 824);
  assert.equal(result.scale, 1);
});

test('normalizeLoadedModel: 複製されるので戻り値を書き換えても元の JSON に影響しない', () => {
  const json = v2Json();
  const result = normalizeLoadedModel(json);
  result.images[0].crop.x = 999;
  result.shapes.push({ id: 'x' });
  assert.equal(json.images[0].crop.x, 0);
  assert.equal(json.shapes.length, 0);
});

test('normalizeLoadedModel: 不正な入力(null・オブジェクトでない・必須フィールド欠落)は null を返す', () => {
  assert.equal(normalizeLoadedModel(null), null);
  assert.equal(normalizeLoadedModel(undefined), null);
  assert.equal(normalizeLoadedModel({}), null);
  assert.equal(normalizeLoadedModel({ version: 3 }), null);
  assert.equal(normalizeLoadedModel({ version: 1, original: { width: 1 } }), null); // height 欠落
  assert.equal(normalizeLoadedModel({ version: 1, original: { width: 1, height: 1 } }), null); // crop 欠落
  assert.equal(normalizeLoadedModel({ version: 2, images: [] }), null); // 画像0枚
  assert.equal(normalizeLoadedModel({ version: 2, images: [{ id: 'i1' }] }), null); // width/height/crop 欠落
  assert.equal(normalizeLoadedModel({ version: 1, original: { width: 1, height: 1 }, crop: { x: 0, y: 0, w: 1, h: 1 } }), null); // shapes 欠落
});

test('normalizeLoadedModel: v2 の画像で x/y/scale が省略されていれば既定値(0,0,1)を補う', () => {
  const json = v2Json({
    images: [{ id: 'i1', mime: 'image/png', width: 10, height: 10, crop: { x: 0, y: 0, w: 10, h: 10 } }],
  });
  const result = normalizeLoadedModel(json);
  assert.deepEqual(result.images[0], { id: 'i1', mime: 'image/png', width: 10, height: 10, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 10, h: 10 } });
});
