// src/paste.js
//
// エディタへの画像の貼り付け・ドロップ(フェーズ4)。
// クリップボードに画像があれば(またはドロップされたファイルが画像であれば)
// MPE(VS Code)と同じく `<md のフォルダ>/images/<md名(拡張子なし)>/image-<連番>.<拡張子>`
// にファイルとして保存し、貼り付け位置(ドロップの場合はドロップした座標)に
// `![](images/<md名>/image-1.png)` を挿入する(base64 の埋め込みはしない。base64 に
// するのは HTML の1ファイル出力のときだけ = src/export.js)。
// 連番はフォルダ内の既存の image-<N>.* の最大値 + 1(拡張子が違っても番号は重ねない。
// 途中の番号を消しても再利用しない)。複数ファイルのドロップは1行ずつ挿入する。
// 保存に失敗したら状態表示にエラーを出す(呼び出し側の setStatusMessage 経由)。
//
// 通常のテキストの貼り付け・ドロップ(画像を含まない場合)は CodeMirror の既定動作に
// そのまま任せる(preventDefault しない)。

import { dirname, basename, relativePath, toMarkdownLinkDest } from './fs/paths.js';
import { getDirHandle, writeByPath } from './fs/workspace.js';

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

// 元のファイル名から拡張子を保つ(無ければ MIME から推測。それも無ければ .png)。
function extFromFile(file) {
  const name = (file && file.name) || '';
  const m = /\.[a-z0-9]+$/i.exec(name);
  if (m) return m[0].toLowerCase();
  return EXT_BY_MIME[file && file.type] || '.png';
}

/**
 * フォルダ内のファイル名の一覧から、次に使う image-<N> の N を返す
 * (既存の image-<N>.<拡張子> の最大値 + 1。無ければ 1)。大文字小文字は区別しない。
 * @param {Iterable<string>} names
 * @returns {number}
 */
export function nextImageSerial(names) {
  let max = 0;
  for (const name of names) {
    const m = /^image-(\d+)\.[^.]+$/i.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

// dirPath(ルート相対)のフォルダ内のファイル名一覧。フォルダが無ければ空。
async function listNames(root, dirPath) {
  let dir;
  try {
    dir = await getDirHandle(root, dirPath, { create: false });
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return [];
    throw e;
  }
  const names = [];
  for await (const entry of dir.values()) names.push(entry.name);
  return names;
}

/**
 * 画像ファイル(File/Blob)を `<md のフォルダ>/images/<md名>/image-<連番>.<拡張子>` に
 * 保存し、書き込んだルート相対パスと、md からの相対参照(`images/<md名>/image-1.png`
 * 形式)を返す。
 * @param {Blob} file
 * @param {{ getRoot: () => any, getMdPath: () => string|null }} deps
 * @returns {Promise<{ path: string, ref: string }>}
 */
export async function saveImageFile(file, { getRoot, getMdPath }) {
  const root = getRoot();
  const mdPath = getMdPath();
  if (!root || !mdPath) throw new Error('ファイルが開かれていません');
  const mdDir = dirname(mdPath);
  const mdBase = basename(mdPath).replace(/\.[^.]+$/, '') || 'untitled';
  const imagesDir = mdDir ? `${mdDir}/images/${mdBase}` : `images/${mdBase}`;
  const ext = extFromFile(file);
  const serial = nextImageSerial(await listNames(root, imagesDir));
  const path = `${imagesDir}/image-${serial}${ext}`;
  await writeByPath(root, path, file, {});
  return { path, ref: relativePath(mdDir, path) };
}

function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

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
  async function insertRefsAtPos(pos, refs) {
    const insertText = refs.map((r) => `![](${toMarkdownLinkDest(r)})`).join('\n') + '\n';
    view.dispatch({
      changes: { from: pos, to: pos, insert: insertText },
      selection: { anchor: pos + insertText.length },
    });
  }

  async function handleFiles(files, pos) {
    const images = Array.from(files).filter(isImageFile);
    if (images.length === 0) return;
    const refs = [];
    for (const file of images) {
      try {
        const { ref } = await saveImageFile(file, { getRoot, getMdPath });
        refs.push(ref);
      } catch (e) {
        setStatusMessage('画像の保存に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
      }
    }
    if (refs.length === 0) return;
    await insertRefsAtPos(pos, refs);
    setStatusMessage(refs.length === 1 ? '画像を保存しました' : `画像を${refs.length}件保存しました`);
  }

  view.dom.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (isImageFile(f)) files.push(f);
      }
    }
    if (files.length === 0) return; // 画像でなければ CodeMirror の既定動作に任せる
    e.preventDefault();
    const pos = view.state.selection.main.from;
    handleFiles(files, pos);
  });

  view.dom.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });

  view.dom.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (!Array.from(files).some(isImageFile)) return; // 画像でなければ既定動作に任せる
    e.preventDefault();
    const coords = view.posAtCoords({ x: e.clientX, y: e.clientY });
    const pos = coords == null ? view.state.selection.main.from : coords;
    handleFiles(files, pos);
  });
}
