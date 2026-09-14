// src/ui/context-menu.js
//
// 小さな右クリックメニュー(ツリーの行・余白の両方で使う汎用実装)。画面外に
// はみ出さないよう表示位置を補正し、外側クリック(mousedown)・Esc・スクロール・
// resize・ウィンドウの blur のいずれかで閉じる。
//
// 使い方: open(x, y, items) の items は { label, onClick } または区切り線を表す
// { separator: true } の配列(x, y は e.clientX / e.clientY = ビューポート座標)。

export function createContextMenu() {
  let menuEl = null;
  let offListeners = [];

  function close() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    for (const off of offListeners) off();
    offListeners = [];
  }

  function open(x, y, items) {
    close();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    for (const item of items || []) {
      if (item.separator) {
        const hr = document.createElement('div');
        hr.className = 'context-menu-separator';
        menu.appendChild(hr);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'context-menu-item';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        close();
        if (typeof item.onClick === 'function') item.onClick();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);
    menuEl = menu;

    // 画面外にはみ出さないよう位置を補正する。
    const rect = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const onMouseDown = (e) => {
      if (menuEl && !menuEl.contains(e.target)) close();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    const onScroll = () => close();
    const onResize = () => close();
    const onBlur = () => close();
    // capture フェーズで見ることで、メニュー項目以外へのクリックを確実に拾う
    // (子要素での stopPropagation の影響を受けない)。
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    offListeners = [
      () => document.removeEventListener('mousedown', onMouseDown, true),
      () => document.removeEventListener('keydown', onKeyDown, true),
      () => window.removeEventListener('scroll', onScroll, true),
      () => window.removeEventListener('resize', onResize),
      () => window.removeEventListener('blur', onBlur),
    ];
  }

  return { open, close };
}
