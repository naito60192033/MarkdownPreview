// tests/render-toc.test.js — src/render/toc.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import attrs from 'markdown-it-attrs';
import { headingIdPlugin } from '../src/render/slug.js';
import { toc, tocPlugin, collectHeadings, updateTocBlocks } from '../src/render/toc.js';

// アプリ本体と同じ順番でプラグインを登録する。
function makeMd(tocOptions) {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(footnote);
  md.use(taskLists);
  md.use(attrs);
  md.use(headingIdPlugin);
  md.use(tocPlugin, tocOptions);
  return md;
}

test('toc(): 見出しからネストした markdown のリストを作る', () => {
  const headings = [
    { content: 'A', level: 1, id: 'a' },
    { content: 'B', level: 2, id: 'b' },
    { content: 'C', level: 1, id: 'c' },
  ];
  const result = toc(headings, {});
  assert.equal(result.content, '- [A](#a)\n  - [B](#b)\n- [C](#c)');
});

test('toc(): ordered なら番号付き・4 スペースインデント', () => {
  const headings = [
    { content: 'A', level: 1, id: 'a' },
    { content: 'B', level: 2, id: 'b' },
    { content: 'B2', level: 2, id: 'b2' },
    { content: 'C', level: 1, id: 'c' },
  ];
  const result = toc(headings, { ordered: true });
  assert.equal(result.content, '1. [A](#a)\n    1. [B](#b)\n    2. [B2](#b2)\n2. [C](#c)');
});

test('toc(): depthFrom / depthTo で絞り込む', () => {
  const headings = [
    { content: 'A', level: 1, id: 'a' },
    { content: 'B', level: 2, id: 'b' },
    { content: 'C', level: 3, id: 'c' },
  ];
  assert.equal(toc(headings, { depthFrom: 2, depthTo: 2 }).content, '- [B](#b)');
  assert.equal(toc(headings, {}).array.length, 3);
});

test('toc(): ignoreLink はリンクにしない', () => {
  const headings = [{ content: 'A', level: 1, id: 'a' }];
  assert.equal(toc(headings, { ignoreLink: true }).content, '- A');
});

test('[TOC] がネストしたリストに展開される', () => {
  const md = makeMd();
  const html = md.render('# A\n\n## B\n\n[TOC]\n\n# C\n');
  assert.equal(
    html,
    '<h1 id="a">A</h1>\n<h2 id="b">B</h2>\n' +
      '<ul data-line="4"><li><a href="#a">A</a><ul><li><a href="#b">B</a></li></ul></li><li><a href="#c">C</a></li></ul>' +
      '<h1 id="c">C</h1>\n',
  );
});

test('[TOC]: ignore の見出しは除外される', () => {
  const md = makeMd();
  const html = md.render('# A\n\n# B {ignore=true}\n\n[TOC]\n');
  assert.match(html, /<a href="#a">A<\/a>/);
  assert.doesNotMatch(html, /href="#b"/);
});

test('[TOC]: depthFrom / depthTo / ordered / ignoreLink をプラグインの options で指定できる', () => {
  const mdOrdered = makeMd({ ordered: true });
  assert.match(mdOrdered.render('# A\n\n## B\n\n[TOC]\n'), /<ol><li>/);

  const mdDepth = makeMd({ depthFrom: 2, depthTo: 2 });
  const html = mdDepth.render('# A\n\n## B\n\n[TOC]\n');
  assert.doesNotMatch(html, /href="#a"/);
  assert.match(html, /href="#b"/);

  const mdIgnoreLink = makeMd({ ignoreLink: true });
  const html2 = mdIgnoreLink.render('# A\n\n[TOC]\n');
  assert.doesNotMatch(html2, /<a /);
});

test('[TOC]: 見出しが無ければ何も残らない', () => {
  const md = makeMd();
  const html = md.render('[TOC]\n\n本文\n');
  assert.equal(html, '<p>本文</p>\n');
});

test('[TOC]: スクロール同期用に data-line(0 始まり)が最上位のリストに付く', () => {
  const html = makeMd().render('# A\n\n[TOC]\n\n## B\n');
  assert.match(html, /<ul data-line="2">/);
});

test('updateTocBlocks: 新規挿入(既存の code_chunk_output が無い場合)', () => {
  const md = makeMd();
  const headings = collectHeadings(md, '# 見出し\n\n## 小見出し\n');
  const src = '<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->\n\n本文\n';
  const out = updateTocBlocks(src, headings);
  assert.equal(
    out,
    '<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->\n' +
      '\n<!-- code_chunk_output -->\n\n- [見出し](#見出し)\n  - [小見出し](#小見出し)\n\n<!-- /code_chunk_output -->\n' +
      '\n本文\n',
  );
});

test('updateTocBlocks: 既存ブロックの中身を置き換える', () => {
  const md = makeMd();
  const headings = collectHeadings(md, '# 新しい見出し\n');
  const src =
    '<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->\n' +
    '\n<!-- code_chunk_output -->\n\n- [古い見出し](#古い見出し)\n\n<!-- /code_chunk_output -->\n' +
    '\n本文\n';
  const out = updateTocBlocks(src, headings);
  assert.match(out, /- \[新しい見出し\]\(#新しい見出し\)/);
  assert.doesNotMatch(out, /古い見出し/);
});

test('updateTocBlocks: 変更が無ければ同じ文字列を返す', () => {
  const md = makeMd();
  const headings = collectHeadings(md, '# 見出し\n');
  const src = '<!-- @import "[TOC]" {} -->\n\n<!-- code_chunk_output -->\n\n- [見出し](#見出し)\n\n<!-- /code_chunk_output -->\n';
  const out1 = updateTocBlocks(src, headings);
  assert.equal(out1, src);
  const out2 = updateTocBlocks(out1, headings);
  assert.equal(out2, out1);
});

test('updateTocBlocks: depthFrom / depthTo / orderedList / ignoreLink 属性を解釈する', () => {
  const headings = [
    { content: 'A', level: 1, id: 'a' },
    { content: 'B', level: 2, id: 'b' },
  ];
  const src = '<!-- @import "[TOC]" {depthFrom=2 depthTo=2 orderedList=true ignoreLink=true} -->\n';
  const out = updateTocBlocks(src, headings);
  assert.match(out, /1\. B\n/);
  assert.doesNotMatch(out, /\[A\]/);
});

test('updateTocBlocks: CRLF を保つ', () => {
  const headings = [{ content: 'H', level: 1, id: 'h' }];
  const src = '<!-- @import "[TOC]" {} -->\r\n\r\ntext\r\n';
  const out = updateTocBlocks(src, headings);
  assert.ok(out.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
});

test('updateTocBlocks: コードブロック内は無視する', () => {
  const headings = [{ content: 'H', level: 1, id: 'h' }];
  const src = '```\n<!-- @import "[TOC]" {} -->\n```\n\ntext\n';
  const out = updateTocBlocks(src, headings);
  assert.equal(out, src);
});
