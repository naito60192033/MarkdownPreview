// tests/names.test.js — src/fs/names.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEntryName, validateCreatePath, ensureMdExtension } from '../src/fs/names.js';

test('validateEntryName: 空・「.」「..」はエラー', () => {
  assert.ok(validateEntryName(''));
  assert.ok(validateEntryName('.'));
  assert.ok(validateEntryName('..'));
});

test('validateEntryName: 禁止文字はエラー', () => {
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    assert.ok(validateEntryName(`a${ch}b`), `${ch} を含む名前が許可されています`);
  }
});

test('validateEntryName: 制御文字はエラー', () => {
  assert.ok(validateEntryName('ab'));
  assert.ok(validateEntryName('a\tb'));
});

test('validateEntryName: 「.」始まりはエラー(ツリーに表示されないため)', () => {
  assert.ok(validateEntryName('.hidden.md'));
  assert.ok(validateEntryName('.git'));
});

test('validateEntryName: 末尾の「.」や空白はエラー', () => {
  assert.ok(validateEntryName('memo.'));
  assert.ok(validateEntryName('memo '));
  assert.equal(validateEntryName('memo'), null);
});

test('validateEntryName: Windows の予約名はエラー(拡張子付きも含む)', () => {
  for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.ok(validateEntryName(name), `${name} が許可されています`);
    assert.ok(validateEntryName(`${name}.md`), `${name}.md が許可されています`);
  }
  // 予約名に似ているだけの名前は許可する
  assert.equal(validateEntryName('CONFIG'), null);
  assert.equal(validateEntryName('COM10'), null);
});

test('validateEntryName: 問題ない名前は null', () => {
  assert.equal(validateEntryName('議事録0912.md'), null);
  assert.equal(validateEntryName('sub'), null);
  assert.equal(validateEntryName('a.b.c.md'), null);
});

test('validateCreatePath: 空・末尾スラッシュ(名前未入力)はエラー', () => {
  assert.ok(validateCreatePath(''));
  assert.ok(validateCreatePath('docs/'));
});

test('validateCreatePath: 先頭スラッシュ・連続スラッシュはエラー', () => {
  assert.ok(validateCreatePath('/a.md'));
  assert.ok(validateCreatePath('a//b.md'));
});

test('validateCreatePath: 途中のフォルダを含むパスは各区切りを検証する', () => {
  assert.equal(validateCreatePath('sub/memo.md'), null);
  assert.equal(validateCreatePath('a/b/c.md'), null);
  assert.ok(validateCreatePath('sub/.hidden.md'), '途中の区切りの「.」始まりを見逃しています');
  assert.ok(validateCreatePath('CON/memo.md'), '途中の区切りの予約名を見逃しています');
});

test('validateCreatePath: ルート直下の名前だけでも検証できる', () => {
  assert.equal(validateCreatePath('memo.md'), null);
  assert.ok(validateCreatePath('memo?.md'));
});

test('ensureMdExtension: 拡張子が無ければ .md を付ける', () => {
  assert.equal(ensureMdExtension('memo'), 'memo.md');
  assert.equal(ensureMdExtension('sub/memo'), 'sub/memo.md');
});

test('ensureMdExtension: 既に .md / .markdown が付いていれば変えない(大文字小文字を問わない)', () => {
  assert.equal(ensureMdExtension('memo.md'), 'memo.md');
  assert.equal(ensureMdExtension('memo.MD'), 'memo.MD');
  assert.equal(ensureMdExtension('memo.markdown'), 'memo.markdown');
  assert.equal(ensureMdExtension('memo.MARKDOWN'), 'memo.MARKDOWN');
});
