// src/ui/conflict-modal.js
//
// 保存時に競合(ConflictError: 読み込んだ後にディスク上のファイルが他で
// 更新されていた)が起きたときの確認モーダル。「上書き保存 / 破棄して再読込 /
// キャンセル」の3択を返す。

export function createConflictModal({ overlay, overwriteBtn, reloadBtn, cancelBtn }) {
  let resolver = null;

  function open() {
    return new Promise((resolve) => {
      resolver = resolve;
      overlay.style.display = '';
    });
  }

  function close(result) {
    overlay.style.display = 'none';
    const r = resolver;
    resolver = null;
    if (r) r(result);
  }

  overwriteBtn.addEventListener('click', () => close('overwrite'));
  reloadBtn.addEventListener('click', () => close('reload'));
  cancelBtn.addEventListener('click', () => close('cancel'));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close('cancel');
  });

  return { open };
}
