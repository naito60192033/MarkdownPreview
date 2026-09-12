// src/paste.js
//
// エディタへの画像の貼り付け・ドロップ(フェーズ4)。
// クリップボードに画像があれば(またはドロップされたファイルが画像であれば)
// `<md のフォルダ>/images/<md名(拡張子なし)>-YYYYMMDD-HHmmss.<拡張子>` に保存し、
// 貼り付け位置(ドロップの場合はドロップした座標)に `![](images/xxx.png)` を挿入する。
// 同名のファイルが既にあれば `-2`, `-3` を付ける。複数ファイルのドロップは1行ずつ挿入する。
// 保存に失敗したら状態表示にエラーを出す(呼び出し側の setStatusMessage 経由)。
//
// 通常のテキストの貼り付け・ドロップ(画像を含まない場合)は CodeMirror の既定動作に
// そのまま任せる(preventDefault しない)。

import { dirname, basename, relativePath, toMarkdownLinkDest } from './fs/paths.js';
import { getFileHandleByPath, writeByPath } from './fs/workspace.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

// YYYYMMDD-HHmmss 形式のタイムスタンプ文字列。
function timestamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

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

async function pathExists(root, path) {
  try {
    const fh = await getFileHandleByPath(root, path, { create: false });
    await fh.getFile();
    return true;
  } catch {
    return false;
  }
}

// dir/baseName.ext が既にあれば dir/baseName-2.ext, dir/baseName-3.ext ... を試す。
async function uniquePath(root, dir, baseName, ext) {
  let candidate = dir ? `${dir}/${baseName}${ext}` : `${baseName}${ext}`;
  if (!(await pathExists(root, candidate))) return candidate;
  for (let n = 2; ; n++) {
    candidate = dir ? `${dir}/${baseName}-${n}${ext}` : `${baseName}-${n}${ext}`;
    if (!(await pathExists(root, candidate))) return candidate;
  }
}

/**
 * 画像ファイル(File/Blob)を `<md のフォルダ>/images/` に保存し、書き込んだ
 * ルート相対パスと、md からの相対参照(`images/xxx.png` 形式)を返す。
 * @param {Blob} file
 * @param {{ getRoot: () => any, getMdPath: () => string|null }} deps
 * @returns {Promise<{ path: string, ref: string }>}
 */
export async function saveImageFile(file, { getRoot, getMdPath }) {
  const root = getRoot();
  const mdPath = getMdPath();
  if (!root || !mdPath) throw new Error('ファイルが開かれていません');
  const mdDir = dirname(mdPath);
  const imagesDir = mdDir ? `${mdDir}/images` : 'images';
  const mdBase = basename(mdPath).replace(/\.[^.]+$/, '') || 'image';
  const ext = extFromFile(file);
  const path = await uniquePath(root, imagesDir, `${mdBase}-${timestamp()}`, ext);
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
