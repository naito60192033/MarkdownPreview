// src/render/alerts.js
//
// アラートブロックを markdown-it で HTML に変換する。DOM に依存しない純粋な
// ES モジュール。2つの記法に対応する。
//
// 1) GitHub 方式: `> [!NOTE]` 〜(引用の中に書く)。マーカーと同じ行のテキストは
//    タイトルになる(例: `> [!WARNING] 注意事項`)。GitHub 本来の仕様ではタイトルは
//    固定(カスタマイズ不可)だが、この実装では MPE 互換のためこの拡張を加えている。
// 2) Qiita 方式: `:::note info` 〜 `:::`(独立したブロックとして書く)。種類語
//    (info/warn/alert)や GitHub の種類名(note/tip/important/warning/caution/
//    link/memo/check/question)、種類語の後ろのタイトルにも対応する。さらに
//    `:::memo` のように "note" を書かない省略形(既知の種類名を ::: の直後に
//    直接書く形)にも対応する。詳細は resolveNoteContainer() / resolveBareContainer()
//    を参照。
//
// どちらも最終的に GitHub と同じ HTML(data-line 付与のため type は
// 'blockquote_open'/'blockquote_close' のまま、tag だけ div にする)に変換する:
//   <div class="markdown-alert markdown-alert-<kind>" data-line="…">
//   <p class="markdown-alert-title"><svg class="octicon …">…</svg>Note</p>
//   ...本文...
//   </div>
//
// タイトルが空文字(設定でタイトルを空欄にした場合。inline での明示指定が
// 優先されるのは変わらない)のときは、外側の div に markdown-alert-notitle を
// 付け、タイトル段落の中身をアイコンだけにする(src/theme/alerts.css 側で
// position: absolute の見出し無しレイアウトに切り替える)。
//
// アイコン(Octicons)について:
// 9 種類は、GitHub と同じ Octicons の 16px 版アイコン(info/light-bulb/report/
// alert/stop/link/pencil/check-circle/question)を使う。パスデータは npm の
// @primer/octicons パッケージ(https://www.npmjs.com/package/@primer/octicons、
// バージョン 19.36.0、`npm pack @primer/octicons@19.36.0` で取得した
// build/data.json より抽出)をそのまま書き写したもの。
//   Copyright (c) 2026 GitHub Inc.
//   Licensed under the MIT License.
// markdown-it の html オプションに依存せず(inline トークンの content は常に
// タイトル文字列そのままにしておく。既存/新規テストが textContent を見て
// いるため)、タイトル段落トークンに meta で印を付け、paragraph_open の
// レンダラで svg 文字列を差し込む方式で出力する。

import container from 'markdown-it-container';

const DEFAULT_TITLES = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
  link: 'Link',
  memo: 'Memo',
  check: 'Check',
  question: 'Question',
};

const KNOWN_KINDS = new Set(Object.keys(DEFAULT_TITLES));

// kind -> Octicon 名・16px 版パスデータ。
const ICONS = {
  note: {
    name: 'info',
    path: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  },
  tip: {
    name: 'light-bulb',
    path: 'M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z',
  },
  important: {
    name: 'report',
    path: 'M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  warning: {
    name: 'alert',
    path: 'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
  caution: {
    name: 'stop',
    path: 'M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  },
  link: {
    name: 'link',
    path: 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z',
  },
  memo: {
    name: 'pencil',
    path: 'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z',
  },
  check: {
    name: 'check-circle',
    path: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm1.5 0a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm10.28-1.72-4.5 4.5a.75.75 0 0 1-1.06 0l-2-2a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018l1.47 1.47 3.97-3.97a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z',
  },
  question: {
    name: 'question',
    path: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  },
};

const MARKER_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|LINK|MEMO|CHECK|QUESTION)\][ \t]*([^\n]*)/i;

// Qiita 方式(:::note <種類語> <タイトル>)の種類語 → 内部の kind への対応。
// info/warn/alert は Qiita 独自の種類語。GitHub の種類名(note/tip/important/
// warning/caution/link/memo/check/question)は KNOWN_KINDS 側でそのまま受け付ける。
const QIITA_KIND_ALIASES = { info: 'note', warn: 'warning', alert: 'caution' };

// Qiita 方式の独立したブロックとして ":::" の直後に直接書ける単語(コンテナ名)。
// "note" は種類語を後ろに続けられる特別な単語(resolveNoteContainer 参照)。
// それ以外は単語自体が種類を表す省略形(resolveBareContainer 参照)。
const QIITA_CONTAINER_WORDS = [...KNOWN_KINDS, ...Object.keys(QIITA_KIND_ALIASES)];

// markdown-it の core ルーラーに、指定のルールの直前にルールを追加する。
// 指定のルールが無ければ末尾に追加する(slug.js / toc.js と同じ考え方)。
function addCoreRuleBefore(md, beforeName, ruleName, fn) {
  try {
    md.core.ruler.before(beforeName, ruleName, fn);
  } catch {
    md.core.ruler.push(ruleName, fn);
  }
}

// アイコンの svg 文字列(fill は CSS 側で currentColor を当てるため属性には書かない)。
function renderOcticon(kind) {
  const icon = ICONS[kind];
  if (!icon) return '';
  return (
    `<svg class="octicon octicon-${icon.name}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">` +
    `<path d="${icon.path}"></path></svg>`
  );
}

// タイトル段落トークン(paragraph_open/inline/paragraph_close)を組み立てる。
// GitHub 方式・Qiita 方式の両方から共通で使う。titleOpen.meta にアイコンの
// kind を記録しておき、registerIconRenderer() の paragraph_open レンダラで
// html オプションに頼らず svg を差し込む(inline.content はタイトル文字列の
// ままにしておくので、レンダリング後の <p> の textContent は変わらない。
// titleText が空文字の場合はアイコンだけの <p> になる)。
function buildTitleTokens(state, { kind, titleText, level, map }) {
  const titleOpen = new state.Token('paragraph_open', 'p', 1);
  titleOpen.block = true;
  titleOpen.level = level;
  titleOpen.map = map ? map.slice() : null;
  titleOpen.attrSet('class', 'markdown-alert-title');
  titleOpen.meta = { alertIcon: kind };

  const titleInline = new state.Token('inline', '', 0);
  titleInline.content = titleText;
  titleInline.level = level + 1;
  titleInline.map = titleOpen.map;
  titleInline.children = [];

  const titleClose = new state.Token('paragraph_close', 'p', -1);
  titleClose.block = true;
  titleClose.level = level;

  return [titleOpen, titleInline, titleClose];
}

// 外側の div トークン(open/close)に共通のクラスを付与する。titleText が
// 空文字(設定でタイトルを空欄にした場合)は markdown-alert-notitle も付ける。
function applyAlertClasses(openToken, closeToken, kind, titleText) {
  openToken.attrJoin('class', 'markdown-alert');
  openToken.attrJoin('class', `markdown-alert-${kind}`);
  if (!titleText) openToken.attrJoin('class', 'markdown-alert-notitle');
  if (closeToken) closeToken.tag = 'div';
}

// Qiita 方式の `:::note ...` の "..." 部分(container_note_open.info。先頭の
// "note" キーワードを含む文字列)から、内部の kind とタイトルを決める。
//   ":::note"            -> { kind: 'note', titleText: 既定の Note }
//   ":::note info"       -> { kind: 'note', titleText: 既定の Note }
//   ":::note warn 注意"  -> { kind: 'warning', titleText: '注意' }
//   ":::note tip"        -> { kind: 'tip', titleText: 既定の Tip }(GitHub の種類名)
// 種類語が info/warn/alert/既知の kind 名のいずれでもない場合は、種類語を含めた
// 文字列全体をタイトルとして扱う(":::note" の後ろに直接タイトルだけを書いた
// 省略記法への配慮。kind は既定の note とする)。
function resolveNoteContainer(info, titles) {
  const trimmed = (info || '').trim();
  // 先頭の "note" キーワードを取り除く(validate で先頭が note であることは
  // 確認済みだが、大文字小文字を問わないため正規表現で取り除く)。
  const afterNote = trimmed.replace(/^\S+/, '').trim();
  if (!afterNote) return { kind: 'note', titleText: titles.note };

  const m = afterNote.match(/^(\S+)[ \t]*([^\n]*)/);
  const word = m[1].toLowerCase();
  const rest = m[2].trim();

  if (QIITA_KIND_ALIASES[word]) {
    const kind = QIITA_KIND_ALIASES[word];
    return { kind, titleText: rest || titles[kind] };
  }
  if (KNOWN_KINDS.has(word)) {
    return { kind: word, titleText: rest || titles[word] };
  }
  return { kind: 'note', titleText: afterNote };
}

// Qiita 方式の省略形(`:::memo` / `:::tip` / `:::info` 等、"note" を書かない
// 形)の "..." 部分(先頭に word 自体を含む文字列)から、kind とタイトルを決める。
// word 自体が種類(またはその別名)を表すので、後ろに続くテキストは常にタイトル
// 扱いになる(resolveNoteContainer と違い、種類語かどうかの判定は不要)。
function resolveBareContainer(word, info, titles) {
  const trimmed = (info || '').trim();
  const afterWord = trimmed.replace(/^\S+/, '').trim();
  const kind = QIITA_KIND_ALIASES[word] || word;
  return { kind, titleText: afterWord || titles[kind] };
}

// GitHub 方式(`> [!NOTE]` 等)を div.markdown-alert に変換する。
function registerGithubStyle(md, titles) {
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

      let closeIdx = -1;
      for (let k = i + 1; k < tokens.length; k++) {
        if (tokens[k].type === 'blockquote_close' && tokens[k].level === bq.level) {
          closeIdx = k;
          break;
        }
      }
      applyAlertClasses(bq, closeIdx >= 0 ? tokens[closeIdx] : null, kind, titleText);

      const titleTokens = buildTitleTokens(state, {
        kind,
        titleText,
        level: pOpen.level,
        map: pOpen.map,
      });

      if (keepBody) {
        tokens.splice(i + 1, 0, ...titleTokens);
      } else {
        // 本文が空になった場合は元の段落(pOpen/inline/pClose)ごと削除する。
        tokens.splice(i + 1, 3, ...titleTokens);
      }
    }
  });
}

// Qiita 方式(`:::note info` 〜 `:::` および `:::memo` 等の省略形)を
// div.markdown-alert に変換する。ブロックの検出自体は markdown-it-container
// (MIT)に任せ、生成された container_<word>_open/close トークンを GitHub 方式と
// 同じ blockquote_open/blockquote_close(type)+div(tag) に作り替える。type を
// blockquote_open のままにすることで、src/render/markdown.js の data-line
// 付与(型ベースの判定)をそのまま利用できる。
//
// 入れ子(`:::note` の中に別の `:::xxx`)を書く場合は、markdown-it-container の
// 仕様上、外側のコロンを内側より多くする必要がある(例: 外側 `::::note` /
// 内側 `:::note`)。コロンの数が同じだと、外側の閉じ `:::` として内側の閉じが
// 先に一致してしまうため。
function registerQiitaStyle(md, titles) {
  for (const word of QIITA_CONTAINER_WORDS) {
    md.use(container, word, {
      // 既定の validate は「先頭の空白区切りトークンが name と完全一致」だが、
      // 大文字小文字を問わず・種類語なし(":::note" だけ)も許可するため独自に定義する。
      validate: (params) => new RegExp(`^${word}(?:\\s|$)`, 'i').test(params.trim()),
    });
  }

  addCoreRuleBefore(md, 'inline', 'qiita_alerts', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i];
      const m = /^container_([a-z]+)_open$/.exec(open.type);
      if (!m || !QIITA_CONTAINER_WORDS.includes(m[1])) continue;
      const word = m[1];

      const { kind, titleText } =
        word === 'note' ? resolveNoteContainer(open.info, titles) : resolveBareContainer(word, open.info, titles);

      open.type = 'blockquote_open';
      open.tag = 'div';

      let closeIdx = -1;
      const closeType = `container_${word}_close`;
      for (let k = i + 1; k < tokens.length; k++) {
        if (tokens[k].type === closeType && tokens[k].level === open.level) {
          closeIdx = k;
          break;
        }
      }
      if (closeIdx >= 0) tokens[closeIdx].type = 'blockquote_close';
      applyAlertClasses(open, closeIdx >= 0 ? tokens[closeIdx] : null, kind, titleText);

      const titleTokens = buildTitleTokens(state, {
        kind,
        titleText,
        level: open.level + 1,
        map: open.map,
      });
      tokens.splice(i + 1, 0, ...titleTokens);
    }
  });
}

// タイトル段落(buildTitleTokens が meta.alertIcon を付けたもの)のレンダリング時に
// アイコンの svg を差し込む。markdown-it の html オプションに依存しない。
function registerIconRenderer(md) {
  const defaultParagraphOpen =
    md.renderer.rules.paragraph_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options, env));

  md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) => {
    const openTag = defaultParagraphOpen(tokens, idx, options, env, self);
    const kind = tokens[idx].meta && tokens[idx].meta.alertIcon;
    return kind ? openTag + renderOcticon(kind) : openTag;
  };
}

/**
 * @param {import('markdown-it')} md
 * @param {{titles?: Partial<typeof DEFAULT_TITLES>}} [options]
 */
export function alertsPlugin(md, options = {}) {
  const titles = { ...DEFAULT_TITLES, ...(options.titles || {}) };

  registerGithubStyle(md, titles);
  registerQiitaStyle(md, titles);
  registerIconRenderer(md);
}
