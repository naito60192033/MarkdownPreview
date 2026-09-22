// src/ui/start.js
//
// 起動画面: 「フォルダを選ぶ」「前回のフォルダを再許可」、最近使ったフォルダの一覧。
// requestPermission はユーザ操作(クリック)のハンドラの中で呼ぶ必要があるため、
// ここでは各ボタンの click ハンドラの中で直接 FSA 呼び出しに繋がるコールバックを
// 呼び出す(呼び出し側の app.js が実際の showDirectoryPicker / 再許可を行う)。

import { listRecentRoots, checkRootPermission, forgetRoot } from '../fs/recent-roots.js';

/**
 * @param {{ screenEl: HTMLElement, pickFolderBtn: HTMLElement, reconnectBtn: HTMLElement,
 *           recentSection: HTMLElement, recentList: HTMLElement, errorEl: HTMLElement,
 *           onPickFolder: () => Promise<void>, onOpenRecent: (id: string) => Promise<void> }} opts
 */
export function createStartScreen({
  screenEl,
  pickFolderBtn,
  reconnectBtn,
  recentSection,
  recentList,
  errorEl,
  onPickFolder,
  onOpenRecent,
}) {
  function showError(message) {
    if (!message) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      return;
    }
    errorEl.style.display = '';
    errorEl.textContent = message;
  }

  async function refreshRecentList() {
    const roots = await listRecentRoots();
    recentList.innerHTML = '';
    if (roots.length === 0) {
      recentSection.style.display = 'none';
      return;
    }
    recentSection.style.display = '';
    for (const r of roots) {
      const li = document.createElement('li');
      li.className = 'recent-root-item';

      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'recent-root-name';
      nameBtn.textContent = r.name;
      nameBtn.addEventListener('click', async () => {
        showError('');
        try {
          await onOpenRecent(r.id);
        } catch (e) {
          showError('開けませんでした: ' + ((e && e.message) || String(e)));
        }
      });

      const forgetBtn = document.createElement('button');
      forgetBtn.type = 'button';
      forgetBtn.className = 'recent-root-forget';
      forgetBtn.title = '一覧から削除';
      forgetBtn.innerHTML = '<svg class="icon icon-sm" viewBox="0 0 24 24"><use href="#i-x"/></svg>';
      forgetBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await forgetRoot(r.id);
        await refreshRecentList();
      });

      li.appendChild(nameBtn);
      li.appendChild(forgetBtn);
      recentList.appendChild(li);
    }
  }

  async function refreshReconnectVisibility() {
    const roots = await listRecentRoots();
    if (roots.length === 0) {
      reconnectBtn.style.display = 'none';
      return;
    }
    const check = await checkRootPermission(roots[0].id);
    reconnectBtn.style.display = check.ok ? 'none' : '';
  }

  pickFolderBtn.addEventListener('click', async () => {
    showError('');
    try {
      await onPickFolder();
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        showError('フォルダを選べませんでした: ' + ((e && e.message) || String(e)));
      }
    }
  });

  reconnectBtn.addEventListener('click', async () => {
    showError('');
    try {
      const roots = await listRecentRoots();
      if (roots.length === 0) return;
      await onOpenRecent(roots[0].id);
    } catch (e) {
      showError('再許可できませんでした: ' + ((e && e.message) || String(e)));
    }
  });

  async function show() {
    screenEl.style.display = '';
    showError('');
    await Promise.all([refreshRecentList(), refreshReconnectVisibility()]);
  }

  function hide() {
    screenEl.style.display = 'none';
  }

  return { show, hide, refreshRecentList };
}
