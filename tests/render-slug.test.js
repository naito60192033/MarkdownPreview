// tests/render-slug.test.js — src/render/slug.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import attrs from 'markdown-it-attrs';
import uslug from 'uslug';
import { HeadingIdGenerator, headingIdPlugin } from '../src/render/slug.js';

// アプリ本体(src/render/markdown.js)と同じ順番でプラグインを登録する。
function makeMd() {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(footnote);
  md.use(taskLists);
  md.use(attrs);
  md.use(headingIdPlugin);
  return md;
}

function collectHeadings(md, text) {
  const env = {};
  md.parse(text, env);
  return env.headings || [];
}

test('日本語の見出し', () => {
  const g = new HeadingIdGenerator();
  assert.equal(g.generateId('概要'), '概要');
  assert.equal(g.generateId('1. はじめに'), '1-はじめに');
  assert.equal(g.generateId('設計 / 実装'), '設計--実装');
});

test('英語(大文字・記号を含む)の見出し', () => {
  const g = new HeadingIdGenerator();
  assert.equal(g.generateId('Hello World! (Test)#1'), 'hello-world-test1');
});

test('重複する見出しには -1, -2 が付く', () => {
  const g = new HeadingIdGenerator();
  assert.equal(g.generateId('a'), 'a');
  assert.equal(g.generateId('a'), 'a-1');
  assert.equal(g.generateId('a'), 'a-2');
});

test('`code` を含む見出し', () => {
  const g = new HeadingIdGenerator();
  assert.equal(g.generateId('`code` heading'), 'code-heading');
});

test('_強調_ 記号は取り除かれ、単語内の _ は残る', () => {
  const g = new HeadingIdGenerator();
  assert.equal(g.generateId('_強調_ text'), '強調-text');
  assert.equal(g.generateId('foo_bar_baz'), 'foo_bar_baz');
});

test('headingIdPlugin: 見出しに id を付け、env.headings に集める', () => {
  const md = makeMd();
  const env = {};
  const html = md.render('# 概要\n\n## 概要\n\n### Hello World!\n', env);
  assert.deepEqual(
    env.headings.map((h) => h.id),
    ['概要', '概要-1', 'hello-world'],
  );
  assert.equal(env.headings[0].level, 1);
  assert.equal(env.headings[0].line, 0);
  assert.equal(env.headings[1].line, 2);
  assert.match(html, /<h1 id="概要">/);
  assert.match(html, /<h2 id="概要-1">/);
});

test('headingIdPlugin: 1 回の描画ごとに重複カウンタがリセットされる', () => {
  const md = makeMd();
  const first = collectHeadings(md, '# a\n\n# a\n');
  const second = collectHeadings(md, '# a\n\n# a\n');
  assert.deepEqual(
    first.map((h) => h.id),
    ['a', 'a-1'],
  );
  assert.deepEqual(
    second.map((h) => h.id),
    ['a', 'a-1'],
  );
});

test('headingIdPlugin: {#custom} を優先し、重複カウンタを消費しない', () => {
  const md = makeMd();
  const headings = collectHeadings(md, '# X {#custom}\n\n# X\n\n# X\n');
  assert.deepEqual(
    headings.map((h) => h.id),
    ['custom', 'x', 'x-1'],
  );
});

test('headingIdPlugin: {ignore=true} は目次対象外を示し、属性が消える', () => {
  const md = makeMd();
  const env = {};
  const html = md.render('# 概要 {ignore=true}\n', env);
  assert.equal(env.headings.length, 1);
  assert.equal(env.headings[0].ignore, true);
  assert.equal(env.headings[0].content, '概要');
  assert.doesNotMatch(html, /ignore/);
  assert.match(html, /<h1 id="概要">/);
});

test('headingIdPlugin: 見出しテキストの行末の {...} 属性部分は id 生成に含めない', () => {
  const md = makeMd();
  const headings = collectHeadings(md, '# 見出し {.cls}\n');
  assert.equal(headings[0].content, '見出し');
  assert.equal(headings[0].id, '見出し');
});

// ---- 移植元の TypeScript(型注釈だけ外したもの)との突き合わせ ----------------
//
// crossnote の src/markdown-engine/heading-id-generator.ts
// (https://raw.githubusercontent.com/shd101wyy/crossnote/master/src/markdown-engine/heading-id-generator.ts)
// から、TypeScript の型注釈だけを取り除いたもの。ロジックは一切変更していない。
class PortedHeadingIdGenerator {
  constructor() {
    this.table = {};
  }
  generateId(heading) {
    const replacement = (match, capture) => {
      const sanitized = capture
        .replace(/[!"#$%&'()*+,./:;<=>?@[\\]^`{|}~]/g, '')
        .replace(/^\s/, '')
        .replace(/\s$/, '')
        .replace(/`/g, '~');
      return (
        (capture.match(/^\s+$/) ? '~' : sanitized) +
        (match.endsWith(' ') && !sanitized.endsWith('~') ? '~' : '')
      );
    };
    heading = heading
      .trim()
      .replace(/~|。/g, '') // sanitize
      .replace(/``(.+?)``\s?/g, replacement)
      .replace(/`(.*?)`\s?/g, replacement)
      .replace(
        /(^|\s|(?!_)[\p{P}\p{S}])___([^\s_](?:[^_]*[^\s_])?)___(?=$|\s|(?!_)[\p{P}\p{S}])/gu,
        `$1$2`,
      )
      .replace(
        /(^|\s|(?!_)[\p{P}\p{S}])__([^\s_](?:[^_]*[^\s_])?)__(?=$|\s|(?!_)[\p{P}\p{S}])/gu,
        `$1$2`,
      )
      .replace(
        /(^|\s|(?!_)[\p{P}\p{S}])_([^\s_](?:[^_]*[^\s_])?)_(?=$|\s|(?!_)[\p{P}\p{S}])/gu,
        `$1$2`,
      );
    let slug = uslug(heading.replace(/\s/g, '~')).replace(/~/g, '-');
    if (this.table[slug] >= 0) {
      this.table[slug] = this.table[slug] + 1;
      slug += '-' + this.table[slug];
    } else {
      this.table[slug] = 0;
    }
    return slug;
  }
}

test('移植元(型注釈を外した TypeScript)と同じ入出力になる', () => {
  const inputs = [
    '概要',
    '1. はじめに',
    '設計 / 実装',
    'Hello World! (Test)#1',
    'a',
    'a',
    'a',
    '`code` heading',
    '_強調_ text',
    'foo_bar_baz',
    '__strong__ 見出し',
  ];
  const ours = new HeadingIdGenerator();
  const ported = new PortedHeadingIdGenerator();
  for (const input of inputs) {
    assert.equal(ours.generateId(input), ported.generateId(input), input);
  }
});
