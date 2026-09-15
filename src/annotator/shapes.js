// src/annotator/shapes.js
//
// 図形の幾何計算と SVG 描画をまとめたモジュール。エディタ表示(annotator.js が
// ライブの SVG に追加する)と PNG への焼き込み(出力用の SVG を組み立てる)の
// どちらからも同じ buildShapeSvg() / computeArrowEndpoints() を呼ぶことで、
// 描画ロジックを二重に持たないようにしている。
//
// 幾何計算部分(normalizeRect・intersectRectFromCenter・computeArrowEndpoints・
// findAttachTarget・computeOutputSize・computeCalloutBox・getShapeVisualBounds・
// imageVisibleRect・imageFullRect・resizeImageFromCorner・unionRect・computeOutputBounds・
// nearestSide・sidePoint・facingSide・routeElbow・computeElbowRoute)は DOM に依存せず、
// テキスト幅の測定関数(measureFn)を外から差し替えられるようにしてあるので、
// tests/annotator-shapes.test.js から node:test で直接検証できる。
// SVG 要素を実際に作る buildShapeSvg() だけは document を必要とする(ブラウザ専用)。
//
// 画像(st.images[])は「キャンバス座標」を持つ(1枚目の画像を (0,0)・等倍に置いた
// 座標系で、v1 の「元画像ピクセル座標」と同じ意味)。画像の表示矩形(切り抜き後)は
// imageVisibleRect()、出力範囲(すべての画像 + 図形を囲む最小矩形)は
// computeOutputBounds() で求める。
//
// カギ線矢印(Excel の「カギ線コネクタ」)は type: 'arrow' のまま routing: 'elbow' を
// 持つ図形(routing が無ければ従来どおりの直線の矢印)。水平・垂直の線分だけで
// つなぐための経路計算を routeElbow()(疎な格子上のダイクストラ。DOM 非依存)が行い、
// computeElbowRoute() が図形の接続情報(from/to の attach・side)から
// routeElbow() の入力(端点・向き・障害物)を組み立てる。ELBOW_STUB は辺から
// まっすぐ出す長さ、ELBOW_BEND_PENALTY は経路が1回曲がるごとのコスト。
// nearestSide()/sidePoint()/facingSide() は辺(top/right/bottom/left)に関する
// 補助関数で、facingSide() は吹き出しのしっぽの辺選びとも共用している。
// computeArrowEndpoints()・getShapeVisualBounds()・buildShapeSvg() は
// shape.routing === 'elbow' のときだけ内部で分岐してカギ線に対応する
// (直線の矢印の挙動・出力は変えない)。

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

/** 出力サイズ(px)。bounds(w/h を持つ矩形。通常は computeOutputBounds の戻り値)× scale を四捨五入する(最低 1px) */
export function computeOutputSize(bounds, scale) {
  return {
    width: Math.max(1, Math.round(bounds.w * scale)),
    height: Math.max(1, Math.round(bounds.h * scale)),
  };
}

/** 2つの矩形の和集合(両方を含む最小の矩形)。どちらかが null/undefined ならもう片方をそのまま返す */
export function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/** 画像の「切り抜き後」の表示矩形(キャンバス座標) */
export function imageVisibleRect(img) {
  return {
    x: img.x + img.crop.x * img.scale,
    y: img.y + img.crop.y * img.scale,
    w: img.crop.w * img.scale,
    h: img.crop.h * img.scale,
  };
}

/** 画像の切り抜き前の全体の矩形(キャンバス座標)。切り抜きツール中の表示に使う */
export function imageFullRect(img) {
  return { x: img.x, y: img.y, w: img.width * img.scale, h: img.height * img.scale };
}

// crop 矩形の四隅のうち、compass('nw'|'ne'|'sw'|'se')が指す1点(元画像ピクセル座標)を返す
function cropCornerPoint(crop, compass) {
  return {
    x: compass.includes('w') ? crop.x : crop.x + crop.w,
    y: compass.includes('n') ? crop.y : crop.y + crop.h,
  };
}

const OPPOSITE_CORNER = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };

/**
 * 選択ツールでの画像の拡大縮小(四隅のハンドル)。縦横比(crop.w / crop.h)は img.scale
 * という単一の係数でしか変わらないため、常に保たれる。反対側の角(表示矩形
 * imageVisibleRect() の corner の対角)を固定したまま、ドラッグ中の角から反対側の角へ
 * 向かう対角線上に pt を投影し、その長さの比で新しい scale を決める(pt が対角線から
 * 外れていても破綻しないよう投影を使う。draw.io 等と同じ「対角ドラッグで比例拡大」)。
 * minSize: 表示矩形の短い方の辺がこれを下回らないように scale をクランプする(キャンバスpx)。
 * 戻り値: 新しい { x, y, scale }(呼び出し側が img にそのまま代入する)。純粋関数(DOM非依存)。
 */
export function resizeImageFromCorner(img, corner, pt, minSize = 16) {
  const rect = imageVisibleRect(img);
  const corners = {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.w, y: rect.y },
    sw: { x: rect.x, y: rect.y + rect.h },
    se: { x: rect.x + rect.w, y: rect.y + rect.h },
  };
  const anchorCompass = OPPOSITE_CORNER[corner];
  const anchor = corners[anchorCompass];
  const orig = corners[corner];

  const diagX = orig.x - anchor.x;
  const diagY = orig.y - anchor.y;
  const diagLen = Math.hypot(diagX, diagY) || 1;
  const ux = diagX / diagLen;
  const uy = diagY / diagLen;
  const proj = (pt.x - anchor.x) * ux + (pt.y - anchor.y) * uy;
  const factor = Math.max(proj, 0) / diagLen;

  const minScale = minSize / Math.max(Math.min(img.crop.w, img.crop.h), 1e-6);
  const newScale = Math.max(img.scale * factor, minScale);

  const anchorCropPt = cropCornerPoint(img.crop, anchorCompass);
  return {
    x: anchor.x - anchorCropPt.x * newScale,
    y: anchor.y - anchorCropPt.y * newScale,
    scale: newScale,
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

/**
 * 図形の「見た目の外枠」(キャンバス座標)。computeOutputBounds() が出力範囲を
 * 求めるのに使う(見た目からはみ出た部分が出力で切れてしまわないようにするため)。
 *   rect: 矩形を線幅の半分だけ外側に広げたもの。
 *   arrow: 線の両端(線幅の半分を加味)と矢じりの三角形の頂点をすべて含む矩形。
 *   callout: 枠(computeCalloutBox)+ しっぽの先端を含み、線幅の半分だけ外側に広げたもの。
 * shapesById は矢印の接続解決に使う(computeArrowEndpoints に渡すのと同じもの)。
 */
export function getShapeVisualBounds(shape, shapesById = {}, measureFn = measureTextWidth) {
  const half = (shape.strokeWidth || 0) / 2;
  if (shape.type === 'rect') {
    const r = normalizeRect(shape);
    return { x: r.x - half, y: r.y - half, w: r.w + half * 2, h: r.h + half * 2 };
  }
  if (shape.type === 'arrow') {
    // カギ線は経路の全折れ点を、直線は両端の2点だけを使う(矢じりの向きは
    // 最後の線分で決める)。これで直線側の計算・出力は完全に元のまま
    let points;
    let angle;
    if (shape.routing === 'elbow') {
      const route = computeElbowRoute(shape, shapesById, measureFn);
      points = route.points;
      const last = points[points.length - 1];
      const prev = points[points.length - 2] || points[0];
      angle = Math.atan2(last.y - prev.y, last.x - prev.x);
    } else {
      const { from, to } = computeArrowEndpoints(shape, shapesById, measureFn);
      points = [from, to];
      angle = Math.atan2(to.y - from.y, to.x - from.x);
    }
    const to = points[points.length - 1];
    const headVertices = arrowheadVertices(to.x, to.y, angle, arrowHeadSize(shape.strokeWidth));
    const allPoints = [...points, ...headVertices];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of allPoints) {
      minX = Math.min(minX, p.x - half);
      minY = Math.min(minY, p.y - half);
      maxX = Math.max(maxX, p.x + half);
      maxY = Math.max(maxY, p.y + half);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (shape.type === 'callout') {
    const box = computeCalloutBox(shape, measureFn);
    let minX = box.x - half;
    let minY = box.y - half;
    let maxX = box.x + box.w + half;
    let maxY = box.y + box.h + half;
    if (shape.tail) {
      minX = Math.min(minX, shape.tail.x);
      minY = Math.min(minY, shape.tail.y);
      maxX = Math.max(maxX, shape.tail.x);
      maxY = Math.max(maxY, shape.tail.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: shape.x || 0, y: shape.y || 0, w: 0, h: 0 };
}

/**
 * 出力範囲(キャンバス座標)。すべての画像の表示矩形(imageVisibleRect)と、
 * すべての図形の見た目の外枠(getShapeVisualBounds)の和集合。
 * 画像が1枚だけで、注釈がその画像の内側に収まっていれば、その画像の表示矩形と
 * 一致する(= v1 と同じ出力になる)。images・shapes がどちらも空なら幅・高さ0を返す
 * (呼び出し側で最低1pxに丸められる: computeOutputSize)。
 */
export function computeOutputBounds(images, shapes, measureFn = measureTextWidth) {
  const shapesMap = {};
  for (const s of shapes) shapesMap[s.id] = s;
  let bounds = null;
  for (const img of images) {
    bounds = unionRect(bounds, imageVisibleRect(img));
  }
  for (const shape of shapes) {
    bounds = unionRect(bounds, getShapeVisualBounds(shape, shapesMap, measureFn));
  }
  return bounds || { x: 0, y: 0, w: 0, h: 0 };
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
  if (shape.routing === 'elbow') {
    // カギ線は経路(routeElbow の結果)の先頭・末尾を両端とする
    const { points } = computeElbowRoute(shape, shapesById, measureFn);
    return { from: points[0], to: points[points.length - 1] };
  }
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

// ---------- カギ線(elbow)矢印の経路計算 ----------
// routing: 'elbow' の矢印(Excel の「カギ線コネクタ」)のための、DOM に依存しない
// 純粋な幾何計算。水平・垂直の線分だけで両端をつなぐ経路を、疎な格子上の
// ダイクストラで探す(candidateの数は多くても十数×十数点なので軽い)。

/** 辺からまっすぐ出す長さ(キャンバスpx)。つないだ枠の辺の中点から、この距離だけ
 * 外向きに直進してから曲がる(Excel のカギ線コネクタと同じ見た目にするため) */
export const ELBOW_STUB = 16;

/** 経路が1回曲がるごとに加える仮想の距離(px)。ELBOW_STUB(16px)の3倍程度にして
 * あり、「短いが曲がる経路」より「多少長いが曲がらない経路」を優先させるのに十分な
 * 値になっている(向かい合う辺・後ろ向きの辺のテストで、余計な曲がりが増えない
 * ことを確認している) */
export const ELBOW_BEND_PENALTY = 48;

const OPPOSITE_DIR = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// 点から線分 a→b までの最短距離
function distanceToSegment(a, b, point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq, 0, 1);
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/** box の4辺(top/right/bottom/left)を線分として、point に最も近い辺を返す。
 * 同距離なら top, right, bottom, left の順で先に定義した方を選ぶ */
export function nearestSide(box, point) {
  const tl = { x: box.x, y: box.y };
  const tr = { x: box.x + box.w, y: box.y };
  const br = { x: box.x + box.w, y: box.y + box.h };
  const bl = { x: box.x, y: box.y + box.h };
  const sides = [
    ['top', tl, tr],
    ['right', tr, br],
    ['bottom', bl, br],
    ['left', tl, bl],
  ];
  let best = 'top';
  let bestDist = Infinity;
  for (const [name, a, b] of sides) {
    const d = distanceToSegment(a, b, point);
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

/** box の指定した辺('top'|'right'|'bottom'|'left')の中点 */
export function sidePoint(box, side) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (side === 'top') return { x: cx, y: box.y };
  if (side === 'bottom') return { x: cx, y: box.y + box.h };
  if (side === 'left') return { x: box.x, y: cy };
  return { x: box.x + box.w, y: cy }; // 'right'
}

/**
 * box の縦横比で正規化した座標系で、point の方向に一番近い辺を返す
 * ('top'|'right'|'bottom'|'left')。カギ線でつないだ端の side が未指定のときの
 * 自動選択と、吹き出しのしっぽの辺選び(buildCalloutPath)の両方で使う
 */
export function facingSide(box, point) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const nx = (point.x - cx) / (box.w / 2 || 1);
  const ny = (point.y - cy) / (box.h / 2 || 1);
  if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'right' : 'left';
  return ny > 0 ? 'bottom' : 'top';
}

// rect を margin だけ四方に広げた矩形
function expandRect(rect, margin) {
  return { x: rect.x - margin, y: rect.y - margin, w: rect.w + margin * 2, h: rect.h + margin * 2 };
}

// 点 (x,y) が rect の内側(境界は含まない)にあるか
function pointInsideRect(rect, x, y) {
  return x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h;
}

// 水平または垂直な線分 a→b が rect の内側を通るか(境界に触れるだけ・角で接するだけなら許可)
function axisSegmentCrossesRect(a, b, rect) {
  if (a.x === b.x) {
    if (a.x <= rect.x || a.x >= rect.x + rect.w) return false;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return hi > rect.y && lo < rect.y + rect.h;
  }
  if (a.y === b.y) {
    if (a.y <= rect.y || a.y >= rect.y + rect.h) return false;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return hi > rect.x && lo < rect.x + rect.w;
  }
  return false; // 斜めの線分は想定しない
}

// dir 方向へ dist だけ進めた点(dir は外向きの辺の名前 = 移動方向として共用する)
function stubPoint(pt, dir, dist) {
  if (dir === 'top') return { x: pt.x, y: pt.y - dist };
  if (dir === 'bottom') return { x: pt.x, y: pt.y + dist };
  if (dir === 'left') return { x: pt.x - dist, y: pt.y };
  return { x: pt.x + dist, y: pt.y }; // 'right'
}

// a→b の移動方向('top'|'right'|'bottom'|'left')。水平・垂直以外は null
function travelDirOf(a, b) {
  if (a.x === b.x && a.y !== b.y) return b.y > a.y ? 'bottom' : 'top';
  if (a.y === b.y && a.x !== b.x) return b.x > a.x ? 'right' : 'left';
  return null;
}

// 重複点・一直線上(水平/垂直が連続する)途中点を取り除く
function simplifyPoints(points) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    pts.push({ x: p.x, y: p.y });
  }
  let i = 1;
  while (i < pts.length - 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    if ((a.y === b.y && b.y === c.y) || (a.x === b.x && b.x === c.x)) {
      pts.splice(i, 1);
    } else {
      i++;
    }
  }
  return pts;
}

/**
 * S・E を結ぶ「横→縦→横」または「縦→横→縦」の経路を作る(両端とも向きの制約が
 * 無いときの経路そのもの、および接続経路が見つからないときのフォールバックの
 * 中央部分に使う)。dx か dy が 0 なら1本の直線になる(axis は null)
 */
function buildSimpleZ(S, E, mid) {
  const dx = E.x - S.x;
  const dy = E.y - S.y;
  if (dx === 0 || dy === 0) {
    return { points: [{ x: S.x, y: S.y }, { x: E.x, y: E.y }], axis: null };
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = S.x + dx * mid;
    return {
      points: [{ x: S.x, y: S.y }, { x: midX, y: S.y }, { x: midX, y: E.y }, { x: E.x, y: E.y }],
      axis: 'x',
    };
  }
  const midY = S.y + dy * mid;
  return {
    points: [{ x: S.x, y: S.y }, { x: S.x, y: midY }, { x: E.x, y: midY }, { x: E.x, y: E.y }],
    axis: 'y',
  };
}

/**
 * 簡約後の経路が「平行で同じ向きの2本の線分に挟まれた、それに垂直な1本の線分」
 * (= Z字。ちょうど4点)のとき、その中央の線分を mid の位置に置き直し、
 * { axis, lo, hi, index } を返す(axis は中央の線分が動く軸、lo/hi は動かせる範囲、
 * index は中央の線分の始点の points 内の添字 = 常に1)。置き直すと障害物の内側を
 * 通ってしまう場合は points はそのまま(置き直さない)にして、範囲の情報だけ返す。
 * Z字でなければ null(points も変えない)
 */
function computeMidSegment(points, start, end, S, E, P, Q, mid, blockRects) {
  if (points.length !== 4) return null;
  const [p0, p1, p2, p3] = points;
  const s1 = { dx: p1.x - p0.x, dy: p1.y - p0.y };
  const s2 = { dx: p2.x - p1.x, dy: p2.y - p1.y };
  const s3 = { dx: p3.x - p2.x, dy: p3.y - p2.y };

  let axis; // 中央の線分(s2)の位置を表す軸('x' = 縦の線がx位置で動く、'y' = 横の線がy位置で動く)
  if (s2.dx === 0 && s2.dy !== 0) axis = 'x';
  else if (s2.dy === 0 && s2.dx !== 0) axis = 'y';
  else return null;

  const ok = axis === 'x'
    ? s1.dy === 0 && s3.dy === 0 && s1.dx !== 0 && s3.dx !== 0 && Math.sign(s1.dx) === Math.sign(s3.dx)
    : s1.dx === 0 && s3.dx === 0 && s1.dy !== 0 && s3.dy !== 0 && Math.sign(s1.dy) === Math.sign(s3.dy);
  if (!ok) return null;

  const lo = start.dir ? P[axis] : S[axis];
  const hi = end.dir ? Q[axis] : E[axis];
  const target = lo + (hi - lo) * mid;

  const np1 = axis === 'x' ? { x: target, y: p1.y } : { x: p1.x, y: target };
  const np2 = axis === 'x' ? { x: target, y: p2.y } : { x: p2.x, y: target };
  // 前後の線分の判定は S→P・Q→E の強制区間(自分がつながっている枠のすぐそば)を
  // 除外する。S・E は接続先の枠の辺の上にあり、その枠自身の障害物判定の内側に
  // 入ってしまうため(P・Q は ELBOW_STUB 分離れているので判定の対象外になる)
  const checkStart = start.dir ? P : p0;
  const checkEnd = end.dir ? Q : p3;
  const crosses = blockRects.some(
    (r) => axisSegmentCrossesRect(checkStart, np1, r) || axisSegmentCrossesRect(np1, np2, r) || axisSegmentCrossesRect(np2, checkEnd, r)
  );
  if (!crosses) {
    points[1].x = np1.x;
    points[1].y = np1.y;
    points[2].x = np2.x;
    points[2].y = np2.y;
  }
  return { axis, lo, hi, index: 1 };
}

/**
 * カギ線の経路を求める(水平・垂直の線分だけ。先頭 = 始点、末尾 = 終点)。
 * start / end: { x, y, dir }。dir はつないだ辺の外向き('top' 等)、つながっていない
 * 端は null。obstacles はつないだ枠の矩形(元の大きさ。避けて通る)。mid は
 * 中央の線の位置(0〜1)。opts.stub / opts.bendPenalty でテスト用に既定値を上書きできる。
 * 戻り値: { points, midSegment }(midSegment は Z字のときだけ非null。中央の線の
 * ハンドル用の情報)
 */
export function routeElbow(start, end, obstacles = [], mid = 0.5, opts = {}) {
  const stub = opts.stub ?? ELBOW_STUB;
  const bendPenalty = opts.bendPenalty ?? ELBOW_BEND_PENALTY;
  const S = { x: start.x, y: start.y };
  const E = { x: end.x, y: end.y };

  // 両端とも向きの制約が無ければ、障害物を考えずにシンプルな Z字(または直線)にする
  if (!start.dir && !end.dir) {
    const { points, axis } = buildSimpleZ(S, E, mid);
    const midSegment = axis ? { axis, lo: S[axis], hi: E[axis], index: 1 } : null;
    return { points, midSegment };
  }

  const P = start.dir ? stubPoint(S, start.dir, stub) : S;
  const Q = end.dir ? stubPoint(E, end.dir, stub) : E;

  // 障害物を通行禁止の判定用に少しだけ広げる(候補座標の生成に使う ELBOW_STUB とは別)
  const blockRects = obstacles.map((o) => expandRect(o, stub / 2));

  // ---- 候補座標(疎な格子)を集める ----
  const xsSet = new Set([S.x, E.x, P.x, Q.x, (P.x + Q.x) / 2]);
  const ysSet = new Set([S.y, E.y, P.y, Q.y, (P.y + Q.y) / 2]);
  for (const o of obstacles) {
    xsSet.add(o.x - stub);
    xsSet.add(o.x + o.w + stub);
    ysSet.add(o.y - stub);
    ysSet.add(o.y + o.h + stub);
  }
  const xs = [...xsSet];
  const ys = [...ysSet];

  // ---- ノード生成(S, E, P, Q は常にノード。それ以外は広げた障害物の内側でない点だけ) ----
  const nodeIndexByKey = new Map();
  const nodes = [];
  function addNode(x, y) {
    const key = `${x},${y}`;
    let idx = nodeIndexByKey.get(key);
    if (idx === undefined) {
      idx = nodes.length;
      nodes.push({ x, y });
      nodeIndexByKey.set(key, idx);
    }
    return idx;
  }
  for (const x of xs) {
    for (const y of ys) {
      if (!blockRects.some((r) => pointInsideRect(r, x, y))) addNode(x, y);
    }
  }
  const sIdx = addNode(S.x, S.y);
  const eIdx = addNode(E.x, E.y);
  const pIdx = addNode(P.x, P.y);
  const qIdx = addNode(Q.x, Q.y);

  // ---- 辺生成: 同じ x / 同じ y の上で隣り合うノードどうしを結ぶ(障害物を横切るものは除く)。
  // つないだ端(S・E)は辺からの強制直進(S→P・Q→E)以外の辺を持たない
  const adj = nodes.map(() => []);
  function addEdge(iA, iB) {
    const a = nodes[iA];
    const b = nodes[iB];
    const dirAB = travelDirOf(a, b);
    if (!dirAB) return;
    const cost = Math.hypot(b.x - a.x, b.y - a.y);
    adj[iA].push({ to: iB, dir: dirAB, cost });
    adj[iB].push({ to: iA, dir: OPPOSITE_DIR[dirAB], cost });
  }
  const excludeFromMesh = new Set();
  if (start.dir) excludeFromMesh.add(sIdx);
  if (end.dir) excludeFromMesh.add(eIdx);

  const byX = new Map();
  const byY = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!byX.has(n.x)) byX.set(n.x, []);
    byX.get(n.x).push(i);
    if (!byY.has(n.y)) byY.set(n.y, []);
    byY.get(n.y).push(i);
  }
  for (const list of byX.values()) {
    list.sort((i, j) => nodes[i].y - nodes[j].y);
    for (let k = 0; k < list.length - 1; k++) {
      const iA = list[k];
      const iB = list[k + 1];
      if (excludeFromMesh.has(iA) || excludeFromMesh.has(iB)) continue;
      if (blockRects.some((r) => axisSegmentCrossesRect(nodes[iA], nodes[iB], r))) continue;
      addEdge(iA, iB);
    }
  }
  for (const list of byY.values()) {
    list.sort((i, j) => nodes[i].x - nodes[j].x);
    for (let k = 0; k < list.length - 1; k++) {
      const iA = list[k];
      const iB = list[k + 1];
      if (excludeFromMesh.has(iA) || excludeFromMesh.has(iB)) continue;
      if (blockRects.some((r) => axisSegmentCrossesRect(nodes[iA], nodes[iB], r))) continue;
      addEdge(iA, iB);
    }
  }

  // 強制区間(障害物チェックの対象外): S→P、Q→E
  if (start.dir) {
    adj[sIdx].push({ to: pIdx, dir: start.dir, cost: Math.hypot(P.x - S.x, P.y - S.y) });
  }
  if (end.dir) {
    adj[qIdx].push({ to: eIdx, dir: OPPOSITE_DIR[end.dir], cost: Math.hypot(E.x - Q.x, E.y - Q.y) });
  }

  // ---- ダイクストラ: 状態 = (ノード, 到着方向)。逆走(180度)は禁止、
  // 方向が変わるたびに bendPenalty を加える ----
  const DIRS = ['top', 'right', 'bottom', 'left'];
  const dist = new Map();
  const prev = new Map();
  const stateKey = (node, dir) => `${node}|${dir || 'none'}`;

  const startKey = stateKey(sIdx, null);
  dist.set(startKey, 0);
  const queue = [{ node: sIdx, dir: null, cost: 0 }];
  const settled = new Set();

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift();
    const key = stateKey(cur.node, cur.dir);
    if (settled.has(key)) continue;
    settled.add(key);

    for (const edge of adj[cur.node]) {
      if (cur.dir && edge.dir === OPPOSITE_DIR[cur.dir]) continue; // 逆走禁止
      const bend = cur.dir && edge.dir !== cur.dir ? bendPenalty : 0;
      const newCost = cur.cost + edge.cost + bend;
      const newKey = stateKey(edge.to, edge.dir);
      if (newCost < (dist.get(newKey) ?? Infinity)) {
        dist.set(newKey, newCost);
        prev.set(newKey, { node: cur.node, dir: cur.dir });
        queue.push({ node: edge.to, dir: edge.dir, cost: newCost });
      }
    }
  }

  let bestDir = null;
  let bestCost = Infinity;
  for (const dir of [null, ...DIRS]) {
    const c = dist.get(stateKey(eIdx, dir));
    if (c !== undefined && c < bestCost) {
      bestCost = c;
      bestDir = dir;
    }
  }

  let rawPoints;
  if (bestCost === Infinity) {
    // ---- フォールバック: 障害物を無視した S→P→(中央)→Q→E の Z字。必ず何か返す ----
    const core = buildSimpleZ(P, Q, mid).points;
    rawPoints = [];
    if (start.dir) rawPoints.push(S);
    rawPoints.push(...core);
    if (end.dir) rawPoints.push(E);
  } else {
    const chain = [];
    let k = stateKey(eIdx, bestDir);
    for (;;) {
      const nodeIdx = Number(k.split('|')[0]);
      chain.push(nodeIdx);
      const p = prev.get(k);
      if (!p) break;
      k = stateKey(p.node, p.dir);
    }
    chain.reverse();
    rawPoints = chain.map((i) => ({ x: nodes[i].x, y: nodes[i].y }));
  }

  const points = simplifyPoints(rawPoints);
  const midSegment = computeMidSegment(points, start, end, S, E, P, Q, mid, blockRects);
  return { points, midSegment };
}

/**
 * shape(routing: 'elbow' の矢印)から routeElbow() の入力を組み立てて経路を求める。
 * つないだ端は sidePoint(box, side || facingSide(box, 相手の端の位置)) を使い、
 * dir はその辺、障害物はつないだ枠の外周(getShapeOutlineBox)。相手の端の位置は、
 * 相手もつながっていればその枠の中心、なければ生座標
 */
export function computeElbowRoute(shape, shapesById = {}, measureFn = measureTextWidth) {
  const mid = shape.mid ?? 0.5;
  const obstacles = [];

  function otherPosition(endpoint) {
    const target = endpoint.attach ? shapesById[endpoint.attach] : null;
    if (!target) return { x: endpoint.x, y: endpoint.y };
    const box = getShapeOutlineBox(target, measureFn);
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }

  function resolveEnd(endpoint, otherEndpoint) {
    const target = endpoint.attach ? shapesById[endpoint.attach] : null;
    if (!target) return { x: endpoint.x, y: endpoint.y, dir: null };
    const box = getShapeOutlineBox(target, measureFn);
    obstacles.push(box);
    const side = endpoint.side || facingSide(box, otherPosition(otherEndpoint));
    const pt = sidePoint(box, side);
    return { x: pt.x, y: pt.y, dir: side };
  }

  const start = resolveEnd(shape.from, shape.to);
  const end = resolveEnd(shape.to, shape.from);
  return routeElbow(start, end, obstacles, mid);
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
  const edge = tail ? facingSide(box, tail) : null;
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

/** 矢印線の太さ(strokeWidth)から矢じり(三角形)の大きさを決める。buildShapeSvg と
 * getShapeVisualBounds の両方で使うことで、矢じりの大きさの計算を二重に持たないようにする */
export function arrowHeadSize(strokeWidth) {
  return Math.max(10, (strokeWidth || 0) * 3);
}

/** 矢じり(三角形)の3頂点の座標配列({x,y}[])を返す。1点目が先端(tip)。
 * buildShapeSvg(描画)と getShapeVisualBounds(出力範囲の計算)の両方から呼ぶことで、
 * 矢じりの頂点計算を二重に持たないようにする */
export function arrowheadVertices(tipX, tipY, angle, size) {
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  return [
    { x: tipX, y: tipY },
    { x: tipX + size * Math.cos(a1), y: tipY + size * Math.sin(a1) },
    { x: tipX + size * Math.cos(a2), y: tipY + size * Math.sin(a2) },
  ];
}

// 矢じり(三角形)の頂点座標を "x,y x,y x,y" の points 文字列にする(<polygon> 用)
function arrowheadPoints(tipX, tipY, angle, size) {
  return arrowheadVertices(tipX, tipY, angle, size)
    .map((p) => `${p.x},${p.y}`)
    .join(' ');
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
  } else if (shape.type === 'arrow' && shape.routing === 'elbow') {
    // カギ線: 折れ点をつないだ <polyline>(直線の矢印と同じく、矢じりの分だけ
    // 最後の線分を手前で止める。矢じりの向きは最後の線分で決める)
    const route = computeElbowRoute(shape, shapesById, measureFn);
    const pts = route.points;
    const headSize = arrowHeadSize(shape.strokeWidth);
    const last = pts[pts.length - 1];
    const prevPt = pts[pts.length - 2] || pts[0];
    const angle = Math.atan2(last.y - prevPt.y, last.x - prevPt.x);
    const lineEnd = {
      x: last.x - Math.cos(angle) * headSize * 0.4,
      y: last.y - Math.sin(angle) * headSize * 0.4,
    };
    const drawPoints = [...pts.slice(0, -1), lineEnd];
    const polyline = doc.createElementNS(SVG_NS, 'polyline');
    setAttrs(polyline, {
      points: drawPoints.map((p) => `${p.x},${p.y}`).join(' '),
      fill: 'none',
      stroke: shape.stroke,
      'stroke-width': shape.strokeWidth,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    });
    g.appendChild(polyline);
    const head = doc.createElementNS(SVG_NS, 'polygon');
    setAttrs(head, { points: arrowheadPoints(last.x, last.y, angle, headSize), fill: shape.stroke });
    g.appendChild(head);
    g.setAttribute('data-routing', 'elbow');
  } else if (shape.type === 'arrow') {
    const { from, to } = computeArrowEndpoints(shape, shapesById, measureFn);
    const headSize = arrowHeadSize(shape.strokeWidth);
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
