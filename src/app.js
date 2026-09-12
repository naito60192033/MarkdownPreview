// src/app.js
//
// アプリ全体のオーケストレーション。各モジュール(エディタ・プレビュー・ツリー・
// 監視・設定パネル等)を組み立て、ワークスペースの選択からファイルの
// 開く/保存/外部変更の取り込みまでを1箇所で配線する。
//
// localStorage のキーはすべて `mdpreview.` 接頭辞を付ける(file:// では
// task-kanri と保存領域を共有するため)。

import { createEditor } from './editor.js';
import { createPreview } from './ui/preview.js';
import { createTree } from './ui/tree.js';
import { createStartScreen } from './ui/start.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createConflictModal } from './ui/conflict-modal.js';
import { createNotifyBar } from './ui/notify-bar.js';
import { createStatusBar } from './ui/statusbar.js';
import { createResizer } from './ui/resizer.js';
import { createImageEdit } from './ui/image-edit.js';
import { createWatcher } from './watch.js';
import { createScrollSync } from './scroll-sync.js';
import { attachImagePasteAndDrop } from './paste.js';
import { exportNormal, exportStandalone } from './export.js';
import { loadSettings } from './settings.js';
import { renderDocument, collectHeadingsFor } from './render/pipeline.js';
import { updateTocBlocks } from './render/toc.js';
import { ensurePermission, readTextByPath, writeByPath, ConflictError } from './fs/workspace.js';
import { rememberRoot, reconnectRoot, checkRootPermission } from './fs/recent-roots.js';

const LAST_ROOT_ID_KEY = 'mdpreview.lastRootId';
const VIEW_MODE_KEY = 'mdpreview.viewMode';

const state = {
  root: null,
  rootId: null,
  currentPath: null,
  currentCssPath: null,
  lastModified: null,
  // 開いた md の元の改行コード('\n' か '\r\n')。CodeMirror は読み込み時に CRLF を
  // LF へ正規化するため、保存時にこの値へ復元する(下記 doSave 参照)。
  eol: '\n',
  dirty: false,
  saving: false,
  // 保存の開始時・終了時に増やす世代番号(レビュー指摘: 変更検知と保存の競合対策)。
  // watch.js の確認処理はこの値を使い、開始時から変わっていれば結果を捨てる。
  writeGeneration: 0,
  suppressChangeEvents: false,
  lineMap: [],
  deps: [], // 現在の @import 先(ルート相対パス)。変わったら watcher の登録を入れ替える
  settings: loadSettings(),
};

let els = {};
let editor, preview, tree, watcher, scrollSync, imageEdit;
let startScreen, settingsPanel, conflictModal, notifyBar, statusbar, resizer;

// ---------- localStorage ヘルパー ----------
function lastFileKey(rootId) {
  return `mdpreview.lastFile.${rootId}`;
}
function getLastFilePath(rootId) {
  try {
    return localStorage.getItem(lastFileKey(rootId));
  } catch {
    return null;
  }
}
function setLastFile(rootId, path) {
  try {
    localStorage.setItem(lastFileKey(rootId), path);
  } catch {
    /* noop */
  }
}

function getHashFile() {
  const m = /^#file=(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
function setHashFile(path) {
  history.replaceState(null, '', '#file=' + encodeURIComponent(path));
}

// ---------- DOM 参照 ----------
function cacheEls() {
  els = {
    startScreen: document.getElementById('startScreen'),
    pickFolderBtn: document.getElementById('pickFolderBtn'),
    reconnectBtn: document.getElementById('reconnectBtn'),
    recentRootsSection: document.getElementById('recentRootsSection'),
    recentRootsList: document.getElementById('recentRootsList'),
    startError: document.getElementById('startError'),

    appScreen: document.getElementById('appScreen'),
    toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
    workspaceName: document.getElementById('workspaceName'),
    viewModeBtns: Array.from(document.querySelectorAll('.view-mode-btn')),
    saveBtn: document.getElementById('saveBtn'),
    exportBtn: document.getElementById('exportBtn'),
    exportMenu: document.getElementById('exportMenu'),
    exportNormalBtn: document.getElementById('exportNormalBtn'),
    exportStandaloneBtn: document.getElementById('exportStandaloneBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    switchFolderBtn: document.getElementById('switchFolderBtn'),

    notifyBar: document.getElementById('notifyBar'),
    notifyBarText: document.getElementById('notifyBarText'),
    notifyReloadBtn: document.getElementById('notifyReloadBtn'),
    notifyDismissBtn: document.getElementById('notifyDismissBtn'),

    mainArea: document.getElementById('mainArea'),
    treeContainer: document.getElementById('tree'),
    editorPane: document.getElementById('editorPane'),
    editorHost: document.getElementById('editorHost'),
    previewResizer: document.getElementById('previewResizer'),
    previewPane: document.getElementById('previewPane'),
    preview: document.getElementById('preview'),

    statusPath: document.getElementById('statusPath'),
    statusSaved: document.getElementById('statusSaved'),
    statusMessage: document.getElementById('statusMessage'),

    settingsPanel: document.getElementById('settingsPanel'),
    settingsCloseBtn: document.getElementById('settingsCloseBtn'),
    settingPollEnabled: document.getElementById('settingPollEnabled'),
    settingPollInterval: document.getElementById('settingPollInterval'),
    settingCssPath: document.getElementById('settingCssPath'),
    settingAlertTitleNote: document.getElementById('settingAlertTitleNote'),
    settingAlertTitleTip: document.getElementById('settingAlertTitleTip'),
    settingAlertTitleImportant: document.getElementById('settingAlertTitleImportant'),
    settingAlertTitleWarning: document.getElementById('settingAlertTitleWarning'),
    settingAlertTitleCaution: document.getElementById('settingAlertTitleCaution'),

    conflictModal: document.getElementById('conflictModal'),
    conflictCancelBtn: document.getElementById('conflictCancelBtn'),
    conflictReloadBtn: document.getElementById('conflictReloadBtn'),
    conflictOverwriteBtn: document.getElementById('conflictOverwriteBtn'),
  };
}

// ---------- 画面切り替え ----------
function showAppScreen() {
  els.startScreen.style.display = 'none';
  els.appScreen.style.display = '';
  if (resizer) resizer.reapply();
}

// ---------- 未保存の確認 ----------
async function confirmDiscardIfDirty() {
  if (!state.dirty) return true;
  return window.confirm('保存されていない変更があります。破棄して続けますか?');
}

// ---------- 表示状態(ファイルパス・保存状態・タイトル) ----------
function syncDirtyUi() {
  const mark = state.dirty ? '● ' : '';
  statusbar.setPath(mark + (state.currentPath || ''));
  statusbar.setSaved(state.dirty);
  const name = state.currentPath ? state.currentPath.split('/').pop() : '';
  document.title = name ? `${mark}${name} — Markdown Preview` : 'Markdown Preview';
}

// ---------- @import 先(deps)の監視登録 ----------
// renderDocument() が返す deps(現在の描画で取り込んだファイル)を watcher に
// 登録する。前回から無くなったものは解除し、新しく増えたものだけ登録する
// (既に監視中のものを毎回登録し直すと lastModified の追跡がリセットされてしまう
// ため)。
function updateDepsWatch(nextDeps, initialLastModifiedByPath) {
  const next = nextDeps || [];
  const nextSet = new Set(next);
  for (const dep of state.deps) {
    if (!nextSet.has(dep)) watcher.unwatch(dep);
  }
  for (const dep of next) {
    if (!state.deps.includes(dep)) {
      const initial = initialLastModifiedByPath && initialLastModifiedByPath.has(dep) ? initialLastModifiedByPath.get(dep) : null;
      watcher.watch(dep, () => scheduleRender(true), initial);
    }
  }
  state.deps = next;
}

function unwatchAllDeps() {
  for (const dep of state.deps) watcher.unwatch(dep);
  state.deps = [];
}

// ---------- レンダリング(300ms デバウンス) ----------
let renderTimer = null;
let renderSeq = 0; // 描画ごとの連番(レビュー指摘: 描画の順序の保証に使う)
function scheduleRender(immediate = false) {
  clearTimeout(renderTimer);
  if (immediate) return doRender();
  return new Promise((resolve, reject) => {
    renderTimer = setTimeout(() => {
      doRender().then(resolve, reject);
    }, 300);
  });
}

async function doRender() {
  if (!state.root || !state.currentPath) return;
  const text = editor.getText();
  const mySeq = ++renderSeq;
  const depLastModified = new Map();
  const { html, lineMap, deps } = await renderDocument(text, {
    path: state.currentPath,
    alertTitles: state.settings.alertTitles,
    readText: async (relPath) => {
      const r = await readTextByPath(state.root, relPath);
      if (r) depLastModified.set(relPath, r.lastModified);
      return r ? r.text : null;
    },
  });
  // @import の読み込みで非同期になる分、先に始めた描画が後から解決して古い内容で
  // 上書きすることがある(レビュー指摘)。自分より新しい描画が既に始まっていたら、
  // この結果は使わずに破棄する。
  if (mySeq !== renderSeq) return;
  state.lineMap = lineMap;
  updateDepsWatch(deps, depLastModified);
  await preview.render({ html, lineMap, root: state.root, mdPath: state.currentPath });
}

// ---------- エディタの変更 ----------
function handleEditorChange() {
  if (state.suppressChangeEvents) return;
  if (!state.dirty) {
    state.dirty = true;
    syncDirtyUi();
  }
  scheduleRender(false);
}

function setEditorTextSilently(text, { preserveCursor = true } = {}) {
  state.suppressChangeEvents = true;
  editor.setText(text, { preserveCursor });
  state.suppressChangeEvents = false;
}

// ---------- ファイルを開く ----------
async function openFile(path, { updateHash = true } = {}) {
  if (!(await confirmDiscardIfDirty())) return false;
  let result;
  try {
    result = await readTextByPath(state.root, path);
  } catch (e) {
    statusbar.setMessage('開けませんでした: ' + ((e && e.message) || String(e)), { isError: true });
    return false;
  }
  if (!result) {
    statusbar.setMessage('ファイルが見つかりません: ' + path, { isError: true });
    return false;
  }

  if (state.currentPath) watcher.unwatch(state.currentPath);
  unwatchAllDeps();
  state.currentPath = path;
  state.lastModified = result.lastModified;
  state.dirty = false;
  // CodeMirror は読み込み時に CRLF を LF へ正規化してしまう(editor.getText() は
  // 常に LF になる)ため、元の改行コードを別途覚えておき、保存時に復元する
  // (レビュー指摘: ソース書き込み型 TOC の保存で CRLF のファイルの改行が壊れる問題)。
  state.eol = result.text.includes('\r\n') ? '\r\n' : '\n';
  setEditorTextSilently(result.text, { preserveCursor: false });
  watcher.watch(path, handleMdExternalChange, result.lastModified);
  tree.setActivePath(path);
  syncDirtyUi();
  if (updateHash) setHashFile(path);
  setLastFile(state.rootId, path);
  await scheduleRender(true);
  scrollSync.attachPreviewScrollListener();
  return true;
}

async function reloadCurrentFile() {
  if (!state.currentPath) return;
  let result;
  try {
    result = await readTextByPath(state.root, state.currentPath);
  } catch (e) {
    statusbar.setMessage('再読込に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
    return;
  }
  if (!result) {
    statusbar.setMessage('ファイルが見つかりません: ' + state.currentPath, { isError: true });
    return;
  }
  setEditorTextSilently(result.text, { preserveCursor: true });
  state.lastModified = result.lastModified;
  state.dirty = false;
  state.eol = result.text.includes('\r\n') ? '\r\n' : '\n';
  watcher.setLastModified(state.currentPath, result.lastModified);
  syncDirtyUi();
  await scheduleRender(true);
}

// ---------- 外部変更の取り込み ----------
function handleMdExternalChange(info) {
  if (info.missing) {
    statusbar.setMessage('ディスク上のファイルが見つからなくなりました: ' + info.path, { isError: true });
    return;
  }
  if (!state.dirty) {
    setEditorTextSilently(info.text, { preserveCursor: true });
    state.lastModified = info.lastModified;
    state.eol = info.text.includes('\r\n') ? '\r\n' : '\n';
    scheduleRender(true);
    statusbar.setMessage('外部の変更を取り込みました');
  } else {
    notifyBar.show('ディスク上のファイルが更新されました', { onReload: () => reloadCurrentFile() });
  }
}

// ---------- style.css の読み込みと監視 ----------
async function loadCssAndWatch() {
  const cssPath = state.settings.cssPath;
  if (state.currentCssPath && state.currentCssPath !== cssPath) {
    watcher.unwatch(state.currentCssPath);
  }
  state.currentCssPath = cssPath;

  let result = null;
  try {
    result = await readTextByPath(state.root, cssPath);
  } catch {
    /* noop (存在しない場合は空扱い) */
  }
  preview.setUserCss(result ? result.text : '');
  watcher.watch(
    cssPath,
    (info) => {
      preview.setUserCss(info.text || '');
    },
    result ? result.lastModified : null
  );
}

// ---------- 保存直前のソース書き込み型 TOC 更新 ----------
// 展開後のテキストから見出しを集め、updateTocBlocks() で `<!-- @import "[TOC]" -->`
// ブロックを再生成する(MPE と同じ動作)。変わった場合だけエディタの内容を
// 置き換える(カーソル位置はできるだけ保つ)。失敗しても保存自体は続行する。
async function applySourceTocUpdate(text) {
  if (!state.currentPath) return text;
  let headings;
  try {
    headings = await collectHeadingsFor(text, {
      path: state.currentPath,
      alertTitles: state.settings.alertTitles,
      readText: async (relPath) => {
        const r = await readTextByPath(state.root, relPath);
        return r ? r.text : null;
      },
    });
  } catch {
    return text;
  }
  const updated = updateTocBlocks(text, headings);
  // 見出しの収集(@import 先の読み込みで非同期)の間に入力があった場合は、エディタを
  // 書き換えない(入力を消さないため)。保存するのは updated で、エディタは未保存のまま残る。
  if (updated !== text && editor.getText() === text) {
    setEditorTextSilently(updated, { preserveCursor: true });
  }
  return updated;
}

// ---------- 保存 ----------
// 保存が終わった後の状態更新。保存処理の最中(SMB では数百 ms〜数秒かかる)に入力された
// 変更は保存されていないので、エディタの内容が保存した内容と違えば未保存のままにする。
function markSaved(lastModified, savedLf) {
  state.lastModified = lastModified;
  state.dirty = editor.getText() !== savedLf;
  watcher.setLastModified(state.currentPath, lastModified);
  syncDirtyUi();
}

async function doSave() {
  if (!state.root || !state.currentPath) return;
  if (state.saving) return; // レビュー指摘: 保存中の再実行(二重 Ctrl+S)は無視する
  // state.saving は await をまたぐ前に同期的に立てる(これより後に await を挟むと、
  // ほぼ同時に呼ばれた2回目の doSave() がこのチェックをすり抜けてしまうため)。
  state.saving = true;
  state.writeGeneration++; // 保存開始(watch.js の確認処理との競合対策)
  let text = editor.getText();
  let savedLf = text; // 実際に保存する内容(LF)。markSaved() でエディタの内容と比べる
  try {
    text = await applySourceTocUpdate(text);
    savedLf = text;
    // CodeMirror 内部では常に LF なので、元が CRLF だったファイルはここで戻す
    // (レビュー指摘: ソース書き込み型 TOC の更新で改行コードが壊れないようにする)。
    if (state.eol === '\r\n') text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    statusbar.setMessage('保存中...');
    const lastModified = await writeByPath(state.root, state.currentPath, text, {
      expectedLastModified: state.lastModified,
    });
    markSaved(lastModified, savedLf);
    statusbar.setMessage('保存しました');
  } catch (e) {
    if (e instanceof ConflictError || (e && e.name === 'ConflictError')) {
      const choice = await conflictModal.open();
      if (choice === 'overwrite') {
        try {
          const lastModified = await writeByPath(state.root, state.currentPath, text, {});
          markSaved(lastModified, savedLf);
          statusbar.setMessage('上書き保存しました');
        } catch (e2) {
          statusbar.setMessage('保存に失敗しました: ' + ((e2 && e2.message) || String(e2)), { isError: true });
        }
      } else if (choice === 'reload') {
        await reloadCurrentFile();
        statusbar.setMessage('破棄して再読込しました');
      }
      // cancel: 何もしない
    } else {
      statusbar.setMessage('保存に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
    }
  } finally {
    state.saving = false;
    state.writeGeneration++; // 保存終了
  }
}

// ---------- HTML 出力 ----------
function closeExportMenu() {
  els.exportMenu.style.display = 'none';
}

async function doExport(kind) {
  closeExportMenu();
  if (!state.root || !state.currentPath) return;
  await scheduleRender(true); // 最新の内容で出力する
  const args = {
    root: state.root,
    mdPath: state.currentPath,
    doc: preview.getDocument(),
    wrapperEl: preview.getWrapperElement(),
  };
  try {
    if (kind === 'normal') {
      const { path } = await exportNormal(args);
      statusbar.setMessage('HTML を出力しました: ' + path);
    } else {
      const { path, failedImageCount } = await exportStandalone(args);
      statusbar.setMessage(
        failedImageCount > 0
          ? `HTML(1ファイル)を出力しました: ${path}(埋め込めなかった画像: ${failedImageCount}件)`
          : 'HTML(1ファイル)を出力しました: ' + path
      );
    }
  } catch (e) {
    statusbar.setMessage('HTML 出力に失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
  }
}

// ---------- ワークスペースの切り替え ----------
async function activateRoot(handle, rootId) {
  state.root = handle;
  state.rootId = rootId;
  try {
    localStorage.setItem(LAST_ROOT_ID_KEY, rootId);
  } catch {
    /* noop */
  }
  showAppScreen();
  els.workspaceName.textContent = handle.name;
  await tree.setRoot(handle);
  watcher.start();
  await loadCssAndWatch();

  const hashPath = getHashFile();
  const lastFilePath = hashPath || getLastFilePath(rootId);
  if (lastFilePath) {
    await openFile(lastFilePath, { updateHash: !hashPath });
  }
}

async function pickFolderFlow() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mdpreview-root' });
  if (!(await ensurePermission(handle))) {
    throw new Error('書き込み許可が得られませんでした');
  }
  const rootId = await rememberRoot(handle);
  await activateRoot(handle, rootId);
}

async function openRecentFlow(id) {
  const handle = await reconnectRoot(id);
  if (!handle) throw new Error('許可が得られませんでした');
  await activateRoot(handle, id);
}

// ---------- 表示モード ----------
function setViewMode(mode) {
  els.viewModeBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.viewMode === mode));
  els.mainArea.classList.remove('view-editor-only', 'view-preview-only');
  if (mode === 'editor') els.mainArea.classList.add('view-editor-only');
  if (mode === 'preview') els.mainArea.classList.add('view-preview-only');
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    /* noop */
  }
}

// ---------- 設定の変更 ----------
function handleSettingsChange(newSettings) {
  const cssPathChanged = newSettings.cssPath !== state.settings.cssPath;
  const alertTitlesChanged = JSON.stringify(newSettings.alertTitles) !== JSON.stringify(state.settings.alertTitles);
  state.settings = newSettings;
  watcher.reschedule();
  if (cssPathChanged && state.root) {
    loadCssAndWatch();
  }
  if (alertTitlesChanged && state.currentPath) {
    scheduleRender(true);
  }
}

// ---------- 静的な UI の配線 ----------
function bindStaticUi() {
  els.toggleSidebarBtn.addEventListener('click', () => {
    els.mainArea.classList.toggle('sidebar-collapsed');
  });

  els.viewModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.viewMode));
  });
  let savedViewMode = 'both';
  try {
    savedViewMode = localStorage.getItem(VIEW_MODE_KEY) || 'both';
  } catch {
    /* noop */
  }
  setViewMode(savedViewMode);

  els.saveBtn.addEventListener('click', () => doSave());

  els.exportBtn.addEventListener('click', () => {
    els.exportMenu.style.display = els.exportMenu.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!els.exportMenu || els.exportMenu.style.display === 'none') return;
    if (e.target === els.exportBtn || els.exportMenu.contains(e.target)) return;
    closeExportMenu();
  });
  els.exportNormalBtn.addEventListener('click', () => doExport('normal'));
  els.exportStandaloneBtn.addEventListener('click', () => doExport('standalone'));

  els.switchFolderBtn.addEventListener('click', async () => {
    if (!(await confirmDiscardIfDirty())) return;
    try {
      await pickFolderFlow();
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        statusbar.setMessage('フォルダの切り替えに失敗しました: ' + ((e && e.message) || String(e)), { isError: true });
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  resizer = createResizer({
    handle: els.previewResizer,
    leftPane: els.editorPane,
    container: els.mainArea,
    storageKey: 'mdpreview.editorWidthRatio',
    min: 240,
  });
}

// ---------- 初期化 ----------
async function setup() {
  cacheEls();

  editor = createEditor({ parent: els.editorHost, doc: '', onChange: handleEditorChange });
  preview = createPreview({ iframe: els.preview, onOpenMdLink: (path) => openFile(path) });
  preview.init();
  await preview.whenReady();

  attachImagePasteAndDrop({
    view: editor.view,
    getRoot: () => state.root,
    getMdPath: () => state.currentPath,
    setStatusMessage: (text, opts) => statusbar.setMessage(text, opts),
  });

  scrollSync = createScrollSync({
    editor,
    getPreviewRoot: () => preview.getScrollContext(),
    getLineMap: () => state.lineMap,
  });

  tree = createTree({ container: els.treeContainer, onOpenFile: (path) => openFile(path) });

  watcher = createWatcher({
    getRoot: () => state.root,
    getSettings: () => state.settings,
    isWriting: () => state.saving,
    getWriteGeneration: () => state.writeGeneration,
  });

  imageEdit = createImageEdit({
    preview,
    getRoot: () => state.root,
    getMdPath: () => state.currentPath,
    getEditorText: () => editor.getText(),
    replaceEditorText: (next) => {
      setEditorTextSilently(next, { preserveCursor: true });
      state.dirty = true;
      syncDirtyUi();
    },
    setStatusMessage: (text, opts) => statusbar.setMessage(text, opts),
    requestRerender: () => scheduleRender(true),
  });
  imageEdit.attach();

  notifyBar = createNotifyBar({
    container: els.notifyBar,
    textEl: els.notifyBarText,
    reloadBtn: els.notifyReloadBtn,
    dismissBtn: els.notifyDismissBtn,
  });

  statusbar = createStatusBar({
    pathEl: els.statusPath,
    savedEl: els.statusSaved,
    messageEl: els.statusMessage,
  });

  conflictModal = createConflictModal({
    overlay: els.conflictModal,
    overwriteBtn: els.conflictOverwriteBtn,
    reloadBtn: els.conflictReloadBtn,
    cancelBtn: els.conflictCancelBtn,
  });

  settingsPanel = createSettingsPanel({
    overlay: els.settingsPanel,
    openBtn: els.settingsBtn,
    closeBtn: els.settingsCloseBtn,
    pollEnabledInput: els.settingPollEnabled,
    pollIntervalInput: els.settingPollInterval,
    cssPathInput: els.settingCssPath,
    alertTitleInputs: {
      note: els.settingAlertTitleNote,
      tip: els.settingAlertTitleTip,
      important: els.settingAlertTitleImportant,
      warning: els.settingAlertTitleWarning,
      caution: els.settingAlertTitleCaution,
    },
    onChange: handleSettingsChange,
  });

  startScreen = createStartScreen({
    screenEl: els.startScreen,
    pickFolderBtn: els.pickFolderBtn,
    reconnectBtn: els.reconnectBtn,
    recentSection: els.recentRootsSection,
    recentList: els.recentRootsList,
    errorEl: els.startError,
    onPickFolder: pickFolderFlow,
    onOpenRecent: openRecentFlow,
  });

  bindStaticUi();
  syncDirtyUi();

  let lastRootId = null;
  try {
    lastRootId = localStorage.getItem(LAST_ROOT_ID_KEY);
  } catch {
    /* noop */
  }
  if (lastRootId) {
    const check = await checkRootPermission(lastRootId);
    if (check.ok) {
      await activateRoot(check.handle, lastRootId);
      exposeTestHooks();
      return;
    }
  }
  await startScreen.show();
  exposeTestHooks();
}

// ---------- E2E テスト用フック ----------
function exposeTestHooks() {
  window.__mdpreview = {
    pickFolder: () => pickFolderFlow(),
    openRecent: (id) => openRecentFlow(id),
    openFile: (path) => openFile(path),
    save: () => doSave(),
    reloadCurrentFile: () => reloadCurrentFile(),
    exportNormal: () => doExport('normal'),
    exportStandalone: () => doExport('standalone'),

    getEditorText: () => editor.getText(),
    setEditorText: (text) => {
      editor.setText(text, { preserveCursor: false });
      return scheduleRender(true);
    },

    getState: () => ({
      hasRoot: !!state.root,
      currentPath: state.currentPath,
      dirty: state.dirty,
      lastModified: state.lastModified,
      deps: state.deps.slice(),
      writeGeneration: state.writeGeneration,
    }),

    getPreviewDocument: () => preview.getDocument(),
    getStatusMessage: () => els.statusMessage.textContent,
    getStatusPath: () => els.statusPath.textContent,

    isNotifyBarVisible: () => els.notifyBar.style.display !== 'none',
    clickNotifyReload: () => els.notifyReloadBtn.click(),
    clickNotifyDismiss: () => els.notifyDismissBtn.click(),

    isConflictModalVisible: () => els.conflictModal.style.display !== 'none',
    resolveConflict: (choice) => {
      if (choice === 'overwrite') els.conflictOverwriteBtn.click();
      else if (choice === 'reload') els.conflictReloadBtn.click();
      else els.conflictCancelBtn.click();
    },

    setViewMode: (mode) => setViewMode(mode),
    getViewMode: () => {
      try {
        return localStorage.getItem(VIEW_MODE_KEY) || 'both';
      } catch {
        return 'both';
      }
    },

    getSettings: () => state.settings,
    getTitle: () => document.title,

    // レビュー指摘1(変更検知と保存の競合)の回帰テスト専用。確認処理(watcher の
    // checkAll)を開始してからその読み込みが発行されるのを待ち、fake-fs の delay
    // をリセットしたうえで保存を行う。確認処理の結果(遅れて到着する)が保存後の
    // 内容を古い内容で上書きしないことを検証できる。
    simulateStaleWatchDuringSave: async ({ delayMs = 600, newText, settleWaitMs = 150 } = {}) => {
      if (window.__fakeFs) await window.__fakeFs.setDelay({ read: delayMs });
      const checkPromise = watcher.checkAll();
      await new Promise((r) => setTimeout(r, settleWaitMs));
      if (window.__fakeFs) await window.__fakeFs.setDelay({ read: 0 });
      if (typeof newText === 'string') {
        editor.setText(newText, { preserveCursor: false });
      }
      await doSave();
      await checkPromise;
      return { dirty: state.dirty, text: editor.getText() };
    },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setup().catch((e) => console.error(e));
  });
} else {
  setup().catch((e) => console.error(e));
}
