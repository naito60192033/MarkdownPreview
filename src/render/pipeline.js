// src/render/pipeline.js
//
// テキスト(生の md ソース)から HTML への変換をまとめる入口。DOM に依存しない
// 純粋な ES モジュール。
//
// 手順: YAML front matter の除去(行位置がずれないよう同じ行数の空行に置き換える。
// @import で取り込む先の front matter も同様に除去する)→ `@import "x.md"` の
// 展開(src/render/imports.js。path と readText が渡されたときだけ行う)→
// markdown-it での描画(見出し id・[TOC]・アラート・蛍光ペン・マーカー付きテキスト枠の
// プラグインを差し込んだもの)。
//
// lineMap は「展開後テキストの行 → 最上位ファイルの元の行」の対応表(imports.js の
// 結果をそのまま使う)。deps は展開で取り込んだファイル(@import 先)のルート相対
// パスの配列で、呼び出し側(src/app.js)がこれを変更監視に登録する。

import { createMarkdown } from './markdown.js';
import { expandImports } from './imports.js';
import { headingIdPlugin } from './slug.js';
import { tocPlugin, collectHeadings } from './toc.js';
import { alertsPlugin } from './alerts.js';
import markdownItMark from 'markdown-it-mark';
import { markBoxPlugin } from './markbox.js';

// markdown-it インスタンスはプラグイン登録のコストがあるため、アラートの
// タイトル設定(alertTitles)ごとにキャッシュして使い回す。
const mdCache = new Map(); // JSON化した alertTitles -> markdown-it インスタンス

function getMd(alertTitles) {
  const key = JSON.stringify(alertTitles || {});
  let md = mdCache.get(key);
  if (!md) {
    md = createMarkdown({
      plugins: [headingIdPlugin, tocPlugin, [alertsPlugin, { titles: alertTitles }], markdownItMark, markBoxPlugin],
    });
    mdCache.set(key, md);
  }
  return md;
}

// front matter の除去 → (path/readText があれば)@import の展開、までを行う内部
// 共通処理。renderDocument()(HTML 化まで行う)と collectHeadingsFor()(保存時の
// ソース書き込み型 TOC 用に見出しだけ集める)の両方から使う。
async function expand(text, { path, readText }) {
  const stripped = stripFrontMatter(text);
  if (!path || typeof readText !== 'function') {
    return { text: stripped, lineMap: identityLineMap(stripped), deps: [] };
  }
  const wrappedReadText = async (relPath) => {
    const t = await readText(relPath);
    return t == null ? null : stripFrontMatter(t);
  };
  return expandImports(stripped, { path, readText: wrappedReadText });
}

/**
 * @param {string} text 生の md ソース
 * @param {{
 *   path?: string,
 *   readText?: (relPath: string) => Promise<string|null>,
 *   alertTitles?: Record<string, string>,
 *   md?: import('markdown-it'),
 * }} [opts]
 *   path: 対象ファイルのルート相対パス(@import のパス解決に使う)。
 *   readText: @import 先のテキストを読むコールバック(省略時は @import を展開しない)。
 *   alertTitles: アラートの既定タイトルを上書きする設定(src/render/alerts.js 参照)。
 *   md: 使用する markdown-it インスタンス(省略時は alertTitles から作る既定のもの)。
 * @returns {Promise<{ html: string, lineMap: number[], deps: string[],
 *   headings: {level: number, content: string, id: string, line: number|null, ignore: boolean}[] }>}
 */
export async function renderDocument(text, { path, readText, alertTitles, md } = {}) {
  const { text: expanded, lineMap, deps } = await expand(text, { path, readText });
  const renderer = md || getMd(alertTitles);
  const env = {};
  const html = renderer.render(expanded, env);
  return { html, lineMap, deps, headings: env.headings || [] };
}

/**
 * 保存時のソース書き込み型 TOC(src/render/toc.js の updateTocBlocks に渡す)用に、
 * front matter の除去・@import の展開後のテキストから見出しの一覧を集める。
 * @param {string} text
 * @param {{ path?: string, readText?: (relPath: string) => Promise<string|null>,
 *           alertTitles?: Record<string, string> }} [opts]
 * @returns {Promise<{level: number, content: string, id: string, line: number|null, ignore: boolean}[]>}
 */
export async function collectHeadingsFor(text, { path, readText, alertTitles } = {}) {
  const { text: expanded } = await expand(text, { path, readText });
  return collectHeadings(getMd(alertTitles), expanded);
}

function identityLineMap(text) {
  const lineCount = text.split('\n').length;
  return Array.from({ length: lineCount }, (_, i) => i);
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
