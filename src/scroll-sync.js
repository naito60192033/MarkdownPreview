// src/scroll-sync.js
//
// エディタとプレビューのスクロールを双方向に同期する。DOM 操作は行うが、
// エディタ・プレビューの実体(CodeMirror の view / iframe の document)は
// 呼び出し側から関数経由で渡してもらう(疎結合にするため)。
//
//  - エディタ → プレビュー: エディタの「一番上に見えている行(小数付き)」を
//    lineMap で展開後の行に変換し、data-line を持つプレビュー要素のうち
//    直前・直後のものを見つけて線形補間でスクロール位置を決める。
//    ただし、エディタの残りのスクロール量が 1 画面分を切ったら、その位置から
//    プレビューの最下部へ徐々に寄せる(エディタが最下部なら必ずプレビューも
//    最下部にする)。行の対応だけだと、一番上に見えている行より下に画像などで
//    縦に長い内容があると、エディタが最下部でもプレビューが最下部まで届かない。
//  - プレビュー → エディタ: 逆方向。プレビューの scrollTop から直前・直後の
//    data-line 要素を見つけて展開後の行(小数)を求め、lineMap の逆変換で
//    エディタの行に直す。こちらは最下部への寄せは行わない。
//
// 互いに呼び合って発振しないよう、プログラムでスクロールさせた直後は
// そちら側からのイベントを一時的に無視する(guardSide)。

// 展開後の行番号 → 元の行番号。lineMap は「展開後の行 index → 元の行番号」の
// 配列(pipeline.js の renderDocument() が返すもの)。
function expandedToOriginal(lineMap, expandedLine) {
  if (!lineMap || lineMap.length === 0) return expandedLine;
  const idx = Math.max(0, Math.min(lineMap.length - 1, Math.round(expandedLine)));
  return lineMap[idx];
}

// 元の行番号(小数可)→ 展開後の行番号(小数)。lineMap が非減少であることを
// 前提に二分探索し、区間内を線形補間する。
function originalToExpanded(lineMap, originalLine) {
  if (!lineMap || lineMap.length === 0) return originalLine;
  const last = lineMap.length - 1;
  if (originalLine <= lineMap[0]) return 0;
  if (originalLine >= lineMap[last]) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineMap[mid] < originalLine) lo = mid + 1;
    else hi = mid;
  }
  const afterIdx = lo;
  const beforeIdx = Math.max(0, lo - 1);
  const beforeVal = lineMap[beforeIdx];
  const afterVal = lineMap[afterIdx];
  if (afterVal === beforeVal || afterIdx === beforeIdx) return afterIdx;
  const t = (originalLine - beforeVal) / (afterVal - beforeVal);
  return beforeIdx + t * (afterIdx - beforeIdx);
}

function collectLineElements(doc) {
  return Array.from(doc.querySelectorAll('[data-line]'))
    .map((el) => ({ el, line: Number(el.getAttribute('data-line')) }))
    .filter((x) => !Number.isNaN(x.line));
}

// el の、scrollRoot のスクロール内容の先頭からの位置(px)。
// scrollRoot がページ全体のスクロール(iframe の <html> = scrollingElement)の場合、
// <html> 自身の getBoundingClientRect().top は -scrollTop になる(一緒にスクロールする)ため
// 基準にしてはいけない(scrollTop が二重に加算され、同期のたびにプレビューが下へずれていく)。
// ビューポートの上端(0)を基準にする。
function topOf(el, scrollRoot) {
  const doc = scrollRoot.ownerDocument;
  const isViewport = scrollRoot === doc.scrollingElement || scrollRoot === doc.documentElement;
  const rootTop = isViewport ? 0 : scrollRoot.getBoundingClientRect().top;
  return el.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop;
}

/**
 * @param {{ editor: ReturnType<typeof import('./editor.js').createEditor>,
 *           getPreviewRoot: () => ({ doc: Document, scrollRoot: Element } | null),
 *           getLineMap: () => number[] }} opts
 */
export function createScrollSync({ editor, getPreviewRoot, getLineMap }) {
  let guardSide = null; // 'editor' | 'preview' | null
  let guardTimer = null;
  let previewScrollHandler = null;
  let attachedScrollRoot = null;

  function withGuard(side, fn) {
    guardSide = side;
    fn();
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      guardSide = null;
    }, 60);
  }

  function syncEditorToPreview() {
    if (guardSide === 'editor') return;
    const root = getPreviewRoot();
    if (!root) return;
    const items = collectLineElements(root.doc);
    if (items.length === 0) return;
    items.sort((a, b) => a.line - b.line);

    const lineMap = getLineMap() || [];
    const { line, fraction } = editor.getTopFractionalLine();
    const expandedLine = originalToExpanded(lineMap, line + fraction);

    let before = items[0];
    let after = items[items.length - 1];
    for (const item of items) {
      if (item.line <= expandedLine) before = item;
      if (item.line >= expandedLine) {
        after = item;
        break;
      }
    }
    const beforeTop = topOf(before.el, root.scrollRoot);
    const afterTop = topOf(after.el, root.scrollRoot);
    const t =
      after.line === before.line ? 0 : Math.max(0, Math.min(1, (expandedLine - before.line) / (after.line - before.line)));
    let target = beforeTop + (afterTop - beforeTop) * t;

    // エディタの残りのスクロール量が 1 画面分を切ったら、プレビューの最下部へ徐々に寄せる。
    const scrollDOM = editor.scrollDOM;
    const editorMax = scrollDOM.scrollHeight - scrollDOM.clientHeight;
    const remain = editorMax - scrollDOM.scrollTop;
    const span = Math.min(editorMax, scrollDOM.clientHeight);
    if (span > 0 && remain < span) {
      const t2 = Math.max(0, Math.min(1, 1 - remain / span));
      const previewMax = root.scrollRoot.scrollHeight - root.scrollRoot.clientHeight;
      target = target + (previewMax - target) * t2;
    }

    withGuard('preview', () => {
      root.scrollRoot.scrollTop = Math.max(0, target);
    });
  }

  function syncPreviewToEditor() {
    if (guardSide === 'preview') return;
    const root = getPreviewRoot();
    if (!root) return;
    const items = collectLineElements(root.doc);
    if (items.length === 0) return;
    for (const item of items) item.top = topOf(item.el, root.scrollRoot);
    items.sort((a, b) => a.top - b.top);

    const scrollTop = root.scrollRoot.scrollTop;
    let before = items[0];
    let after = items[items.length - 1];
    for (const item of items) {
      if (item.top <= scrollTop) before = item;
      if (item.top >= scrollTop) {
        after = item;
        break;
      }
    }
    const t = after.top === before.top ? 0 : Math.max(0, Math.min(1, (scrollTop - before.top) / (after.top - before.top)));
    const expandedLine = before.line + (after.line - before.line) * t;

    const lineMap = getLineMap() || [];
    const originalLine = expandedToOriginal(lineMap, expandedLine);

    withGuard('editor', () => {
      const line = Math.floor(originalLine);
      const fraction = originalLine - line;
      editor.scrollToFractionalLine(line, fraction);
    });
  }

  editor.scrollDOM.addEventListener('scroll', syncEditorToPreview, { passive: true });

  // プレビュー(iframe)は1度しか作られないが、load 完了のタイミングは
  // 呼び出し側の都合次第なので、scrollRoot が確定してから呼んでもらう。
  function attachPreviewScrollListener() {
    const root = getPreviewRoot();
    if (!root || attachedScrollRoot === root.scrollRoot) return;
    if (attachedScrollRoot && previewScrollHandler) {
      attachedScrollRoot.removeEventListener('scroll', previewScrollHandler);
    }
    previewScrollHandler = () => syncPreviewToEditor();
    root.scrollRoot.addEventListener('scroll', previewScrollHandler, { passive: true });
    attachedScrollRoot = root.scrollRoot;
  }

  function destroy() {
    editor.scrollDOM.removeEventListener('scroll', syncEditorToPreview);
    if (attachedScrollRoot && previewScrollHandler) {
      attachedScrollRoot.removeEventListener('scroll', previewScrollHandler);
    }
    clearTimeout(guardTimer);
  }

  return { attachPreviewScrollListener, syncEditorToPreview, syncPreviewToEditor, destroy };
}
