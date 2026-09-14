// src/ui/backdrop-close.js
//
// モーダルの背景(overlay 自身)をクリックしたら閉じる、の共通処理。
//
// click の e.target === overlay だけで判定すると、モーダル内の入力欄で文字を
// ドラッグ選択し、マウスをモーダルの外に出して離したときにも閉じてしまう
// (mousedown と mouseup の要素が違うと、click は両者の共通の祖先 = overlay で
// 発火するため)。mousedown も背景の上で始まった場合だけ閉じる。

export function closeOnBackdropClick(overlay, onClose) {
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (e) => {
    downOnBackdrop = e.target === overlay;
  });
  overlay.addEventListener('click', (e) => {
    const shouldClose = downOnBackdrop && e.target === overlay;
    downOnBackdrop = false;
    if (shouldClose) onClose();
  });
}
