// dev/paste-demo/main.js
//
// 貼り付けの改善(画像/テキスト/表の選択・保存中表示・表の整形)を実機(Windows +
// Excel)で試すためのデモページのエントリポイント。dev/build-paste-demo.mjs で
// test-output/paste-demo.html に1ファイル化してブラウザで直接開く。
//
// ここで書いているエディタの貼り付け処理は、そのままアプリ本体(src/paste.js)に
// 組み込む予定の本物のロジック(デモ用に画像の保存先だけメモリ上の Blob URL に
// 差し替えている)。src/paste-ui.js(保存中プレースホルダー・選択メニュー)・
// src/md-table.js(表の変換・整形)も同様にアプリ本体で使う想定の本物のモジュール。
//
// このデモはファイルの読み書きを一切行わない(貼り付けた画像は Blob として
// メモリに保持するだけ)。file:// でダブルクリックして開ける。

import { keymap } from '@codemirror/view';
import MarkdownIt from 'markdown-it';
import { createEditor } from '../../src/editor.js';
import { savingPlaceholderExtension, addSavingPlaceholder, takeSavingPlaceholder, showPasteChoiceMenu } from '../../src/paste-ui.js';
import { isTsvTable, tsvToMarkdownTable, formatMarkdownTables, wrapBlockForInsert } from '../../src/md-table.js';

const INITIAL_DOC = `# 貼り付けの動作デモ

このエディタに Excel からコピーしたセルや画像を貼り付けて試せます。

## サンプルの表(列がずれています)

|項目|値|説明|
|:--|--:|:-:|
|名前|山田太郎|フルネーム|
|年齢|28|満年齢|
|部署|開発|所属部署|
`;

// ---------- 状態 ----------
const state = {
  imageBlobUrls: new Map(), // 'image-1.png' -> blob URL
  imageSerial: 1,
  saving: false,
};

function getPasteMode() {
  return document.getElementById('pasteModeSelect').value; // 'choice' | 'image' | 'text'
}

function getSaveDelayMs() {
  return Number(document.getElementById('saveDelaySelect').value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- ステータスバー(4秒で消える。src/ui/statusbar.js と同じ作法) ----------
const statusBarEl = document.getElementById('statusBar');
let statusTimer = null;
function setStatusMessage(text, { isError = false, timeoutMs = 4000 } = {}) {
  clearTimeout(statusTimer);
  statusBarEl.textContent = text || '';
  statusBarEl.classList.toggle('error', !!isError);
  if (text && timeoutMs) {
    statusTimer = setTimeout(() => {
      statusBarEl.textContent = '';
    }, timeoutMs);
  }
}

// ---------- markdown-it によるプレビュー ----------
const md = new MarkdownIt({ html: true, breaks: true });
const previewHost = document.getElementById('previewHost');

function renderPreview(text) {
  const html = md.render(text);
  // images/demo/image-N.png への参照を、デモ内で保持している Blob URL に差し替える。
  const withImages = html.replace(/src="images\/demo\/([^"]+)"/g, (whole, name) => {
    const url = state.imageBlobUrls.get(name);
    return url ? `src="${url}"` : whole;
  });
  previewHost.innerHTML = withImages;
}

// ---------- クリップボードの中身パネル ----------
const clipboardEmptyEl = document.getElementById('clipboardEmpty');
const clipboardMetaEl = document.getElementById('clipboardMeta');
const clipboardTableEl = document.getElementById('clipboardTable');
const clipboardTableBodyEl = document.getElementById('clipboardTableBody');

// 直前に押されたキー(Ctrl+V / Ctrl+Shift+V)を paste イベントに紐付けるための記録。
// 実際のキー操作で貼り付けられたときだけ埋まり、合成イベントの dispatch では
// 直前の keydown が無いため「(不明)」のままになる。
let lastPasteKeyLabel = null;
document.addEventListener(
  'keydown',
  (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      lastPasteKeyLabel = e.shiftKey ? 'Ctrl+Shift+V' : 'Ctrl+V';
    }
  },
  true
);

function describeClipboardItem(data, item, index) {
  if (item.kind === 'file') {
    const file = item.getAsFile();
    const info = file ? `${file.name || '(無名のファイル)'}(${file.size.toLocaleString()} bytes)` : '(取得できず)';
    return { index: index + 1, kind: item.kind, type: item.type, info };
  }
  const str = data.getData(item.type) || '';
  const preview = str.length > 60 ? str.slice(0, 60) + '…' : str;
  return { index: index + 1, kind: item.kind, type: item.type, info: `${str.length}文字: ${preview}` };
}

// 貼り付けイベントの中身をパネルに記録する。location は「エディタ」「注釈エディタ相当」。
function recordClipboard(location, e) {
  const data = e.clipboardData;
  const items = data ? Array.from(data.items) : [];
  const keyLabel = lastPasteKeyLabel || '(不明。プログラムからの貼り付けなど)';
  lastPasteKeyLabel = null;

  clipboardEmptyEl.style.display = 'none';
  clipboardMetaEl.style.display = '';
  clipboardTableEl.style.display = '';
  clipboardMetaEl.textContent = `貼り付け先: ${location} / 押したキー: ${keyLabel}`;

  clipboardTableBodyEl.innerHTML = '';
  const rows = items.map((item, i) => describeClipboardItem(data, item, i));
  for (const row of rows) {
    const tr = document.createElement('tr');
    // 貼り付け内容(type・内容)は外部由来の文字列なので innerHTML は使わず textContent で組み立てる。
    for (const value of [row.index, row.kind, row.type, row.info]) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.appendChild(td);
    }
    clipboardTableBodyEl.appendChild(tr);
  }

  return { data, items };
}

// ---------- エディタ ----------
const editor = createEditor({
  parent: document.getElementById('editorHost'),
  doc: INITIAL_DOC,
  onChange: (text) => renderPreview(text),
  extensions: [
    savingPlaceholderExtension(),
    keymap.of([
      {
        key: 'Alt-Shift-f',
        run: () => {
          formatTables();
          return true;
        },
      },
    ]),
  ],
});
const view = editor.view;
renderPreview(INITIAL_DOC);

function isImageItem(item) {
  return !!item && typeof item.type === 'string' && item.type.startsWith('image/');
}

// 画像ファイル(File の配列)を、選択範囲の先頭(pos)から1つずつ保存する。
// 保存中は addSavingPlaceholder の表示を出し、疑似の保存時間だけ待ってから
// images/demo/image-N.png への参照を挿入する。
async function pasteImages(files, pos) {
  let insertAt = pos;
  for (const file of files) {
    const placeholderId = addSavingPlaceholder(view, insertAt);
    state.saving = true;
    try {
      await delay(getSaveDelayMs());
      const name = `image-${state.imageSerial++}.png`;
      state.imageBlobUrls.set(name, URL.createObjectURL(file));

      const resolvedPos = takeSavingPlaceholder(view, placeholderId);
      if (resolvedPos == null) continue; // 通常は起きない(表示が既に消えている)
      const insertText = `![](images/demo/${name})\n`;
      view.dispatch({
        changes: { from: resolvedPos, to: resolvedPos, insert: insertText },
        selection: { anchor: resolvedPos + insertText.length },
      });
      insertAt = resolvedPos + insertText.length;
      setStatusMessage('画像を保存しました');
    } finally {
      state.saving = false;
    }
  }
}

function pasteText(text) {
  view.dispatch({ ...view.state.replaceSelection(text), userEvent: 'input.paste' });
}

// 前後の段落・表とつながらないよう、必要なら空行を挟んで挿入する(wrapBlockForInsert)。
function pasteTable(text) {
  const sel = view.state.selection.main;
  const insert = wrapBlockForInsert(view.state.doc.toString(), sel.from, sel.to, tsvToMarkdownTable(text));
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
    userEvent: 'input.paste',
  });
}

function formatTables() {
  const result = formatMarkdownTables(view.state.doc.toString());
  if (result.count === 0) {
    setStatusMessage('整形が必要な表はありません');
    return;
  }
  view.dispatch({ changes: result.changes });
  setStatusMessage(`表を${result.count}個整形しました`);
}
document.getElementById('formatTablesBtn').addEventListener('click', formatTables);

// エディタへの貼り付け(paste はキャプチャ段階で受ける。src/paste.js と同じ作法)。
view.dom.addEventListener(
  'paste',
  (e) => {
    recordClipboard('エディタ', e);
    const data = e.clipboardData;
    if (!data) return;

    const images = [];
    for (const item of data.items || []) {
      if (item.kind === 'file' && isImageItem(item)) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
    if (images.length === 0) return; // 画像が無ければ CodeMirror の既定動作(テキスト)に任せる

    if (state.saving) {
      e.preventDefault();
      setStatusMessage('前の画像を保存中です。保存が終わってから貼り付けてください', { isError: true });
      return;
    }

    e.preventDefault();
    const pos = view.state.selection.main.from;
    const text = data.getData('text/plain');
    const hasText = !!text && text.trim() !== '';
    const mode = getPasteMode();

    if (!hasText || mode === 'image') {
      pasteImages(images, pos);
      return;
    }
    if (mode === 'text') {
      pasteText(text);
      return;
    }

    // mode === 'choice': 画像・テキスト・(タブ区切りなら)表から選ばせる
    const choices = [
      { id: 'image', label: '画像で貼り付け' },
      { id: 'text', label: 'テキストで貼り付け' },
    ];
    if (isTsvTable(text)) choices.push({ id: 'table', label: '表(Markdown)で貼り付け' });
    showPasteChoiceMenu({ view, pos, choices }).then((choice) => {
      if (choice === 'image') pasteImages(images, pos);
      else if (choice === 'text') pasteText(text);
      else if (choice === 'table') pasteTable(text);
      // null(取り消し)なら何もしない
    });
  },
  true
);

view.dom.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    e.preventDefault();
  }
});

view.dom.addEventListener('drop', (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || files.length === 0) return;
  const images = Array.from(files).filter((f) => isImageItem(f));
  if (images.length === 0) return;
  e.preventDefault();
  if (state.saving) {
    setStatusMessage('前の画像を保存中です。保存が終わってから貼り付けてください', { isError: true });
    return;
  }
  const coords = view.posAtCoords({ x: e.clientX, y: e.clientY });
  const pos = coords == null ? view.state.selection.main.from : coords;
  pasteImages(images, pos);
});

// ---------- 「注釈エディタと同じ条件で試す」枠 ----------
// 現行の src/annotator/annotator.js の _pasteHandler と同じロジック
// (type が image/ で始まる最初の項目を選び、kind を問わず getAsFile() する)。
function currentAnnotatorPasteResult(items) {
  const item = items.find((it) => it.type && it.type.startsWith('image/'));
  if (!item) return { ok: false, text: '× 失敗(画像の項目がありません)' };
  const file = item.getAsFile();
  if (!file) return { ok: false, text: `× 失敗(${item.kind}:${item.type} を選んだため画像を取り出せない)` };
  return { ok: true, text: `○ 成功(${item.type})`, file };
}

// 修正後の処理: kind が file かつ type が image/ の最初の項目だけを選ぶ。
function fixedPasteResult(items) {
  const item = items.find((it) => it.kind === 'file' && it.type && it.type.startsWith('image/'));
  if (!item) return { ok: false, text: '× クリップボードに画像がありません' };
  const file = item.getAsFile();
  if (!file) return { ok: false, text: '× 失敗(画像を取り出せない)' };
  return { ok: true, text: '○ 成功', file };
}

const annotatorLikeArea = document.getElementById('annotatorLikeArea');
const annotatorLikeCurrentEl = document.getElementById('annotatorLikeCurrent');
const annotatorLikeFixedEl = document.getElementById('annotatorLikeFixed');
const annotatorLikeThumbEl = document.getElementById('annotatorLikeThumb');

annotatorLikeArea.addEventListener('paste', (e) => {
  e.preventDefault();
  const { items } = recordClipboard('注釈エディタ相当', e);

  const current = currentAnnotatorPasteResult(items);
  annotatorLikeCurrentEl.textContent = `今の注釈エディタの処理: ${current.text}`;

  const fixed = fixedPasteResult(items);
  annotatorLikeFixedEl.textContent = `修正後の処理: ${fixed.text}`;

  if (fixed.ok && fixed.file) {
    annotatorLikeThumbEl.src = URL.createObjectURL(fixed.file);
    annotatorLikeThumbEl.style.display = '';
  } else {
    annotatorLikeThumbEl.style.display = 'none';
  }
});

// harness(Playwright)からの操作用に、最小限のフックだけ公開する。
window.__pasteDemo = {
  getEditorText() {
    return view.state.doc.toString();
  },
  getPreviewHtml() {
    return previewHost.innerHTML;
  },
};
