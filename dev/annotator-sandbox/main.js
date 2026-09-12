// dev/annotator-sandbox/main.js
//
// 画像注釈エディタ(src/annotator/annotator.js)を単体で検証するための開発用
// エントリポイント。dev/build-annotator-sandbox.mjs で
// test-output/annotator-sandbox.html に1ファイル化してヘッドレス Chromium から開く。
//
// dev/annotator-harness.mjs は window.__annotator に公開したフックを
// page.evaluate() 経由で呼び出す。実際のツール操作(図形を描く・選択する等)は
// フックを増やさず、モーダルの実 DOM に対して page.mouse / page.click で行う
// (E2E としての実際性を保つため)。フックは「テスト画像の用意」「開く/閉じるの
// 進行状況の確認」「保存結果の検証」など、DOM 操作だけでは完結しない部分に限る。

import { openAnnotator, getAnnotatorDebugState } from '../../src/annotator/annotator.js';

const state = {
  sourceBlob: null,
  lastResult: 'unset', // 'unset' = 一度も保存/キャンセルされていない
  pending: false,
};

// テスト用画像を <canvas> で作って Blob にする(注釈エディタ自体はファイルを
// 読み書きしないので、ここでのテスト画像作成もあくまでテスト用の便宜)
function createTestImageBlob({ format = 'png', width = 800, height = 600, fillColor = '#f0f0f0' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = fillColor;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 50) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 50) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, 0.92));
}

async function getBlobPixel(blob, x, y) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(x, y, 1, 1).data;
  bmp.close();
  return [data[0], data[1], data[2], data[3]];
}

window.__annotator = {
  async createTestImage(opts) {
    state.sourceBlob = await createTestImageBlob(opts);
    return { size: state.sourceBlob.size, type: state.sourceBlob.type };
  },

  // imageBlob として何を渡すか('source' = 直近に作ったテスト画像、
  // 'lastResult' = 直前に保存された PNG)。openAnnotator() 自体の完了は
  // 待たない(モーダルは開いたまま、Node 側がマウス操作をしてから save/cancel する)。
  open(which = 'source') {
    const blob = which === 'lastResult' ? state.lastResult : state.sourceBlob;
    if (!blob || blob === 'unset') throw new Error(`開く対象の Blob がありません: ${which}`);
    state.pending = true;
    openAnnotator({ imageBlob: blob, title: 'テスト画像' }).then((result) => {
      state.lastResult = result;
      state.pending = false;
    });
  },

  isOpen() {
    return document.querySelector('.annotator-overlay') != null;
  },

  isPending() {
    return state.pending;
  },

  getDebugState() {
    return getAnnotatorDebugState();
  },

  getSvgBox() {
    const svg = document.querySelector('.annotator-svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  },

  lastResultWasCancelled() {
    return state.lastResult === null;
  },

  async getLastResultInfo() {
    if (!state.lastResult || state.lastResult === 'unset') return null;
    const bmp = await createImageBitmap(state.lastResult);
    const info = { width: bmp.width, height: bmp.height, byteSize: state.lastResult.size, type: state.lastResult.type };
    bmp.close();
    return info;
  },

  async getLastResultPixel(x, y) {
    if (!state.lastResult || state.lastResult === 'unset') return null;
    return getBlobPixel(state.lastResult, x, y);
  },
};
