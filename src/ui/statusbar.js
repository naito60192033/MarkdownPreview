// src/ui/statusbar.js
//
// 下部のステータスバー: ファイルパス・保存状態・一時的なメッセージ。

export function createStatusBar({ pathEl, savedEl, messageEl }) {
  let messageTimer = null;

  function setPath(path) {
    pathEl.textContent = path || '';
  }

  function setSaved(dirty) {
    savedEl.textContent = dirty ? '未保存の変更があります' : '保存済み';
    savedEl.classList.toggle('dirty', !!dirty);
  }

  function setMessage(text, { isError = false, timeoutMs = 4000 } = {}) {
    clearTimeout(messageTimer);
    messageEl.textContent = text || '';
    messageEl.classList.toggle('error', !!isError);
    if (text && timeoutMs) {
      messageTimer = setTimeout(() => {
        messageEl.textContent = '';
      }, timeoutMs);
    }
  }

  return { setPath, setSaved, setMessage };
}
