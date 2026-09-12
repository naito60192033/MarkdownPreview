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
} from '../src/annotator/pngmeta.js';

// 1x1 の赤いピクセルからなる最小の有効な PNG(dev/harness.mjs と同じ既知のバイト列)
const MIN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function minPngBytes() {
  return new Uint8Array(Buffer.from(MIN_PNG_BASE64, 'base64'));
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

test('setAnnotationData/getAnnotationData: JSON(日本語含む)と元画像バイト列を往復できる', () => {
  const json = {
    version: 1,
    original: { mime: 'image/png', width: 10, height: 20 },
    crop: { x: 0, y: 0, w: 10, h: 20 },
    scale: 1,
    shapes: [{ id: 's1', type: 'callout', x: 1, y: 1, text: '注釈テキスト\n2行目', tail: { x: 0, y: 0 } }],
  };
  const originalBytes = new Uint8Array([10, 20, 30, 40, 250, 255, 0]);
  const out = setAnnotationData(minPngBytes(), { json, originalBytes });

  assert.ok(isPngBytes(out));
  const { json: gotJson, originalBytes: gotBytes } = getAnnotationData(out);
  assert.deepEqual(gotJson, json);
  assert.deepEqual(Array.from(gotBytes), Array.from(originalBytes));
});

test('setAnnotationData: 既にチャンクがある PNG に対して呼ぶと、重複せず置き換わる', () => {
  const json1 = { version: 1, original: { mime: 'image/png', width: 1, height: 1 }, crop: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, shapes: [] };
  const json2 = {
    version: 1,
    original: { mime: 'image/png', width: 1, height: 1 },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    scale: 0.5,
    shapes: [{ id: 's1', type: 'rect', x: 0, y: 0, w: 1, h: 1, stroke: '#e53935', strokeWidth: 4 }],
  };
  const once = setAnnotationData(minPngBytes(), { json: json1, originalBytes: new Uint8Array([1]) });
  const twice = setAnnotationData(once, { json: json2, originalBytes: new Uint8Array([2, 3]) });

  const chunks = parseChunks(twice);
  const itxtChunks = chunks.filter((c) => c.type === 'iTXt');
  const mdorChunks = chunks.filter((c) => c.type === ORIGINAL_IMAGE_CHUNK_TYPE);
  assert.equal(itxtChunks.length, 1, 'iTXt チャンクが重複しています');
  assert.equal(mdorChunks.length, 1, 'mdOR チャンクが重複しています');

  const { json, originalBytes } = getAnnotationData(twice);
  assert.deepEqual(json, json2);
  assert.deepEqual(Array.from(originalBytes), [2, 3]);
});

test('getAnnotationData: チャンクが無い通常の PNG に対しては null を返す', () => {
  const { json, originalBytes } = getAnnotationData(minPngBytes());
  assert.equal(json, null);
  assert.equal(originalBytes, null);
});
