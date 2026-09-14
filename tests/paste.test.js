// tests/paste.test.js — src/paste.js の連番の決め方の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import { nextImageSerial } from '../src/paste.js';

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

test('nextImageSerial: image-<N>.<拡張子> 以外の名前は数えない', () => {
  assert.equal(
    nextImageSerial(['image.png', 'image-a.png', 'myimage-9.png', 'image-7', 'image-8.png.bak', 'photo.png']),
    1
  );
});
