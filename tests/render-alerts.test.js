// tests/render-alerts.test.js — src/render/alerts.js の単体テスト

import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { alertsPlugin } from '../src/render/alerts.js';

function makeMd(options) {
  const md = new MarkdownIt();
  md.use(alertsPlugin, options);
  return md;
}

// アプリ本体(src/render/markdown.js)が最後に付与する data-line を模したルール。
// alertsPlugin が型を維持していれば、これがそのまま働くことを確認するため。
function withFakeDataLine(md) {
  md.core.ruler.push('fake_data_line', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'blockquote_open' && token.map) {
        token.attrSet('data-line', String(token.map[0]));
      }
    }
  });
  return md;
}

const KINDS = [
  ['NOTE', 'note', 'Note'],
  ['TIP', 'tip', 'Tip'],
  ['IMPORTANT', 'important', 'Important'],
  ['WARNING', 'warning', 'Warning'],
  ['CAUTION', 'caution', 'Caution'],
];

for (const [marker, cls, title] of KINDS) {
  test(`アラート: [!${marker}]`, () => {
    const md = makeMd();
    const html = md.render(`> [!${marker}]\n> 本文\n`);
    assert.equal(
      html,
      `<div class="markdown-alert markdown-alert-${cls}">\n` +
        `<p class="markdown-alert-title">${title}</p>\n` +
        `<p>本文</p>\n</div>\n`,
    );
  });
}

test('小文字のマーカーも認識する', () => {
  const md = makeMd();
  const html = md.render('> [!note]\n> 本文\n');
  assert.match(html, /markdown-alert-note/);
});

test('マーカーと同じ行にタイトルがあれば上書きする', () => {
  const md = makeMd();
  const html = md.render('> [!WARNING] 注意事項\n> 本文\n');
  assert.match(html, /<p class="markdown-alert-title">注意事項<\/p>/);
});

test('titles オプションで既定タイトルを変更できる', () => {
  const md = makeMd({ titles: { note: 'メモ' } });
  const html = md.render('> [!NOTE]\n> 本文\n');
  assert.match(html, /<p class="markdown-alert-title">メモ<\/p>/);
  // 上書きしていない種別は既定のまま
  const html2 = md.render('> [!TIP]\n> 本文\n');
  assert.match(html2, /<p class="markdown-alert-title">Tip<\/p>/);
});

test('本文が無いマーカーだけのアラートは空の段落を残さない', () => {
  const md = makeMd();
  const html = md.render('> [!TIP]\n');
  assert.equal(html, '<div class="markdown-alert markdown-alert-tip">\n<p class="markdown-alert-title">Tip</p>\n</div>\n');
});

test('普通の引用は変わらない', () => {
  const md = makeMd();
  const html = md.render('> ただの引用\n> 複数行\n');
  assert.equal(html, '<blockquote>\n<p>ただの引用\n複数行</p>\n</blockquote>\n');
});

test('マーカーが行の途中にある場合は普通の引用のまま', () => {
  const md = makeMd();
  const html = md.render('> これは [!NOTE] ではない\n');
  assert.doesNotMatch(html, /markdown-alert/);
});

test('アラートの中の入れ子の引用は壊れない', () => {
  const md = makeMd();
  const html = md.render('> [!CAUTION]\n> > 入れ子の引用\n> 続き\n');
  assert.equal(
    html,
    '<div class="markdown-alert markdown-alert-caution">\n' +
      '<p class="markdown-alert-title">Caution</p>\n' +
      '<blockquote>\n<p>入れ子の引用\n続き</p>\n</blockquote>\n' +
      '</div>\n',
  );
});

test('アラートでない引用の中にネストした普通の引用も壊れない', () => {
  const md = makeMd();
  const html = md.render('> 外側\n> > 内側\n');
  assert.equal(html, '<blockquote>\n<p>外側</p>\n<blockquote>\n<p>内側</p>\n</blockquote>\n</blockquote>\n');
});

test('data-line などトークンに付いた属性は保持される(後段の data-line 付与が効く)', () => {
  const md = withFakeDataLine(makeMd());
  const html = md.render('本文\n\n> [!NOTE]\n> 中身\n');
  assert.match(html, /<div class="markdown-alert markdown-alert-note" data-line="2">/);
});
