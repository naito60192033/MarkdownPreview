// tests/paste.test.js — src/paste-save.js(画像の保存まわりの純粋なロジック)の単体テスト
//
// src/paste.js は src/paste-ui.js(CSS を import する)を使うため plain `node --test`
// では読み込めない。ここで検証したい連番の決め方などの純粋なロジックは
// src/paste-save.js に分離してあるので、そちらを直接 import する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextImageSerial, extFromFile, isDrawioClipboardText } from '../src/paste-save.js';

test('nextImageSerial: 空のフォルダなら 1', () => {
  assert.equal(nextImageSerial([]), 1);
});

test('nextImageSerial: 既存の image-<N> の最大値 + 1(拡張子が違っても番号を重ねない)', () => {
  assert.equal(nextImageSerial(['image-1.png', 'image-2.jpg']), 3);
  assert.equal(nextImageSerial(['IMAGE-5.PNG']), 6);
});

test('nextImageSerial: 途中の番号が抜けていても再利用しない', () => {
  assert.equal(nextImageSerial(['image-1.png', 'image-3.png']), 4);
});

test('nextImageSerial: image-<N>.drawio.png のような二重拡張子も数える', () => {
  assert.equal(nextImageSerial(['image-1.png', 'image-4.drawio.png']), 5);
});

test('nextImageSerial: image-<N>.<拡張子> 以外の名前は数えない', () => {
  assert.equal(nextImageSerial(['image.png', 'image-a.png', 'myimage-9.png', 'image-7', 'photo.png']), 1);
});

test('extFromFile: 元の拡張子を保つ(draw.io の .drawio.png も保つ)。名前が無ければ MIME から', () => {
  assert.equal(extFromFile({ name: 'shot.JPG', type: 'image/jpeg' }), '.jpg');
  assert.equal(extFromFile({ name: 'flow.drawio.png', type: 'image/png' }), '.drawio.png');
  assert.equal(extFromFile({ name: 'flow.Drawio.SVG', type: 'image/svg+xml' }), '.drawio.svg');
  assert.equal(extFromFile({ name: 'my.photo.png', type: 'image/png' }), '.png');
  assert.equal(extFromFile({ name: '', type: 'image/webp' }), '.webp');
  assert.equal(extFromFile({ name: '', type: '' }), '.png');
});

test('isDrawioClipboardText: draw.io の通常のコピー(URL エンコードした XML)を見分ける', () => {
  assert.ok(isDrawioClipboardText(encodeURIComponent('<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>')));
  assert.ok(isDrawioClipboardText(encodeURIComponent('<mxfile host="Electron"><diagram>x</diagram></mxfile>')));
  assert.ok(isDrawioClipboardText('<mxGraphModel dx="1"><root/></mxGraphModel>'));
  assert.ok(!isDrawioClipboardText('普通のテキスト'));
  assert.ok(!isDrawioClipboardText('`<mxGraphModel>` の説明'));
  assert.ok(!isDrawioClipboardText(''));
  assert.ok(!isDrawioClipboardText(null));
});
