#!/usr/bin/env node
// dev/build-paste-demo.mjs
//
// 貼り付けの改善(画像/テキスト/表の選択・保存中表示・表の整形)を実機(Windows +
// Excel)で試すためのデモページを esbuild で単体バンドルし、
// test-output/paste-demo.html に1ファイル化する。dev/build-annotator-sandbox.mjs
// と同じ方式(bundle + iife + text ローダーで .css を文字列化 + プレースホルダ差し替え)。
//
// dev/paste-demo/main.js は `import pasteUiCss from '../../src/paste-ui.css'`
// (src/paste-ui.js 経由)のように CSS を文字列として取り込む(esbuild の text
// ローダー)。アプリ本体(build.mjs)に組み込む際も loader: { '.css': 'text' } が必要。
//
// 実行: node dev/build-paste-demo.mjs (= npm run build:paste-demo)
// npm test には含めない(実機確認用のデモであり、CI 的な自動テスト対象ではないため)。

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO_DIR = path.join(__dirname, 'paste-demo');
const OUT_DIR = path.join(REPO_ROOT, 'test-output');
const OUT_FILE = path.join(OUT_DIR, 'paste-demo.html');

async function main() {
  const startedAt = Date.now();

  const jsResult = await build({
    entryPoints: [path.join(DEMO_DIR, 'main.js')],
    bundle: true,
    format: 'iife',
    write: false,
    target: ['chrome122'],
    loader: { '.css': 'text' },
    logLevel: 'warning',
  });
  const jsText = jsResult.outputFiles[0].text;

  const template = await readFile(path.join(DEMO_DIR, 'index.html'), 'utf8');
  if (!template.includes('<!--@inline-js-->')) {
    throw new Error('index.html に <!--@inline-js--> プレースホルダが見つかりません');
  }
  const html = template.replace('<!--@inline-js-->', () => `<script>\n${jsText}\n</script>`);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, html, 'utf8');

  const elapsedMs = Date.now() - startedAt;
  const sizeBytes = Buffer.byteLength(html, 'utf8');
  console.log(`build: ${path.relative(REPO_ROOT, OUT_FILE)}`);
  console.log(`  size: ${(sizeBytes / 1024).toFixed(1)} KiB`);
  console.log(`  time: ${elapsedMs} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
