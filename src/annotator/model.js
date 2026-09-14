// src/annotator/model.js
//
// PNG から読み込んだ注釈データの JSON を検証・正規化する DOM 非依存の純粋関数。
// v1(単一画像 + crop。version が無い、または 1)と v2(images 配列)のどちらの
// 形式で保存されていても、annotator.js が扱う内部モデル
//   { images: [{ id, mime, width, height, x, y, scale, crop }], shapes, scale, source }
// に正規化する。JSON が壊れている・必須フィールドが欠けている場合は null を返し、
// 呼び出し側(annotator.js の loadInitialState)で「注釈なしの普通の画像として開く」
// 判断に使う。
//
// v1 → v2 の対応(座標系はどちらも「キャンバス座標」で同じ意味なのでそのまま使える):
//   images[0] = { id: 'i1', mime: original.mime, width: original.width,
//                 height: original.height, x: 0, y: 0, scale: 1, crop: v1.crop }

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizeCrop(crop) {
  if (!crop || !isFiniteNumber(crop.x) || !isFiniteNumber(crop.y) || !isFiniteNumber(crop.w) || !isFiniteNumber(crop.h)) {
    return null;
  }
  return { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
}

function normalizeShapes(shapes) {
  if (!Array.isArray(shapes)) return null;
  return shapes.map((s) => JSON.parse(JSON.stringify(s)));
}

function normalizeV1(json) {
  const original = json.original;
  if (!original || !isFiniteNumber(original.width) || !isFiniteNumber(original.height)) return null;
  const crop = normalizeCrop(json.crop);
  if (!crop) return null;
  const shapes = normalizeShapes(json.shapes);
  if (!shapes) return null;
  const images = [
    {
      id: 'i1',
      mime: original.mime,
      width: original.width,
      height: original.height,
      x: 0,
      y: 0,
      scale: 1,
      crop,
    },
  ];
  return { images, shapes, scale: isFiniteNumber(json.scale) ? json.scale : 1, source: 'v1' };
}

function normalizeV2Image(img) {
  if (!img || typeof img.id !== 'string' || !img.id) return null;
  if (!isFiniteNumber(img.width) || !isFiniteNumber(img.height)) return null;
  const crop = normalizeCrop(img.crop);
  if (!crop) return null;
  return {
    id: img.id,
    mime: img.mime,
    width: img.width,
    height: img.height,
    x: isFiniteNumber(img.x) ? img.x : 0,
    y: isFiniteNumber(img.y) ? img.y : 0,
    scale: isFiniteNumber(img.scale) ? img.scale : 1,
    crop,
  };
}

function normalizeV2(json) {
  if (!Array.isArray(json.images) || json.images.length === 0) return null;
  const images = [];
  for (const raw of json.images) {
    const img = normalizeV2Image(raw);
    if (!img) return null;
    images.push(img);
  }
  const shapes = normalizeShapes(json.shapes);
  if (!shapes) return null;
  return { images, shapes, scale: isFiniteNumber(json.scale) ? json.scale : 1, source: 'v2' };
}

/**
 * PNG の iTXt から読んだ JSON を内部モデルに正規化する。
 * 戻り値: { images, shapes, scale, source: 'v1'|'v2' } または(不正なら)null。
 */
export function normalizeLoadedModel(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.version === 2) return normalizeV2(json);
  // version が無い、または 1 は v1 形式とみなす
  if (json.version === undefined || json.version === 1) return normalizeV1(json);
  return null;
}
