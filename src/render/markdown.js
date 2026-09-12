// src/render/markdown.js
//
// markdown-it の設定を1箇所にまとめる。DOM に依存しない純粋な ES モジュール。
//
// 既定で footnote / task-lists / attrs(既定の `{` `}`)を登録し、その後に
// 呼び出し側が渡す plugins([plugin, options] または plugin の配列)を登録する。
// 見出し id(slug)・TOC・アラートは別モジュール(担当外)が用意するプラグインを
// この plugins 経由で後から差し込む想定で、ここはその「組み込み口」だけを用意する。
//
// data-line: 展開後テキスト上の 0 始まり行番号を、対象のブロックトークン
// (paragraph/heading/list_item/table/blockquote/fence/code_block/hr/html_block)
// に付与する。スクロール同期(src/scroll-sync.js)はこれを起点に行う。
//
// ```mermaid コードブロックは通常のコードとして色付けせず、元のソースを保持した
// プレースホルダ要素に変換する(実際の描画は iframe を持つ親ドキュメント側で行う。
// src/ui/preview.js を参照)。

import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import attrs from 'markdown-it-attrs';
import footnote from 'markdown-it-footnote';
import hljs from 'highlight.js/lib/common';
import { isExternalUrl } from '../fs/paths.js';

// token.map を持ち、data-line を付けたいブロックトークンの種別。
const DATA_LINE_TYPES = new Set([
  'paragraph_open',
  'heading_open',
  'list_item_open',
  'table_open',
  'blockquote_open',
  'fence',
  'code_block',
  'hr',
  'html_block',
]);

export function createMarkdown({ plugins = [] } = {}) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    highlight: highlightCode,
  });

  md.use(footnote);
  md.use(taskLists);
  md.use(attrs); // 既定の区切り文字 '{' '}' をそのまま使う

  for (const entry of plugins) {
    const [plugin, options] = Array.isArray(entry) ? entry : [entry, undefined];
    md.use(plugin, options);
  }

  applyPostProcessing(md);
  applyMermaidFence(md);
  applyImagePlaceholder(md);

  return md;
}

// highlight.js で言語が分かっているコードだけを色付けする。言語が無い/不明な場合は
// null を返して markdown-it 側の既定のエスケープに任せる(誤った言語推測をしない)。
function highlightCode(code, lang) {
  const language = (lang || '').trim().toLowerCase();
  if (!language || language === 'mermaid') return null;
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

// data-line の付与と、コードフェンスへの 'hljs' クラス付与(mermaid を除く)。
function applyPostProcessing(md) {
  md.core.ruler.push('mdpreview_data_line', (state) => {
    for (const token of state.tokens) {
      if (DATA_LINE_TYPES.has(token.type) && token.map) {
        token.attrSet('data-line', String(token.map[0]));
      }
      if (token.type === 'fence') {
        const lang = (token.info || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
        if (lang !== 'mermaid') {
          token.attrJoin('class', 'hljs');
        }
      }
    }
  });
}

// ```mermaid コードブロックを、元のソースを保持したプレースホルダ要素に変換する。
function applyMermaidFence(md) {
  const defaultFence =
    md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options, env));

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = (token.info || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
    if (lang !== 'mermaid') {
      return defaultFence(tokens, idx, options, env, self);
    }
    token.attrJoin('class', 'mermaid-block');
    // 元のソースは非表示の子要素の textContent に保持する(HTML パーサに
    // エスケープを任せられるため、属性へ詰めるより引用符・改行の扱いが安全)。
    // ("<script>" 文字列はビルド時の二重エスケープ検査に引っかかるため使わない)
    const source = md.utils.escapeHtml(token.content);
    return (
      `<div${self.renderAttrs(token)}>` +
      `<div class="mermaid-source" hidden>${source}</div>` +
      `mermaid を描画中...</div>\n`
    );
  };
}

// 相対パスの <img> は、markdown-it が付けた src をそのまま出さず data-src に
// 退避する。src を残したまま innerHTML に流し込むと、blob URL に置き換える
// (src/ui/preview.js の resolveImages())より先にブラウザが素の相対パスへ
// 実際に読み込みを試みてしまい、無駄な 404 とコンソールエラーが発生するため。
// 外部 URL(http 等)はそのまま素通しする(ブラウザに直接読ませてよいため)。
function applyImagePlaceholder(md) {
  const defaultImage =
    md.renderer.rules.image || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options, env));

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIdx = token.attrIndex('src');
    if (srcIdx >= 0) {
      const src = token.attrs[srcIdx][1];
      if (!isExternalUrl(src)) {
        token.attrs.splice(srcIdx, 1);
        token.attrSet('data-src', src);
      }
    }
    return defaultImage(tokens, idx, options, env, self);
  };
}
