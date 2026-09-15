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
//  10. (セクション26)編集画面の不具合修正の確認: 「エディタのみ」表示でエディタが
//      #workArea 全幅になりプレビューが隠れる。サイドバー表示中でも境界のドラッグが
//      サイドバー幅分ずれない。境界をプレビュー側までドラッグでき、サイドバー開閉後も
//      比率が保たれる。エディタのスクロール・入力でプレビューがずれ続けない
//  11. (セクション27)ファイル操作一式(新規 md・新規フォルダ・名前の変更・削除)の確認:
//      「＋ md」で開いている md のフォルダに 0 バイトの md ができて開かれ、ツリーに出る。
//      フォルダ付きの入力(sub2/x)で途中のフォルダも作る。同名(大文字小文字違いを含む)・
//      禁止文字はモーダル内エラーで閉じず既存ファイルは変わらない。フォルダの右クリックから
//      その中に新規 md・新規フォルダを作れる。未保存のまま開いている md の名前を変えると
//      内容と未保存の印が残り、保存で新パスに書かれ競合モーダルが出ない(#file= も更新)。
//      move あり(既定)/ move なし(コピー方式にフォールバック、ステータスバーに明記)/
//      大文字小文字だけの変更、のいずれでも正しく行われる。開いている md を含むフォルダの
//      名前を変えると currentPath が付け替わり、md 以外(画像・ドット始まり)もバイト一致で
//      コピーされ元のフォルダは消える。削除は confirm の OK/キャンセルで反映され、
//      「完全に削除」の文言・フォルダの件数(md・その他のファイル・フォルダ)・未保存の警告が
//      確認文に出て、開いていた md を削除すると閉じる。F2/Delete キーでも同じ操作ができる。
//      ⟳ の再読込で外部変更が反映され、開いていたフォルダは開いたまま
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

// サイドバー目次のテスト用に、指定した段落数のダミー本文を作る(実際にスクロール
// できる分量を確保するため)。
function fillerParagraphs(n) {
  return Array.from({ length: n }, (_, i) => `本文の行 ${i + 1} です。`).join('\n\n');
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

// 設定パネルのチェックボックスを ON/OFF して change イベントを発火する
// (commit() が呼ばれ、即座に保存・反映される)。
async function setSettingCheckbox(page, id, checked) {
  await page.evaluate(
    ({ id, checked }) => {
      const input = document.getElementById(id);
      input.checked = checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { id, checked }
  );
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

// ---------- ファイル操作(新規作成・名前の変更・削除)のテスト用ヘルパー ----------
async function waitNameModalVisible(page) {
  await waitFor(async () => page.evaluate(() => document.getElementById('nameModal').style.display !== 'none'), {
    message: '名前入力モーダルが開きませんでした',
  });
}
async function getNameModalState(page) {
  return page.evaluate(() => ({
    visible: document.getElementById('nameModal').style.display !== 'none',
    value: document.getElementById('nameModalInput').value,
    errorVisible: document.getElementById('nameModalError').style.display !== 'none',
    errorText: document.getElementById('nameModalError').textContent,
  }));
}
// nameModal の入力欄の選択範囲(初期値の一部・全部)を消して置き換える。
async function replaceNameModalInput(page, text) {
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
}
async function rightClickTreeRow(page, selector) {
  await page.click(selector, { button: 'right' });
}
// ツリーの余白(= ルート)を右クリックする。行の無い領域(ツリーの下端付近)を狙う。
async function rightClickTreeBackground(page) {
  const box = await page.evaluate(() => {
    const el = document.getElementById('tree');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 6 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
}
async function waitContextMenuVisible(page) {
  await waitFor(async () => page.evaluate(() => !!document.querySelector('.context-menu')), {
    message: '右クリックメニューが開きませんでした',
  });
}
async function clickContextMenuItem(page, label) {
  await waitContextMenuVisible(page);
  const clicked = await page.evaluate((l) => {
    const items = Array.from(document.querySelectorAll('.context-menu-item'));
    const btn = items.find((b) => b.textContent.trim() === l);
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  assert.ok(clicked, `右クリックメニューに「${label}」が見つかりません`);
}
async function expandTreeDir(page, label) {
  await page.evaluate((l) => {
    const rows = Array.from(document.querySelectorAll('#tree .tree-dir-row'));
    const row = rows.find((r) => r.querySelector('.tree-label').textContent.trim() === l);
    row.click();
  }, label);
}
async function readDirNames(dir) {
  return fs.readdir(dir);
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

  await test('画像には既定で 1px の枠線が付き、{.no-border} を付けた画像には付かない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      await fs.writeFile(path.join(dir, 'images', 'a.png'), Buffer.from(TEST_PNG_BASE64, 'base64'));
      await fs.writeFile(
        path.join(dir, 'doc.md'),
        '# 見出し\n\n![既定](images/a.png)\n\n![枠なし](images/a.png){.no-border}\n\n<img src="images/a.png">\n',
        'utf8'
      );
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await waitFor(
          async () =>
            page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('img').length === 3),
          { message: '画像が 3 枚描画されませんでした' }
        );

        const borders = await page.evaluate(() =>
          Array.from(window.__mdpreview.getPreviewDocument().querySelectorAll('img')).map((img) => {
            const cs = getComputedStyle(img);
            return { width: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor };
          })
        );
        const framed = { width: '1px', style: 'solid', color: 'rgb(197, 206, 216)' };
        assert.deepEqual(borders[0], framed, 'markdown の画像に既定の枠線が付いていません: ' + JSON.stringify(borders[0]));
        assert.equal(borders[1].style, 'none', '{.no-border} の画像に枠線が付いています: ' + JSON.stringify(borders[1]));
        assert.deepEqual(borders[2], framed, 'HTML で書いた画像に既定の枠線が付いていません: ' + JSON.stringify(borders[2]));

        printConsoleErrors(consoleErrors, '画像の枠線');
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

  console.log('\n20b) 貼り付けの選択メニュー・保存中表示・表の整形');

  // 画像ファイル(1x1 PNG)とタブ区切りテキストの両方を持つ合成 ClipboardEvent を
  // .cm-content に dispatch する(実クリップボードは使わない共通ヘルパー)。
  async function pasteImageAndText(page, text) {
    await page.evaluate(
      ({ b64, text }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        dt.setData('text/plain', text);
        const target = document.querySelector('.cm-content');
        const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(evt);
      },
      { b64: TEST_PNG_BASE64, text }
    );
  }

  // 画像だけの合成 ClipboardEvent を .cm-content に dispatch する。
  async function pasteImageOnly(page) {
    await page.evaluate((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'clipboard.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('.cm-content');
      const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(evt);
    }, TEST_PNG_BASE64);
  }

  await test('画像とタブ区切りテキストを貼り付けると選択メニューが出て(項目3つ)、「3」で整形済みの表が挿入され画像は保存されない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 表貼り付け\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await pasteImageAndText(page, 'a\tb\nc\td\n');

        await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-paste-menu')), {
          message: '貼り付け方法の選択メニューが表示されませんでした',
        });
        const menu = await page.evaluate(() => ({
          heading: document.querySelector('.mdp-paste-menu-heading').textContent,
          items: Array.from(document.querySelectorAll('.mdp-paste-menu-item')).map((btn) => ({
            label: btn.querySelector('.mdp-paste-menu-label').textContent,
            key: btn.querySelector('.mdp-paste-menu-key').textContent,
          })),
          footer: document.querySelector('.mdp-paste-menu-footer').textContent,
        }));
        assert.equal(menu.heading, '貼り付け方法');
        assert.deepEqual(menu.items, [
          { label: '画像で貼り付け', key: 'Enter / 1' },
          { label: 'テキストで貼り付け', key: '2' },
          { label: '表(Markdown)で貼り付け', key: '3' },
        ]);
        assert.equal(menu.footer, 'Esc で取り消し');

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'app-paste-menu.png') });

        await page.keyboard.press('3');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('| a   | b   |'), {
          message: '表が挿入されませんでした',
        });
        const text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.equal(
          text,
          '# 表貼り付け\n\n本文\n\n| a   | b   |\n| --- | --- |\n| c   | d   |\n',
          '整形済みの表の挿入結果が想定と異なります: ' + JSON.stringify(text)
        );
        assert.ok(!(await fs.readdir(dir)).includes('images'), '画像フォルダが作られています(表を選んだのに画像が保存されています)');

        printConsoleErrors(consoleErrors, '貼り付けメニュー(表)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('選択メニューで「2」はタブ区切りのテキストのまま、Esc は本文が変わらず、Enter(既定)は画像を保存して参照を挿入する', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 表貼り付け\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        // 「2」: タブ区切りのテキストがそのまま貼られ、画像は保存されない
        await pasteImageAndText(page, 'a\tb\nc\td\n');
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-paste-menu')), {
          message: '貼り付け方法の選択メニューが表示されませんでした(2)',
        });
        await page.keyboard.press('2');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('a\tb\nc\td\n'), {
          message: 'タブ区切りのテキストが貼り付けられませんでした',
        });
        let text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.equal(text, '# 表貼り付け\n\n本文\na\tb\nc\td\n', 'テキストの貼り付け結果が想定と異なります: ' + JSON.stringify(text));
        assert.ok(!(await fs.readdir(dir)).includes('images'), '「テキストで貼り付け」で画像フォルダが作られています');

        // Esc: 本文が変わらず画像も保存されない
        await page.keyboard.press('Control+End');
        await pasteImageAndText(page, 'a\tb\nc\td\n');
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-paste-menu')), {
          message: '貼り付け方法の選択メニューが表示されませんでした(Esc)',
        });
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.mdp-paste-menu'))), {
          message: 'Esc でメニューが閉じませんでした',
        });
        text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.equal(text, '# 表貼り付け\n\n本文\na\tb\nc\td\n', 'Esc で本文が変わっています: ' + JSON.stringify(text));
        assert.ok(!(await fs.readdir(dir)).includes('images'), 'Esc で画像フォルダが作られています');

        // Enter(既定 = 画像で貼り付け): 画像が保存され参照が挿入される
        await pasteImageAndText(page, 'a\tb\nc\td\n');
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-paste-menu')), {
          message: '貼り付け方法の選択メニューが表示されませんでした(Enter)',
        });
        await page.keyboard.press('Enter');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('](images/'), {
          message: 'Enter で画像の参照が挿入されませんでした',
        });
        text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.match(text, /!\[\]\(images\/doc\/image-1\.png\)/, '画像参照の形式が想定と異なります: ' + text);
        const files = await fs.readdir(path.join(dir, 'images', 'doc'));
        assert.deepEqual(files, ['image-1.png'], '画像が保存されていません: ' + JSON.stringify(files));

        printConsoleErrors(consoleErrors, '貼り付けメニュー(テキスト/Esc/画像)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('画像だけの貼り付け(保存を遅くする)ではメニューが出ず、保存中は表示とステータスが出て、完了後に消えて参照が入る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 保存中\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await page.evaluate(() => window.__fakeFs.setDelay({ write: 600 }));
        await pasteImageOnly(page);

        assert.equal(
          await page.evaluate(() => !!document.querySelector('.mdp-paste-menu')),
          false,
          '画像だけの貼り付けで選択メニューが表示されています'
        );
        assert.equal(
          await page.evaluate(() => !!document.querySelector('.mdp-saving-placeholder')),
          true,
          '貼り付け直後に保存中のプレースホルダーが表示されていません'
        );
        assert.equal(
          await page.evaluate(() => window.__mdpreview.getStatusMessage()),
          '画像を保存中…',
          '貼り付け直後のステータスが「画像を保存中…」になっていません'
        );

        await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.mdp-saving-placeholder'))), {
          message: '保存完了後もプレースホルダーが残っています',
        });
        assert.equal(
          await page.evaluate(() => window.__mdpreview.getStatusMessage()),
          '画像を保存しました',
          '保存完了後のステータスが「画像を保存しました」になっていません'
        );
        const text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.match(text, /!\[\]\(images\/doc\/image-1\.png\)/, '画像参照が挿入されていません: ' + text);

        await page.evaluate(() => window.__fakeFs.setDelay({ write: 0 }));
        printConsoleErrors(consoleErrors, '保存中の表示');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('画像の保存中にもう一度画像を貼り付けると受け付けず、完了後は最初の画像だけが保存される(二重貼り付け防止)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 二重貼り付け\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await page.evaluate(() => window.__fakeFs.setDelay({ write: 600 }));

        await pasteImageOnly(page);
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-saving-placeholder')), {
          message: '1回目の保存中プレースホルダーが表示されませんでした',
        });

        await pasteImageOnly(page);
        const busyMsg = await page.evaluate(() => window.__mdpreview.getStatusMessage());
        assert.equal(
          busyMsg,
          '前の画像を保存中です。保存が終わってから貼り付けてください',
          '2回目の貼り付け直後のステータスが想定と異なります: ' + busyMsg
        );

        await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.mdp-saving-placeholder'))), {
          message: '保存が完了しませんでした',
        });
        await page.evaluate(() => window.__fakeFs.setDelay({ write: 0 }));

        const files = await fs.readdir(path.join(dir, 'images', 'doc'));
        assert.deepEqual(files, ['image-1.png'], '画像が1件だけ保存されていません: ' + JSON.stringify(files));
        const text = await page.evaluate(() => window.__mdpreview.getEditorText());
        const refCount = (text.match(/!\[\]\(images\/doc\/image-1\.png\)/g) || []).length;
        assert.equal(refCount, 1, '画像参照が1件だけ挿入されていません: ' + text);

        printConsoleErrors(consoleErrors, '画像の二重貼り付け防止');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('画像の保存中に別の md を開くと、保存完了後も参照は挿入されず、ファイルを切り替えた旨のメッセージが出る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');
      await fs.writeFile(path.join(dir, 'b.md'), '# b\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'a.md');
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await page.evaluate(() => window.__fakeFs.setDelay({ write: 600 }));
        await pasteImageOnly(page);
        await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-saving-placeholder')), {
          message: '保存中のプレースホルダーが表示されませんでした',
        });

        await page.evaluate(() => window.__mdpreview.openFile('b.md'));
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'b.md', {
          message: 'b.md を開けませんでした',
        });

        await waitFor(
          async () =>
            (await page.evaluate(() => window.__mdpreview.getStatusMessage())) ===
            '画像は保存しましたが、ファイルを切り替えたため参照は挿入していません: images/a/image-1.png',
          { message: 'ファイル切り替え時のメッセージが表示されませんでした' }
        );

        const text = await page.evaluate(() => window.__mdpreview.getEditorText());
        assert.equal(text, '# b\n', 'b.md の本文に画像参照が挿入されています: ' + JSON.stringify(text));
        const files = await fs.readdir(path.join(dir, 'images', 'a'));
        assert.deepEqual(files, ['image-1.png'], '画像が保存されていません: ' + JSON.stringify(files));

        await page.evaluate(() => window.__fakeFs.setDelay({ write: 0 }));
        printConsoleErrors(consoleErrors, '保存中のファイル切り替え');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('「表を整形」ボタンと Alt+Shift+F で列がずれた表を整形できる。整形不要なら案内が出る', async () => {
    const dir = await mkTmpDir();
    const initial = '# 表\n\n内容\n\n|項目|値|説明|\n|:--|--:|:-:|\n|名前|山田太郎|フルネーム|\n|年齢|28|満年齢|\n';
    const formatted =
      '# 表\n\n内容\n\n| 項目 |       値 |    説明    |\n| :--- | -------: | :--------: |\n| 名前 | 山田太郎 | フルネーム |\n| 年齢 |       28 |   満年齢   |\n';
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), initial, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('#formatTablesBtn');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())) === formatted, {
          message: '表が整形されませんでした',
        });
        assert.equal(await page.evaluate(() => window.__mdpreview.getStatusMessage()), '表を1個整形しました');
        assert.equal((await page.evaluate(() => window.__mdpreview.getState())).dirty, true, '未保存の印が付いていません');

        await page.click('#formatTablesBtn');
        assert.equal(await page.evaluate(() => window.__mdpreview.getStatusMessage()), '整形が必要な表はありません');

        // Alt+Shift+F でも整形される(検証のため、いったん未整形の内容に戻す)。
        await page.evaluate((t) => window.__mdpreview.setEditorText(t), initial);
        await page.click('.cm-content');
        await page.keyboard.press('Alt+Shift+F');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())) === formatted, {
          message: 'Alt+Shift+F で整形されませんでした',
        });
        assert.equal(await page.evaluate(() => window.__mdpreview.getStatusMessage()), '表を1個整形しました');

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'app-format-tables.png') });

        printConsoleErrors(consoleErrors, '表の整形');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('Ctrl+Shift+V は実際のクリップボードに画像とテキストの両方があっても選択メニューを出さずテキストだけを貼り付ける', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# Ctrl+Shift+V\n', 'utf8');
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
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');

        await page.evaluate(async (b64) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const imageBlob = new Blob([bytes], { type: 'image/png' });
          const textBlob = new Blob(['セルの文字列'], { type: 'text/plain' });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageBlob, 'text/plain': textBlob })]);
        }, TEST_PNG_BASE64);

        await page.keyboard.press('Control+Shift+V');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())).includes('セルの文字列'), {
          message: 'Ctrl+Shift+V でテキストが貼り付けられませんでした',
        });
        assert.equal(
          await page.evaluate(() => !!document.querySelector('.mdp-paste-menu')),
          false,
          'Ctrl+Shift+V で選択メニューが表示されています'
        );
        assert.ok(!(await fs.readdir(dir)).includes('images'), '画像フォルダが作られています(画像が保存されています)');

        printConsoleErrors(consoleErrors, 'Ctrl+Shift+V');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await browserContext.close();
      }
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

  console.log('\n22b) HTML 出力: サイドバーの目次');
  await test('通常出力: サイドバーの目次が h2〜h6(ignore を除く)の文書順・見出し番号と一致し、script 要素が無い', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# タイトル',
        '',
        fillerParagraphs(5),
        '',
        '## 概要',
        '',
        fillerParagraphs(40),
        '',
        '### 詳細',
        '',
        fillerParagraphs(40),
        '',
        '#### 深掘り',
        '',
        fillerParagraphs(40),
        '',
        '### 除外見出し {ignore=true}',
        '',
        fillerParagraphs(10),
        '',
        '##### 五段目',
        '',
        fillerParagraphs(40),
        '',
        '###### 六段目',
        '',
        fillerParagraphs(40),
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await page.click('#settingsCloseBtn');
        await waitFor(
          async () =>
            !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number')))
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

        const data = await page2.evaluate(() => {
          const headings = Array.from(
            document.querySelectorAll(
              '.crossnote.markdown-preview h2, .crossnote.markdown-preview h3, .crossnote.markdown-preview h4, ' +
                '.crossnote.markdown-preview h5, .crossnote.markdown-preview h6'
            )
          );
          const tocLinks = Array.from(document.querySelectorAll('.mdp-sidetoc a'));
          const numberOf = (el) => {
            const span = el.querySelector('.mdp-heading-number');
            return span ? span.textContent : null;
          };
          return {
            headingIds: headings.map((h) => h.id),
            headingTexts: headings.map((h) => h.textContent.trim()),
            tocHrefs: tocLinks.map((a) => a.getAttribute('href')),
            tocNumbers: tocLinks.map(numberOf),
            navAriaLabel: document.querySelector('.mdp-sidetoc') && document.querySelector('.mdp-sidetoc').getAttribute('aria-label'),
            titleText: document.querySelector('.mdp-sidetoc-title') && document.querySelector('.mdp-sidetoc-title').textContent,
            scriptCount: document.querySelectorAll('script').length,
          };
        });

        // 見出しの連番をオンにしているため textContent には番号("1-2." 等)が
        // 前置される。末尾一致で判定する。
        const expectedIds = data.headingIds.filter((_, i) => !data.headingTexts[i].endsWith('除外見出し'));
        assert.deepEqual(data.tocHrefs, expectedIds.map((id) => '#' + id), '目次のリンクが見出しの id・文書順と一致しません');
        assert.deepEqual(
          data.tocNumbers,
          ['1.', '1-1.', '1-1-1.', '1-2-1-1.', '1-2-1-1-1.'],
          `目次の連番が見出しの連番と一致しません: ${JSON.stringify(data.tocNumbers)}`
        );
        assert.equal(data.navAriaLabel, '目次', 'nav の aria-label が想定と違います');
        assert.equal(data.titleText, '目次', '目次の見出し文字が想定と違います');
        assert.equal(data.scriptCount, 0, 'script 要素が含まれています');

        printConsoleErrors(consoleErrors2, 'HTML 出力(通常)のサイドバー目次');
        assert.equal(consoleErrors2.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('幅 1400px でスクロールすると、画面上端付近の見出しの目次リンクが a:target-current になる(h3 以下・h2 とも)', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# タイトル',
        '',
        fillerParagraphs(5),
        '',
        '## 概要',
        '',
        fillerParagraphs(40),
        '',
        '### 詳細',
        '',
        fillerParagraphs(60),
        '',
        '## まとめ',
        '',
        fillerParagraphs(40),
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
      });

      const context = await browser.newContext();
      const page2 = await context.newPage();
      const consoleErrors2 = [];
      attachDebugLogging(page2, consoleErrors2);
      try {
        await page2.setViewportSize({ width: 1400, height: 800 });
        await page2.goto('file://' + path.join(dir, 'doc.html'));

        const detailId = await page2.evaluate(() => {
          const h3 = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.trim() === '詳細');
          return h3 ? h3.id : null;
        });
        assert.ok(detailId, '「詳細」(h3)の見出しが見つかりませんでした');
        await page2.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), detailId);
        await waitFor(
          async () =>
            (await page2.evaluate(() => {
              const a = document.querySelector('.mdp-sidetoc a:target-current');
              return a ? a.getAttribute('href') : null;
            })) === '#' + detailId,
          { message: '深い見出し(h3)へスクロールしても目次が強調されませんでした' }
        );

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page2.screenshot({ path: path.join(SCREENSHOT_DIR, 'export-sidetoc.png') });

        const overviewId = await page2.evaluate(() => {
          const h2 = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent.trim() === '概要');
          return h2 ? h2.id : null;
        });
        assert.ok(overviewId, '「概要」(h2)の見出しが見つかりませんでした');
        await page2.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), overviewId);
        await waitFor(
          async () =>
            (await page2.evaluate(() => {
              const a = document.querySelector('.mdp-sidetoc a:target-current');
              return a ? a.getAttribute('href') : null;
            })) === '#' + overviewId,
          { message: 'h2 の見出しへスクロールしても目次が強調されませんでした' }
        );

        printConsoleErrors(consoleErrors2, 'サイドバー目次のスクロール強調');
        assert.equal(consoleErrors2.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('幅 800px では .mdp-sidetoc の computed display が none になる', async () => {
    const dir = await mkTmpDir();
    try {
      const content = ['# タイトル', '', '## 概要', '', '本文です。', ''].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
      });

      const context = await browser.newContext();
      const page2 = await context.newPage();
      try {
        await page2.setViewportSize({ width: 800, height: 800 });
        await page2.goto('file://' + path.join(dir, 'doc.html'));
        const display = await page2.evaluate(() => getComputedStyle(document.querySelector('.mdp-sidetoc')).display);
        assert.equal(display, 'none', '幅 800px で目次が非表示になっていません');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('1ファイル出力にも目次が付く', async () => {
    const dir = await mkTmpDir();
    try {
      const content = ['# タイトル', '', '## 概要', '', '本文です。', ''].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__mdpreview.exportStandalone());
        await waitFor(async () => existsSync(path.join(dir, 'doc.standalone.html')), {
          message: 'doc.standalone.html が出力されませんでした',
        });
      });

      const context = await browser.newContext();
      const page2 = await context.newPage();
      try {
        await page2.goto('file://' + path.join(dir, 'doc.standalone.html'));
        const hrefs = await page2.evaluate(() =>
          Array.from(document.querySelectorAll('.mdp-sidetoc a')).map((a) => a.getAttribute('href'))
        );
        assert.equal(hrefs.length, 1, '1ファイル出力の目次の項目数が想定と違います');
        assert.equal(hrefs[0], '#概要', '1ファイル出力の目次の href が想定と違います');
      } finally {
        await context.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('設定でオフにすると出力に目次が付かない(.mdp-sidetoc も .mdp-layout も無い)', async () => {
    const dir = await mkTmpDir();
    try {
      const content = ['# タイトル', '', '## 概要', '', '本文です。', ''].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingSideToc', false);
        await page.click('#settingsCloseBtn');
        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
      });

      const html = await fs.readFile(path.join(dir, 'doc.html'), 'utf8');
      assert.equal(html.includes('mdp-sidetoc'), false, 'sideToc をオフにしたのに mdp-sidetoc が出力に含まれています');
      assert.equal(html.includes('mdp-layout'), false, 'sideToc をオフにしたのに mdp-layout が出力に含まれています');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('h2〜h6 が無い文書には目次(レイアウト用の要素も)付かない', async () => {
    const dir = await mkTmpDir();
    try {
      const content = '# タイトルだけ\n\n本文です。\n';
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
      });

      const html = await fs.readFile(path.join(dir, 'doc.html'), 'utf8');
      assert.equal(html.includes('mdp-sidetoc'), false, '見出しが無いのに mdp-sidetoc が出力に含まれています');
      assert.equal(html.includes('mdp-layout'), false, '見出しが無いのに mdp-layout が出力に含まれています');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
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
          const root = doc.getElementById('mdpreview-root');
          return {
            h2BorderLeftWidth: getComputedStyle(doc.querySelector('h2')).borderLeftWidth,
            tableDisplay: getComputedStyle(doc.querySelector('table')).display,
            htmlBackgroundColor: getComputedStyle(doc.documentElement).backgroundColor,
            rootBackgroundColor: getComputedStyle(root).backgroundColor,
            rootMaxWidth: getComputedStyle(root).maxWidth,
          };
        });
        assert.equal(styles.h2BorderLeftWidth, '6px', '標準 CSS の h2 の枠線が反映されていません');
        assert.equal(styles.tableDisplay, 'table', '標準 CSS の表の display が table になっていません');
        assert.equal(styles.htmlBackgroundColor, 'rgb(238, 240, 243)', 'ページの背景(薄いグレー)が反映されていません');
        assert.equal(styles.rootBackgroundColor, 'rgb(255, 255, 255)', '表示エリアの背景(白)が反映されていません');
        assert.equal(styles.rootMaxWidth, '1200px', '表示エリアの max-width が反映されていません');

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
            htmlBackgroundColor: getComputedStyle(doc.documentElement).backgroundColor,
          };
        });
        assert.equal(after.h2BorderLeftWidth, '0px', '標準 CSS をオフにしても h2 の枠線が残っています');
        assert.equal(after.alertBorderWidth, '1px', 'アラートの枠線が消えてしまいました(常に適用されるはずです)');
        assert.equal(after.bodyColor, 'rgb(50, 60, 70)', 'style.css が効かなくなりました');
        assert.equal(after.htmlBackgroundColor, 'rgba(0, 0, 0, 0)', '標準 CSS をオフにしてもページの背景(薄いグレー)が残っています');

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

  console.log('\n24) 見出しの連番と字下げ');
  await test('既定(オフ)では番号の span も data-mdp-indent も付かない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# タイトル\n\n## 概要\n\n本文\n\n### 詳細\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('h2'))));

        const { hasNumberSpan, hasIndentAttr } = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          return {
            hasNumberSpan: !!doc.querySelector('.mdp-heading-number'),
            hasIndentAttr: !!doc.querySelector('[data-mdp-indent]'),
          };
        });
        assert.equal(hasNumberSpan, false, '既定オフなのに番号の span が付いています');
        assert.equal(hasIndentAttr, false, '既定オフなのに data-mdp-indent が付いています');

        printConsoleErrors(consoleErrors, '見出しの連番と字下げ(既定オフ)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('連番をオンにすると h2/h3/h4 に 1. / 1-1. / 1-1-1. が付き、見出しの id は変わらない。nonum の見出しとその配下には付かず、番号は消費されない', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# ドキュメント',
        '',
        '## 概要',
        '',
        '### 詳細',
        '',
        '#### 深堀り',
        '',
        '## 改訂履歴 {.nonum}',
        '',
        '### 却下案',
        '',
        '## まとめ',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(
          async () =>
            (await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('h2, h3, h4').length)) === 6
        );

        const idsBefore = await page.evaluate(() =>
          Array.from(window.__mdpreview.getPreviewDocument().querySelectorAll('h2, h3, h4')).map((el) => el.id)
        );

        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number'))));

        const { idsAfter, numbers } = await page.evaluate(() => {
          const headings = Array.from(window.__mdpreview.getPreviewDocument().querySelectorAll('h2, h3, h4'));
          return {
            idsAfter: headings.map((el) => el.id),
            numbers: headings.map((el) => {
              const span = el.querySelector('.mdp-heading-number');
              return span ? span.textContent : null;
            }),
          };
        });

        assert.deepEqual(idsAfter, idsBefore, '連番をオンにすると見出しの id が変わってしまいました');
        assert.deepEqual(
          numbers,
          ['1.', '1-1.', '1-1-1.', null, null, '2.'],
          `番号の付き方が期待と違います: ${JSON.stringify(numbers)}`
        );

        printConsoleErrors(consoleErrors, '見出しの連番(基本形・nonum)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('深さを h2〜h3 にすると h4 には付かない', async () => {
    const dir = await mkTmpDir();
    try {
      const content = ['# ドキュメント', '', '## 概要', '', '### 詳細', '', '#### 深堀り', ''].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await page.selectOption('#settingHeadingNumberDepth', '3');
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number'))));

        const numbers = await page.evaluate(() =>
          Array.from(window.__mdpreview.getPreviewDocument().querySelectorAll('h2, h3, h4')).map((el) => {
            const span = el.querySelector('.mdp-heading-number');
            return span ? span.textContent : null;
          })
        );
        assert.deepEqual(numbers, ['1.', '1-1.', null], `深さ h2〜h3 の指定が反映されていません: ${JSON.stringify(numbers)}`);

        printConsoleErrors(consoleErrors, '見出しの連番(深さの制限)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('[TOC] と MPE 方式の目次の項目にも同じ番号が付く。本文の段落中のリンクには付かない', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# ドキュメント',
        '',
        '[TOC]',
        '',
        '<!-- @import "[TOC]" {orderedList=true} -->',
        '',
        '## 概要',
        '',
        '本文です。[概要へ](#概要) を参照してください。',
        '',
        '### 詳細',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('h2 .mdp-heading-number'))));

        // 保存でソース書き込み型 TOC(<!-- @import "[TOC]" --> の直後のブロック)を
        // 生成させ、再読込で通常の markdown リストとして描画された状態を確認する。
        await page.evaluate(() => window.__mdpreview.save());
        await waitFor(async () => !(await page.evaluate(() => window.__mdpreview.getState())).dirty);
        await page.evaluate(() => window.__mdpreview.reloadCurrentFile());
        await waitFor(
          async () =>
            (await page.evaluate(
              () => window.__mdpreview.getPreviewDocument().querySelectorAll('li a[href^="#"] .mdp-heading-number').length
            )) >= 4
        );

        const result = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const tocEntries = Array.from(doc.querySelectorAll('li'))
            .map((li) => li.firstElementChild)
            .filter((a) => a && a.tagName === 'A' && /^#/.test(a.getAttribute('href') || ''))
            .map((a) => a.textContent.trim());
          const bodyLink = Array.from(doc.querySelectorAll('p a')).find((a) => a.textContent.trim() === '概要へ');
          return {
            tocEntries,
            bodyLinkText: bodyLink ? bodyLink.textContent.trim() : null,
            bodyLinkHasSpan: bodyLink ? !!bodyLink.querySelector('.mdp-heading-number') : null,
          };
        });

        // [TOC] と MPE 方式の両方に、概要(1.)・詳細(1-1.)の項目がそれぞれ現れる。
        assert.equal(
          result.tocEntries.filter((t) => t === '1.概要').length,
          2,
          `目次の「概要」に番号が付いていません: ${JSON.stringify(result.tocEntries)}`
        );
        assert.equal(
          result.tocEntries.filter((t) => t === '1-1.詳細').length,
          2,
          `目次の「詳細」に番号が付いていません: ${JSON.stringify(result.tocEntries)}`
        );
        assert.equal(result.bodyLinkText, '概要へ', '本文中の [概要へ](#概要) リンクが見つかりません');
        assert.equal(result.bodyLinkHasSpan, false, '本文の段落中のリンクに番号が付いてしまいました');

        printConsoleErrors(consoleErrors, '目次への連番の反映');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('字下げをオンにすると見出し・本文が階層ごとに下がる({.full} の表は本文幅からはみ出さない)', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# ドキュメント',
        '',
        '## 階層',
        '',
        '段落その1',
        '',
        '### 小節',
        '',
        '段落その2',
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
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingIndent', true);
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('table[data-mdp-indent]'))));

        const result = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const container = doc.querySelector('.crossnote.markdown-preview');
          const cs = getComputedStyle(container);
          const containerContentRight = container.getBoundingClientRect().right - parseFloat(cs.paddingRight);
          const ratio = (el) => {
            const s = getComputedStyle(el);
            return parseFloat(s.marginLeft) / parseFloat(s.fontSize);
          };
          const h2 = doc.querySelector('h2');
          const h3 = doc.querySelector('h3');
          const paragraphs = Array.from(doc.querySelectorAll('p'));
          const table = doc.querySelector('table');
          return {
            h2Ratio: ratio(h2),
            p1Ratio: ratio(paragraphs[0]),
            h3Ratio: ratio(h3),
            p2Ratio: ratio(paragraphs[1]),
            tableIndentAttr: table.getAttribute('data-mdp-indent'),
            tableRight: table.getBoundingClientRect().right,
            containerContentRight,
          };
        });

        assert.ok(Math.abs(result.h2Ratio - 0) < 0.02, `h2 の margin-left が 0 ではありません(ratio=${result.h2Ratio})`);
        assert.ok(Math.abs(result.p1Ratio - 1.5) < 0.02, `h2 直後の段落が 1 段になっていません(ratio=${result.p1Ratio})`);
        assert.ok(Math.abs(result.h3Ratio - 1.5) < 0.02, `h3 が 1 段になっていません(ratio=${result.h3Ratio})`);
        assert.ok(Math.abs(result.p2Ratio - 3.0) < 0.02, `h3 の本文が 2 段になっていません(ratio=${result.p2Ratio})`);
        assert.equal(result.tableIndentAttr, '2', `表の data-mdp-indent が期待通りではありません(${result.tableIndentAttr})`);
        assert.ok(
          result.tableRight <= result.containerContentRight + 1,
          `{.full} の表が本文幅からはみ出しています(table right=${result.tableRight}, container content right=${result.containerContentRight})`
        );

        printConsoleErrors(consoleErrors, '見出しの字下げ');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('「標準 CSS を使う」をオフにしても連番・字下げは効く', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# ドキュメント\n\n## 概要\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingUseStandardCss', false);
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await setSettingCheckbox(page, 'settingHeadingIndent', true);
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number'))));

        const { numberText, indentMarginLeft } = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const span = doc.querySelector('h2 .mdp-heading-number');
          const p = doc.querySelector('p[data-mdp-indent]');
          return {
            numberText: span ? span.textContent : null,
            indentMarginLeft: p ? parseFloat(getComputedStyle(p).marginLeft) : 0,
          };
        });
        assert.equal(numberText, '1.', '標準 CSS オフでも見出しの連番が付くはずです');
        assert.ok(indentMarginLeft > 0, `標準 CSS オフでも字下げが効くはずです(margin-left=${indentMarginLeft})`);

        printConsoleErrors(consoleErrors, '標準 CSS オフでも連番・字下げ');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('HTML 出力に見出しの連番・data-mdp-indent・outline.css の内容が含まれる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# ドキュメント\n\n## 概要\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await setSettingCheckbox(page, 'settingHeadingIndent', true);
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number'))));

        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
        const html = await fs.readFile(path.join(dir, 'doc.html'), 'utf8');
        assert.ok(html.includes('mdp-heading-number'), 'HTML 出力に見出しの連番の span が含まれていません');
        assert.ok(/data-mdp-indent="1"/.test(html), 'HTML 出力に data-mdp-indent が含まれていません');
        assert.ok(html.includes('--mdp-indent-step'), 'HTML 出力に outline.css の内容が含まれていません');

        printConsoleErrors(consoleErrors, 'HTML 出力への反映');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('設定(連番・深さ・字下げ)は再読み込み後も保持する', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# ドキュメント\n\n## 概要\n\n### 詳細\n\n#### 深堀り\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingHeadingNumbers', true);
        await page.selectOption('#settingHeadingNumberDepth', '3');
        await setSettingCheckbox(page, 'settingHeadingIndent', true);
        await page.click('#settingsCloseBtn');
        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number'))));

        await page.reload();
        await ensureHooks(page);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).hasRoot);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'doc.md');

        const settings = await page.evaluate(() => window.__mdpreview.getSettings());
        assert.equal(settings.headingNumbers, true, '再読み込み後に見出しの連番がオフに戻ってしまいました');
        assert.equal(settings.headingNumberDepth, 3, '再読み込み後に深さの設定が保持されていません');
        assert.equal(settings.headingIndent, true, '再読み込み後に字下げがオフに戻ってしまいました');

        await waitFor(async () => !!(await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdp-heading-number'))));
        const { hasH4Number, hasIndentAttr } = await page.evaluate(() => {
          const doc = window.__mdpreview.getPreviewDocument();
          const h4 = doc.querySelector('h4');
          return {
            hasH4Number: h4 ? !!h4.querySelector('.mdp-heading-number') : null,
            hasIndentAttr: !!doc.querySelector('[data-mdp-indent]'),
          };
        });
        assert.equal(hasH4Number, false, '再読み込み後、深さ設定(h2〜h3)が反映されず h4 にも番号が付いています');
        assert.equal(hasIndentAttr, true, '再読み込み後、字下げが反映されていません');

        printConsoleErrors(consoleErrors, '設定の永続化(見出しの連番・字下げ)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n25) 蛍光ペン・マーカー付きテキスト枠(常に適用)');
  const MARKBOX_DOC = [
    '# 蛍光ペン',
    '',
    '段落の ==黄色== と ==赤枠=={.mark-text} です。',
    '',
    '```mark',
    '枠内 ==強調== です。',
    '```',
    '',
  ].join('\n');

  // 標準 CSS のオン/オフどちらでも同じであるべき計算済みスタイルをまとめて取得する。
  async function readMarkboxStyles(page) {
    return page.evaluate(() => {
      const doc = window.__mdpreview.getPreviewDocument();
      const plainMark = doc.querySelector('mark:not(.mark-text)');
      const markText = doc.querySelector('mark.mark-text');
      const preBox = doc.querySelector('pre.mark-box');
      const spanMark = preBox ? preBox.querySelector('span.mark-text') : null;
      const pick = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          tagName: el.tagName,
          backgroundColor: cs.backgroundColor,
          borderTopWidth: cs.borderTopWidth,
          borderTopStyle: cs.borderTopStyle,
          borderTopColor: cs.borderTopColor,
        };
      };
      return {
        plainMark: pick(plainMark),
        markText: pick(markText),
        preBox: pick(preBox),
        spanMark: pick(spanMark),
        preHasCode: !!(preBox && preBox.querySelector('code')),
      };
    });
  }

  function assertMarkboxStyles(styles, label) {
    assert.ok(styles.plainMark, `${label}: 素の <mark> が見つかりません`);
    assert.equal(styles.plainMark.backgroundColor, 'rgb(255, 245, 157)', `${label}: <mark> の背景色が想定と異なります`);

    assert.ok(styles.markText, `${label}: <mark class="mark-text"> が見つかりません`);
    assert.equal(styles.markText.tagName, 'MARK');
    assert.equal(styles.markText.backgroundColor, 'rgb(255, 245, 157)', `${label}: mark.mark-text の背景色が想定と異なります`);
    assert.equal(styles.markText.borderTopWidth, '2px', `${label}: mark.mark-text の枠線の太さが想定と異なります`);
    assert.equal(styles.markText.borderTopStyle, 'solid', `${label}: mark.mark-text の枠線が実線ではありません`);
    assert.equal(styles.markText.borderTopColor, 'rgb(229, 57, 53)', `${label}: mark.mark-text の枠線色が想定と異なります`);

    assert.ok(styles.preBox, `${label}: pre.mark-box が見つかりません`);
    assert.equal(styles.preBox.backgroundColor, 'rgb(245, 245, 245)', `${label}: pre.mark-box の背景色が想定と異なります`);
    assert.equal(styles.preBox.borderTopWidth, '1px', `${label}: pre.mark-box の枠線の太さが想定と異なります`);
    assert.equal(styles.preBox.borderTopColor, 'rgb(224, 224, 224)', `${label}: pre.mark-box の枠線色が想定と異なります`);
    assert.equal(styles.preHasCode, false, `${label}: pre.mark-box の中に <code> があります`);

    assert.ok(styles.spanMark, `${label}: pre.mark-box の中の span.mark-text が見つかりません`);
    assert.equal(styles.spanMark.tagName, 'SPAN');
    assert.equal(styles.spanMark.backgroundColor, 'rgb(255, 245, 157)', `${label}: span.mark-text の背景色が想定と異なります`);
    assert.equal(styles.spanMark.borderTopWidth, '2px', `${label}: span.mark-text の枠線の太さが想定と異なります`);
    assert.equal(styles.spanMark.borderTopColor, 'rgb(229, 57, 53)', `${label}: span.mark-text の枠線色が想定と異なります`);
  }

  await test('標準 CSS がオンのとき、mark・.mark-text(span/mark)・pre.mark-box が指定の見た目になる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), MARKBOX_DOC, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('pre.mark-box')));

        assertMarkboxStyles(await readMarkboxStyles(page), '標準 CSS オン');

        printConsoleErrors(consoleErrors, '蛍光ペン・マーカー付きテキスト枠(標準 CSS オン)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('「標準 CSS を使う」をオフにしても、蛍光ペン・マーカー付きテキスト枠の見た目は変わらない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), MARKBOX_DOC, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('pre.mark-box')));

        await page.click('#settingsBtn');
        await setSettingCheckbox(page, 'settingUseStandardCss', false);
        await page.click('#settingsCloseBtn');
        await waitFor(
          async () =>
            page.evaluate(() => document.getElementById('preview').contentDocument.getElementById('mdpreview-base-style').textContent === ''),
          { message: '標準 CSS をオフにしても #mdpreview-base-style が空になりませんでした' }
        );

        assertMarkboxStyles(await readMarkboxStyles(page), '標準 CSS オフ');

        printConsoleErrors(consoleErrors, '蛍光ペン・マーカー付きテキスト枠(標準 CSS オフ)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('HTML 出力に markbox.css の内容(蛍光ペン・マーカー付きテキスト枠のスタイル)が含まれる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), MARKBOX_DOC, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('pre.mark-box')));

        await page.evaluate(() => window.__mdpreview.exportNormal());
        await waitFor(async () => existsSync(path.join(dir, 'doc.html')), { message: 'doc.html が出力されませんでした' });
        const html = await fs.readFile(path.join(dir, 'doc.html'), 'utf8');
        assert.ok(html.includes('--mdp-markbox-bg'), 'HTML 出力に markbox.css の内容が含まれていません');
        assert.ok(html.includes('mark-box'), 'HTML 出力に pre.mark-box が含まれていません');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('目視確認用に、蛍光ペン・マーカー付きテキスト枠(複数行・字下げ・枠内の強調 2 か所)のスクリーンショットを保存する', async () => {
    const dir = await mkTmpDir();
    try {
      const content = [
        '# 蛍光ペン・マーカー付きテキスト枠',
        '',
        '段落の ==黄色== と ==赤枠=={.mark-text} です。',
        '',
        '```mark',
        'ここは普通の文字 ==ここを強調== 続き',
        '  字下げされた行 ==ここも強調==',
        '```',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'doc.md'), content, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 800 });
        await pickFolderAndOpen(page, 'doc.md');
        await waitFor(async () =>
          page.evaluate(
            () => window.__mdpreview.getPreviewDocument().querySelectorAll('pre.mark-box span.mark-text').length === 2
          )
        );

        await page.click('.view-mode-btn[data-view-mode="preview"]');
        await sleep(200); // レイアウト安定待ち

        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'markbox.png') });
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // 編集画面の不具合修正(表示モード・サイドバー考慮のドラッグ位置・
  // プレビュー側へのドラッグ・スクロール同期のドリフト)の検証。
  // ---------------------------------------------------------------------

  console.log('\n26) 編集画面の不具合修正(表示モード・ドラッグ位置・スクロール同期)');

  await test('「エディタのみ」表示でエディタが #workArea 全幅になり、プレビューが隠れる。「両方」に戻すとプレビューが再表示される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('.view-mode-btn[data-view-mode="editor"]');
        await waitFor(async () =>
          page.evaluate(() => document.getElementById('mainArea').classList.contains('view-editor-only'))
        );

        const widths = await page.evaluate(() => ({
          editor: document.getElementById('editorPane').getBoundingClientRect().width,
          workArea: document.getElementById('workArea').getBoundingClientRect().width,
        }));
        assert.ok(
          Math.abs(widths.editor - widths.workArea) <= 2,
          `「エディタのみ」表示でエディタ幅が #workArea 幅と一致しません: ${JSON.stringify(widths)}`
        );

        const previewHiddenInEditorOnly = await page.evaluate(
          () => getComputedStyle(document.getElementById('previewPane')).display === 'none'
        );
        assert.ok(previewHiddenInEditorOnly, '「エディタのみ」表示なのにプレビューが非表示になっていません');

        await page.click('.view-mode-btn[data-view-mode="both"]');
        await waitFor(
          async () =>
            page.evaluate(() => getComputedStyle(document.getElementById('previewPane')).display !== 'none'),
          { message: '「両方」に戻してもプレビューが再表示されませんでした' }
        );

        printConsoleErrors(consoleErrors, '「エディタのみ」表示');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('サイドバー表示中に境界(#previewResizer)をドラッグすると、サイドバー幅分ずれずにカーソル位置に境界がついてくる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        const sidebarCollapsed = await page.evaluate(() =>
          document.getElementById('mainArea').classList.contains('sidebar-collapsed')
        );
        assert.equal(sidebarCollapsed, false, '前提条件が崩れています: サイドバーが表示されていません');

        const rects = await page.evaluate(() => {
          const workArea = document.getElementById('workArea').getBoundingClientRect();
          const resizer = document.getElementById('previewResizer').getBoundingClientRect();
          return {
            workAreaLeft: workArea.left,
            workAreaWidth: workArea.width,
            resizerLeft: resizer.left,
            resizerTop: resizer.top,
            resizerWidth: resizer.width,
            resizerHeight: resizer.height,
          };
        });
        const startX = rects.resizerLeft + rects.resizerWidth / 2;
        const startY = rects.resizerTop + rects.resizerHeight / 2;
        const targetX = rects.workAreaLeft + rects.workAreaWidth * 0.3;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(targetX, startY, { steps: 10 });
        await page.mouse.up();

        const resizerAfter = await page.evaluate(() => {
          const r = document.getElementById('previewResizer').getBoundingClientRect();
          return { left: r.left, width: r.width };
        });
        assert.ok(
          targetX >= resizerAfter.left - 2 && targetX <= resizerAfter.left + resizerAfter.width + 2,
          `境界がカーソル位置についてきていません(サイドバー幅分ずれている疑い): targetX=${targetX}, resizer=${JSON.stringify(resizerAfter)}`
        );

        printConsoleErrors(consoleErrors, 'サイドバー表示中のドラッグ');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('境界をプレビュー側までドラッグでき、mouseup 後に比率が保存される。サイドバーを閉じても幅比率が保たれる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 見出し\n\n本文\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        const rects = await page.evaluate(() => {
          const workArea = document.getElementById('workArea').getBoundingClientRect();
          const resizer = document.getElementById('previewResizer').getBoundingClientRect();
          return {
            workAreaLeft: workArea.left,
            workAreaWidth: workArea.width,
            resizerLeft: resizer.left,
            resizerTop: resizer.top,
            resizerWidth: resizer.width,
            resizerHeight: resizer.height,
          };
        });
        const startX = rects.resizerLeft + rects.resizerWidth / 2;
        const startY = rects.resizerTop + rects.resizerHeight / 2;
        const targetX = rects.workAreaLeft + rects.workAreaWidth * 0.8;

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(targetX, startY, { steps: 10 });
        await page.mouse.up();

        const resizerAfter = await page.evaluate(() => {
          const r = document.getElementById('previewResizer').getBoundingClientRect();
          return { left: r.left, width: r.width };
        });
        assert.ok(
          targetX >= resizerAfter.left - 2 && targetX <= resizerAfter.left + resizerAfter.width + 2,
          `境界がプレビュー側のカーソル位置についてきていません: targetX=${targetX}, resizer=${JSON.stringify(resizerAfter)}`
        );

        const resizingAfterUp = await page.evaluate(() => document.body.classList.contains('resizing'));
        assert.equal(resizingAfterUp, false, 'mouseup 後も body.resizing が残っています(iframe にマウスが乗って mouseup が届かなかった疑い)');

        const savedRatio = await page.evaluate(() => Number(localStorage.getItem('mdpreview.editorWidthRatio')));
        assert.ok(Math.abs(savedRatio - 0.8) <= 0.02, `localStorage に保存された比率が 0.8 付近ではありません: ${savedRatio}`);

        const widthRatio = () =>
          page.evaluate(() => {
            const editorWidth = document.getElementById('editorPane').getBoundingClientRect().width;
            const workAreaWidth = document.getElementById('workArea').getBoundingClientRect().width;
            return editorWidth / workAreaWidth;
          });
        assert.ok(Math.abs((await widthRatio()) - 0.8) <= 0.02, `ドラッグ直後の幅比率が 0.8 付近ではありません: ${await widthRatio()}`);

        await page.click('#toggleSidebarBtn');
        await waitFor(async () =>
          page.evaluate(() => document.getElementById('mainArea').classList.contains('sidebar-collapsed'))
        );
        assert.ok(
          Math.abs((await widthRatio()) - 0.8) <= 0.02,
          `サイドバーを閉じた後も幅比率が 0.8 付近に保たれていません: ${await widthRatio()}`
        );

        printConsoleErrors(consoleErrors, 'プレビュー側へのドラッグ');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('エディタを40pxずつ刻んでスクロールしても直接ジャンプしても、プレビューの到達点がほぼ一致し、先頭に戻すとプレビューも先頭付近に戻る', async () => {
    const dir = await mkTmpDir();
    try {
      const paras = Array.from({ length: 60 }, (_, i) => `## 見出し${i}\n\n本文${i} の段落です。\n`).join('');
      await fs.writeFile(path.join(dir, 'doc.md'), paras, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await sleep(300); // 初回描画の安定待ち

        // 前提チェック: エディタが十分スクロールできること。
        const scrollable = await page.evaluate(() => {
          const el = document.querySelector('.cm-scroller');
          return el.scrollHeight - el.clientHeight;
        });
        assert.ok(scrollable > 800, `前提条件が崩れています: エディタが十分スクロールできません(scrollable=${scrollable})`);

        for (let i = 0; i < 10; i++) {
          await page.evaluate((top) => {
            document.querySelector('.cm-scroller').scrollTop = top;
          }, (i + 1) * 40);
          await sleep(120);
        }
        const p1 = await page.evaluate(() => window.__mdpreview.getPreviewDocument().scrollingElement.scrollTop);

        await page.evaluate(() => {
          document.querySelector('.cm-scroller').scrollTop = 0;
        });
        await waitFor(
          async () =>
            (await page.evaluate(() => window.__mdpreview.getPreviewDocument().scrollingElement.scrollTop)) < 50,
          { message: 'エディタを先頭に戻してもプレビューが先頭付近(50px未満)に戻りませんでした' }
        );

        await page.evaluate(() => {
          document.querySelector('.cm-scroller').scrollTop = 400;
        });
        await sleep(300);
        const p2 = await page.evaluate(() => window.__mdpreview.getPreviewDocument().scrollingElement.scrollTop);

        const maxPreviewScroll = await page.evaluate(() => {
          const se = window.__mdpreview.getPreviewDocument().scrollingElement;
          return se.scrollHeight - se.clientHeight;
        });

        assert.ok(
          Math.abs(p1 - p2) <= 30,
          `40px刻みのスクロールと直接ジャンプでプレビューの到達点が一致しません: P1=${p1}, P2=${p2}`
        );
        assert.ok(
          p1 < maxPreviewScroll * 0.5,
          `P1 がプレビューの最大 scrollTop に対して十分小さくありません(スクロール同期がずれ続けている疑い): P1=${p1}, max=${maxPreviewScroll}`
        );

        printConsoleErrors(consoleErrors, 'スクロール同期(刻み vs 直接ジャンプ)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('スクロールしたエディタの表示最下部付近で End+Enter を繰り返しても、プレビューの scrollTop が1回あたり大きく飛ばない', async () => {
    const dir = await mkTmpDir();
    try {
      const paras = Array.from({ length: 60 }, (_, i) => `## 見出し${i}\n\n本文${i} の段落です。\n`).join('');
      await fs.writeFile(path.join(dir, 'doc.md'), paras, 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await sleep(300);

        // エディタを一旦先頭に戻してから 300px までスクロールし、プレビューとの
        // 同期を落ち着かせる(プレビュー・エディタとも初期位置は0)。
        await page.evaluate(() => {
          document.querySelector('.cm-scroller').scrollTop = 0;
        });
        await sleep(200);
        await page.evaluate(() => {
          document.querySelector('.cm-scroller').scrollTop = 300;
        });
        await sleep(300);

        const box = await page.evaluate(() => {
          const el = document.querySelector('.cm-scroller');
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.bottom - 12 };
        });
        await page.mouse.click(box.x, box.y);

        let prevPreview = await page.evaluate(
          () => window.__mdpreview.getPreviewDocument().scrollingElement.scrollTop
        );
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('End');
          await page.keyboard.press('Enter');
          await sleep(400);
          const curPreview = await page.evaluate(
            () => window.__mdpreview.getPreviewDocument().scrollingElement.scrollTop
          );
          const delta = curPreview - prevPreview;
          assert.ok(delta < 150, `${i + 1}回目の Enter でプレビューが大きく飛びました: delta=${delta}`);
          prevPreview = curPreview;
        }

        printConsoleErrors(consoleErrors, 'スクロール同期(下端付近での改行入力)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('末尾付近に縦に長い画像があっても、エディタを最下部までスクロールするとプレビューも最下部になる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'images'));
      // 縦 1500px の画像を末尾に置く。エディタでは1行でも、プレビューでは
      // 「一番上に見えている行」より下にこの画像分の高さが残るため、行の対応
      // だけではプレビューが最下部まで届かない(修正前は失敗する)。
      await fs.writeFile(path.join(dir, 'images', 'tall.png'), makeSolidPng(200, 1500, [30, 120, 90]));
      const paras = Array.from({ length: 40 }, (_, i) => `## 見出し${i}\n\n本文${i} の段落です。\n`).join('');
      await fs.writeFile(path.join(dir, 'doc.md'), paras + '\n![tall](images/tall.png)\n', 'utf8');
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await sleep(300); // 初回描画の安定待ち

        const scrollable = await page.evaluate(() => {
          const el = document.querySelector('.cm-scroller');
          return el.scrollHeight - el.clientHeight;
        });
        assert.ok(scrollable > 400, `前提条件が崩れています: エディタが十分スクロールできません(scrollable=${scrollable})`);

        await page.evaluate(() => {
          const el = document.querySelector('.cm-scroller');
          el.scrollTop = el.scrollHeight - el.clientHeight;
        });

        await waitFor(
          async () => {
            const { previewTop, previewMax } = await page.evaluate(() => {
              const se = window.__mdpreview.getPreviewDocument().scrollingElement;
              return { previewTop: se.scrollTop, previewMax: se.scrollHeight - se.clientHeight };
            });
            return Math.abs(previewTop - previewMax) <= 1;
          },
          { message: 'エディタを最下部までスクロールしてもプレビューが最下部(±1px)になりませんでした' }
        );

        printConsoleErrors(consoleErrors, 'スクロール同期(末尾の縦長画像)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // 27) ファイル操作一式(新規 md・新規フォルダ・名前の変更・削除)
  //   1. 「＋ md」: 開いている md のフォルダに 0 バイトの md ができ、開かれ、ツリーに出る。
  //      sub2/x で途中のフォルダも作る
  //   2. 同名(大文字小文字違いを含む)・禁止文字はモーダル内エラーで閉じず、既存ファイルは変わらない
  //   3. フォルダの右クリック → 新規フォルダ / 新規 md がそのフォルダの中にできる
  //   4. 未保存のまま開いている md の名前を変える(move あり / move なし=コピー方式 / 大文字小文字だけ)
  //   5. 開いている md を含むフォルダの名前を変える(currentPath の付け替え・バイト一致コピー)
  //   6. 削除(confirm の OK/キャンセル、フォルダの件数表示、開いていた md を閉じる)
  //   7. ⟳: 外部で追加した md が出て、開いていたフォルダは開いたまま
  //   8. F2 / Delete キー操作
  // ---------------------------------------------------------------------

  console.log('\n27) ファイル操作一式(新規 md・新規フォルダ・名前の変更・削除)');

  await test('「＋ md」で開いている md のフォルダに 0 バイトの md ができて開かれ、ツリーに出る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'a.md');

        await page.click('#newMdBtn');
        await waitNameModalVisible(page);
        const initial = await getNameModalState(page);
        assert.equal(initial.value, '', 'ルート直下の md を開いているときの初期値が空ではありません');

        await page.keyboard.type('newdoc');
        await page.keyboard.press('Enter');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'newdoc.md', {
          message: '新規作成した md が開かれませんでした',
        });

        const st = await fs.stat(path.join(dir, 'newdoc.md'));
        assert.equal(st.size, 0, '新規作成した md が 0 バイトではありません');

        await waitFor(async () =>
          page.evaluate(() => !!Array.from(document.querySelectorAll('#tree .tree-file-row')).find((r) => r.textContent.trim() === 'newdoc.md'))
        , { message: '新規作成した md がツリーに出ていません' });

        printConsoleErrors(consoleErrors, '新規 md(＋ md ボタン)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('ルートの余白の右クリック → 新規 md でフォルダ付きの入力(sub2/x)から途中のフォルダも作る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'a.md');

        await rightClickTreeBackground(page);
        await clickContextMenuItem(page, '新規 md');
        await waitNameModalVisible(page);

        await page.keyboard.type('sub2/x');
        await page.keyboard.press('Enter');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'sub2/x.md', {
          message: 'sub2/x.md が開かれませんでした',
        });

        const st = await fs.stat(path.join(dir, 'sub2', 'x.md'));
        assert.equal(st.size, 0, '途中のフォルダごと作成した md が 0 バイトではありません');

        printConsoleErrors(consoleErrors, '新規 md(フォルダ付きパス)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('同名(大文字小文字違いを含む)・禁止文字はモーダル内エラーで閉じない。既存ファイルは変わらない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'Existing.md'), '既存の内容\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page);

        await page.click('#newMdBtn');
        await waitNameModalVisible(page);
        await page.keyboard.type('existing'); // 大文字小文字違いで同名
        await page.keyboard.press('Enter');

        await waitFor(async () => (await getNameModalState(page)).errorVisible, {
          message: '同名(大文字小文字違い)のエラーが表示されませんでした',
        });
        assert.ok((await getNameModalState(page)).visible, 'エラー時にモーダルが閉じてしまいました');

        await replaceNameModalInput(page, 'bad:name');
        await page.keyboard.press('Enter');
        await waitFor(async () => (await getNameModalState(page)).errorVisible, {
          message: '禁止文字のエラーが表示されませんでした',
        });
        assert.ok((await getNameModalState(page)).visible, 'エラー時にモーダルが閉じてしまいました(禁止文字)');

        await page.keyboard.press('Escape');
        await waitFor(async () => !(await getNameModalState(page)).visible, { message: 'Escape でモーダルが閉じませんでした' });

        const names = await readDirNames(dir);
        assert.deepEqual(names.sort(), ['Existing.md'], '既存ファイル以外が作られています: ' + JSON.stringify(names));
        const content = await fs.readFile(path.join(dir, 'Existing.md'), 'utf8');
        assert.equal(content, '既存の内容\n', '既存ファイルの内容が変わっています');

        printConsoleErrors(consoleErrors, '新規作成の検証エラー');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('フォルダの右クリック → 新規フォルダ / 新規 md がそのフォルダの中にできる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'projA'));
      await fs.writeFile(path.join(dir, 'projA', 'keep.md'), '# keep\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page);

        await rightClickTreeRow(page, '.tree-dir-row[data-path="projA"]');
        await clickContextMenuItem(page, '新規フォルダ');
        await waitNameModalVisible(page);
        const initial = await getNameModalState(page);
        assert.equal(initial.value, 'projA/', 'フォルダの右クリックからの新規フォルダの初期値が違います');
        await page.keyboard.type('sub');
        await page.keyboard.press('Enter');
        await waitFor(async () => {
          const st = await fs.stat(path.join(dir, 'projA', 'sub')).catch(() => null);
          return !!st && st.isDirectory();
        }, { message: 'projA/sub フォルダが作られませんでした' });

        await rightClickTreeRow(page, '.tree-dir-row[data-path="projA"]');
        await clickContextMenuItem(page, '新規 md');
        await waitNameModalVisible(page);
        await page.keyboard.type('note');
        await page.keyboard.press('Enter');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'projA/note.md', {
          message: 'projA/note.md が開かれませんでした',
        });
        const st = await fs.stat(path.join(dir, 'projA', 'note.md'));
        assert.equal(st.size, 0);

        printConsoleErrors(consoleErrors, 'フォルダの右クリックからの新規作成');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('名前の変更(move): 未保存のまま開いている md の名前を変える。内容と未保存の印は残り、保存で新パスに書かれ競合モーダルが出ない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# 初期\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');

        await page.click('.cm-content');
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\n未保存の本文');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).dirty);

        await rightClickTreeRow(page, '.tree-file-row[data-path="doc.md"]');
        await clickContextMenuItem(page, '名前の変更');
        await waitNameModalVisible(page);
        const initial = await getNameModalState(page);
        assert.equal(initial.value, 'doc.md');
        await page.keyboard.type('renamed'); // 拡張子の手前が選択されているので置き換わる
        await page.keyboard.press('Enter');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'renamed.md', {
          message: '名前の変更後に currentPath が付け替わりませんでした',
        });
        // 完了の文言は操作の直後に確かめる(後の保存で「保存しました」に置き換わるため)。
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getStatusMessage())) === '名前を変更しました', {
          message: 'move での名前の変更の完了がステータスバーに出ていません',
        });
        const stateAfterRename = await page.evaluate(() => window.__mdpreview.getState());
        assert.equal(stateAfterRename.dirty, true, '未保存の印が消えています');
        assert.ok((await page.evaluate(() => window.__mdpreview.getEditorText())).includes('未保存の本文'), '編集中の内容が失われました');
        const hash = await page.evaluate(() => location.hash);
        assert.equal(decodeURIComponent(hash), '#file=renamed.md', '#file= が新しいパスになっていません');

        await fs.access(path.join(dir, 'doc.md')).then(
          () => assert.fail('旧ファイル doc.md が残っています'),
          () => {}
        );
        const renamedOnDiskBeforeSave = await fs.readFile(path.join(dir, 'renamed.md'), 'utf8');
        assert.equal(renamedOnDiskBeforeSave, '# 初期\n', 'ディスク上の内容が保存前に変わっています');

        await page.evaluate(() => window.__mdpreview.save());
        await waitFor(async () => !(await page.evaluate(() => window.__mdpreview.getState())).dirty, {
          message: '名前の変更後の保存が完了しませんでした',
        });
        assert.equal(
          await page.evaluate(() => window.__mdpreview.isConflictModalVisible()),
          false,
          '名前の変更後の保存で競合モーダルが誤って出ました'
        );
        const onDisk = await fs.readFile(path.join(dir, 'renamed.md'), 'utf8');
        assert.ok(onDisk.includes('未保存の本文'), '保存後のディスクの内容が正しくありません');

        printConsoleErrors(consoleErrors, '名前の変更(move・未保存の引き継ぎ)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('名前の変更(move 非対応): コピー方式にフォールバックし、内容を保ったまま名前が変わる', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# コピー方式で変更\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.evaluate(() => window.__fakeFs.setFileMoveSupported(false));

        await rightClickTreeRow(page, '.tree-file-row[data-path="doc.md"]');
        await clickContextMenuItem(page, '名前の変更');
        await waitNameModalVisible(page);
        await page.keyboard.type('copied');
        await page.keyboard.press('Enter');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'copied.md', {
          message: 'コピー方式での名前の変更後に currentPath が付け替わりませんでした',
        });
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getStatusMessage())) === '名前を変更しました(コピー方式)',
          { message: 'コピー方式で行われたことがステータスバーに出ていません' }
        );

        await fs.access(path.join(dir, 'doc.md')).then(
          () => assert.fail('旧ファイル doc.md が残っています'),
          () => {}
        );
        const content = await fs.readFile(path.join(dir, 'copied.md'), 'utf8');
        assert.equal(content, '# コピー方式で変更\n', 'コピー方式での内容が一致しません');

        printConsoleErrors(consoleErrors, '名前の変更(コピー方式)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('名前の変更: 大文字小文字だけの変更ができる(move あり)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'lower.md'), '# 大文字小文字\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'lower.md');

        await rightClickTreeRow(page, '.tree-file-row[data-path="lower.md"]');
        await clickContextMenuItem(page, '名前の変更');
        await waitNameModalVisible(page);
        await page.keyboard.type('LOWER'); // 拡張子の手前(lower)が選択されている
        await page.keyboard.press('Enter');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'LOWER.md', {
          message: '大文字小文字だけの変更後に currentPath が付け替わりませんでした',
        });
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getStatusMessage())) === '名前を変更しました', {
          message: '大文字小文字だけの変更の完了がステータスバーに出ていません',
        });

        const names = await readDirNames(dir);
        assert.ok(names.includes('LOWER.md'), 'LOWER.md がディスクにありません: ' + JSON.stringify(names));
        assert.ok(!names.includes('lower.md'), 'lower.md が残っています(大文字小文字だけの変更で二重に存在): ' + JSON.stringify(names));
        const content = await fs.readFile(path.join(dir, 'LOWER.md'), 'utf8');
        assert.equal(content, '# 大文字小文字\n');

        printConsoleErrors(consoleErrors, '名前の変更(大文字小文字だけ)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('開いている md を含むフォルダの名前を変える: currentPath が付け替わり、md 以外(画像・ドット始まり)もバイト一致でコピーされ、元のフォルダは消える', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'proj', 'images'), { recursive: true });
      await fs.writeFile(path.join(dir, 'proj', 'note.md'), '# proj\n', 'utf8');
      await fs.writeFile(path.join(dir, 'proj', '.hidden'), 'hidden-data\n', 'utf8');
      const pngBuf = Buffer.from(TEST_PNG_BASE64, 'base64');
      await fs.writeFile(path.join(dir, 'proj', 'images', 'pic.png'), pngBuf);

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'proj/note.md');

        await rightClickTreeRow(page, '.tree-dir-row[data-path="proj"]');
        await clickContextMenuItem(page, '名前の変更');
        await waitNameModalVisible(page);
        await page.keyboard.type('proj2');
        await page.keyboard.press('Enter');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === 'proj2/note.md', {
          message: 'フォルダの名前の変更後に currentPath が付け替わりませんでした',
        });
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getStatusMessage())) === '名前を変更しました(コピー方式)',
          { message: 'フォルダの名前の変更の完了がステータスバーに出ていません' }
        );

        await fs.access(path.join(dir, 'proj')).then(
          () => assert.fail('元のフォルダ proj が残っています'),
          () => {}
        );
        const noteContent = await fs.readFile(path.join(dir, 'proj2', 'note.md'), 'utf8');
        assert.equal(noteContent, '# proj\n');
        const hiddenContent = await fs.readFile(path.join(dir, 'proj2', '.hidden'), 'utf8');
        assert.equal(hiddenContent, 'hidden-data\n', 'ドット始まりのファイルがコピーされていません');
        const copiedPng = await fs.readFile(path.join(dir, 'proj2', 'images', 'pic.png'));
        assert.ok(copiedPng.equals(pngBuf), '画像がバイト一致でコピーされていません');

        printConsoleErrors(consoleErrors, 'フォルダの名前の変更(開いている md を含む)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('削除: confirm で OK するとディスクから消え、開いていた md なら閉じる。キャンセルすると何も変わらない', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'a.md'), '# a\n', 'utf8');
      await fs.writeFile(path.join(dir, 'b.md'), '# b\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'a.md');

        // キャンセル: 何も変わらない。
        page.once('dialog', (d) => d.dismiss());
        await rightClickTreeRow(page, '.tree-file-row[data-path="b.md"]');
        await clickContextMenuItem(page, '削除');
        await sleep(300);
        await fs.access(path.join(dir, 'b.md')); // 例外なく読めれば残っている

        // OK: 開いていた a.md を削除 → 閉じる。
        let confirmText = null;
        page.once('dialog', (d) => {
          confirmText = d.message();
          d.accept();
        });
        await rightClickTreeRow(page, '.tree-file-row[data-path="a.md"]');
        await clickContextMenuItem(page, '削除');

        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === null, {
          message: '削除した md が閉じられませんでした',
        });
        assert.ok(confirmText && confirmText.includes('完全に削除'), '削除確認に「完全に削除」の文言がありません: ' + confirmText);

        await fs.access(path.join(dir, 'a.md')).then(
          () => assert.fail('削除したはずの a.md が残っています'),
          () => {}
        );

        printConsoleErrors(consoleErrors, '削除(ファイル・OK/キャンセル)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('削除: フォルダの確認文に件数(md・その他のファイル・フォルダ)が出て、中身ごと削除される', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'proj', 'sub'), { recursive: true });
      await fs.writeFile(path.join(dir, 'proj', 'a.md'), '# a\n', 'utf8');
      await fs.writeFile(path.join(dir, 'proj', 'b.md'), '# b\n', 'utf8');
      await fs.writeFile(path.join(dir, 'proj', 'notes.txt'), 'plain\n', 'utf8');
      await fs.writeFile(path.join(dir, 'proj', 'sub', 'c.md'), '# c\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page);

        let confirmText = null;
        page.once('dialog', (d) => {
          confirmText = d.message();
          d.accept();
        });
        await rightClickTreeRow(page, '.tree-dir-row[data-path="proj"]');
        await clickContextMenuItem(page, '削除');

        await waitFor(async () => confirmText != null, { message: '確認ダイアログが出ませんでした' });
        assert.ok(confirmText.includes('md 3 件'), '確認文の md 件数が違います: ' + confirmText);
        assert.ok(confirmText.includes('その他のファイル 1 件'), '確認文のその他のファイル件数が違います: ' + confirmText);
        assert.ok(confirmText.includes('フォルダ 1 件'), '確認文のフォルダ件数が違います: ' + confirmText);
        assert.ok(confirmText.includes('完全に削除'), '確認文に「完全に削除」の文言がありません: ' + confirmText);

        await waitFor(async () => {
          const st = await fs.stat(path.join(dir, 'proj')).catch(() => null);
          return st == null;
        }, { message: 'フォルダが削除されませんでした' });

        printConsoleErrors(consoleErrors, '削除(フォルダ・件数表示)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('削除: 開いている md が未保存のときは確認文に「未保存の変更も失われます」が出る', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# doc\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page, 'doc.md');
        await page.click('.cm-content');
        await page.keyboard.type('未保存の追記');
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).dirty);

        let confirmText = null;
        page.once('dialog', (d) => {
          confirmText = d.message();
          d.accept();
        });
        await rightClickTreeRow(page, '.tree-file-row[data-path="doc.md"]');
        await clickContextMenuItem(page, '削除');

        await waitFor(async () => confirmText != null);
        assert.ok(confirmText.includes('未保存の変更も失われます'), '確認文に未保存の警告がありません: ' + confirmText);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === null);

        printConsoleErrors(consoleErrors, '削除(未保存の警告)');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('F2 で名前の変更モーダル、Delete で削除の確認ダイアログが開く(ツリーの行にフォーカスがあるとき)', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.writeFile(path.join(dir, 'doc.md'), '# doc\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page);

        await page.focus('.tree-file-row[data-path="doc.md"]');
        await page.keyboard.press('F2');
        await waitNameModalVisible(page);
        assert.equal((await getNameModalState(page)).value, 'doc.md');
        await page.keyboard.press('Escape');

        await page.focus('.tree-file-row[data-path="doc.md"]');
        let confirmText = null;
        page.once('dialog', (d) => {
          confirmText = d.message();
          d.dismiss();
        });
        await page.keyboard.press('Delete');
        await waitFor(async () => confirmText != null, { message: 'Delete キーで確認ダイアログが出ませんでした' });
        await sleep(200);
        await fs.access(path.join(dir, 'doc.md')); // キャンセルしたので残っている

        printConsoleErrors(consoleErrors, 'F2 / Delete キー操作');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('⟳: 外部で追加した md が出て、開いていたフォルダは開いたまま', async () => {
    const dir = await mkTmpDir();
    try {
      await fs.mkdir(path.join(dir, 'sub'));
      await fs.writeFile(path.join(dir, 'sub', 'x.md'), '# x\n', 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await pickFolderAndOpen(page);

        await expandTreeDir(page, 'sub');
        await waitFor(async () =>
          page.evaluate(() => !!Array.from(document.querySelectorAll('#tree .tree-file-row')).find((r) => r.textContent.trim() === 'x.md'))
        );

        await fs.writeFile(path.join(dir, 'sub', 'y.md'), '# y\n', 'utf8');
        await page.click('#refreshTreeBtn');

        await waitFor(async () =>
          page.evaluate(() => !!Array.from(document.querySelectorAll('#tree .tree-file-row')).find((r) => r.textContent.trim() === 'y.md'))
        , { message: '外部で追加した md が再読込後に出ていません' });
        // sub フォルダが開いたまま(x.md がまだ見えている)であること。
        assert.ok(
          await page.evaluate(() => !!Array.from(document.querySelectorAll('#tree .tree-file-row')).find((r) => r.textContent.trim() === 'x.md')),
          '再読込でフォルダが閉じてしまいました'
        );

        printConsoleErrors(consoleErrors, 'ツリーの再読込(⟳)');
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
