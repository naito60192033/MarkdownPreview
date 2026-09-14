// dev/harness.mjs
//
// `node dev/harness.mjs`(= `npm run test:e2e`)で走る E2E テストランナー。
// 外部フレームワークを使わない自前の test() ヘルパー、waitFor、browserEnv、
// --only、1件も実行されなければ失敗、という構成は task-kanri / フェーズ0を踏襲する。
// `file://` で開いた `dist/mdpreview.html` をヘッドレス Chromium で操作し、
// `window.showDirectoryPicker` を `dev/fake-fs.mjs` のフェイクに差し替えて検証する。
//
// フェーズ1(ワークスペース)・フェーズ2(エディタ+プレビュー)で検証する項目:
//   1. フォルダを選ぶとツリーに md とフォルダが出る(ドット始まり・md以外は出ない)。
//      サブフォルダの md も開ける
//   2. md を開いて入力するとプレビューが更新される(iframe は再読み込みされない)。
//      Ctrl+S でディスクに保存され、未保存の印が消える
//   3. 外部で md を書き換える → 未保存なしなら自動で取り込まれる/未保存ありなら通知バー
//   4. 読み込み後に外部で書き換えてから保存 → 競合モーダル。上書き保存/破棄して再読込
//   5. ルートの style.css を書き換えると、再読み込みなしでプレビューに反映される
//   6. 相対パスの画像が表示される(naturalWidth > 0)。サブフォルダの ../images/x.png も
//   7. mermaid が SVG で描画される。コードブロックが highlight.js で色付けされる
//   8. #file= 付きで開くとそのファイルが開く。再読み込み後にルートと最後のファイルが復元
//   9. プレビュー内の相対 .md リンクをクリックするとそのファイルが開く
// すべてのテストでコンソールエラーが0件であることを確認する。
//
// 前提: 開発コンテナでは先に `bash dev/setup-container.sh` を1度実行しておく。

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { installFakeFs } from './fake-fs.mjs';
import { serializeChunks, parseChunks, findChunk } from '../src/annotator/pngmeta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_HTML = path.join(REPO_ROOT, 'dist', 'mdpreview.html');
const DIST_URL = 'file://' + DIST_HTML;
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-output');

// 1x1 の赤いピクセルからなる最小の有効な PNG。
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// 1x1 の最小の有効な JPEG(注釈エディタの「PNG 以外」テスト用)。
const TEST_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

// 見た目の確認用に、指定サイズ・単色の PNG を実際に生成する(注釈エディタでの
// マウス操作や HTML 出力のスクリーンショットには 1x1 では小さすぎるため)。
// 1x1 の TEST_PNG_BASE64 と違い、PNG チャンクの組み立ては src/annotator/pngmeta.js
// (読み取り専用で利用。実装は別エージェントが担当中のため変更しない)の
// serializeChunks() をそのまま使う。
function makeSolidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method
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
  return Buffer.from(serializeChunks(chunks));
}

// ---------- CLI 引数 ----------
const ARGV = process.argv.slice(2);
function argValue(flag) {
  const hit = ARGV.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}
const ONLY = argValue('--only');
const REPEAT = Math.max(1, Number(argValue('--repeat')) || 1);

// この開発コンテナには Chromium の実行に必要な共有ライブラリとフォントが無いため、
// `dev/setup-container.sh` が /tmp/chromedeps 配下に展開したものを自動参照する。
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

// ---------- 自前の test() ヘルパー ----------
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

async function waitFor(fn, { timeout = 8000, interval = 100, message = '条件が満たされませんでした' } = {}) {
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

async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mdpreview-test-'));
}

async function ensureHooks(page) {
  await waitFor(async () => page.evaluate(() => typeof window.__mdpreview !== 'undefined'), {
    message: 'window.__mdpreview が未定義のままです(対象ページが __mdpreview フックを公開していません)',
  });
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

// 1 ページを用意して fn に渡す。rootDir を渡すと fake-fs をインストールする。
async function withPage(browser, { rootDir, url } = {}, fn) {
  const context = await browser.newContext();
  let fsController = null;
  if (rootDir) {
    fsController = await installFakeFs(context, { rootDir });
  }
  const page = await context.newPage();
  const consoleErrors = [];
  attachDebugLogging(page, consoleErrors);
  await page.goto(url || DIST_URL);
  await ensureHooks(page);
  try {
    return await fn({ page, context, consoleErrors, fsController });
  } finally {
    await context.close();
  }
}

// フォルダを選び、指定した md を開いた状態のページを用意する共通セットアップ。
async function pickFolderAndOpen(page, path_) {
  await page.evaluate(() => window.__mdpreview.pickFolder());
  await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).hasRoot, {
    message: 'フォルダの選択が完了しませんでした',
  });
  if (path_) {
    await page.evaluate((p) => window.__mdpreview.openFile(p), path_);
    await waitFor(
      async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === path_,
      { message: `${path_} を開けませんでした` }
    );
  }
}

// 外部プロセスがファイルを書き換えたことを検知しやすくするため、フォーカスイベントを
// 発火してポーリングを即座に走らせる(既定2秒間隔の待ちを毎回発生させないため)。
async function nudgeFocus(page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function getPreviewText(page) {
  return page.evaluate(() => window.__mdpreview.getPreviewDocument().body.textContent);
}

// プレビュー内の最初の画像にマウスを乗せる(画像編集ボタンを表示させるため)。
// iframe 内の座標に、iframe 要素自体の画面上の位置を足して画面座標に変換する。
async function hoverPreviewImage(page) {
  const box = await page.evaluate(() => {
    const doc = window.__mdpreview.getPreviewDocument();
    const img = doc.querySelector('img');
    const r = img.getBoundingClientRect();
    const frame = document.getElementById('preview').getBoundingClientRect();
    return { left: frame.left + r.left, top: frame.top + r.top, width: r.width, height: r.height };
  });
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.move(x + 1, y + 1); // mouseover を確実に発火させる
}

// 画像注釈エディタの .annotator-svg 上でキャンバス座標(1枚目の画像は (0,0) に
// 等倍で置かれるため元画像ピクセル座標と一致する)の2点間をドラッグして矩形を描く。
// エディタは無限キャンバス(viewBox をカメラとして動かす方式)になっており、開いた
// 直後の zoom・カメラ位置は画像サイズや画面サイズによって変わるため、
// svg.viewBox.baseVal から実際の変換係数を求めて使う(zoom=1 を前提にしない)。
async function drawRectOnAnnotator(page, from, to) {
  const box = await page.evaluate(() => {
    const svg = document.querySelector('.annotator-svg');
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { left: r.left, top: r.top, width: r.width, height: r.height, vbX: vb.x, vbY: vb.y, vbW: vb.width, vbH: vb.height };
  });
  const scaleX = box.width / box.vbW;
  const scaleY = box.height / box.vbH;
  const toClient = (pt) => ({
    x: box.left + (pt.x - box.vbX) * scaleX,
    y: box.top + (pt.y - box.vbY) * scaleY,
  });
  const p1 = toClient(from);
  const p2 = toClient(to);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, { steps: 3 });
  await page.mouse.move(p2.x, p2.y, { steps: 3 });
  await page.mouse.up();
}

// ---------- テスト本体 ----------
async function runTests(browser) {
  console.log('\n1) ファイルツリー(フォルダ・.md のみ表示、サブフォルダも開ける)');
  await test('ツリーはフォルダと .md だけを表示し、ドット始まり・md以外は隠す。サブフォルダの md も開ける', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');
      await fs.writeFile(path.join(dir, '.hidden.md'), '# hidden\n', 'utf8');
      await fs.writeFile(path.join(dir, 'notes.txt'), 'plain text\n', 'utf8');
      await fs.mkdir(path.join(dir, 'sub'));
      await fs.writeFile(path.join(dir, 'sub', 'b.md'), '# b\n\nサブフォルダの本文\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await page.evaluate(() => window.__mdpreview.pickFolder());
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).hasRoot);

        const topLevel = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#tree > ul > li')).map((li) => {
            const row = li.querySelector('.tree-row');
            const label = row.querySelector('.tree-label');
            return {
              text: (label ? label.textContent : row.textContent).trim(),
              isDir: li.classList.contains('tree-dir'),
            };
          })
        );
        const names = topLevel.map((e) => e.text);
        assert.ok(names.includes('a.md'), 'a.md がツリーに出ていません: ' + JSON.stringify(names));
        assert.ok(names.includes('sub'), 'sub フォルダがツリーに出ていません: ' + JSON.stringify(names));
        assert.ok(!names.includes('.hidden.md'), 'ドット始まりのファイルが表示されています');
        assert.ok(!names.includes('notes.txt'), '.md 以外のファイルが表示されています');

        // sub フォルダを開く(遅延読み込み)
        await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('#tree .tree-dir-row'));
          const row = rows.find((r) => r.querySelector('.tree-label').textContent.trim() === 'sub');
          row.click();
        });
        await waitFor(async () =>
          page.evaluate(() => !!Array.from(document.querySelectorAll('#tree .tree-file-row')).find((r) => r.textContent.trim() === 'b.md'))
        );

        // b.md を開く
        await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('#tree .tree-file-row'));
          const row = rows.find((r) => r.textContent.trim() === 'b.md');
          row.click();
        });
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'sub/b.md', {
          message: 'サブフォルダの md を開けませんでした',
        });

        printConsoleErrors(consoleErrors, 'ファイルツリー');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n2) 入力でプレビュー更新・Ctrl+S で保存');
  await test('md を開いて入力するとプレビューが更新される(iframe は再読み込みされない)。Ctrl+S で保存され未保存の印が消える', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.evaluate(() => {
          document.getElementById('preview').contentWindow.__noReloadMarker = 'kept';
        });

        await page.click('.cm-content');
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\n\n本文テキストです');

        await waitFor(async () => (await getPreviewText(page)).includes('本文テキストです'), {
          message: '入力がプレビューに反映されませんでした',
        });
        assert.ok((await page.evaluate(() => window.__mdpreview.getState())).dirty, '入力後に未保存状態になっていません');

        const markerKept = await page.evaluate(() => document.getElementById('preview').contentWindow.__noReloadMarker);
        assert.equal(markerKept, 'kept', 'iframe が再読み込みされています(srcdoc の再代入が起きた疑い)');

        await page.keyboard.press('Control+s');
        await waitFor(async () => !(await page.evaluate(() => window.__mdpreview.getState())).dirty, {
          message: 'Ctrl+S 後も未保存状態のままです',
        });

        const onDisk = await fs.readFile(path.join(dir, 'doc.md'), 'utf8');
        assert.ok(onDisk.includes('本文テキストです'), 'ディスク上のファイルが更新されていません');

        printConsoleErrors(consoleErrors, '入力・保存');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n3) 外部変更の検知(自動取り込み / 通知バー)');
  await test('未保存が無ければ外部変更を自動で取り込む', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期状態\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await sleep(30); // mtime の解像度対策
        await fs.writeFile(path.join(dir, 'doc.md'), '# 外部で更新\n', 'utf8');
        await nudgeFocus(page);

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('外部で更新'), {
          message: '外部変更が自動で取り込まれませんでした',
        });
        assert.ok(!(await page.evaluate(() => window.__mdpreview.getState())).dirty);

        printConsoleErrors(consoleErrors, '外部変更(自動取り込み)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('未保存があれば外部変更で通知バーが出て、[再読込] で取り込める', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期状態\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('.cm-content');
        await page.keyboard.type('ローカルの未保存の変更');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).dirty);

        await sleep(30);
        await fs.writeFile(path.join(dir, 'doc.md'), '# 外部で更新2\n', 'utf8');
        await nudgeFocus(page);

        await waitFor(async () => page.evaluate(() => window.__mdpreview.isNotifyBarVisible()), {
          message: '未保存がある状態で外部変更をしても通知バーが出ませんでした',
        });

        await page.evaluate(() => window.__mdpreview.clickNotifyReload());
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('外部で更新2'), {
          message: '通知バーの再読込で外部変更が取り込まれませんでした',
        });

        printConsoleErrors(consoleErrors, '外部変更(通知バー)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n4) 保存時の競合モーダル');
  await test('保存時に競合すると確認モーダルが出る。「上書き保存」でディスクを上書きできる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期状態\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('.cm-content');
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\nローカルの変更(上書き用)');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).dirty);

        await sleep(30);
        await fs.writeFile(path.join(dir, 'doc.md'), '# 競合させるための外部更新\n', 'utf8');

        await page.evaluate(() => { window.__mdpreview.save(); });
        await waitFor(async () => page.evaluate(() => window.__mdpreview.isConflictModalVisible()), {
          message: '競合モーダルが表示されませんでした',
        });

        await page.evaluate(() => window.__mdpreview.resolveConflict('overwrite'));
        await waitFor(async () => !(await page.evaluate(() => window.__mdpreview.getState())).dirty);

        const onDisk = await fs.readFile(path.join(dir, 'doc.md'), 'utf8');
        assert.ok(onDisk.includes('ローカルの変更(上書き用)'), '上書き保存がディスクに反映されていません');

        printConsoleErrors(consoleErrors, '競合(上書き保存)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('保存時に競合すると確認モーダルが出る。「破棄して再読込」でディスクの内容を取り込める', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期状態\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('.cm-content');
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\nローカルの変更(破棄される)');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).dirty);

        await sleep(30);
        await fs.writeFile(path.join(dir, 'doc.md'), '# 破棄して再読込されるべき内容\n', 'utf8');

        await page.evaluate(() => { window.__mdpreview.save(); });
        await waitFor(async () => page.evaluate(() => window.__mdpreview.isConflictModalVisible()), {
          message: '競合モーダルが表示されませんでした',
        });

        await page.evaluate(() => window.__mdpreview.resolveConflict('reload'));
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('破棄して再読込されるべき内容'),
          { message: '破棄して再読込がエディタに反映されませんでした' }
        );
        assert.ok(!(await page.evaluate(() => window.__mdpreview.getState())).dirty);

        printConsoleErrors(consoleErrors, '競合(破棄して再読込)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n5) style.css の即時反映');
  await test('ルートの style.css を書き換えると、再読み込みなしでプレビューに反映される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n本文\n', 'utf8');
      await fs.writeFile(path.join(dir, 'style.css'), '.crossnote.markdown-preview { color: rgb(10, 20, 30); }\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(async () =>
          page.evaluate(() => {
            const doc = window.__mdpreview.getPreviewDocument();
            const el = doc.querySelector('.crossnote.markdown-preview');
            return el && getComputedStyle(el).color === 'rgb(10, 20, 30)';
          })
        , { message: '初回の style.css がプレビューに反映されませんでした' });

        await sleep(30);
        await fs.writeFile(path.join(dir, 'style.css'), '.crossnote.markdown-preview { color: rgb(40, 50, 60); }\n', 'utf8');
        await nudgeFocus(page);

        await waitFor(async () =>
          page.evaluate(() => {
            const doc = window.__mdpreview.getPreviewDocument();
            const el = doc.querySelector('.crossnote.markdown-preview');
            return el && getComputedStyle(el).color === 'rgb(40, 50, 60)';
          })
        , { message: 'style.css の変更が再読み込みなしで反映されませんでした' });

        printConsoleErrors(consoleErrors, 'style.css 即時反映');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n6) 相対パスの画像(blob URL 化)');
  await test('相対パスの画像が表示される(ルート直下・サブフォルダの md からの ../ 参照の両方)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'x.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await fs.writeFile(path.join(dir, 'a.md'), '# 画像\n\n![alt](images/x.png)\n', 'utf8');
      await fs.mkdir(path.join(dir, 'sub'));
      await fs.writeFile(path.join(dir, 'sub', 'b.md'), '# 画像(サブフォルダから)\n\n![alt](../images/x.png)\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'a.md');
        await waitFor(async () =>
          page.evaluate(async () => {
            const doc = window.__mdpreview.getPreviewDocument();
            const img = doc.querySelector('img');
            if (!img) return false;
            if (img.complete) return img.naturalWidth > 0;
            return new Promise((resolve) => {
              img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
              img.addEventListener('error', () => resolve(false), { once: true });
            });
          })
        , { message: 'ルート直下の画像が表示されませんでした' });

        await page.evaluate(() => window.__mdpreview.openFile('sub/b.md'));
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'sub/b.md');
        await waitFor(async () =>
          page.evaluate(async () => {
            const doc = window.__mdpreview.getPreviewDocument();
            const img = doc.querySelector('img');
            if (!img) return false;
            if (img.complete) return img.naturalWidth > 0;
            return new Promise((resolve) => {
              img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
              img.addEventListener('error', () => resolve(false), { once: true });
            });
          })
        , { message: 'サブフォルダの md からの ../images/x.png が表示されませんでした' });

        printConsoleErrors(consoleErrors, '画像の blob URL 化');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n7) mermaid・highlight.js');
  await test('mermaid コードブロックが SVG として描画され、通常のコードブロックが highlight.js で色付けされる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 図とコード\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        const src = [
          '# 図とコード',
          '',
          '```mermaid',
          'graph TD;',
          '  A[開始] --> B[終了];',
          '```',
          '',
          '```javascript',
          'const answer = 42;',
          '```',
          '',
        ].join('\n');
        await page.evaluate((t) => window.__mdpreview.setEditorText(t), src);

        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('svg').length)) > 0,
          { message: 'mermaid が SVG を描画しませんでした', timeout: 8000 }
        );

        const hasHighlight = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const code = doc.querySelector('pre code.hljs');
          return !!code && code.querySelectorAll('[class^="hljs-"]').length > 0;
        });
        assert.ok(hasHighlight, 'コードブロックが highlight.js で色付けされていません');

        printConsoleErrors(consoleErrors, 'mermaid・highlight.js');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n8) #file= と再読み込み後の復元');
  await test('#file= 付きで開くとそのファイルが開く', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');
      await fs.writeFile(path.join(dir, 'b.md'), '# b\n', 'utf8');

      const url = DIST_URL + '#file=' + encodeURIComponent('b.md');
      await withPage(browser, { rootDir: dir, url }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'b.md', {
          message: '#file= で指定したファイルが開きませんでした',
        });

        printConsoleErrors(consoleErrors, '#file=');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('再読み込み後にルートと最後に開いたファイルが復元される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');
      await fs.writeFile(path.join(dir, 'b.md'), '# b\n', 'utf8');

      const browserContext = await browser.newContext();
      await installFakeFs(browserContext, { rootDir: dir });
      const page = await browserContext.newPage();
      const consoleErrors = [];
      attachDebugLogging(page, consoleErrors);
      try {
        await page.goto(DIST_URL);
        await ensureHooks(page);
        await pickFolderAndOpen(page, 'b.md');

        await page.reload();
        await ensureHooks(page);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).hasRoot, {
          message: '再読み込み後にルートが自動復元されませんでした',
        });
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'b.md', {
          message: '再読み込み後に最後に開いたファイルが復元されませんでした',
        });

        printConsoleErrors(consoleErrors, '再読み込み後の復元');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await browserContext.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n9) プレビュー内の相対 .md リンク');
  await test('プレビュー内の相対 .md リンクをクリックするとそのファイルが開く', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n\n[リンク](sub/other.md)\n', 'utf8');
      await fs.mkdir(path.join(dir, 'sub'));
      await fs.writeFile(path.join(dir, 'sub', 'other.md'), '# other\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'a.md');

        await waitFor(async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('a[href="sub/other.md"]')));

        await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          doc.querySelector('a[href="sub/other.md"]').click();
        });

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'sub/other.md', {
          message: 'プレビュー内のリンクをクリックしてもファイルが開きませんでした',
        });

        printConsoleErrors(consoleErrors, 'プレビュー内リンク');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // 以下、統合作業(レビュー指摘の修正・MPE互換の組み込み・画像の貼り付け/注釈
  // エディタ/HTML出力)の検証。
  // ---------------------------------------------------------------------

  console.log('\n10) 変更検知と保存の競合(レビュー指摘1)');
  await test('保存前に読み始めた確認処理の結果が保存後に届いても、保存直後の内容を古い内容で上書きしない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        const result = await page.evaluate(() =>
          window.__mdpreview.simulateStaleWatchDuringSave({ delayMs: 600, newText: '# 保存された内容\n', settleWaitMs: 150 })
        );

        assert.equal(result.dirty, false, '保存が完了していません');
        assert.ok(result.text.includes('保存された内容'), '保存直後の内容が古い内容で上書きされました: ' + result.text);

        const onDisk = await fs.readFile(path.join(dir, 'doc.md'), 'utf8');
        assert.ok(onDisk.includes('保存された内容'), 'ディスクの内容が保存後のものになっていません');
        assert.equal(await page.evaluate(() => window.__mdpreview.isNotifyBarVisible()), false, '不要な通知バーが表示されています');

        printConsoleErrors(consoleErrors, '変更検知と保存の競合');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n11) 描画の順序(レビュー指摘2)');
  await test('@import の読み込みで待たされる古い描画より後に始めた新しい描画が先に終わっても、最終的に新しい内容が残る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期\n', 'utf8');
      await fs.writeFile(path.join(dir, 'slow.md'), '遅い取り込みの本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__fakeFs.setDelay({ read: 700 }));

        // 古い描画(@import の読み込みで待たされる)。await せずに発行だけする。
        await page.evaluate(() => {
          window.__mdpreview.setEditorText('# 古い\n\n@import "slow.md"\n');
        });
        // すぐに新しい描画(@import なしで速い)を発行し、完了を待つ。
        await page.evaluate(() => window.__mdpreview.setEditorText('# 新しい\n\n新しい内容です\n'));

        await waitFor(async () => (await getPreviewText(page)).includes('新しい内容です'), {
          message: '新しい描画がプレビューに反映されませんでした',
        });

        // 古い描画の @import 読み込みが完了するのを待っても、内容が古い方に戻らないこと。
        await sleep(900);
        const text = await getPreviewText(page);
        assert.ok(text.includes('新しい内容です'), '古い描画の結果でプレビューが上書きされました: ' + text);
        assert.ok(!text.includes('遅い取り込みの本文'), '古い描画(@import の内容)がプレビューに残っています: ' + text);

        printConsoleErrors(consoleErrors, '描画の順序');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n12) 画像キャッシュの解放(レビュー指摘3)');
  await test('遅い描画の画像確認が後から終わっても、新しい描画が使っている画像の blob URL を解放しない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'img1.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await fs.writeFile(path.join(dir, 'images', 'img2.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await fs.writeFile(path.join(dir, 'doc.md'), '# 画像\n\n![img1](images/img1.png)\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => {
            const img = window.__mdpreview.getPreviewDocument().querySelector('img');
            return !!img && img.complete && img.naturalWidth > 0;
          })
        );

        await page.evaluate(() => window.__fakeFs.setDelay({ read: 700 }));
        // 古い描画(img1 の再確認で待たされる)。await せずに発行だけする。
        await page.evaluate(() => {
          window.__mdpreview.setEditorText('# 画像\n\n![img1](images/img1.png)\n');
        });
        await page.evaluate(() => window.__fakeFs.setDelay({ read: 0 }));
        // 新しい描画(img2 に差し替え)を発行し、反映を待つ。
        await page.evaluate(() => window.__mdpreview.setEditorText('# 画像\n\n![img2](images/img2.png)\n'));

        await waitFor(
          async () =>
            page.evaluate(() => {
              const img = window.__mdpreview.getPreviewDocument().querySelector('img');
              return !!img && img.getAttribute('data-src') === 'images/img2.png' && (img.src || '').startsWith('blob:');
            }),
          { message: '新しい描画(img2)がプレビューに反映されませんでした' }
        );

        const blobUrlBefore = await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('img').src);

        // 古い描画(img1)の画像確認が完了するまで待つ。
        await sleep(900);

        // img2 の blob URL が生きたまま(revoke されていない)であること。
        const stillOk = await page.evaluate(
          (url) =>
            new Promise((resolve) => {
              const doc = window.__mdpreview.getPreviewDocument();
              const testImg = doc.createElement('img');
              testImg.onload = () => resolve(testImg.naturalWidth > 0);
              testImg.onerror = () => resolve(false);
              testImg.src = url;
            }),
          blobUrlBefore
        );
        assert.ok(stillOk, '新しい描画が使っている画像の blob URL が解放されてしまいました');

        const srcAfter = await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('img').src);
        assert.equal(srcAfter, blobUrlBefore, '表示中の画像の src が変わってしまいました');

        printConsoleErrors(consoleErrors, '画像キャッシュの解放');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n13) 保存の二重実行(レビュー指摘4)');
  await test('保存中に2回目の保存を呼んでも無視され、競合モーダルが誤って出ない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('.cm-content');
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\n本文');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).dirty);

        await page.evaluate(() => window.__fakeFs.setDelay({ read: 500 }));
        await page.evaluate(() => {
          window.__mdpreview.save(); // 1回目(競合チェックの読み込みで少し時間がかかる)
          window.__mdpreview.save(); // 2回目(1回目がまだ保存中のはずなので無視される)
        });

        await waitFor(async () => !(await page.evaluate(() => window.__mdpreview.getState())).dirty, {
          message: '保存が完了しませんでした',
        });
        await sleep(600);

        assert.equal(
          await page.evaluate(() => window.__mdpreview.isConflictModalVisible()),
          false,
          '不要な競合モーダルが表示されました'
        );
        const onDisk = await fs.readFile(path.join(dir, 'doc.md'), 'utf8');
        assert.ok(onDisk.includes('本文'), 'ディスクの内容が保存されていません');

        printConsoleErrors(consoleErrors, '保存の二重実行');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n14) HTML で書いた画像(レビュー指摘5)');
  await test('生の <img src="..."> で書かれた画像も blob URL に解決され、width 属性を保ったままコンソールエラーが出ない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'a.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n<img src="images/a.png" width="300">\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(
          async () =>
            page.evaluate(async () => {
              const doc = window.__mdpreview.getPreviewDocument();
              const img = doc.querySelector('img');
              if (!img) return false;
              if (img.complete) return img.naturalWidth > 0;
              return new Promise((resolve) => {
                img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
                img.addEventListener('error', () => resolve(false), { once: true });
              });
            }),
          { message: 'HTML で直接書いた <img> が表示されませんでした' }
        );

        const widthAttr = await page.evaluate(() =>
          window.__mdpreview.getPreviewDocument().querySelector('img').getAttribute('width')
        );
        assert.equal(widthAttr, '300', 'width 属性が保たれていません');

        printConsoleErrors(consoleErrors, 'HTML で書いた画像');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n15) MPE互換: @import');
  await test('@import が入れ子・別フォルダの画像とともに展開され、外部で @import 先を書き換えると再描画される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'sub', 'images'), { recursive: true });
      await fs.writeFile(path.join(dir, 'sub', 'images', 'x.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await fs.writeFile(path.join(dir, 'sub', 'child.md'), '## 子見出し\n\n![img](images/x.png)\n', 'utf8');
      await fs.writeFile(path.join(dir, 'doc.md'), '# 親\n\n@import "sub/child.md"\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(async () => (await getPreviewText(page)).includes('子見出し'), {
          message: '@import 先の内容が展開されませんでした',
        });
        await waitFor(
          async () =>
            page.evaluate(async () => {
              const doc = window.__mdpreview.getPreviewDocument();
              const img = doc.querySelector('img');
              if (!img) return false;
              if (img.complete) return img.naturalWidth > 0;
              return new Promise((resolve) => {
                img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
                img.addEventListener('error', () => resolve(false), { once: true });
              });
            }),
          { message: '@import 先(別フォルダ)の画像が表示されませんでした' }
        );

        await sleep(30);
        await fs.writeFile(path.join(dir, 'sub', 'child.md'), '## 更新後の子見出し\n\n![img](images/x.png)\n', 'utf8');
        await nudgeFocus(page);

        await waitFor(async () => (await getPreviewText(page)).includes('更新後の子見出し'), {
          message: '@import 先を外部で書き換えても再描画されませんでした',
        });

        printConsoleErrors(consoleErrors, '@import');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n16) MPE互換: [TOC] クリックでスクロール');
  await test('[TOC] の目次リンクをクリックすると見出しへスクロールする', async () => {
    const dir = await mkTmpDir();
    try {
      const paras = Array.from({ length: 80 }, (_, i) => `本文${i}\n`).join('\n');
      const content = `# 見出しA\n\n[TOC]\n\n${paras}\n## 見出しB\n\n下の本文\n`;
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(async () =>
          page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('a[href="#見出しb"]'))
        );

        await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          doc.querySelector('a[href="#見出しb"]').click();
        });

        await waitFor(
          async () =>
            page.evaluate(() => {
              const doc = window.__mdpreview.getPreviewDocument();
              const scrollRoot = doc.scrollingElement || doc.documentElement;
              return scrollRoot.scrollTop > 0;
            }),
          { message: '見出しへスクロールしませんでした' }
        );

        printConsoleErrors(consoleErrors, '[TOC] クリックでスクロール');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n17) MPE互換: ソース書き込み型 TOC の保存時更新(CRLF)');
  await test('保存時にソース書き込み型 TOC が更新され、CRLF のファイルでも CRLF が保たれる', async () => {
    const dir = await mkTmpDir();
    try {
      const content =
        '# 見出し\r\n\r\n' +
        '<!-- @import "[TOC]" {cmd="toc" depthFrom=1 depthTo=6 orderedList=false} -->\r\n' +
        '\r\n<!-- code_chunk_output -->\r\n\r\n- [古い](#古い)\r\n\r\n<!-- /code_chunk_output -->\r\n' +
        '\r\n## 新しい見出し\r\n\r\n本文\r\n';
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__mdpreview.save());
        await waitFor(async () => !(await page.evaluate(() => window.__mdpreview.getState())).dirty);

        const onDisk = await fs.readFile(path.join(dir, 'doc.md'), 'utf8');
        assert.match(onDisk, /\[新しい見出し\]\(#新しい見出し\)/);
        assert.doesNotMatch(onDisk, /古い/);
        assert.ok(!/[^\r]\n/.test(onDisk), 'CRLF が保たれていません(裸の LF が混入しています)');
        assert.ok(onDisk.includes('\r\n'), 'CRLF になっていません');

        printConsoleErrors(consoleErrors, 'ソース書き込み型 TOC');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n18) MPE互換: アラート');
  await test('> [!WARNING] 等が div.markdown-alert として描画される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n> [!WARNING]\n> 注意してください\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(
            () => !!window.__mdpreview.getPreviewDocument().querySelector('div.markdown-alert.markdown-alert-warning')
          )
        );
        const titleText = await page.evaluate(
          () => window.__mdpreview.getPreviewDocument().querySelector('.markdown-alert-title').textContent
        );
        assert.equal(titleText, 'Warning');

        printConsoleErrors(consoleErrors, 'アラート');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n18-2) アラート拡張: GitHub 方式と Qiita 方式の混在・9 種類');
  await test('GitHub 方式と Qiita 方式のアラートが同じ構造(div.markdown-alert)で描画され、枠線・背景色が付く', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# アラート確認',
        '',
        '> [!NOTE]',
        '> note 本文(GitHub 方式)',
        '',
        ':::note info',
        'note 本文(Qiita 方式)',
        ':::',
        '',
        '> [!LINK]',
        '> link 本文(GitHub 方式)',
        '',
        ':::note link',
        'link 本文(Qiita 方式)',
        ':::',
        '',
        '> [!MEMO]',
        '> memo 本文(GitHub 方式)',
        '',
        ':::memo',
        'memo 本文(Qiita 方式・省略形)',
        ':::',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(async () =>
          page.evaluate(
            () => window.__mdpreview.getPreviewDocument().querySelectorAll('div.markdown-alert.markdown-alert-note').length === 2
          ),
          { message: 'GitHub 方式・Qiita 方式それぞれの note アラートが描画されませんでした' }
        );
        assert.equal(
          await page.evaluate(
            () => window.__mdpreview.getPreviewDocument().querySelectorAll('div.markdown-alert.markdown-alert-link').length
          ),
          2,
          'GitHub 方式・Qiita 方式それぞれの link アラートが描画されませんでした'
        );

        const styles = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const divs = Array.from(doc.querySelectorAll('div.markdown-alert.markdown-alert-note'));
          return divs.map((el) => {
            const cs = getComputedStyle(el);
            return {
              borderWidth: cs.borderTopWidth,
              borderStyle: cs.borderTopStyle,
              borderColor: cs.borderTopColor,
              backgroundColor: cs.backgroundColor,
              borderRadius: cs.borderTopLeftRadius,
            };
          });
        });
        assert.equal(styles.length, 2);
        for (const s of styles) {
          assert.equal(s.borderWidth, '1px', '枠線の太さが 1px ではありません: ' + JSON.stringify(s));
          assert.equal(s.borderStyle, 'solid', '枠線が実線ではありません: ' + JSON.stringify(s));
          assert.equal(s.borderColor, 'rgb(169, 193, 221)', 'note の枠線色が想定と異なります: ' + JSON.stringify(s));
          assert.equal(s.backgroundColor, 'rgb(244, 248, 252)', 'note の背景色が想定と異なります: ' + JSON.stringify(s));
          assert.equal(s.borderRadius, '6px', '角丸になっていません: ' + JSON.stringify(s));
        }
        // GitHub 方式・Qiita 方式で同じ見た目(構造)になっていること
        assert.deepEqual(styles[0], styles[1], 'GitHub 方式と Qiita 方式で見た目が異なります');

        const titleColor = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const title = doc.querySelector('div.markdown-alert.markdown-alert-note .markdown-alert-title');
          return getComputedStyle(title).color;
        });
        assert.equal(titleColor, 'rgb(44, 95, 148)', 'note のタイトル文字色が想定と異なります');

        // 追加した memo(GitHub 方式・Qiita 方式省略形の両方)も同じ構造で描画される。
        assert.equal(
          await page.evaluate(
            () => window.__mdpreview.getPreviewDocument().querySelectorAll('div.markdown-alert.markdown-alert-memo').length
          ),
          2,
          'GitHub 方式・Qiita 方式(省略形)それぞれの memo アラートが描画されませんでした'
        );
        const memoStyle = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const el = doc.querySelector('div.markdown-alert.markdown-alert-memo');
          const cs = getComputedStyle(el);
          return { borderColor: cs.borderTopColor, backgroundColor: cs.backgroundColor };
        });
        assert.equal(memoStyle.borderColor, 'rgb(214, 202, 187)', 'memo の枠線色が想定と異なります');
        assert.equal(memoStyle.backgroundColor, 'rgb(250, 248, 245)', 'memo の背景色が想定と異なります');

        const hasIcon = await page.evaluate(
          () => !!window.__mdpreview.getPreviewDocument().querySelector('.markdown-alert-title svg.octicon')
        );
        assert.ok(hasIcon, 'タイトルにアイコンの svg がありません');

        printConsoleErrors(consoleErrors, 'アラート拡張(混在・9種類)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('1ファイル出力にもアイコンの svg が含まれる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# アラート\n\n> [!NOTE]\n> 本文\n\n:::note warn\n本文\n:::\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('.markdown-alert-title svg.octicon').length === 2)
        );
        await page.evaluate(() => window.__mdpreview.exportStandalone());
        await waitFor(async () => existsSync(path.join(dir, 'doc.standalone.html')));
      });

      const context = await browser.newContext();
      const page2 = await context.newPage();
      try {
        await page2.goto('file://' + path.join(dir, 'doc.standalone.html'));
        const iconCount = await page2.evaluate(() => document.querySelectorAll('.markdown-alert-title svg.octicon').length);
        assert.equal(iconCount, 2, 'HTML 出力(1ファイル)にアイコンの svg が含まれていません');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('9 種類 × 2 方式のアラートを並べたプレビューのスクリーンショットを保存する', async () => {
    const dir = await mkTmpDir();
    try {
      const kinds = [
        ['NOTE', 'info'],
        ['TIP', 'tip'],
        ['IMPORTANT', 'important'],
        ['WARNING', 'warn'],
        ['CAUTION', 'alert'],
        ['LINK', 'link'],
        ['MEMO', 'memo'],
        ['CHECK', 'check'],
        ['QUESTION', 'question'],
      ];
      const lines = ['# アラート一覧(GitHub 方式・Qiita 方式)', ''];
      for (const [marker] of kinds) {
        lines.push(`> [!${marker}]`, `> ${marker} の本文です(GitHub 方式)。`, '');
      }
      for (const [marker, qiitaWord] of kinds) {
        lines.push(`:::${qiitaWord}`, `${marker} の本文です(Qiita 方式・省略形)。`, ':::', '');
      }
      await fs.writeFile(path.join(dir, 'doc.md'), lines.join('\n'), 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 1000 });
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('div.markdown-alert').length === 18)
        );

        await page.click('.view-mode-btn[data-view-mode="preview"]');
        await sleep(200); // レイアウト安定待ち

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'alerts.png') });
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('タイトル空欄(アイコンのみ)のプレビューのスクリーンショットを保存する', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# タイトル空欄(アイコンのみ)',
        '',
        '> [!NOTE]',
        '> タイトルを空欄にすると、アイコンだけが左上に表示されます。',
        '',
        '> [!TIP]',
        '> 本文 1 行目とアイコンの縦位置が揃います。',
        '',
        '> [!WARNING] タイトルを書けば設定が空欄でも表示されます',
        '> md 側で明示的にタイトルを書いた場合の例です。',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 1000 });
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('div.markdown-alert').length === 3)
        );

        // 設定パネルで note と tip のタイトルを空欄にする(warning は空欄のままにし、
        // md 側の明示タイトルが優先されることを確認する)。
        await page.click('#settingsBtn');
        await page.evaluate(() => {
          for (const id of ['settingAlertTitleNote', 'settingAlertTitleTip', 'settingAlertTitleWarning']) {
            const input = document.getElementById(id);
            input.value = '';
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        await page.click('#settingsCloseBtn');

        await waitFor(async () =>
          page.evaluate(() => {
            const doc = window.__mdpreview.getPreviewDocument();
            return (
              doc.querySelectorAll('div.markdown-alert-notitle').length === 2 &&
              !doc.querySelector('div.markdown-alert-warning').classList.contains('markdown-alert-notitle')
            );
          }),
          { message: 'タイトル空欄の反映がプレビューに出ませんでした' }
        );

        await page.click('.view-mode-btn[data-view-mode="preview"]');
        await sleep(200); // レイアウト安定待ち

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'alerts-notitle.png') });
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n18-3) アラート拡張: 設定でタイトルを空欄にする(空欄と未設定の区別)');
  await test('アラートのタイトルを空欄にすると本文がアイコンのみになり、再読み込み後も既定値に戻らない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n> [!NOTE]\n> 本文\n', 'utf8');

      const context = await browser.newContext();
      await installFakeFs(context, { rootDir: dir });
      const page = await context.newPage();
      const consoleErrors = [];
      attachDebugLogging(page, consoleErrors);
      try {
        await page.goto(DIST_URL);
        await ensureHooks(page);
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(async () =>
          page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('div.markdown-alert.markdown-alert-note'))
        );

        // 設定パネルでタイトルを空欄にする。
        await page.click('#settingsBtn');
        await page.evaluate(() => {
          const input = document.getElementById('settingAlertTitleNote');
          input.value = '';
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await waitFor(
          async () =>
            page.evaluate(() => {
              const doc = window.__mdpreview.getPreviewDocument();
              const div = doc.querySelector('div.markdown-alert.markdown-alert-note');
              return !!div && div.classList.contains('markdown-alert-notitle');
            }),
          { message: 'タイトルを空欄にしても markdown-alert-notitle が付きませんでした' }
        );

        const titleTextBefore = await page.evaluate(
          () => window.__mdpreview.getPreviewDocument().querySelector('.markdown-alert-note .markdown-alert-title').textContent
        );
        assert.equal(titleTextBefore, '', 'アイコンのみのはずが、タイトル文字が残っています');

        // 再読み込みしても「空欄」のままで、既定値(Note)に戻らないこと。
        await page.reload();
        await ensureHooks(page);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).hasRoot);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'doc.md');

        const settingsAfterReload = await page.evaluate(() => window.__mdpreview.getSettings());
        assert.equal(settingsAfterReload.alertTitles.note, '', '再読み込み後に既定値(Note)へ戻ってしまいました');

        await waitFor(
          async () =>
            page.evaluate(() => {
              const doc = window.__mdpreview.getPreviewDocument();
              const div = doc.querySelector('div.markdown-alert.markdown-alert-note');
              return !!div && div.classList.contains('markdown-alert-notitle');
            }),
          { message: '再読み込み後にアイコンのみの表示が保たれませんでした' }
        );

        // 「既定に戻す」ボタンで既定のタイトル(Note)に戻ることも確認する。
        await page.click('#settingsBtn');
        await page.click('#resetAlertTitleNote');
        await waitFor(
          async () =>
            page.evaluate(() => {
              const doc = window.__mdpreview.getPreviewDocument();
              const div = doc.querySelector('div.markdown-alert.markdown-alert-note');
              return !!div && !div.classList.contains('markdown-alert-notitle');
            }),
          { message: '「既定に戻す」ボタンを押しても既定のタイトルに戻りませんでした' }
        );
        const titleTextAfterReset = await page.evaluate(
          () => window.__mdpreview.getPreviewDocument().querySelector('.markdown-alert-note .markdown-alert-title').textContent
        );
        assert.equal(titleTextAfterReset, 'Note', '「既定に戻す」後のタイトルが Note になっていません');
        assert.equal(
          await page.evaluate(() => document.getElementById('settingAlertTitleNote').value),
          'Note',
          '「既定に戻す」後の入力欄の値が Note になっていません'
        );

        printConsoleErrors(consoleErrors, 'タイトル空欄設定の永続化');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n18-4) 設定パネル: 背景クリックで閉じる判定');
  await test('入力欄でドラッグ選択してモーダルの外で離しても閉じない(背景のクリックでは閉じる)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n', 'utf8');

      const context = await browser.newContext();
      await installFakeFs(context, { rootDir: dir });
      const page = await context.newPage();
      const consoleErrors = [];
      attachDebugLogging(page, consoleErrors);
      try {
        await page.goto(DIST_URL);
        await ensureHooks(page);
        await pickFolderAndOpen(page, 'doc.md');

        const isOpen = () => page.evaluate(() => document.getElementById('settingsPanel').style.display !== 'none');
        await page.click('#settingsBtn');
        assert.ok(await isOpen(), '設定パネルが開きませんでした');

        // 入力欄の中でマウスを押し、モーダルの外(背景の左上)まで動かして離す
        const box = await page.locator('#settingsPanel .modal input[type="text"]').first().boundingBox();
        await page.mouse.move(box.x + 4, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(5, 5, { steps: 5 });
        await page.mouse.up();
        assert.ok(await isOpen(), '入力欄からドラッグしてモーダルの外で離すと閉じてしまいました');

        // 背景の上で押して離す(通常のクリック)なら閉じる
        await page.mouse.click(5, 5);
        await waitFor(async () => !(await isOpen()), { message: '背景をクリックしても設定パネルが閉じませんでした' });

        printConsoleErrors(consoleErrors, '設定パネルの背景クリック');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n19) MPE互換: 日本語見出しの id');
  await test('## 1. はじめに の id が 1-はじめに になる(既存 md の #見出し リンクとの互換用)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '## 1. はじめに\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => !!window.__mdpreview.getPreviewDocument().getElementById('1-はじめに'))
        );
        printConsoleErrors(consoleErrors, '日本語見出しの id');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n20) 画像の貼り付けとドロップ');
  await test('クリップボードの画像を貼り付けると images/<md名>/image-1.png に保存され(base64 にしない)、参照が挿入されプレビューに表示される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 貼り付けテスト\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await page.evaluate(async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const target = document.querySelector('.cm-content');
          const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          target.dispatchEvent(evt);
        }, TEST_PNG_BASE64);

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('](images/'), {
          message: '画像の参照が挿入されませんでした',
        });

        const text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.match(text, /!\[\]\(images\/doc\/image-1\.png\)/, '画像参照の形式が想定と異なります: ' + text);
        assert.ok(!text.includes('base64'), '貼り付けで base64 が埋め込まれています: ' + text);

        const files = await fs.readdir(path.join(dir, 'images', 'doc'));
        assert.deepEqual(files, ['image-1.png'], 'images/doc/image-1.png が保存されていません: ' + JSON.stringify(files));

        await waitFor(
          async () =>
            page.evaluate(async () => {
              const doc = window.__mdpreview.getPreviewDocument();
              const img = doc.querySelector('img');
              if (!img) return false;
              if (img.complete) return img.naturalWidth > 0;
              return new Promise((resolve) => {
                img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
                img.addEventListener('error', () => resolve(false), { once: true });
              });
            }),
          { message: '貼り付けた画像がプレビューに表示されませんでした' }
        );

        printConsoleErrors(consoleErrors, '画像の貼り付け');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('画像ファイルのドロップで images/<md名>/ に既存の続きの連番で保存され、参照が挿入される(元の拡張子を保つ・複数ファイル)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# ドロップテスト\n', 'utf8');
      // 既存の連番の続きから振られることを確かめるため、image-1.png を先に置いておく
      await fs.mkdir(path.join(dir, 'images', 'doc'), { recursive: true });
      await fs.writeFile(path.join(dir, 'images', 'doc', 'image-1.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await page.evaluate(
          async ({ pngB64, jpgB64 }) => {
            const toFile = (b64, name, type) => {
              const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
              return new File([bytes], name, { type });
            };
            const dt = new DataTransfer();
            dt.items.add(toFile(pngB64, 'shot1.png', 'image/png'));
            dt.items.add(toFile(jpgB64, 'shot2.jpg', 'image/jpeg'));
            dt.items.add(toFile(pngB64, 'flow.drawio.png', 'image/png'));
            const target = document.querySelector('.cm-content');
            const rect = target.getBoundingClientRect();
            const evt = new DragEvent('drop', {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              clientX: rect.left + 10,
              clientY: rect.top + 10,
            });
            target.dispatchEvent(evt);
          },
          { pngB64: TEST_PNG_BASE64, jpgB64: TEST_JPEG_BASE64 }
        );

        await waitFor(
          async () => {
            const text = await page.evaluate(() => window.__mdpreview.getEditorText());
            return (text.match(/!\[\]\(images\//g) || []).length === 3;
          },
          { message: '3件の画像参照が挿入されませんでした' }
        );

        const text = await page.evaluate(() => window.__mdpreview.getEditorText());
        // 既存の image-1.png があるので連番は 2 から(拡張子が違っても番号は重ねない)
        assert.match(text, /!\[\]\(images\/doc\/image-2\.png\)/, 'png の参照が見つかりません: ' + text);
        assert.match(text, /!\[\]\(images\/doc\/image-3\.jpg\)/, 'jpg の参照が見つかりません(元の拡張子が保たれていません): ' + text);
        assert.match(text, /!\[\]\(images\/doc\/image-4\.drawio\.png\)/, '.drawio.png の参照が見つかりません: ' + text);

        const files = (await fs.readdir(path.join(dir, 'images', 'doc'))).sort();
        assert.deepEqual(
          files,
          ['image-1.png', 'image-2.png', 'image-3.jpg', 'image-4.drawio.png'],
          'images/doc/ の内容が想定と異なります: ' + JSON.stringify(files)
        );

        printConsoleErrors(consoleErrors, '画像のドロップ');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('draw.io の通常のコピー(図形データ)を貼り付けても挿入せず、「画像としてコピー」を案内する。普通のテキストは貼り付けられる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# draw.io\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        const pasteText = (text) =>
          page.evaluate((t) => {
            const dt = new DataTransfer();
            dt.setData('text/plain', t);
            const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            document.querySelector('.cm-content').dispatchEvent(evt);
          }, text);

        // draw.io の EditorUi.copyCells と同じ形(encodeURIComponent した mxGraphModel)
        await pasteText(encodeURIComponent('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'));
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getStatusMessage())).includes('画像としてコピー'), {
          message: '「画像としてコピー」の案内が表示されませんでした',
        });
        assert.equal(await page.evaluate(() => window.__mdpreview.getEditorText()), '# draw.io\n', '図形データが挿入されています');
        assert.ok(!(await fs.readdir(dir)).includes('images'), 'images/ が作られています');

        // 普通のテキストは従来どおり CodeMirror が貼り付ける
        await pasteText('ふつうの文字');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('ふつうの文字'), {
          message: '普通のテキストが貼り付けられませんでした',
        });

        printConsoleErrors(consoleErrors, 'draw.io の貼り付け');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n21) 画像注釈エディタの組み込み');
  await test('画像の編集ボタン → 赤枠を描いて保存 → ファイルが更新され mdIM チャンクが入っている', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'shot.png'), makeSolidPng(80, 80, [40, 60, 200]));
      await fs.writeFile(path.join(dir, 'doc.md'), '# 画像編集\n\n![shot](images/shot.png)\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => {
            const img = window.__mdpreview.getPreviewDocument().querySelector('img');
            return !!img && img.complete && img.naturalWidth > 0;
          })
        );

        await hoverPreviewImage(page);
        await waitFor(
          async () =>
            page.evaluate(() => {
              const btn = window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn');
              return !!btn && btn.style.display !== 'none';
            }),
          { message: '画像編集ボタンが表示されませんでした' }
        );

        // 編集ボタンは iframe(プレビュー)の document 内にあるため、通常の
        // page.click() ではなく DOM 経由でクリックする。
        await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn').click());
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.annotator-svg')), {
          message: '注釈エディタが開きませんでした',
        });

        await page.click('.annotator-tool-btn[data-tool="rect"]');
        await drawRectOnAnnotator(page, { x: 10, y: 10 }, { x: 40, y: 40 });

        await page.click('[data-action="save"]');
        await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.annotator-svg'))), {
          message: '保存後に注釈エディタが閉じませんでした',
        });

        await waitFor(async () => (await getPreviewText(page)) !== undefined); // 再描画の完了を軽く待つ
        await sleep(200);

        const bytes = await fs.readFile(path.join(dir, 'images', 'shot.png'));
        const chunks = parseChunks(new Uint8Array(bytes));
        assert.ok(findChunk(chunks, 'mdIM'), 'mdIM チャンクが見つかりません(元画像が埋め込まれていません)');

        printConsoleErrors(consoleErrors, '画像注釈エディタ(PNG 上書き)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('保存処理の最中に入力した内容は未保存のまま残る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# A\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        const st = await page.evaluate(async () => {
          const h = window.__mdpreview;
          await h.setEditorText('# B\n');
          // 書き込みの完了通知を遅らせ、その間に入力する(SMB の遅い保存を再現)
          await window.__fakeFs.setDelay({ write: 800 });
          const saving = h.save();
          await new Promise((r) => setTimeout(r, 200));
          await h.setEditorText('# C\n');
          await saving;
          await window.__fakeFs.setDelay({ write: 0 });
          return h.getState();
        });
        assert.equal(await fs.readFile(path.join(dir, 'doc.md'), 'utf8'), '# B\n');
        assert.equal(st.dirty, true, '保存中に入力した内容が保存済み扱いになっています');
        printConsoleErrors(consoleErrors, '保存中の入力');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('JPEG を編集すると .png が新規作成され、参照が書き換わる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      // 日本語 + 空白を含むファイル名で、<...> 形式の markdown 参照と HTML の <img> の両方を
      // 書き換えられることを確認する(data-src は markdown-it が %エンコードした形になるため)。
      await fs.writeFile(path.join(dir, 'images', '写真 1.jpg'), Buffer.from(TEST_JPEG_BASE64, 'base64'));
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '# JPEG編集\n\n![photo](<images/写真 1.jpg>)\n\n<img src="images/写真 1.jpg" width="100">\n',
        'utf8'
      );

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(async () => {
            const doc = window.__mdpreview.getPreviewDocument();
            const img = doc.querySelector('img');
            if (!img) return false;
            if (img.complete) return img.naturalWidth > 0;
            return new Promise((resolve) => {
              img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
              img.addEventListener('error', () => resolve(false), { once: true });
            });
          })
        );

        await hoverPreviewImage(page);
        await waitFor(async () =>
          page.evaluate(() => {
            const btn = window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn');
            return !!btn && btn.style.display !== 'none';
          })
        );
        // 編集ボタンは iframe(プレビュー)の document 内にあるため、通常の
        // page.click() ではなく DOM 経由でクリックする。
        await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn').click());
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.annotator-svg')));

        await page.click('.annotator-tool-btn[data-tool="rect"]');
        await drawRectOnAnnotator(page, { x: 10, y: 10 }, { x: 40, y: 40 });
        await page.click('[data-action="save"]'); // 図形を描いてから保存(PNG化の確認)
        await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.annotator-svg'))));

        const expectedText =
          '# JPEG編集\n\n![photo](<images/写真 1.png>)\n\n<img src="images/写真 1.png" width="100">\n';
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getEditorText())) === expectedText,
          { message: '参照が images/写真 1.png に正しく書き換わりませんでした' }
        );

        const exists = await fs
          .stat(path.join(dir, 'images', '写真 1.png'))
          .then(() => true)
          .catch(() => false);
        assert.ok(exists, 'images/写真 1.png が作成されていません');

        printConsoleErrors(consoleErrors, '画像注釈エディタ(JPEG→PNG)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('プレビューの編集ボタンから開いたエディタでも、実際のクリップボード(Ctrl+V)で2枚目の画像を追加できる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'shot.png'), makeSolidPng(80, 80, [40, 60, 200]));
      await fs.writeFile(path.join(dir, 'doc.md'), '# 画像編集(クリップボード)\n\n![shot](images/shot.png)\n', 'utf8');

      // withPage は使わず、クリップボード権限を付与できる自前のコンテキストを使う
      // (合成 ClipboardEvent ではなく、実際の navigator.clipboard.write → 実際の
      // Ctrl+V による貼り付け経路を確認するため)。
      const browserContext = await browser.newContext();
      await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);
      await installFakeFs(browserContext, { rootDir: dir });
      const page = await browserContext.newPage();
      const consoleErrors = [];
      attachDebugLogging(page, consoleErrors);
      try {
        await page.goto(DIST_URL);
        await ensureHooks(page);
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(() => {
            const img = window.__mdpreview.getPreviewDocument().querySelector('img');
            return !!img && img.complete && img.naturalWidth > 0;
          })
        );

        await hoverPreviewImage(page);
        await waitFor(async () =>
          page.evaluate(() => {
            const btn = window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn');
            return !!btn && btn.style.display !== 'none';
          })
        );
        // 編集ボタンは iframe(プレビュー)の document 内にあるため、通常の
        // page.click() ではなく DOM 経由でクリックする。
        await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn').click());
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.annotator-svg')), {
          message: '注釈エディタが開きませんでした',
        });

        // 実際のクリップボードに画像を書き込む
        await page.evaluate(async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: 'image/png' });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        }, TEST_PNG_BASE64);

        // iframe 内のボタンから開いた場合でも、エディタにフォーカスが移っていて
        // 実際の Ctrl+V が届くことを確認する(合成イベントの dispatch ではない)。
        await page.keyboard.press('Control+v');

        await waitFor(
          async () =>
            page.evaluate(() => document.querySelectorAll('.annotator-image-layer > svg[data-image-id]').length === 2),
          { message: '実際のクリップボード(Ctrl+V)で2枚目の画像が追加されませんでした' }
        );

        await page.click('[data-action="save"]');
        await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.annotator-svg'))), {
          message: '保存後に注釈エディタが閉じませんでした',
        });

        const bytes = await fs.readFile(path.join(dir, 'images', 'shot.png'));
        const chunks = parseChunks(new Uint8Array(bytes));
        const mdimCount = chunks.filter((c) => c.type === 'mdIM').length;
        assert.equal(mdimCount, 2, `保存したPNGにmdIMチャンクが2つあるはずです: ${chunks.map((c) => c.type)}`);

        printConsoleErrors(consoleErrors, '実クリップボードでの画像追加');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await browserContext.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n22) HTML 出力');
  await test('通常出力: style.css が効き、画像が表示され、mermaid の svg があり、script 要素が無い', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'pic.png'), makeSolidPng(40, 40, [20, 120, 200]));
      await fs.writeFile(path.join(dir, 'style.css'), '.crossnote.markdown-preview { color: rgb(11, 22, 33); }\n', 'utf8');
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '# 出力テスト\n\n![pic](images/pic.png)\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n',
        'utf8'
      );

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('svg').length)) > 0,
          { message: 'mermaid が描画されませんでした' }
        );
        await waitFor(async () =>
          page.evaluate(() => {
            const img = window.__mdpreview.getPreviewDocument().querySelector('img');
            return !!img && img.complete && img.naturalWidth > 0;
          })
        );

        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
      });

      const context = await browser.newContext();
      const page2 = await context.newPage();
      const consoleErrors2 = [];
      attachDebugLogging(page2, consoleErrors2);
      try {
        await page2.goto('file://' + path.join(dir, 'doc.html'));

        const color = await page2.evaluate(
          () => getComputedStyle(document.querySelector('.crossnote.markdown-preview')).color
        );
        assert.equal(color, 'rgb(11, 22, 33)', 'style.css が反映されていません');

        await waitFor(
          async () =>
            page2.evaluate(() => {
              const img = document.querySelector('img');
              return !!img && img.complete && img.naturalWidth > 0;
            }),
          { message: '出力 HTML の画像が表示されませんでした' }
        );

        assert.ok((await page2.evaluate(() => document.querySelectorAll('svg').length)) > 0, 'mermaid の svg がありません');
        assert.equal(await page2.evaluate(() => document.querySelectorAll('script').length), 0, 'script 要素が含まれています');

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page2.screenshot({ path: path.join(SCREENSHOT_DIR, 'export-normal.png') });

        printConsoleErrors(consoleErrors2, 'HTML 出力(通常)を開く');
        assert.equal(consoleErrors2.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('1ファイル出力: 画像を data URI で埋め込み、別の空フォルダにコピーしても CSS・画像・mermaid が表示される', async () => {
    const dir = await mkTmpDir();
    const emptyDir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'pic.png'), makeSolidPng(40, 40, [10, 200, 60]));
      await fs.writeFile(
        path.join(dir, 'style.css'),
        '.crossnote.markdown-preview { background-color: rgb(240, 240, 210); }\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '# 1ファイル出力\n\n![pic](images/pic.png)\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n',
        'utf8'
      );

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('svg').length)) > 0
        );
        await waitFor(async () =>
          page.evaluate(() => {
            const img = window.__mdpreview.getPreviewDocument().querySelector('img');
            return !!img && img.complete && img.naturalWidth > 0;
          })
        );
        await page.evaluate(() => window.__mdpreview.exportStandalone());
        await waitFor(async () => existsSync(path.join(dir, 'doc.standalone.html')), {
          message: 'doc.standalone.html が出力されませんでした',
        });
      });

      const copiedPath = path.join(emptyDir, 'doc.standalone.html');
      await fs.copyFile(path.join(dir, 'doc.standalone.html'), copiedPath);

      const context = await browser.newContext();
      const page2 = await context.newPage();
      const consoleErrors2 = [];
      attachDebugLogging(page2, consoleErrors2);
      try {
        await page2.goto('file://' + copiedPath);

        const bg = await page2.evaluate(
          () => getComputedStyle(document.querySelector('.crossnote.markdown-preview')).backgroundColor
        );
        assert.equal(bg, 'rgb(240, 240, 210)', 'style.css が反映されていません');

        await waitFor(
          async () =>
            page2.evaluate(() => {
              const img = document.querySelector('img');
              return !!img && img.complete && img.naturalWidth > 0 && img.src.startsWith('data:');
            }),
          { message: '別フォルダにコピーした 1ファイル出力の画像が表示されませんでした' }
        );

        assert.ok((await page2.evaluate(() => document.querySelectorAll('svg').length)) > 0, 'mermaid の svg がありません');
        assert.equal(await page2.evaluate(() => document.querySelectorAll('script').length), 0, 'script 要素が含まれています');

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page2.screenshot({ path: path.join(SCREENSHOT_DIR, 'export-standalone.png') });

        printConsoleErrors(consoleErrors2, 'HTML 出力(1ファイル)を別フォルダで開く');
        assert.equal(consoleErrors2.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  console.log('\n23) 標準 CSS(社内資料向け)');
  await test('標準 CSS が効いている(h2 の枠線・表の display: table)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '# 見出し\n\n## 見出し2\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
        'utf8'
      );
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('table')));

        const styles = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          return {
            h2BorderLeftWidth: getComputedStyle(doc.querySelector('h2')).borderLeftWidth,
            tableDisplay: getComputedStyle(doc.querySelector('table')).display,
          };
        });
        assert.equal(styles.h2BorderLeftWidth, '6px', '標準 CSS の h2 の枠線が反映されていません');
        assert.equal(styles.tableDisplay, 'table', '標準 CSS の表の display が table になっていません');

        printConsoleErrors(consoleErrors, '標準 CSS');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('「標準 CSS を使う」をオフにすると外れる(アラートの枠・style.css は残る)。再読み込み後もオフのまま。HTML 出力にも含まれない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '# 見出し\n\n## 見出し2\n\n> [!NOTE]\n> 本文\n',
        'utf8'
      );
      await fs.writeFile(path.join(dir, 'style.css'), '.crossnote.markdown-preview { color: rgb(50, 60, 70); }\n', 'utf8');

      const context = await browser.newContext();
      await installFakeFs(context, { rootDir: dir });
      const page = await context.newPage();
      const consoleErrors = [];
      attachDebugLogging(page, consoleErrors);
      try {
        await page.goto(DIST_URL);
        await ensureHooks(page);
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('div.markdown-alert')));
        // オンの状態の前提を確認しておく。
        assert.equal(
          await page.evaluate(() => getComputedStyle(window.__mdpreview.getPreviewDocument().querySelector('h2')).borderLeftWidth),
          '6px',
          '前提: 標準 CSS がオンの時点で h2 の枠線が付いていません'
        );

        await page.click('#settingsBtn');
        await page.evaluate(() => {
          const input = document.getElementById('settingUseStandardCss');
          input.checked = false;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.click('#settingsCloseBtn');

        await waitFor(
          async () =>
            page.evaluate(() => document.getElementById('preview').contentDocument.getElementById('mdpreview-base-style').textContent === ''),
          { message: '標準 CSS をオフにしても #mdpreview-base-style が空になりませんでした' }
        );

        const after = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          return {
            h2BorderLeftWidth: getComputedStyle(doc.querySelector('h2')).borderLeftWidth,
            alertBorderWidth: getComputedStyle(doc.querySelector('div.markdown-alert')).borderTopWidth,
            bodyColor: getComputedStyle(doc.querySelector('.crossnote.markdown-preview')).color,
          };
        });
        assert.equal(after.h2BorderLeftWidth, '0px', '標準 CSS をオフにしても h2 の枠線が残っています');
        assert.equal(after.alertBorderWidth, '1px', 'アラートの枠線が消えてしまいました(常に適用されるはずです)');
        assert.equal(after.bodyColor, 'rgb(50, 60, 70)', 'style.css が効かなくなりました');

        // 再読み込み後もオフのまま。
        await page.reload();
        await ensureHooks(page);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).hasRoot);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'doc.md');
        assert.equal(
          (await page.evaluate(() => window.__mdpreview.getSettings())).useStandardCss,
          false,
          '再読み込み後にオンへ戻ってしまいました'
        );
        await waitFor(
          async () =>
            page.evaluate(() => document.getElementById('preview').contentDocument.getElementById('mdpreview-base-style').textContent === ''),
          { message: '再読み込み後に標準 CSS が空でなくなりました' }
        );

        // オフの状態の HTML 出力には標準 CSS の内容が含まれない。
        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
        const html = await fs.readFile(path.join(dir, 'doc.html'), 'utf8');
        assert.ok(!html.includes('--mdp-accent'), 'オフの状態の HTML 出力に標準 CSS の内容が含まれています');

        printConsoleErrors(consoleErrors, '標準 CSS オフ');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('「標準 CSS を書き出す」でワークスペースに standard.css ができる。既にある場合は上書き確認する(dismiss/accept)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('#settingsBtn');
        await page.click('#exportStandardCssBtn');
        await waitFor(async () => existsSync(path.join(dir, 'standard.css')), { message: 'standard.css が書き出されませんでした' });

        const content = await fs.readFile(path.join(dir, 'standard.css'), 'utf8');
        assert.ok(content.includes('--mdp-accent'), '書き出した standard.css の中身が標準 CSS ではないようです');
        assert.equal(
          await page.evaluate(() => window.__mdpreview.getStatusMessage()),
          '標準 CSS を書き出しました: standard.css'
        );

        // 既にある状態で押すと確認ダイアログが出る。dismiss なら上書きされない。
        await fs.writeFile(path.join(dir, 'standard.css'), '/* 手を加えた内容 */\n', 'utf8');
        page.once('dialog', (dialog) => dialog.dismiss());
        await page.click('#exportStandardCssBtn');
        await sleep(200);
        const afterDismiss = await fs.readFile(path.join(dir, 'standard.css'), 'utf8');
        assert.equal(afterDismiss, '/* 手を加えた内容 */\n', 'キャンセルしたのに standard.css が上書きされました');

        // accept なら上書きされる。
        page.once('dialog', (dialog) => dialog.accept());
        await page.click('#exportStandardCssBtn');
        await waitFor(
          async () => (await fs.readFile(path.join(dir, 'standard.css'), 'utf8')).includes('--mdp-accent'),
          { message: '上書きを承諾しても standard.css が更新されませんでした' }
        );

        printConsoleErrors(consoleErrors, '標準 CSS の書き出し');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('表の後に空行を挟んで {.full} を書くと table に class="full" が付き、幅いっぱいに広がる', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# 表',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '{.full}',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('table').length)) === 2
        );

        // 内容が短い表だと th/td の min-width の影響で「通常の表」自体もある程度
        // 広がるため、「通常より広い」という相対比較ではなく、{.full} の表が本文の
        // 内側幅(container の clientWidth から padding を引いたもの)と一致する
        // ことを直接確認する。
        const { normalHasFull, fullHasFull, normalWidth, fullWidth, containerContentWidth } = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const tables = doc.querySelectorAll('table');
          const container = doc.querySelector('.crossnote.markdown-preview');
          const cs = getComputedStyle(container);
          const containerContentWidth =
            container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          return {
            normalHasFull: tables[0].classList.contains('full'),
            fullHasFull: tables[1].classList.contains('full'),
            normalWidth: tables[0].getBoundingClientRect().width,
            fullWidth: tables[1].getBoundingClientRect().width,
            containerContentWidth,
          };
        });
        assert.equal(normalHasFull, false, '{.full} を付けていない表に full クラスが付いています');
        assert.equal(fullHasFull, true, '{.full} を付けた表に full クラスが付いていません');
        assert.ok(fullWidth > normalWidth, `{.full} で幅が広がっていません(normal=${normalWidth}, full=${fullWidth})`);
        assert.ok(
          Math.abs(fullWidth - containerContentWidth) < 2,
          `{.full} の表が本文幅いっぱいになっていません(full=${fullWidth}, container=${containerContentWidth})`
        );

        printConsoleErrors(consoleErrors, '表の {.full}');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

// ---------- エントリポイント ----------
async function main() {
  if (!existsSync(DIST_HTML)) {
    console.error(`dist/mdpreview.html が見つかりません: ${DIST_HTML}\n先に \`npm run build\` を実行してください。`);
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
