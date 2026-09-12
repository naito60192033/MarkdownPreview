#!/usr/bin/env node
// dev/build-annotator-sandbox.mjs
//
// 画像注釈エディタ(src/annotator/)を単体で検証するための開発用ページを esbuild で
// バンドルし、test-output/annotator-sandbox.html に1ファイル化する。
//
// annotator.js は `import annotatorCss from './annotator.css'` のように CSS を
// 文字列として取り込む(esbuild の text ローダー)。アプリ本体(build.mjs)に
// annotator.js を組み込む際も同様に loader: { '.css': 'text' } の指定が必要になる。
//
// 実行: node dev/build-annotator-sandbox.mjs

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SANDBOX_DIR = path.join(__dirname, 'annotator-sandbox');
const OUT_DIR = path.join(REPO_ROOT, 'test-output');
const OUT_FILE = path.join(OUT_DIR, 'annotator-sandbox.html');

async function main() {
  const startedAt = Date.now();

  const jsResult = await build({
    entryPoints: [path.join(SANDBOX_DIR, 'main.js')],
    bundle: true,
    format: 'iife',
    write: false,
    target: ['chrome122'],
    loader: { '.css': 'text' },
    logLevel: 'warning',
  });
  const jsText = jsResult.outputFiles[0].text;

  const template = await readFile(path.join(SANDBOX_DIR, 'index.html'), 'utf8');
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
