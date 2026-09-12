// src/ui/image-edit.js
//
// プレビュー上の画像にマウスを乗せると、画像の右上に「✎ 編集」ボタンを出す。
// クリックすると、その画像のファイルを FSA で読んで openAnnotator() を開く。
//
// 保存された(Blob が返った)ら:
//   - 元が PNG なら同じパスに上書きする(読み込み時の lastModified で競合チェック。
//     競合したら確認ダイアログを出す)
//   - PNG 以外なら `<同じフォルダ>/<元の名前>.png`(既にあれば -2 等)に保存し、
//     エディタのテキスト内の参照(`](元の data-src)` と `src="元の data-src"`)を
//     新しいパスに書き換える(未保存の状態になる)。参照が見つからない場合
//     (@import 先の md から参照されている画像など)は、PNG の保存はしたうえで、
//     参照を手で直す必要がある旨を状態表示に出す
// その後 requestRerender() を呼んでプレビューを再描画する。
//
// ボタンは iframe の <body> 直下(プレビュー本文 #mdpreview-root の外)に1つだけ
// 作り、対象の画像に応じて位置と表示/非表示を切り替えるだけにする。本文側の
// innerHTML 差し替え(src/ui/preview.js の render())の影響を受けず、また
// HTML 出力(src/export.js は #mdpreview-root の中身だけを複製する)にも
// 含まれない。

import {
  dirname, basename, extname, joinPath, relativePath, urlToPath, isExternalUrl, toMarkdownLinkDest,
} from '../fs/paths.js';
import { getFileHandleByPath, readBlobByPath, writeByPath, ConflictError } from '../fs/workspace.js';
import { openAnnotator } from '../annotator/annotator.js';

async function pathExists(root, path) {
  try {
    const fh = await getFileHandleByPath(root, path, { create: false });
    await fh.getFile();
    return true;
  } catch {
    return false;
  }
}

async function uniquePngPath(root, dir, baseName) {
  let candidate = dir ? `${dir}/${baseName}.png` : `${baseName}.png`;
  if (!(await pathExists(root, candidate))) return candidate;
  for (let n = 2; ; n++) {
    candidate = dir ? `${dir}/${baseName}-${n}.png` : `${baseName}-${n}.png`;
    if (!(await pathExists(root, candidate))) return candidate;
  }
}

/**
 * @param {{
 *   preview: ReturnType<typeof import('./preview.js').createPreview>,
 *   getRoot: () => any,
 *   getMdPath: () => string|null,
 *   getEditorText: () => string,
 *   replaceEditorText: (nextText: string) => void,
 *   setStatusMessage: (text: string, opts?: { isError?: boolean }) => void,
 *   requestRerender: () => void,
 * }} opts
 */
export function createImageEdit({
  preview,
  getRoot,
  getMdPath,
  getEditorText,
  replaceEditorText,
  setStatusMessage,
  requestRerender,
}) {
  let btn = null;
  let currentImg = null;
  let hideTimer = null;

  function ensureButton(doc) {
    if (btn && btn.ownerDocument === doc && doc.body.contains(btn)) return btn;
    btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = '✎ 編集';
    btn.className = 'mdpreview-image-edit-btn';
    Object.assign(btn.style, {
      position: 'absolute',
      zIndex: '2147483647',
      display: 'none',
      padding: '2px 8px',
      fontSize: '12px',
      lineHeight: '1.4',
      border: '1px solid #888',
      borderRadius: '4px',
      background: 'rgba(255,255,255,0.95)',
      color: '#222',
      cursor: 'pointer',
      boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
    });
    btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    btn.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const img = currentImg;
      if (img) openEditorFor(img);
    });
    doc.body.appendChild(btn);
    return btn;
  }

  function positionButton(img, doc) {
    const rect = img.getBoundingClientRect();
    const view = doc.defaultView;
    const top = Math.max(0, rect.top + view.scrollY + 4);
    const left = Math.max(0, rect.right + view.scrollX - 4);
    btn.style.display = '';
    btn.style.top = top + 'px';
    // 幅が確定してから右端に合わせる(初回は offsetWidth が 0 のことがあるため)。
    requestAnimationFrame(() => {
      btn.style.left = Math.max(0, left - btn.offsetWidth) + 'px';
    });
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (btn) btn.style.display = 'none';
      currentImg = null;
    }, 200);
  }

  function resolveImagePath(img) {
    const raw = img.getAttribute('data-src');
    const mdPath = getMdPath();
    if (!raw || !mdPath || isExternalUrl(raw)) return null;
    const rel = urlToPath(raw);
    return joinPath(dirname(mdPath), rel);
  }

  // エディタのテキスト中の `](元の参照)`・`](<元の参照>)`・`src="元の参照"` を新しいパスに
  // 書き換える。data-src は markdown-it が %エンコードした形(日本語ファイル名など)なので、
  // md に書かれたままの形(デコード後)でも探す。1件でも置換できれば true。
  function rewriteReference(rawSrc, newRef) {
    const text = getEditorText();
    const dest = toMarkdownLinkDest(newRef);
    let replaced = text;
    for (const cand of new Set([rawSrc, urlToPath(rawSrc)])) {
      const esc = cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      replaced = replaced
        .replace(new RegExp('\\]\\(<' + esc + '>', 'g'), () => '](' + dest)
        .replace(new RegExp('\\]\\(' + esc + '(?=[)\\s])', 'g'), () => '](' + dest)
        .replace(new RegExp('src="' + esc + '"', 'g'), () => 'src="' + newRef + '"');
    }
    if (replaced === text) return false;
    replaceEditorText(replaced);
    return true;
  }

  async function openEditorFor(img) {
    const root = getRoot();
    const resolved = resolveImagePath(img);
    if (!root || !resolved) return;

    let blobInfo;
    try {
      blobInfo = await readBlobByPath(root, resolved);
    } catch (e) {
      setStatusMessage('画像を読み込めませんでした: ' + ((e && e.message) || String(e)), { isError: true });
      return;
    }
    if (!blobInfo) {
      setStatusMessage('画像が見つかりません: ' + resolved, { isError: true });
      return;
    }

    let resultBlob;
    try {
      resultBlob = await openAnnotator({ imageBlob: blobInfo.blob, title: basename(resolved) });
    } catch (e) {
      setStatusMessage('注釈エディタを開けませんでした: ' + ((e && e.message) || String(e)), { isError: true });
      return;
    }
    if (!resultBlob) return; // キャンセル

    if (extname(resolved) === '.png') {
      await saveOverPng(root, resolved, resultBlob, blobInfo.lastModified);
      return;
    }

    await saveAsNewPng(root, resolved, resultBlob, img.getAttribute('data-src'));
  }

  // 元の画像が参照されていた md から見た、新しい PNG への相対パス。
  // (元画像・新画像は同じフォルダに保存するので、拡張子・ファイル名だけが変わる)
  function referenceFor(newPath) {
    const mdPath = getMdPath();
    return relativePath(dirname(mdPath || ''), newPath);
  }

  async function saveOverPng(root, resolved, resultBlob, expectedLastModified) {
    try {
      await writeByPath(root, resolved, resultBlob, { expectedLastModified });
      setStatusMessage('画像を保存しました: ' + resolved);
      requestRerender();
    } catch (e) {
      if (e instanceof ConflictError || (e && e.name === 'ConflictError')) {
        const overwrite = window.confirm('画像が他で更新されています。上書きしますか?');
        if (!overwrite) return;
        try {
          await writeByPath(root, resolved, resultBlob, {});
          setStatusMessage('画像を上書き保存しました: ' + resolved);
          requestRerender();
        } catch (e2) {
          setStatusMessage('画像の保存に失敗しました: ' + ((e2 && e2.message) || String(e2)), { isError: true });
        }
      } else {
        setStatusMessage('画像の保存に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
      }
    }
  }

  async function saveAsNewPng(root, resolved, resultBlob, rawSrc) {
    const dir = dirname(resolved);
    const base = basename(resolved).replace(/\.[^.]+$/, '');
    let newPath;
    try {
      newPath = await uniquePngPath(root, dir, base);
      await writeByPath(root, newPath, resultBlob, {});
    } catch (e) {
      setStatusMessage('画像の保存に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
      return;
    }

    const relNewPath = referenceFor(newPath);
    const hit = rawSrc ? rewriteReference(rawSrc, relNewPath) : false;
    if (hit) {
      setStatusMessage('PNG として保存し、参照を書き換えました(未保存です): ' + newPath);
    } else {
      setStatusMessage(
        'PNG として保存しました: ' + newPath + '(参照が見つからないため、手動で書き換えてください)',
        { isError: true }
      );
    }
    requestRerender();
  }


  function attach() {
    const doc = preview.getDocument();
    const wrapper = preview.getWrapperElement();
    if (!doc || !wrapper) return;
    ensureButton(doc);
    wrapper.addEventListener('mouseover', (e) => {
      const img = e.target.closest && e.target.closest('img[data-src]');
      if (!img) return;
      clearTimeout(hideTimer);
      currentImg = img;
      positionButton(img, doc);
    });
    wrapper.addEventListener('mouseout', (e) => {
      const img = e.target.closest && e.target.closest('img[data-src]');
      if (!img) return;
      if (e.relatedTarget === btn) return;
      scheduleHide();
    });
  }

  return { attach };
}
