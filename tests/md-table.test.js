// tests/md-table.test.js — src/md-table.js の単体テスト
// (displayWidth・Excel の TSV 変換・文書中の GFM 表の整形)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  displayWidth, parseTsv, isTsvTable, tsvToMarkdownTable, formatMarkdownTables, wrapBlockForInsert,
} from '../src/md-table.js';

// changes(昇順・重なりなし)を元テキストに適用した結果を作る(テスト専用の素朴な実装)。
function applyChanges(text, changes) {
  let result = '';
  let last = 0;
  for (const c of changes) {
    result += text.slice(last, c.from) + c.insert;
    last = c.to;
  }
  return result + text.slice(last);
}

test('displayWidth: 半角は1、日本語(ひらがな・漢字)・全角記号・絵文字は2', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('あいう'), 6);
  assert.equal(displayWidth('日本語'), 6);
  assert.equal(displayWidth('😀'), 2); // サロゲートペア
});

test('displayWidth: 半角カナは1、結合文字・ゼロ幅文字は0', () => {
  assert.equal(displayWidth('ｱｲｳ'), 3);
  assert.equal(displayWidth('á'), 1); // 結合文字(アキュート・アクセント)は幅0
  assert.equal(displayWidth('a​b'), 2); // ゼロ幅スペースは幅0
});

test('formatMarkdownTables: 日本語の幅揃え(表示幅で列を揃える)', () => {
  const src = '|名前|値|\n|---|---|\n|山田太郎|100|\n|鈴木|5|';
  const { text, count } = formatMarkdownTables(src);
  assert.equal(count, 1);
  assert.equal(
    text,
    '| 名前     | 値  |\n' + '| -------- | --- |\n' + '| 山田太郎 | 100 |\n' + '| 鈴木     | 5   |'
  );
});

test('formatMarkdownTables: 配置4種(なし/左/右/中央)を区切り行から読み取って詰める', () => {
  const src = '| a | bb | ccc | dddd |\n|:--|--:|:-:|---|\n| e | f | g | h |';
  const { text, count, changes } = formatMarkdownTables(src);
  assert.equal(count, 1);
  assert.equal(
    text,
    '| a   |  bb | ccc | dddd |\n' + '| :-- | --: | :-: | ---- |\n' + '| e   |   f |  g  | h    |'
  );
  assert.equal(applyChanges(src, changes), text);
});

test('formatMarkdownTables: `\\|` はセル内の文字として扱い分割しない', () => {
  const src = '| a | b |\n|---|---|\n| x\\|y | z |';
  const { text, count } = formatMarkdownTables(src);
  assert.equal(count, 1);
  assert.ok(text.includes('x\\|y'));
  // エスケープされたパイプの影響で列数が増えていないこと(2列のまま)
  assert.equal(text.split('\n')[0].match(/\|/g).length, 3);
});

test('formatMarkdownTables: フェンスコードブロック(``` / ~~~)の中は対象外', () => {
  const src = 'text\n\n```\n| a | b |\n|---|---|\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const { text, count } = formatMarkdownTables(src);
  assert.equal(count, 1); // フェンスの外の表だけが整形される
  assert.ok(text.includes('```\n| a | b |\n|---|---|\n```'), 'フェンス内はそのまま残るはず');
  assert.ok(text.includes('| a   | b   |\n| --- | --- |\n| 1   | 2   |'));
});

test('formatMarkdownTables: 行頭が `>` の行(引用内)は対象外', () => {
  const src = '> | a | b |\n> |---|---|\n> | 1 | 2 |\n';
  const { count, changes } = formatMarkdownTables(src);
  assert.equal(count, 0);
  assert.deepEqual(changes, []);
});

test('formatMarkdownTables: セル数が不揃いの行(足りないセルは空、多い分は列が増える)', () => {
  const src = '| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| x |';
  const { text } = formatMarkdownTables(src);
  assert.equal(
    text,
    '| a   | b   |     |\n' + '| --- | --- | --- |\n' + '| 1   | 2   | 3   |\n' + '| x   |     |     |'
  );
});

test('formatMarkdownTables: 冪等(整形済みを再整形しても changes が空)', () => {
  const src = '|名前|値|\n|---|---|\n|山田太郎|100|\n|鈴木|5|';
  const once = formatMarkdownTables(src);
  const twice = formatMarkdownTables(once.text);
  assert.deepEqual(twice.changes, []);
  assert.equal(twice.count, 0);
  assert.equal(twice.text, once.text);
});

test('parseTsv: Excel の引用セル(タブ・改行・"" を含む)', () => {
  const tsv = 'a\tb\r\n"c\tc2"\t"line1\r\nline2"\r\n"He said ""hi"""\td\r\n';
  const rows = parseTsv(tsv);
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['c\tc2', 'line1\nline2'],
    ['He said "hi"', 'd'],
  ]);
});

test('tsvToMarkdownTable: 引用セルの改行は <br>、通常のセルはそのまま', () => {
  const tsv = 'a\tb\r\n"c\tc2"\t"line1\r\nline2"\r\n"He said ""hi"""\td\r\n';
  const md = tsvToMarkdownTable(tsv);
  assert.ok(md.includes('line1<br>line2'));
  assert.ok(md.includes('He said "hi"'));
  assert.ok(!md.endsWith('\n'));
});

test('parseTsv / isTsvTable: 1行だけの TSV', () => {
  assert.deepEqual(parseTsv('a\tb\tc'), [['a', 'b', 'c']]);
  assert.ok(isTsvTable('a\tb\tc'));
  assert.equal(tsvToMarkdownTable('a\tb\tc'), '| a   | b   | c   |\n| --- | --- | --- |');
});

test('parseTsv / isTsvTable: 末尾の CRLF を1つだけ除く', () => {
  assert.deepEqual(parseTsv('a\tb\r\n'), [['a', 'b']]);
  assert.deepEqual(parseTsv('a\tb\r\n\r\n'), [['a', 'b'], ['']]);
  assert.ok(isTsvTable('a\tb\r\n'));
});

test('isTsvTable: タブを含まなければ false', () => {
  assert.ok(!isTsvTable('hello\nworld\n'));
  assert.ok(!isTsvTable(''));
});

test('formatMarkdownTables: changes を元テキストに適用すると text と一致する', () => {
  const src =
    'メモ\n\n|a|bb|\n|--|--:|\n|1|22|\n\n通常の文\n\n> |a|b|\n> |--|--|\n> |1|2|\n\n|名前|値|\n|---|---|\n|山田|1|\n';
  const { text, changes } = formatMarkdownTables(src);
  assert.equal(applyChanges(src, changes), text);
  assert.ok(changes.length >= 2);
});

test('formatMarkdownTables: 見出し行と区切り行のセル数が違えば表ではない(setext 見出しを壊さない)', () => {
  const src = 'a | b\n---\n\n本文\n';
  const { text, count } = formatMarkdownTables(src);
  assert.equal(count, 0);
  assert.equal(text, src);
});

test('formatMarkdownTables: 4 個以上の空白で始まる行(インデントされたコード)は対象外', () => {
  const src = '    |a|b|\n    |--|--|\n    |1|2|\n';
  const { text, count } = formatMarkdownTables(src);
  assert.equal(count, 0);
  assert.equal(text, src);
});

test('wrapBlockForInsert: 直前・直後の段落や表とつながらないよう空行を挟む', () => {
  const T = '| a |\n| --- |';
  // 前の行が表(空行でない)・文書の末尾の空行 → 前に改行 1 つ、後ろに改行
  const doc1 = '|x|\n|-|\n';
  assert.equal(wrapBlockForInsert(doc1, doc1.length, doc1.length, T), '\n' + T + '\n');
  // 前の行が空行 → 前には何も足さない
  const doc2 = '本文\n\n';
  assert.equal(wrapBlockForInsert(doc2, doc2.length, doc2.length, T), T + '\n');
  // 行の途中(前後に文字あり)→ 前後とも空行
  const doc3 = 'abcdef';
  assert.equal(wrapBlockForInsert(doc3, 3, 3, T), '\n\n' + T + '\n\n');
  // 空行の上で、次の行が本文 → 後ろに空行ができるよう改行 1 つ
  const doc4 = '\n次の行\n';
  assert.equal(wrapBlockForInsert(doc4, 0, 0, T), T + '\n');
  // 文書の先頭・次の行が空行 → 何も足さない
  const doc5 = '\n\n後ろ\n';
  assert.equal(wrapBlockForInsert(doc5, 0, 0, T), T);
});
