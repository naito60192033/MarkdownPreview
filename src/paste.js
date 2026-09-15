// src/paste.js
//
// エディタへの画像の貼り付け・ドロップ。
// クリップボードに画像があれば(またはドロップされたファイルが画像であれば)
// MPE(VS Code)と同じく `<md のフォルダ>/images/<md名(拡張子なし)>/image-<連番>.<拡張子>`
// にファイルとして保存し、貼り付け位置(ドロップの場合はドロップした座標)に
// `![](images/<md名>/image-1.png)` を挿入する(base64 の埋め込みはしない。base64 に
// するのは HTML の1ファイル出力のときだけ = src/export.js)。連番・保存先パスの
// 決め方・draw.io の図形データの見分け方などの純粋なロジックは src/paste-save.js
// (このファイルは src/paste-ui.js を使うため CSS の import が絡み、plain
// `node --test` では読み込めない。純粋な部分だけ分離してテスト可能にしている)。
//
// 画像の保存は挿入位置に「⏳ 画像を保存中…」(src/paste-ui.js の
// savingPlaceholderExtension)を出してから始め、終わったら参照に差し替える。
// 保存中に別の画像の貼り付け・ドロップがあっても受け付けず(連番の衝突を防ぐため
// 並行させない)、案内を出す。保存中に別の md を開いた場合は、保存は完了させるが
// 参照は挿入せず(開いている本文が別ファイルのため)、保存したパスを案内する。
//
// クリップボードに画像とテキストの両方がある場合(Excel のセルのコピーなど)は、
// 「画像で貼り付け / テキストで貼り付け / (タブ区切りなら)表(Markdown)で貼り付け」を
// カーソル位置近くのメニュー(src/paste-ui.js の showPasteChoiceMenu)で選ばせる。
// Ctrl+Shift+V(ブラウザの「書式なしで貼り付け」)は text/plain しか渡らないため、
// このハンドラでは画像なしの通常のテキスト貼り付けとして CodeMirror の既定動作になる。
//
// 通常のテキストの貼り付け・ドロップ(画像を含まない場合)は CodeMirror の既定動作に
// そのまま任せる(preventDefault しない)。ただし draw.io の通常のコピー(Ctrl+C)は
// 画像ではなく図形データ(mxGraphModel の XML を URL エンコードした文字列)を
// text/plain に入れるだけなので、それは貼り付けずに「画像としてコピー」を案内する。
// paste はキャプチャ段階で受ける(CodeMirror は defaultPrevented なら自前の貼り付けをしない)。

import { toMarkdownLinkDest } from './fs/paths.js';
import { saveImageFile, isImageFile, isDrawioClipboardText } from './paste-save.js';
import { addSavingPlaceholder, takeSavingPlaceholder, showPasteChoiceMenu } from './paste-ui.js';
import { isTsvTable, tsvToMarkdownTable, wrapBlockForInsert } from './md-table.js';

/**
 * CodeMirror の EditorView に画像の貼り付け・ドロップを配線する。
 * @param {{
 *   view: import('@codemirror/view').EditorView,
 *   getRoot: () => any,
 *   getMdPath: () => string|null,
 *   setStatusMessage: (text: string, opts?: { isError?: boolean }) => void,
 * }} opts
 */
export function attachImagePasteAndDrop({ view, getRoot, getMdPath, setStatusMessage }) {
  // 画像の保存中は連番の衝突を防ぐため並行させない(1つずつ順に保存する)。
  let saving = false;

  const SAVING_BUSY_MESSAGE = '前の画像を保存中です。保存が終わってから貼り付けてください';

  // 画像ファイルを1つずつ順に保存し、挿入位置(pos)へ参照を挿入する
  // (貼り付け・ドロップ・選択メニューの「画像で貼り付け」で共通に使う)。
  async function handleFiles(images, pos) {
    if (images.length === 0) return;
    if (saving) {
      setStatusMessage(SAVING_BUSY_MESSAGE, { isError: true });
      return;
    }
    saving = true;
    const startMdPath = getMdPath();
    const placeholderId = addSavingPlaceholder(view, pos);
    setStatusMessage('画像を保存中…', { timeoutMs: 0 });
    const savedPaths = [];
    const refs = [];
    try {
      for (const file of images) {
        try {
          const { path, ref } = await saveImageFile(file, { getRoot, getMdPath });
          savedPaths.push(path);
          refs.push(ref);
        } catch (e) {
          setStatusMessage('画像の保存に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
        }
      }
    } finally {
      const resolvedPos = takeSavingPlaceholder(view, placeholderId);
      if (getMdPath() !== startMdPath) {
        // 保存中に別の md に切り替えられた: 開いている本文は別ファイルなので挿入しない。
        if (refs.length > 0) {
          setStatusMessage(
            `画像は保存しましたが、ファイルを切り替えたため参照は挿入していません: ${savedPaths.join('、')}`,
            { isError: true, timeoutMs: 0 }
          );
        }
      } else if (refs.length > 0) {
        const insertAt = resolvedPos == null ? view.state.selection.main.from : resolvedPos;
        const insertText = refs.map((r) => `![](${toMarkdownLinkDest(r)})`).join('\n') + '\n';
        view.dispatch({
          changes: { from: insertAt, to: insertAt, insert: insertText },
          selection: { anchor: insertAt + insertText.length },
        });
        setStatusMessage(refs.length === 1 ? '画像を保存しました' : `画像を${refs.length}件保存しました`);
      }
      saving = false;
    }
  }

  function pasteAsText(text) {
    view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.paste' });
  }

  // 前後の段落・表とつながらないよう、必要なら空行を挟んで挿入する(wrapBlockForInsert)。
  function pasteAsTable(text) {
    const sel = view.state.selection.main;
    const insert = wrapBlockForInsert(view.state.doc.toString(), sel.from, sel.to, tsvToMarkdownTable(text));
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length },
      userEvent: 'input.paste',
    });
  }

  // キャプチャ段階で受ける: CodeMirror の paste ハンドラ(.cm-content に付く)より先に
  // 動き、preventDefault すれば CodeMirror はテキストを挿入しない。
  view.dom.addEventListener(
    'paste',
    (e) => {
      const data = e.clipboardData;
      if (!data) return;
      const images = [];
      for (const item of data.items || []) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (isImageFile(f)) images.push(f);
        }
      }
      // text/plain はイベント中に同期で取り出す(Ctrl+Shift+V はこれだけが渡る)。
      const text = data.getData('text/plain');

      if (images.length > 0) {
        e.preventDefault();
        if (saving) {
          setStatusMessage(SAVING_BUSY_MESSAGE, { isError: true });
          return;
        }
        if (text && text.trim() !== '') {
          // Excel のセルなど、画像とテキストの両方がある: 貼り付け方法を選ばせる。
          const pos = view.state.selection.main.from;
          const choices = [
            { id: 'image', label: '画像で貼り付け' },
            { id: 'text', label: 'テキストで貼り付け' },
          ];
          if (isTsvTable(text)) choices.push({ id: 'table', label: '表(Markdown)で貼り付け' });
          showPasteChoiceMenu({ view, pos, choices }).then((choice) => {
            // 挿入位置は選んだ時点のカーソル位置(メニューを開いている間に動くことがあるため)。
            if (choice === 'image') handleFiles(images, view.state.selection.main.from);
            else if (choice === 'text') pasteAsText(text);
            else if (choice === 'table') pasteAsTable(text);
            // null(Esc・外のクリック): 何もしない
          });
          return;
        }
        handleFiles(images, view.state.selection.main.from);
        return;
      }
      if (isDrawioClipboardText(text)) {
        e.preventDefault();
        setStatusMessage(
          'draw.io の図形データは画像ではないため貼り付けませんでした。draw.io の「画像としてコピー(Copy as Image)」(Ctrl+Alt+X)でコピーするか、PNG に書き出してドロップしてください',
          { isError: true, timeoutMs: 15000 }
        );
      }
      // それ以外(通常のテキスト)は CodeMirror の既定動作に任せる
    },
    true
  );

  view.dom.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });

  view.dom.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter(isImageFile);
    if (images.length === 0) return; // 画像でなければ既定動作に任せる
    e.preventDefault();
    if (saving) {
      setStatusMessage(SAVING_BUSY_MESSAGE, { isError: true });
      return;
    }
    const coords = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const pos = coords == null ? view.state.selection.main.from : coords;
    handleFiles(images, pos);
  });
}
