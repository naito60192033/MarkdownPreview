// tests/render-imports.test.js — src/render/imports.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import { expandImports } from '../src/render/imports.js';

function makeReadText(files) {
  return async (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
}

test('単純な展開', async () => {
  const files = { 'a.md': '前\n@import "b.md"\n後\n', 'b.md': '取り込まれた本文\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, '前\n取り込まれた本文\n\n後\n');
  assert.deepEqual(r.deps, ['b.md']);
  assert.deepEqual(r.errors, []);
});

test('<!-- @import "x.md" --> 形式にも対応する', async () => {
  const files = { 'a.md': '<!-- @import "b.md" -->\n', 'b.md': 'B\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, 'B\n\n');
});

test('入れ子の @import に対応する', async () => {
  const files = {
    'a.md': 'L0\n@import "b.md"\nL2\n',
    'b.md': 'B0\n@import "c.md"\nB2\n',
    'c.md': 'C0\nC1\n',
  };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, 'L0\nB0\nC0\nC1\n\nB2\n\nL2\n');
  assert.deepEqual(r.deps.sort(), ['b.md', 'c.md']);
});

test('lineMap: 取り込んだ行はすべて @import の行(最上位基準)に対応する', async () => {
  const files = {
    'a.md': 'L0\n@import "b.md"\nL2\n',
    'b.md': 'B0\n@import "c.md"\nB2\n',
    'c.md': 'C0\nC1\n',
  };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  // ['L0','B0','C0','C1','','B2','','L2',''] に対応する行番号(0 始まり)
  assert.deepEqual(r.lineMap, [0, 1, 1, 1, 1, 1, 1, 2, 3]);
});

test('別フォルダからの取り込みで画像・リンクの相対パスが書き換わる', async () => {
  const files = {
    'a.md': '@import "sub/b.md"\n',
    'sub/b.md': '![img](img.png)\n\n@import "c.md"\n',
    'sub/c.md': '[link](../top.md)\n\n<a href="deep/x.html">x</a>\n',
  };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.match(r.text, /!\[img\]\(sub\/img\.png\)/);
  assert.match(r.text, /\[link\]\(top\.md\)/);
  assert.match(r.text, /href="sub\/deep\/x\.html"/);
});

test('参照定義と <url> 形式のリンクも書き換わる', async () => {
  const files = {
    'a.md': '@import "sub/b.md"\n',
    'sub/b.md': '[ref]: img/x.png "title"\n\n![y](<img/y with space.png>)\n',
  };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.match(r.text, /\[ref\]: sub\/img\/x\.png "title"/);
  assert.match(r.text, /!\[y\]\(<sub\/img\/y with space\.png>\)/);
});

test('外部 URL と / 始まりのパスは書き換えない', async () => {
  const files = {
    'a.md': '@import "sub/b.md"\n',
    'sub/b.md': '![x](https://example.com/a.png)\n\n[y](/abs/z.png)\n',
  };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.match(r.text, /!\[x\]\(https:\/\/example\.com\/a\.png\)/);
  assert.match(r.text, /\[y\]\(\/abs\/z\.png\)/);
});

test('コードブロック内の @import と URL は無視する', async () => {
  const files = { 'a.md': '```\n@import "x.md"\n![a](img.png)\n```\n', 'x.md': 'X' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, files['a.md']);
  assert.deepEqual(r.deps, []);
});

test('"[TOC]" は展開せずそのまま残す', async () => {
  const files = { 'a.md': '@import "[TOC]"\n\n<!-- @import "[TOC]" {cmd="toc"} -->\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, files['a.md']);
  assert.deepEqual(r.errors, []);
});

test('循環参照はエラーになる', async () => {
  const files = { 'a.md': '@import "b.md"\n', 'b.md': '@import "a.md"\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].reason, '循環参照です');
  assert.match(r.text, /mdp-import-error/);
  assert.match(r.text, /循環参照/);
});

test('見つからないファイルはエラーになる', async () => {
  const files = { 'a.md': '@import "missing.md"\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.errors[0].reason, '見つかりません');
  assert.match(r.text, /missing\.md/);
});

test('ルート外を指すとエラーになる', async () => {
  const files = { 'sub/a.md': '@import "../../x.md"\n' };
  const r = await expandImports(files['sub/a.md'], { path: 'sub/a.md', readText: makeReadText(files) });
  assert.match(r.errors[0].reason, /ワークスペースの外/);
});

test('.md / .markdown 以外の拡張子はエラーになる', async () => {
  const files = { 'a.md': '@import "data.txt"\n', 'data.txt': 'hello' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.match(r.errors[0].reason, /対象外/);
  assert.deepEqual(r.deps, []);
});

test('.markdown 拡張子は展開できる', async () => {
  const files = { 'a.md': '@import "b.markdown"\n', 'b.markdown': 'B\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, 'B\n\n');
  assert.deepEqual(r.errors, []);
});

test('深さの上限を超えるとエラーになる', async () => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`${i}.md`] = `@import "${i + 1}.md"\n`;
  files['12.md'] = 'leaf\n';
  const r = await expandImports(files['0.md'], { path: '0.md', readText: makeReadText(files), maxDepth: 10 });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /深さ/);
});

test('改行コードが CRLF でも正しく動く', async () => {
  const files = { 'a.md': '前\r\n@import "b.md"\r\n後\r\n', 'b.md': '中身\n' };
  const r = await expandImports(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.equal(r.text, '前\r\n中身\r\n\r\n後\r\n');
});
