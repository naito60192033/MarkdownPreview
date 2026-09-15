// tests/render-pipeline.test.js — src/render/pipeline.js の単体テスト
//
// アプリ本体と同じ組み立て(見出し id・[TOC]・アラート・@import)が
// renderDocument() 経由で正しく連動することを確認する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDocument, stripFrontMatter, collectHeadingsFor } from '../src/render/pipeline.js';
import { updateTocBlocks } from '../src/render/toc.js';

function makeReadText(files) {
  return async (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
}

test('front matter を同じ行数の空行に置き換える', () => {
  const text = '---\ntitle: T\n---\n本文\n';
  assert.equal(stripFrontMatter(text), '\n\n\n本文\n');
});

test('front matter が無ければそのまま', () => {
  assert.equal(stripFrontMatter('# a\n'), '# a\n');
});

test('path/readText が無ければ @import を展開せず、そのまま描画する', async () => {
  const { html, lineMap, deps } = await renderDocument('# 見出し\n\n本文\n');
  assert.match(html, /<h1 id="見出し" data-line="0">見出し<\/h1>/);
  assert.deepEqual(deps, []);
  assert.deepEqual(lineMap, [0, 1, 2, 3]);
});

test('front matter を除去してから描画する(行番号は保たれる)', async () => {
  const text = '---\ntitle: T\n---\n# 見出し\n';
  const { html, lineMap } = await renderDocument(text, { path: 'a.md', readText: makeReadText({}) });
  assert.match(html, /<h1 id="見出し" data-line="3">/);
  assert.equal(lineMap[3], 3);
});

test('@import を展開してから描画する(取り込み先の front matter も除去する)', async () => {
  const files = {
    'a.md': '# 親\n\n@import "b.md"\n',
    'b.md': '---\ntitle: 子\n---\n## 子の見出し\n',
  };
  const { html, deps } = await renderDocument(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  assert.match(html, /<h1 id="親" data-line="0">親<\/h1>/);
  assert.match(html, /<h2 id="子の見出し" data-line="5">子の見出し<\/h2>/);
  assert.deepEqual(deps, ['b.md']);
});

test('[TOC] が見出しの一覧に展開される', async () => {
  const text = '# A\n\n## B\n\n[TOC]\n';
  const { html } = await renderDocument(text, { path: 'a.md', readText: makeReadText({}) });
  assert.match(html, /<a href="#a">A<\/a>/);
  assert.match(html, /<a href="#b">B<\/a>/);
});

test('アラートが div.markdown-alert として描画される', async () => {
  const text = '> [!WARNING]\n> 注意\n';
  const { html } = await renderDocument(text, { path: 'a.md', readText: makeReadText({}) });
  assert.match(html, /class="markdown-alert markdown-alert-warning"/);
  assert.match(html, /<p class="markdown-alert-title" data-line="0"><svg class="octicon octicon-alert"[^>]*>.*<\/svg>Warning<\/p>/);
});

test('alertTitles でタイトルを差し替えられる', async () => {
  const text = '> [!NOTE]\n> 本文\n';
  const { html } = await renderDocument(text, {
    path: 'a.md',
    readText: makeReadText({}),
    alertTitles: { note: 'メモ' },
  });
  assert.match(html, /<p class="markdown-alert-title" data-line="0"><svg class="octicon octicon-info"[^>]*>.*<\/svg>メモ<\/p>/);
});

test('collectHeadingsFor: @import 先の見出しも含めて集め、保存時の TOC 再生成に使える', async () => {
  const files = {
    'a.md': '# 親\n\n<!-- @import "[TOC]" {} -->\n\n<!-- code_chunk_output -->\n\n- old\n\n<!-- /code_chunk_output -->\n\n@import "b.md"\n',
    'b.md': '## 子\n',
  };
  const headings = await collectHeadingsFor(files['a.md'], { path: 'a.md', readText: makeReadText(files) });
  const updated = updateTocBlocks(files['a.md'], headings);
  assert.match(updated, /\[親\]\(#親\)/);
  assert.match(updated, /\[子\]\(#子\)/);
  assert.doesNotMatch(updated, /- old/);
});

test('日本語見出しの id が MPE 互換で生成される', async () => {
  const text = '## 1. はじめに\n';
  const { html } = await renderDocument(text, { path: 'a.md', readText: makeReadText({}) });
  assert.match(html, /<h2 id="1-はじめに"/);
});

test('段落内の 1 回の改行が <br> になる(breaks: true)', async () => {
  const { html } = await renderDocument('1行目\n2行目\n', { path: 'a.md', readText: makeReadText({}) });
  assert.match(html, /1行目<br>\n2行目/);
});

test('行末 2 空白の改行は <br> が二重にならない', async () => {
  const { html } = await renderDocument('1行目  \n2行目\n', { path: 'a.md', readText: makeReadText({}) });
  const matches = html.match(/<br>/g) || [];
  assert.equal(matches.length, 1);
});

test('アラートのタイトル段落には <br> を入れず、本文の改行は <br> になる', async () => {
  const text = '> [!NOTE]\n> 本文1\n> 本文2\n';
  const { html } = await renderDocument(text, { path: 'a.md', readText: makeReadText({}) });
  const titleMatch = html.match(/<p class="markdown-alert-title"[^>]*>.*?<\/p>/s);
  assert.ok(titleMatch);
  assert.doesNotMatch(titleMatch[0], /<br>/);
  assert.match(html, /本文1<br>\n本文2/);
});

test('次の行に {.foo} を書いた段落は、その手前の改行が <br> として残らない', async () => {
  const { html } = await renderDocument('段落の文\n{.foo}\n', { path: 'a.md', readText: makeReadText({}) });
  assert.match(html, /<p class="foo"[^>]*>段落の文<\/p>/);
  assert.doesNotMatch(html, /<br>/);
});

test('```mark コードブロックの中は改行しても <br> にならない', async () => {
  const text = '```mark\nA ==B==\nC\n```\n';
  const { html } = await renderDocument(text, { path: 'a.md', readText: makeReadText({}) });
  assert.doesNotMatch(html, /<br>/);
});
