// tests/paths.test.js — src/fs/paths.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePath, dirname, basename, extname, joinPath, relativePath, isExternalUrl, urlToPath,
} from '../src/fs/paths.js';

test('normalizePath: . と .. を解決し、\\ を / にそろえる', () => {
  assert.equal(normalizePath('a/./b/../c.md'), 'a/c.md');
  assert.equal(normalizePath('a\\b\\c.md'), 'a/b/c.md');
  assert.equal(normalizePath('/a//b/'), 'a/b');
  assert.equal(normalizePath(''), '');
});

test('normalizePath: ルートを超えると null', () => {
  assert.equal(normalizePath('../a.md'), null);
  assert.equal(normalizePath('a/../../b.md'), null);
});

test('dirname / basename / extname', () => {
  assert.equal(dirname('a/b/c.md'), 'a/b');
  assert.equal(dirname('c.md'), '');
  assert.equal(basename('a/b/c.md'), 'c.md');
  assert.equal(extname('a/b/C.MD'), '.md');
  assert.equal(extname('a/.hidden'), '');
  assert.equal(extname('a/noext'), '');
});

test('joinPath: フォルダ基準で相対パスを解決する', () => {
  assert.equal(joinPath('docs', 'images/x.png'), 'docs/images/x.png');
  assert.equal(joinPath('docs/sub', '../common.md'), 'docs/common.md');
  assert.equal(joinPath('', 'a.md'), 'a.md');
  assert.equal(joinPath('docs', '../../x.md'), null);
});

test('relativePath: フォルダから見た相対パス', () => {
  assert.equal(relativePath('a/b', 'a/img/x.png'), '../img/x.png');
  assert.equal(relativePath('', 'img/x.png'), 'img/x.png');
  assert.equal(relativePath('a', 'a/x.png'), 'x.png');
  assert.equal(relativePath('a/b', ''), '../..');
  assert.equal(relativePath('a', 'a'), '.');
});

test('isExternalUrl: スキーム付き・// 始まり・# 始まりを外部とみなす', () => {
  for (const u of ['http://x', 'https://x', 'data:image/png;base64,', 'mailto:a@b', '//cdn/x', '#見出し', 'C:/x']) {
    assert.equal(isExternalUrl(u), true, u);
  }
  for (const u of ['images/a.png', './a.md', '../a.md', '画像/a.png']) {
    assert.equal(isExternalUrl(u), false, u);
  }
});

test('urlToPath: クエリとフラグメントを落とし、%xx をデコードする', () => {
  assert.equal(urlToPath('images/%E7%94%BB%E5%83%8F.png?v=1#x'), 'images/画像.png');
  assert.equal(urlToPath('a%20b.png'), 'a b.png');
  assert.equal(urlToPath('bad%E0.png'), 'bad%E0.png');
});
