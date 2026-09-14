// tests/annotator-pngmeta.test.js — src/annotator/pngmeta.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32,
  parseChunks,
  buildChunk,
  serializeChunks,
  findChunk,
  replaceOrInsertChunk,
  encodeITxt,
  decodeITxt,
  setAnnotationData,
  getAnnotationData,
  isPngBytes,
  ANNOTATION_KEYWORD,
  ORIGINAL_IMAGE_CHUNK_TYPE,
  IMAGE_CHUNK_TYPE,
} from '../src/annotator/pngmeta.js';

// 1x1 の赤いピクセルからなる最小の有効な PNG(dev/harness.mjs と同じ既知のバイト列)
const MIN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function minPngBytes() {
  return new Uint8Array(Buffer.from(MIN_PNG_BASE64, 'base64'));
}

function v2Json(overrides = {}) {
  return {
    version: 2,
    images: [
      { id: 'i1', mime: 'image/png', width: 10, height: 20, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 10, h: 20 } },
    ],
    shapes: [],
    scale: 1,
    ...overrides,
  };
}

test('crc32: IEND(データ長0)の CRC は既知の値 AE426082 になる', () => {
  const bytes = new TextEncoder().encode('IEND');
  assert.equal(crc32(bytes).toString(16).toUpperCase().padStart(8, '0'), 'AE426082');
});

test('isPngBytes: シグネチャの有無を判定する', () => {
  assert.equal(isPngBytes(minPngBytes()), true);
  assert.equal(isPngBytes(new Uint8Array([1, 2, 3])), false);
  assert.equal(isPngBytes(new Uint8Array([0xff, 0xd8, 0xff])), false); // JPEG
});

test('parseChunks: 最小 PNG から IHDR/IDAT/IEND を読み取り、CRC が実際の内容と一致する', () => {
  const chunks = parseChunks(minPngBytes());
  const types = chunks.map((c) => c.type);
  assert.ok(types.includes('IHDR'));
  assert.ok(types.includes('IDAT'));
  assert.equal(types[types.length - 1], 'IEND');

  const iend = findChunk(chunks, 'IEND');
  assert.equal(iend.data.length, 0);
  assert.equal(iend.crc.toString(16).toUpperCase().padStart(8, '0'), 'AE426082');

  // 各チャンクの CRC は type+data から再計算した値と一致するはず
  for (const c of chunks) {
    const typeBytes = new TextEncoder().encode(c.type);
    const input = new Uint8Array(typeBytes.length + c.data.length);
    input.set(typeBytes, 0);
    input.set(c.data, typeBytes.length);
    assert.equal(crc32(input), c.crc, `${c.type} の CRC が不一致`);
  }
});

test('buildChunk/serializeChunks: 組み立てたチャンクを再度 parseChunks で読み戻せる(往復一致)', () => {
  const original = parseChunks(minPngBytes());
  const rebuilt = serializeChunks(original.map((c) => ({ type: c.type, data: c.data })));
  const reparsed = parseChunks(rebuilt);
  assert.equal(reparsed.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(reparsed[i].type, original[i].type);
    assert.deepEqual(Array.from(reparsed[i].data), Array.from(original[i].data));
    assert.equal(reparsed[i].crc, original[i].crc);
  }
});

test('encodeITxt/decodeITxt: 日本語テキストを含めて往復させても一致する', () => {
  const text = JSON.stringify({ memo: '日本語のテスト。矢印と赤枠。' });
  const data = encodeITxt({ keyword: ANNOTATION_KEYWORD, text });
  const decoded = decodeITxt(data);
  assert.equal(decoded.keyword, ANNOTATION_KEYWORD);
  assert.equal(decoded.compressionFlag, 0);
  assert.equal(decoded.text, text);
});

test('replaceOrInsertChunk: IEND の直前に挿入される', () => {
  const withChunk = replaceOrInsertChunk(minPngBytes(), { type: 'tEXt', data: new Uint8Array([1, 2, 3]) }, () => false);
  const chunks = parseChunks(withChunk);
  const idx = chunks.findIndex((c) => c.type === 'tEXt');
  assert.equal(chunks[idx + 1].type, 'IEND', '挿入したチャンクの直後が IEND ではありません');
});

test('setAnnotationData/getAnnotationData: v2(1枚)の JSON(日本語含む)と画像バイト列を往復できる', () => {
  const json = v2Json({
    shapes: [{ id: 's1', type: 'callout', x: 1, y: 1, text: '注釈テキスト\n2行目', tail: { x: 0, y: 0 } }],
  });
  const imageBytes = new Uint8Array([10, 20, 30, 40, 250, 255, 0]);
  const out = setAnnotationData(minPngBytes(), { json, images: [{ id: 'i1', bytes: imageBytes }] });

  assert.ok(isPngBytes(out));
  const { json: gotJson, imageBytes: gotMap, originalBytes } = getAnnotationData(out);
  assert.deepEqual(gotJson, json);
  assert.equal(originalBytes, null, 'v2 では mdOR は書かれないはず');
  assert.equal(gotMap.size, 1);
  assert.deepEqual(Array.from(gotMap.get('i1')), Array.from(imageBytes));
});

test('setAnnotationData: 複数画像(mdIM)を1回の呼び出しで往復できる', () => {
  const json = v2Json({
    images: [
      { id: 'i1', mime: 'image/png', width: 10, height: 20, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 10, h: 20 } },
      { id: 'i2', mime: 'image/png', width: 5, height: 5, x: 34, y: 0, scale: 1, crop: { x: 0, y: 0, w: 5, h: 5 } },
    ],
  });
  const images = [
    { id: 'i1', bytes: new Uint8Array([1, 2, 3]) },
    { id: 'i2', bytes: new Uint8Array([9, 9]) },
  ];
  const out = setAnnotationData(minPngBytes(), { json, images });

  const chunks = parseChunks(out);
  const imChunks = chunks.filter((c) => c.type === IMAGE_CHUNK_TYPE);
  assert.equal(imChunks.length, 2, 'mdIM チャンクが2つあるはずです');

  const { json: gotJson, imageBytes } = getAnnotationData(out);
  assert.deepEqual(gotJson, json);
  assert.equal(imageBytes.size, 2);
  assert.deepEqual(Array.from(imageBytes.get('i1')), [1, 2, 3]);
  assert.deepEqual(Array.from(imageBytes.get('i2')), [9, 9]);
});

test('setAnnotationData: 既にチャンクがある PNG に対して呼ぶと、重複せず置き換わる(画像の数が変わっても古いものが残らない)', () => {
  const json1 = v2Json();
  const images1 = [{ id: 'i1', bytes: new Uint8Array([1]) }];
  const json2 = v2Json({
    images: [
      { id: 'i1', mime: 'image/png', width: 10, height: 20, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: 10, h: 20 } },
      { id: 'i2', mime: 'image/png', width: 3, height: 3, x: 34, y: 0, scale: 1, crop: { x: 0, y: 0, w: 3, h: 3 } },
    ],
    scale: 0.5,
  });
  const images2 = [
    { id: 'i1', bytes: new Uint8Array([2, 3]) },
    { id: 'i2', bytes: new Uint8Array([4, 5, 6]) },
  ];
  const once = setAnnotationData(minPngBytes(), { json: json1, images: images1 });
  const twice = setAnnotationData(once, { json: json2, images: images2 });

  const chunks = parseChunks(twice);
  const itxtChunks = chunks.filter((c) => c.type === 'iTXt');
  const imChunks = chunks.filter((c) => c.type === IMAGE_CHUNK_TYPE);
  assert.equal(itxtChunks.length, 1, 'iTXt チャンクが重複しています');
  assert.equal(imChunks.length, 2, '1回目の mdIM が残らず、2回目の2枚だけになっているはずです');

  const { json, imageBytes } = getAnnotationData(twice);
  assert.deepEqual(json, json2);
  assert.deepEqual(Array.from(imageBytes.get('i1')), [2, 3]);
  assert.deepEqual(Array.from(imageBytes.get('i2')), [4, 5, 6]);
});

test('getAnnotationData: v1(mdOR + version無し)の PNG も読み込める(後方互換)', () => {
  // v1 は replaceOrInsertChunk を2回呼ぶ形で組み立てていた(旧 setAnnotationData 相当)。
  // 本テストでは buildChunk 等の低レベル API で v1 相当のチャンクを直接組み立てる。
  const v1Json = {
    version: 1,
    original: { mime: 'image/png', width: 10, height: 20 },
    crop: { x: 0, y: 0, w: 10, h: 20 },
    scale: 1,
    shapes: [{ id: 's1', type: 'rect', x: 0, y: 0, w: 1, h: 1, stroke: '#e53935', strokeWidth: 4 }],
  };
  const itxtData = encodeITxt({ keyword: ANNOTATION_KEYWORD, text: JSON.stringify(v1Json) });
  const originalBytes = new Uint8Array([5, 6, 7]);
  let out = replaceOrInsertChunk(minPngBytes(), { type: 'iTXt', data: itxtData }, () => false);
  out = replaceOrInsertChunk(out, { type: ORIGINAL_IMAGE_CHUNK_TYPE, data: originalBytes }, () => false);

  const { json, originalBytes: gotOriginal, imageBytes } = getAnnotationData(out);
  assert.deepEqual(json, v1Json);
  assert.deepEqual(Array.from(gotOriginal), Array.from(originalBytes));
  assert.equal(imageBytes.size, 0, 'v1 には mdIM は無いはず');
});

test('getAnnotationData: チャンクが無い通常の PNG に対しては json/originalBytes が null、imageBytes は空になる', () => {
  const { json, originalBytes, imageBytes } = getAnnotationData(minPngBytes());
  assert.equal(json, null);
  assert.equal(originalBytes, null);
  assert.equal(imageBytes.size, 0);
});
