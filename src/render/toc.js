// src/render/toc.js
//
// MPE(VSCode Markdown Preview Enhanced)互換の目次(TOC)。DOM に依存しない
// 純粋な ES モジュール。
//
// - toc(headings, opt): crossnote の src/markdown-engine/toc.ts の toc() の移植
//   (テキスト形式の目次を作る。updateTocBlocks から使う)
// - tocPlugin(md, opt): 単独の段落 `[TOC]` をネストした HTML の目次に置き換える
//   markdown-it プラグイン
// - collectHeadings(md, text): md.parse して env.headings を取り出すヘルパー
// - updateTocBlocks(text, headings): MPE のソース書き込み型 TOC
//   (`<!-- @import "[TOC]" {...} -->` + `<!-- code_chunk_output -->` ブロック)を
//   再生成する

import { HeadingIdGenerator } from './slug.js';

/**
 * 見出しの内容から、目次のリンクテキストとして不適切な部分を取り除く。
 * crossnote の toc.ts の sanitizeContent() の移植。
 *   `![alt](url)` → 取り除く(画像)
 *   `[text](url)` → `text` だけ残す(リンク)
 *   `<a name="x"></a>text</a>` のような `<tag>...</tag>` → 中身のテキストだけ残す
 *   `[^footnote]` → 取り除く(脚注)
 */
export function sanitizeContent(content) {
  let output = '';
  let offset = 0;
  const r = /!?\[([^\]]*)\]\(([^)]*)\)|<([^>]*)>([^<]*)<\/([^>]*)>|\[\^([^\]]*)\]/g;
  let match;
  while ((match = r.exec(content))) {
    output += content.slice(offset, match.index);
    offset = match.index + match[0].length;

    if (match[0][0] === '<') {
      output += match[4];
    } else if (match[0][0] === '[' && match[0][1] === '^') {
      // footnote
      output += '';
    } else if (match[0][0] !== '!') {
      output += match[1]; // link
    } else {
      output += match[0]; // image はそのまま(元実装と同じ挙動)
    }
  }
  output += content.slice(offset, content.length);
  return output;
}

/**
 * 見出しの配列から目次のテキスト(markdown のネストしたリスト)を作る。
 * crossnote の toc.ts の toc() の移植。
 *
 * @param {{content: string, level: number, id?: string}[]} headings
 * @param {{ordered?: boolean, depthFrom?: number, depthTo?: number, tab?: string, ignoreLink?: boolean}} opt
 * @returns {{content: string, array: string[]}}
 */
export function toc(headings, opt) {
  const headingIdGenerator = new HeadingIdGenerator();
  if (!headings) {
    return { content: '', array: [] };
  }

  const ordered = opt.ordered;
  const depthFrom = opt.depthFrom || 1;
  const depthTo = opt.depthTo || 6;
  let tab = opt.tab || '  ';
  const ignoreLink = opt.ignoreLink || false;

  if (ordered) {
    tab = '    ';
  }

  headings = headings.filter((heading) => heading.level >= depthFrom && heading.level <= depthTo);

  if (!headings.length) {
    return { content: '', array: [] };
  }

  const outputArr = [];
  let smallestLevel = headings[0].level;
  for (const heading of headings) {
    if (heading.level < smallestLevel) {
      smallestLevel = heading.level;
    }
  }

  let orderedListNums = [];
  for (const heading of headings) {
    const content = heading.content.trim();
    const level = heading.level;
    const slug = heading.id || headingIdGenerator.generateId(content);
    const n = level - smallestLevel;
    let numStr = '1';
    if (ordered) {
      if (n >= orderedListNums.length) {
        orderedListNums.push(1);
      } else if (n === orderedListNums.length - 1) {
        orderedListNums[orderedListNums.length - 1]++;
      } else {
        orderedListNums = orderedListNums.slice(0, n + 1);
        if (orderedListNums.length) {
          orderedListNums[orderedListNums.length - 1]++;
        }
      }
      numStr = orderedListNums[orderedListNums.length - 1].toString();
    }
    const listItem = `${nPrefix(tab, n)}${ordered ? `${numStr}.` : '-'} ${
      ignoreLink ? sanitizeContent(content) : `[${sanitizeContent(content)}](#${slug})`
    }`;
    outputArr.push(listItem);
  }

  return {
    content: outputArr.join('\n'),
    array: outputArr,
  };
}

function nPrefix(str, n) {
  let output = '';
  for (let i = 0; i < n; i++) output += str;
  return output;
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// markdown-it の core ルーラーに、指定のルールの直後にルールを追加する。
// 指定のルールが存在しなければ末尾に追加する(slug.js と同じ考え方)。
function addCoreRuleAfter(md, afterName, ruleName, fn) {
  try {
    md.core.ruler.after(afterName, ruleName, fn);
  } catch {
    md.core.ruler.push(ruleName, fn);
  }
}

// 見出しの配列(親候補より後ろにある、より深いレベルの見出しをすべて子とみなす)
// からネストした <ul>/<ol> の HTML を組み立てる。
function renderTocHtml(headings, opt, md) {
  const tag = opt.ordered ? 'ol' : 'ul';
  const build = (slice) => {
    let html = '';
    let i = 0;
    while (i < slice.length) {
      const heading = slice[i];
      let j = i + 1;
      while (j < slice.length && slice[j].level > heading.level) j++;
      const children = slice.slice(i + 1, j);
      const label = md.renderInline(sanitizeContent(heading.content.trim()), {});
      const itemHtml = opt.ignoreLink ? label : `<a href="#${escapeHtmlAttr(heading.id)}">${label}</a>`;
      const inner = children.length ? build(children) : '';
      html += `<li>${itemHtml}${inner}</li>`;
      i = j;
    }
    return `<${tag}>${html}</${tag}>`;
  };
  return build(headings);
}

/**
 * 単独の段落 `[TOC]` をネストしたリスト + リンクの目次に置き換える markdown-it
 * プラグイン。見出し id を付与する headingIdPlugin の後に動く必要がある
 * (env.headings を使うため)。ignore の見出しは除外する。
 *
 * @param {import('markdown-it')} md
 * @param {{ordered?: boolean, depthFrom?: number, depthTo?: number, ignoreLink?: boolean}} [opt]
 */
export function tocPlugin(md, opt = {}) {
  const options = {
    ordered: opt.ordered || false,
    depthFrom: opt.depthFrom || 1,
    depthTo: opt.depthTo || 6,
    ignoreLink: opt.ignoreLink || false,
  };

  addCoreRuleAfter(md, 'heading_id', 'toc', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const po = tokens[i];
      if (po.type !== 'paragraph_open') continue;
      const inline = tokens[i + 1];
      const pc = tokens[i + 2];
      if (!inline || inline.type !== 'inline' || !pc || pc.type !== 'paragraph_close') continue;
      if (!/^\[toc\]$/i.test(inline.content.trim())) continue;

      const allHeadings = state.env.headings || [];
      const headings = allHeadings.filter(
        (h) => !h.ignore && h.level >= options.depthFrom && h.level <= options.depthTo,
      );

      if (!headings.length) {
        tokens.splice(i, 3);
        i -= 1;
        continue;
      }

      // html_block の既定レンダラはトークンの属性を出力しないため、スクロール同期用の
      // data-line(展開後テキストでの 0 始まりの行番号)は最上位のリスト要素に直接書く。
      let html = renderTocHtml(headings, options, state.md);
      if (po.map) html = html.replace(/^<(ul|ol)>/, `<$1 data-line="${po.map[0]}">`);
      const block = new state.Token('html_block', '', 0);
      block.content = html;
      block.map = po.map;
      tokens.splice(i, 3, block);
    }
  });
}

/**
 * md.parse() して env.headings を取り出すヘルパー。
 * @param {import('markdown-it')} md headingIdPlugin が登録済みのインスタンス
 * @param {string} text
 * @returns {{level: number, content: string, id: string, line: number|null, ignore: boolean}[]}
 */
export function collectHeadings(md, text) {
  const env = {};
  md.parse(text, env);
  return env.headings || [];
}

// ---- updateTocBlocks: ソース書き込み型 TOC ---------------------------------

// `<!-- @import "[TOC]" {...} -->` 形式の行。属性部分は省略可。
const TOC_IMPORT_LINE_RE = /^\s*<!--\s*@import\s+"\[TOC\]"\s*(\{[^}]*\})?\s*-->\s*$/i;
const CODE_CHUNK_OUTPUT_OPEN = '<!-- code_chunk_output -->';
const CODE_CHUNK_OUTPUT_CLOSE = '<!-- /code_chunk_output -->';
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// `{key="value" key2=value2}` 形式の簡易パーサ(この用途に必要な範囲だけ対応)。
function parseAttrs(str) {
  const attrs = {};
  if (!str) return attrs;
  const inner = str.trim().replace(/^\{/, '').replace(/\}$/, '');
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(inner))) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function isTruthyAttr(v) {
  return typeof v === 'string' && v.toLowerCase() === 'true';
}

/**
 * MPE のソース書き込み型 TOC(`<!-- @import "[TOC]" {...} -->` の直後に続く
 * `<!-- code_chunk_output --> ... <!-- /code_chunk_output -->` ブロック)を、
 * 現在の見出しから再生成する。コードブロックの中は対象外。変更が無ければ
 * 同じ文字列を返す。改行コードは元のテキストに合わせる(CRLF / LF)。
 *
 * @param {string} text
 * @param {{content: string, level: number, id: string, ignore?: boolean}[]} headings
 * @returns {string}
 */
export function updateTocBlocks(text, headings) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const visibleHeadings = (headings || []).filter((h) => !h.ignore);

  const out = [];
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(FENCE_RE);

    if (!inFence && fm) {
      inFence = true;
      fenceChar = fm[1][0];
      fenceLen = fm[1].length;
      out.push(line);
      continue;
    }
    if (inFence) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) {
        inFence = false;
      }
      out.push(line);
      continue;
    }

    const tocMatch = line.match(TOC_IMPORT_LINE_RE);
    if (!tocMatch) {
      out.push(line);
      continue;
    }

    out.push(line);

    const attrs = parseAttrs(tocMatch[1]);
    const opt = {
      ordered: isTruthyAttr(attrs.orderedList),
      depthFrom: parseInt(attrs.depthFrom, 10) || 1,
      depthTo: parseInt(attrs.depthTo, 10) || 6,
      ignoreLink: isTruthyAttr(attrs.ignoreLink),
    };
    const tocLines = toc(visibleHeadings, opt).array;

    // @import の行の直後、空行を挟んで <!-- code_chunk_output --> があるか調べる。
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const hasExistingBlock = j < lines.length && lines[j].trim() === CODE_CHUNK_OUTPUT_OPEN;

    if (hasExistingBlock) {
      const headerIdx = j;
      let footerIdx = -1;
      for (let k = headerIdx + 1; k < lines.length; k++) {
        if (lines[k].trim() === CODE_CHUNK_OUTPUT_CLOSE) {
          footerIdx = k;
          break;
        }
      }
      if (footerIdx === -1) {
        // 閉じが見つからない(壊れている)場合は何もせず、そのまま出力を続ける。
        continue;
      }
      // @import の行と header の間の空行(あれば)をそのまま維持する。
      for (let k = i + 1; k < headerIdx; k++) out.push(lines[k]);
      out.push(lines[headerIdx]);

      const oldContent = lines.slice(headerIdx + 1, footerIdx).join('\n');
      const newContent = ['', ...tocLines, ''].join('\n');
      if (oldContent !== newContent) changed = true;
      out.push('', ...tocLines, '');
      out.push(lines[footerIdx]);
      i = footerIdx;
    } else {
      changed = true;
      out.push('', CODE_CHUNK_OUTPUT_OPEN, '', ...tocLines, '', CODE_CHUNK_OUTPUT_CLOSE);
    }
  }

  if (!changed) return text;
  return out.join(eol);
}
