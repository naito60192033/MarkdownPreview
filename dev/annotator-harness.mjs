// dev/annotator-harness.mjs
//
// `node dev/annotator-harness.mjs` で走る画像注釈エディタ(src/annotator/)専用の
// E2E テストランナー。dev/harness.mjs と同じ構成(外部フレームワークを使わない
// 自前の test() ヘルパー、waitFor、browserEnv、1件も実行されなければ失敗)を踏襲する。
// `file://` で開いた test-output/annotator-sandbox.html をヘッドレス Chromium で
// 操作する(先に `node dev/build-annotator-sandbox.mjs` でビルドしておくこと)。
//
// 図形の作成・選択・移動などは実際のマウス操作(page.mouse)でモーダルの DOM に対して
// 行う。window.__annotator フックは「テスト画像の用意」「保存結果の検証」など
// マウス操作だけでは完結しない部分に限って使う(dev/annotator-sandbox/main.js 参照)。
//
// CLI:
//   node dev/annotator-harness.mjs                  全テストを1回
//   node dev/annotator-harness.mjs --only=undo       テスト「名」に部分一致するものだけ
//   node dev/annotator-harness.mjs --repeat=5        全体を5回繰り返す(フレーク検出用)
//
// 前提: 開発コンテナでは先に `bash dev/setup-container.sh` を1度実行しておく。

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { computeArrowEndpoints, ELBOW_STUB } from '../src/annotator/shapes.js';
import {
  serializeChunks,
  encodeITxt,
  replaceOrInsertChunk,
  ANNOTATION_KEYWORD,
  ORIGINAL_IMAGE_CHUNK_TYPE,
} from '../src/annotator/pngmeta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SANDBOX_HTML = path.join(REPO_ROOT, 'test-output', 'annotator-sandbox.html');
const SANDBOX_URL = 'file://' + SANDBOX_HTML;

// ---------- CLI 引数 ----------
const ARGV = process.argv.slice(2);
function argValue(flag) {
  const hit = ARGV.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}
const ONLY = argValue('--only');
const REPEAT = Math.max(1, Number(argValue('--repeat')) || 1);

// dev/harness.mjs と同じ: /tmp/chromedeps があれば Chromium 実行に必要な
// 共有ライブラリ・フォント設定を自動で参照する。
const DEPS_ROOT = '/tmp/chromedeps';
const DEFAULT_LD_LIBRARY_PATH = [
  `${DEPS_ROOT}/usr/lib/x86_64-linux-gnu`,
  `${DEPS_ROOT}/lib/x86_64-linux-gnu`,
  `${DEPS_ROOT}/usr/lib`,
].join(':');
const DEFAULT_FONTCONFIG_FILE = `${DEPS_ROOT}/etc/fonts/fonts.conf`;

function browserEnv() {
  const env = { ...process.env };
  if (!env.LD_LIBRARY_PATH && existsSync(DEPS_ROOT)) {
    env.LD_LIBRARY_PATH = DEFAULT_LD_LIBRARY_PATH;
  }
  if (!env.FONTCONFIG_FILE && existsSync(DEFAULT_FONTCONFIG_FILE)) {
    env.FONTCONFIG_FILE = DEFAULT_FONTCONFIG_FILE;
    env.FONTCONFIG_PATH = path.dirname(DEFAULT_FONTCONFIG_FILE);
  }
  return env;
}

// ---------- 自前の test() ヘルパー(dev/harness.mjs と同じ形) ----------
let passCount = 0;
let failCount = 0;
let skipCount = 0;
const failedNames = [];

async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) {
    skipCount++;
    return;
  }
  const start = Date.now();
  try {
    await fn();
    passCount++;
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${Date.now() - start}ms)\x1b[0m`);
  } catch (e) {
    failCount++;
    failedNames.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    const detail = e && e.stack ? e.stack : String(e);
    console.log(
      detail
        .split('\n')
        .map((l) => '      ' + l)
        .join('\n')
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 5000, interval = 50, message = '条件が満たされませんでした' } = {}) {
  const start = Date.now();
  let lastErr;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start >= timeout) {
      throw new Error(message + (lastErr ? `(直近のエラー: ${lastErr.message})` : ''));
    }
    await sleep(interval);
  }
}

function attachDebugLogging(page, consoleErrors) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push('pageerror: ' + (err.stack || err.message || String(err)));
  });
}

function printConsoleErrors(consoleErrors, label) {
  if (consoleErrors.length === 0) return;
  console.log(`    \x1b[33m[console] ${label} で ${consoleErrors.length} 件のエラーが記録されました:\x1b[0m`);
  for (const line of consoleErrors) {
    console.log('      ' + line.split('\n').join('\n      '));
  }
}

async function ensureHooks(page) {
  await waitFor(async () => page.evaluate(() => typeof window.__annotator !== 'undefined'), {
    message: 'window.__annotator が未定義のままです',
  });
}

// 1 ページを用意して fn に渡す(annotator は fs を扱わないので fake-fs は不要)。
async function withPage(browser, fn) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  attachDebugLogging(page, consoleErrors);
  await page.goto(SANDBOX_URL);
  await ensureHooks(page);
  try {
    return await fn({ page, consoleErrors });
  } finally {
    await context.close();
  }
}

// ---------- 座標変換・マウス操作のヘルパー ----------

// キャンバス座標(1枚目の画像は (0,0) に等倍で置かれるため元画像ピクセル座標と
// 一致する)→ 画面上のクライアント座標。エディタは無限キャンバス(viewBox を
// カメラとして動かす方式)になっているため、カメラ位置(camera)も差し引く。
async function imgToClient(page, x, y) {
  const box = await page.evaluate(() => window.__annotator.getSvgBox());
  const st = await page.evaluate(() => window.__annotator.getDebugState());
  return { x: box.left + (x - st.camera.x) * st.zoom, y: box.top + (y - st.camera.y) * st.zoom };
}

// 画像座標系での (fromX,fromY) → (toX,toY) へのドラッグ
async function dragOnCanvas(page, from, to) {
  const c1 = await imgToClient(page, from.x, from.y);
  const c2 = await imgToClient(page, to.x, to.y);
  await page.mouse.move(c1.x, c1.y);
  await page.mouse.down();
  await page.mouse.move((c1.x + c2.x) / 2, (c1.y + c2.y) / 2, { steps: 3 });
  await page.mouse.move(c2.x, c2.y, { steps: 3 });
  await page.mouse.up();
}

// 画像座標系での単純クリック(ドラッグとみなされない程度の移動のみ)
async function clickOnCanvas(page, pt) {
  const c = await imgToClient(page, pt.x, pt.y);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
}

async function selectTool(page, tool) {
  await page.click(`.annotator-tool-btn[data-tool="${tool}"]`);
}

async function openWithTestImage(page, opts) {
  await page.evaluate((o) => window.__annotator.createTestImage(o), opts);
  await page.evaluate(() => window.__annotator.open('source'));
  await waitFor(async () => page.evaluate(() => window.__annotator.isOpen()), {
    message: '注釈エディタのモーダルが開きませんでした',
  });
}

async function reopenLastResult(page) {
  await page.evaluate(() => window.__annotator.open('lastResult'));
  await waitFor(async () => page.evaluate(() => window.__annotator.isOpen()), {
    message: '保存結果を再度開けませんでした',
  });
}

// 保存ボタンを押してモーダルが閉じる(= Blob が確定する)までの時間を計測する。
// label を渡すとテスト出力に「保存にかかった時間」として表示する
// (大きな画像でのパフォーマンス確認のため)。
async function saveAndWaitClosed(page, { label = null, timeout = 8000 } = {}) {
  const start = Date.now();
  await page.click('[data-action="save"]');
  await waitFor(async () => !(await page.evaluate(() => window.__annotator.isOpen())), {
    message: '保存後にモーダルが閉じませんでした',
    timeout,
  });
  await waitFor(async () => !(await page.evaluate(() => window.__annotator.isPending())), {
    message: '保存の Promise が解決しませんでした',
    timeout,
  });
  const elapsedMs = Date.now() - start;
  if (label) {
    console.log(`    \x1b[36m[timing]\x1b[0m ${label}: ${elapsedMs}ms`);
  }
  return elapsedMs;
}

async function getDebugState(page) {
  return page.evaluate(() => window.__annotator.getDebugState());
}

// 吹き出しのテキスト編集用 textarea の表示/非表示を待つ(作成直後・ダブルクリック・
// Enter/F2 のいずれで開いた場合も同じ .annotator-text-editor を使うため共通化する)
async function waitForTextEditorVisible(page) {
  await waitFor(
    async () =>
      page.evaluate(() => {
        const el = document.querySelector('.annotator-text-editor');
        return el && el.style.display !== 'none';
      }),
    { message: 'テキスト編集用の textarea が表示されませんでした' }
  );
}

async function waitForTextEditorHidden(page) {
  await waitFor(
    async () =>
      page.evaluate(() => {
        const el = document.querySelector('.annotator-text-editor');
        return el && el.style.display === 'none';
      }),
    { message: 'テキスト編集用の textarea が非表示になりませんでした' }
  );
}

async function getTextEditorValue(page) {
  return page.evaluate(() => document.querySelector('.annotator-text-editor').value);
}

async function getTextEditorWidthPx(page) {
  return page.evaluate(() => parseFloat(document.querySelector('.annotator-text-editor').style.width));
}

// 矢印の実際の描画座標を読む。始点は <line> の x1/y1 でそのまま取れるが、
// 終点は矢じり(<polygon>)の分だけ <line> の x2/y2 が手前で止められているため、
// 矢じりの先端(points の1点目 = 実際の to 座標)から読む(shapes.js の
// arrowheadPoints() の実装に合わせる)。
async function getArrowLine(page, shapeId) {
  return page.evaluate((id) => {
    const g = document.querySelector(`.annotator-shapes-layer [data-shape-id="${id}"]`);
    const line = g.querySelector('line');
    const polygon = g.querySelector('polygon');
    const [tipX, tipY] = polygon
      .getAttribute('points')
      .split(' ')[0]
      .split(',')
      .map(Number);
    return {
      x1: Number(line.getAttribute('x1')),
      y1: Number(line.getAttribute('y1')),
      x2: tipX,
      y2: tipY,
    };
  }, shapeId);
}

function assertClose(actual, expected, tolerance, msg) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${msg}: expected≈${expected}, actual=${actual}`);
}

// カギ線(elbow)の <polyline> の点を [{x,y}, ...] で読む(shapesLayer 側。矢じりの分だけ
// 最後の点は手前で止められているが、同じ線分の向き上にあるので水平・垂直の確認には使える)。
async function getElbowPolylinePoints(page, shapeId) {
  return page.evaluate((id) => {
    const g = document.querySelector(`.annotator-shapes-layer [data-shape-id="${id}"]`);
    const polyline = g.querySelector('polyline');
    return polyline
      .getAttribute('points')
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      });
  }, shapeId);
}

// points の隣り合う各点が水平(同y)・垂直(同x)のどちらかでつながっていることを確認する
function assertAxisAlignedPolyline(points, msgPrefix) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    assert.ok(
      a.x === b.x || a.y === b.y,
      `${msgPrefix}: 線分${i}が水平・垂直ではありません: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
    );
  }
}

// カギ線ツールの選択中に出る接続点(.annotator-connect-point)を読む
async function getConnectPoints(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.annotator-connect-point')).map((el) => ({
      side: el.getAttribute('data-side'),
      active: el.classList.contains('annotator-connect-point--active'),
    }))
  );
}

async function countConnectTargets(page) {
  return page.evaluate(() => document.querySelectorAll('.annotator-connect-target').length);
}

// ---------- カギ線テスト用の共通配置 ----------
// 赤枠A(左上、box: x50,y50,w100,h100)・B(右下、box: x350,y200,w100,h100)。
// A の右辺中点(150,100)→B の左辺中点(350,250)へ繋ぐと、向かい合う辺どうしの
// Z字(中央の縦線)になる(tests/annotator-shapes.test.js の「向かい合う辺」テストと同じ配置)。
const ELBOW_A_DRAG = [{ x: 50, y: 50 }, { x: 150, y: 150 }];
const ELBOW_B_DRAG = [{ x: 350, y: 200 }, { x: 450, y: 300 }];
const ELBOW_A_RIGHT = { x: 150, y: 100 };
const ELBOW_B_LEFT = { x: 350, y: 250 };

// 赤枠A・Bを描いてから、カギ線ツールでAの右辺中点→Bの左辺中点へ1回のドラッグでつなぐ
async function drawElbowAB(page) {
  await selectTool(page, 'rect');
  await dragOnCanvas(page, ELBOW_A_DRAG[0], ELBOW_A_DRAG[1]);
  await selectTool(page, 'rect');
  await dragOnCanvas(page, ELBOW_B_DRAG[0], ELBOW_B_DRAG[1]);
  await selectTool(page, 'elbow');
  await dragOnCanvas(page, ELBOW_A_RIGHT, ELBOW_B_LEFT);
}

function findRectByX(shapes, x) {
  return shapes.find((s) => s.type === 'rect' && s.x === x);
}

// ---------- PNG バイト列を Node 側で直接組み立てる(v1 形式の読み込みテスト用) ----------

// 指定サイズ・単色の最小限の PNG(フィルタ無し・非圧縮相当)を組み立てる。
// dev/harness.mjs の makeSolidPng() と同じアルゴリズム(pngmeta.js の
// serializeChunks() を使って IHDR/IDAT/IEND だけの PNG を作る)。
function makeSolidPngBytes(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // フィルタタイプ: none
    for (let x = 0; x < width; x++) {
      const off = rowStart + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunks = [
    { type: 'IHDR', data: new Uint8Array(ihdr) },
    { type: 'IDAT', data: new Uint8Array(idat) },
    { type: 'IEND', data: new Uint8Array(0) },
  ];
  return serializeChunks(chunks);
}

function makeSolidPngBuffer(width, height, rgb) {
  return Buffer.from(makeSolidPngBytes(width, height, rgb));
}

// v1形式(iTXt + mdOR。version:1・images配列を持たない古い保存形式)の注釈付きPNGを
// pngmeta.js の低レベル API で直接組み立てる(model.js の v1→v2 正規化の入力を
// 実際の PNG として再現するため)。base64 文字列を返す(sandbox の
// setSourceFromBase64 フック経由で Blob 化する)。
function buildV1AnnotatedPngBase64({ width, height, color, crop, shapes, scale = 1 }) {
  const baseBytes = makeSolidPngBytes(width, height, color);
  const json = {
    version: 1,
    original: { mime: 'image/png', width, height },
    crop,
    scale,
    shapes,
  };
  const itxtData = encodeITxt({ keyword: ANNOTATION_KEYWORD, text: JSON.stringify(json) });
  let out = replaceOrInsertChunk(baseBytes, { type: 'iTXt', data: itxtData }, () => false);
  out = replaceOrInsertChunk(out, { type: ORIGINAL_IMAGE_CHUNK_TYPE, data: baseBytes }, () => false);
  return Buffer.from(out).toString('base64');
}

// ---------- テスト本体 ----------

async function runTests(browser) {
  console.log('\n1) 赤枠2つを矢印でつなぎ、枠を動かすと矢印が追従する');
  await test('赤枠2つ + 矢印(接続) → 片方を動かすと端点が追従する', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 50, y: 50 }, { x: 150, y: 150 }); // rect1
      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 300, y: 50 }, { x: 400, y: 150 }); // rect2

      await selectTool(page, 'arrow');
      // rect1 の右辺中点 → rect2 の左辺中点(許容距離10px以内でぴったり辺上)
      await dragOnCanvas(page, { x: 150, y: 100 }, { x: 300, y: 100 });

      let st = await getDebugState(page);
      assert.equal(st.shapes.length, 3, '図形が3つ(rect,rect,arrow)になっていません');
      const rect1 = st.shapes.find((s) => s.type === 'rect' && s.x === 50);
      const rect2 = st.shapes.find((s) => s.type === 'rect' && s.x === 300);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      assert.ok(rect1 && rect2 && arrow, '期待した図形が見つかりません');
      assert.equal(arrow.from.attach, rect1.id, '矢印の始点が rect1 に接続していません');
      assert.equal(arrow.to.attach, rect2.id, '矢印の終点が rect2 に接続していません');

      const beforeLine = await getArrowLine(page, arrow.id);
      assertClose(beforeLine.x1, 150, 1, '移動前の矢印始点 x');
      assertClose(beforeLine.y1, 100, 1, '移動前の矢印始点 y');

      // rect1 を選択して下に移動する(中心(100,100) → (100,250))
      await selectTool(page, 'select');
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 100, y: 250 });

      st = await getDebugState(page);
      const movedRect1 = st.shapes.find((s) => s.id === rect1.id);
      assertClose(movedRect1.y, 200, 1, 'rect1 が想定どおり移動していません');

      // 期待値は shapes.js の幾何計算そのものを使って算出する(rect のみなので measureFn は不要)
      const shapesById = Object.fromEntries(st.shapes.map((s) => [s.id, s]));
      const expected = computeArrowEndpoints(arrow, shapesById, () => 0);

      const afterLine = await getArrowLine(page, arrow.id);
      assertClose(afterLine.x1, expected.from.x, 1, '移動後の矢印始点 x が追従していません');
      assertClose(afterLine.y1, expected.from.y, 1, '移動後の矢印始点 y が追従していません');
      // to 側も rect1 の移動で角度が変わるため、位置が変化しているはず
      assert.ok(Math.abs(afterLine.y2 - beforeLine.y2) > 1, '矢印の終点も追従して変化するはずです');
      assertClose(afterLine.x2, expected.to.x, 1, '移動後の矢印終点 x が想定と異なります');
      assertClose(afterLine.y2, expected.to.y, 1, '移動後の矢印終点 y が想定と異なります');

      printConsoleErrors(consoleErrors, '矢印の追従');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n2) 日本語テキストの吹き出し');
  await test('吹き出しツールで日本語テキストの吹き出しを作れる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });

      await waitFor(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector('.annotator-text-editor');
            return el && el.style.display !== 'none';
          }),
        { message: 'テキスト編集用の textarea が表示されませんでした' }
      );

      await page.fill('.annotator-text-editor', '日本語のテスト\n2行目');
      // Esc で「編集中のテキストがあれば確定」する仕様を確認する
      await page.keyboard.press('Escape');

      await waitFor(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector('.annotator-text-editor');
            return el.style.display === 'none';
          }),
        { message: 'Escape でテキスト編集が確定しませんでした' }
      );

      const st = await getDebugState(page);
      const callout = st.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '吹き出しが作成されていません');
      assert.equal(callout.text, '日本語のテスト\n2行目', '吹き出しのテキストが一致しません');

      printConsoleErrors(consoleErrors, '吹き出し作成');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n3) 切り抜き + 50% 出力');
  await test('切り抜きと50%出力 → 出力PNGのサイズと赤枠の画素が期待どおり', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600, fillColor: '#f0f0f0' });

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 200, y: 200 }); // 既定色は赤(#e53935)

      await selectTool(page, 'crop');
      await dragOnCanvas(page, { x: 50, y: 50 }, { x: 300, y: 300 }); // crop = {x:50,y:50,w:250,h:250}

      await page.click('.annotator-scale-btn[data-scale="0.5"]');

      const st = await getDebugState(page);
      assertClose(st.images[0].crop.x, 50, 1, 'crop.x');
      assertClose(st.images[0].crop.y, 50, 1, 'crop.y');
      assertClose(st.images[0].crop.w, 250, 1, 'crop.w');
      assertClose(st.images[0].crop.h, 250, 1, 'crop.h');
      assert.equal(st.scale, 0.5);

      await saveAndWaitClosed(page);

      const info = await page.evaluate(() => window.__annotator.getLastResultInfo());
      assert.equal(info.type, 'image/png');
      assertClose(info.width, 125, 1, '出力PNGの幅');
      assertClose(info.height, 125, 1, '出力PNGの高さ');

      // rect の上辺の中心付近(出力座標系でおよそ (50,25))が赤いはず
      const px = await page.evaluate(() => window.__annotator.getLastResultPixel(50, 25));
      assert.ok(px[0] > 150 && px[0] - px[1] > 40 && px[0] - px[2] > 40, `赤枠の画素が赤くありません: ${px}`);

      printConsoleErrors(consoleErrors, '切り抜き+50%出力');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n4) 保存 → 再度開くと復元 → 再編集して保存できる');
  await test('保存したPNGを再度開くと図形・切り抜き・倍率が復元され、追加編集して保存できる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 40, y: 40 }, { x: 140, y: 140 });

      await selectTool(page, 'crop');
      // (0,0) は crop 未実施時の "nw" ハンドルの位置と厳密に重なるため、
      // ハンドルドラッグと誤認されないよう少しずらした点から描き始める。
      await dragOnCanvas(page, { x: 15, y: 15 }, { x: 600, y: 400 });

      await page.click('.annotator-scale-btn[data-scale="0.75"]');

      await saveAndWaitClosed(page);

      await reopenLastResult(page);
      let st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, '再読み込み後の図形数が一致しません');
      assert.equal(st.shapes[0].type, 'rect');
      assertClose(st.images[0].crop.w, 585, 1, '再読み込み後の crop.w');
      assertClose(st.images[0].crop.h, 385, 1, '再読み込み後の crop.h');
      assert.equal(st.scale, 0.75, '再読み込み後の scale');

      // 追加でもう1つ枠を描いて再保存する
      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 200, y: 200 }, { x: 260, y: 260 });
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 2, '追加した図形が反映されていません');

      await saveAndWaitClosed(page);

      await reopenLastResult(page);
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 2, '再々読み込み後も2つの図形が復元されるべきです');

      printConsoleErrors(consoleErrors, '再編集の往復');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n5) JPEG を渡しても PNG で保存できる');
  await test('JPEG画像を開いてもPNGとして保存される', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'jpeg', width: 400, height: 300 });

      const st = await getDebugState(page);
      assert.equal(st.images[0].mime, 'image/jpeg');

      await saveAndWaitClosed(page);

      const info = await page.evaluate(() => window.__annotator.getLastResultInfo());
      assert.equal(info.type, 'image/png', 'JPEGを開いても出力はPNGであるべきです');
      assertClose(info.width, 400, 1, '出力幅');
      assertClose(info.height, 300, 1, '出力高さ');

      printConsoleErrors(consoleErrors, 'JPEG→PNG保存');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n6) 元に戻す / やり直し');
  await test('Ctrl+Z / Ctrl+Y で図形の追加を取り消し・やり直しできる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 50, y: 50 }, { x: 100, y: 100 });
      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 200, y: 50 }, { x: 250, y: 100 });

      let st = await getDebugState(page);
      assert.equal(st.shapes.length, 2);

      await page.keyboard.press('Control+Z');
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, '1回目の Undo で図形が1つ減るはずです');

      await page.keyboard.press('Control+Z');
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 0, '2回目の Undo で図形が0になるはずです');

      await page.keyboard.press('Control+Y');
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, 'Redo(Ctrl+Y)で図形が1つ戻るはずです');

      await page.keyboard.press('Control+Shift+Z');
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 2, 'Redo(Ctrl+Shift+Z)でさらに1つ戻るはずです');

      printConsoleErrors(consoleErrors, 'Undo/Redo');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n7) 大きな画像(4K・数MB以上のノイズ入りPNG)の保存');
  await test('4Kのノイズ画像を開いて赤枠を保存できる(サイズ・画素・再読み込み・50%縮小品質を確認)', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      // グラデーション+ランダムノイズで PNG 圧縮が効きにくい(=数MB以上になる)
      // 3840x2160 のテスト画像を作る。4Kスクリーンショット相当の負荷を再現する。
      const info = await page.evaluate(() =>
        window.__annotator.createTestImage({ format: 'png', width: 3840, height: 2160, noise: true })
      );
      console.log(`    \x1b[2mテスト画像サイズ: ${(info.size / 1024 / 1024).toFixed(1)}MiB\x1b[0m`);
      assert.ok(
        info.size > 2 * 1024 * 1024,
        `テスト画像が数MB未満です(圧縮しにくいノイズ画像になっていない可能性があります): ${info.size}バイト`
      );

      await page.evaluate(() => window.__annotator.open('source'));
      await waitFor(async () => page.evaluate(() => window.__annotator.isOpen()), {
        message: '注釈エディタのモーダルが開きませんでした',
        timeout: 15000,
      });

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 200, y: 200 }, { x: 600, y: 600 });

      const elapsedMs = await saveAndWaitClosed(page, { label: '4K画像(等倍)の保存', timeout: 30000 });
      assert.ok(elapsedMs < 15000, `保存に時間がかかりすぎています(二重エンコードの疑い): ${elapsedMs}ms`);

      const resultInfo = await page.evaluate(() => window.__annotator.getLastResultInfo());
      assert.equal(resultInfo.type, 'image/png');
      assertClose(resultInfo.width, 3840, 1, '出力幅');
      assertClose(resultInfo.height, 2160, 1, '出力高さ');
      console.log(`    \x1b[2m出力PNGサイズ: ${(resultInfo.byteSize / 1024 / 1024).toFixed(1)}MiB\x1b[0m`);

      // 赤枠の上辺中央の画素が赤いこと(等倍・crop無しなので画像座標=出力座標)
      const px = await page.evaluate(() => window.__annotator.getLastResultPixel(400, 200));
      assert.ok(px[0] > 150 && px[0] - px[1] > 40 && px[0] - px[2] > 40, `赤枠の画素が赤くありません: ${px}`);

      // 保存した4K PNGを再度開くと図形が復元されること
      await reopenLastResult(page);
      let st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, '再読み込み後の図形数が一致しません');
      assert.equal(st.shapes[0].type, 'rect');

      // 50%出力時の縮小品質: テスト画像の右下に置いた白黒の境界(main.js 参照)を
      // 縮小したとき、境界付近に中間色(アンチエイリアス)が現れることを確認する
      // (極端なジャギー=中間色が一切無い、ではないことの簡易チェック)
      await page.click('.annotator-scale-btn[data-scale="0.5"]');
      st = await getDebugState(page);
      assert.equal(st.scale, 0.5);
      await saveAndWaitClosed(page, { label: '4K画像(50%)の保存', timeout: 30000 });

      // main.js の白黒境界(x = width-99)に合わせる。わざと奇数座標にしてあるので
      // 50%縮小の2x2ブロックをまたぎ、中間色(アンチエイリアス)が期待できる。
      const boundaryOutX = Math.floor((3840 - 99) * 0.5);
      const sampleY = Math.round((2160 - 100) * 0.5);
      const points = [];
      for (let dx = -3; dx <= 3; dx++) points.push([boundaryOutX + dx, sampleY]);
      const pixels = await page.evaluate((pts) => window.__annotator.getLastResultPixels(pts), points);
      const reds = pixels.map((p) => p[0]); // 白黒の境界なので R チャンネルだけ見ればよい
      const hasBlend = reds.some((v) => v > 60 && v < 200);
      assert.ok(hasBlend, `50%縮小時に境界付近で中間色が見られず、ジャギーの疑いがあります: ${reds}`);

      printConsoleErrors(consoleErrors, '4K画像の保存');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n8) 吹き出しの文言をダブルクリックで後から修正できる');
  await test('吹き出しをダブルクリックすると文言を修正でき、履歴がちょうど1つ増える', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', '最初の文言');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      const before = await getDebugState(page);
      const callout = before.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '吹き出しが作成されていません');
      assert.equal(callout.text, '最初の文言');

      // render() が hitLayer を作り直すため dblclick イベント自体は発火しない環境でも、
      // 実際の page.mouse.dblclick(mousedown の e.detail 判定)で編集を開始できることを確認する
      const inner = await imgToClient(page, callout.x + 5, callout.y + 5);
      await page.mouse.dblclick(inner.x, inner.y);
      await waitForTextEditorVisible(page);

      const value = await getTextEditorValue(page);
      assert.equal(value, '最初の文言', 'ダブルクリックで開いた textarea の初期値が元の文言と一致しません');

      await page.fill('.annotator-text-editor', '修正後の文言');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      const after = await getDebugState(page);
      const updated = after.shapes.find((s) => s.id === callout.id);
      assert.equal(updated.text, '修正後の文言', '吹き出しの文言が修正後の値に更新されていません');
      assert.equal(after.historyLength - before.historyLength, 1, '履歴がちょうど1つ増えるはずです');

      printConsoleErrors(consoleErrors, '吹き出しの再編集');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n9) 吹き出しの再編集を保存 → 再読み込みしても復元される');
  await test('吹き出しをダブルクリックで修正して保存 → 再読み込みで修正後の文言が復元される', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', '最初の文言');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      await saveAndWaitClosed(page);
      await reopenLastResult(page);

      let st = await getDebugState(page);
      let callout = st.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '再読み込み後に吹き出しが見つかりません');
      assert.equal(callout.text, '最初の文言');

      const inner = await imgToClient(page, callout.x + 5, callout.y + 5);
      await page.mouse.dblclick(inner.x, inner.y);
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', '修正後の文言');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      await saveAndWaitClosed(page);
      await reopenLastResult(page);

      st = await getDebugState(page);
      callout = st.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '再々読み込み後に吹き出しが見つかりません');
      assert.equal(callout.text, '修正後の文言', '修正後の文言が復元されていません');

      printConsoleErrors(consoleErrors, '吹き出しの再編集の保存往復');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n10) 選択中の吹き出しを Enter / F2 で編集開始できる');
  await test('選択中の吹き出しを Enter / F2 で編集開始でき、textarea に改行が混入しない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', 'Enterテスト');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      // Escape での確定は「編集中のテキストを確定する」だけで選択は解除しない
      // 仕様なので、そのまま Enter を押すだけで編集を再開できるはず
      await page.keyboard.press('Enter');
      await waitForTextEditorVisible(page);
      let value = await getTextEditorValue(page);
      assert.equal(value, 'Enterテスト', 'Enter で開いた textarea の初期値が一致しません');
      assert.ok(!value.includes('\n'), 'Enter キーで textarea に改行が混入しています');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      // F2 でも同様に編集開始できる
      await page.keyboard.press('F2');
      await waitForTextEditorVisible(page);
      value = await getTextEditorValue(page);
      assert.equal(value, 'Enterテスト', 'F2 で開いた textarea の初期値が一致しません');
      assert.ok(!value.includes('\n'), 'F2 キーで textarea に改行が混入しています');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      printConsoleErrors(consoleErrors, 'Enter/F2 での編集開始');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n11) 入力中に吹き出しの textarea 幅が追従する');
  await test('長い1行を入力すると textarea の幅が広がる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);

      const widthBefore = await getTextEditorWidthPx(page);
      await page.keyboard.type('とても長い一行のテキストを入力してtextareaの幅が広がることを確認する');
      const widthAfter = await getTextEditorWidthPx(page);
      assert.ok(
        widthAfter > widthBefore,
        `入力後に textarea の幅が広がっていません: before=${widthBefore}, after=${widthAfter}`
      );

      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      printConsoleErrors(consoleErrors, 'textarea 幅の追従');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n12) 図形を動かさないクリックでは履歴が増えない');
  await test('選択ツールで図形を動かさずにクリックしても履歴が増えない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: 50, y: 50 }, { x: 150, y: 150 });
      await selectTool(page, 'select');

      const before = await getDebugState(page);

      // ドラッグを伴わない単純なクリック(同じ点で down/up)で選択するだけの操作
      await clickOnCanvas(page, { x: 100, y: 100 });

      const after = await getDebugState(page);
      assert.equal(after.selectedShapeId, before.shapes[0].id, '図形が選択されていません');
      assert.equal(after.historyLength, before.historyLength, '移動していないクリックで履歴が増えてはいけません');

      printConsoleErrors(consoleErrors, '移動なしクリック');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n13) v1形式のPNG(切り抜き+赤枠)を開いて復元できる');
  await test('v1形式のPNGを開くとcropと図形が復元され、変更せず保存すると出力サイズがv1の切り抜きと同じになる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      const width = 400;
      const height = 300;
      const crop = { x: 20, y: 30, w: 200, h: 150 };
      const rectShape = { id: 's1', type: 'rect', x: 40, y: 50, w: 60, h: 40, stroke: '#e53935', strokeWidth: 4 };
      const base64 = buildV1AnnotatedPngBase64({ width, height, color: [40, 60, 200], crop, shapes: [rectShape], scale: 1 });
      await page.evaluate((b64) => window.__annotator.setSourceFromBase64(b64, 'image/png'), base64);
      await page.evaluate(() => window.__annotator.open('source'));
      await waitFor(async () => page.evaluate(() => window.__annotator.isOpen()), {
        message: 'v1形式のPNGでモーダルが開きませんでした',
      });

      const st = await getDebugState(page);
      assert.equal(st.images.length, 1, 'v1は画像1枚に変換されるはずです');
      assertClose(st.images[0].crop.x, crop.x, 0.5, 'crop.x');
      assertClose(st.images[0].crop.y, crop.y, 0.5, 'crop.y');
      assertClose(st.images[0].crop.w, crop.w, 0.5, 'crop.w');
      assertClose(st.images[0].crop.h, crop.h, 0.5, 'crop.h');
      assert.equal(st.shapes.length, 1, '図形が復元されていません');
      assert.equal(st.shapes[0].type, 'rect');

      await saveAndWaitClosed(page);
      const info = await page.evaluate(() => window.__annotator.getLastResultInfo());
      assertClose(info.width, crop.w, 1, '出力幅がv1の切り抜きと一致しません');
      assertClose(info.height, crop.h, 1, '出力高さがv1の切り抜きと一致しません');

      printConsoleErrors(consoleErrors, 'v1形式の読み込み');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n14) 吹き出しが画像の外にはみ出すと出力が広がる');
  await test('画像の上端より外に吹き出しを置くと出力範囲が上に広がり、画像の外側(吹き出しでない場所)の画素が白', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600, fillColor: '#3050a0' });

      await selectTool(page, 'callout');
      // tail=(300,-20)、box左上=(300,-90)。画像(y:0-600)より上にはみ出るが、
      // 「全体表示」直後の余白の範囲内に収まる控えめな量にして実マウス操作で描けるようにする。
      await dragOnCanvas(page, { x: 300, y: -20 }, { x: 300, y: -90 });
      await waitForTextEditorVisible(page);
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      const st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, '吹き出しが作成されていません');
      assert.ok(st.outputBounds.y < 0, `出力範囲が上に広がっていません: ${JSON.stringify(st.outputBounds)}`);
      assert.ok(st.outputBounds.h > 600, `出力範囲の高さが増えていません: ${JSON.stringify(st.outputBounds)}`);
      assertClose(st.outputBounds.w, 800, 1, '横方向の出力幅は変わらないはずです');

      await saveAndWaitClosed(page);
      const bounds = st.outputBounds;
      // 吹き出しの下端(tail, y=-20)と画像の上端(y=0)の間の隙間をサンプリングする
      const outX = Math.round(300 - bounds.x);
      const outY = Math.round(-10 - bounds.y);
      const px = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), { x: outX, y: outY });
      assert.ok(px[0] > 240 && px[1] > 240 && px[2] > 240, `隙間の画素が白ではありません: ${px}`);

      printConsoleErrors(consoleErrors, '吹き出しのはみ出し');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n15) 貼り付けで2枚目の画像を追加できる');
  await test('貼り付けで2枚目を追加すると右隣(24px空け・上端揃え)に配置され、保存/再読込で2枚とも復元される', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 400, height: 300, fillColor: '#3050a0' });
      const before = await getDebugState(page);
      assert.equal(before.images.length, 1);

      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 100, height: 80, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '貼り付けで2枚目が追加されませんでした' });

      const st = await getDebugState(page);
      const img1 = st.images[0];
      const img2 = st.images[1];
      assertClose(img2.x, img1.x + img1.width + 24, 1, '2枚目のxが1枚目の右端+24になっていません');
      assertClose(img2.y, img1.y, 1, '2枚目のyが1枚目の上端に揃っていません');
      assertClose(st.outputBounds.w, img1.width + 24 + img2.width, 2, '出力範囲の幅が和集合になっていません');
      assertClose(st.outputBounds.h, Math.max(img1.height, img2.height), 2, '出力範囲の高さが和集合になっていません');

      await saveAndWaitClosed(page);

      const chunkTypes = await page.evaluate(() => window.__annotator.getLastResultChunkTypes());
      const mdimCount = chunkTypes.filter((t) => t === 'mdIM').length;
      assert.equal(mdimCount, 2, `mdIM チャンクが2つあるはずです: ${chunkTypes}`);

      // 隙間(1枚目と2枚目の間)の画素が白、2枚目の場所の画素が2枚目の色(緑)
      const gapX = Math.round(img1.x + img1.width + 12 - st.outputBounds.x);
      const gapY = Math.round(img1.y + 5 - st.outputBounds.y);
      const gapPx = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), { x: gapX, y: gapY });
      assert.ok(gapPx[0] > 240 && gapPx[1] > 240 && gapPx[2] > 240, `隙間の画素が白ではありません: ${gapPx}`);

      const img2X = Math.round(img2.x + 5 - st.outputBounds.x);
      const img2Y = Math.round(img2.y + 5 - st.outputBounds.y);
      const img2Px = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), { x: img2X, y: img2Y });
      assert.ok(img2Px[1] > img2Px[0] && img2Px[1] > img2Px[2], `2枚目の場所の画素が2枚目の色(緑)ではありません: ${img2Px}`);

      await reopenLastResult(page);
      const reopened = await getDebugState(page);
      assert.equal(reopened.images.length, 2, '再読み込み後も2枚あるはずです');
      assertClose(reopened.images[1].x, img2.x, 1, '再読み込み後のx位置がずれています');
      assertClose(reopened.images[1].y, img2.y, 1, '再読み込み後のy位置がずれています');

      printConsoleErrors(consoleErrors, '貼り付けでの画像追加');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n16) ファイル選択・ドロップでも画像を追加できる');
  await test('ファイル選択(input)とドロップで画像を追加できる。ドロップは位置が画像の中心になる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 300, height: 200, fillColor: '#3050a0' });

      // ファイル選択(非表示 input に Buffer を渡す)
      const buf = makeSolidPngBuffer(60, 40, [200, 30, 30]);
      await page.setInputFiles('.annotator-file-input', { name: 'via-input.png', mimeType: 'image/png', buffer: buf });
      await waitFor(async () => (await getDebugState(page)).images.length === 2, {
        message: 'ファイル選択で2枚目が追加されませんでした',
      });

      let st = await getDebugState(page);
      assert.equal(st.images[1].width, 60);
      assert.equal(st.images[1].height, 40);

      // ドロップ(合成 DragEvent)。ドロップ位置(キャンバス座標)が画像の中心になるはず。
      const dropCanvasPoint = { x: 500, y: 300 };
      const dropClient = await imgToClient(page, dropCanvasPoint.x, dropCanvasPoint.y);
      await page.evaluate(
        ({ opts, point }) => window.__annotator.dropTestImage(opts, point),
        { opts: { format: 'png', width: 80, height: 50, fillColor: '#20a040' }, point: dropClient }
      );
      await waitFor(async () => (await getDebugState(page)).images.length === 3, {
        message: 'ドロップで3枚目が追加されませんでした',
      });

      st = await getDebugState(page);
      const dropped = st.images[2];
      assertClose(dropped.x + dropped.width / 2, dropCanvasPoint.x, 1, 'ドロップした画像の中心xがドロップ位置と一致しません');
      assertClose(dropped.y + dropped.height / 2, dropCanvasPoint.y, 1, 'ドロップした画像の中心yがドロップ位置と一致しません');

      printConsoleErrors(consoleErrors, 'ファイル選択・ドロップでの画像追加');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n17) 2枚以上のときに切り抜きツールで対象画像を選んで切り抜ける');
  await test('切り抜きツールで2枚目をクリックして対象にし、ドラッグで切り抜くと2枚目のcropだけが変わる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 300, height: 200, fillColor: '#3050a0' });
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 150, height: 100, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2);

      let st = await getDebugState(page);
      const img2 = st.images[1];

      await selectTool(page, 'crop');
      let afterTool = await getDebugState(page);
      assert.equal(afterTool.cropTargetId, null, '2枚以上でツール切替直後は対象が未定のはずです');

      // 2枚目の内部の点をクリックして対象にする(このクリックでは切り抜きを開始しない)
      await clickOnCanvas(page, { x: img2.x + 20, y: img2.y + 20 });
      const afterClick = await getDebugState(page);
      assert.equal(afterClick.cropTargetId, img2.id, '2枚目が切り抜き対象になっていません');
      assertClose(afterClick.images[1].crop.w, img2.width, 0.5, 'クリックだけでは切り抜きが変わらないはずです');

      // 対象画像のピクセル座標でドラッグして切り抜く
      await dragOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 }, { x: img2.x + 100, y: img2.y + 80 });

      st = await getDebugState(page);
      assertClose(st.images[1].crop.x, 10, 1, '2枚目のcrop.x');
      assertClose(st.images[1].crop.y, 10, 1, '2枚目のcrop.y');
      assertClose(st.images[1].crop.w, 90, 1, '2枚目のcrop.w');
      assertClose(st.images[1].crop.h, 70, 1, '2枚目のcrop.h');
      // 1枚目は変わらない
      assertClose(st.images[0].crop.w, st.images[0].width, 0.5, '1枚目のcropは変わらないはずです');

      assertClose(st.outputBounds.x + st.outputBounds.w, img2.x + 10 + 90, 2, '出力範囲の右端が2枚目の切り抜きに追従していません');

      printConsoleErrors(consoleErrors, '画像ごとの切り抜き');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n18) ホイールでのパン・ズーム、全体表示');
  await test('Ctrl+ホイールでカーソル位置を固定してズームでき、ホイールでパンでき、全体表示で出力範囲が画面に収まる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      const box = await page.evaluate(() => window.__annotator.getSvgBox());
      const cursor = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      await page.mouse.move(cursor.x, cursor.y);

      const canvasPointAt = async (client) =>
        page.evaluate((c) => {
          const svg = document.querySelector('.annotator-svg');
          const r = svg.getBoundingClientRect();
          const st = window.__annotator.getDebugState();
          return { x: st.camera.x + (c.x - r.left) / st.zoom, y: st.camera.y + (c.y - r.top) / st.zoom };
        }, client);

      const canvasPointBefore = await canvasPointAt(cursor);

      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -200); // 上にスクロール = 拡大方向
      await page.keyboard.up('Control');

      const st1 = await getDebugState(page);
      assert.ok(st1.zoom > 1, `Ctrl+ホイールでズームインしていません: zoom=${st1.zoom}`);

      const canvasPointAfter = await canvasPointAt(cursor);
      assertClose(canvasPointAfter.x, canvasPointBefore.x, 1, 'ズーム後もカーソル位置のキャンバス座標がずれてはいけません(x)');
      assertClose(canvasPointAfter.y, canvasPointBefore.y, 1, 'ズーム後もカーソル位置のキャンバス座標がずれてはいけません(y)');

      // 素のホイール(下方向)= 下にパン(camera.yが増える)
      const camBeforePan = st1.camera;
      await page.mouse.wheel(0, 100);
      const st2 = await getDebugState(page);
      assert.ok(st2.camera.y > camBeforePan.y, `ホイールで下にパンしていません: ${JSON.stringify(st2.camera)}`);

      // 全体表示: 出力範囲の四隅がすべて表示領域内に収まる
      await page.click('[data-action="fit"]');
      const st3 = await getDebugState(page);
      const box3 = await page.evaluate(() => window.__annotator.getSvgBox());
      const corners = [
        { x: st3.outputBounds.x, y: st3.outputBounds.y },
        { x: st3.outputBounds.x + st3.outputBounds.w, y: st3.outputBounds.y + st3.outputBounds.h },
      ];
      for (const c of corners) {
        const screenX = (c.x - st3.camera.x) * st3.zoom;
        const screenY = (c.y - st3.camera.y) * st3.zoom;
        assert.ok(screenX >= -1 && screenX <= box3.width + 1, `全体表示後、出力範囲の角が画面からはみ出しています(x=${screenX})`);
        assert.ok(screenY >= -1 && screenY <= box3.height + 1, `全体表示後、出力範囲の角が画面からはみ出しています(y=${screenY})`);
      }
      assert.ok(st3.zoom <= 1 + 1e-9, '全体表示のズームは最大100%のはずです');

      printConsoleErrors(consoleErrors, 'パン・ズーム・全体表示');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n19) 出力サイズの上限を超えると保存を止めてメッセージを出す');
  await test('大きめの画像+出力倍率1000%で保存しようとするとメッセージが出てモーダルは開いたまま', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 2000, height: 1500, fillColor: '#f0f0f0' });

      await page.evaluate(() => {
        const input = document.querySelector('.annotator-scale-custom');
        input.value = '1000';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const st = await getDebugState(page);
      assert.equal(st.scale, 10, '出力倍率が1000%になっていません');

      await page.click('[data-action="save"]');
      await waitFor(async () => page.evaluate(() => !!document.querySelector('.annotator-confirm-overlay')), {
        message: '出力サイズ超過のメッセージが表示されませんでした',
      });
      const message = await page.evaluate(() => document.querySelector('.annotator-confirm-message').textContent);
      assert.match(message, /大きすぎます/, `期待したメッセージが表示されていません: ${message}`);

      await page.click('.annotator-confirm-actions button[data-action="ok"]');
      // モーダルは開いたまま(注釈エディタ自体は閉じない)
      assert.ok(await page.evaluate(() => window.__annotator.isOpen()), '出力サイズ超過時にモーダルが閉じてしまいました');
      assert.ok(await page.evaluate(() => window.__annotator.isPending()), '保存の Promise が解決されてはいけません');

      printConsoleErrors(consoleErrors, '出力サイズの上限');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n20) 画像が1枚のときは選択・移動できない');
  await test('画像1枚のときはクリックしても選択されず、ドラッグしても動かない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 400, height: 300 });

      await clickOnCanvas(page, { x: 100, y: 100 });
      let st = await getDebugState(page);
      assert.equal(st.selectedImageId, null, '画像が1枚のときは選択されないはずです');

      const before = await getDebugState(page);
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 250, y: 220 });
      const after = await getDebugState(page);
      assertClose(after.images[0].x, before.images[0].x, 0.01, '画像が1枚のときはドラッグしても動かないはずです(x)');
      assertClose(after.images[0].y, before.images[0].y, 0.01, '画像が1枚のときはドラッグしても動かないはずです(y)');
      assert.equal(after.historyLength, before.historyLength, '履歴も増えないはずです');

      printConsoleErrors(consoleErrors, '画像1枚のときの選択');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n21) 画像が2枚以上のときの選択・移動(4px未満はうっかりずらし防止で動かない)');
  await test('2枚目をクリックで選択でき、ドラッグで移動できる。3px(画面上)の移動では動かず履歴も増えない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 400, height: 300, fillColor: '#3050a0' });
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 120, height: 90, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '2枚目が追加されませんでした' });

      let st = await getDebugState(page);
      const img2 = st.images[1];

      await clickOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 });
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id, '2枚目が選択されていません');

      // 3px(画面上=クライアント座標、片軸のみでちょうど3pxの移動距離)のドラッグでは
      // 移動しない(うっかりずらし防止)
      const before = await getDebugState(page);
      const c1 = await imgToClient(page, img2.x + 10, img2.y + 10);
      await page.mouse.move(c1.x, c1.y);
      await page.mouse.down();
      await page.mouse.move(c1.x + 3, c1.y, { steps: 1 });
      await page.mouse.up();
      const afterSmall = await getDebugState(page);
      assertClose(afterSmall.images[1].x, before.images[1].x, 0.01, '3px未満の移動では動かないはずです(x)');
      assertClose(afterSmall.images[1].y, before.images[1].y, 0.01, '3px未満の移動では動かないはずです(y)');
      assert.equal(afterSmall.historyLength, before.historyLength, '3px未満の移動では履歴が増えないはずです');

      // 十分な距離のドラッグでは移動量(/zoom で正規化されたキャンバス座標の移動量)だけ動く
      await dragOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 }, { x: img2.x + 60, y: img2.y + 80 });
      const after = await getDebugState(page);
      assertClose(after.images[1].x, img2.x + 50, 1, 'ドラッグした分だけxが動いていません');
      assertClose(after.images[1].y, img2.y + 70, 1, 'ドラッグした分だけyが動いていません');
      assert.equal(after.historyLength, afterSmall.historyLength + 1, '実際に動かした移動で履歴が1つ増えるはずです');

      printConsoleErrors(consoleErrors, '画像の選択と移動');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n22) 画像の四隅のハンドルで拡大縮小(縦横比維持・反対角固定)');
  await test('四隅のハンドルで拡大縮小すると縦横比が保たれ、反対側の角が動かない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 400, height: 300, fillColor: '#3050a0' });
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 200, height: 100, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '2枚目が追加されませんでした' });

      let st = await getDebugState(page);
      const img2 = st.images[1];
      await clickOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 });
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id);

      const nwCorner = { x: img2.x, y: img2.y };
      const seCorner = { x: img2.x + img2.width, y: img2.y + img2.height }; // scale=1・crop無しなので表示矩形の角と一致

      // se ハンドルを右下に大きくドラッグして拡大する(nw が固定されるはず)
      await dragOnCanvas(page, seCorner, { x: seCorner.x + 100, y: seCorner.y + 50 });

      st = await getDebugState(page);
      const resized = st.images[1];
      assertClose(resized.x, nwCorner.x, 1, '反対側の角(nw.x)が動いてしまっています');
      assertClose(resized.y, nwCorner.y, 1, '反対側の角(nw.y)が動いてしまっています');
      assert.ok(resized.scale > 1, '拡大されているはずです');

      const origRatio = img2.width / img2.height;
      const newW = resized.crop.w * resized.scale;
      const newH = resized.crop.h * resized.scale;
      assertClose(newW / newH, origRatio, 0.02, `縦横比が保たれていません: ${newW}/${newH} vs ${origRatio}`);

      printConsoleErrors(consoleErrors, '画像の拡大縮小');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n23) 画像の削除(Delete)・元に戻す・保存時のmdIM件数');
  await test('Deleteで選択中の画像を削除でき、元に戻すで復活し、保存したPNGにmdIMが2つ含まれる。最後の1枚はDeleteしても消えない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 400, height: 300, fillColor: '#3050a0' });
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 100, height: 80, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '2枚目が追加されませんでした' });

      let st = await getDebugState(page);
      const img2 = st.images[1];
      await clickOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 });
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id);

      await page.keyboard.press('Delete');
      st = await getDebugState(page);
      assert.equal(st.images.length, 1, '削除後は画像が1枚になるはずです');
      assert.equal(st.selectedImageId, null, '削除後は選択も解除されるはずです');

      await page.keyboard.press('Control+Z');
      st = await getDebugState(page);
      assert.equal(st.images.length, 2, '元に戻すで画像が復活するはずです');

      await saveAndWaitClosed(page);
      const chunkTypes = await page.evaluate(() => window.__annotator.getLastResultChunkTypes());
      const mdimCount = chunkTypes.filter((t) => t === 'mdIM').length;
      assert.equal(mdimCount, 2, `復活後に保存したPNGにmdIMが2つあるはずです: ${chunkTypes}`);

      // 1枚だけ残った状態ではDeleteしても画像は消えないことを確認する
      await reopenLastResult(page);
      st = await getDebugState(page);
      assert.equal(st.images.length, 2);
      const img2b = st.images[1];
      await clickOnCanvas(page, { x: img2b.x + 10, y: img2b.y + 10 });
      await page.keyboard.press('Delete');
      st = await getDebugState(page);
      assert.equal(st.images.length, 1, 'この時点では1枚になっているはずです');

      await clickOnCanvas(page, { x: st.images[0].x + 10, y: st.images[0].y + 10 }); // 1枚なので選択されない
      await page.keyboard.press('Delete');
      st = await getDebugState(page);
      assert.equal(st.images.length, 1, '最後の1枚はDeleteしても消えないはずです');

      printConsoleErrors(consoleErrors, '画像の削除・復活');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n24) 画像の重なり順(最前面へ / 最背面へ)');
  await test('「最前面へ」「最背面へ」で st.images の順が変わり、重なり部分の出力画素の色が変わる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 200, height: 200, fillColor: '#e53935' }); // 赤
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 200, height: 200, fillColor: '#1e88e5' })); // 青
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '2枚目が追加されませんでした' });

      let st = await getDebugState(page);
      const img1 = st.images[0];
      let img2 = st.images[1];

      // 2枚目(青)を1枚目(赤)に「一部だけ」重なるよう移動する(完全に重ねてしまうと、
      // 重なり順を変えた後に2枚目だけをクリックで再選択する手段が無くなるため)。
      // 新しい位置: x = img1の右端-100(横方向に100pxだけ重なる)、y は揃える。
      const targetX = img1.x + img1.width - 100;
      await clickOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 });
      await dragOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 }, { x: targetX + 10, y: img1.y + 10 });

      st = await getDebugState(page);
      img2 = st.images[1];
      assertClose(img2.x, targetX, 1, '2枚目の移動後の位置が想定とずれています');

      // 重なり領域(両方の画像が存在する点)と、2枚目だけが存在する点(重なり順に
      // 関わらず常に2枚目をクリックで選択できる点)を求める
      const overlapPoint = { x: Math.round(img2.x + 30 - st.outputBounds.x), y: Math.round(img2.y + 30 - st.outputBounds.y) };
      const img2OnlyPoint = { x: img2.x + img2.width - 20, y: img2.y + 20 };

      // 既定では2枚目(青)が手前
      await saveAndWaitClosed(page);
      let px = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), overlapPoint);
      assert.ok(px[2] > px[0], `2枚目(青)が手前のはずです: ${px}`);

      // 2枚目(青だけが存在する点をクリックして選ぶ)を選んで「最背面へ」
      // → 1枚目(赤)が手前になる(保存済みなのでモーダルは閉じている。開き直す)
      await reopenLastResult(page);
      st = await getDebugState(page);
      img2 = st.images[1];
      await clickOnCanvas(page, img2OnlyPoint);
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id, '2枚目だけの領域をクリックすると2枚目が選択されるはずです');
      const beforeReorder = await getDebugState(page);
      await page.click('[data-action="sendToBack"]');
      st = await getDebugState(page);
      assert.equal(st.images[0].id, img2.id, '「最背面へ」で配列の先頭に移動するはずです');
      assert.equal(st.historyLength, beforeReorder.historyLength + 1, '重なり順の変更で履歴が1つ増えるはずです');

      await saveAndWaitClosed(page);
      px = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), overlapPoint);
      assert.ok(px[0] > px[2], `「最背面へ」の後は1枚目(赤)が手前になっているはずです: ${px}`);

      // 開き直して、2枚目だけの領域をクリックで選び「最前面へ」で元(2枚目=青が手前)に戻す
      // (この時点で2枚目は配列の先頭=最背面にいるが、クリックによる選択は重なり順に
      // 関わらず一貫して動くはずなので、そのことも合わせて確認できる)
      await reopenLastResult(page);
      st = await getDebugState(page);
      img2 = st.images.find((i) => i.id === img2.id);
      await clickOnCanvas(page, { x: img2.x + img2.width - 20, y: img2.y + 20 });
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id, '重なり順が変わっても2枚目だけの領域のクリックで2枚目が選択されるはずです');
      await page.click('[data-action="bringToFront"]');
      st = await getDebugState(page);
      assert.equal(st.images[1].id, img2.id, '「最前面へ」で配列の末尾に移動するはずです');

      await saveAndWaitClosed(page);
      px = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), overlapPoint);
      assert.ok(px[2] > px[0], `「最前面へ」の後は2枚目(青)が手前に戻っているはずです: ${px}`);

      printConsoleErrors(consoleErrors, '画像の重なり順');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n25) 選択ツールから切り抜きツールへの切り替えで対象を引き継ぐ');
  await test('画像を選択してから切り抜きツールに切り替えると、その画像が切り抜き対象になる(ボタン・Cキーの両方)', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 300, height: 200, fillColor: '#3050a0' });
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 100, height: 80, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '2枚目が追加されませんでした' });

      let st = await getDebugState(page);
      const img2 = st.images[1];
      await clickOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 });
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id);

      await selectTool(page, 'crop'); // ボタンでの切り替え
      st = await getDebugState(page);
      assert.equal(st.cropTargetId, img2.id, 'ボタンでの切り替えでも選択中の画像が切り抜き対象を引き継ぐはずです');

      await selectTool(page, 'select');
      await clickOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 });
      st = await getDebugState(page);
      assert.equal(st.selectedImageId, img2.id);
      await page.keyboard.press('c'); // 'C'キーでの切り替え
      st = await getDebugState(page);
      assert.equal(st.cropTargetId, img2.id, 'Cキーでの切り替えでも選択中の画像が切り抜き対象を引き継ぐはずです');

      printConsoleErrors(consoleErrors, '選択→切り抜きの引き継ぎ');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n26) 複数ファイルの同時ドロップで重ならない');
  await test('2ファイルを同時にドロップすると重ならず、2枚目が1枚目の右隣(+24px・上端揃え)に配置される', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 300, height: 200, fillColor: '#3050a0' });
      let st = await getDebugState(page);
      const img1 = st.images[0];

      // ドロップ位置の y は1枚目(ドロップした画像)の上端が既存の背景画像(img1)の
      // 上端と一致するように選ぶ(そうしないと2枚目の基準になる「現在の出力範囲」の
      // 上端が背景画像側になってしまい、「直前に追加した画像の右隣」の検証があいまいになる)
      const droppedHeight = 60;
      const dropClient = await imgToClient(page, img1.x + img1.width + 200, img1.y + droppedHeight / 2);
      await page.evaluate(
        ({ optsList, point }) => window.__annotator.dropTestImages(optsList, point),
        {
          optsList: [
            { format: 'png', width: 80, height: droppedHeight, fillColor: '#20a040' },
            { format: 'png', width: 50, height: 40, fillColor: '#e53935' },
          ],
          point: dropClient,
        }
      );
      await waitFor(async () => (await getDebugState(page)).images.length === 3, {
        message: '2ファイル同時ドロップで画像が2枚追加されませんでした',
      });

      st = await getDebugState(page);
      const dropped1 = st.images[1];
      const dropped2 = st.images[2];
      assertClose(dropped1.x + dropped1.width / 2, img1.x + img1.width + 200, 1, '1枚目(ドロップ位置)の中心がずれています');
      assertClose(dropped2.x, dropped1.x + dropped1.width + 24, 1, '2枚目のxが1枚目の右端+24になっていません');
      assertClose(dropped2.y, dropped1.y, 1, '2枚目のyが1枚目の上端に揃っていません');

      printConsoleErrors(consoleErrors, '複数ファイル同時ドロップ');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n27) 画像の上に重なった図形は図形が優先して選択される');
  await test('画像の上にある図形をクリックすると図形が選ばれる(画像より優先)', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 400, height: 300, fillColor: '#3050a0' });
      await page.evaluate(() => window.__annotator.pasteTestImage({ format: 'png', width: 150, height: 100, fillColor: '#20a040' }));
      await waitFor(async () => (await getDebugState(page)).images.length === 2, { message: '2枚目が追加されませんでした' });

      let st = await getDebugState(page);
      const img2 = st.images[1];

      await selectTool(page, 'rect');
      await dragOnCanvas(page, { x: img2.x + 10, y: img2.y + 10 }, { x: img2.x + 60, y: img2.y + 60 });

      await selectTool(page, 'select');
      await clickOnCanvas(page, { x: img2.x + 30, y: img2.y + 30 }); // 図形の内側かつ画像の内側
      st = await getDebugState(page);
      assert.ok(st.selectedShapeId, '図形が選択されているはずです');
      assert.equal(st.selectedImageId, null, '図形が優先され画像は選択されないはずです');

      printConsoleErrors(consoleErrors, '図形と画像の当たり判定の優先順位');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n28) 吹き出しの文字の大きさ・色');
  await test('選択中の吹き出しの大きさ・色をツールバーで変えると反映され、Ctrl+Z で色が元に戻る', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', 'テスト文言');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      const st0 = await getDebugState(page);
      const callout = st0.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '吹き出しが作成されていません');
      assert.equal(st0.selectedShapeId, callout.id, '作成した吹き出しが選択された状態のはずです');

      const getBox = () =>
        page.evaluate((id) => {
          const path = document.querySelector(`.annotator-shapes-layer [data-shape-id="${id}"] path`);
          const b = path.getBBox();
          return { w: b.width, h: b.height };
        }, callout.id);
      const getTextFill = () =>
        page.evaluate((id) => {
          const t = document.querySelector(`.annotator-shapes-layer [data-shape-id="${id}"] text`);
          return t.getAttribute('fill');
        }, callout.id);

      const boxBefore = await getBox();

      await page.selectOption('.annotator-font-size', '48');
      let st = await getDebugState(page);
      let updated = st.shapes.find((s) => s.id === callout.id);
      assert.equal(updated.fontSize, 48, '文字の大きさが反映されていません');

      const boxAfter = await getBox();
      assert.ok(
        boxAfter.w > boxBefore.w && boxAfter.h > boxBefore.h,
        `文字の大きさを変えても枠が大きくなっていません: before=${JSON.stringify(boxBefore)}, after=${JSON.stringify(boxAfter)}`
      );

      await page.click('.annotator-text-color-btn[data-text-color="#1e88e5"]');
      st = await getDebugState(page);
      updated = st.shapes.find((s) => s.id === callout.id);
      assert.equal(updated.textColor, '#1e88e5', '文字の色が反映されていません');
      assert.equal(await getTextFill(), '#1e88e5', 'SVG の text の fill が変わっていません');

      await page.keyboard.press('Control+Z');
      st = await getDebugState(page);
      updated = st.shapes.find((s) => s.id === callout.id);
      assert.equal(updated.textColor, '#222222', 'Ctrl+Z で文字の色が元に戻っていません');

      printConsoleErrors(consoleErrors, '吹き出しの文字の大きさ・色');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('吹き出しの文字の大きさ・色を保存して開き直しても復元される', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', 'テスト');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      await page.selectOption('.annotator-font-size', '40');
      await page.click('.annotator-text-color-btn[data-text-color="#43a047"]');

      let st = await getDebugState(page);
      let callout = st.shapes.find((s) => s.type === 'callout');
      assert.equal(callout.fontSize, 40);
      assert.equal(callout.textColor, '#43a047');

      await saveAndWaitClosed(page);
      await reopenLastResult(page);

      st = await getDebugState(page);
      callout = st.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '再読み込み後に吹き出しが見つかりません');
      assert.equal(callout.fontSize, 40, '再読み込み後の fontSize が復元されていません');
      assert.equal(callout.textColor, '#43a047', '再読み込み後の textColor が復元されていません');

      printConsoleErrors(consoleErrors, '吹き出しの文字の大きさ・色の保存往復');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('何も選んでいない状態で大きさ・色を変えると、次に作る吹き出しがその値になる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'select'); // 前提: 何も選択していない状態
      await page.selectOption('.annotator-font-size', '16');
      await page.click('.annotator-text-color-btn[data-text-color="#e53935"]');

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.keyboard.press('Escape'); // テキストは空のまま確定
      await waitForTextEditorHidden(page);

      const st = await getDebugState(page);
      const callout = st.shapes.find((s) => s.type === 'callout');
      assert.ok(callout, '吹き出しが作成されていません');
      assert.equal(callout.fontSize, 16, '既定の文字の大きさが新しい吹き出しに反映されていません');
      assert.equal(callout.textColor, '#e53935', '既定の文字色が新しい吹き出しに反映されていません');

      printConsoleErrors(consoleErrors, '既定の文字の大きさ・色');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('文字の大きさの select にフォーカスがある状態で Delete を押しても選択中の吹き出しが消えない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });

      await selectTool(page, 'callout');
      await clickOnCanvas(page, { x: 300, y: 300 });
      await waitForTextEditorVisible(page);
      await page.fill('.annotator-text-editor', 'テスト');
      await page.keyboard.press('Escape');
      await waitForTextEditorHidden(page);

      let st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, '前提条件が崩れています: 吹き出しが作成されていません');

      await page.focus('.annotator-font-size');
      await page.keyboard.press('Delete');

      st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, 'select にフォーカスがある状態で Delete を押すと吹き出しが消えてしまいました');

      printConsoleErrors(consoleErrors, 'select フォーカス中の Delete');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n29) カギ線矢印');
  await test('L キーでツールが elbow になる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await page.keyboard.press('l');
      const st = await getDebugState(page);
      assert.equal(st.activeTool, 'elbow', 'L キーでツールが elbow になっていません');

      printConsoleErrors(consoleErrors, 'Lキーでのツール切替');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('赤枠Aの右辺→赤枠Bの左辺へカギ線を描くと、ドラッグ中に接続点が表示され、attach/side/polylineが正しくなる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await selectTool(page, 'rect');
      await dragOnCanvas(page, ELBOW_A_DRAG[0], ELBOW_A_DRAG[1]);
      await selectTool(page, 'rect');
      await dragOnCanvas(page, ELBOW_B_DRAG[0], ELBOW_B_DRAG[1]);

      let st = await getDebugState(page);
      const rectA = findRectByX(st.shapes, 50);
      const rectB = findRectByX(st.shapes, 350);
      assert.ok(rectA && rectB, '前提の赤枠2つが見つかりません');

      await selectTool(page, 'elbow');
      const c1 = await imgToClient(page, ELBOW_A_RIGHT.x, ELBOW_A_RIGHT.y);
      const c2 = await imgToClient(page, ELBOW_B_LEFT.x, ELBOW_B_LEFT.y);
      await page.mouse.move(c1.x, c1.y);
      await page.mouse.down();
      await page.mouse.move(c2.x, c2.y, { steps: 5 }); // まだ up していない(ドラッグ中)

      // ドラッグ中: つながる予定の枠(B)に接続点が4つ、活性(--active)が1つ、side='left'
      const points = await getConnectPoints(page);
      assert.equal(points.length, 4, `接続点が4つのはずです: ${JSON.stringify(points)}`);
      const activePoints = points.filter((p) => p.active);
      assert.equal(activePoints.length, 1, `活性の接続点は1つのはずです: ${JSON.stringify(points)}`);
      assert.equal(activePoints[0].side, 'left', `活性の接続点のsideはleftのはずです: ${JSON.stringify(points)}`);

      // ドラッグ中の見た目も離したときと同じ接続: B の左辺に左から水平に入り、末尾が左辺の中点
      const draftPoints = await page.evaluate(() => {
        const poly = document.querySelector('.annotator-shapes-layer g[data-routing="elbow"] polyline');
        return poly
          .getAttribute('points')
          .trim()
          .split(/\s+/)
          .map((pair) => {
            const [x, y] = pair.split(',').map(Number);
            return { x, y };
          });
      });
      const dLast = draftPoints[draftPoints.length - 1];
      const dPrev = draftPoints[draftPoints.length - 2];
      assert.equal(dLast.y, dPrev.y, `ドラッグ中の最後の線分が水平ではありません: ${JSON.stringify(draftPoints)}`);
      assert.ok(dLast.x > dPrev.x, `ドラッグ中の最後の線分が左から入っていません: ${JSON.stringify(draftPoints)}`);
      assertClose(dLast.y, ELBOW_B_LEFT.y, 1, 'ドラッグ中の末尾yが B の左辺の中点ではありません');

      await page.mouse.up();

      st = await getDebugState(page);
      assert.equal(st.shapes.length, 3, '図形が3つ(rect,rect,arrow)になっていません');
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      assert.ok(arrow, 'カギ線が作成されていません');
      assert.equal(arrow.routing, 'elbow');
      assert.equal(arrow.from.attach, rectA.id, 'カギ線の始点がAに接続していません');
      assert.equal(arrow.from.side, 'right', '始点のsideがrightではありません');
      assert.equal(arrow.to.attach, rectB.id, 'カギ線の終点がBに接続していません');
      assert.equal(arrow.to.side, 'left', '終点のsideがleftではありません');

      const polyPoints = await getElbowPolylinePoints(page, arrow.id);
      assertClose(polyPoints[0].x, ELBOW_A_RIGHT.x, 1, '折れ線の先頭x');
      assertClose(polyPoints[0].y, ELBOW_A_RIGHT.y, 1, '折れ線の先頭y');
      assertAxisAlignedPolyline(polyPoints, '折れ線');

      printConsoleErrors(consoleErrors, 'カギ線の接続と接続ヒント');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('選択ツールで枠Bを動かすと、カギ線の経路の末尾が新しい左辺の中点に追従する', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await drawElbowAB(page);

      let st = await getDebugState(page);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      const rectB = findRectByX(st.shapes, 350);
      assert.ok(arrow && rectB, '前提の図形が見つかりません');

      await selectTool(page, 'select');
      // rectBの中心(400,250)を(500,350)へ移動する(x,yともに+100)
      await dragOnCanvas(page, { x: 400, y: 250 }, { x: 500, y: 350 });

      st = await getDebugState(page);
      const movedB = st.shapes.find((s) => s.id === rectB.id);
      assertClose(movedB.x, 450, 1, 'Bの移動後のxが想定とずれています');
      assertClose(movedB.y, 300, 1, 'Bの移動後のyが想定とずれています');

      const shapesMap = Object.fromEntries(st.shapes.map((s) => [s.id, s]));
      const movedArrow = st.shapes.find((s) => s.id === arrow.id);
      const { to } = computeArrowEndpoints(movedArrow, shapesMap, () => 0);
      assertClose(to.x, movedB.x, 1, 'カギ線の終点xがBの新しい左辺の中点に追従していません');
      assertClose(to.y, movedB.y + movedB.h / 2, 1, 'カギ線の終点yがBの新しい左辺の中点に追従していません');

      printConsoleErrors(consoleErrors, 'カギ線の追従');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('選択中のカギ線に elbow-mid ハンドルがあり、ドラッグで mid が変わる。Ctrl+Z で 0.5 に戻る', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await drawElbowAB(page);

      let st = await getDebugState(page);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      assert.ok(arrow, '前提のカギ線が見つかりません');
      assert.equal(st.selectedShapeId, arrow.id, '作成直後はカギ線が選択された状態のはずです');
      assert.equal(arrow.mid, 0.5, '既定のmidは0.5のはずです');

      const handle = await page.evaluate(() => {
        const el = document.querySelector('[data-handle="elbow-mid"]');
        return el ? { cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')) } : null;
      });
      assert.ok(handle, 'elbow-mid ハンドルが見つかりません');

      const targetX = 300;
      await dragOnCanvas(page, { x: handle.cx, y: handle.cy }, { x: targetX, y: handle.cy });

      st = await getDebugState(page);
      const updated = st.shapes.find((s) => s.id === arrow.id);
      const lo = ELBOW_A_RIGHT.x + ELBOW_STUB;
      const hi = ELBOW_B_LEFT.x - ELBOW_STUB;
      const expectedMid = (targetX - lo) / (hi - lo);
      assertClose(updated.mid, expectedMid, 0.02, 'ドラッグ後のmidが期待値と異なります');
      assert.notEqual(updated.mid, 0.5, 'ドラッグでmidが変わっているはずです');

      await page.keyboard.press('Control+Z');
      st = await getDebugState(page);
      const reverted = st.shapes.find((s) => s.id === arrow.id);
      assertClose(reverted.mid, 0.5, 0.001, 'Ctrl+Zでmidが0.5に戻っていません');

      printConsoleErrors(consoleErrors, 'カギ線の中央ハンドル');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('端点ハンドル(arrow-to)を枠Bの上辺付近へドラッグすると side が top になる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await drawElbowAB(page);

      let st = await getDebugState(page);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      const rectB = findRectByX(st.shapes, 350);
      assert.ok(arrow && rectB, '前提の図形が見つかりません');

      // arrow-to ハンドルは現在Bの左辺中点(350,250)にある。Bの上辺中点へドラッグする
      await dragOnCanvas(page, ELBOW_B_LEFT, { x: rectB.x + rectB.w / 2, y: rectB.y });

      st = await getDebugState(page);
      const updated = st.shapes.find((s) => s.id === arrow.id);
      assert.equal(updated.to.attach, rectB.id, '終点は依然Bに接続しているはずです');
      assert.equal(updated.to.side, 'top', '終点のsideがtopになっていません');

      printConsoleErrors(consoleErrors, 'カギ線の端点の付け替え');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('保存→開き直しで routing/side/mid が復元され、出力PNGの折れ線上の画素が線の色になる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600, fillColor: '#f0f0f0' });
      await drawElbowAB(page);

      // 中央の縦線の位置をずらしてから保存する(既定値のままでも復元されるが、
      // 変更した値がちゃんと保存されることも合わせて確認する)
      const handle = await page.evaluate(() => {
        const el = document.querySelector('[data-handle="elbow-mid"]');
        return { cx: Number(el.getAttribute('cx')), cy: Number(el.getAttribute('cy')) };
      });
      const targetX = 300;
      await dragOnCanvas(page, { x: handle.cx, y: handle.cy }, { x: targetX, y: handle.cy });

      let st = await getDebugState(page);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      const midAfterDrag = arrow.mid;
      const bounds = st.outputBounds;

      await saveAndWaitClosed(page);
      await reopenLastResult(page);

      st = await getDebugState(page);
      const reopened = st.shapes.find((s) => s.type === 'arrow');
      assert.ok(reopened, '再読み込み後にカギ線が見つかりません');
      assert.equal(reopened.routing, 'elbow', '再読み込み後もrouting=elbowのはずです');
      assert.equal(reopened.from.side, 'right', '再読み込み後の始点sideが復元されていません');
      assert.equal(reopened.to.side, 'left', '再読み込み後の終点sideが復元されていません');
      assertClose(reopened.mid, midAfterDrag, 0.001, '再読み込み後のmidが復元されていません');

      // 中央の縦線上の点(targetX, 中間のy)の画素が線の色(既定色 #e53935)のはず
      const sampleY = (ELBOW_A_RIGHT.y + ELBOW_B_LEFT.y) / 2;
      const outX = Math.round(targetX - bounds.x);
      const outY = Math.round(sampleY - bounds.y);
      const px = await page.evaluate((pt) => window.__annotator.getLastResultPixel(pt.x, pt.y), { x: outX, y: outY });
      assert.ok(px[0] > 150 && px[0] - px[1] > 40 && px[0] - px[2] > 40, `折れ線上の画素が線の色ではありません: ${px}`);

      printConsoleErrors(consoleErrors, 'カギ線の保存・復元');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('枠Bを削除すると、カギ線のtoはattach null・side nullになり、位置は削除前の末尾のまま', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await drawElbowAB(page);

      let st = await getDebugState(page);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      const rectB = findRectByX(st.shapes, 350);
      const shapesMap = Object.fromEntries(st.shapes.map((s) => [s.id, s]));
      const before = computeArrowEndpoints(arrow, shapesMap, () => 0);

      await selectTool(page, 'select');
      await clickOnCanvas(page, { x: rectB.x + 30, y: rectB.y + 30 }); // Bの内側(線から離れた点)をクリックして選択
      st = await getDebugState(page);
      assert.equal(st.selectedShapeId, rectB.id, '枠Bが選択されていません');

      await page.keyboard.press('Delete');
      st = await getDebugState(page);
      assert.equal(st.shapes.length, 2, 'Bの削除後は図形が2つ(rectA, arrow)のはずです');
      const updated = st.shapes.find((s) => s.id === arrow.id);
      assert.equal(updated.to.attach, null, '削除後は終点のattachがnullのはずです');
      assert.equal(updated.to.side, null, '削除後は終点のsideがnullのはずです');
      assertClose(updated.to.x, before.to.x, 1, '削除後の終点xが削除前の位置と異なります');
      assertClose(updated.to.y, before.to.y, 1, '削除後の終点yが削除前の位置と異なります');

      printConsoleErrors(consoleErrors, '接続先の削除');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('両端とも接続していないカギ線を横長にドラッグすると横→縦→横になる', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await selectTool(page, 'elbow');
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 400, y: 160 });

      const st = await getDebugState(page);
      const arrow = st.shapes.find((s) => s.type === 'arrow');
      assert.ok(arrow, 'カギ線が作成されていません');
      assert.equal(arrow.routing, 'elbow');
      assert.equal(arrow.from.attach, null);
      assert.equal(arrow.from.side, null, '未接続の端はsideもnullのはずです');
      assert.equal(arrow.to.attach, null);
      assert.equal(arrow.to.side, null);

      const points = await getElbowPolylinePoints(page, arrow.id);
      assert.equal(points.length, 4, '横→縦→横の4点のはずです');
      assertClose(points[0].y, points[1].y, 1, '1本目は水平のはずです');
      assertClose(points[1].x, points[2].x, 1, '2本目は垂直のはずです');
      assertClose(points[2].y, points[3].y, 1, '3本目は水平のはずです');
      assertAxisAlignedPolyline(points, '未接続のカギ線');

      printConsoleErrors(consoleErrors, '未接続のカギ線');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('直線の矢印ツールでのドラッグ中は接続先の枠が強調されるが、接続点(4つの丸)は出ない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await selectTool(page, 'rect');
      await dragOnCanvas(page, ELBOW_A_DRAG[0], ELBOW_A_DRAG[1]);

      await selectTool(page, 'arrow');
      const c1 = await imgToClient(page, 20, 20);
      const c2 = await imgToClient(page, ELBOW_A_RIGHT.x, ELBOW_A_RIGHT.y);
      await page.mouse.move(c1.x, c1.y);
      await page.mouse.down();
      await page.mouse.move(c2.x, c2.y, { steps: 5 });

      const targetCount = await countConnectTargets(page);
      const points = await getConnectPoints(page);
      assert.equal(targetCount, 1, '接続先の枠の強調が1つ出るはずです');
      assert.equal(points.length, 0, '直線の矢印では接続点(丸)は出ないはずです');

      await page.mouse.up();

      printConsoleErrors(consoleErrors, '直線の矢印の接続ヒント');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  await test('カギ線の折れ線の内側(角の内側で線から離れた点)をクリックしても選択されない', async () => {
    await withPage(browser, async ({ page, consoleErrors }) => {
      await openWithTestImage(page, { format: 'png', width: 800, height: 600 });
      await selectTool(page, 'elbow');
      await dragOnCanvas(page, { x: 100, y: 100 }, { x: 400, y: 160 }); // 横→縦→横。中央の縦線はx=250

      let st = await getDebugState(page);
      assert.equal(st.shapes.length, 1, '前提のカギ線が作成されていません');

      await selectTool(page, 'select');
      await clickOnCanvas(page, { x: 600, y: 400 }); // 空白をクリックして選択解除
      st = await getDebugState(page);
      assert.equal(st.selectedShapeId, null);

      // (235,120) は折れ線(y=100の横線・x=250の縦線・y=160の横線)の実際の線からは
      // 十分離れているが、<polyline> を(fill を持たないことを無視して)暗黙に閉じた
      // 領域(先頭(100,100)と末尾(400,160)を直線で結んだ領域)としては内側に入る点
      // (annotator.css の pointer-events: stroke が無いと実際にここが誤って
      // クリックに反応することを確認済み)
      await clickOnCanvas(page, { x: 235, y: 120 });
      st = await getDebugState(page);
      assert.equal(st.selectedShapeId, null, '折れ線の内側をクリックしても選択されないはずです');

      printConsoleErrors(consoleErrors, 'カギ線の内側クリック');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });
}

// ---------- エントリポイント ----------
async function main() {
  if (!existsSync(SANDBOX_HTML)) {
    console.error(
      `test-output/annotator-sandbox.html が見つかりません: ${SANDBOX_HTML}\n先に \`node dev/build-annotator-sandbox.mjs\` を実行してください。`
    );
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    env: browserEnv(),
  });

  const roundResults = [];
  try {
    for (let round = 1; round <= REPEAT; round++) {
      if (REPEAT > 1) {
        console.log(`\n\x1b[36m===== ラウンド ${round}/${REPEAT} =====\x1b[0m`);
      }
      const before = { pass: passCount, fail: failCount };
      await runTests(browser);
      roundResults.push({ round, pass: passCount - before.pass, fail: failCount - before.fail });
    }
  } finally {
    await browser.close();
  }

  console.log('');
  if (REPEAT > 1) {
    for (const r of roundResults) {
      const mark = r.fail === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`  ラウンド ${r.round}: ${mark} (${r.pass} passed, ${r.fail} failed)`);
    }
    const failedRounds = roundResults.filter((r) => r.fail > 0).length;
    console.log(`\n  ${roundResults.length - failedRounds}/${roundResults.length} ラウンドが完全に成功しました`);
  }
  const skipNote = skipCount > 0 ? `, ${skipCount} skipped` : '';
  console.log(`\n${passCount} passed, ${failCount} failed${skipNote}`);
  if (passCount === 0 && failCount === 0) {
    console.error(
      ONLY
        ? `\n\x1b[31mテストが1件も実行されませんでした: --only=${ONLY} に一致する名前がありません\x1b[0m`
        : '\n\x1b[31mテストが1件も実行されませんでした\x1b[0m'
    );
    process.exit(1);
  }
  if (failCount > 0) {
    console.log('失敗したテスト:');
    for (const n of [...new Set(failedNames)]) console.log('  - ' + n);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
