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
import { fileURLToPath } from 'node:url';
import { installFakeFs } from './fake-fs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_HTML = path.join(REPO_ROOT, 'dist', 'mdpreview.html');
const DIST_URL = 'file://' + DIST_HTML;

// 1x1 の赤いピクセルからなる最小の有効な PNG。
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
