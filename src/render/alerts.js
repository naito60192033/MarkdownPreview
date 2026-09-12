// src/render/alerts.js
//
// GitHub 形式のアラートブロック(`> [!NOTE]` 等)を markdown-it で HTML に
// 変換する。DOM に依存しない純粋な ES モジュール。
//
// 出力は GitHub と同じ形:
//   <div class="markdown-alert markdown-alert-note">
//   <p class="markdown-alert-title">Note</p>
//   ...本文...
//   </div>
//
// GitHub 本来の仕様ではタイトルは固定(カスタマイズ不可)だが、この実装では
// MPE 互換のため「マーカーの後ろに同じ行でテキストがあればタイトルとして使う」
// (例: `> [!WARNING] 注意事項`)という拡張を加えている。

const DEFAULT_TITLES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

const MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*([^\n]*)/i;

// markdown-it の core ルーラーに、指定のルールの直前にルールを追加する。
// 指定のルールが無ければ末尾に追加する(slug.js / toc.js と同じ考え方)。
function addCoreRuleBefore(md, beforeName, ruleName, fn) {
  try {
    md.core.ruler.before(beforeName, ruleName, fn);
  } catch {
    md.core.ruler.push(ruleName, fn);
  }
}

/**
 * @param {import('markdown-it')} md
 * @param {{titles?: Partial<typeof DEFAULT_TITLES>}} [options]
 */
export function alertsPlugin(md, options = {}) {
  const titles = { ...DEFAULT_TITLES, ...(options.titles || {}) };

  // inline トークンがまだ children に分解される前(= 'inline' コアルールより前)に
  // 動かす。段落の生の markdown テキスト(inline.content)をそのまま操作できるため、
  // マーカー行を取り除いた残りは通常どおり inline 解析される。
  addCoreRuleBefore(md, 'inline', 'alerts', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      const bq = tokens[i];
      if (bq.type !== 'blockquote_open') continue;

      const pOpen = tokens[i + 1];
      const inline = tokens[i + 2];
      const pClose = tokens[i + 3];
      if (
        !pOpen ||
        pOpen.type !== 'paragraph_open' ||
        !inline ||
        inline.type !== 'inline' ||
        !pClose ||
        pClose.type !== 'paragraph_close'
      ) {
        continue;
      }

      const m = inline.content.match(MARKER_RE);
      if (!m) continue;

      const kind = m[1].toLowerCase();
      const customTitle = m[2].trim();
      const titleText = customTitle || titles[kind];

      // マーカー行(+続く改行 1 つ)を取り除いた残りが本文になる。
      let remainder = inline.content.slice(m[0].length);
      if (remainder.startsWith('\n')) remainder = remainder.slice(1);
      const keepBody = remainder.trim() !== '';
      inline.content = remainder;

      // blockquote_open/close を div.markdown-alert.markdown-alert-<kind> にする。
      // type は 'blockquote_open'/'blockquote_close' のまま保つ(後段の
      // data-line 付与など、型で判定する処理に影響を与えないため)。
      bq.tag = 'div';
      bq.attrJoin('class', 'markdown-alert');
      bq.attrJoin('class', `markdown-alert-${kind}`);

      let closeIdx = -1;
      for (let k = i + 1; k < tokens.length; k++) {
        if (tokens[k].type === 'blockquote_close' && tokens[k].level === bq.level) {
          closeIdx = k;
          break;
        }
      }
      if (closeIdx >= 0) {
        tokens[closeIdx].tag = 'div';
      }

      // タイトル段落トークンを組み立てる。
      const titleOpen = new state.Token('paragraph_open', 'p', 1);
      titleOpen.block = true;
      titleOpen.level = pOpen.level;
      titleOpen.map = pOpen.map ? pOpen.map.slice() : null;
      titleOpen.attrSet('class', 'markdown-alert-title');

      const titleInline = new state.Token('inline', '', 0);
      titleInline.content = titleText;
      titleInline.level = pOpen.level + 1;
      titleInline.map = titleOpen.map;
      titleInline.children = [];

      const titleClose = new state.Token('paragraph_close', 'p', -1);
      titleClose.block = true;
      titleClose.level = pOpen.level;

      if (keepBody) {
        tokens.splice(i + 1, 0, titleOpen, titleInline, titleClose);
      } else {
        // 本文が空になった場合は元の段落(pOpen/inline/pClose)ごと削除する。
        tokens.splice(i + 1, 3, titleOpen, titleInline, titleClose);
      }
    }
  });
}
