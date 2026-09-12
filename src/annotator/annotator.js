// src/annotator/annotator.js
//
// 画像注釈エディタ本体。公開 API は openAnnotator() のみ。
// 呼び出し側はファイルの読み書きを行わず、Blob を渡して Blob を受け取るだけにする。
//
//   import { openAnnotator } from './annotator/annotator.js';
//   const blob = await openAnnotator({ imageBlob, title });
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
import {
  buildShapeSvg,
  getShapeOutlineBox,
  intersectRectFromCenter,
  computeArrowEndpoints,
  findAttachTarget,
  computeOutputSize,
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
const ATTACH_TOLERANCE_SCREEN_PX = 10;
const HANDLE_SCREEN_PX = 8;
const MIN_DRAW_SIZE_IMAGE_PX = 3;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

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
 *            元画像と図形を復元して再編集できる状態で開く。
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
  return {
    crop: { ...st.crop },
    scale: st.scale,
    shapes: st.shapes.map((s) => ({ ...s })),
    activeTool: st.activeTool,
    selectedShapeId: st.selectedShapeId,
    historyIndex: st.historyIndex,
    historyLength: st.history.length,
    zoom: st.zoom,
    original: { ...st.original },
  };
}

// ---------- 初期状態の読み込み(元画像・チャンクの復元) ----------

async function loadInitialState(imageBlob) {
  const bytes = new Uint8Array(await imageBlob.arrayBuffer());
  let json = null;
  let originalBytes = null;
  if (isPngBytes(bytes)) {
    const parsed = getAnnotationData(bytes);
    json = parsed.json;
    originalBytes = parsed.originalBytes;
  }
  const srcBytes = originalBytes || bytes;
  const srcMime = (json && json.original && json.original.mime) || imageBlob.type || guessMimeFromBytes(srcBytes);
  const dataUrl = bytesToDataUrl(srcBytes, srcMime);
  const dims = await loadImageDimensions(dataUrl);

  const restorable = json && json.original && json.original.width === dims.width && json.original.height === dims.height;
  if (restorable) {
    return {
      original: { mime: srcMime, width: dims.width, height: dims.height },
      originalBytes: srcBytes,
      originalDataUrl: dataUrl,
      crop: { ...json.crop },
      scale: json.scale,
      shapes: json.shapes.map(cloneShape),
    };
  }
  return {
    original: { mime: srcMime, width: dims.width, height: dims.height },
    originalBytes: srcBytes,
    originalDataUrl: dataUrl,
    crop: { x: 0, y: 0, w: dims.width, h: dims.height },
    scale: 1,
    shapes: [],
  };
}

function guessMimeFromBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (isPngBytes(bytes)) return 'image/png';
  return 'image/png';
}

function loadImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    img.src = dataUrl;
  });
}

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

function cloneModel(st) {
  return { crop: { ...st.crop }, scale: st.scale, shapes: st.shapes.map(cloneShape) };
}

function modelJson(st) {
  return JSON.stringify(cloneModel(st));
}

// ---------- インスタンスの生成 ----------

function createInstance(initial, title, resolve) {
  const st = {
    original: initial.original,
    originalBytes: initial.originalBytes,
    originalDataUrl: initial.originalDataUrl,
    crop: initial.crop,
    scale: initial.scale,
    shapes: initial.shapes,
    history: [],
    historyIndex: -1,
    activeTool: 'select',
    currentColor: DEFAULT_COLOR,
    currentStrokeWidth: DEFAULT_WIDTH,
    selectedShapeId: null,
    editingShapeId: null,
    zoom: 1,
    nextIdCounter: initial.shapes.reduce((max, s) => {
      const n = Number(String(s.id).replace(/^s/, ''));
      return Number.isFinite(n) ? Math.max(max, n + 1) : max;
    }, 1),
    drag: null,
    resolvePromise: resolve,
  };

  const dom = buildDom(title);
  const inst = { root: dom.root, state: st, dom };
  wireEvents(inst);

  st.initialSnapshotJson = null; // init() 内で最初の render 後に確定させる

  inst.init = () => {
    pushHistory(inst, { replaceInitial: true });
    st.initialSnapshotJson = modelJson(st);
    fitZoomToWindow(inst);
    render(inst);
  };
  return inst;
}

// ---------- DOM 構築 ----------

function buildDom(title) {
  const root = document.createElement('div');
  root.className = 'annotator-overlay';

  const toolbar = document.createElement('div');
  toolbar.className = 'annotator-toolbar';
  toolbar.appendChild(buildToolGroup());
  toolbar.appendChild(buildColorGroup());
  toolbar.appendChild(buildWidthGroup());
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

  const imageEl = document.createElementNS(SVG_NS, 'image');
  imageEl.setAttribute('x', '0');
  imageEl.setAttribute('y', '0');
  svg.appendChild(imageEl);

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
    imageEl,
    shapesLayer,
    hitLayer,
    cropLayer,
    selectionLayer,
    textEditor,
    toolButtons: Array.from(toolbar.querySelectorAll('[data-tool]')),
    colorButtons: Array.from(toolbar.querySelectorAll('[data-color]')),
    widthButtons: Array.from(toolbar.querySelectorAll('[data-width]')),
    scaleButtons: Array.from(toolbar.querySelectorAll('[data-scale]')),
    scaleCustomInput: toolbar.querySelector('.annotator-scale-custom'),
    outputSizeLabel: toolbar.querySelector('.annotator-output-size'),
    undoBtn: toolbar.querySelector('[data-action="undo"]'),
    redoBtn: toolbar.querySelector('[data-action="redo"]'),
    resetCropBtn: toolbar.querySelector('[data-action="resetCrop"]'),
    zoomInBtn: toolbar.querySelector('[data-action="zoomIn"]'),
    zoomOutBtn: toolbar.querySelector('[data-action="zoomOut"]'),
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
  resetCropBtn.title = '切り抜きを元画像全体に戻す';
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

// ---------- ズーム ----------

function fitZoomToWindow(inst) {
  const { wrap } = inst.dom;
  const { original } = inst.state;
  const availW = Math.max(100, wrap.clientWidth - 24);
  const availH = Math.max(100, wrap.clientHeight - 24);
  const zoom = Math.min(1, availW / original.width, availH / original.height);
  inst.state.zoom = clampNum(zoom, MIN_ZOOM, MAX_ZOOM);
}

function clampNum(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

function setZoom(inst, zoom) {
  inst.state.zoom = clampNum(zoom, MIN_ZOOM, MAX_ZOOM);
  render(inst);
}

// ---------- 座標変換 ----------

function clientToImagePoint(inst, clientX, clientY) {
  const rect = inst.dom.svg.getBoundingClientRect();
  const { zoom } = inst.state;
  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
  };
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
  st.crop = { ...snapshot.crop };
  st.scale = snapshot.scale;
  st.shapes = snapshot.shapes.map(cloneShape);
  if (st.selectedShapeId && !st.shapes.some((s) => s.id === st.selectedShapeId)) {
    st.selectedShapeId = null;
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

// ---------- レンダリング ----------

function render(inst) {
  const st = inst.state;
  const { svg, imageEl, shapesLayer, hitLayer, cropLayer, selectionLayer } = inst.dom;

  svg.setAttribute('viewBox', `0 0 ${st.original.width} ${st.original.height}`);
  svg.setAttribute('width', String(Math.round(st.original.width * st.zoom)));
  svg.setAttribute('height', String(Math.round(st.original.height * st.zoom)));
  svg.setAttribute('data-tool', st.activeTool);

  imageEl.setAttribute('href', st.originalDataUrl);
  imageEl.setAttribute('width', String(st.original.width));
  imageEl.setAttribute('height', String(st.original.height));

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

  updateToolbar(inst);
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
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
  const full = { x: 0, y: 0, w: st.original.width, h: st.original.height };
  const crop = st.activeTool === 'crop' && inst.cropDraft ? inst.cropDraft : st.crop;
  const isCropped = crop.x > 0.001 || crop.y > 0.001 || Math.abs(crop.w - full.w) > 0.001 || Math.abs(crop.h - full.h) > 0.001;

  if (isCropped || st.activeTool === 'crop') {
    // crop の外側を暗くする(4枚の矩形で crop の周囲を覆う)
    const rects = [
      { x: 0, y: 0, w: full.w, h: crop.y },
      { x: 0, y: crop.y + crop.h, w: full.w, h: full.h - (crop.y + crop.h) },
      { x: 0, y: crop.y, w: crop.x, h: crop.h },
      { x: crop.x + crop.w, y: crop.y, w: full.w - (crop.x + crop.w), h: crop.h },
    ];
    for (const r of rects) {
      if (r.w <= 0 || r.h <= 0) continue;
      const el = svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h });
      el.setAttribute('class', 'annotator-crop-dim');
      cropLayer.appendChild(el);
    }
    const boundary = svgEl('rect', { x: crop.x, y: crop.y, width: crop.w, height: crop.h });
    boundary.setAttribute('class', 'annotator-crop-boundary');
    cropLayer.appendChild(boundary);
  }

  if (st.activeTool === 'crop') {
    const hp = HANDLE_SCREEN_PX / st.zoom;
    const points = cropHandlePoints(crop);
    for (const p of points) {
      const handle = svgEl('rect', { x: p.x - hp / 2, y: p.y - hp / 2, width: hp, height: hp });
      handle.setAttribute('class', 'annotator-handle');
      handle.setAttribute('data-handle', p.name);
      cropLayer.appendChild(handle);
    }
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
  if (!st.selectedShapeId) return;
  const shape = st.shapes.find((s) => s.id === st.selectedShapeId);
  if (!shape) return;
  const map = shapesById(st);
  const hp = HANDLE_SCREEN_PX / st.zoom;

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

function updateToolbar(inst) {
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

  for (const btn of dom.scaleButtons) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.scale) === st.scale));
  }
  if (document.activeElement !== dom.scaleCustomInput) {
    dom.scaleCustomInput.value = String(Math.round(st.scale * 100));
  }
  const outSize = computeOutputSize(st.crop, st.scale);
  dom.outputSizeLabel.textContent = `出力: ${outSize.width} × ${outSize.height} px`;

  dom.undoBtn.disabled = st.historyIndex <= 0;
  dom.redoBtn.disabled = st.historyIndex >= st.history.length - 1;

  dom.zoomLabel.textContent = `${Math.round(st.zoom * 100)}%`;
}

// ---------- テキスト編集(吹き出し) ----------

function openTextEditor(inst, shape) {
  commitPendingTextEdit(inst);
  const st = inst.state;
  st.editingShapeId = shape.id;
  const { textEditor, svg } = inst.dom;
  const box = computeCalloutBox(shape, measureTextWidth);
  const svgRect = svg.getBoundingClientRect();
  const wrapRect = inst.dom.wrap.getBoundingClientRect();
  const zoom = st.zoom;

  textEditor.style.display = 'block';
  textEditor.style.left = `${svgRect.left - wrapRect.left + inst.dom.wrap.scrollLeft + box.x * zoom}px`;
  textEditor.style.top = `${svgRect.top - wrapRect.top + inst.dom.wrap.scrollTop + box.y * zoom}px`;
  textEditor.style.width = `${box.w * zoom}px`;
  textEditor.style.height = `${box.h * zoom}px`;
  textEditor.style.fontSize = `${box.fontSize * zoom}px`;
  textEditor.style.lineHeight = `${box.lineHeight * zoom}px`;
  textEditor.style.padding = `${box.padding * zoom}px`;
  textEditor.style.color = shape.textColor || '#222222';
  textEditor.value = shape.text || '';
  textEditor.focus();
  textEditor.select();
}

function commitPendingTextEdit(inst) {
  const st = inst.state;
  if (!st.editingShapeId) return;
  const shape = st.shapes.find((s) => s.id === st.editingShapeId);
  const { textEditor } = inst.dom;
  const newText = textEditor.value;
  textEditor.style.display = 'none';
  st.editingShapeId = null;
  if (shape && shape.text !== newText) {
    shape.text = newText;
    pushHistory(inst);
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
    textColor: '#222222',
    fontSize: 24,
  };
}

// ---------- マウス操作 ----------

function wireEvents(inst) {
  const { dom } = inst;

  for (const btn of dom.toolButtons) {
    btn.addEventListener('click', () => {
      commitPendingTextEdit(inst);
      inst.state.activeTool = btn.dataset.tool;
      inst.state.selectedShapeId = null;
      inst.cropDraft = null;
      render(inst);
    });
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

  dom.undoBtn.addEventListener('click', () => undo(inst));
  dom.redoBtn.addEventListener('click', () => redo(inst));
  dom.resetCropBtn.addEventListener('click', () => {
    inst.state.crop = { x: 0, y: 0, w: inst.state.original.width, h: inst.state.original.height };
    pushHistory(inst);
    render(inst);
  });
  dom.zoomInBtn.addEventListener('click', () => setZoom(inst, inst.state.zoom * 1.25));
  dom.zoomOutBtn.addEventListener('click', () => setZoom(inst, inst.state.zoom * 0.8));

  dom.saveBtn.addEventListener('click', () => handleSave(inst));
  dom.cancelBtn.addEventListener('click', () => handleCancel(inst));

  dom.textEditor.addEventListener('blur', () => commitPendingTextEdit(inst));

  dom.svg.addEventListener('dblclick', (e) => {
    const target = e.target.closest('[data-shape-id]');
    if (!target) return;
    const shape = inst.state.shapes.find((s) => s.id === target.dataset.shapeId);
    if (shape && shape.type === 'callout') {
      inst.state.selectedShapeId = shape.id;
      openTextEditor(inst, shape);
    }
  });

  dom.svg.addEventListener('mousedown', (e) => onCanvasMouseDown(inst, e));

  inst._keydownHandler = (e) => onKeyDown(inst, e);
  document.addEventListener('keydown', inst._keydownHandler);
}

function applyColorChoice(inst, color) {
  const st = inst.state;
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
  const shape = st.selectedShapeId ? st.shapes.find((s) => s.id === st.selectedShapeId) : null;
  if (shape) {
    shape.strokeWidth = width;
    pushHistory(inst);
  } else {
    st.currentStrokeWidth = width;
  }
  render(inst);
}

function onKeyDown(inst, e) {
  if (!document.body.contains(inst.dom.root)) return; // 既に閉じている
  const active = document.activeElement;
  const isTyping = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');

  if (e.key === 'Escape') {
    if (inst.state.editingShapeId) {
      commitPendingTextEdit(inst);
    } else {
      inst.state.selectedShapeId = null;
    }
    render(inst);
    return;
  }

  if (isTyping) return;

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
    deleteSelectedShape(inst);
    return;
  }
  const toolKeys = { v: 'select', r: 'rect', a: 'arrow', t: 'callout', c: 'crop' };
  const tool = toolKeys[e.key.toLowerCase()];
  if (tool) {
    commitPendingTextEdit(inst);
    inst.state.activeTool = tool;
    inst.state.selectedShapeId = null;
    render(inst);
  }
}

function onCanvasMouseDown(inst, e) {
  if (e.button !== 0) return;
  commitPendingTextEdit(inst);
  const st = inst.state;
  const pt = clientToImagePoint(inst, e.clientX, e.clientY);
  const handleName = e.target.dataset && e.target.dataset.handle;
  const shapeTarget = e.target.closest && e.target.closest('[data-shape-id]');

  if (st.activeTool === 'select') {
    if (handleName) {
      startHandleDrag(inst, handleName, pt);
      return;
    }
    if (shapeTarget) {
      const id = shapeTarget.dataset.shapeId;
      st.selectedShapeId = id;
      const shape = st.shapes.find((s) => s.id === id);
      startMoveDrag(inst, shape, pt);
      render(inst);
      return;
    }
    st.selectedShapeId = null;
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
    if (handleName) {
      startCropHandleDrag(inst, handleName, pt);
      return;
    }
    const crop = st.crop;
    const isFullImage =
      crop.x <= 0.001 &&
      crop.y <= 0.001 &&
      Math.abs(crop.w - st.original.width) <= 0.001 &&
      Math.abs(crop.h - st.original.height) <= 0.001;
    const inside = pt.x >= crop.x && pt.x <= crop.x + crop.w && pt.y >= crop.y && pt.y <= crop.y + crop.h;
    // crop がまだ元画像全体のまま(何も切り抜いていない)なら、クリックした場所に
    // 関わらず常に新規の切り抜き矩形を描き始める(そうしないと「全体を動かす」
    // 操作しかできなくなってしまうため)。既に部分的な crop があるときだけ、
    // その内側のクリックを「移動」として扱う。
    if (!isFullImage && inside) {
      startCropMoveDrag(inst, pt);
    } else {
      startCropDraw(inst, pt);
    }
  }
}

function withWindowDragListeners(inst, onMove, onUp) {
  const move = (e) => onMove(clientToImagePoint(inst, e.clientX, e.clientY), e);
  const up = (e) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    onUp(clientToImagePoint(inst, e.clientX, e.clientY), e);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ---- 選択ツール: 移動 ----
function startMoveDrag(inst, shape, startPt) {
  if (!shape) return;
  const st = inst.state;
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
      pushHistory(inst);
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

// ---- 切り抜き ----
function startCropDraw(inst, startPt) {
  const st = inst.state;
  inst.cropDraft = { x: startPt.x, y: startPt.y, w: 0, h: 0 };
  withWindowDragListeners(
    inst,
    (pt) => {
      inst.cropDraft = normalizeRect({ x: startPt.x, y: startPt.y, w: pt.x - startPt.x, h: pt.y - startPt.y });
      render(inst);
    },
    (pt) => {
      const n = normalizeRect({ x: startPt.x, y: startPt.y, w: pt.x - startPt.x, h: pt.y - startPt.y });
      inst.cropDraft = null;
      if (n.w >= MIN_DRAW_SIZE_IMAGE_PX && n.h >= MIN_DRAW_SIZE_IMAGE_PX) {
        st.crop = clampCropToImage(n, st.original);
        pushHistory(inst);
      }
      render(inst);
    }
  );
}

function startCropMoveDrag(inst, startPt) {
  const st = inst.state;
  const startCrop = { ...st.crop };
  inst.cropDraft = startCrop;
  withWindowDragListeners(
    inst,
    (pt) => {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      inst.cropDraft = clampCropToImage({ x: startCrop.x + dx, y: startCrop.y + dy, w: startCrop.w, h: startCrop.h }, st.original);
      render(inst);
    },
    (pt) => {
      const dx = pt.x - startPt.x;
      const dy = pt.y - startPt.y;
      st.crop = clampCropToImage({ x: startCrop.x + dx, y: startCrop.y + dy, w: startCrop.w, h: startCrop.h }, st.original);
      inst.cropDraft = null;
      pushHistory(inst);
      render(inst);
    }
  );
}

function startCropHandleDrag(inst, handleName, startPt) {
  const st = inst.state;
  const startCrop = { ...st.crop };
  withWindowDragListeners(
    inst,
    (pt) => {
      inst.cropDraft = normalizeRect(resizeCropRect(startCrop, handleName, pt));
      render(inst);
    },
    (pt) => {
      const n = normalizeRect(resizeCropRect(startCrop, handleName, pt));
      inst.cropDraft = null;
      if (n.w >= MIN_DRAW_SIZE_IMAGE_PX && n.h >= MIN_DRAW_SIZE_IMAGE_PX) {
        st.crop = clampCropToImage(n, st.original);
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

function clampCropToImage(rect, original) {
  let { x, y, w, h } = rect;
  x = clampNum(x, 0, original.width);
  y = clampNum(y, 0, original.height);
  w = clampNum(w, 1, original.width - x);
  h = clampNum(h, 1, original.height - y);
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

async function handleSave(inst) {
  commitPendingTextEdit(inst);
  try {
    const blob = await renderOutputPng(inst.state);
    closeInstance(inst, blob);
  } catch (err) {
    console.error('注釈の保存に失敗しました', err);
    await showConfirm(inst, `保存に失敗しました: ${err.message || err}`, { okOnly: true });
  }
}

function closeInstance(inst, result) {
  document.removeEventListener('keydown', inst._keydownHandler);
  if (inst.root.parentNode) inst.root.parentNode.removeChild(inst.root);
  if (currentInstance === inst) currentInstance = null;
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

async function renderOutputPng(st) {
  const outSize = computeOutputSize(st.crop, st.scale);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `${st.crop.x} ${st.crop.y} ${st.crop.w} ${st.crop.h}`);
  svg.setAttribute('width', String(outSize.width));
  svg.setAttribute('height', String(outSize.height));

  const imageEl = svgEl('image', { x: 0, y: 0, width: st.original.width, height: st.original.height });
  imageEl.setAttribute('href', st.originalDataUrl);
  svg.appendChild(imageEl);

  const map = shapesById(st);
  for (const shape of st.shapes) {
    svg.appendChild(buildShapeSvg(document, shape, map, { measureFn: measureTextWidth }));
  }

  const svgText = new XMLSerializer().serializeToString(svg);
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;

  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('出力用 SVG の読み込みに失敗しました'));
    img.src = svgDataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = outSize.width;
  canvas.height = outSize.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, outSize.width, outSize.height);

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG の生成に失敗しました'))), 'image/png');
  });
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());

  const json = {
    version: 1,
    original: st.original,
    crop: st.crop,
    scale: st.scale,
    shapes: st.shapes.map(cloneShape),
  };
  const finalBytes = setAnnotationData(pngBytes, { json, originalBytes: st.originalBytes });
  return new Blob([finalBytes], { type: 'image/png' });
}
