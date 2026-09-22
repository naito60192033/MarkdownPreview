// src/ui/drop-zone.js
//
// md ファイル・フォルダをウィンドウへドラッグ&ドロップして開く機能の受け口。
// 起動画面・メイン画面のどちらの上でも受け付けるため window に配線する。
//
// #editorPane(エディタ)へのドロップは src/paste.js が画像として処理する既存の
// 動作があり、絶対に壊してはいけない。そのため:
//   - dragover で #editorPane 上にいる間は、この覆いは何もしない(preventDefault も
//     しない)。paste.js 側の dragover ハンドラ(view.dom に付く)が Files のときに
//     preventDefault するので、ドロップ自体は禁止にならない。
//   - drop は e.defaultPrevented を見て、paste.js が既に処理済み(画像として保存)
//     なら何もしない。
// 覆いの要素には pointer-events: none を付けること(付けないとこの要素がドロップ先を
// 奪い、エディタへの画像ドロップが壊れる。CSS 側 .drop で担保する)。
//
// ハンドルの取り出し(item.getAsFileSystemHandle())だけをここで行い、複数落とされた
// ときの優先順位判定・実際に開く処理は呼び出し側(onDropHandles、app.js の
// openDroppedHandles)に任せる。openDroppedHandles は E2E テスト用フックとしても
// 公開される(本物の DragEvent は dataTransfer.items を組み立てられないため、
// テストは window.showDirectoryPicker() 等で得た本物相当のハンドルを直接渡す)。

/**
 * @param {{
 *   overlayEl: HTMLElement,
 *   onDropHandles: (handles: Array<FileSystemDirectoryHandle|FileSystemFileHandle>) => void,
 *   setStatusMessage: (text: string, opts?: { isError?: boolean }) => void,
 * }} opts
 */
export function attachDropZone({ overlayEl, onDropHandles, setStatusMessage }) {
  function hasFiles(dataTransfer) {
    return !!dataTransfer && Array.from(dataTransfer.types || []).includes('Files');
  }

  function showOverlay() {
    overlayEl.style.display = 'flex';
  }

  function hideOverlay() {
    overlayEl.style.display = 'none';
  }

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    if (e.target && e.target.closest && e.target.closest('#editorPane')) {
      // 画像のエディタへのドロップは src/paste.js に任せる。
      hideOverlay();
      return;
    }
    e.preventDefault();
    showOverlay();
  });

  window.addEventListener('dragleave', (e) => {
    // ウィンドウの外へ出たときだけ隠す(子要素間の移動では relatedTarget が入る)。
    if (e.relatedTarget == null) hideOverlay();
  });

  window.addEventListener('dragend', () => hideOverlay());

  window.addEventListener('drop', (e) => {
    hideOverlay();
    if (e.defaultPrevented) return; // paste.js が画像として処理済み
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();

    const items = Array.from(e.dataTransfer.items || []).filter((item) => item.kind === 'file');
    if (items.length === 0) return;
    if (typeof items[0].getAsFileSystemHandle !== 'function') {
      setStatusMessage('このブラウザではドロップから開けません', { isError: true });
      return;
    }

    Promise.all(items.map((item) => item.getAsFileSystemHandle()))
      .then((handles) => onDropHandles(handles.filter(Boolean)))
      .catch((err) => {
        setStatusMessage('開けませんでした: ' + ((err && err.message) || String(err)), { isError: true });
      });
  });
}
