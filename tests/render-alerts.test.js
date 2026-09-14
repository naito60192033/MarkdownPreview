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

// アイコンの svg 込みでタイトル段落の HTML を組み立てる(テストの期待値作りに使う)。
const OCTICON_NAMES = {
  note: 'info',
  tip: 'light-bulb',
  important: 'report',
  warning: 'alert',
  caution: 'stop',
  link: 'link',
  memo: 'pencil',
  check: 'check-circle',
  question: 'question',
};

// svg のパスデータそのものはテストとして固定しない(取得元の Octicons が更新
// されても壊れないように)。ここでは class 名と、path が閉じて title の
// テキストが続くことだけを確認する。
function assertTitleWithIcon(html, cls, title) {
  const re = new RegExp(
    `<p class="markdown-alert-title"><svg class="octicon octicon-${OCTICON_NAMES[cls]}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="[^"]+"></path></svg>${title}</p>`
  );
  assert.match(html, re);
}

const KINDS = [
  ['NOTE', 'note', 'Note'],
  ['TIP', 'tip', 'Tip'],
  ['IMPORTANT', 'important', 'Important'],
  ['WARNING', 'warning', 'Warning'],
  ['CAUTION', 'caution', 'Caution'],
  ['LINK', 'link', 'Link'],
  ['MEMO', 'memo', 'Memo'],
  ['CHECK', 'check', 'Check'],
  ['QUESTION', 'question', 'Question'],
];

for (const [marker, cls, title] of KINDS) {
  test(`アラート: [!${marker}]`, () => {
    const md = makeMd();
    const html = md.render(`> [!${marker}]\n> 本文\n`);
    assert.match(html, new RegExp(`^<div class="markdown-alert markdown-alert-${cls}">\\n`));
    assertTitleWithIcon(html, cls, title);
    assert.match(html, /<p>本文<\/p>\n<\/div>\n$/);
  });
}

test('小文字のマーカーも認識する', () => {
  const md = makeMd();
  const html = md.render('> [!note]\n> 本文\n');
  assert.match(html, /markdown-alert-note/);
});

test('小文字の LINK マーカーも認識する', () => {
  const md = makeMd();
  const html = md.render('> [!link]\n> 本文\n');
  assert.match(html, /markdown-alert-link/);
});

test('マーカーと同じ行にタイトルがあれば上書きする', () => {
  const md = makeMd();
  const html = md.render('> [!WARNING] 注意事項\n> 本文\n');
  assert.match(html, /<p class="markdown-alert-title"><svg[^>]*>.*<\/svg>注意事項<\/p>/);
});

test('titles オプションで既定タイトルを変更できる', () => {
  const md = makeMd({ titles: { note: 'メモ' } });
  const html = md.render('> [!NOTE]\n> 本文\n');
  assert.match(html, /<\/svg>メモ<\/p>/);
  // 上書きしていない種別は既定のまま
  const html2 = md.render('> [!TIP]\n> 本文\n');
  assert.match(html2, /<\/svg>Tip<\/p>/);
});

test('titles オプションで link のタイトルも変更できる', () => {
  const md = makeMd({ titles: { link: '関連リンク' } });
  const html = md.render('> [!LINK]\n> 本文\n');
  assert.match(html, /<\/svg>関連リンク<\/p>/);
});

test('本文が無いマーカーだけのアラートは空の段落を残さない', () => {
  const md = makeMd();
  const html = md.render('> [!TIP]\n');
  assert.match(html, /^<div class="markdown-alert markdown-alert-tip">\n<p class="markdown-alert-title">/);
  assert.match(html, /<\/svg>Tip<\/p>\n<\/div>\n$/);
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
  assert.match(html, /^<div class="markdown-alert markdown-alert-caution">\n<p class="markdown-alert-title">/);
  assert.match(
    html,
    /<\/svg>Caution<\/p>\n<blockquote>\n<p>入れ子の引用\n続き<\/p>\n<\/blockquote>\n<\/div>\n$/
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

// ---------- アイコン(6 種類) ----------

for (const [marker, cls] of KINDS) {
  test(`アイコン: [!${marker}] に対応する octicon の svg と class が付く`, () => {
    const md = makeMd();
    const html = md.render(`> [!${marker}]\n> 本文\n`);
    const iconName = OCTICON_NAMES[cls];
    assert.match(html, new RegExp(`<svg class="octicon octicon-${iconName}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">`));
    assert.match(html, /<path d="[^"]+"><\/path><\/svg>/);
  });
}

test('タイトル段落の textContent 相当(svg 以外のテキスト)はタイトル文字列のまま', () => {
  const md = makeMd();
  const html = md.render('> [!WARNING] 注意事項\n> 本文\n');
  // svg の path 要素にはテキストが無いので、</svg> の直後から </p> までがそのまま
  // textContent になる。
  const m = html.match(/<p class="markdown-alert-title">.*?<\/svg>([^<]*)<\/p>/);
  assert.ok(m, 'タイトル段落が見つかりません: ' + html);
  assert.equal(m[1], '注意事項');
});

// ---------- Qiita 方式(:::note ...) ----------

test('Qiita 方式: :::note info は note として描画される(タイトル省略時は既定値)', () => {
  const md = makeMd();
  const html = md.render(':::note info\n本文です\n:::\n');
  assert.match(html, /^<div class="markdown-alert markdown-alert-note">\n/);
  assertTitleWithIcon(html, 'note', 'Note');
  assert.match(html, /<p>本文です<\/p>\n<\/div>\n$/);
});

test('Qiita 方式: :::note warn は warning として描画される', () => {
  const md = makeMd();
  const html = md.render(':::note warn\n本文です\n:::\n');
  assert.match(html, /markdown-alert-warning/);
  assertTitleWithIcon(html, 'warning', 'Warning');
});

test('Qiita 方式: :::note alert は caution として描画される', () => {
  const md = makeMd();
  const html = md.render(':::note alert\n本文です\n:::\n');
  assert.match(html, /markdown-alert-caution/);
  assertTitleWithIcon(html, 'caution', 'Caution');
});

test('Qiita 方式: :::note だけ(種類なし)は info(note)扱い', () => {
  const md = makeMd();
  const html = md.render(':::note\n本文です\n:::\n');
  assert.match(html, /markdown-alert-note/);
  assertTitleWithIcon(html, 'note', 'Note');
});

test('Qiita 方式: GitHub の種類名も受け付ける(tip / important / link)', () => {
  const md = makeMd();
  for (const [word, cls, title] of [
    ['tip', 'tip', 'Tip'],
    ['important', 'important', 'Important'],
    ['link', 'link', 'Link'],
  ]) {
    const html = md.render(`:::note ${word}\n本文です\n:::\n`);
    assert.match(html, new RegExp(`markdown-alert-${cls}`), `:::note ${word} が ${cls} になりません`);
    assertTitleWithIcon(html, cls, title);
  }
});

test('Qiita 方式: 種類の後ろにテキストがあればタイトルにする', () => {
  const md = makeMd();
  const html = md.render(':::note warn 注意事項\n本文です\n:::\n');
  assert.match(html, /markdown-alert-warning/);
  assert.match(html, /<\/svg>注意事項<\/p>/);
});

test('Qiita 方式: 中身は通常の Markdown として描画される(リスト・コード)', () => {
  const md = makeMd();
  const html = md.render(':::note info\n- a\n- b\n\n```js\nconst x = 1;\n```\n:::\n');
  assert.match(html, /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
  assert.match(html, /<pre><code class="language-js">const x = 1;\n<\/code><\/pre>/);
});

test('Qiita 方式: 入れ子のアラートが描画できる(外側は内側より多いコロンが必要)', () => {
  const md = makeMd();
  const html = md.render('::::note info\n外側の本文\n\n:::note warn\n内側の本文\n:::\n::::\n');
  assert.match(html, /^<div class="markdown-alert markdown-alert-note">\n/);
  assertTitleWithIcon(html, 'note', 'Note');
  assert.match(html, /<p>外側の本文<\/p>/);
  assert.match(html, /<div class="markdown-alert markdown-alert-warning">\n/);
  assertTitleWithIcon(html, 'warning', 'Warning');
  assert.match(html, /<p>内側の本文<\/p>/);
  // 外側の div がちゃんと閉じている(入れ子の :::: が2つの </div> の後に無いこと)
  assert.equal((html.match(/<div class="markdown-alert/g) || []).length, 2);
  assert.equal((html.match(/<\/div>/g) || []).length, 2);
});

test('Qiita 方式: コードブロックの中の ::: は対象外', () => {
  const md = makeMd();
  const html = md.render('```\n:::note info\nnot an alert\n:::\n```\n');
  assert.doesNotMatch(html, /markdown-alert/);
  assert.match(html, /<pre><code>:::note info\nnot an alert\n:::\n<\/code><\/pre>/);
});

test('Qiita 方式: 外側の div に data-line が付く', () => {
  const md = withFakeDataLine(makeMd());
  const html = md.render('本文\n\n:::note warn\n中身\n:::\n');
  assert.match(html, /<div class="markdown-alert markdown-alert-warning" data-line="2">/);
});

test('Qiita 方式: titles オプションで既定タイトルを変更できる', () => {
  const md = makeMd({ titles: { warning: '要注意' } });
  const html = md.render(':::note warn\n本文\n:::\n');
  assert.match(html, /<\/svg>要注意<\/p>/);
});

// ---------- Qiita 方式: "note" を書かない省略形(:::memo 等) ----------

test('Qiita 方式(省略形): :::memo / :::check / :::question がそれぞれの種類になる', () => {
  const md = makeMd();
  for (const [word, cls, title] of [
    ['memo', 'memo', 'Memo'],
    ['check', 'check', 'Check'],
    ['question', 'question', 'Question'],
  ]) {
    const html = md.render(`:::${word}\n本文です\n:::\n`);
    assert.match(html, new RegExp(`^<div class="markdown-alert markdown-alert-${cls}">\\n`), `:::${word} が変換されません`);
    assertTitleWithIcon(html, cls, title);
    assert.match(html, /<p>本文です<\/p>\n<\/div>\n$/);
  }
});

test('Qiita 方式(省略形): :::info / :::warn / :::alert / :::tip / :::link も使える', () => {
  const md = makeMd();
  for (const [word, cls, title] of [
    ['info', 'note', 'Note'],
    ['warn', 'warning', 'Warning'],
    ['alert', 'caution', 'Caution'],
    ['tip', 'tip', 'Tip'],
    ['link', 'link', 'Link'],
  ]) {
    const html = md.render(`:::${word}\n本文です\n:::\n`);
    assert.match(html, new RegExp(`markdown-alert-${cls}`), `:::${word} が ${cls} になりません`);
    assertTitleWithIcon(html, cls, title);
  }
});

test('Qiita 方式(省略形): 種類語の後ろのテキストはタイトルになる', () => {
  const md = makeMd();
  const html = md.render(':::memo 作業メモ\n本文です\n:::\n');
  assert.match(html, /markdown-alert-memo/);
  assert.match(html, /<\/svg>作業メモ<\/p>/);
});

test('Qiita 方式(省略形): 既知の種類名でないものは変換しない', () => {
  const md = makeMd();
  const html = md.render(':::foo\n本文です\n:::\n');
  assert.doesNotMatch(html, /markdown-alert/);
});

// ---------- タイトル空欄(アイコンのみ)モード ----------

test('タイトルが空欄(titles で "" を指定)のとき、GitHub 方式は notitle クラスになりアイコンだけになる', () => {
  const md = makeMd({ titles: { note: '' } });
  const html = md.render('> [!NOTE]\n> 本文\n');
  assert.match(html, /^<div class="markdown-alert markdown-alert-note markdown-alert-notitle">\n/);
  assert.match(html, /<p class="markdown-alert-title"><svg[^>]*><path[^>]*><\/path><\/svg><\/p>/);
});

test('タイトルが空欄でも、md 側でタイトルを指定していればそちらを表示する', () => {
  const md = makeMd({ titles: { note: '' } });
  const html = md.render('> [!NOTE] 見出し\n> 本文\n');
  assert.doesNotMatch(html, /markdown-alert-notitle/);
  assert.match(html, /<\/svg>見出し<\/p>/);
});

test('タイトルが空欄(titles で "" を指定)のとき、Qiita 方式も notitle クラスになる', () => {
  const md = makeMd({ titles: { memo: '' } });
  const html = md.render(':::memo\n本文です\n:::\n');
  assert.match(html, /^<div class="markdown-alert markdown-alert-memo markdown-alert-notitle">\n/);
  assert.match(html, /<p class="markdown-alert-title"><svg[^>]*><path[^>]*><\/path><\/svg><\/p>/);
});

test('タイトルが空欄でも、Qiita 方式で種類の後ろにタイトルを書いていればそちらを表示する', () => {
  const md = makeMd({ titles: { memo: '' } });
  const html = md.render(':::memo 作業メモ\n本文です\n:::\n');
  assert.doesNotMatch(html, /markdown-alert-notitle/);
  assert.match(html, /<\/svg>作業メモ<\/p>/);
});
