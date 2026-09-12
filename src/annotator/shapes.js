// src/annotator/shapes.js
//
// 図形の幾何計算と SVG 描画をまとめたモジュール。エディタ表示(annotator.js が
// ライブの SVG に追加する)と PNG への焼き込み(出力用の SVG を組み立てる)の
// どちらからも同じ buildShapeSvg() / computeArrowEndpoints() を呼ぶことで、
// 描画ロジックを二重に持たないようにしている。
//
// 幾何計算部分(normalizeRect・intersectRectFromCenter・computeArrowEndpoints・
// findAttachTarget・computeOutputSize・computeCalloutBox)は DOM に依存せず、
// テキスト幅の測定関数(measureFn)を外から差し替えられるようにしてあるので、
// tests/annotator-shapes.test.js から node:test で直接検証できる。
// SVG 要素を実際に作る buildShapeSvg() だけは document を必要とする(ブラウザ専用)。

export const SVG_NS = 'http://www.w3.org/2000/svg';

// Windows のシステムフォント(要件どおり)
export const DEFAULT_FONT_FAMILY = '"Meiryo", "Yu Gothic UI", sans-serif';

// ---------- 純粋な幾何計算 ----------

/** w/h が負(逆方向にドラッグした結果)でも正しい矩形になるよう正規化する */
export function normalizeRect(rect) {
  const x = rect.w < 0 ? rect.x + rect.w : rect.x;
  const y = rect.h < 0 ? rect.y + rect.h : rect.y;
  return { x, y, w: Math.abs(rect.w), h: Math.abs(rect.h) };
}

/** 出力サイズ(px)。crop のサイズ × scale を四捨五入する(最低 1px) */
export function computeOutputSize(crop, scale) {
  return {
    width: Math.max(1, Math.round(crop.w * scale)),
    height: Math.max(1, Math.round(crop.h * scale)),
  };
}

// キャンバス2D測定による既定のテキスト幅計測(ブラウザ専用)。
// 遅延生成して使い回す。node:test からは呼ばれない(measureFn を明示的に渡すため)。
let sharedMeasureCtx = null;
export function measureTextWidth(text, fontSize, fontFamily = DEFAULT_FONT_FAMILY) {
  if (!sharedMeasureCtx) {
    sharedMeasureCtx = document.createElement('canvas').getContext('2d');
  }
  sharedMeasureCtx.font = `${fontSize}px ${fontFamily}`;
  return sharedMeasureCtx.measureText(text).width;
}

/**
 * 吹き出しの枠のサイズをテキストに合わせて自動計算する(内側の余白込み)。
 * measureFn(line, fontSize) => 幅px を注入できるので DOM なしでもテスト可能。
 */
export function computeCalloutBox(shape, measureFn = measureTextWidth) {
  const lines = String(shape.text ?? '').split('\n');
  const fontSize = shape.fontSize || 24;
  const padding = Math.round(fontSize * 0.6);
  const lineHeight = Math.round(fontSize * 1.35);
  let maxWidth = 0;
  for (const line of lines) {
    const w = measureFn(line, fontSize);
    if (w > maxWidth) maxWidth = w;
  }
  const w = Math.ceil(maxWidth) + padding * 2;
  const h = lines.length * lineHeight + padding * 2;
  return { x: shape.x, y: shape.y, w, h, padding, lineHeight, fontSize, lines };
}

/** rect / callout の「外周」(当たり判定・矢印接続に使う矩形)を返す。それ以外は null */
export function getShapeOutlineBox(shape, measureFn = measureTextWidth) {
  if (shape.type === 'rect') return normalizeRect(shape);
  if (shape.type === 'callout') return computeCalloutBox(shape, measureFn);
  return null;
}

/** 矩形の中心から target 方向に伸ばした半直線が、矩形の外周と交わる点を求める */
export function intersectRectFromCenter(rect, target) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) {
    // 縮退(target が中心と一致)。右辺の中点を返しておく
    return { x: rect.x + rect.w, y: cy };
  }
  const hw = rect.w / 2 || 0.0001;
  const hh = rect.h / 2 || 0.0001;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * 矢印の両端の実座標(描画に使う座標)を求める。
 * 接続先があれば「接続先図形の中心 → もう一方の端点(相手も接続済みならその中心)」の
 * 線分と図形の外周との交点、接続が無ければ生の座標をそのまま使う。
 */
export function computeArrowEndpoints(shape, shapesById = {}, measureFn = measureTextWidth) {
  const resolveAnchor = (endpoint) => {
    const target = endpoint.attach ? shapesById[endpoint.attach] : null;
    if (target) {
      const box = getShapeOutlineBox(target, measureFn);
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    }
    return { x: endpoint.x, y: endpoint.y };
  };
  const fromAnchor = resolveAnchor(shape.from);
  const toAnchor = resolveAnchor(shape.to);

  const fromTarget = shape.from.attach ? shapesById[shape.from.attach] : null;
  const toTarget = shape.to.attach ? shapesById[shape.to.attach] : null;

  const from = fromTarget
    ? intersectRectFromCenter(getShapeOutlineBox(fromTarget, measureFn), toAnchor)
    : { x: shape.from.x, y: shape.from.y };
  const to = toTarget
    ? intersectRectFromCenter(getShapeOutlineBox(toTarget, measureFn), fromAnchor)
    : { x: shape.to.x, y: shape.to.y };
  return { from, to };
}

/** 点から矩形までの最短距離(点が矩形内なら 0) */
export function distanceToRect(rect, point) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.w));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.h));
  return Math.hypot(dx, dy);
}

/**
 * point の近くにある rect/callout を探す(矢印の端点を離したときの接続判定に使う)。
 * tolerance は point と同じ座標系(元画像ピクセル)での許容距離。
 * 最も近い(距離が tolerance 以下の)図形の id を返す。無ければ null。
 */
export function findAttachTarget(point, shapes, tolerance, measureFn = measureTextWidth) {
  let bestId = null;
  let bestDist = Infinity;
  for (const s of shapes) {
    if (s.type !== 'rect' && s.type !== 'callout') continue;
    const box = getShapeOutlineBox(s, measureFn);
    const d = distanceToRect(box, point);
    if (d <= tolerance && d < bestDist) {
      bestDist = d;
      bestId = s.id;
    }
  }
  return bestId;
}

function clamp(v, lo, hi) {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(Math.max(v, lo), hi);
}

// tail(しっぽの先端)に最も近い辺を選ぶ(box の縦横比を考慮して正規化してから比較する)
function pickTailEdge(box, tail) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const nx = (tail.x - cx) / (box.w / 2 || 1);
  const ny = (tail.y - cy) / (box.h / 2 || 1);
  if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'right' : 'left';
  return ny > 0 ? 'bottom' : 'top';
}

/**
 * 角丸の枠 + しっぽ(三角形)を1本の path にまとめて d 属性の文字列を作る。
 * tail が無い(null)場合は普通の角丸矩形になる。
 */
export function buildCalloutPath(box, tail, cornerRadius) {
  const x = box.x;
  const y = box.y;
  const w = box.w;
  const h = box.h;
  const x2 = x + w;
  const y2 = y + h;
  const r = Math.max(0, Math.min(cornerRadius, w / 2, h / 2));
  const edge = tail ? pickTailEdge(box, tail) : null;
  const half = Math.max(6, Math.round(box.fontSize * 0.3));

  // from → to の直線区間。isEdge が true ならしっぽの突起を挿入する
  function seg(from, to, isEdge, axis) {
    if (!isEdge) return `L ${to.x} ${to.y} `;
    if (axis === 'h') {
      const lo = Math.min(from.x, to.x) + half;
      const hi = Math.max(from.x, to.x) - half;
      const center = clamp(tail.x, lo, hi);
      const dir = from.x > to.x ? 1 : -1; // from→to の進行方向
      const b1 = { x: center + half * dir, y: from.y };
      const b2 = { x: center - half * dir, y: from.y };
      return `L ${b1.x} ${b1.y} L ${tail.x} ${tail.y} L ${b2.x} ${b2.y} L ${to.x} ${to.y} `;
    }
    const lo = Math.min(from.y, to.y) + half;
    const hi = Math.max(from.y, to.y) - half;
    const center = clamp(tail.y, lo, hi);
    const dir = from.y > to.y ? 1 : -1;
    const b1 = { x: from.x, y: center + half * dir };
    const b2 = { x: from.x, y: center - half * dir };
    return `L ${b1.x} ${b1.y} L ${tail.x} ${tail.y} L ${b2.x} ${b2.y} L ${to.x} ${to.y} `;
  }

  let d = `M ${x + r} ${y} `;
  d += seg({ x: x + r, y }, { x: x2 - r, y }, edge === 'top', 'h');
  d += `A ${r} ${r} 0 0 1 ${x2} ${y + r} `;
  d += seg({ x: x2, y: y + r }, { x: x2, y: y2 - r }, edge === 'right', 'v');
  d += `A ${r} ${r} 0 0 1 ${x2 - r} ${y2} `;
  d += seg({ x: x2 - r, y: y2 }, { x: x + r, y: y2 }, edge === 'bottom', 'h');
  d += `A ${r} ${r} 0 0 1 ${x} ${y2 - r} `;
  d += seg({ x, y: y2 - r }, { x, y: y + r }, edge === 'left', 'v');
  d += `A ${r} ${r} 0 0 1 ${x + r} ${y} `;
  d += 'Z';
  return d;
}

// 矢じり(三角形)の頂点座標を "x,y x,y x,y" の points 文字列にする
function arrowheadPoints(tipX, tipY, angle, size) {
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  const p1x = tipX + size * Math.cos(a1);
  const p1y = tipY + size * Math.sin(a1);
  const p2x = tipX + size * Math.cos(a2);
  const p2y = tipY + size * Math.sin(a2);
  return `${tipX},${tipY} ${p1x},${p1y} ${p2x},${p2y}`;
}

// ---------- SVG 要素の構築(エディタ表示・出力の両方で共用) ----------

function setAttrs(el, attrs) {
  for (const key in attrs) {
    const v = attrs[key];
    if (v === null || v === undefined) continue;
    el.setAttribute(key, String(v));
  }
}

/**
 * 1つの図形の「見た目」(選択ハンドルなどエディタ専用の装飾は含まない)を表す
 * <g> 要素を作る。エディタのライブ SVG・出力用の一時 SVG のどちらからも呼ばれる。
 *
 * doc: 要素の生成に使う Document(通常は window.document をそのまま渡す)
 * shapesById: 矢印の接続解決に使う { id: shape }
 */
export function buildShapeSvg(doc, shape, shapesById = {}, opts = {}) {
  const measureFn = opts.measureFn || measureTextWidth;
  const g = doc.createElementNS(SVG_NS, 'g');
  g.setAttribute('data-shape-id', shape.id);
  g.setAttribute('data-shape-type', shape.type);

  if (shape.type === 'rect') {
    const r = normalizeRect(shape);
    const rectEl = doc.createElementNS(SVG_NS, 'rect');
    setAttrs(rectEl, {
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      fill: 'none',
      stroke: shape.stroke,
      'stroke-width': shape.strokeWidth,
    });
    g.appendChild(rectEl);
  } else if (shape.type === 'arrow') {
    const { from, to } = computeArrowEndpoints(shape, shapesById, measureFn);
    const headSize = Math.max(10, shape.strokeWidth * 3);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    // 矢じりの分だけ線を手前で止め、線と三角形が重なりすぎないようにする
    const lineEnd = {
      x: to.x - Math.cos(angle) * headSize * 0.4,
      y: to.y - Math.sin(angle) * headSize * 0.4,
    };
    const line = doc.createElementNS(SVG_NS, 'line');
    setAttrs(line, {
      x1: from.x,
      y1: from.y,
      x2: lineEnd.x,
      y2: lineEnd.y,
      stroke: shape.stroke,
      'stroke-width': shape.strokeWidth,
      'stroke-linecap': 'round',
    });
    g.appendChild(line);
    const head = doc.createElementNS(SVG_NS, 'polygon');
    setAttrs(head, { points: arrowheadPoints(to.x, to.y, angle, headSize), fill: shape.stroke });
    g.appendChild(head);
  } else if (shape.type === 'callout') {
    const box = computeCalloutBox(shape, measureFn);
    const cornerRadius = Math.round(box.fontSize * 0.35);
    const path = doc.createElementNS(SVG_NS, 'path');
    setAttrs(path, {
      d: buildCalloutPath(box, shape.tail || null, cornerRadius),
      fill: shape.fill || '#ffffff',
      stroke: shape.stroke,
      'stroke-width': shape.strokeWidth,
      'stroke-linejoin': 'round',
    });
    g.appendChild(path);

    const baseX = box.x + box.padding;
    const baseY = box.y + box.padding + box.fontSize * 0.85;
    const textEl = doc.createElementNS(SVG_NS, 'text');
    setAttrs(textEl, {
      x: baseX,
      y: baseY,
      fill: shape.textColor || '#222222',
      'font-size': box.fontSize,
      'font-family': DEFAULT_FONT_FAMILY,
    });
    textEl.setAttribute('xml:space', 'preserve');
    box.lines.forEach((line, i) => {
      const tspan = doc.createElementNS(SVG_NS, 'tspan');
      setAttrs(tspan, { x: baseX, y: baseY + i * box.lineHeight });
      tspan.textContent = line.length ? line : ' ';
      textEl.appendChild(tspan);
    });
    g.appendChild(textEl);
  }
  return g;
}
