// src/app.js
//
// フェーズ0の技術検証用の最小実装。後のフェーズ(1〜)で作り直す前提のため、
// 過剰な作り込みはしない。ここで検証するのは次の4点:
//   1. iframe srcdoc の中身を親から(再読み込みせずに)更新できること
//   2. インライン化した mermaid が SVG を描画できること
//   3. FSA でフォルダを選び、test.md の読み書き・バイナリの読み書きができること
//   4. IndexedDB に保存したフォルダハンドルがページ再読み込み後に復元できること
//
// FSA まわりの実処理は src/fs/workspace.js(task-kanri 同等品質、後のフェーズで
// そのまま再利用する)に委譲する。

import MarkdownIt from 'markdown-it';
import mermaid from 'mermaid';
import {
  pickFolder as fsPickFolder,
  tryRestoreFolder as fsTryRestoreFolder,
  readFile,
  writeFileWithRetry,
} from './fs/workspace.js';

const TEST_FILE = 'test.md';
const IDB_KEY = 'mdpreview-root';

const state = {
  dirHandle: null,
  lastModified: null,
};

// ---------- markdown-it: ```mermaid コードブロックをプレースホルダに変換 ----------
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

let currentMermaidBlocks = [];
const defaultFenceRule =
  md.renderer.rules.fence || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options, env));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().toLowerCase();
  if (info === 'mermaid') {
    const id = 'mermaid-block-' + currentMermaidBlocks.length;
    currentMermaidBlocks.push({ id, src: token.content });
    return `<div class="mermaid-block" id="${id}">図を描画中...</div>`;
  }
  return defaultFenceRule(tokens, idx, options, env, self);
};

function renderMarkdownToHtml(src) {
  currentMermaidBlocks = [];
  const html = md.render(src);
  return { html, mermaidBlocks: currentMermaidBlocks };
}

mermaid.initialize({ startOnLoad: false });
let mermaidRenderSeq = 0;

// ---------- DOM 参照 ----------
let els = {};

function setStatus(text, isError = false) {
  if (!els.status) return;
  els.status.textContent = text;
  els.status.classList.toggle('error', !!isError);
}

// ---------- プレビュー更新 ----------
// iframe の再読み込み(srcdoc の再代入)ではなく、contentDocument.body を
// 直接書き換えることでスクロール位置などを保つ。
async function updatePreview() {
  const src = els.editor.value;
  const { html, mermaidBlocks } = renderMarkdownToHtml(src);
  const doc = els.preview.contentDocument;
  if (!doc || !doc.body) return;
  doc.body.innerHTML = html;

  for (const block of mermaidBlocks) {
    const el = doc.getElementById(block.id);
    if (!el) continue;
    try {
      const renderId = 'mmd-render-' + mermaidRenderSeq++;
      const { svg } = await mermaid.render(renderId, block.src);
      el.innerHTML = svg;
    } catch (e) {
      el.textContent = 'mermaid の描画に失敗しました: ' + (e && e.message ? e.message : String(e));
    }
  }
}

let updateTimer = null;
function scheduleUpdatePreview() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(updatePreview, 150);
}

// ---------- ワークスペース ----------
async function loadTestFile() {
  if (!state.dirHandle) return;
  setStatus('読み込み中...');
  try {
    const file = await readFile(state.dirHandle, TEST_FILE);
    if (file) {
      els.editor.value = await file.text();
      state.lastModified = file.lastModified;
    } else {
      els.editor.value = '';
      state.lastModified = null;
    }
    await updatePreview();
    setStatus(`読込完了: ${TEST_FILE}`);
  } catch (e) {
    console.error(e);
    setStatus('読み込みに失敗しました: ' + e.message, true);
  }
}

async function doPickFolder({ forcePicker = false } = {}) {
  try {
    const handle = await fsPickFolder({ idbKey: IDB_KEY, forcePicker });
    state.dirHandle = handle;
    els.reconnectBtn.style.display = 'none';
    await loadTestFile();
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      setStatus('フォルダの選択に失敗しました: ' + e.message, true);
    }
  }
}

async function doSave() {
  if (!state.dirHandle) {
    setStatus('先にフォルダを選んでください', true);
    return;
  }
  setStatus('保存中...');
  try {
    await writeFileWithRetry(state.dirHandle, TEST_FILE, els.editor.value, {
      expectedLastModified: state.lastModified,
    });
    const file = await readFile(state.dirHandle, TEST_FILE);
    state.lastModified = file ? file.lastModified : null;
    setStatus('保存しました');
  } catch (e) {
    console.error(e);
    setStatus('保存に失敗しました: ' + e.message, true);
  }
}

// ---------- バイナリファイルの読み書き(技術検証用) ----------
// テストコードとのやり取りは base64 文字列で行う(dev/fake-fs.mjs と同じ方式)。
function base64ToBytes(b64) {
  const binary = atob(b64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function writeBinaryFile(name, base64) {
  if (!state.dirHandle) throw new Error('フォルダが選択されていません');
  await writeFileWithRetry(state.dirHandle, name, base64ToBytes(base64));
}

async function readBinaryFileAsBase64(name) {
  if (!state.dirHandle) throw new Error('フォルダが選択されていません');
  const file = await readFile(state.dirHandle, name);
  if (!file) return null;
  const buf = await file.arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

// ---------- 初期化 ----------
function waitForPreviewReady() {
  return new Promise((resolve) => {
    const doc = els.preview.contentDocument;
    if (doc && doc.body) {
      resolve();
      return;
    }
    els.preview.addEventListener('load', () => resolve(), { once: true });
  });
}

async function setup() {
  els = {
    editor: document.getElementById('editor'),
    preview: document.getElementById('preview'),
    pickFolderBtn: document.getElementById('pickFolderBtn'),
    reconnectBtn: document.getElementById('reconnectBtn'),
    saveBtn: document.getElementById('saveBtn'),
    status: document.getElementById('status'),
  };

  els.pickFolderBtn.addEventListener('click', () => doPickFolder({ forcePicker: true }));
  els.reconnectBtn.addEventListener('click', () => doPickFolder({ forcePicker: false }));
  els.saveBtn.addEventListener('click', () => doSave());
  els.editor.addEventListener('input', scheduleUpdatePreview);

  // Ctrl+S / Cmd+S でブラウザの「ページを保存」を抑止し、アプリの保存を実行する。
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    }
  });

  await waitForPreviewReady();
  await updatePreview();

  // 前回のフォルダの復元を試みる(許可済みなら自動で読み込む。要再許可ならボタンを出す)。
  const restore = await fsTryRestoreFolder({ idbKey: IDB_KEY });
  if (restore.ok) {
    state.dirHandle = restore.handle;
    els.reconnectBtn.style.display = 'none';
    await loadTestFile();
  } else if (restore.needsPermission) {
    els.reconnectBtn.style.display = '';
    setStatus('前回のフォルダへの再許可が必要です');
  } else {
    setStatus('フォルダを選んでください');
  }

  // ============================================================
  // E2E テスト用フック。task-kanri の window.__taskkanri と同様、
  // file:// 単独ページで外部からの不正アクセスを想定する必要がないため
  // 無条件で公開する。
  // ============================================================
  window.__mdpreview = {
    get state() {
      return { hasDir: !!state.dirHandle, lastModified: state.lastModified };
    },
    pickFolder: (opts) => doPickFolder(opts || {}),
    tryRestoreFolder: () => fsTryRestoreFolder({ idbKey: IDB_KEY }),
    save: () => doSave(),
    getEditorText: () => els.editor.value,
    setEditorText: (text) => {
      els.editor.value = text;
      return updatePreview();
    },
    updatePreview: () => updatePreview(),
    getPreviewBodyHtml: () => els.preview.contentDocument.body.innerHTML,
    getPreviewSvgCount: () => els.preview.contentDocument.querySelectorAll('svg').length,
    writeBinaryFile,
    readBinaryFileAsBase64,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setup().catch((e) => console.error(e));
  });
} else {
  setup().catch((e) => console.error(e));
}
