// src/ui/drop-zone.js
//
// md ファイル・フォルダをドラッグ&ドロップして開く機能の受け口。起動画面・
// メイン画面のどちらの上でも受け付けるため window に配線する。プレビュー
// (src/ui/preview.js)は iframe なので、その上の dragover/drop/dragleave は
// 親 window のリスナーには届かない(iframe は別のブラウジングコンテキストで、
// ネイティブのドラッグ&ドロップイベントは自身のドキュメントにしか配られない)。
// そのため attachDropZone() が返す attachToDocument(doc) で、iframe の
// contentDocument にも同じ3種類のイベントを配線する(呼び出し側 = src/app.js が
// preview.whenReady() の後に呼ぶ)。
//
// #editorPane(エディタ)へのドロップは src/paste.js が画像として処理する既存の
// 動作があり、絶対に壊してはいけない。画像を1つでも含む Files のドラッグは
// dragover・drop とも paste.js に完全に任せる(この覆いは出さない・preventDefault も
// stopPropagation もしない)。画像を含まない Files(md・フォルダ・その他)のときは、
// この覆いを出し、drop はここで「開く」として処理する。
//
// ---- CodeMirror の既定の drop 処理をどう避けるか ----
// CodeMirror(node_modules/@codemirror/view の handlers.drop)は #editorPane 内の
// contentDOM に非捕捉(bubble)の drop リスナーを持ち、Files のドロップでもファイルの
// 中身をテキストとして読み込んで文書に挿入してしまう(handlers.drop → dropText)。
// paste.js の drop リスナーも contentDOM の上位(view.dom)に非捕捉で付いており、
// 画像でなければ何もせず既定動作(= CodeMirror の挿入)に譲る作りになっている。
// bubble フェーズでは contentDOM 上の CodeMirror のリスナーの方が window より先に
// 実行されてしまうため、window の bubble リスナーで後から preventDefault しても
// 間に合わない。そのため drop は window に capture: true でも付け、対象が #editorPane の中で
// Files を含み画像を含まないと判定した時点で preventDefault() + stopPropagation() する
// (捕捉フェーズは対象に向かって最初に実行されるため、CodeMirror・paste.js のどちらの
// リスナーにもイベントが渡らない)。画像を含む場合はここでは何もしないので、通常どおり
// bubble フェーズで paste.js が処理する。
// エディタの外へのドロップは従来どおり bubble フェーズで処理し、他の部品(注釈エディタの
// 画像ドロップなど)が先に preventDefault していれば何もしない(捕捉フェーズで横取りすると、
// 注釈エディタに md を落としたときに背後で md が開いてしまうため、捕捉はエディタの上だけ)。
//
// エディタ内のテキストのドラッグ移動(選択範囲を別の位置へ動かす操作)は
// dataTransfer.types に 'Files' が含まれないため、この処理には一切引っかからない
// (hasFiles() が false を返してそのまま return する)。
//
// ---- 覆いの出し外し(iframe との境界) ----
// dragleave の relatedTarget は、iframe ⇔ 親ドキュメントの境界をまたいで移動した
// ときに null になることがある(ブラウザの外に完全に出たときと区別が付かない)。
// 境界をまたいだ直後には反対側で dragover が発火するはずなので、dragleave では
// 覆いを即座に消さず一呼吸(数十ms)待ってから消す。その間に別の dragover が来れば
// 消去は取り消される(境界をまたいだだけなら覆いが消えたり残ったりしない)。
//
// 覆いの要素には pointer-events: none を付けること(付けないとこの要素がドロップ先を
// 奪い、エディタ・プレビューへのドロップが壊れる。CSS 側 .drop で担保する)。
//
// ハンドルの取り出し(item.getAsFileSystemHandle())だけをここで行い、複数落とされた
// ときの優先順位判定・実際に開く処理は呼び出し側(onDropHandles、app.js の
// openDroppedHandles)に任せる。openDroppedHandles は E2E テスト用フックとしても
// 公開される(本物の DragEvent は dataTransfer.items(getAsFileSystemHandle)を
// 組み立てられないため、テストは window.showDirectoryPicker() 等で得た本物相当の
// ハンドルを直接渡す。画像でない Files の drop 自体(覆いの表示・CodeMirror への
// 非挿入)は本物の File を積んだ DataTransfer で検証できる)。

const HIDE_DELAY_MS = 60;

/**
 * @param {{
 *   overlayEl: HTMLElement,
 *   onDropHandles: (handles: Array<FileSystemDirectoryHandle|FileSystemFileHandle>) => void,
 *   setStatusMessage: (text: string, opts?: { isError?: boolean }) => void,
 * }} opts
 * @returns {{ attachToDocument: (doc: Document) => void }}
 */
export function attachDropZone({ overlayEl, onDropHandles, setStatusMessage }) {
  let hideTimer = null;

  function hasFiles(dataTransfer) {
    return !!dataTransfer && Array.from(dataTransfer.types || []).includes('Files');
  }

  // ドラッグ中の項目に画像ファイルが1つでも含まれるか。dragover の時点では
  // dataTransfer.files は空(File の中身はドロップされるまで見えない)なので、
  // 型情報だけ持つ dataTransfer.items で判定する(drop 時もこれで統一する)。
  function hasImageItem(dataTransfer) {
    if (!dataTransfer) return false;
    return Array.from(dataTransfer.items || []).some((item) => item.kind === 'file' && /^image\//.test(item.type || ''));
  }

  function showOverlay() {
    if (hideTimer != null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    overlayEl.style.display = 'flex';
  }

  // 即座に隠す(drop・dragend など、ドラッグ自体が終わったとき用)。
  function hideOverlayNow() {
    if (hideTimer != null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    overlayEl.style.display = 'none';
  }

  // 一呼吸待ってから隠す(dragleave 用。iframe との境界をまたいだだけなら、
  // 直後の dragover で showOverlay() が呼ばれこの予約は取り消される)。
  function scheduleHideOverlay() {
    if (hideTimer != null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      overlayEl.style.display = 'none';
    }, HIDE_DELAY_MS);
  }

  function handleDragOver(e) {
    if (!hasFiles(e.dataTransfer)) return;
    if (e.target && e.target.closest && e.target.closest('#editorPane')) {
      if (hasImageItem(e.dataTransfer)) {
        // 画像を含む: 貼り付け(paste.js)に任せる。覆いは出さない
        // (dragleave と同じ「一呼吸待ってから隠す」にして、境界をまたいだだけの
        // ときの点滅を防ぐ)。
        scheduleHideOverlay();
        return;
      }
      // 画像を含まない Files(md・フォルダ・その他): エディタ上でも「開く」対象として
      // 覆いを出す(下の handleDropCapture が CodeMirror への挿入を防ぐ)。
    }
    e.preventDefault();
    showOverlay();
  }

  function handleDragLeave(e) {
    // 子要素間の移動では relatedTarget が入るので無視する。null のときだけ
    // (ウィンドウの外/iframe の境界)一呼吸待って隠す。
    if (e.relatedTarget == null) scheduleHideOverlay();
  }

  function handleDragEnd() {
    hideOverlayNow();
  }

  function openFromDrop(e) {
    e.preventDefault();
    hideOverlayNow();
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
  }

  // エディタ(#editorPane)の上だけは捕捉フェーズで処理する。CodeMirror 本体の drop
  // (contentDOM の bubble リスナー)は画像以外のファイルを文字として文書に挿入して
  // しまうため、それより先に止める必要がある。画像を含むときは何もせず、bubble
  // フェーズの paste.js(画像の貼り付け)に任せる。
  function handleDropCapture(e) {
    if (!hasFiles(e.dataTransfer)) return; // Files でない(エディタ内のテキスト移動など)
    if (!(e.target && e.target.closest && e.target.closest('#editorPane'))) return; // エディタの外は下の bubble で
    if (hasImageItem(e.dataTransfer)) {
      hideOverlayNow();
      return; // paste.js に任せる
    }
    e.stopPropagation();
    openFromDrop(e);
  }

  // エディタの外(起動画面・ツールバー・プレビューの iframe など)は bubble フェーズで
  // 処理する。他の部品(注釈エディタの画像ドロップなど)が先に処理済み
  // (defaultPrevented)なら何もしない。
  function handleDropBubble(e) {
    hideOverlayNow();
    if (e.defaultPrevented) return;
    if (!hasFiles(e.dataTransfer)) return;
    openFromDrop(e);
  }

  function wire(target) {
    target.addEventListener('dragover', handleDragOver);
    target.addEventListener('dragleave', handleDragLeave);
    target.addEventListener('dragend', handleDragEnd);
    target.addEventListener('drop', handleDropCapture, true);
    target.addEventListener('drop', handleDropBubble);
  }

  wire(window);

  return {
    // iframe の contentDocument にも同じ配線をする(iframe は別のブラウジング
    // コンテキストなので window の配線だけでは届かない。src/app.js が
    // preview.whenReady() の後に呼ぶ)。iframe の document が作り直される経路が
    // 増えた場合は、そのたびに呼び直すこと。
    attachToDocument(doc) {
      if (!doc) return;
      wire(doc);
    },
  };
}
