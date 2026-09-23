// dev/readme-screenshots.mjs
//
// `node dev/readme-screenshots.mjs`(= `npm run screenshots`)で走る、README.md 用の
// スクリーンショットを撮るためのスクリプト。E2E テスト(dev/harness.mjs・
// dev/annotator-harness.mjs)ではなく、見た目の確認用の画像を docs/images/ に
// 生成するだけの一回きりの用途なので、自前の test() ランナーは持たない。
//
// dist/mdpreview.html を file:// で開き、dev/fake-fs.mjs の installFakeFs で
// showDirectoryPicker をフェイクに差し替える点、ワークスペースを開く手順・待ち方・
// 単体プレビュー(openDroppedHandles)・貼り付けメニューの出し方は dev/harness.mjs を、
// 注釈エディタの開き方・図形の描き方は dev/annotator-harness.mjs を、それぞれ参考にして
// 必要なヘルパーをコピーしている(両ファイル自体は変更しない)。
//
// 前提: 開発コンテナでは先に `bash dev/setup-container.sh` を1度実行しておくこと。
// 実行前に `npm run build` で dist/mdpreview.html を最新化しておくこと(このスクリプトは
// ビルドしない)。
//
// 出力先: docs/images/(README.md からリンクする想定。README.md 自体はこのスクリプトでは
// 編集しない)。

import { chromium } from 'playwright';
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
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'images');

const VIEWPORT = { width: 1280, height: 800 };
const WORKSPACE_NAME = '○○受付管理システム 設計書';
const MAIN_MD = '基本設計書.md';

// 1x1 の赤いピクセルからなる最小の有効な PNG(貼り付けメニューを出すための
// 合成 ClipboardEvent 用。dev/harness.mjs の TEST_PNG_BASE64 と同じもの)。
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ---------- dev/harness.mjs から流用したヘルパー ----------
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

async function ensureHooks(page) {
  await waitFor(async () => page.evaluate(() => typeof window.__mdpreview !== 'undefined'), {
    message: 'window.__mdpreview が未定義のままです',
  });
}

function attachDebugLogging(page, consoleErrors) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push('pageerror: ' + (err.stack || err.message || String(err)));
  });
  page.on('requestfailed', (req) => {
    consoleErrors.push(`requestfailed(${currentStepLabel}): ` + req.url() + ' ' + JSON.stringify(req.failure()));
  });
}
let currentStepLabel = '(不明)';

// フォルダを選び、指定した md を開いた状態にする(dev/harness.mjs と同じ手順)。
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

// プレビュー内の最初の画像にマウスを乗せる(画像編集ボタンを表示させるため)。
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

async function expandTreeFolder(page, label) {
  await page.evaluate((l) => {
    const rows = Array.from(document.querySelectorAll('#tree .tree-dir-row'));
    const row = rows.find((r) => r.querySelector('.tree-label').textContent.trim() === l);
    if (row) row.click();
  }, label);
}

// ---------- dev/annotator-harness.mjs から流用した、注釈エディタの操作ヘルパー ----------
// (「メインアプリの中で開いた」注釈エディタに対して使う。無限キャンバスのため
// viewBox からクライアント座標への変換係数を毎回求める)。
async function annotatorBox(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('.annotator-svg');
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return { left: r.left, top: r.top, width: r.width, height: r.height, vbX: vb.x, vbY: vb.y, vbW: vb.width, vbH: vb.height };
  });
}
function toClientPoint(box, pt) {
  const scaleX = box.width / box.vbW;
  const scaleY = box.height / box.vbH;
  return { x: box.left + (pt.x - box.vbX) * scaleX, y: box.top + (pt.y - box.vbY) * scaleY };
}
async function dragOnAnnotator(page, from, to) {
  const box = await annotatorBox(page);
  const p1 = toClientPoint(box, from);
  const p2 = toClientPoint(box, to);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, { steps: 3 });
  await page.mouse.move(p2.x, p2.y, { steps: 3 });
  await page.mouse.up();
}
async function clickOnAnnotator(page, pt) {
  const box = await annotatorBox(page);
  const c = toClientPoint(box, pt);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
}
async function selectAnnotatorTool(page, tool) {
  await page.click(`.annotator-tool-btn[data-tool="${tool}"]`);
}

// ---------- ここから、このスクリプト独自のヘルパー ----------

function shotPath(name) {
  return path.join(OUT_DIR, name);
}
async function shot(page, name, opts) {
  await page.screenshot({ path: shotPath(name), ...opts });
  const st = await fs.stat(shotPath(name));
  console.log(`  \x1b[32m✓\x1b[0m ${name} (${Math.round(st.size / 1024)} KB)`);
}

// 見出し(h2)のテキストから、次の h2 が出るまでの兄弟要素をまとめて囲む範囲を
// クリップ用の矩形(ページ座標)として求める。alerts.png・highlight.png のように
// プレビュー内の一部分だけを切り出すために使う。
async function sectionClipRect(page, headingText, pad = 16) {
  // 対象の見出しをプレビュー(iframe)の先頭までスクロールしてから測る(スクロール
  // していないと本文の途中がプレビューの表示領域からはみ出し、clip がページの
  // 外側になってしまうため)。
  await page.evaluate((headingText) => {
    const doc = window.__mdpreview.getPreviewDocument();
    const heading = Array.from(doc.querySelectorAll('h2')).find((h) => h.textContent.trim() === headingText);
    if (heading) heading.scrollIntoView({ block: 'start' });
  }, headingText);
  await sleep(150);

  const rect = await page.evaluate((headingText) => {
    const doc = window.__mdpreview.getPreviewDocument();
    const heading = Array.from(doc.querySelectorAll('h2')).find((h) => h.textContent.trim() === headingText);
    if (!heading) return null;
    const rects = [];
    let el = heading.nextElementSibling;
    while (el && el.tagName !== 'H2') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      el = el.nextElementSibling;
    }
    if (rects.length === 0) return null;
    return {
      top: Math.min(...rects.map((r) => r.top)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
    };
  }, headingText);
  if (!rect) throw new Error(`見出し「${headingText}」の直後の要素が見つかりませんでした`);
  const frame = await page.evaluate(() => document.getElementById('preview').getBoundingClientRect());
  const x = Math.max(0, frame.left + rect.left - pad);
  const y = Math.max(0, frame.top + rect.top - pad);
  // clip はスクリーンショット全体(= 現在の viewport サイズ)の内側に収まっている
  // 必要があるため、呼び出し側が縦に広げた viewport をそのまま見る(定数 VIEWPORT
  // 固定だと、5個のアラートのように高さが 800px を超える範囲で下端が切れる)。
  const viewport = page.viewportSize() || VIEWPORT;
  const maxWidth = viewport.width - x;
  const maxHeight = viewport.height - y;
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.right - rect.left + pad * 2, maxWidth)),
    height: Math.max(1, Math.min(rect.bottom - rect.top + pad * 2, maxHeight)),
  };
}

async function waitForMainDocRendered(page) {
  await waitFor(async () => (await page.evaluate(() => window.__mdpreview.getState())).currentPath === MAIN_MD, {
    message: `${MAIN_MD} が開きませんでした`,
  });
  await waitFor(
    async () => page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelectorAll('svg').length > 0),
    { message: 'mermaid が描画されませんでした' }
  );
  await waitFor(
    async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('.markdown-alert')),
    { message: 'アラートが描画されませんでした' }
  );
  await waitFor(
    async () =>
      page.evaluate(async () => {
        const img = window.__mdpreview.getPreviewDocument().querySelector('img');
        if (!img) return false;
        if (img.complete) return img.naturalWidth > 0;
        return new Promise((resolve) => {
          img.addEventListener('load', () => resolve(true), { once: true });
          img.addEventListener('error', () => resolve(false), { once: true });
        });
      }),
    { message: '画面キャプチャの画像が表示されませんでした' }
  );
}

// 画像とタブ区切りテキストの両方を持つ合成 ClipboardEvent を .cm-content に
// dispatch する(dev/harness.mjs の pasteImageAndText と同じ)。
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

// ---------- 画面キャプチャ風のダミー画像を作る ----------
// 単色ではなく、ヘッダ帯・検索ボックス・ボタン・一覧表のような矩形を並べた
// 簡易 HTML を Playwright で撮って PNG にする。座標は固定値で設計しているので、
// 後で注釈(赤枠・矢印)を「新規登録」ボタンの位置に正確に重ねられる。
const MOCK_WIDTH = 960;
const MOCK_HEIGHT = 600;
const MOCK_BUTTON_RECT = { x1: 786, y1: 84, x2: 936, y2: 124 };

function mockScreenshotHtml() {
  const rows = [
    ['R-1024', '窓口対応の遅延について', '対応中', '田中', '2026-09-10 10:15'],
    ['R-1023', '申請書類の再発行依頼', '未対応', '未割当', '2026-09-10 09:40'],
    ['R-1022', '住所変更の届出', '完了', '鈴木', '2026-09-09 16:05'],
    ['R-1021', 'システム利用方法の問い合わせ', '完了', '高橋', '2026-09-09 14:20'],
    ['R-1020', '受付票の再発行', '対応中', '田中', '2026-09-09 11:02'],
  ];
  const rowHtml = rows
    .map(
      (cols, i) => `
      <div class="row" style="top:${188 + i * 40}px;background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'}">
        <span style="flex:0 0 90px;color:#3a4553;">${cols[0]}</span>
        <span style="flex:1 1 auto;color:#1c2430;">${cols[1]}</span>
        <span style="flex:0 0 70px;color:${cols[2] === '完了' ? '#1a8a4a' : cols[2] === '対応中' ? '#b4680a' : '#a03a3a'};font-weight:600;">${cols[2]}</span>
        <span style="flex:0 0 70px;color:#3a4553;">${cols[3]}</span>
        <span style="flex:0 0 150px;color:#6b7787;">${cols[4]}</span>
      </div>`
    )
    .join('');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: ${MOCK_WIDTH}px; height: ${MOCK_HEIGHT}px; background: #eef1f5; font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; }
  .abs { position: absolute; }
  .header { top:0; left:0; right:0; height:64px; background:#1f4e79; color:#fff; display:flex; align-items:center; padding:0 20px; font-size:19px; font-weight:600; }
  .nav { top:24px; right:24px; color:#cfe0f0; font-size:12px; }
  .search { top:84px; left:24px; width:280px; height:40px; background:#fff; border:1px solid #c7d0da; border-radius:6px; line-height:40px; padding-left:12px; color:#8a94a3; font-size:13px; }
  .newbtn { top:${MOCK_BUTTON_RECT.y1}px; left:${MOCK_BUTTON_RECT.x1}px; width:${MOCK_BUTTON_RECT.x2 - MOCK_BUTTON_RECT.x1}px; height:${MOCK_BUTTON_RECT.y2 - MOCK_BUTTON_RECT.y1}px; background:#2f6fb0; color:#fff; border-radius:6px; text-align:center; line-height:${MOCK_BUTTON_RECT.y2 - MOCK_BUTTON_RECT.y1}px; font-size:14px; font-weight:600; }
  .table { top:148px; left:24px; right:24px; background:#fff; border:1px solid #dde3ea; border-radius:6px; overflow:hidden; }
  .thead { display:flex; height:40px; align-items:center; background:#eef2f6; font-size:12px; font-weight:600; color:#4a5566; padding:0 14px; }
  .row { position:absolute; left:24px; right:24px; height:40px; display:flex; align-items:center; padding:0 14px; font-size:13px; border-top:1px solid #eef1f5; }
</style></head>
<body>
  <div class="abs header">受付管理システム<span class="abs nav">受付一覧&nbsp;&nbsp;対応履歴&nbsp;&nbsp;設定</span></div>
  <div class="abs search">受付番号・件名で検索</div>
  <div class="abs newbtn">＋ 新規登録</div>
  <div class="abs table">
    <div class="thead">
      <span style="flex:0 0 90px;">受付番号</span><span style="flex:1 1 auto;">件名</span>
      <span style="flex:0 0 70px;">状況</span><span style="flex:0 0 70px;">担当</span><span style="flex:0 0 150px;">受付日時</span>
    </div>
  </div>
  ${rowHtml}
</body></html>`;
}

async function makeScreenshotMockPng(browser, destPath) {
  const tmpHtml = path.join(os.tmpdir(), `mdpreview-mockui-${Date.now()}.html`);
  await fs.writeFile(tmpHtml, mockScreenshotHtml(), 'utf8');
  const context = await browser.newContext({ viewport: { width: MOCK_WIDTH, height: MOCK_HEIGHT }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto('file://' + tmpHtml);
    await page.screenshot({ path: destPath });
  } finally {
    await context.close();
    await fs.rm(tmpHtml, { force: true });
  }
}

// ---------- サンプルワークスペースの用意 ----------
async function writeSampleWorkspace(browser, dir) {
  await fs.mkdir(path.join(dir, 'images', '基本設計書'), { recursive: true });
  await fs.mkdir(path.join(dir, '詳細設計'), { recursive: true });
  await fs.mkdir(path.join(dir, '議事録'), { recursive: true });

  await makeScreenshotMockPng(browser, path.join(dir, 'images', '基本設計書', 'screenshot.png'));

  const mainMd = `# ○○受付管理システム 基本設計書

本書は「○○受付管理システム」の基本設計書です。関係者向けにシステムの全体像・画面構成・データ構造・処理フローをまとめています。

## 1. 概要

○○受付管理システムは、窓口業務における受付登録・進捗管理・履歴照会を一元化するための業務システムです。既存の紙台帳運用を置き換え、検索性と集計の効率化を目的としています。

### 1.1 対象範囲

- 受付登録・受付一覧の表示
- 対応状況の更新(未対応 / 対応中 / 完了)
- 受付履歴の検索・CSV 出力
- 管理者向けの利用者管理

### 1.2 対象外

- 会計・請求処理(既存の会計システムを継続利用)
- 外部ポータルサイトとの連携(次期フェーズで検討)

## 2. 本書の見方

本書では、次の記法で注意書きを区別しています。

> [!NOTE]
> 本書は関係者向けの基本設計書です。用語は「9. 用語集」を参照してください。

> [!TIP]
> 章番号をブラウザでブックマークしておくと、レビュー時に該当箇所へすぐ戻れます。

> [!IMPORTANT]
> 本書の内容は、関連システムの仕様確定後に変更される場合があります。

> [!WARNING] ドラフト版の取り扱い
> 本ドキュメントはレビュー中のドラフト版です。承認前の内容を外部に共有しないでください。

> [!CAUTION]
> 本番環境への設定反映は、影響範囲を確認したうえで実施してください。

## 3. 画面設計

### 3.1 受付一覧画面

受付一覧画面のキャプチャを以下に示します。

![受付一覧画面のキャプチャ](images/基本設計書/screenshot.png){width="480px"}

| 項目 | 内容 |
|---|---|
| 検索条件 | 受付日・対応状況・担当者で絞り込み |
| 一覧表示 | 受付番号・件名・対応状況・担当者・受付日時 |
| 新規登録 | 画面右上の「新規登録」ボタンから登録画面へ遷移 |

詳しい画面遷移は [詳細設計/画面設計.md](詳細設計/画面設計.md) を参照してください。

## 4. 機能一覧

| 機能ID | 機能名 | 概要 | 優先度 |
|---|---|---|---|
| F-001 | 受付登録 | 受付情報を新規登録する | 高 |
| F-002 | 受付一覧 | 条件を指定して受付情報を一覧表示する | 高 |
| F-003 | 対応状況更新 | 未対応・対応中・完了のステータスを更新する | 高 |
| F-004 | 履歴検索 | 過去の受付履歴をキーワードで検索する | 中 |
| F-005 | CSV 出力 | 検索結果を CSV 形式で出力する | 中 |
| F-006 | 利用者管理 | 管理者がログインアカウントを管理する | 低 |

{.full}

## 5. データ設計

受付情報テーブル(\`reception\`)の主な列は次のとおりです。

| 列名 | 型 | 説明 |
|---|---|---|
| id | INTEGER | 主キー |
| title | TEXT | 件名 |
| status | TEXT | 対応状況(未対応 / 対応中 / 完了) |
| assignee | TEXT | 担当者 |
| received_at | DATETIME | 受付日時 |

\`\`\`sql
CREATE TABLE reception (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '未対応',
  assignee TEXT,
  received_at DATETIME NOT NULL
);
\`\`\`

## 6. 処理フロー

受付登録処理の流れを次に示します。

\`\`\`mermaid
graph TD;
  A[受付窓口で申込] --> B[受付情報を入力];
  B --> C{入力内容は正しいか};
  C -- はい --> D[受付登録];
  C -- いいえ --> B;
  D --> E[担当者へ通知];
  E --> F[対応開始];
\`\`\`

## 7. レビュー指摘・強調表示

現在レビュー中の項目は次のとおりです。==未確定=={.mark-text} の項目は次回定例までに確定してください。==参考情報==は黄色のハイライトのみで、対応の要否はありません。

\`\`\`mark
【指摘】次の項目は仕様が未確定のため、実装に着手しないでください。
  - ==画面遷移の詳細==(3.1 節を参照)
  - CSV 出力の文字コード
\`\`\`

## 8. コード例

優先度の判定ロジックの例です。

\`\`\`python
def priority_label(score: int) -> str:
    if score >= 80:
        return "高"
    elif score >= 50:
        return "中"
    return "低"
\`\`\`

## 9. 用語集

用語の定義は [用語集.md](用語集.md) にまとめています。

## 10. 参考資料

> [!LINK]
> 詳細設計は \`詳細設計/\` 配下、議事録は \`議事録/\` 配下を参照してください。

> [!MEMO]
> 本章は暫定版です。正式版公開時に更新します。
`;
  await fs.writeFile(path.join(dir, MAIN_MD), mainMd, 'utf8');

  const glossaryMd = `# 用語集

○○受付管理システムで使用する用語をまとめます。

| 用語 | 説明 |
|---|---|
| 受付 | 窓口またはオンラインで登録される問い合わせ・依頼の単位 |
| 対応状況 | 受付に対する処理の進捗(未対応 / 対応中 / 完了) |
| 担当者 | 受付の処理を担当するスタッフ |
| CSV 出力 | 検索結果を CSV 形式でダウンロードする機能 |

> [!MEMO]
> 用語を追加した場合は、本書とあわせて更新してください。
`;
  await fs.writeFile(path.join(dir, '用語集.md'), glossaryMd, 'utf8');

  const screenDesignMd = `# 画面設計(詳細)

[基本設計書](../基本設計書.md) の 3 章を補足する詳細設計です。

## 画面遷移

\`\`\`mermaid
graph LR;
  A[受付一覧] --> B[受付登録];
  A --> C[受付詳細];
  C --> D[対応状況の更新];
\`\`\`

## 入力項目

| 項目名 | 型 | 必須 | 備考 |
|---|---|---|---|
| 件名 | 文字列(100) | 必須 | 全角・半角混在可 |
| 対応状況 | 選択式 | 必須 | 未対応 / 対応中 / 完了 |
| 担当者 | 選択式 | 任意 | 未割当を許容 |
| 備考 | 文字列(1000) | 任意 | 改行可 |

> [!WARNING]
> 件名は空欄のまま登録できないようにバリデーションしてください。
`;
  await fs.writeFile(path.join(dir, '詳細設計', '画面設計.md'), screenDesignMd, 'utf8');

  const apiDesignMd = `# API 設計(詳細)

内部 API の一覧です。認証は既存の社内 SSO を利用します。

| メソッド | パス | 概要 |
|---|---|---|
| GET | /api/receptions | 受付一覧の取得 |
| POST | /api/receptions | 受付の新規登録 |
| PATCH | /api/receptions/{id} | 対応状況の更新 |
| GET | /api/receptions/export | CSV 出力 |

## レスポンス例

\`\`\`json
{
  "id": 1024,
  "title": "窓口対応の遅延について",
  "status": "対応中",
  "assignee": "田中",
  "receivedAt": "2026-09-10T10:15:00+09:00"
}
\`\`\`

> [!CHECK]
> レスポンスの日時は ISO 8601(タイムゾーン付き)で返却されているか確認してください。
`;
  await fs.writeFile(path.join(dir, '詳細設計', 'API設計.md'), apiDesignMd, 'utf8');

  const minutesMd = `# キックオフ議事録(2026-08-01)

## 出席者

- 企画: 佐藤
- 開発: 鈴木・田中
- 品質保証: 高橋

## 決定事項

- 対象範囲は基本設計書の「1.1 対象範囲」のとおりとする
- 次回レビューは 2026-08-15 とする

> [!QUESTION]
> 既存の紙台帳データの移行範囲(直近何年分か)は未確定。次回までに確認する。
`;
  await fs.writeFile(path.join(dir, '議事録', '2026-08-01_キックオフ.md'), minutesMd, 'utf8');
}

// ---------- 撮影本体 ----------
async function attempt(skipped, name, fn) {
  currentStepLabel = name;
  try {
    await fn();
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m ${name}: ${e.message}`);
    skipped.push(`${name}: ${e.message}`);
  }
}

async function main() {
  if (!existsSync(DIST_HTML)) {
    console.error(`dist/mdpreview.html が見つかりません: ${DIST_HTML}\n先に \`npm run build\` を実行してください。`);
    process.exit(1);
  }
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
    env: browserEnv(),
  });

  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'mdpreview-shots-'));
  const workDir = path.join(tmpBase, WORKSPACE_NAME);
  const skipped = [];
  const allConsoleErrors = [];

  try {
    await fs.mkdir(workDir, { recursive: true });
    await writeSampleWorkspace(browser, workDir);

    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await installFakeFs(context, { rootDir: workDir });
    const page = await context.newPage();
    const consoleErrors = [];
    attachDebugLogging(page, consoleErrors);
    await page.goto(DIST_URL);
    await ensureHooks(page);

    await attempt(skipped, 'start.png', async () => {
      // カードだけだと画面の大半が空白になるので、カードの周囲に少し余白を
      // 残した範囲だけを切り出す。
      const card = await page.evaluate(() => {
        const r = document.querySelector('.start-card').getBoundingClientRect();
        return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
      });
      const pad = 40;
      const clip = {
        x: Math.max(0, card.left - pad),
        y: Math.max(0, card.top - pad),
        width: card.right - card.left + pad * 2,
        height: card.bottom - card.top + pad * 2,
      };
      await shot(page, 'start.png', { clip });
    });

    currentStepLabel = 'open-main-doc';
    await pickFolderAndOpen(page, MAIN_MD);
    await waitForMainDocRendered(page);
    await expandTreeFolder(page, '詳細設計');
    await expandTreeFolder(page, '議事録');
    await waitFor(
      async () =>
        page.evaluate(() => !!Array.from(document.querySelectorAll('#tree .tree-file-row')).find((r) => r.textContent.trim() === '画面設計.md')),
      { message: 'ツリーの「詳細設計」フォルダを展開できませんでした' }
    );

    await attempt(skipped, 'main.png', async () => {
      await page.evaluate(() => window.__mdpreview.setViewMode('both'));
      await shot(page, 'main.png');
    });

    await attempt(skipped, 'alerts.png', async () => {
      // NOTE/TIP/IMPORTANT/WARNING/CAUTION の5個ぶんの高さが既定の 800px を
      // 超えるため、撮影のあいだだけ viewport を縦に広げて下端が切れないようにする。
      await page.setViewportSize({ width: VIEWPORT.width, height: 1500 });
      await sleep(200);
      const clip = await sectionClipRect(page, '2. 本書の見方');
      await shot(page, 'alerts.png', { clip });
      await page.setViewportSize(VIEWPORT);
      await sleep(200);
    });

    await attempt(skipped, 'highlight.png', async () => {
      const clip = await sectionClipRect(page, '7. レビュー指摘・強調表示');
      await shot(page, 'highlight.png', { clip });
    });

    await attempt(skipped, 'paste-menu.png', async () => {
      // 直前のスクロール操作(alerts.png・highlight.png)からの scrollSync が
      // 落ち着くのを待ってから貼り付ける(まれにメニューが出ないことがあるため、
      // 数回まで再試行する)。
      let menuVisible = false;
      for (let i = 0; i < 3 && !menuVisible; i++) {
        await page.click('.cm-content');
        await page.keyboard.press('Control+End');
        await pasteImageAndText(page, 'a\tb\nc\td\n');
        try {
          await waitFor(async () => page.evaluate(() => !!document.querySelector('.mdp-paste-menu')), {
            timeout: 2000,
            message: '貼り付け方法の選択メニューが表示されませんでした',
          });
          menuVisible = true;
        } catch (e) {
          if (i === 2) throw e;
          await sleep(300);
        }
      }
      await shot(page, 'paste-menu.png');
      await page.keyboard.press('Escape'); // 本文を変えずにメニューを閉じる
      await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.mdp-paste-menu'))));
    });

    await attempt(skipped, 'annotator.png', async () => {
      // 直前の操作(貼り付けメニューの確認)でプレビューがスクロールしている
      // ことがあるため、画像を表示領域に戻してからホバーする。
      await page.evaluate(() => {
        const doc = window.__mdpreview.getPreviewDocument();
        const img = doc.querySelector('img');
        if (img) img.scrollIntoView({ block: 'center' });
      });
      await sleep(150);
      await hoverPreviewImage(page);
      await waitFor(
        async () =>
          page.evaluate(() => {
            const btn = window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn');
            return !!btn && btn.style.display !== 'none';
          }),
        { message: '画像編集ボタンが表示されませんでした' }
      );
      await page.evaluate(() => window.__mdpreview.getPreviewDocument().querySelector('.mdpreview-image-edit-btn').click());
      await waitFor(async () => page.evaluate(() => !!document.querySelector('.annotator-svg')), {
        message: '注釈エディタが開きませんでした',
      });

      // 「新規登録」ボタン(x:786-936, y:84-124)を赤枠で囲む。
      await selectAnnotatorTool(page, 'rect');
      await dragOnAnnotator(page, { x: 776, y: 74 }, { x: 946, y: 134 });

      // 一覧の1行目を指す矢印(枠の下辺付近で離すと枠に接続する)。始点(560,470)は
      // 下で作る吹き出しのしっぽの先端と同じ点にして、吹き出し→矢印→赤枠が
      // 一続きに見えるようにする。
      const arrowStart = { x: 560, y: 470 };
      await selectAnnotatorTool(page, 'arrow');
      await dragOnAnnotator(page, arrowStart, { x: 800, y: 136 });

      // 吹き出し(しっぽの先端 → 吹き出し本体の位置、へドラッグする。クリックだけだと
      // 既定オフセットで意図しない向きに尾が伸びるため、明示的にドラッグする)。
      await selectAnnotatorTool(page, 'callout');
      await dragOnAnnotator(page, arrowStart, { x: 360, y: 500 });
      await waitFor(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector('.annotator-text-editor');
            return !!el && el.style.display !== 'none';
          }),
        { message: '吹き出しのテキスト入力欄が表示されませんでした' }
      );
      await page.fill('.annotator-text-editor', 'ここを確認');
      await page.keyboard.press('Escape'); // 入力中のテキストを確定する

      // 作った直後は選択状態(破線枠+ハンドル)のままなので、何もない場所をクリックして
      // 選択を解除してから撮る。
      await clickOnAnnotator(page, { x: 40, y: 40 });
      await waitFor(async () => page.evaluate(() => !document.querySelector('.annotator-selection-outline')), {
        message: '選択が解除されませんでした',
      });
      await sleep(150);

      await shot(page, 'annotator.png');

      // 図形を描いて未保存状態になっているため、キャンセルすると破棄確認ダイアログが出る。
      await page.click('.annotator-toolbar [data-action="cancel"]');
      await waitFor(async () => page.evaluate(() => !!document.querySelector('.annotator-confirm-overlay')), {
        message: '破棄確認ダイアログが表示されませんでした',
      });
      await page.click('.annotator-confirm-overlay [data-action="ok"]');
      await waitFor(async () => !(await page.evaluate(() => !!document.querySelector('.annotator-svg'))), {
        message: '注釈エディタが閉じませんでした',
      });
    });

    await attempt(skipped, 'preview-only.png', async () => {
      await page.evaluate(() => window.__mdpreview.setViewMode('preview'));
      // ファイルツリーのサイドバーを畳んでプレビュー幅を広げる(1160px 未満だと
      // 目次が畳んだ帯で始まってしまい、見た目の確認用としては寂しいため)。
      await page.click('#toggleSidebarBtn');
      await waitFor(async () => page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display === 'none'), {
        message: 'サイドバーが畳めませんでした',
      });
      await waitFor(
        async () => page.evaluate(() => !!window.__mdpreview.getPreviewDocument().querySelector('.mdp-sidetoc')),
        { message: '「プレビューのみ」でサイドバー目次が出ませんでした' }
      );
      await waitFor(
        async () =>
          page.evaluate(() => {
            const nav = window.__mdpreview.getPreviewDocument().querySelector('.mdp-sidetoc');
            return !!nav && getComputedStyle(nav).width !== '36px';
          }),
        { message: '目次が畳んだ帯のままでした' }
      );
      // それまでの操作(alerts.png・highlight.png・注釈エディタで開いた画像)で
      // プレビューが下の方までスクロールしたままのため、文書タイトルが見える
      // 先頭まで戻してから撮る。
      await page.evaluate(() => {
        window.__mdpreview.getPreviewDocument().defaultView.scrollTo(0, 0);
      });
      await sleep(150);
      await shot(page, 'preview-only.png');
      await page.click('#toggleSidebarBtn');
      await page.evaluate(() => window.__mdpreview.setViewMode('both'));
    });

    await attempt(skipped, 'settings.png', async () => {
      await page.click('#settingsBtn');
      await waitFor(async () => page.evaluate(() => document.getElementById('settingsPanel').style.display !== 'none'), {
        message: '設定パネルが開きませんでした',
      });
      await shot(page, 'settings.png');
      await page.click('#settingsCloseBtn');
    });

    // HTML 出力(exportNormal)はステータスバーに「HTML を出力しました」の文言が
    // 残ってしまうため、この main page を使う撮影のいちばん最後に行う
    // (settings.png・preview-only.png にその文言が写り込まないようにするため)。
    await attempt(skipped, 'export-sidetoc.png', async () => {
      await page.evaluate(() => window.__mdpreview.exportNormal());
      const outHtml = path.join(workDir, '基本設計書.html');
      await waitFor(async () => existsSync(outHtml), { message: '基本設計書.html が出力されませんでした' });

      const context2 = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page2 = await context2.newPage();
      const consoleErrors2 = [];
      attachDebugLogging(page2, consoleErrors2);
      try {
        await page2.goto('file://' + outHtml);
        await waitFor(async () => page2.evaluate(() => !!document.querySelector('.mdp-sidetoc')), {
          message: '出力 HTML にサイドバー目次が出ませんでした',
        });
        // 見出しの1つへスクロールし、目次の該当項目が強調された状態を見せる。
        await page2.evaluate(() => {
          const h2s = Array.from(document.querySelectorAll('h2'));
          const target = h2s[2] || h2s[0];
          if (target) target.scrollIntoView({ block: 'start' });
        });
        await sleep(200);
        await shot(page2, 'export-sidetoc.png');
        allConsoleErrors.push(...consoleErrors2.map((e) => '[export-sidetoc] ' + e));
      } finally {
        await context2.close();
      }
    });

    allConsoleErrors.push(...consoleErrors.map((e) => '[main] ' + e));
    await context.close();

    await attempt(skipped, 'single-file.png', async () => {
      const context3 = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await installFakeFs(context3, { rootDir: workDir });
      const page3 = await context3.newPage();
      const consoleErrors3 = [];
      attachDebugLogging(page3, consoleErrors3);
      try {
        await page3.goto(DIST_URL);
        await ensureHooks(page3);
        await page3.evaluate(async () => {
          const root = await window.showDirectoryPicker();
          const fh = await root.getFileHandle('用語集.md');
          await window.__mdpreview.openDroppedHandles([fh]);
        });
        await waitFor(async () => (await page3.evaluate(() => window.__mdpreview.getState())).currentPath === '用語集.md', {
          message: '単体プレビューで用語集.md が開きませんでした',
        });
        await shot(page3, 'single-file.png');
        allConsoleErrors.push(...consoleErrors3.map((e) => '[single-file] ' + e));
      } finally {
        await context3.close();
      }
    });
  } finally {
    await browser.close();
    await fs.rm(tmpBase, { recursive: true, force: true });
  }

  console.log('');
  if (allConsoleErrors.length > 0) {
    console.log(`\x1b[33mコンソールエラーが ${allConsoleErrors.length} 件記録されました:\x1b[0m`);
    for (const e of allConsoleErrors) console.log('  ' + e.split('\n').join('\n  '));
  }
  if (skipped.length > 0) {
    console.log(`\x1b[33mスキップした画像 (${skipped.length}):\x1b[0m`);
    for (const s of skipped) console.log('  - ' + s);
  }
  console.log(`\n完了: docs/images/ に画像を生成しました。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
