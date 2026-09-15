// src/paste-save.js
//
// 画像の保存まわりの純粋なロジック(DOM・CodeMirror に非依存)。
// src/paste.js(CodeMirror への貼り付け・ドロップの配線)から分離してあるのは、
// src/paste.js が src/paste-ui.js(CSS を import する。esbuild でしか読み込めない)を
// 使うようになったため、plain `node --test`(tests/paste.test.js)では
// src/paste.js を直接 import できなくなったから(annotator.js とその
// model.js/shapes.js/pngmeta.js の分け方と同じ考え方)。
//
// - extFromFile / nextImageSerial / saveImageFile: 画像の保存先パス・連番の決め方。
//   `<md のフォルダ>/images/<md名(拡張子なし)>/image-<連番>.<拡張子>` に保存する
//   (MPE と同じ)。連番はフォルダ内の既存の image-<N>.* の最大値 + 1(拡張子が
//   違っても番号は重ねない。途中の番号を消しても再利用しない)。ドロップしたファイルが
//   `xxx.drawio.png` / `xxx.drawio.svg` なら `.drawio` を残して `image-<N>.drawio.png`
//   にする(draw.io で開き直せるファイルだと分かるように)。
// - isDrawioClipboardText: draw.io の通常のコピー(Ctrl+C)が text/plain に入れる
//   図形データ(画像ではない)を見分ける。
// - isImageFile: File/Blob が画像(MIME が image/ で始まる)かどうか。

import { dirname, basename, relativePath } from './fs/paths.js';
import { getDirHandle, writeByPath } from './fs/workspace.js';

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

/**
 * 元のファイル名から拡張子を保つ(`.drawio.png` のような draw.io の二重拡張子も保つ)。
 * 無ければ MIME から推測。それも無ければ .png。
 * @param {{ name?: string, type?: string }} file
 * @returns {string}
 */
export function extFromFile(file) {
  const name = (file && file.name) || '';
  const m = /(\.drawio)?\.[a-z0-9]+$/i.exec(name);
  if (m) return m[0].toLowerCase();
  return EXT_BY_MIME[file && file.type] || '.png';
}

// draw.io の通常のコピー(Ctrl+C)が text/plain に入れる図形データの先頭
// (draw.io の EditorUi.copyCells は encodeURIComponent(xml) を入れる。生の XML も念のため)。
const DRAWIO_TEXT_RE = /^\s*(%3CmxGraphModel|%3Cmxfile|<mxGraphModel|<mxfile)/i;

/** 貼り付けようとしたテキストが draw.io の図形データ(画像ではない)かどうか。 */
export function isDrawioClipboardText(text) {
  return typeof text === 'string' && DRAWIO_TEXT_RE.test(text);
}

/**
 * フォルダ内のファイル名の一覧から、次に使う image-<N> の N を返す
 * (既存の image-<N>.<拡張子> の最大値 + 1。無ければ 1)。`image-3.drawio.png` のような
 * 二重拡張子も数える。大文字小文字は区別しない。
 * @param {Iterable<string>} names
 * @returns {number}
 */
export function nextImageSerial(names) {
  let max = 0;
  for (const name of names) {
    const m = /^image-(\d+)\./i.exec(name);
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

/** File/Blob が画像(MIME が image/ で始まる)かどうか。 */
export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}
