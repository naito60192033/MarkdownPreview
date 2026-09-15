// src/editor.js
//
// CodeMirror 6 まわりのセットアップ。`codemirror` パッケージの basicSetup
// (行番号・履歴・検索・折りたたみ・自動補完などをひとまとめにしたもの)に
// 折り返し(lineWrapping)と markdown 言語を足すだけの薄いラッパー。
//
// IME(日本語入力)については CodeMirror 6 が標準で合成(composition)イベントを
// 正しく扱うため、ここでは特別な処理を入れていない(keydown を横取りする独自の
// 入力ハンドラを足さないことが重要)。
//
// スクロール同期(src/scroll-sync.js)のために、行単位ではなく「行 + その行内の
// 縦方向の割合(0〜1)」で読み書きできる API(getTopFractionalLine /
// scrollToFractionalLine)を用意している。

import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// md 編集用の配色。basicSetup の既定の配色(フォールバック扱い)は見出しやリンクに
// 下線を引いて読みにくいため、これを登録して置き換える(フォールバックでない配色が
// 1 つでもあれば既定の配色は使われない)。
const mdHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: '#1f2328' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: '#0969da' },
  { tag: tags.monospace, color: '#953800' },
  { tag: tags.quote, color: '#57606a' },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: '#8c959f' },
  { tag: tags.comment, color: '#6e7781' },
]);

/**
 * @param {{
 *   parent: HTMLElement,
 *   doc?: string,
 *   onChange?: (text: string) => void,
 *   onCursorActivity?: () => void,
 *   extensions?: import('@codemirror/state').Extension[],
 * }} opts
 */
export function createEditor({ parent, doc = '', onChange, onCursorActivity, extensions = [] } = {}) {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && typeof onChange === 'function') {
      onChange(update.state.doc.toString());
    }
    if ((update.selectionSet || update.docChanged) && typeof onCursorActivity === 'function') {
      onCursorActivity();
    }
  });

  const state = EditorState.create({
    doc,
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(mdHighlightStyle),
      keymap.of([indentWithTab]),
      updateListener,
      ...extensions,
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,

    getText() {
      return view.state.doc.toString();
    },

    /**
     * 全文を置き換える。preserveCursor が true(既定)なら、置き換え前の
     * カーソル位置(行番号 + 桁)と縦スクロール位置をできる範囲で復元する。
     * 外部変更の自動取り込み時に使う。
     */
    setText(text, { preserveCursor = true } = {}) {
      let restore = null;
      if (preserveCursor) {
        const sel = view.state.selection.main;
        const oldLine = view.state.doc.lineAt(sel.head);
        restore = {
          lineNumber: oldLine.number,
          col: sel.head - oldLine.from,
          scrollTop: view.scrollDOM.scrollTop,
        };
      }

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });

      if (restore) {
        const doc2 = view.state.doc;
        const lineNumber = Math.min(restore.lineNumber, doc2.lines);
        const line = doc2.line(lineNumber);
        const pos = Math.min(line.from + restore.col, line.to);
        view.dispatch({ selection: { anchor: pos, head: pos } });
        view.scrollDOM.scrollTop = restore.scrollTop;
      }
    },

    focus() {
      view.focus();
    },

    /** カーソル位置にテキストを挿入する(画像の貼り付け等で後のフェーズに使う)。 */
    insertAtCursor(text) {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
    },

    /** 現在一番上に見えている行(0始まり)と、その行内でのスクロール割合(0〜1)。 */
    getTopFractionalLine() {
      const scrollTop = view.scrollDOM.scrollTop;
      const block = view.lineBlockAtHeight(scrollTop);
      const lineNumber = view.state.doc.lineAt(block.from).number - 1;
      const fraction = block.height > 0 ? (scrollTop - block.top) / block.height : 0;
      return { line: lineNumber, fraction: Math.max(0, Math.min(1, fraction)) };
    },

    /** line(0始まり) + その行内の割合(0〜1)の位置までスクロールする。 */
    scrollToFractionalLine(line, fraction = 0) {
      const doc2 = view.state.doc;
      const lineNumber = Math.max(1, Math.min(doc2.lines, line + 1));
      const lineInfo = doc2.line(lineNumber);
      const block = view.lineBlockAt(lineInfo.from);
      view.scrollDOM.scrollTop = block.top + block.height * fraction;
    },

    /** スクロール DOM 要素そのもの(scroll イベントの購読用)。 */
    get scrollDOM() {
      return view.scrollDOM;
    },

    destroy() {
      view.destroy();
    },
  };
}
