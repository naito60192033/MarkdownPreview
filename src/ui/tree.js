// src/ui/tree.js
//
// 左側のファイルツリー。フォルダを開いたときに初めて中身を読む(遅延読み込み)。
// 表示するのはフォルダと .md / .markdown だけ。フォルダが先、ファイルが後、
// それぞれ日本語順(localeCompare('ja'))。ドットで始まるものは隠す。
// 開いているファイルは .active クラスで強調する。
//
// 開いているフォルダのパス集合(openPaths)を持っており、refresh()(外部変更の
// 取り込みやファイル操作後の再読み込み)は開いていたフォルダを開いたまま再描画する。
// reveal(path) は祖先フォルダを開いて再描画し、対象の行までスクロールする。
//
// ファイル操作(新規作成・名前の変更・削除)の入口として、行または余白の右クリックで
// onContextMenu({ kind: 'file' | 'dir' | 'root', path, x, y })、行にフォーカスがある
// 状態での F2 / Delete で onKeyAction({ action: 'rename' | 'delete', kind, path }) を呼ぶ。

import { extname, joinPath } from '../fs/paths.js';

function isVisibleMarkdown(name) {
  const ext = extname(name);
  return ext === '.md' || ext === '.markdown';
}

/**
 * @param {{ container: HTMLElement, onOpenFile: (path: string) => void,
 *           onContextMenu?: (info: { kind: string, path: string, x: number, y: number }) => void,
 *           onKeyAction?: (info: { action: string, kind: string, path: string }) => void }} opts
 */
export function createTree({ container, onOpenFile, onContextMenu, onKeyAction }) {
  let currentPath = null;
  let rootHandle = null;
  // 開いている(展開している)フォルダのルート相対パスの集合。refresh() はこれを
  // 保ったまま再描画し、setRoot()(ワークスペースの切り替え)はリセットする。
  let openPaths = new Set();

  async function listEntries(dirHandle) {
    const dirs = [];
    const files = [];
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        dirs.push(entry);
      } else if (isVisibleMarkdown(entry.name)) {
        files.push(entry);
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    files.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return { dirs, files };
  }

  function fireContextMenu(e, kind, path) {
    e.preventDefault();
    if (typeof onContextMenu === 'function') onContextMenu({ kind, path, x: e.clientX, y: e.clientY });
  }

  function buildFileRow(fileHandle, path) {
    const li = document.createElement('li');
    li.className = 'tree-file';
    const row = document.createElement('div');
    row.className = 'tree-row tree-file-row';
    row.tabIndex = 0;
    row.textContent = fileHandle.name;
    row.dataset.path = path;
    row.dataset.kind = 'file';
    if (path === currentPath) row.classList.add('active');
    row.addEventListener('click', () => {
      if (typeof onOpenFile === 'function') onOpenFile(path);
    });
    row.addEventListener('contextmenu', (e) => fireContextMenu(e, 'file', path));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (typeof onOpenFile === 'function') onOpenFile(path);
      } else if (e.key === 'F2') {
        e.preventDefault();
        if (typeof onKeyAction === 'function') onKeyAction({ action: 'rename', kind: 'file', path });
      } else if (e.key === 'Delete') {
        e.preventDefault();
        if (typeof onKeyAction === 'function') onKeyAction({ action: 'delete', kind: 'file', path });
      }
    });
    li.appendChild(row);
    return li;
  }

  function buildDirRow(dirHandle, path, pending) {
    const li = document.createElement('li');
    li.className = 'tree-dir';
    const row = document.createElement('div');
    row.className = 'tree-row tree-dir-row';
    row.tabIndex = 0;
    row.dataset.path = path;
    row.dataset.kind = 'dir';

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = dirHandle.name;
    row.appendChild(caret);
    row.appendChild(label);
    li.appendChild(row);

    const childUl = document.createElement('ul');
    childUl.className = 'tree-children';
    li.appendChild(childUl);

    // キャレットは #i-chev(右向き矢印)の SVG を使い、開いているときは
    // row に is-open を付けて CSS の transform: rotate(90deg) で下向きに回す
    // (src/index.html の SVG スプライト参照)。
    caret.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#i-chev"/></svg>';
    let loaded = false;
    const openAtBuild = openPaths.has(path);
    row.classList.toggle('is-open', openAtBuild);
    childUl.hidden = !openAtBuild;
    if (openAtBuild) {
      loaded = true;
      // 開いたままのフォルダの中身。renderDir() が兄弟と並行して待つ(refresh() / reveal() が
      // 返った時点で、開いているフォルダの中身まで描画し終わっているようにするため)。
      pending.push(renderDir(dirHandle, path, childUl));
    }

    async function openDir() {
      openPaths.add(path);
      childUl.hidden = false;
      row.classList.add('is-open');
      if (!loaded) {
        loaded = true;
        await renderDir(dirHandle, path, childUl);
      }
    }
    function closeDir() {
      openPaths.delete(path);
      childUl.hidden = true;
      row.classList.remove('is-open');
    }
    async function toggle() {
      if (childUl.hidden) await openDir();
      else closeDir();
    }
    row.addEventListener('click', toggle);
    row.addEventListener('contextmenu', (e) => fireContextMenu(e, 'dir', path));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'F2') {
        e.preventDefault();
        if (typeof onKeyAction === 'function') onKeyAction({ action: 'rename', kind: 'dir', path });
      } else if (e.key === 'Delete') {
        e.preventDefault();
        if (typeof onKeyAction === 'function') onKeyAction({ action: 'delete', kind: 'dir', path });
      }
    });

    return li;
  }

  async function renderDir(dirHandle, dirPath, ulEl) {
    ulEl.innerHTML = '';
    let entries;
    try {
      entries = await listEntries(dirHandle);
    } catch (e) {
      const li = document.createElement('li');
      li.className = 'tree-error';
      li.textContent = 'フォルダを読み込めませんでした: ' + ((e && e.message) || String(e));
      ulEl.appendChild(li);
      return;
    }
    const pending = [];
    for (const dir of entries.dirs) {
      ulEl.appendChild(buildDirRow(dir, joinPath(dirPath, dir.name), pending));
    }
    for (const file of entries.files) {
      ulEl.appendChild(buildFileRow(file, joinPath(dirPath, file.name)));
    }
    await Promise.all(pending);
  }

  // 新しいツリーは DOM の外で組み立て終えてから差し替える(SMB で一覧に時間がかかっても
  // ツリーが空になって点滅しないように)。refresh() が重なったときは、後から始めたものだけを
  // 反映する(先に始めた描画が後から終わって古い内容で上書きしないように)。
  let renderSeq = 0;
  async function renderRoot() {
    const mySeq = ++renderSeq;
    if (!rootHandle) {
      container.innerHTML = '';
      return;
    }
    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    await renderDir(rootHandle, '', rootUl);
    if (mySeq !== renderSeq) return;
    container.replaceChildren(rootUl);
  }

  async function setRoot(root) {
    rootHandle = root;
    openPaths = new Set();
    await renderRoot();
  }

  /** 開いていたフォルダを開いたまま再描画する(外部変更の取り込み・ファイル操作後の更新用)。 */
  async function refresh() {
    if (!rootHandle) return;
    await renderRoot();
  }

  /** 祖先フォルダを開いて再描画し、対象の行までスクロールする。 */
  async function reveal(path) {
    if (!rootHandle || !path) return;
    const segs = path.split('/');
    segs.pop(); // 最後の区切りは対象自身の名前なので、祖先だけ開く
    let acc = '';
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      openPaths.add(acc);
    }
    await refresh();
    for (const row of container.querySelectorAll('.tree-row')) {
      if (row.dataset.path === path) {
        row.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }

  /** 名前を変更したフォルダの配下にある openPaths を新しいパスへ付け替える。 */
  function renamed(oldPath, newPath) {
    const next = new Set();
    for (const p of openPaths) {
      if (p === oldPath) next.add(newPath);
      else if (p.startsWith(`${oldPath}/`)) next.add(newPath + p.slice(oldPath.length));
      else next.add(p);
    }
    openPaths = next;
  }

  /** 削除したフォルダの配下にある openPaths を取り除く。 */
  function removed(path) {
    for (const p of Array.from(openPaths)) {
      if (p === path || p.startsWith(`${path}/`)) openPaths.delete(p);
    }
  }

  function setActivePath(path) {
    currentPath = path;
    container.querySelectorAll('.tree-file-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.path === path);
    });
  }

  // 行の上ならその行、余白なら kind: 'root' で通知する。
  container.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) return; // 行自身のハンドラ(fireContextMenu)に任せる
    e.preventDefault();
    if (typeof onContextMenu === 'function') onContextMenu({ kind: 'root', path: '', x: e.clientX, y: e.clientY });
  });

  return { setRoot, setActivePath, refresh, reveal, renamed, removed };
}
