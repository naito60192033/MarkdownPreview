// dev/harness.mjs
//
// `node dev/harness.mjs`(= `npm run test:e2e`)で走る E2E テストランナー。
// task-kanri の dev/harness.mjs と同じ構成(外部フレームワークを使わない自前の
// test() ヘルパー、waitFor、browserEnv、--only、1件も実行されなければ失敗)を
// 踏襲する。`file://` で開いた `dist/mdpreview.html` をヘッドレス Chromium で
// 操作し、`window.showDirectoryPicker` を `dev/fake-fs.mjs` のフェイクに
// 差し替えて検証する。
//
// フェーズ0で検証する4点:
//   1. iframe srcdoc の中身を親から(再読み込みせずに)更新できる
//   2. インライン化した mermaid が SVG を描画する
//   3. fake-fs でフォルダを選び、test.md の読み書き・PNG バイナリの読み書きができる
//   4. IndexedDB に保存したハンドルがページの再読み込み後に復元される
//
// CLI:
//   node dev/harness.mjs                  全テストを1回
//   node dev/harness.mjs --only=mermaid    テスト「名」に部分一致するものだけ
//   node dev/harness.mjs --repeat=5       全体を5回繰り返す(フレーク検出用)
//
// 前提: 開発コンテナでは先に `bash dev/setup-container.sh` を1度実行しておく
// (/tmp は揮発するのでコンテナを作り直したら再実行が必要)。

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installFakeFs } from './fake-fs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_HTML = path.join(REPO_ROOT, 'dist', 'mdpreview.html');
const DIST_URL = 'file://' + DIST_HTML;
const TEST_FILE = 'test.md';

// 1x1 の赤いピクセルからなる最小の有効な PNG(よく使われる既知のバイト列)。
// バイナリの読み書きが「文字列として偶然一致した」のではなく、実際にバイト列
// として正しく往復していることを確認するために使う。
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ---------- CLI 引数 ----------
const ARGV = process.argv.slice(2);
function argValue(flag) {
  const hit = ARGV.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : null;
}
const ONLY = argValue('--only');
const REPEAT = Math.max(1, Number(argValue('--repeat')) || 1);

// この開発コンテナには Chromium の実行に必要な共有ライブラリとフォントが
// システムにインストールされていない(root 権限がないため apt が使えない)。
// `dev/setup-container.sh` が /tmp/chromedeps 配下にそれらを展開するので、
// 存在すればここで自動的に参照する。既に環境変数が設定されていればそちらを尊重する。
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

async function waitFor(fn, { timeout = 5000, interval = 100, message = '条件が満たされませんでした' } = {}) {
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

// setup() 内でのフォルダ自動復元(fsTryRestoreFolder 等)を待ってから
// window.__mdpreview を公開するため、ページの load イベント後も少し遅れて
// 準備が整う。単発の評価ではなく待ち合わせる。
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
async function withPage(browser, { rootDir } = {}, fn) {
  const context = await browser.newContext();
  let fsController = null;
  if (rootDir) {
    fsController = await installFakeFs(context, { rootDir });
  }
  const page = await context.newPage();
  const consoleErrors = [];
  attachDebugLogging(page, consoleErrors);
  await page.goto(DIST_URL);
  await ensureHooks(page);
  try {
    return await fn({ page, context, consoleErrors, fsController });
  } finally {
    await context.close();
  }
}

// ---------- テスト本体 ----------
async function runTests(browser) {
  console.log('\n1) プレビューの更新(iframe を再読み込みせず body を差し替える)');
  await test('textarea に入力するとプレビュー(iframe.contentDocument.body)が更新される', async () => {
    await withPage(browser, {}, async ({ page, consoleErrors }) => {
      // iframe の window が「差し替えではなく同一のまま」であることを確認するための
      // マーカー。srcdoc の再代入(＝ナビゲーション)が起きればこのマーカーは消える。
      await page.evaluate(() => {
        const frame = document.getElementById('preview');
        frame.contentWindow.__noReloadMarker = 'kept';
      });

      await page.fill('#editor', '# 見出し1\n\n本文A');
      await waitFor(
        async () => {
          const html = await page.evaluate(() => window.__mdpreview.getPreviewBodyHtml());
          return html.includes('見出し1') && html.includes('本文A');
        },
        { message: '入力1回目がプレビューに反映されませんでした' }
      );

      await page.fill('#editor', '# 見出し2\n\n本文B');
      await waitFor(
        async () => {
          const html = await page.evaluate(() => window.__mdpreview.getPreviewBodyHtml());
          return html.includes('見出し2') && html.includes('本文B') && !html.includes('見出し1');
        },
        { message: '入力2回目でプレビューが更新されませんでした' }
      );

      const markerKept = await page.evaluate(() => document.getElementById('preview').contentWindow.__noReloadMarker);
      assert.equal(markerKept, 'kept', 'iframe が再読み込みされています(srcdoc の再代入が起きた疑い)');

      printConsoleErrors(consoleErrors, 'プレビュー更新');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n2) mermaid の描画');
  await test('```mermaid コードブロックが iframe 内に svg として描画される', async () => {
    await withPage(browser, {}, async ({ page, consoleErrors }) => {
      const src = '```mermaid\ngraph TD;\n  A[開始] --> B[終了];\n```\n';
      await page.evaluate((t) => window.__mdpreview.setEditorText(t), src);
      await waitFor(
        async () => (await page.evaluate(() => window.__mdpreview.getPreviewSvgCount())) > 0,
        { message: 'mermaid が SVG を描画しませんでした', timeout: 8000 }
      );
      const svgCount = await page.evaluate(() => window.__mdpreview.getPreviewSvgCount());
      assert.equal(svgCount, 1, `svg の数が想定と異なります: ${svgCount}`);

      printConsoleErrors(consoleErrors, 'mermaid描画');
      assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
    });
  });

  console.log('\n3) fake-fs でのフォルダ選択・読み書き(テキスト・バイナリ)');
  await test('フォルダを選ぶと test.md を読み込み、編集して保存するとディスクの内容が変わる', async () => {
    const dir = await mkTmpDir();
    try {
      const seed = '# 初期状態\n\nこれは初期状態のテキストです。\n';
      await fs.writeFile(path.join(dir, TEST_FILE), seed, 'utf8');

      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await page.evaluate(() => window.__mdpreview.pickFolder());
        await waitFor(
          async () => (await page.evaluate(() => window.__mdpreview.getEditorText())) === seed,
          { message: 'フォルダ選択後に test.md の内容が読み込まれませんでした' }
        );

        const edited = '# 編集後\n\nこれは編集後のテキストです。\n';
        await page.evaluate((t) => window.__mdpreview.setEditorText(t), edited);
        await page.evaluate(() => window.__mdpreview.save());

        await waitFor(
          async () => {
            const onDisk = await fs.readFile(path.join(dir, TEST_FILE), 'utf8');
            return onDisk === edited;
          },
          { message: '保存してもディスク上の test.md が更新されませんでした' }
        );

        printConsoleErrors(consoleErrors, 'test.md 読み書き');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test('バイナリ(PNG)を書き込み、読み戻すとバイト列が一致する', async () => {
    const dir = await mkTmpDir();
    try {
      await withPage(browser, { rootDir: dir }, async ({ page, consoleErrors }) => {
        await page.evaluate(() => window.__mdpreview.pickFolder());
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.state)).hasDir, {
          message: 'フォルダの選択が完了しませんでした',
        });

        await page.evaluate((b64) => window.__mdpreview.writeBinaryFile('image.png', b64), TEST_PNG_BASE64);

        // ディスク上に書かれたバイト列が元の PNG と一致することを確認する
        // (fake-fs の base64 往復と createWritable().write() の型対応の両方を検証する)。
        await waitFor(async () => {
          try {
            const onDisk = await fs.readFile(path.join(dir, 'image.png'));
            return onDisk.equals(Buffer.from(TEST_PNG_BASE64, 'base64'));
          } catch {
            return false;
          }
        }, { message: 'ディスク上の image.png が元の PNG と一致しませんでした' });

        // アプリ自身の getFile()/arrayBuffer() 経由での読み戻しも一致することを確認する。
        const readBack = await page.evaluate(() => window.__mdpreview.readBinaryFileAsBase64('image.png'));
        assert.equal(readBack, TEST_PNG_BASE64, 'アプリ経由で読み戻した PNG のバイト列が一致しません');

        printConsoleErrors(consoleErrors, 'PNGバイナリ読み書き');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  console.log('\n4) IndexedDB へのハンドル保存と再読み込み後の復元');
  await test('フォルダを選んだ後にページを再読み込みすると、ハンドルが自動で復元される', async () => {
    const dir = await mkTmpDir();
    try {
      const seed = '# 再起動テスト\n\n再読み込み後も復元されるはずの内容です。\n';
      await fs.writeFile(path.join(dir, TEST_FILE), seed, 'utf8');

      const context = await browser.newContext();
      const fsController = await installFakeFs(context, { rootDir: dir });
      void fsController;
      const page = await context.newPage();
      const consoleErrors = [];
      attachDebugLogging(page, consoleErrors);
      try {
        await page.goto(DIST_URL);
        await ensureHooks(page);
        await page.evaluate(() => window.__mdpreview.pickFolder());
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())) === seed, {
          message: '初回のフォルダ選択で test.md が読み込まれませんでした',
        });

        // 再読み込み: pickFolder は呼ばず、起動時の自動復元だけに委ねる。
        await page.reload();
        await ensureHooks(page);
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.state)).hasDir, {
          message: '再読み込み後にフォルダが自動復元されませんでした(IndexedDB からのハンドル復元に失敗)',
        });
        await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getEditorText())) === seed, {
          message: '再読み込み後に test.md の自動読み込みが行われませんでした',
        });

        printConsoleErrors(consoleErrors, 'IndexedDBハンドル復元');
        assert.equal(consoleErrors.length, 0, 'コンソールエラーが発生しました');
      } finally {
        await context.close();
      }
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
