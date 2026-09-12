// src/ui/tree.js
//
// 左側のファイルツリー。フォルダを開いたときに初めて中身を読む(遅延読み込み)。
// 表示するのはフォルダと .md / .markdown だけ。フォルダが先、ファイルが後、
// それぞれ日本語順(localeCompare('ja'))。ドットで始まるものは隠す。
// 開いているファイルは .active クラスで強調する。

import { extname, joinPath } from '../fs/paths.js';

function isVisibleMarkdown(name) {
  const ext = extname(name);
  return ext === '.md' || ext === '.markdown';
}

/**
 * @param {{ container: HTMLElement, onOpenFile: (path: string) => void }} opts
 */
export function createTree({ container, onOpenFile }) {
  let currentPath = null;

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

  function buildFileRow(fileHandle, path) {
    const li = document.createElement('li');
    li.className = 'tree-file';
    const row = document.createElement('div');
    row.className = 'tree-row tree-file-row';
    row.tabIndex = 0;
    row.textContent = fileHandle.name;
    row.dataset.path = path;
    if (path === currentPath) row.classList.add('active');
    row.addEventListener('click', () => {
      if (typeof onOpenFile === 'function') onOpenFile(path);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (typeof onOpenFile === 'function') onOpenFile(path);
      }
    });
    li.appendChild(row);
    return li;
  }

  function buildDirRow(dirHandle, path) {
    const li = document.createElement('li');
    li.className = 'tree-dir';
    const row = document.createElement('div');
    row.className = 'tree-row tree-dir-row';
    row.tabIndex = 0;

    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    caret.textContent = '▶';
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = dirHandle.name;
    row.appendChild(caret);
    row.appendChild(label);
    li.appendChild(row);

    const childUl = document.createElement('ul');
    childUl.className = 'tree-children';
    childUl.hidden = true;
    li.appendChild(childUl);

    let loaded = false;
    async function toggle() {
      const isOpen = !childUl.hidden;
      if (isOpen) {
        childUl.hidden = true;
        caret.textContent = '▶';
        return;
      }
      childUl.hidden = false;
      caret.textContent = '▼';
      if (!loaded) {
        loaded = true;
        await renderDir(dirHandle, path, childUl);
      }
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
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
    for (const dir of entries.dirs) {
      ulEl.appendChild(buildDirRow(dir, joinPath(dirPath, dir.name)));
    }
    for (const file of entries.files) {
      ulEl.appendChild(buildFileRow(file, joinPath(dirPath, file.name)));
    }
  }

  async function setRoot(root) {
    container.innerHTML = '';
    if (!root) return;
    const rootUl = document.createElement('ul');
    rootUl.className = 'tree-root';
    container.appendChild(rootUl);
    await renderDir(root, '', rootUl);
  }

  function setActivePath(path) {
    currentPath = path;
    container.querySelectorAll('.tree-file-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.path === path);
    });
  }

  return { setRoot, setActivePath };
}
