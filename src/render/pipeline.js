// src/render/pipeline.js
//
// テキスト(生の md ソース)から HTML への変換をまとめる入口。DOM に依存しない
// 純粋な ES モジュール。
//
// 現時点(@import 未実装)では、YAML front matter の除去(行位置がずれないよう
// 同じ行数の空行に置き換える)と markdown-it によるレンダリングだけを行うため、
// lineMap は恒等写像(lineMap[展開後の行] = 元の行 = 同じ添字)になる。
//
// TODO(後続フェーズ): @import "x.md" の展開をここに差し込む。`path` と
// `readText`(相対パスを渡すとテキストを読めるコールバック)を使って再帰的に
// 取り込み、lineMap を「展開後の行 → 元ファイルの行」の対応表に、deps を
// 取り込んだファイルの相対パスの配列に更新する。見出し id・TOC・アラートの
// プラグインは src/render/markdown.js の createMarkdown({ plugins }) 経由で
// 差し込む想定。

import { createMarkdown } from './markdown.js';

let defaultMd = null;
function getDefaultMd() {
  if (!defaultMd) defaultMd = createMarkdown({ plugins: [] });
  return defaultMd;
}

/**
 * @param {string} text 生の md ソース
 * @param {{ path?: string, readText?: (relPath: string) => Promise<string|null>, md?: import('markdown-it') }} [opts]
 *   path: 対象ファイルのルート相対パス(@import のパス解決に使う。今は未使用)
 *   readText: @import 先のテキストを読むコールバック(今は未使用)
 *   md: 使用する markdown-it インスタンス(省略時はこのモジュール既定のものを使う)
 * @returns {Promise<{ html: string, lineMap: number[], deps: string[] }>}
 */
export async function renderDocument(text, { path, readText, md } = {}) {
  void path;
  void readText;
  const expanded = stripFrontMatter(text);
  const renderer = md || getDefaultMd();
  const html = renderer.render(expanded);
  const lineCount = expanded.split('\n').length;
  const lineMap = Array.from({ length: lineCount }, (_, i) => i);
  return { html, lineMap, deps: [] };
}

// 先頭が `---` で始まり、閉じの `---` または `...` が見つかれば YAML front matter
// とみなし、その範囲を同じ行数の空行に置き換える(行番号がずれないようにするため。
// 削除ではなく空行への置換にすることで data-line / lineMap を単純に保てる)。
export function stripFrontMatter(text) {
  if (!text.startsWith('---')) return text;
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return text;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '---' || trimmed === '...') {
      const blanked = new Array(i + 1).fill('');
      return [...blanked, ...lines.slice(i + 1)].join('\n');
    }
  }
  return text;
}
