// src/ui/notify-bar.js
//
// 「ディスク上のファイルが更新されました」のような一時的な通知バー。
// [再読込] [無視] の2ボタンで構成する。

export function createNotifyBar({ container, textEl, reloadBtn, dismissBtn }) {
  let onReload = null;

  function show(message, { onReload: reloadHandler } = {}) {
    textEl.textContent = message;
    onReload = reloadHandler || null;
    reloadBtn.style.display = onReload ? '' : 'none';
    container.style.display = '';
  }

  function hide() {
    container.style.display = 'none';
    onReload = null;
  }

  reloadBtn.addEventListener('click', () => {
    const handler = onReload;
    hide();
    if (handler) handler();
  });
  dismissBtn.addEventListener('click', () => hide());

  return { show, hide };
}
