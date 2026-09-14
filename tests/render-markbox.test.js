// tests/render-markbox.test.js — src/render/markbox.js の単体テスト
//
// ```mark フェンス(markBoxPlugin)と、段落中の `==強調==`(markdown-it-mark)の
// 両方を検証する。data-line・hljs クラスの付与は src/render/markdown.js の
// 担当(mermaid と同じ扱い)なので、それを模したルールを追加して確認する
// (tests/render-alerts.test.js の withFakeDataLine と同じ考え方)。

import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import attrs from 'markdown-it-attrs';
import mark from 'markdown-it-mark';
import { headingIdPlugin } from '../src/render/slug.js';
import { tocPlugin, collectHeadings } from '../src/render/toc.js';
import { markBoxPlugin } from '../src/render/markbox.js';

// アプリ本体(src/render/markdown.js の applyPostProcessing)が最後に付与する
// data-line と hljs クラス(mermaid・mark は除外)を模したルール。
function withFakeDataLineAndHljs(md) {
  md.core.ruler.push('fake_post_processing', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'fence' && token.map) {
        token.attrSet('data-line', String(token.map[0]));
        const lang = (token.info || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
        if (lang !== 'mermaid' && lang !== 'mark') {
          token.attrJoin('class', 'hljs');
        }
      }
    }
  });
  return md;
}

// ---------- ```mark の枠 ----------

function makeBoxMd() {
  const md = new MarkdownIt({ html: true });
  md.use(attrs);
  md.use(markBoxPlugin);
  return md;
}

test('```mark: ==強調== が <span class="mark-text"> になり、pre.mark-box で囲む(<code> は無い)', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n強調前 ==強調== 強調後\n```\n');
  assert.equal(html, '<pre class="mark-box">強調前 <span class="mark-text">強調</span> 強調後\n</pre>\n');
});

test('```mark: 空白・改行(字下げ含む)を保持する', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n1 行目\n  字下げされた 2 行目\n```\n');
  assert.equal(html, '<pre class="mark-box">1 行目\n  字下げされた 2 行目\n</pre>\n');
});

test('```mark: `<` `&` は自動でエスケープされる', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n<tag> a & b\n```\n');
  assert.equal(html, '<pre class="mark-box">&lt;tag&gt; a &amp; b\n</pre>\n');
});

test('```mark: 対応しない == はそのまま文字になる', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n開いたまま == 閉じない\n```\n');
  assert.equal(html, '<pre class="mark-box">開いたまま == 閉じない\n</pre>\n');
});

test('```mark: 中身が空の ==== はそのまま文字になる', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n====\n```\n');
  assert.equal(html, '<pre class="mark-box">====\n</pre>\n');
});

test('```mark: \\== で == を文字として書ける', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n\\==これは強調ではない==\n```\n');
  assert.equal(html, '<pre class="mark-box">==これは強調ではない==\n</pre>\n');
});

test('```mark: ==…== の中の \\== は閉じとみなさない(段落の markdown-it-mark と同じ)', () => {
  const md = makeBoxMd();
  assert.equal(
    md.render('```mark\n==a\\==b==\n```\n'),
    '<pre class="mark-box"><span class="mark-text">a==b</span>\n</pre>\n'
  );
  // 閉じが \== しか無ければ強調にならない(\ だけを中身にして閉じる読み方をしない)
  assert.equal(md.render('```mark\n==a\\==\n```\n'), '<pre class="mark-box">==a==\n</pre>\n');
});

test('```mark: 行区切り文字(U+2028)も落とさずに出力する', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\na b ==c d==\n```\n');
  assert.equal(html, '<pre class="mark-box">a b <span class="mark-text">c d</span>\n</pre>\n');
});

test('```mark: 1 行に複数の ==強調== を書ける', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n==a== と ==b==\n```\n');
  assert.equal(
    html,
    '<pre class="mark-box"><span class="mark-text">a</span> と <span class="mark-text">b</span>\n</pre>\n'
  );
});

test('```mark: == は行をまたがない', () => {
  const md = makeBoxMd();
  const html = md.render('```mark\n==a\nb==\n```\n');
  assert.equal(html, '<pre class="mark-box">==a\nb==\n</pre>\n');
});

test('```mark: {#id .class} など markdown-it-attrs の属性がそのまま付く(renderAttrs)', () => {
  const md = makeBoxMd();
  const html = md.render('```mark {#foo .bar}\n中身\n```\n');
  assert.equal(html, '<pre id="foo" class="bar mark-box">中身\n</pre>\n');
});

test('```mark: data-line が付く', () => {
  const md = withFakeDataLineAndHljs(makeBoxMd());
  const html = md.render('本文\n\n```mark\n中身\n```\n');
  assert.match(html, /<pre data-line="2" class="mark-box">/);
});

test('```mark: hljs クラスが付かない(mermaid と同じ扱い)', () => {
  const md = withFakeDataLineAndHljs(makeBoxMd());
  const html = md.render('```mark\n中身\n```\n');
  assert.doesNotMatch(html, /hljs/);
});

test('```mark 以外の通常のフェンスは変わらない(hljs クラスが付く)', () => {
  const md = withFakeDataLineAndHljs(makeBoxMd());
  const html = md.render('```js\nconst x = 1;\n```\n');
  assert.match(html, /<pre><code data-line="0" class="hljs language-js">/);
});

test('生 HTML の <pre class="mark-box"> はそのまま素通りする', () => {
  const md = makeBoxMd();
  const html = md.render('<pre class="mark-box">x <span class="mark-text">y</span> z</pre>\n');
  assert.equal(html, '<pre class="mark-box">x <span class="mark-text">y</span> z</pre>\n');
});

// ---------- 段落などの ==強調== ----------

function makeInlineMd() {
  const md = new MarkdownIt({ html: true });
  md.use(attrs);
  md.use(mark);
  md.use(headingIdPlugin);
  md.use(tocPlugin);
  return md;
}

test('段落の ==強調== は <mark>強調</mark> になる(黄色のみ)', () => {
  const md = makeInlineMd();
  const html = md.render('==強調==\n');
  assert.equal(html, '<p><mark>強調</mark></p>\n');
});

test('段落の ==強調=={.mark-text} は <mark class="mark-text">強調</mark> になる(黄色 + 赤枠)', () => {
  const md = makeInlineMd();
  const html = md.render('==強調=={.mark-text}\n');
  assert.equal(html, '<p><mark class="mark-text">強調</mark></p>\n');
});

test('コードの中の == は対象外', () => {
  const md = makeInlineMd();
  const html = md.render('`a == b`\n');
  assert.equal(html, '<p><code>a == b</code></p>\n');
});

test('空白で囲まれた == は強調にならない(markdown-it-mark の区切り規則)', () => {
  const md = makeInlineMd();
  const html = md.render('a == b == c\n');
  assert.equal(html, '<p>a == b == c</p>\n');
});

test('見出しの中の ==重要== でも id と [TOC] が壊れない', () => {
  const md = makeInlineMd();
  const html = md.render('# ==重要== 手順\n\n[TOC]\n');
  assert.match(html, /<h1 id="重要-手順">/);
  assert.match(html, /<mark>重要<\/mark> 手順/);
  assert.match(html, /<a href="#重要-手順">/);
});

test('見出しの id は == を取り除いた形になる(uslug が記号を除去する)', () => {
  const headings = collectHeadings(makeInlineMd(), '# ==重要== 手順\n');
  assert.equal(headings[0].id, '重要-手順');
});
