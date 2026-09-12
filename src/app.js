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
import { createWatcher } from './watch.js';
import { createScrollSync } from './scroll-sync.js';
import { loadSettings } from './settings.js';
import { renderDocument } from './render/pipeline.js';
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
  dirty: false,
  saving: false,
  suppressChangeEvents: false,
  lineMap: [],
  settings: loadSettings(),
};

let els = {};
let editor, preview, tree, watcher, scrollSync;
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

// ---------- レンダリング(300ms デバウンス) ----------
let renderTimer = null;
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
  const { html, lineMap } = await renderDocument(text, {
    path: state.currentPath,
    readText: async (relPath) => {
      const r = await readTextByPath(state.root, relPath);
      return r ? r.text : null;
    },
  });
  state.lineMap = lineMap;
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
  state.currentPath = path;
  state.lastModified = result.lastModified;
  state.dirty = false;
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

// ---------- 保存 ----------
async function doSave() {
  if (!state.root || !state.currentPath) return;
  const text = editor.getText();
  statusbar.setMessage('保存中...');
  state.saving = true;
  try {
    const lastModified = await writeByPath(state.root, state.currentPath, text, {
      expectedLastModified: state.lastModified,
    });
    state.lastModified = lastModified;
    state.dirty = false;
    watcher.setLastModified(state.currentPath, lastModified);
    syncDirtyUi();
    statusbar.setMessage('保存しました');
  } catch (e) {
    if (e instanceof ConflictError || (e && e.name === 'ConflictError')) {
      const choice = await conflictModal.open();
      if (choice === 'overwrite') {
        try {
          const lastModified = await writeByPath(state.root, state.currentPath, text, {});
          state.lastModified = lastModified;
          state.dirty = false;
          watcher.setLastModified(state.currentPath, lastModified);
          syncDirtyUi();
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
  state.settings = newSettings;
  watcher.reschedule();
  if (cssPathChanged && state.root) {
    loadCssAndWatch();
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
  });

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
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setup().catch((e) => console.error(e));
  });
} else {
  setup().catch((e) => console.error(e));
}
