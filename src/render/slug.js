// src/render/slug.js
//
// MPE(VSCode Markdown Preview Enhanced)互換の見出し id 生成。DOM に依存しない
// 純粋な ES モジュール。crossnote の src/markdown-engine/heading-id-generator.ts
// を忠実に移植した HeadingIdGenerator と、それを使う markdown-it プラグイン
// headingIdPlugin を提供する。

import uslug from 'uslug';

/**
 * 見出しの見出し文字列(元の markdown テキスト)から id を生成する。
 * crossnote の HeadingIdGenerator の移植(型注釈を外しただけで、ロジックは同一)。
 * 1 インスタンス = 1 回の描画に対応し、同じテキストの見出しが複数あれば
 * `-1`, `-2` ... を付けて重複を避ける。
 */
export class HeadingIdGenerator {
  constructor() {
    this.table = {};
  }

  generateId(heading) {
    const replacement = (match, capture) => {
      const sanitized = capture
        .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '')
        .replace(/^\s/, '')
        .replace(/\s$/, '')
        .replace(/`/g, '~');
      return (
        (capture.match(/^\s+$/) ? '~' : sanitized) +
        (match.endsWith(' ') && !sanitized.endsWith('~') ? '~' : '')
      );
    };

    heading = heading
      .trim()
      .replace(/~|。/g, '') // sanitize
      .replace(/``(.+?)``\s?/g, replacement)
      .replace(/`(.*?)`\s?/g, replacement)
      // 下線による強調記号(_..._, __...__, ___...___)を、レンダリング結果に
      // 合わせて取り除く(単語内の `_` は CommonMark の仕様上強調にならないため
      // 残す。境界の判定は元の TypeScript 実装のコメントのとおり)。
      .replace(
        /(^|\s|(?!_)[\p{P}\p{S}])___([^\s_](?:[^_]*[^\s_])?)___(?=$|\s|(?!_)[\p{P}\p{S}])/gu,
        `$1$2`,
      )
      .replace(
        /(^|\s|(?!_)[\p{P}\p{S}])__([^\s_](?:[^_]*[^\s_])?)__(?=$|\s|(?!_)[\p{P}\p{S}])/gu,
        `$1$2`,
      )
      .replace(
        /(^|\s|(?!_)[\p{P}\p{S}])_([^\s_](?:[^_]*[^\s_])?)_(?=$|\s|(?!_)[\p{P}\p{S}])/gu,
        `$1$2`,
      );

    let slug = uslug(heading.replace(/\s/g, '~')).replace(/~/g, '-');
    if (this.table[slug] >= 0) {
      this.table[slug] = this.table[slug] + 1;
      slug += '-' + this.table[slug];
    } else {
      this.table[slug] = 0;
    }
    return slug;
  }
}

// 見出しの行末に付いた `{...}` 属性部分を取り除く(id 生成用のテキストには
// 含めない)。crossnote の transformer.ts と同じ正規表現。
const TRAILING_ATTRS_RE = /{[^{]+}\s*$/;

// markdown-it の core ルーラーに、指定のルールの直後にルールを追加する。
// 指定のルールが存在しない場合(単体テストなどで attrs 系プラグインを
// 使っていない場合)は末尾に追加する。
function addCoreRuleAfter(md, afterName, ruleName, fn) {
  try {
    md.core.ruler.after(afterName, ruleName, fn);
  } catch {
    md.core.ruler.push(ruleName, fn);
  }
}

/**
 * 見出しに id を付ける markdown-it プラグイン。
 *
 * - markdown-it-attrs の core ルール `curly_attributes` の後で動く(見出し末尾の
 *   `{#id .class ignore=true}` が heading_open トークンの属性へ既に移されている
 *   前提)。attrs が登録されていない場合はルーラーの末尾で動く。
 * - `{#id}` の指定があればそれを優先し、重複カウンタは消費しない。
 * - `{ignore=true}` は出力 HTML から ignore 属性を取り除き、見出し一覧では
 *   ignore: true として記録する(目次からの除外は toc.js 側の責務)。
 * - env.headings に `{ level, content, id, line, ignore }` を集める。line は
 *   0 始まり。1 回の描画(env)ごとに重複カウンタをリセットする。
 */
export function headingIdPlugin(md) {
  addCoreRuleAfter(md, 'curly_attributes', 'heading_id', (state) => {
    // この core ルールは md.parse() が呼ばれるたびに実行されるので、ここで
    // 新しい HeadingIdGenerator を作ることで描画ごとに重複カウンタがリセットされる。
    const generator = new HeadingIdGenerator();
    state.env.headings = [];
    state.env.__headingIdGenerator = generator;

    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;

      const level = Number(token.tag.slice(1)) || 1;
      const content = inline.content.replace(TRAILING_ATTRS_RE, '').trim();

      let ignoreAttr = token.attrGet('ignore');
      const ignore = ignoreAttr != null && String(ignoreAttr) !== 'false';
      if (ignore) {
        const idx = token.attrIndex('ignore');
        if (idx >= 0) token.attrs.splice(idx, 1);
      }

      let id = token.attrGet('id');
      if (!id) {
        id = generator.generateId(content);
        token.attrSet('id', id);
      }

      state.env.headings.push({
        level,
        content,
        id,
        line: token.map ? token.map[0] : null,
        ignore,
      });
    }
  });
}
