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
import { parseChunks } from '../../src/annotator/pngmeta.js';

const state = {
  sourceBlob: null,
  lastResult: 'unset', // 'unset' = 一度も保存/キャンセルされていない
  pending: false,
};

// crypto.getRandomValues() で高周波なノイズの ImageData を作る(1回あたり65536バイト
// までの制限があるためチャンクに分けて埋める)。Math.random() を8M+ 回呼ぶより大幅に速い。
function createNoiseImageData(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const bytes = new Uint8Array(data.buffer);
  const CHUNK = 65536;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  for (let i = 3; i < bytes.length; i += 4) bytes[i] = 255; // 不透明に統一する
  return new ImageData(data, width, height);
}

// テスト用画像を <canvas> で作って Blob にする(注釈エディタ自体はファイルを
// 読み書きしないので、ここでのテスト画像作成もあくまでテスト用の便宜)。
// noise: true にすると、グラデーション(低周波)+ ランダムノイズ(高周波)を
// 重ねた「圧縮しにくい」画像を作る。4K スクリーンショットのように PNG が
// 数MB以上になるケースを E2E で再現するために使う。
function createTestImageBlob({ format = 'png', width = 800, height = 600, fillColor = '#f0f0f0', noise = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (noise) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#204060');
    gradient.addColorStop(0.5, '#a0c0e0');
    gradient.addColorStop(1, '#302010');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = width;
    noiseCanvas.height = height;
    noiseCanvas.getContext('2d').putImageData(createNoiseImageData(width, height), 0, 0);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(noiseCanvas, 0, 0);
    ctx.globalAlpha = 1;

    // 50%縮小時のアンチエイリアス(imageSmoothingQuality)を確認するための
    // 高コントラストな白黒の境界を右下に置く(ノイズに埋もれないよう上から不透明に塗る)。
    // 境界(x = width-99)をわざと奇数座標にして、50%縮小(2x2ブロック→1px)の
    // ブロック境界とずらしている。偶数座標だとブロック境界と一致してしまい、
    // ちょうど黒/白のどちらかにきれいに分かれてしまうため、縮小アルゴリズムに
    // 関わらず「たまたま」中間色が出ない/出るが起きてしまい、品質の確認にならない。
    // 縦方向の範囲は [height-200, height]。
    // dev/annotator-harness.mjs の「50%出力時の縮小品質」チェックが参照する。
    const qx = width - 200;
    const qy = height - 200;
    ctx.fillStyle = '#000000';
    ctx.fillRect(qx, qy, 101, 200);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(qx + 101, qy, 99, 200);
  } else {
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

  // Node 側(dev/annotator-harness.mjs)で組み立てたバイト列(v1形式の注釈付きPNG等)を
  // base64 で受け取り、そのまま state.sourceBlob にする。マウス操作だけでは用意できない
  // 「開く対象の Blob」を差し替えるためのフック。
  setSourceFromBase64(b64, mime = 'image/png') {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    state.sourceBlob = new Blob([bytes], { type: mime });
    return { size: state.sourceBlob.size };
  },

  // 別の色のテスト画像を作って document に paste イベントとして発火する
  // (2枚目以降の画像追加の入口「貼り付け」のテスト用)。
  async pasteTestImage(opts) {
    const blob = await createTestImageBlob(opts);
    const file = new File([blob], 'pasted.png', { type: blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(evt);
  },

  // 別の色のテスト画像を作って .annotator-overlay に drop イベントとして発火する
  // (2枚目以降の画像追加の入口「ドロップ」のテスト用)。point はクライアント座標。
  async dropTestImage(opts, point) {
    const blob = await createTestImageBlob(opts);
    const file = new File([blob], 'dropped.png', { type: blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const root = document.querySelector('.annotator-overlay');
    const evt = new DragEvent('drop', {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    });
    root.dispatchEvent(evt);
  },

  // 直前の保存結果(PNG)に含まれるチャンク種別の一覧(mdIM の個数を数える等に使う)
  async getLastResultChunkTypes() {
    if (!state.lastResult || state.lastResult === 'unset') return null;
    const bytes = new Uint8Array(await state.lastResult.arrayBuffer());
    return parseChunks(bytes).map((c) => c.type);
  },

  // 直前の保存結果(PNG)を base64 文字列で取り出す(目視確認用にファイルへ書き出す等、
  // ブラウザ外に持ち出す必要がある場合に使う)
  async getLastResultBase64() {
    if (!state.lastResult || state.lastResult === 'unset') return null;
    const bytes = new Uint8Array(await state.lastResult.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
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

  // 複数の座標をまとめてサンプリングする(大きな画像を毎回デコードし直すコストを
  // 避けるため。50%出力時の縮小画質の確認など、複数点を見たいときに使う)
  async getLastResultPixels(points) {
    if (!state.lastResult || state.lastResult === 'unset') return null;
    const bmp = await createImageBitmap(state.lastResult);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const result = points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
    bmp.close();
    return result;
  },
};
