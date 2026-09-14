// src/render/markbox.js
//
// マーカー付きテキスト枠(```mark)を markdown-it で HTML に変換する。DOM に
// 依存しない純粋な ES モジュール。
//
// 既存資料の生 HTML `<pre class="mark-box">…<span class="mark-text">…</span>…</pre>`
// と互換の HTML を、```mark フェンスから生成する。
//
//   ```mark
//   ここは普通の文字 ==ここを強調== 続き
//   ```
//   -> <pre class="mark-box" data-line="N">ここは普通の文字 <span class="mark-text">ここを強調</span> 続き</pre>
//
// - 枠内は md として解釈しない(空白・改行をそのまま保つ)。`<` `&` などは
//   md.utils.escapeHtml で自動的にエスケープする
// - `==X==`(X は 1 文字以上)は 1 行の中だけで対応を取る(行をまたがない)。対応しない
//   `==`(閉じが無い)や中身が空の `====` は文字のまま
// - `\==` で `==` を文字として書ける(`==…==` の中でも閉じとみなさない)
// - `{#id .class}` など markdown-it-attrs の属性はそのまま付く(renderAttrs を使う)
// - `<code>` は入れない(既存資料の生 HTML と同じ構造にするため)
// - 色付け(hljs クラス)・data-line の付与は src/render/markdown.js 側(mermaid と
//   同じ扱い)で行うため、このプラグインでは触れない
//
// mermaid(src/render/markdown.js の applyMermaidFence)と同じ作法で、既存の
// フェンスのレンダラをラップする。plugins の登録(pipeline.js)の後で
// applyMermaidFence が掛かるため、mermaid 側は 'mark' 言語をそのまま
// defaultFence(このプラグインのレンダラ)へ委譲し、両方が正しく動く。

const MARK_LANG = 'mark';

// 1 行分の変換に使うトークナイザ: `\==`(エスケープ) / `==X==`(X は1文字以上、
// 非貪欲マッチ) / それ以外の1文字、の順に優先して切り出す。対応しない `==` や
// 中身が空の `====` はどの候補にもマッチしないため、最後の「それ以外の1文字」で
// 1文字ずつ文字として拾われる。
// X の中の `\==` は閉じとみなさない(段落の markdown-it-mark と同じく
// `==a\==b==` は「a==b」の強調、`==a\==` は強調にならない)。`\` は直後が `==`
// のときは必ず `\==` として 1 単位で読むため、`\` だけを X の末尾にして閉じる
// 読み方にはならない。`[^]` は改行以外の行区切り文字(U+2028 等)も含む任意の 1 文字。
const MARK_TOKEN_RE = /\\==|==((?:\\==|\\(?!==)|[^\\])+?)==|[^]/gu;

// 1 行(改行を含まない文字列)を変換する。
function renderMarkLine(line, md) {
  let out = '';
  let m;
  MARK_TOKEN_RE.lastIndex = 0;
  while ((m = MARK_TOKEN_RE.exec(line))) {
    if (m[0] === '\\==') {
      out += '==';
    } else if (m[1] !== undefined) {
      const text = m[1].replace(/\\==/g, '==');
      out += `<span class="mark-text">${md.utils.escapeHtml(text)}</span>`;
    } else {
      out += md.utils.escapeHtml(m[0]);
    }
  }
  return out;
}

// フェンスの中身を行ごとに変換し、改行を保ったまま結合する。
function renderMarkBody(content, md) {
  return content
    .split('\n')
    .map((line) => renderMarkLine(line, md))
    .join('\n');
}

/**
 * @param {import('markdown-it')} md
 */
export function markBoxPlugin(md) {
  const defaultFence =
    md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options, env));

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = (token.info || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
    if (lang !== MARK_LANG) {
      return defaultFence(tokens, idx, options, env, self);
    }
    token.attrJoin('class', 'mark-box');
    return `<pre${self.renderAttrs(token)}>${renderMarkBody(token.content, md)}</pre>\n`;
  };
}
