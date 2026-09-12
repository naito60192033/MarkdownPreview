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
import { fileURLToPath } from 'node:url';
import { computeArrowEndpoints } from '../src/annotator/shapes.js';

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

// 元画像ピクセル座標 → 画面上のクライアント座標(現在の zoom を考慮する)
async function imgToClient(page, x, y) {
  const box = await page.evaluate(() => window.__annotator.getSvgBox());
  const st = await page.evaluate(() => window.__annotator.getDebugState());
  return { x: box.left + x * st.zoom, y: box.top + y * st.zoom };
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

async function saveAndWaitClosed(page) {
  await page.click('[data-action="save"]');
  await waitFor(async () => !(await page.evaluate(() => window.__annotator.isOpen())), {
    message: '保存後にモーダルが閉じませんでした',
    timeout: 8000,
  });
  await waitFor(async () => !(await page.evaluate(() => window.__annotator.isPending())), {
    message: '保存の Promise が解決しませんでした',
  });
}

async function getDebugState(page) {
  return page.evaluate(() => window.__annotator.getDebugState());
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
      assertClose(st.crop.x, 50, 1, 'crop.x');
      assertClose(st.crop.y, 50, 1, 'crop.y');
      assertClose(st.crop.w, 250, 1, 'crop.w');
      assertClose(st.crop.h, 250, 1, 'crop.h');
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
      assertClose(st.crop.w, 585, 1, '再読み込み後の crop.w');
      assertClose(st.crop.h, 385, 1, '再読み込み後の crop.h');
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
      assert.equal(st.original.mime, 'image/jpeg');

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
