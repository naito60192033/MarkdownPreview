// src/annotator/annotator.js
//
// 画像注釈エディタ本体。公開 API は openAnnotator() のみ。
// 呼び出し側はファイルの読み書きを行わず、Blob を渡して Blob を受け取るだけにする。
//
//   import { openAnnotator } from './annotator/annotator.js';
//   const blob = await openAnnotator({ imageBlob, title });
//
// 【キャンバスと複数画像】
// 内部的には「無限キャンバス」に複数の画像(st.images[])を自由に配置し、注釈
// (st.shapes[])を重ねる draw.io 風のエディタになっている。画像・図形の座標はすべて
// 「キャンバス座標」(1枚目の画像を (0,0)・等倍に置いた座標系。v1 の「元画像
// ピクセル座標」と同じ意味なので、shapes の座標はそのまま使い回せる)。
// 出力範囲はすべての画像の表示矩形(切り抜き後)と図形の見た目の外枠を囲む最小の
// 矩形(shapes.js の computeOutputBounds)で自動的に決まり、エディタ上には点線で
// 示す。画像が1枚で注釈がその画像の内側に収まっていれば、出力はその画像の表示矩形と
// 一致する(= v1 と同じ結果になる)。
//
// 表示は SVG を表示枠(.annotator-canvas-wrap)いっぱいに固定し、viewBox をカメラ
// (st.camera・st.zoom)として動かすことでパン・ズームを実現する(draw.io / Figma と
// 同じ方式)。画像ごとの切り抜きは、画像ごとの入れ子 <svg viewBox=crop> で表現する
// (パン・ズーム用の外側の viewBox とは別物)。
//
// 【画像の選択・移動・拡大縮小・削除・重なり順(選択ツール)】
// 画像が2枚以上のときだけ、選択ツールで画像自体を選べる(st.selectedImageId。
// 図形の選択 st.selectedShapeId とは排他)。1枚のときは今までどおり画像のクリックは
// 選択解除として扱う(移動しても出力が変わらないため)。当たり判定の優先順位は
// ハンドル → 図形(hitLayer)→ 画像(手前優先)→ 余白(選択解除)。
// 移動はドラッグで x, y を動かすが、画面上で4px未満の移動はうっかりずらし防止のため
// 移動とみなさない(4pxを超えた時点から追従する。startImageMoveDrag)。
// 拡大縮小は四隅のハンドル(data-handle="img-resize-nw" 等)をドラッグし、
// shapes.js の resizeImageFromCorner()(縦横比を保ったまま反対側の角を固定して
// img.scale を変える純粋関数)を使う。削除(Delete/Backspace)は画像が2枚以上の
// ときだけでき、最後の1枚は消せない。「最前面へ/最背面へ」は st.images の並び替え
// (注釈は常に画像より上に描く)。選択ツールで画像を選んだ状態から切り抜きツールに
// 切り替えると、その画像を切り抜き対象(cropTargetId)として引き継ぐ。
//
// 【データ形式(PNG に埋め込む JSON。version 2)】
//   {
//     version: 2,
//     images: [{ id, mime, width, height, x, y, scale, crop: {x,y,w,h} }],
//     shapes: [...],
//     scale,                 // 出力倍率(今までと同じ意味)
//   }
// 元画像のバイト列は画像ごとに独自チャンク mdIM(id + NUL + バイト列)へ格納する
// (pngmeta.js)。v1(1枚の画像のみ・mdOR チャンク)を開いた場合は model.js の
// normalizeLoadedModel() で { images: [1枚], shapes, scale } に変換してから読み込む。
//
// 【吹き出しの文字の大きさ・色】
// ツールバーの「文字」グループで吹き出し(type 'callout')の fontSize・textColor を
// 変更できる(選択肢は FONT_SIZES / TEXT_COLORS)。吹き出しを選択中はその吹き出しに、
// それ以外(未選択・吹き出し以外の図形を選択中)は次に作る吹き出しの既定値に適用する
// (色・線の太さと同じ考え方)。文字色は吹き出し全体が対象で、一部だけ変えることはできない。
//
// 図形の描画(見た目)は shapes.js の buildShapeSvg() にまとめてあり、エディタの
// ライブ表示と出力(PNG 焼き込み)の両方でこの関数だけを使う(描画ロジックの二重化を避ける)。
// PNG チャンクの読み書きは pngmeta.js に任せる(DOM 非依存)。
//
// このファイルは export function getAnnotatorDebugState() という内部/テスト専用の
// 追加エクスポートを持つ。アプリ本体からは使わず、dev/annotator-sandbox 経由の
// E2E テスト(dev/annotator-harness.mjs)がエディタの内部状態を覗くためだけに使う。

import annotatorCss from './annotator.css';
import { isPngBytes, getAnnotationData, setAnnotationData } from './pngmeta.js';
import { normalizeLoadedModel } from './model.js';
import {
  buildShapeSvg,
  getShapeOutlineBox,
  computeArrowEndpoints,
  findAttachTarget,
  computeOutputSize,
  computeOutputBounds,
  imageVisibleRect,
  imageFullRect,
  resizeImageFromCorner,
  computeCalloutBox,
  measureTextWidth,
  normalizeRect,
  SVG_NS,
} from './shapes.js';

// ---------- 定数 ----------
const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#1e88e5', '#43a047', '#000000', '#ffffff'];
const WIDTHS = [2, 4, 6, 8];
const SCALE_PRESETS = [1, 0.75, 0.5];
const DEFAULT_COLOR = '#e53935';
const DEFAULT_WIDTH = 4;
const DEFAULT_CALLOUT_WIDTH = 2;
// 吹き出し(callout)の文字の大きさ・色。TEXT_COLORS のキー(色コード)と表示名の対応は
// TEXT_COLOR_NAMES に持つ(title 属性・ボタンの説明に使う)。
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];
const TEXT_COLORS = ['#222222', '#e53935', '#fb8c00', '#1e88e5', '#43a047'];
const TEXT_COLOR_NAMES = { '#222222': '黒', '#e53935': '赤', '#fb8c00': 'オレンジ', '#1e88e5': '青', '#43a047': '緑' };
const DEFAULT_FONT_SIZE = 24;
const DEFAULT_TEXT_COLOR = '#222222';
const ATTACH_TOLERANCE_SCREEN_PX = 10;
const HANDLE_SCREEN_PX = 8;
const MIN_DRAW_SIZE_IMAGE_PX = 3;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const FIT_MARGIN_SCREEN_PX = 24;
const WHEEL_ZOOM_SENSITIVITY = 0.0015; // Ctrl+ホイール1notch(deltaY≈100)あたり約15%ズーム
const NEW_IMAGE_GAP_CANVAS_PX = 24;
const IMAGE_MOVE_THRESHOLD_SCREEN_PX = 4; // 画面上でこの距離未満の移動は「うっかりずらし」とみなし追従しない
const MIN_IMAGE_DISPLAY_SIZE_CANVAS_PX = 16; // 画像の拡大縮小: 表示矩形の一辺がこれを下回らないようにする
// 出力サイズの上限(超えたら保存を止めて出力倍率を下げるよう案内する)
const MAX_OUTPUT_DIMENSION_PX = 16384;
const MAX_OUTPUT_AREA_PX = 100_000_000; // 1億ピクセル

// ---------- スタイルの挿入(1度だけ) ----------
let styleInjected = false;
function ensureStyleInjected() {
  if (styleInjected) return;
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-annotator-style', '');
  styleEl.textContent = annotatorCss;
  document.head.appendChild(styleEl);
  styleInjected = true;
}

// ---------- 公開 API ----------

/**
 * 画像注釈エディタを全画面モーダルで開く。
 * imageBlob: PNG/JPEG 等の画像。既にこのエディタで保存した PNG(チャンク入り)なら
 *            画像の配置・図形を復元して再編集できる状態で開く。
 * title: モーダル上部に表示する任意のタイトル文字列。
 * 戻り値: 保存したら注釈を焼き込んだ PNG の Blob、キャンセルなら null。
 */
export function openAnnotator({ imageBlob, title = '' } = {}) {
  ensureStyleInjected();
  return loadInitialState(imageBlob).then(
    (initial) =>
      new Promise((resolve) => {
        const inst = createInstance(initial, title, resolve);
        document.body.appendChild(inst.root);
        inst.init();
        currentInstance = inst; // テスト用フックから参照できるようにする
      })
  );
}

// getAnnotatorDebugState() から参照する「現在開いているインスタンス」(無ければ null)。
// 複数同時に開くことは想定していない(常に全画面モーダルのため)。
let currentInstance = null;

/**
 * [内部/テスト専用] 現在開いている注釈エディタの状態を覗くためのフック。
 * アプリ本体のコードからは使わないこと。E2E(dev/annotator-harness.mjs)専用。
 */
export function getAnnotatorDebugState() {
  if (!currentInstance) return null;
  const st = currentInstance.state;
  const bounds = computeOutputBounds(st.images, st.shapes, measureTextWidth);
  const cropTarget = getCropTarget(st);
  return {
    images: st.images.map((img) => ({ ...img, crop: { ...img.crop } })),
    outputBounds: { ...bounds },
    camera: { ...st.camera },
    zoom: st.zoom,
    scale: st.scale,
    shapes: st.shapes.map((s) => ({ ...s })),
    activeTool: st.activeTool,
    selectedShapeId: st.selectedShapeId,
    selectedImageId: st.selectedImageId,
    cropTargetId: cropTarget ? cropTarget.id : null,
    historyIndex: st.historyIndex,
    historyLength: st.history.length,
  };
}

// ---------- 初期状態の読み込み(画像・チャンクの復元) ----------

function guessMimeFromBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (isPngBytes(bytes)) return 'image/png';
  return 'image/png';
}

// src(blob URL / data URL のいずれでも可)を Image として読み込む
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    img.src = src;
  });
}

async function loadImageDimensions(src) {
  const img = await loadImageElement(src);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

// 普通の画像(注釈データを持たない、または壊れている/欠けている)として開く。
async function loadAsPlainImage(bytes, blobType) {
  const mime = blobType || guessMimeFromBytes(bytes);
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  let dims;
  try {
    dims = await loadImageDimensions(objectUrl);
  } catch (e) {
    URL.revokeObjectURL(objectUrl);
    throw e;
  }
  const id = 'i1';
  return {
    images: [
      { id, mime, width: dims.width, height: dims.height, x: 0, y: 0, scale: 1, crop: { x: 0, y: 0, w: dims.width, h: dims.height } },
    ],
    imageSources: new Map([[id, { bytes, mime, objectUrl }]]),
    shapes: [],
    scale: 1,
  };
}

// normalizeLoadedModel() が返した内部モデルを実際に読み込む。画像ごとのバイト列を
// blob URL にして実寸を確認し、1枚でも欠けている・実寸が JSON と食い違うものが
// あれば null を返す(呼び出し側は「注釈なしの普通の画像」として開き直す)。
async function tryLoadNormalizedModel(normalized, parsed) {
  const imageSources = new Map();
  const objectUrls = [];
  const fail = () => {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    return null;
  };
  for (const img of normalized.images) {
    const srcBytes = normalized.source === 'v1' ? parsed.originalBytes : parsed.imageBytes.get(img.id);
    if (!srcBytes) return fail();
    const mime = img.mime || guessMimeFromBytes(srcBytes);
    const objectUrl = URL.createObjectURL(new Blob([srcBytes], { type: mime }));
    objectUrls.push(objectUrl);
    let dims;
    try {
      dims = await loadImageDimensions(objectUrl);
    } catch {
      return fail();
    }
    if (dims.width !== img.width || dims.height !== img.height) return fail();
    imageSources.set(img.id, { bytes: srcBytes, mime, objectUrl });
  }
  return {
    images: normalized.images.map((img) => ({ ...img, mime: img.mime || imageSources.get(img.id).mime, crop: { ...img.crop } })),
    imageSources,
    shapes: normalized.shapes,
    scale: normalized.scale,
  };
}

async function loadInitialState(imageBlob) {
  const bytes = new Uint8Array(await imageBlob.arrayBuffer());
  if (isPngBytes(bytes)) {
    const parsed = getAnnotationData(bytes);
    const normalized = parsed.json ? normalizeLoadedModel(parsed.json) : null;
    if (normalized) {
      const loaded = await tryLoadNormalizedModel(normalized, parsed);
      if (loaded) return loaded;
    }
  }
  return loadAsPlainImage(bytes, imageBlob.type);
}

// data URL(base64)化。通常は blob URL を使うため呼ばないが、blob URL 経由の
// <img> が万一 canvas を汚染してしまった場合の出力用フォールバックとして使う
// (renderOutputPng 参照)。
function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function bytesToDataUrl(bytes, mime) {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function cloneShape(shape) {
  return JSON.parse(JSON.stringify(shape));
}

function cloneImageMeta(img) {
  return { ...img, crop: { ...img.crop } };
}

function cloneModel(st) {
  return { images: st.images.map(cloneImageMeta), shapes: st.shapes.map(cloneShape), scale: st.scale };
}

function modelJson(st) {
  return JSON.stringify(cloneModel(st));
}

// ---------- インスタンスの生成 ----------

function createInstance(initial, title, resolve) {
  const st = {
    images: initial.images,
    imageSources: initial.imageSources, // Map<id, {bytes, mime, objectUrl}>。履歴に入れない
    shapes: initial.shapes,
    scale: initial.scale,
    camera: { x: 0, y: 0 }, // init() の fitToOutputBounds で実際の値になる
    zoom: 1,
    history: [],
    historyIndex: -1,
    activeTool: 'select',
    currentColor: DEFAULT_COLOR,
    currentStrokeWidth: DEFAULT_WIDTH,
    currentFontSize: DEFAULT_FONT_SIZE,
    currentTextColor: DEFAULT_TEXT_COLOR,
    selectedShapeId: null,
    selectedImageId: null, // 画像が2枚以上のときだけ選択ツールで選べる(selectedShapeIdとは排他)
    editingShapeId: null,
    editingOriginalText: null, // openTextEditor で開いた時点の文字列(commitPendingTextEdit の変更判定用)
    cropTargetId: null, // 2枚以上のときに切り抜きツールで明示的に選んだ画像(ツール切替で解除)
    nextIdCounter: initial.shapes.reduce((max, s) => {
      const n = Number(String(s.id).replace(/^s/, ''));
      return Number.isFinite(n) ? Math.max(max, n + 1) : max;
    }, 1),
    nextImageIdCounter: initial.images.reduce((max, img) => {
      const n = Number(String(img.id).replace(/^i/, ''));
      return Number.isFinite(n) ? Math.max(max, n + 1) : max;
    }, 1),
    resolvePromise: resolve,
  };

  const dom = buildDom(title);
  const inst = { root: dom.root, state: st, dom, imageElements: new Map(), cropDraft: null };
  wireEvents(inst);

  st.initialSnapshotJson = null; // init() 内で最初の render 後に確定させる

  inst.init = () => {
    pushHistory(inst, { replaceInitial: true });
    st.initialSnapshotJson = modelJson(st);
    fitToOutputBounds(inst);
    render(inst);
    // アプリではプレビューの iframe 内のボタンから開くため、フォーカスが iframe に
    // 残ったままだとキー操作(Delete/Undo等)や貼り付けが overlay に届かない
    inst.root.focus();
    inst.resizeObserver = new ResizeObserver(() => render(inst));
    inst.resizeObserver.observe(inst.dom.wrap);
  };
  return inst;
}

// ---------- DOM 構築 ----------

function buildDom(title) {
  const root = document.createElement('div');
  root.className = 'annotator-overlay';
  root.tabIndex = -1;

  const toolbar = document.createElement('div');
  toolbar.className = 'annotator-toolbar';
  toolbar.appendChild(buildToolGroup());
  toolbar.appendChild(buildImageGroup());
  toolbar.appendChild(buildColorGroup());
  toolbar.appendChild(buildWidthGroup());
  toolbar.appendChild(buildTextGroup());
  toolbar.appendChild(buildScaleGroup());
  toolbar.appendChild(buildHistoryGroup());
  toolbar.appendChild(buildZoomGroup());
  toolbar.appendChild(buildEndGroup(title));
  root.appendChild(toolbar);

  const wrap = document.createElement('div');
  wrap.className = 'annotator-canvas-wrap';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'annotator-svg');
  svg.setAttribute('xmlns', SVG_NS);

  // レイヤー順(背面→前面): 出力範囲の背景 → 画像 → 出力範囲の点線 → 図形 →
  // 当たり判定 → 切り抜きUI → 選択UI。注釈(図形)は常に画像より上に描かれる。
  const outputBgEl = document.createElementNS(SVG_NS, 'rect');
  outputBgEl.setAttribute('class', 'annotator-output-bg');
  svg.appendChild(outputBgEl);

  const imageLayer = document.createElementNS(SVG_NS, 'g');
  imageLayer.setAttribute('class', 'annotator-image-layer');
  svg.appendChild(imageLayer);

  const outputBoundaryEl = document.createElementNS(SVG_NS, 'rect');
  outputBoundaryEl.setAttribute('class', 'annotator-output-boundary');
  svg.appendChild(outputBoundaryEl);

  const shapesLayer = document.createElementNS(SVG_NS, 'g');
  shapesLayer.setAttribute('class', 'annotator-shapes-layer');
  svg.appendChild(shapesLayer);

  const hitLayer = document.createElementNS(SVG_NS, 'g');
  hitLayer.setAttribute('class', 'annotator-hit-layer');
  svg.appendChild(hitLayer);

  const cropLayer = document.createElementNS(SVG_NS, 'g');
  cropLayer.setAttribute('class', 'annotator-crop-layer');
  svg.appendChild(cropLayer);

  const selectionLayer = document.createElementNS(SVG_NS, 'g');
  selectionLayer.setAttribute('class', 'annotator-selection-layer');
  svg.appendChild(selectionLayer);

  wrap.appendChild(svg);

  const textEditor = document.createElement('textarea');
  textEditor.className = 'annotator-text-editor';
  textEditor.style.display = 'none';
  wrap.appendChild(textEditor);

  root.appendChild(wrap);

  return {
    root,
    toolbar,
    wrap,
    svg,
    outputBgEl,
    imageLayer,
    outputBoundaryEl,
    shapesLayer,
    hitLayer,
    cropLayer,
    selectionLayer,
    textEditor,
    toolButtons: Array.from(toolbar.querySelectorAll('[data-tool]')),
    colorButtons: Array.from(toolbar.querySelectorAll('[data-color]')),
    widthButtons: Array.from(toolbar.querySelectorAll('[data-width]')),
    fontSizeSelect: toolbar.querySelector('.annotator-font-size'),
    textColorButtons: Array.from(toolbar.querySelectorAll('[data-text-color]')),
    scaleButtons: Array.from(toolbar.querySelectorAll('[data-scale]')),
    scaleCustomInput: toolbar.querySelector('.annotator-scale-custom'),
    outputSizeLabel: toolbar.querySelector('.annotator-output-size'),
    addImageBtn: toolbar.querySelector('[data-action="addImage"]'),
    fileInput: toolbar.querySelector('.annotator-file-input'),
    bringToFrontBtn: toolbar.querySelector('[data-action="bringToFront"]'),
    sendToBackBtn: toolbar.querySelector('[data-action="sendToBack"]'),
    undoBtn: toolbar.querySelector('[data-action="undo"]'),
    redoBtn: toolbar.querySelector('[data-action="redo"]'),
    resetCropBtn: toolbar.querySelector('[data-action="resetCrop"]'),
    zoomInBtn: toolbar.querySelector('[data-action="zoomIn"]'),
    zoomOutBtn: toolbar.querySelector('[data-action="zoomOut"]'),
    fitBtn: toolbar.querySelector('[data-action="fit"]'),
    zoomLabel: toolbar.querySelector('.annotator-zoom-label'),
    saveBtn: toolbar.querySelector('[data-action="save"]'),
    cancelBtn: toolbar.querySelector('[data-action="cancel"]'),
  };
}

function buildToolGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'ツール');
  const tools = [
    ['select', '選択 (V)'],
    ['rect', '赤枠 (R)'],
    ['arrow', '矢印 (A)'],
    ['callout', '吹き出し (T)'],
    ['crop', '切り抜き (C)'],
  ];
  for (const [tool, label] of tools) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annotator-tool-btn';
    btn.dataset.tool = tool;
    btn.setAttribute('aria-pressed', 'false');
    btn.title = label;
    btn.textContent = label;
    group.appendChild(btn);
  }
  return group;
}

function buildImageGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'annotator-icon-btn';
  addBtn.dataset.action = 'addImage';
  addBtn.title = '画像を追加';
  addBtn.textContent = '画像を追加';
  group.appendChild(addBtn);

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.className = 'annotator-file-input';
  group.appendChild(input);

  // 重なり順(画像を選択中のときだけ有効。updateToolbar で disabled を切り替える)
  const frontBtn = document.createElement('button');
  frontBtn.type = 'button';
  frontBtn.className = 'annotator-icon-btn';
  frontBtn.dataset.action = 'bringToFront';
  frontBtn.title = '最前面へ';
  frontBtn.textContent = '最前面へ';
  group.appendChild(frontBtn);

  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'annotator-icon-btn';
  backBtn.dataset.action = 'sendToBack';
  backBtn.title = '最背面へ';
  backBtn.textContent = '最背面へ';
  group.appendChild(backBtn);

  return group;
}

function buildColorGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  group.setAttribute('aria-label', '色');
  for (const color of COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annotator-color-btn';
    btn.dataset.color = color;
    btn.setAttribute('aria-pressed', 'false');
    btn.style.background = color;
    btn.title = color;
    group.appendChild(btn);
  }
  return group;
}

function buildWidthGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  group.setAttribute('aria-label', '線の太さ');
  for (const w of WIDTHS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annotator-width-btn';
    btn.dataset.width = String(w);
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = String(w);
    group.appendChild(btn);
  }
  return group;
}

// 吹き出しの文字の大きさ・色。選択中の吹き出し(未選択時は次に作る吹き出しの既定)に適用する。
function buildTextGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  group.setAttribute('aria-label', '文字');

  const label = document.createElement('span');
  label.className = 'annotator-text-group-label';
  label.textContent = '文字';
  group.appendChild(label);

  const select = document.createElement('select');
  select.className = 'annotator-font-size';
  select.title = '文字の大きさ';
  for (const size of FONT_SIZES) {
    const opt = document.createElement('option');
    opt.value = String(size);
    opt.textContent = `${size}px`;
    select.appendChild(opt);
  }
  group.appendChild(select);

  for (const color of TEXT_COLORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annotator-text-color-btn';
    btn.dataset.textColor = color;
    btn.setAttribute('aria-pressed', 'false');
    btn.style.color = color;
    btn.title = `文字の色: ${TEXT_COLOR_NAMES[color] || color}`;
    btn.textContent = 'A';
    group.appendChild(btn);
  }
  return group;
}

function buildScaleGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  group.setAttribute('aria-label', '出力倍率');
  for (const s of SCALE_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'annotator-scale-btn';
    btn.dataset.scale = String(s);
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = `${Math.round(s * 100)}%`;
    group.appendChild(btn);
  }
  const custom = document.createElement('input');
  custom.type = 'number';
  custom.className = 'annotator-scale-custom';
  custom.min = '1';
  custom.max = '1000';
  custom.step = '1';
  custom.title = '任意の倍率(%)';
  group.appendChild(custom);

  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'annotator-output-size';
  group.appendChild(sizeLabel);
  return group;
}

function buildHistoryGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'annotator-icon-btn';
  undoBtn.dataset.action = 'undo';
  undoBtn.title = '元に戻す (Ctrl+Z)';
  undoBtn.textContent = '元に戻す';
  group.appendChild(undoBtn);

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'annotator-icon-btn';
  redoBtn.dataset.action = 'redo';
  redoBtn.title = 'やり直し (Ctrl+Y)';
  redoBtn.textContent = 'やり直し';
  group.appendChild(redoBtn);

  const resetCropBtn = document.createElement('button');
  resetCropBtn.type = 'button';
  resetCropBtn.className = 'annotator-icon-btn';
  resetCropBtn.dataset.action = 'resetCrop';
  resetCropBtn.title = '切り抜きを対象画像の全体に戻す';
  resetCropBtn.textContent = '切り抜き解除';
  group.appendChild(resetCropBtn);
  return group;
}

function buildZoomGroup() {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group';
  const outBtn = document.createElement('button');
  outBtn.type = 'button';
  outBtn.className = 'annotator-icon-btn';
  outBtn.dataset.action = 'zoomOut';
  outBtn.textContent = '縮小';
  group.appendChild(outBtn);

  const label = document.createElement('span');
  label.className = 'annotator-zoom-label';
  label.textContent = '100%';
  group.appendChild(label);

  const inBtn = document.createElement('button');
  inBtn.type = 'button';
  inBtn.className = 'annotator-icon-btn';
  inBtn.dataset.action = 'zoomIn';
  inBtn.textContent = '拡大';
  group.appendChild(inBtn);

  const fitBtn = document.createElement('button');
  fitBtn.type = 'button';
  fitBtn.className = 'annotator-icon-btn';
  fitBtn.dataset.action = 'fit';
  fitBtn.title = '全体表示';
  fitBtn.textContent = '全体表示';
  group.appendChild(fitBtn);
  return group;
}

function buildEndGroup(title) {
  const group = document.createElement('div');
  group.className = 'annotator-tool-group annotator-tool-group--end';
  if (title) {
    const titleEl = document.createElement('span');
    titleEl.className = 'annotator-title';
    titleEl.textContent = title;
    group.appendChild(titleEl);
  }
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'annotator-icon-btn';
  cancelBtn.dataset.action = 'cancel';
  cancelBtn.textContent = 'キャンセル';
  group.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'annotator-primary-btn';
  saveBtn.dataset.action = 'save';
  saveBtn.textContent = '保存';
  group.appendChild(saveBtn);
  return group;
}

// ---------- ズーム・パン(無限キャンバス) ----------

function clampNum(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

// 出力範囲(画像+図形すべて)が収まる倍率(最大100%)で中央に表示する「全体表示」。
// 開いた直後・画像を追加した直後にこの状態にする。
function fitToOutputBounds(inst) {
  const st = inst.state;
  const { wrap } = inst.dom;
  const bounds = computeOutputBounds(st.images, st.shapes, measureTextWidth);
  const wrapW = Math.max(1, wrap.clientWidth);
  const wrapH = Math.max(1, wrap.clientHeight);
  const availW = Math.max(1, wrapW - FIT_MARGIN_SCREEN_PX * 2);
  const availH = Math.max(1, wrapH - FIT_MARGIN_SCREEN_PX * 2);
  const zoom = Math.min(1, availW / Math.max(bounds.w, 1), availH / Math.max(bounds.h, 1));
  st.zoom = clampNum(zoom, MIN_ZOOM, MAX_ZOOM);
  const viewW = wrapW / st.zoom;
  const viewH = wrapH / st.zoom;
  st.camera = {
    x: bounds.x + bounds.w / 2 - viewW / 2,
    y: bounds.y + bounds.h / 2 - viewH / 2,
  };
}

// 表示中央のキャンバス座標を固定したままズームする(拡大/縮小ボタン用)
function setZoomKeepCenter(inst, newZoom) {
  const st = inst.state;
  const { wrap } = inst.dom;
  const wrapW = Math.max(1, wrap.clientWidth);
  const wrapH = Math.max(1, wrap.clientHeight);
  const centerX = st.camera.x + wrapW / st.zoom / 2;
  const centerY = st.camera.y + wrapH / st.zoom / 2;
  const zoom = clampNum(newZoom, MIN_ZOOM, MAX_ZOOM);
  st.zoom = zoom;
  st.camera = { x: centerX - wrapW / zoom / 2, y: centerY - wrapH / zoom / 2 };
  render(inst);
}

// ホイール: 上下パン(Shift併用で左右)、Ctrl(⌘)併用でカーソル位置を固定してズーム
function onWheel(inst, e) {
  e.preventDefault();
  const st = inst.state;
  if (e.ctrlKey || e.metaKey) {
    const rect = inst.dom.svg.getBoundingClientRect();
    const canvasPt = clientToCanvasPoint(inst, e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
    const newZoom = clampNum(st.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    st.zoom = newZoom;
    st.camera = { x: canvasPt.x - sx / newZoom, y: canvasPt.y - sy / newZoom };
  } else {
    // Shift+ホイールで左右にパンする(トラックパッド等、shift保持時に deltaY へ
    // 値が入ったままのブラウザ向けに deltaX が0ならフォールバックする)
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    st.camera = { x: st.camera.x + dx / st.zoom, y: st.camera.y + dy / st.zoom };
  }
  render(inst);
}

// 中ボタンドラッグでのパン(画面上の移動量をそのままカメラに反映する)
function startPanDrag(inst, startClientX, startClientY) {
  const st = inst.state;
  const startCam = { ...st.camera };
  const move = (e) => {
    const dx = (e.clientX - startClientX) / st.zoom;
    const dy = (e.clientY - startClientY) / st.zoom;
    st.camera = { x: startCam.x - dx, y: startCam.y - dy };
    render(inst);
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ---------- 座標変換 ----------

// クライアント座標 → キャンバス座標(カメラ・ズームを考慮)
function clientToCanvasPoint(inst, clientX, clientY) {
  const rect = inst.dom.svg.getBoundingClientRect();
  const { zoom, camera } = inst.state;
  return {
    x: camera.x + (clientX - rect.left) / zoom,
    y: camera.y + (clientY - rect.top) / zoom,
  };
}

// キャンバス座標 → 画像固有のピクセル座標(切り抜き操作は対象画像のピクセル座標で行う)
function canvasPointToImagePx(img, pt) {
  return { x: (pt.x - img.x) / img.scale, y: (pt.y - img.y) / img.scale };
}

// 画像固有のピクセル座標の矩形 → キャンバス座標の矩形
function imagePxRectToCanvasRect(img, r) {
  return { x: img.x + r.x * img.scale, y: img.y + r.y * img.scale, w: r.w * img.scale, h: r.h * img.scale };
}

// キャンバス座標の点にある画像を探す(重なり順の手前=配列の後ろから探す)。
// 切り抜きツールで2枚目以降をクリックして対象にするときに使う。
function findImageAtPoint(st, pt) {
  for (let i = st.images.length - 1; i >= 0; i--) {
    const img = st.images[i];
    const rect = imageVisibleRect(img);
    if (pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h) return img;
  }
  return null;
}

// 現在の切り抜き対象画像。画像が1枚ならそれ、2枚以上なら明示的に選んだもの(無ければ null)
function getCropTarget(st) {
  if (st.images.length === 1) return st.images[0];
  if (st.cropTargetId) return st.images.find((i) => i.id === st.cropTargetId) || null;
  return null;
}

// ---------- 履歴(元に戻す/やり直し) ----------

function pushHistory(inst, { replaceInitial = false } = {}) {
  const st = inst.state;
  const snapshot = cloneModel(st);
  if (replaceInitial) {
    st.history = [snapshot];
    st.historyIndex = 0;
    return;
  }
  st.history = st.history.slice(0, st.historyIndex + 1);
  st.history.push(snapshot);
  st.historyIndex = st.history.length - 1;
}

function applyHistorySnapshot(inst, snapshot) {
  const st = inst.state;
  st.images = snapshot.images.map(cloneImageMeta);
  st.scale = snapshot.scale;
  st.shapes = snapshot.shapes.map(cloneShape);
  if (st.selectedShapeId && !st.shapes.some((s) => s.id === st.selectedShapeId)) {
    st.selectedShapeId = null;
  }
  if (st.selectedImageId && !st.images.some((i) => i.id === st.selectedImageId)) {
    st.selectedImageId = null;
  }
  if (st.cropTargetId && !st.images.some((i) => i.id === st.cropTargetId)) {
    st.cropTargetId = null;
  }
}

function undo(inst) {
  const st = inst.state;
  if (st.historyIndex <= 0) return;
  commitPendingTextEdit(inst);
  st.historyIndex -= 1;
  applyHistorySnapshot(inst, st.history[st.historyIndex]);
  render(inst);
}

function redo(inst) {
  const st = inst.state;
  if (st.historyIndex >= st.history.length - 1) return;
  commitPendingTextEdit(inst);
  st.historyIndex += 1;
  applyHistorySnapshot(inst, st.history[st.historyIndex]);
  render(inst);
}

// ---------- 図形 ID ----------

function genShapeId(st) {
  return 's' + st.nextIdCounter++;
}

function shapesById(st) {
  const map = {};
  for (const s of st.shapes) map[s.id] = s;
  return map;
}

// 図形削除時: この図形に接続している矢印の端点を、現在の描画座標を残して attach=null にする
function detachArrowsPointingTo(st, shapeId) {
  const map = shapesById(st);
  for (const s of st.shapes) {
    if (s.type !== 'arrow') continue;
    const { from, to } = computeArrowEndpoints(s, map);
    if (s.from.attach === shapeId) {
      s.from = { x: from.x, y: from.y, attach: null };
    }
    if (s.to.attach === shapeId) {
      s.to = { x: to.x, y: to.y, attach: null };
    }
  }
}

function deleteSelectedShape(inst) {
  const st = inst.state;
  if (!st.selectedShapeId) return;
  commitPendingTextEdit(inst);
  const id = st.selectedShapeId;
  detachArrowsPointingTo(st, id);
  st.shapes = st.shapes.filter((s) => s.id !== id);
  st.selectedShapeId = null;
  pushHistory(inst);
  render(inst);
}

// 選択中の画像を削除する(2枚以上のときだけ。最後の1枚は消せない)。
// imageSources のバイト列はここでは消さない(閉じるまで保持し、元に戻すで復活できるようにする)。
function deleteSelectedImage(inst) {
  const st = inst.state;
  if (!st.selectedImageId) return;
  if (st.images.length <= 1) return; // 最後の1枚は削除できない
  const id = st.selectedImageId;
  st.images = st.images.filter((img) => img.id !== id);
  st.selectedImageId = null;
  if (st.cropTargetId === id) st.cropTargetId = null;
  pushHistory(inst);
  render(inst);
}

// 選択中の画像の重なり順を変える(注釈は常に画像より上に描かれるため、
// st.images 配列内の並び替えだけでよい)。
function reorderSelectedImage(inst, where) {
  const st = inst.state;
  if (!st.selectedImageId) return;
  const idx = st.images.findIndex((img) => img.id === st.selectedImageId);
  if (idx === -1) return;
  // 既に最前面/最背面なら何もしない(元に戻すが空振りする履歴を積まない)
  if ((where === 'front' && idx === st.images.length - 1) || (where !== 'front' && idx === 0)) return;
  const [img] = st.images.splice(idx, 1);
  if (where === 'front') st.images.push(img);
  else st.images.unshift(img);
  pushHistory(inst);
  render(inst);
}

// ---------- 画像の追加 ----------

// blob を画像として読み込み、st.images の末尾に追加する(重なり順は常に最前面)。
// canvasPoint があればその点が画像の中心、無ければ現在の出力範囲の右隣(24px空け、
// 上端を揃える)に置く。画像として読めなければ okOnly の確認ダイアログを出す。
async function addImageFromBlob(inst, blob, canvasPoint = null) {
  const st = inst.state;
  let bytes;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    await showConfirm(inst, '画像として読み込めませんでした', { okOnly: true });
    return;
  }
  const mime = blob.type || guessMimeFromBytes(bytes);
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  let dims;
  try {
    dims = await loadImageDimensions(objectUrl);
  } catch {
    URL.revokeObjectURL(objectUrl);
    await showConfirm(inst, '画像として読み込めませんでした', { okOnly: true });
    return;
  }

  const id = 'i' + st.nextImageIdCounter++;
  let x;
  let y;
  if (canvasPoint) {
    x = canvasPoint.x - dims.width / 2;
    y = canvasPoint.y - dims.height / 2;
  } else if (st.images.length === 0) {
    x = 0;
    y = 0;
  } else {
    const bounds = computeOutputBounds(st.images, st.shapes, measureTextWidth);
    x = bounds.x + bounds.w + NEW_IMAGE_GAP_CANVAS_PX;
    y = bounds.y;
  }

  st.images.push({ id, mime, width: dims.width, height: dims.height, x, y, scale: 1, crop: { x: 0, y: 0, w: dims.width, h: dims.height } });
  st.imageSources.set(id, { bytes, mime, objectUrl });
  pushHistory(inst);
  fitToOutputBounds(inst);
  render(inst);
}

// ---------- レンダリング ----------

function setSvgAttrs(el, attrs) {
  for (const key in attrs) el.setAttribute(key, String(attrs[key]));
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  setSvgAttrs(el, attrs);
  return el;
}

function render(inst) {
  const st = inst.state;
  const { wrap, svg, outputBgEl, outputBoundaryEl, shapesLayer, hitLayer, cropLayer, selectionLayer } = inst.dom;

  const wrapW = Math.max(1, Math.round(wrap.clientWidth));
  const wrapH = Math.max(1, Math.round(wrap.clientHeight));
  svg.setAttribute('width', String(wrapW));
  svg.setAttribute('height', String(wrapH));
  svg.setAttribute('viewBox', `${st.camera.x} ${st.camera.y} ${wrapW / st.zoom} ${wrapH / st.zoom}`);
  svg.setAttribute('data-tool', st.activeTool);

  const bounds = computeOutputBounds(st.images, st.shapes, measureTextWidth);
  setSvgAttrs(outputBgEl, { x: bounds.x, y: bounds.y, width: Math.max(bounds.w, 0), height: Math.max(bounds.h, 0) });
  setSvgAttrs(outputBoundaryEl, { x: bounds.x, y: bounds.y, width: Math.max(bounds.w, 0), height: Math.max(bounds.h, 0) });

  renderImageLayer(inst);

  const map = shapesById(st);
  const drawList = st.draftShape ? [...st.shapes, st.draftShape] : st.shapes;

  clearChildren(shapesLayer);
  clearChildren(hitLayer);
  for (const shape of drawList) {
    shapesLayer.appendChild(buildShapeSvg(document, shape, map, { measureFn: measureTextWidth }));
    if (shape.id) hitLayer.appendChild(buildHitArea(shape, map));
  }

  clearChildren(cropLayer);
  renderCropLayer(inst);

  clearChildren(selectionLayer);
  renderSelectionLayer(inst);

  updateToolbar(inst, bounds);
}

// 画像ごとの入れ子 <svg data-image-id>[<image>] を id をキーに使い回して更新する。
// render() はマウス移動のたびに呼ばれるため、4K画像等の要素をここで毎回作り直すと
// ちらつき・負荷の原因になる(href の再設定だけなら再デコードは発生しない)。
function renderImageLayer(inst) {
  const st = inst.state;
  const { imageLayer } = inst.dom;
  const cropTarget = getCropTarget(st);
  const seen = new Set();
  for (const img of st.images) {
    seen.add(img.id);
    let entry = inst.imageElements.get(img.id);
    if (!entry) {
      const nestedSvg = document.createElementNS(SVG_NS, 'svg');
      nestedSvg.setAttribute('data-image-id', img.id);
      nestedSvg.setAttribute('preserveAspectRatio', 'none');
      const imageEl = document.createElementNS(SVG_NS, 'image');
      nestedSvg.appendChild(imageEl);
      entry = { svg: nestedSvg, image: imageEl };
      inst.imageElements.set(img.id, entry);
    }
    // 切り抜きツールで対象になっている画像だけ、切り抜き前の全体を表示する
    // (外側を暗くする演出は cropLayer 側で行う)。それ以外は切り抜き後の見た目のまま。
    const showFull = st.activeTool === 'crop' && cropTarget && cropTarget.id === img.id;
    const rect = showFull ? imageFullRect(img) : imageVisibleRect(img);
    const vb = showFull ? { x: 0, y: 0, w: img.width, h: img.height } : img.crop;
    setSvgAttrs(entry.svg, {
      x: rect.x,
      y: rect.y,
      width: Math.max(rect.w, 0),
      height: Math.max(rect.h, 0),
      viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`,
    });
    entry.image.setAttribute('width', String(img.width));
    entry.image.setAttribute('height', String(img.height));
    const source = st.imageSources.get(img.id);
    if (source) entry.image.setAttribute('href', source.objectUrl);
    imageLayer.appendChild(entry.svg); // 常に末尾へ付け替えることで配列順=重なり順を保つ
  }
  for (const [id, entry] of inst.imageElements) {
    if (seen.has(id)) continue;
    if (entry.svg.parentNode) entry.svg.parentNode.removeChild(entry.svg);
    inst.imageElements.delete(id);
  }
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function buildHitArea(shape, map) {
  if (shape.type === 'rect' || shape.type === 'callout') {
    const box = getShapeOutlineBox(shape, measureTextWidth);
    const g = svgEl('rect', { x: box.x, y: box.y, width: Math.max(box.w, 1), height: Math.max(box.h, 1) });
    g.setAttribute('class', 'annotator-hit-area');
    g.setAttribute('data-shape-id', shape.id);
    return g;
  }
  if (shape.type === 'arrow') {
    const { from, to } = computeArrowEndpoints(shape, map, measureTextWidth);
    const line = svgEl('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, 'stroke-width': Math.max(20, (shape.strokeWidth || 4) + 16) });
    line.setAttribute('class', 'annotator-hit-area');
    line.setAttribute('data-shape-id', shape.id);
    line.style.stroke = 'transparent';
    return line;
  }
  return svgEl('g', {});
}

function renderCropLayer(inst) {
  const st = inst.state;
  const { cropLayer } = inst.dom;
  if (st.activeTool !== 'crop') return;
  const target = getCropTarget(st);
  if (!target) return; // 2枚以上でまだ対象を選んでいない

  const full = { x: 0, y: 0, w: target.width, h: target.height };
  const crop = inst.cropDraft || target.crop;
  const toCanvas = (r) => imagePxRectToCanvasRect(target, r);

  // crop の外側を暗くする(4枚の矩形で crop の周囲を覆う。対象画像のピクセル座標で
  // 計算してからキャンバス座標に変換する)
  const rects = [
    { x: 0, y: 0, w: full.w, h: crop.y },
    { x: 0, y: crop.y + crop.h, w: full.w, h: full.h - (crop.y + crop.h) },
    { x: 0, y: crop.y, w: crop.x, h: crop.h },
    { x: crop.x + crop.w, y: crop.y, w: full.w - (crop.x + crop.w), h: crop.h },
  ];
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    const cr = toCanvas(r);
    const el = svgEl('rect', { x: cr.x, y: cr.y, width: cr.w, height: cr.h });
    el.setAttribute('class', 'annotator-crop-dim');
    cropLayer.appendChild(el);
  }
  const boundaryCanvas = toCanvas(crop);
  const boundary = svgEl('rect', { x: boundaryCanvas.x, y: boundaryCanvas.y, width: boundaryCanvas.w, height: boundaryCanvas.h });
  boundary.setAttribute('class', 'annotator-crop-boundary');
  cropLayer.appendChild(boundary);

  const hp = HANDLE_SCREEN_PX / st.zoom;
  const points = cropHandlePoints(crop);
  for (const p of points) {
    const cp = toCanvas({ x: p.x, y: p.y, w: 0, h: 0 });
    const handle = svgEl('rect', { x: cp.x - hp / 2, y: cp.y - hp / 2, width: hp, height: hp });
    handle.setAttribute('class', 'annotator-handle');
    handle.setAttribute('data-handle', p.name);
    cropLayer.appendChild(handle);
  }
}

function cropHandlePoints(crop) {
  const { x, y, w, h } = crop;
  return [
    { name: 'nw', x, y },
    { name: 'n', x: x + w / 2, y },
    { name: 'ne', x: x + w, y },
    { name: 'e', x: x + w, y: y + h / 2 },
    { name: 'se', x: x + w, y: y + h },
    { name: 's', x: x + w / 2, y: y + h },
    { name: 'sw', x, y: y + h },
    { name: 'w', x, y: y + h / 2 },
  ];
}

function renderSelectionLayer(inst) {
  const st = inst.state;
  const { selectionLayer } = inst.dom;
  const hp = HANDLE_SCREEN_PX / st.zoom;

  if (st.selectedImageId) {
    const img = st.images.find((i) => i.id === st.selectedImageId);
    if (!img) return;
    const rect = imageVisibleRect(img);
    const outline = svgEl('rect', { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    outline.setAttribute('class', 'annotator-selection-outline');
    selectionLayer.appendChild(outline);
    const corners = [
      { name: 'nw', x: rect.x, y: rect.y },
      { name: 'ne', x: rect.x + rect.w, y: rect.y },
      { name: 'sw', x: rect.x, y: rect.y + rect.h },
      { name: 'se', x: rect.x + rect.w, y: rect.y + rect.h },
    ];
    for (const c of corners) {
      const handle = svgEl('rect', { x: c.x - hp / 2, y: c.y - hp / 2, width: hp, height: hp });
      handle.setAttribute('class', 'annotator-handle');
      handle.setAttribute('data-handle', 'img-resize-' + c.name);
      selectionLayer.appendChild(handle);
    }
    return;
  }

  if (!st.selectedShapeId) return;
  const shape = st.shapes.find((s) => s.id === st.selectedShapeId);
  if (!shape) return;
  const map = shapesById(st);

  if (shape.type === 'rect' || shape.type === 'callout') {
    const box = getShapeOutlineBox(shape, measureTextWidth);
    const outline = svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h });
    outline.setAttribute('class', 'annotator-selection-outline');
    selectionLayer.appendChild(outline);

    if (shape.type === 'rect') {
      const corners = [
        { name: 'nw', x: box.x, y: box.y },
        { name: 'ne', x: box.x + box.w, y: box.y },
        { name: 'sw', x: box.x, y: box.y + box.h },
        { name: 'se', x: box.x + box.w, y: box.y + box.h },
      ];
      for (const c of corners) {
        const handle = svgEl('rect', { x: c.x - hp / 2, y: c.y - hp / 2, width: hp, height: hp });
        handle.setAttribute('class', 'annotator-handle');
        handle.setAttribute('data-handle', 'resize-' + c.name);
        selectionLayer.appendChild(handle);
      }
    } else {
      // callout: しっぽの先端ハンドル
      const tail = shape.tail;
      if (tail) {
        const handle = svgEl('circle', { cx: tail.x, cy: tail.y, r: hp / 2 });
        handle.setAttribute('class', 'annotator-handle annotator-handle-tail');
        handle.setAttribute('data-handle', 'tail');
        selectionLayer.appendChild(handle);
      }
    }
  } else if (shape.type === 'arrow') {
    const { from, to } = computeArrowEndpoints(shape, map, measureTextWidth);
    for (const [name, pt] of [['from', from], ['to', to]]) {
      const handle = svgEl('circle', { cx: pt.x, cy: pt.y, r: hp / 2 });
      handle.setAttribute('class', 'annotator-handle');
      handle.setAttribute('data-handle', 'arrow-' + name);
      selectionLayer.appendChild(handle);
    }
  }
}

// ---------- ツールバー表示の更新 ----------

function updateToolbar(inst, boundsArg) {
  const st = inst.state;
  const { dom } = inst;
  for (const btn of dom.toolButtons) {
    btn.setAttribute('aria-pressed', String(btn.dataset.tool === st.activeTool));
  }

  const selected = st.selectedShapeId ? st.shapes.find((s) => s.id === st.selectedShapeId) : null;
  const effectiveColor = selected ? selected.stroke : st.currentColor;
  const effectiveWidth = selected ? selected.strokeWidth : st.currentStrokeWidth;
  for (const btn of dom.colorButtons) {
    btn.setAttribute('aria-pressed', String(btn.dataset.color === effectiveColor));
  }
  for (const btn of dom.widthButtons) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.width) === effectiveWidth));
  }

  // 文字の大きさ・色は選択中が吹き出しのときだけその値、それ以外は次に作る吹き出しの既定値
  const selectedCallout = selected && selected.type === 'callout' ? selected : null;
  const effectiveFontSize = selectedCallout ? selectedCallout.fontSize : st.currentFontSize;
  const effectiveTextColor = selectedCallout ? selectedCallout.textColor : st.currentTextColor;
  if (document.activeElement !== dom.fontSizeSelect) {
    dom.fontSizeSelect.value = String(effectiveFontSize);
  }
  for (const btn of dom.textColorButtons) {
    btn.setAttribute('aria-pressed', String(btn.dataset.textColor === effectiveTextColor));
  }

  for (const btn of dom.scaleButtons) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.scale) === st.scale));
  }
  if (document.activeElement !== dom.scaleCustomInput) {
    dom.scaleCustomInput.value = String(Math.round(st.scale * 100));
  }
  const bounds = boundsArg || computeOutputBounds(st.images, st.shapes, measureTextWidth);
  const outSize = computeOutputSize(bounds, st.scale);
  dom.outputSizeLabel.textContent = `出力: ${outSize.width} × ${outSize.height} px`;

  dom.undoBtn.disabled = st.historyIndex <= 0;
  dom.redoBtn.disabled = st.historyIndex >= st.history.length - 1;
  dom.resetCropBtn.disabled = !getCropTarget(st);
  dom.bringToFrontBtn.disabled = !st.selectedImageId;
  dom.sendToBackBtn.disabled = !st.selectedImageId;

  dom.zoomLabel.textContent = `${Math.round(st.zoom * 100)}%`;
}

// ---------- テキスト編集(吹き出し) ----------

// 吹き出しの枠(computeCalloutBox)に合わせて textarea の位置・大きさを計算し直す。
// 開くとき(openTextEditor)と、入力中に枠を追従させるとき(textEditor の input
// イベント)の両方から呼ぶことで、位置・大きさの計算ロジックを二重に持たないようにする。
// キャンバスは無限スクロール(カメラ)方式のため、位置は wrap のスクロール量ではなく
// カメラ(st.camera)を基準に計算する。
function layoutTextEditor(inst, shape) {
  const st = inst.state;
  const { textEditor, svg, wrap } = inst.dom;
  const box = computeCalloutBox(shape, measureTextWidth);
  const svgRect = svg.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const zoom = st.zoom;
  const cam = st.camera;

  // キャレットが右端で見切れないようフォント1文字分だけ余裕を持たせ、
  // 文字が空でも掴んで編集できるよう最小幅(フォントサイズの4倍)を確保する
  const extraWidth = box.fontSize;
  const minWidth = box.fontSize * 4;
  const editorWidth = Math.max(box.w + extraWidth, minWidth);

  textEditor.style.left = `${svgRect.left - wrapRect.left + (box.x - cam.x) * zoom}px`;
  textEditor.style.top = `${svgRect.top - wrapRect.top + (box.y - cam.y) * zoom}px`;
  textEditor.style.width = `${editorWidth * zoom}px`;
  textEditor.style.height = `${box.h * zoom}px`;
  textEditor.style.fontSize = `${box.fontSize * zoom}px`;
  textEditor.style.lineHeight = `${box.lineHeight * zoom}px`;
  textEditor.style.padding = `${box.padding * zoom}px`;
  textEditor.style.color = shape.textColor || '#222222';
}

function openTextEditor(inst, shape) {
  commitPendingTextEdit(inst);
  const st = inst.state;
  st.editingShapeId = shape.id;
  st.editingOriginalText = shape.text || ''; // commitPendingTextEdit で「実際に変更したか」を判定するために保持する
  const { textEditor } = inst.dom;
  textEditor.style.display = 'block';
  textEditor.value = shape.text || '';
  layoutTextEditor(inst, shape);
  textEditor.focus();
  textEditor.select();
}

function commitPendingTextEdit(inst) {
  const st = inst.state;
  if (!st.editingShapeId) return;
  const shape = st.shapes.find((s) => s.id === st.editingShapeId);
  const { textEditor } = inst.dom;
  const newText = textEditor.value;
  const originalText = st.editingOriginalText;
  // state のクリアを textEditor.blur() より先に行う。blur() は同期的に 'blur' イベントを
  // 発火し(wireEvents 参照)、このハンドラ自身が再入するが、その時点で editingShapeId が
  // 既に null なら先頭の early return で何もしない(display:none による非同期的な blur を
  // 待つと、直後の Enter/F2 判定(onKeyDown の isTyping)がまだ textarea にフォーカスが
  // 残っていると誤判定することがあるため、明示的に blur() して同期的に確定させる)
  st.editingShapeId = null;
  st.editingOriginalText = null;
  textEditor.blur();
  textEditor.style.display = 'none';
  if (shape) {
    shape.text = newText;
    // input イベントで shape.text は既にライブ反映済みなので、ここで shape.text と
    // 比べると常に一致してしまい履歴が積まれなくなる。編集開始時の文字列
    // (originalText)と比べることで「実際に変更したか」を判定する
    if (originalText !== newText) {
      pushHistory(inst);
    }
  }
}

// ---------- 図形の作成(既定値) ----------

function newRect(st, x, y) {
  return { id: genShapeId(st), type: 'rect', x, y, w: 0, h: 0, stroke: st.currentColor, strokeWidth: st.currentStrokeWidth };
}

function newArrow(st, x, y) {
  return {
    id: genShapeId(st),
    type: 'arrow',
    from: { x, y, attach: null },
    to: { x, y, attach: null },
    stroke: st.currentColor,
    strokeWidth: st.currentStrokeWidth,
  };
}

function newCallout(st, tailX, tailY, boxX, boxY) {
  return {
    id: genShapeId(st),
    type: 'callout',
    x: boxX,
    y: boxY,
    text: '',
    tail: { x: tailX, y: tailY },
    stroke: st.currentColor,
    strokeWidth: DEFAULT_CALLOUT_WIDTH,
    fill: '#ffffff',
    textColor: st.currentTextColor,
    fontSize: st.currentFontSize,
  };
}

// ---------- マウス操作 ----------

// ツールを切り替える(ツールバーのボタン・'C'キー等のショートカットの両方から呼ぶ)。
// 選択ツールで画像を選んだ状態(selectedImageId)から切り抜きツールに切り替えた場合だけ、
// その画像を切り抜き対象(cropTargetId)として引き継ぐ。それ以外はツールを切り替えたら
// 選択・切り抜き対象を解除する(選択は選択ツール専用の概念のため)。
function setActiveTool(inst, tool) {
  commitPendingTextEdit(inst);
  const st = inst.state;
  const previousSelectedImageId = st.selectedImageId;
  st.activeTool = tool;
  st.selectedShapeId = null;
  st.selectedImageId = null;
  st.cropTargetId = tool === 'crop' && previousSelectedImageId ? previousSelectedImageId : null;
  inst.cropDraft = null;
  render(inst);
}

function wireEvents(inst) {
  const { dom } = inst;

  for (const btn of dom.toolButtons) {
    btn.addEventListener('click', () => setActiveTool(inst, btn.dataset.tool));
  }
  for (const btn of dom.colorButtons) {
    btn.addEventListener('click', () => {
      applyColorChoice(inst, btn.dataset.color);
    });
  }
  for (const btn of dom.widthButtons) {
    btn.addEventListener('click', () => {
      applyWidthChoice(inst, Number(btn.dataset.width));
    });
  }
  dom.fontSizeSelect.addEventListener('change', () => {
    applyFontSizeChoice(inst, Number(dom.fontSizeSelect.value));
    inst.root.focus(); // select にフォーカスが残ったままだと以降のキー操作(Delete等)が効かないため
  });
  for (const btn of dom.textColorButtons) {
    btn.addEventListener('click', () => {
      applyTextColorChoice(inst, btn.dataset.textColor);
    });
  }
  for (const btn of dom.scaleButtons) {
    btn.addEventListener('click', () => {
      inst.state.scale = Number(btn.dataset.scale);
      pushHistory(inst);
      render(inst);
    });
  }
  dom.scaleCustomInput.addEventListener('change', () => {
    const pct = Number(dom.scaleCustomInput.value);
    if (Number.isFinite(pct) && pct > 0) {
      inst.state.scale = pct / 100;
      pushHistory(inst);
      render(inst);
    }
  });

  dom.addImageBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', async () => {
    const files = Array.from(dom.fileInput.files || []);
    dom.fileInput.value = ''; // 同じファイルを続けて選び直せるようにする
    for (const f of files) {
      await addImageFromBlob(inst, f, null);
    }
  });
  dom.bringToFrontBtn.addEventListener('click', () => reorderSelectedImage(inst, 'front'));
  dom.sendToBackBtn.addEventListener('click', () => reorderSelectedImage(inst, 'back'));

  dom.undoBtn.addEventListener('click', () => undo(inst));
  dom.redoBtn.addEventListener('click', () => redo(inst));
  dom.resetCropBtn.addEventListener('click', () => {
    const target = getCropTarget(inst.state);
    if (!target) return; // 対象が無ければ無効
    target.crop = { x: 0, y: 0, w: target.width, h: target.height };
    pushHistory(inst);
    render(inst);
  });
  dom.zoomInBtn.addEventListener('click', () => setZoomKeepCenter(inst, inst.state.zoom * 1.25));
  dom.zoomOutBtn.addEventListener('click', () => setZoomKeepCenter(inst, inst.state.zoom * 0.8));
  dom.fitBtn.addEventListener('click', () => {
    fitToOutputBounds(inst);
    render(inst);
  });

  dom.saveBtn.addEventListener('click', () => handleSave(inst));
  dom.cancelBtn.addEventListener('click', () => handleCancel(inst));

  dom.textEditor.addEventListener('blur', () => commitPendingTextEdit(inst));

  // 入力中に吹き出しの枠(テキストに合わせて自動計算されるサイズ)を追従させる。
  // render() は shapesLayer/hitLayer を作り直すだけで dom.textEditor 自体は
  // 作り直さないため、この中で render() を呼んでもフォーカスは失われない。
  dom.textEditor.addEventListener('input', () => {
    const st = inst.state;
    if (!st.editingShapeId) return;
    const shape = st.shapes.find((s) => s.id === st.editingShapeId);
    if (!shape) return;
    shape.text = dom.textEditor.value; // 履歴は積まない(確定は commitPendingTextEdit で行う)
    render(inst);
    layoutTextEditor(inst, shape);
  });

  // 吹き出しのダブルクリックでのテキスト編集開始は dblclick イベントではなく
  // onCanvasMouseDown 内で mousedown の e.detail を見て判定する(理由は
  // onCanvasMouseDown のコメント参照)。
  dom.svg.addEventListener('mousedown', (e) => onCanvasMouseDown(inst, e));
  dom.svg.addEventListener('wheel', (e) => onWheel(inst, e), { passive: false });

  // ドロップ: overlay 全体で dragover/drop を preventDefault し、ブラウザが
  // ファイルを開いてしまうのを防ぐ。画像ファイルならドロップ位置(キャンバス座標)に追加する。
  inst.root.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  inst.root.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const imageFiles = files.filter((f) => f.type && f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const pt = clientToCanvasPoint(inst, e.clientX, e.clientY);
    // 1つずつ順に(await して)追加する。並行して追加すると、どれも「追加前の
    // 出力範囲」を見て位置を決めてしまい重なってしまうため。1枚目だけドロップ位置を
    // 中心にし、2枚目以降は addImageFromBlob の既定どおり直前に追加した画像の右隣になる。
    for (let i = 0; i < imageFiles.length; i++) {
      await addImageFromBlob(inst, imageFiles[i], i === 0 ? pt : null);
    }
  });

  // 貼り付け: エディタが開いている間、document への paste で画像があれば追加する。
  // 吹き出しの文字編集中は textarea の通常の貼り付け(テキスト)を邪魔しない。
  inst._pasteHandler = (e) => {
    if (inst.state.editingShapeId) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const imageItem = Array.from(items).find((it) => it.type && it.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (file) addImageFromBlob(inst, file, null);
  };
  document.addEventListener('paste', inst._pasteHandler);

  inst._keydownHandler = (e) => onKeyDown(inst, e);
  document.addEventListener('keydown', inst._keydownHandler);
}

function applyColorChoice(inst, color) {
  const st = inst.state;
  if (st.selectedImageId) return; // 画像の選択中は色ボタンは何もしない
  const shape = st.selectedShapeId ? st.shapes.find((s) => s.id === st.selectedShapeId) : null;
  if (shape) {
    shape.stroke = color;
    pushHistory(inst);
  } else {
    st.currentColor = color;
  }
  render(inst);
}

function applyWidthChoice(inst, width) {
  const st = inst.state;
  if (st.selectedImageId) return; // 画像の選択中は線の太さボタンは何もしない
  const shape = st.selectedShapeId ? st.shapes.find((s) => s.id === st.selectedShapeId) : null;
  if (shape) {
    shape.strokeWidth = width;
    pushHistory(inst);
  } else {
    st.currentStrokeWidth = width;
  }
  render(inst);
}

// 文字の大きさ・色は吹き出し(callout)だけが持つ値のため、選択中の図形が吹き出しの
// ときだけその図形に適用する(rect・arrow を選択中は色・線の太さと違い対象外)。
function applyFontSizeChoice(inst, fontSize) {
  const st = inst.state;
  if (st.selectedImageId) return; // 画像の選択中は何もしない
  const shape = st.selectedShapeId ? st.shapes.find((s) => s.id === st.selectedShapeId) : null;
  if (shape && shape.type === 'callout') {
    if (shape.fontSize !== fontSize) {
      shape.fontSize = fontSize;
      pushHistory(inst);
    }
  } else {
    st.currentFontSize = fontSize;
  }
  render(inst);
}

function applyTextColorChoice(inst, textColor) {
  const st = inst.state;
  if (st.selectedImageId) return; // 画像の選択中は何もしない
  const shape = st.selectedShapeId ? st.shapes.find((s) => s.id === st.selectedShapeId) : null;
  if (shape && shape.type === 'callout') {
    if (shape.textColor !== textColor) {
      shape.textColor = textColor;
      pushHistory(inst);
    }
  } else {
    st.currentTextColor = textColor;
  }
  render(inst);
}

function onKeyDown(inst, e) {
  if (!document.body.contains(inst.dom.root)) return; // 既に閉じている
  const active = document.activeElement;
  const isTyping = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.tagName === 'SELECT');

  if (e.key === 'Escape') {
    if (inst.state.editingShapeId) {
      commitPendingTextEdit(inst);
    } else {
      inst.state.selectedShapeId = null;
      inst.state.selectedImageId = null;
    }
    render(inst);
    return;
  }

  if (isTyping) return;

  if (e.key === 'Enter' || e.key === 'F2') {
    const shape = inst.state.selectedShapeId ? inst.state.shapes.find((s) => s.id === inst.state.selectedShapeId) : null;
    if (shape && shape.type === 'callout') {
      e.preventDefault(); // 既定動作のままだと textarea にフォーカスが移った直後に改行が入力されてしまう
      openTextEditor(inst, shape);
      return;
    }
  }

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo(inst);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    redo(inst);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (inst.state.selectedImageId) {
      deleteSelectedImage(inst);
    } else {
      deleteSelectedShape(inst);
    }
    return;
  }
  const toolKeys = { v: 'select', r: 'rect', a: 'arrow', t: 'callout', c: 'crop' };
  const tool = toolKeys[e.key.toLowerCase()];
  if (tool) {
    setActiveTool(inst, tool);
  }
}

function onCanvasMouseDown(inst, e) {
  if (e.button === 1) {
    // 中ボタンドラッグ = パン(どのツールでも使える)
    e.preventDefault();
    startPanDrag(inst, e.clientX, e.clientY);
    return;
  }
  if (e.button !== 0) return;
  commitPendingTextEdit(inst);
  const st = inst.state;
  const pt = clientToCanvasPoint(inst, e.clientX, e.clientY);
  const handleName = e.target.dataset && e.target.dataset.handle;
  const shapeTarget = e.target.closest && e.target.closest('[data-shape-id]');

  if (st.activeTool === 'select') {
    if (handleName) {
      if (handleName.startsWith('img-resize-') && st.selectedImageId) {
        startImageResizeDrag(inst, handleName, pt);
      } else {
        startHandleDrag(inst, handleName, pt);
      }
      return;
    }
    if (shapeTarget) {
      const id = shapeTarget.dataset.shapeId;
      const shape = st.shapes.find((s) => s.id === id);
      // 吹き出しのダブルクリックでのテキスト編集開始は、dblclick イベントではなく
      // ここ(mousedown の e.detail)で判定する。render() は mousedown のたびに
      // hitLayer の当たり判定要素を全部作り直すため、マウスを押した要素が
      // mouseup 前に DOM から外れてしまい、Chromium は click / dblclick を
      // 発火しない。一方 mousedown の e.detail(1→2)は正しく積算されるため、
      // これで代用する。
      if (shape && shape.type === 'callout' && e.detail >= 2) {
        e.preventDefault(); // 既定動作でフォーカスが textarea から外れて即 blur → commit してしまうのを防ぐ
        st.selectedShapeId = id;
        st.selectedImageId = null; // 図形の選択と画像の選択は排他
        render(inst);
        openTextEditor(inst, shape);
        return;
      }
      st.selectedShapeId = id;
      st.selectedImageId = null;
      startMoveDrag(inst, shape, pt);
      render(inst);
      return;
    }
    // 画像は2枚以上のときだけ選択できる(1枚のときは今までどおり選択解除扱い。
    // 移動しても出力が変わらないため)。当たり判定は手前(配列の後ろ)から探す。
    if (st.images.length >= 2) {
      const clicked = findImageAtPoint(st, pt);
      if (clicked) {
        st.selectedShapeId = null;
        st.selectedImageId = clicked.id;
        startImageMoveDrag(inst, clicked, pt);
        render(inst);
        return;
      }
    }
    // 画像1枚だけのときの画像クリック・余白のクリックは選択解除として扱う
    st.selectedShapeId = null;
    st.selectedImageId = null;
    render(inst);
    return;
  }

  if (st.activeTool === 'rect') {
    startDrawRect(inst, pt);
    return;
  }
  if (st.activeTool === 'arrow') {
    startDrawArrow(inst, pt);
    return;
  }
  if (st.activeTool === 'callout') {
    startDrawCallout(inst, pt);
    return;
  }
  if (st.activeTool === 'crop') {
    const target = getCropTarget(st);
    if (!target) {
      // 2枚以上でまだ対象が決まっていない: クリックした画像を対象にする
      // (このクリックでは切り抜き枠を描き始めない)
      const clicked = findImageAtPoint(st, pt);
      if (clicked) {
        st.cropTargetId = clicked.id;
        render(inst);
      }
      return;
    }
    const imgPt = canvasPointToImagePx(target, pt);
    if (handleName) {
      startCropHandleDrag(inst, target, handleName, imgPt);
      return;
    }
    const crop = target.crop;
    const isFullImage =
      crop.x <= 0.001 && crop.y <= 0.001 && Math.abs(crop.w - target.width) <= 0.001 && Math.abs(crop.h - target.height) <= 0.001;
    const inside = imgPt.x >= crop.x && imgPt.x <= crop.x + crop.w && imgPt.y >= crop.y && imgPt.y <= crop.y + crop.h;
    // crop がまだ画像全体のまま(何も切り抜いていない)なら、クリックした場所に
    // 関わらず常に新規の切り抜き矩形を描き始める(そうしないと「全体を動かす」
    // 操作しかできなくなってしまうため)。既に部分的な crop があるときだけ、
    // その内側のクリックを「移動」として扱う。
    if (!isFullImage && inside) {
      startCropMoveDrag(inst, target, imgPt);
    } else {
      startCropDraw(inst, target, imgPt);
    }
  }
}

function withWindowDragListeners(inst, onMove, onUp) {
  const move = (e) => onMove(clientToCanvasPoint(inst, e.clientX, e.clientY), e);
  const up = (e) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    onUp(clientToCanvasPoint(inst, e.clientX, e.clientY), e);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// crop 操作専用: クライアント座標を対象画像固有のピクセル座標に変換してから渡す
function withImageDragListeners(inst, target, onMove, onUp) {
  const toImagePx = (clientX, clientY) => canvasPointToImagePx(target, clientToCanvasPoint(inst, clientX, clientY));
  const move = (e) => onMove(toImagePx(e.clientX, e.clientY), e);
  const up = (e) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    onUp(toImagePx(e.clientX, e.clientY), e);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ---- 選択ツール: 移動 ----
function startMoveDrag(inst, shape, startPt) {
  if (!shape) return;
  const startShape = cloneShape(shape);
  withWindowDragListeners(
    inst,
    (pt) => {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      applyMove(shape, startShape, dx, dy);
      render(inst);
    },
    (pt) => {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      applyMove(shape, startShape, dx, dy);
      // 実際には動いていない(選択するだけの)クリックでは履歴を汚さない
      if (dx !== 0 || dy !== 0) {
        pushHistory(inst);
      }
      render(inst);
    }
  );
}

function applyMove(shape, startShape, dx, dy) {
  if (shape.type === 'rect' || shape.type === 'callout') {
    shape.x = startShape.x + dx;
    shape.y = startShape.y + dy;
    if (shape.type === 'callout' && startShape.tail) {
      shape.tail = { x: startShape.tail.x + dx, y: startShape.tail.y + dy };
    }
  } else if (shape.type === 'arrow') {
    if (!startShape.from.attach) shape.from = { ...startShape.from, x: startShape.from.x + dx, y: startShape.from.y + dy };
    if (!startShape.to.attach) shape.to = { ...startShape.to, x: startShape.to.x + dx, y: startShape.to.y + dy };
  }
}

// ---- 選択ツール: 画像の移動(2枚以上のときだけ呼ばれる) ----
// 画面上で IMAGE_MOVE_THRESHOLD_SCREEN_PX 未満の移動は「うっかりずらし」とみなし、
// 画像を動かさない(4pxを超えた時点から追従する)。pt は withWindowDragListeners が
// 渡すキャンバス座標なので、画面px換算は st.zoom を掛けて行う(パン・ズームは
// ドラッグ中に変化しない前提)。
function startImageMoveDrag(inst, img, startPt) {
  const st = inst.state;
  const startImg = cloneImageMeta(img);
  let moved = false;
  const apply = (pt) => {
    const dx = pt.x - startPt.x;
    const dy = pt.y - startPt.y;
    const screenDist = Math.hypot(dx, dy) * st.zoom;
    if (!moved && screenDist < IMAGE_MOVE_THRESHOLD_SCREEN_PX) return false;
    moved = true;
    img.x = startImg.x + dx;
    img.y = startImg.y + dy;
    return true;
  };
  withWindowDragListeners(
    inst,
    (pt) => {
      apply(pt);
      render(inst);
    },
    (pt) => {
      apply(pt);
      if (moved) pushHistory(inst); // 実際に動いたときだけ履歴を積む
      render(inst);
    }
  );
}

// ---- 選択ツール: 画像の拡大縮小(四隅のハンドル。縦横比を保ったまま反対側の角を固定する) ----
function startImageResizeDrag(inst, handleName, startPt) {
  const st = inst.state;
  const img = st.images.find((i) => i.id === st.selectedImageId);
  if (!img) return;
  const corner = handleName.replace('img-resize-', '');
  const startImg = cloneImageMeta(img);
  withWindowDragListeners(
    inst,
    (pt) => {
      Object.assign(img, resizeImageFromCorner(startImg, corner, pt, MIN_IMAGE_DISPLAY_SIZE_CANVAS_PX));
      render(inst);
    },
    (pt) => {
      Object.assign(img, resizeImageFromCorner(startImg, corner, pt, MIN_IMAGE_DISPLAY_SIZE_CANVAS_PX));
      // ハンドルを押しただけ(大きさが変わっていない)なら履歴を積まない
      if (img.scale !== startImg.scale || img.x !== startImg.x || img.y !== startImg.y) pushHistory(inst);
      render(inst);
    }
  );
}

// ---- 選択ツール: rect のリサイズ / 矢印の端点 / 吹き出しのしっぽ ----
function startHandleDrag(inst, handleName, startPt) {
  const st = inst.state;
  const shape = st.shapes.find((s) => s.id === st.selectedShapeId);
  if (!shape) return;
  const startShape = cloneShape(shape);

  if (handleName.startsWith('resize-') && shape.type === 'rect') {
    const corner = handleName.replace('resize-', '');
    withWindowDragListeners(
      inst,
      (pt) => {
        applyResize(shape, startShape, corner, pt);
        render(inst);
      },
      (pt) => {
        applyResize(shape, startShape, corner, pt);
        normalizeShapeRect(shape);
        pushHistory(inst);
        render(inst);
      }
    );
    return;
  }

  if (handleName.startsWith('arrow-') && shape.type === 'arrow') {
    const which = handleName === 'arrow-from' ? 'from' : 'to';
    withWindowDragListeners(
      inst,
      (pt) => {
        shape[which] = { x: pt.x, y: pt.y, attach: null };
        render(inst);
      },
      (pt) => {
        const others = st.shapes.filter((s) => s.id !== shape.id);
        const tolerance = ATTACH_TOLERANCE_SCREEN_PX / st.zoom;
        const attachId = findAttachTarget(pt, others, tolerance, measureTextWidth);
        shape[which] = { x: pt.x, y: pt.y, attach: attachId };
        pushHistory(inst);
        render(inst);
      }
    );
    return;
  }

  if (handleName === 'tail' && shape.type === 'callout') {
    withWindowDragListeners(
      inst,
      (pt) => {
        shape.tail = { x: pt.x, y: pt.y };
        render(inst);
      },
      (pt) => {
        shape.tail = { x: pt.x, y: pt.y };
        pushHistory(inst);
        render(inst);
      }
    );
  }
}

function applyResize(shape, startShape, corner, pt) {
  let { x, y, w, h } = startShape;
  const right = x + w;
  const bottom = y + h;
  if (corner.includes('w')) {
    w = right - pt.x;
    x = pt.x;
  }
  if (corner.includes('e')) {
    w = pt.x - x;
  }
  if (corner.includes('n')) {
    h = bottom - pt.y;
    y = pt.y;
  }
  if (corner.includes('s')) {
    h = pt.y - y;
  }
  shape.x = x;
  shape.y = y;
  shape.w = w;
  shape.h = h;
}

function normalizeShapeRect(shape) {
  const n = normalizeRect(shape);
  shape.x = n.x;
  shape.y = n.y;
  shape.w = n.w;
  shape.h = n.h;
}

// ---- rect / arrow / callout の新規作成 ----
function startDrawRect(inst, startPt) {
  const st = inst.state;
  const draft = newRect(st, startPt.x, startPt.y);
  st.draftShape = draft;
  withWindowDragListeners(
    inst,
    (pt) => {
      draft.w = pt.x - startPt.x;
      draft.h = pt.y - startPt.y;
      render(inst);
    },
    (pt) => {
      draft.w = pt.x - startPt.x;
      draft.h = pt.y - startPt.y;
      st.draftShape = null;
      const n = normalizeRect(draft);
      if (n.w < MIN_DRAW_SIZE_IMAGE_PX || n.h < MIN_DRAW_SIZE_IMAGE_PX) {
        render(inst);
        return;
      }
      draft.x = n.x;
      draft.y = n.y;
      draft.w = n.w;
      draft.h = n.h;
      st.shapes.push(draft);
      st.selectedShapeId = draft.id;
      st.activeTool = 'select';
      pushHistory(inst);
      render(inst);
    }
  );
}

function startDrawArrow(inst, startPt) {
  const st = inst.state;
  const tolerance = ATTACH_TOLERANCE_SCREEN_PX / st.zoom;
  const startAttach = findAttachTarget(startPt, st.shapes, tolerance, measureTextWidth);
  const draft = newArrow(st, startPt.x, startPt.y);
  draft.from.attach = startAttach;
  st.draftShape = draft;
  withWindowDragListeners(
    inst,
    (pt) => {
      draft.to = { x: pt.x, y: pt.y, attach: null };
      render(inst);
    },
    (pt) => {
      st.draftShape = null;
      const dist = Math.hypot(pt.x - startPt.x, pt.y - startPt.y);
      if (dist < MIN_DRAW_SIZE_IMAGE_PX) {
        render(inst);
        return;
      }
      const endAttach = findAttachTarget(pt, st.shapes, tolerance, measureTextWidth);
      draft.to = { x: pt.x, y: pt.y, attach: endAttach };
      st.shapes.push(draft);
      st.selectedShapeId = draft.id;
      st.activeTool = 'select';
      pushHistory(inst);
      render(inst);
    }
  );
}

function startDrawCallout(inst, startPt) {
  const st = inst.state;
  let moved = false;
  withWindowDragListeners(
    inst,
    () => {
      moved = true;
    },
    (pt) => {
      const dist = Math.hypot(pt.x - startPt.x, pt.y - startPt.y);
      let tailX;
      let tailY;
      let boxX;
      let boxY;
      if (moved && dist >= MIN_DRAW_SIZE_IMAGE_PX) {
        tailX = startPt.x;
        tailY = startPt.y;
        boxX = pt.x;
        boxY = pt.y;
      } else {
        tailX = startPt.x;
        tailY = startPt.y;
        boxX = startPt.x + 24;
        boxY = startPt.y - 72;
      }
      const shape = newCallout(st, tailX, tailY, boxX, boxY);
      st.shapes.push(shape);
      st.selectedShapeId = shape.id;
      st.activeTool = 'select';
      pushHistory(inst);
      render(inst);
      openTextEditor(inst, shape);
    }
  );
}

// ---- 切り抜き(対象画像固有のピクセル座標で行う) ----
function startCropDraw(inst, target, startPt) {
  inst.cropDraft = { x: startPt.x, y: startPt.y, w: 0, h: 0 };
  withImageDragListeners(
    inst,
    target,
    (pt) => {
      inst.cropDraft = normalizeRect({ x: startPt.x, y: startPt.y, w: pt.x - startPt.x, h: pt.y - startPt.y });
      render(inst);
    },
    (pt) => {
      const n = normalizeRect({ x: startPt.x, y: startPt.y, w: pt.x - startPt.x, h: pt.y - startPt.y });
      inst.cropDraft = null;
      if (n.w >= MIN_DRAW_SIZE_IMAGE_PX && n.h >= MIN_DRAW_SIZE_IMAGE_PX) {
        target.crop = clampCropToImage(n, target);
        pushHistory(inst);
      }
      render(inst);
    }
  );
}

function startCropMoveDrag(inst, target, startPt) {
  const startCrop = { ...target.crop };
  inst.cropDraft = startCrop;
  withImageDragListeners(
    inst,
    target,
    (pt) => {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      inst.cropDraft = clampCropToImage({ x: startCrop.x + dx, y: startCrop.y + dy, w: startCrop.w, h: startCrop.h }, target);
      render(inst);
    },
    (pt) => {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      target.crop = clampCropToImage({ x: startCrop.x + dx, y: startCrop.y + dy, w: startCrop.w, h: startCrop.h }, target);
      inst.cropDraft = null;
      pushHistory(inst);
      render(inst);
    }
  );
}

function startCropHandleDrag(inst, target, handleName, startPt) {
  const startCrop = { ...target.crop };
  withImageDragListeners(
    inst,
    target,
    (pt) => {
      inst.cropDraft = normalizeRect(resizeCropRect(startCrop, handleName, pt));
      render(inst);
    },
    (pt) => {
      const n = normalizeRect(resizeCropRect(startCrop, handleName, pt));
      inst.cropDraft = null;
      if (n.w >= MIN_DRAW_SIZE_IMAGE_PX && n.h >= MIN_DRAW_SIZE_IMAGE_PX) {
        target.crop = clampCropToImage(n, target);
        pushHistory(inst);
      }
      render(inst);
    }
  );
}

function resizeCropRect(startCrop, handleName, pt) {
  let { x, y, w, h } = startCrop;
  const right = x + w;
  const bottom = y + h;
  if (handleName.includes('w')) {
    w = right - pt.x;
    x = pt.x;
  }
  if (handleName.includes('e')) {
    w = pt.x - x;
  }
  if (handleName.includes('n')) {
    h = bottom - pt.y;
    y = pt.y;
  }
  if (handleName.includes('s')) {
    h = pt.y - y;
  }
  return { x, y, w, h };
}

function clampCropToImage(rect, target) {
  let { x, y, w, h } = rect;
  x = clampNum(x, 0, target.width);
  y = clampNum(y, 0, target.height);
  w = clampNum(w, 1, target.width - x);
  h = clampNum(h, 1, target.height - y);
  return { x, y, w, h };
}

// ---------- 保存 / キャンセル ----------

function isDirty(st) {
  return modelJson(st) !== st.initialSnapshotJson;
}

async function handleCancel(inst) {
  commitPendingTextEdit(inst);
  if (isDirty(inst.state)) {
    const ok = await showConfirm(inst, '変更を破棄してキャンセルしますか?');
    if (!ok) return;
  }
  closeInstance(inst, null);
}

function isOutputTooLarge(size) {
  return size.width > MAX_OUTPUT_DIMENSION_PX || size.height > MAX_OUTPUT_DIMENSION_PX || size.width * size.height > MAX_OUTPUT_AREA_PX;
}

async function handleSave(inst) {
  commitPendingTextEdit(inst);
  const st = inst.state;
  const bounds = computeOutputBounds(st.images, st.shapes, measureTextWidth);
  const outSize = computeOutputSize(bounds, st.scale);
  if (isOutputTooLarge(outSize)) {
    await showConfirm(
      inst,
      `出力サイズ(${outSize.width} × ${outSize.height} px)が大きすぎます。出力倍率を下げてください`,
      { okOnly: true }
    );
    return; // モーダルは開いたまま
  }
  try {
    const blob = await renderOutputPng(st);
    closeInstance(inst, blob);
  } catch (err) {
    console.error('注釈の保存に失敗しました', err);
    await showConfirm(inst, `保存に失敗しました: ${err.message || err}`, { okOnly: true });
  }
}

function closeInstance(inst, result) {
  document.removeEventListener('keydown', inst._keydownHandler);
  document.removeEventListener('paste', inst._pasteHandler);
  if (inst.resizeObserver) inst.resizeObserver.disconnect();
  if (inst.root.parentNode) inst.root.parentNode.removeChild(inst.root);
  if (currentInstance === inst) currentInstance = null;
  for (const source of inst.state.imageSources.values()) {
    URL.revokeObjectURL(source.objectUrl);
  }
  inst.state.imageSources.clear();
  inst.state.resolvePromise(result);
}

// 独自の確認ダイアログ(window.confirm は使わない: モーダル内で完結させ、
// テスト環境でのネイティブダイアログのハンドリングを不要にするため)
function showConfirm(inst, message, { okOnly = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'annotator-confirm-overlay';
    const box = document.createElement('div');
    box.className = 'annotator-confirm-box';
    const msg = document.createElement('p');
    msg.className = 'annotator-confirm-message';
    msg.textContent = message;
    box.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'annotator-confirm-actions';
    if (!okOnly) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.dataset.action = 'cancel';
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });
      actions.appendChild(cancelBtn);
    }
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.dataset.action = 'ok';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });
    actions.appendChild(okBtn);
    box.appendChild(actions);
    overlay.appendChild(box);
    inst.root.appendChild(overlay);
    okBtn.focus();
  });
}

// ---------- 出力(PNG への焼き込み) ----------
//
// 元画像は Image 要素から直接 canvas に drawImage する(crop・配置・出力サイズへの
// 変換も9引数の drawImage で1回に行う)。画像データを SVG や data URL に包み直さない
// ので二重エンコードが発生しない(4Kスクリーンショット等の大きな画像でも高速)。
// 図形だけ(image 要素を含まない、通常は小さい)を SVG の data URL にしてその上から
// 重ねて描く。図形の見た目は shapes.js の buildShapeSvg() をエディタ表示と共用する。
//
// 元画像は openAnnotator 内で作った blob URL(imageSources の objectUrl)を使う。
// blob URL は同一ドキュメント内で生成した Blob を指すため canvas を汚染しないはずだが、
// 万一 toBlob が失敗した(canvas が汚染された)場合は、出力時だけ data URL 経由の
// Image に切り替えて再試行する。

function buildShapesOnlySvgDataUrl(st, bounds, outSize) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
  svg.setAttribute('width', String(outSize.width));
  svg.setAttribute('height', String(outSize.height));
  const map = shapesById(st);
  for (const shape of st.shapes) {
    svg.appendChild(buildShapeSvg(document, shape, map, { measureFn: measureTextWidth }));
  }
  const svgText = new XMLSerializer().serializeToString(svg);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG の生成に失敗しました'))), 'image/png');
    } catch (e) {
      reject(e);
    }
  });
}

// canvas が汚染された(origin-clean フラグが false になった)ことを示すエラーかどうか
function isLikelyTaintedCanvasError(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || '');
  return name === 'SecurityError' || /tainted|insecure|cross-origin/i.test(msg);
}

async function renderOutputPng(st) {
  const bounds = computeOutputBounds(st.images, st.shapes, measureTextWidth);
  const outSize = computeOutputSize(bounds, st.scale);
  const kx = outSize.width / Math.max(bounds.w, 1e-6);
  const ky = outSize.height / Math.max(bounds.h, 1e-6);

  const shapesDataUrl = st.shapes.length > 0 ? buildShapesOnlySvgDataUrl(st, bounds, outSize) : null;
  const shapesImg = shapesDataUrl ? await loadImageElement(shapesDataUrl) : null;

  // srcFor(img): 画像ごとに描画元(blob URL / data URL)を決める関数
  const draw = async (srcFor) => {
    const canvas = document.createElement('canvas');
    canvas.width = outSize.width;
    canvas.height = outSize.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outSize.width, outSize.height);
    for (const img of st.images) {
      const baseImg = await loadImageElement(srcFor(img));
      const rect = imageVisibleRect(img);
      ctx.drawImage(
        baseImg,
        img.crop.x,
        img.crop.y,
        img.crop.w,
        img.crop.h,
        (rect.x - bounds.x) * kx,
        (rect.y - bounds.y) * ky,
        rect.w * kx,
        rect.h * ky
      );
    }
    if (shapesImg) {
      ctx.drawImage(shapesImg, 0, 0, outSize.width, outSize.height);
    }
    return canvas;
  };

  let pngBlob;
  try {
    const canvas = await draw((img) => st.imageSources.get(img.id).objectUrl);
    pngBlob = await canvasToPngBlob(canvas);
  } catch (err) {
    if (!isLikelyTaintedCanvasError(err)) throw err;
    // blob URL 経由の描画で canvas が汚染された場合の救済策(出力時のみ data URL に切り替える)
    console.warn('blob URL からの描画で canvas が汚染されたため、data URL 経由に切り替えて出力します', err);
    const canvas = await draw((img) => {
      const source = st.imageSources.get(img.id);
      return bytesToDataUrl(source.bytes, source.mime);
    });
    pngBlob = await canvasToPngBlob(canvas);
  }

  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const json = {
    version: 2,
    images: st.images.map((img) => ({
      id: img.id,
      mime: img.mime,
      width: img.width,
      height: img.height,
      x: img.x,
      y: img.y,
      scale: img.scale,
      crop: { ...img.crop },
    })),
    shapes: st.shapes.map(cloneShape),
    scale: st.scale,
  };
  const images = st.images.map((img) => ({ id: img.id, bytes: st.imageSources.get(img.id).bytes }));
  const finalBytes = setAnnotationData(pngBytes, { json, images });
  return new Blob([finalBytes], { type: 'image/png' });
}
