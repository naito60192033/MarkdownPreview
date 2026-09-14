// src/ui/resizer.js
//
// 2つのペインの境界をドラッグして幅を変えられるようにする汎用のリサイザー。
// 左ペインの幅は container に対する比率(0.1〜0.9)で持ち、CSS 変数
// `--resizer-ratio` として container に設定する(左ペインの flex-basis は CSS 側で
// この変数から % で決める。src/app.css の .editor-pane)。% 指定なので、ウィンドウの
// 幅やサイドバーの開閉が変わっても再計算は要らない。最小幅は CSS の min-width に任せる。
//
// container は「左ペイン・ハンドル・右ペイン」だけを包む要素にすること(サイドバー等を
// 含めると、ドラッグ位置と境界がその分ずれる)。
//
// ドラッグ中は body に .resizing を付ける。右ペインが iframe の場合、マウスが iframe に
// 乗ると mousemove / mouseup が親ドキュメントに届かなくなるため、CSS 側で
// `body.resizing` のときに iframe の pointer-events を切ること(src/app.css 参照)。
//
// 比率は localStorage に保存し、次回起動時にも復元する。

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

function clampRatio(ratio) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function createResizer({ handle, container, storageKey, defaultRatio = 0.5 }) {
  let ratio = defaultRatio;

  function applyRatio(next) {
    ratio = clampRatio(next);
    container.style.setProperty('--resizer-ratio', String(ratio));
  }

  function loadRatio() {
    let raw = null;
    try {
      raw = storageKey ? localStorage.getItem(storageKey) : null;
    } catch {
      /* noop */
    }
    const value = raw ? Number(raw) : defaultRatio;
    return Number.isFinite(value) && value > 0 && value < 1 ? value : defaultRatio;
  }

  function saveRatio(value) {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      /* noop */
    }
  }

  let dragging = false;
  // ハンドルのどこを掴んだか(ハンドル左端からの距離)。境界がカーソルに対して
  // 掴んだ位置のまま動くようにする。
  let grabOffset = 0;

  function onMouseMove(e) {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    if (rect.width > 0) applyRatio((e.clientX - grabOffset - rect.left) / rect.width);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    saveRatio(ratio);
  }

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    grabOffset = e.clientX - handle.getBoundingClientRect().left;
    e.preventDefault();
    document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  applyRatio(loadRatio());

  return {
    destroy() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    },
  };
}
