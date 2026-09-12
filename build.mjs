#!/usr/bin/env node
// build.mjs
//
// src/app.js(ESM)・src/app.css を esbuild でバンドルし、src/index.html の
// プレースホルダに <style> / <script> として埋め込んで dist/mdpreview.html を
// 1 ファイルとして出力する。Node もサーバも使わない file:// 運用が前提のため、
// 動的 import・chunk 分割・import.meta が出力に残っていないことをビルド時に
// 検証する。
//
// 実行: node build.mjs (= npm run build)

import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');
const OUT_FILE = path.join(DIST_DIR, 'mdpreview.html');

async function main() {
  const startedAt = Date.now();

  // ---------- JS: ESM エントリを IIFE・minify でバンドル ----------
  // `supported: { 'inline-script': true }` を明示しておく(esbuild のデフォルトも
  // true 相当だが、将来のデフォルト変更に左右されないよう固定する)。この設定により
  // 文字列/正規表現リテラル中に現れる "</script" は "<\/script" にエスケープされ、
  // HTML パーサが <script> の終端と誤認しないようになる。
  const jsResult = await build({
    entryPoints: [path.join(SRC_DIR, 'app.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    target: ['chrome122'],
    legalComments: 'none',
    supported: { 'inline-script': true },
    logLevel: 'warning',
    // src/theme/base.css は iframe 内の <style> に流し込む JS 文字列として
    // 扱う(このアプリ本体の CSS ではないため、'css' ローダーで別出力に
    // 分離させず 'text' として1つの JS 出力にまとめる)。
    loader: { '.css': 'text' },
  });
  const jsText = jsResult.outputFiles[0].text;

  // ---------- CSS: @import を解決してバンドル ----------
  // JS と同様、'inline-style' を明示して "</style" のエスケープを固定する。
  const cssResult = await build({
    entryPoints: [path.join(SRC_DIR, 'app.css')],
    bundle: true,
    minify: true,
    write: false,
    supported: { 'inline-style': true },
    logLevel: 'warning',
  });
  const cssText = cssResult.outputFiles[0].text;

  // ---------- 出力の安全性検証 ----------
  assertScriptSafe(jsText, 'JS');
  assertScriptSafe(cssText, 'CSS');
  assertNoDoubleEscape(jsText);
  assertNoDynamicImport(jsText);

  // ---------- テンプレートへ埋め込み ----------
  const template = await readFile(path.join(SRC_DIR, 'index.html'), 'utf8');
  if (!template.includes('<!--@inline-css-->')) {
    throw new Error('index.html に <!--@inline-css--> プレースホルダが見つかりません');
  }
  if (!template.includes('<!--@inline-js-->')) {
    throw new Error('index.html に <!--@inline-js--> プレースホルダが見つかりません');
  }
  // 置換元の文字列を関数として渡す。String.replace() は置換文字列が普通の
  // 文字列だと "$&" などのドル記号パターンを特殊展開してしまい、バンドル後の
  // JS/CSS 側にたまたま含まれる "$&"(例: KaTeX のエラー整形コード)を巻き込んで
  // 出力を破壊してしまう。関数を渡せばその戻り値がそのまま挿入されるため安全。
  const html = template
    .replace('<!--@inline-css-->', () => `<style>\n${cssText}\n</style>`)
    .replace('<!--@inline-js-->', () => `<script>\n${jsText}\n</script>`);

  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(OUT_FILE, html, 'utf8');

  const elapsedMs = Date.now() - startedAt;
  const sizeBytes = Buffer.byteLength(html, 'utf8');
  console.log(`build: ${path.relative(__dirname, OUT_FILE)}`);
  console.log(`  size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MiB (${sizeBytes.toLocaleString()} bytes)`);
  console.log(`  time: ${elapsedMs} ms`);
}

// バンドル後の本文に生の "</script"(大文字小文字を問わず)が残っていないかを検査する。
// これが1つでも残っていると、HTML パーサがその位置で <script> を終端してしまい
// 以降のコードが実行されない。esbuild の inline-script/inline-style エスケープに
// 任せきりにせず、ビルドの最終防衛線としてここでも必ず確認する。
function assertScriptSafe(text, label) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf('</script');
  if (idx !== -1) {
    const around = text.slice(Math.max(0, idx - 40), idx + 40);
    throw new Error(
      `build failed: バンドル後の ${label} に "</script" が含まれています (index ${idx})\n  周辺: ${around}`
    );
  }
}

// HTML の script 本文では、"<!--" の後に "<script" が現れると "double escaped" 状態に入り、
// 本物の閉じタグ </script> がその状態を抜けるだけに使われてスクリプトが終端されなくなる
// (以降の文書全体がスクリプト扱いになる)。esbuild は "</script" しかエスケープしないため、
// 両方が同時に含まれる場合はビルドを止める。"<!--" 単独は無害(現状 mermaid/KaTeX 由来で数件ある)。
function assertNoDoubleEscape(jsText) {
  if (jsText.includes('<!--') && /<script[\s/>]/i.test(jsText)) {
    throw new Error(
      'build failed: バンドル後の JS に "<!--" と "<script" が両方含まれています。' +
        'HTML パーサが script を正しく終端できなくなるため、該当箇所を確認してください'
    );
  }
}

// file:// の 1 ファイルで完結させるため、動的 import・import.meta・chunk 分割が
// 出力に残っていないことを確認する。mermaid は診断図の種類ごとに動的 import を
// 使うが、code splitting を伴わない iife 出力へバンドルすると esbuild が
// 静的に解決してバンドル内へ埋め込むため、通常は残らない(build.mjs 実行時の
// ログでも 0 件であることを確認済み)。
function assertNoDynamicImport(jsText) {
  if (/\bimport\s*\(/.test(jsText)) {
    throw new Error('build failed: バンドル後の JS に動的 import( が残っています(file:// では chunk を取得できません)');
  }
  if (jsText.includes('import.meta')) {
    throw new Error('build failed: バンドル後の JS に import.meta が残っています');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
