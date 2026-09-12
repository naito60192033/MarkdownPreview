// src/ui/resizer.js
//
// 2つのペインの境界をドラッグして幅を変えられるようにする汎用のリサイザー。
// leftPane の幅を px 固定(flex-basis)にして左右比率を決め、rightPane 側は
// flex:1 で残りを埋める前提。比率は localStorage に保存し、次回起動時にも復元する。

export function createResizer({ handle, leftPane, container, storageKey, min = 200, max = null, defaultRatio = 0.5 }) {
  function applyRatio(ratio) {
    const width = container.clientWidth;
    if (!width) return;
    let px = width * ratio;
    px = Math.max(min, px);
    if (max != null) px = Math.min(max, px);
    leftPane.style.flex = `0 0 ${px}px`;
  }

  function loadRatio() {
    let raw = null;
    try {
      raw = storageKey ? localStorage.getItem(storageKey) : null;
    } catch {
      /* noop */
    }
    const ratio = raw ? Number(raw) : defaultRatio;
    return Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : defaultRatio;
  }

  function saveRatio(ratio) {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(ratio));
    } catch {
      /* noop */
    }
  }

  let dragging = false;

  function onMouseMove(e) {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const ratio = Math.min(0.9, Math.max(0.1, px / rect.width));
    applyRatio(ratio);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    const rect = container.getBoundingClientRect();
    const px = leftPane.getBoundingClientRect().width;
    if (rect.width > 0) saveRatio(Math.min(0.9, Math.max(0.1, px / rect.width)));
  }

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  applyRatio(loadRatio());

  return {
    // コンテナのサイズが変わった後(サイドバー開閉など)に再適用したいとき用。
    reapply() {
      applyRatio(loadRatio());
    },
    destroy() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    },
  };
}
