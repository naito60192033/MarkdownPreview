// src/export.js
//
// HTML 出力(通常 / 1ファイル、フェーズ6)。プレビュー(iframe)の描画済み DOM
// (mermaid は SVG まで描画済み・画像は blob URL に解決済みのもの)を複製して
// 本文を作る。JavaScript は含めない。
//
// - 通常出力: 画像は data-src(元の相対パス)に戻す。`<md名>.html` を md と同じ
//   フォルダに書く(画像は相対パスのまま参照するので、同じフォルダに置く前提)
// - 1ファイル出力: 画像を FSA で読み直し、base64 の data URI として埋め込む。
//   `<md名>.standalone.html` を同じフォルダに書く。読めなかった画像は元の
//   相対パスのまま残す(呼び出し側で件数を状態表示に出す)
//
// 出力構造: <!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
// <meta name="viewport" ...><title>(最初の h1、無ければファイル名)</title>
// <style>標準 CSS(base.css。設定でオフなら空) + alerts.css + style.css</style></head>
// <body><div class="crossnote markdown-preview">本文</div></body></html>
//
// 書き込みは writeByPath(root, path, html, {})(競合チェックなし。常に上書き)。

import { dirname, basename, joinPath, urlToPath, isExternalUrl } from './fs/paths.js';
import { getFileHandleByPath, writeByPath } from './fs/workspace.js';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// base.css(標準 CSS。オフなら空文字) → alerts.css → style.css の順
// (preview.js の <style> 要素の並びと同じ)。
function buildCss(doc) {
  const ids = ['mdpreview-base-style', 'mdpreview-alerts-style', 'mdpreview-user-style'];
  return ids.map((id) => (doc.getElementById(id) ? doc.getElementById(id).textContent || '' : '')).join('\n');
}

function pickTitle(wrapperEl, mdPath) {
  const h1 = wrapperEl.querySelector('h1');
  if (h1 && h1.textContent.trim()) return h1.textContent.trim();
  return basename(mdPath || '').replace(/\.[^.]+$/, '') || 'Untitled';
}

// アプリ用の要素・属性を取り除いた本文のクローンを作る。mermaid は既に描画済みの
// SVG をそのまま使う(.mermaid-source は取り除く)。画像編集ボタン(親スクリプトが
// iframe の body 直下に置くもの)は #mdpreview-root の外にあるためクローンには
// 含まれない。
function buildBodyClone(wrapperEl) {
  const clone = wrapperEl.cloneNode(true);
  clone.removeAttribute('id');
  for (const el of clone.querySelectorAll('script')) el.remove();
  for (const el of clone.querySelectorAll('.mermaid-source')) el.remove();
  for (const el of clone.querySelectorAll('[data-line]')) el.removeAttribute('data-line');
  return clone;
}

function revertImageSrcToRelative(clone) {
  for (const img of clone.querySelectorAll('img[data-src]')) {
    img.setAttribute('src', img.getAttribute('data-src'));
    img.removeAttribute('data-src');
  }
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
}

// 1ファイル出力用: img[data-src] を data URI に埋め込む。読めなかった件数を返す。
async function inlineImages(clone, { root, mdDir }) {
  let failedCount = 0;
  for (const img of clone.querySelectorAll('img[data-src]')) {
    const raw = img.getAttribute('data-src');
    img.setAttribute('src', raw);
    img.removeAttribute('data-src');
    if (isExternalUrl(raw)) continue; // 外部 URL はそのまま
    const resolved = joinPath(mdDir, urlToPath(raw));
    if (resolved == null) {
      failedCount++;
      continue;
    }
    try {
      const fh = await getFileHandleByPath(root, resolved, { create: false });
      const file = await fh.getFile();
      img.setAttribute('src', await blobToDataUrl(file));
    } catch {
      failedCount++; // 読めなかった画像は元の相対パスのまま残す(既に src に設定済み)
    }
  }
  return failedCount;
}

function composeHtml({ title, css, bodyHtml }) {
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="ja">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>\n${css}\n</style>\n` +
    '</head>\n' +
    '<body>\n' +
    bodyHtml +
    '\n</body>\n' +
    '</html>\n'
  );
}

function outputPath(mdPath, suffix) {
  const dir = dirname(mdPath);
  const base = basename(mdPath).replace(/\.[^.]+$/, '');
  return dir ? `${dir}/${base}${suffix}` : `${base}${suffix}`;
}

/**
 * 通常出力: `<md名>.html` を md と同じフォルダに書く(画像は相対パスのまま参照)。
 * @param {{ root: any, mdPath: string, doc: Document, wrapperEl: HTMLElement }} args
 * @returns {Promise<{ path: string }>}
 */
export async function exportNormal({ root, mdPath, doc, wrapperEl }) {
  const clone = buildBodyClone(wrapperEl);
  revertImageSrcToRelative(clone);
  const html = composeHtml({ title: pickTitle(wrapperEl, mdPath), css: buildCss(doc), bodyHtml: clone.outerHTML });

  const path = outputPath(mdPath, '.html');
  await writeByPath(root, path, html, {});
  return { path };
}

/**
 * 1ファイル出力: 画像を base64 の data URI で埋め込み、`<md名>.standalone.html` を
 * 同じフォルダに書く。
 * @param {{ root: any, mdPath: string, doc: Document, wrapperEl: HTMLElement }} args
 * @returns {Promise<{ path: string, failedImageCount: number }>}
 */
export async function exportStandalone({ root, mdPath, doc, wrapperEl }) {
  const clone = buildBodyClone(wrapperEl);
  const failedImageCount = await inlineImages(clone, { root, mdDir: dirname(mdPath) });
  const html = composeHtml({ title: pickTitle(wrapperEl, mdPath), css: buildCss(doc), bodyHtml: clone.outerHTML });

  const path = outputPath(mdPath, '.standalone.html');
  await writeByPath(root, path, html, {});
  return { path, failedImageCount };
}
