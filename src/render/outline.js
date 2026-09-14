// src/render/outline.js
//
// 見出しの連番・階層ごとの字下げ(設定でオン/オフできる。既定はどちらもオフ)。
// markdown-it のトークン段階ではなく、描画後の DOM(#mdpreview-root の中身)に
// 対して適用する。理由: md 本文や見出し id(MPE 互換)を変えずに済み、目次
// (`[TOC]` と保存時に md へ書き込む MPE 方式の目次の両方)にも同じ規則で番号を
// 付けられ、HTML 出力は DOM を複製するのでそのまま反映されるため。
//
// - computeHeadingNumbers / computeIndentLevels: DOM に依存しない純粋関数
//   (tests/render-outline.test.js で検証する)
// - applyOutline: 上記を使って実際に本文直下の DOM 要素へ反映する
//   (src/ui/preview.js の render() から、本文を差し込んだ直後に呼ばれる)

const HEADING_TAGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * 見出しの配列(本文直下にあるものを文書順に)から、それぞれの連番文字列を
 * 計算する。h2 = "1."、h3 = "1-2."、h4 = "1-2-3."(区切りは "-"、末尾に ".")。
 *
 * - h1 は番号を付けず、h2 以降の数え直し(リセット)をする
 * - 間の階層が抜けている場合(h2 の次にいきなり h4)は、抜けた階層を 1 として数える
 * - nonum は番号を付けず、番号も消費しない。その配下(次に同じかより浅い見出しが
 *   来るまでの、より深い見出し)にも番号を付けない
 * - depth より深い見出しには番号を付けない(番号も消費しない)
 *
 * @param {{level: number, nonum?: boolean}[]} headings
 * @param {number} depth 番号を付ける最も深い見出しレベル(2〜6)
 * @returns {(string|null)[]} 各見出しの番号文字列。付けない場合は null
 */
export function computeHeadingNumbers(headings, depth) {
  const counts = {}; // level(2〜6) -> 現在のカウント
  let suppressUntilLevel = null; // nonum の配下を抑制中の基準レベル(null なら抑制なし)

  return (headings || []).map(({ level, nonum }) => {
    if (level === 1) {
      // h1 で数え直す(h1 自体には番号を付けない)。
      for (const key of Object.keys(counts)) delete counts[key];
      suppressUntilLevel = null;
      return null;
    }

    if (suppressUntilLevel != null) {
      if (level <= suppressUntilLevel) {
        suppressUntilLevel = null; // 同じかより浅い見出しが来たので抑制を終える
      } else {
        return null; // nonum の配下(より深い見出し)
      }
    }

    if (nonum) {
      // 自分自身には番号を付けず、カウンタも消費しない。配下は抑制する。
      suppressUntilLevel = level;
      return null;
    }

    if (level > depth) {
      return null; // 設定した深さより深い見出しには付けない・消費しない
    }

    counts[level] = (counts[level] || 0) + 1;
    for (let l = level + 1; l <= 6; l++) counts[l] = 0; // より深い階層は数え直す

    const parts = [];
    for (let l = 2; l <= level; l++) parts.push(counts[l] || 1); // 抜けた階層は 1 とみなす
    return parts.join('-') + '.';
  });
}

/**
 * 本文直下の要素(見出し・それ以外)を文書順に並べたものから、それぞれの
 * 字下げ段数(0〜5にクランプ)を計算する。
 *
 * - 見出し h2 = 0 段、h3 = 1 段、h4 = 2 段…(= level - 2、h1 は 0)
 * - 見出し以外の要素は、直前の見出しの level - 1 段。h1 の後・最初の見出しより
 *   前は 0 段
 * - 脚注(isFootnotes)は常に 0 段
 *
 * @param {{headingLevel: number|null, isFootnotes: boolean}[]} blocks
 * @returns {number[]}
 */
export function computeIndentLevels(blocks) {
  let lastHeadingLevel = 1; // 最初の見出しより前は h1 の後と同じ扱い(0 段)にする
  return (blocks || []).map((block) => {
    if (block.isFootnotes) return 0;
    if (block.headingLevel != null) {
      lastHeadingLevel = block.headingLevel;
      return clamp(block.headingLevel - 2, 0, 5);
    }
    return clamp(lastHeadingLevel - 1, 0, 5);
  });
}

// ---- DOM への適用 -----------------------------------------------------------

function isFootnotesElement(el) {
  return (
    (el.tagName === 'SECTION' && el.classList.contains('footnotes')) ||
    (el.tagName === 'HR' && el.classList.contains('footnotes-sep'))
  );
}

function makeNumberSpan(doc, text) {
  const span = doc.createElement('span');
  span.className = 'mdp-heading-number';
  span.textContent = text;
  return span;
}

// 本文直下の見出しに連番の span を差し込み、目次(`[TOC]` と保存時に md へ書き込む
// MPE 方式の目次の両方)の対応するリンクにも同じ番号を差し込む。見出しのテキスト・
// id は変えない(span を先頭の子として挿入するだけ)。
function applyHeadingNumbers(wrapperEl, children, depth) {
  const headingEls = children.filter((el) => HEADING_TAGS[el.tagName]);
  if (!headingEls.length) return;

  const numbers = computeHeadingNumbers(
    headingEls.map((el) => ({ level: HEADING_TAGS[el.tagName], nonum: el.classList.contains('nonum') })),
    depth
  );

  const doc = wrapperEl.ownerDocument;
  // 目次側の一致判定用に、見出し id → { number, text }(span 挿入前のテキスト)を集める。
  const byId = new Map();
  headingEls.forEach((el, i) => {
    const number = numbers[i];
    if (number == null) return;
    byId.set(el.id, { number, text: el.textContent.trim() });
    el.insertBefore(makeNumberSpan(doc, number), el.firstChild);
  });
  if (!byId.size) return;

  // 目次の li は `[TOC]` の出力にも、MPE 方式の目次(通常の markdown リストとして
  // 書き込まれる)にも文書中どこにでもネストしうるため、本文全体から探す。
  // li の最初の子要素が `a[href^="#"]` で、リンク先が番号付きの見出しであり、かつ
  // リンクのテキストがその見出しのテキスト(番号を除いたもの)と一致するものだけを
  // 対象にする(段落中の普通のリンクは li の最初の子でないため対象外になる)。
  for (const li of wrapperEl.querySelectorAll('li')) {
    const a = li.firstElementChild;
    if (!a || a.tagName !== 'A') continue;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('#')) continue;
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch {
      id = href.slice(1);
    }
    const info = byId.get(id);
    if (!info || a.textContent.trim() !== info.text) continue;
    a.insertBefore(makeNumberSpan(doc, info.number), a.firstChild);
  }
}

// 本文直下の各要素に data-mdp-indent="N"(N ≥ 1 のときだけ)を付ける。
function applyIndent(children) {
  const blocks = children.map((el) => ({
    headingLevel: HEADING_TAGS[el.tagName] || null,
    isFootnotes: isFootnotesElement(el),
  }));
  const levels = computeIndentLevels(blocks);
  children.forEach((el, i) => {
    if (levels[i] >= 1) el.setAttribute('data-mdp-indent', String(levels[i]));
  });
}

/**
 * 描画後の本文(#mdpreview-root)に見出しの連番・字下げを適用する。呼び出し側
 * (src/ui/preview.js)は render() のたびに innerHTML を丸ごと入れ直してから
 * 呼ぶ前提なので、オフのときに前回の付与を取り消す処理は不要。
 *
 * @param {HTMLElement} wrapperEl
 * @param {{numbers?: boolean, depth?: number, indent?: boolean}} [opts]
 */
export function applyOutline(wrapperEl, { numbers, depth, indent } = {}) {
  if (!wrapperEl || (!numbers && !indent)) return;
  const children = Array.from(wrapperEl.children);
  if (numbers) applyHeadingNumbers(wrapperEl, children, depth || 6);
  if (indent) applyIndent(children);
}
