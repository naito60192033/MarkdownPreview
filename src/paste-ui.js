// src/paste-ui.js
//
// 貼り付けまわりの UI 部品(CodeMirror 依存)。アプリ本体(src/paste.js)への
// 組み込みを見据えた本物のモジュールとして、いまは dev/paste-demo/ から使う。
//
// - savingPlaceholderExtension / addSavingPlaceholder / takeSavingPlaceholder:
//   画像の保存中、本文には書き込まずにカーソル位置へ「⏳ 画像を保存中…」を
//   表示する CodeMirror の装飾(Decoration)。編集で位置がずれても追従する。
// - showPasteChoiceMenu: 画像とテキストの両方を貼り付けようとしたときに、
//   カーソル位置の近くへ出す小さな選択メニュー。
//
// CSS(paste-ui.css)は esbuild の text ローダーで文字列として取り込み、
// 初回使用時に <style id="mdp-paste-ui-style"> として document.head に
// 1度だけ挿入する(src/annotator/annotator.js と同じ方式)。

import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import pasteUiCss from './paste-ui.css';

// ---------- スタイルの挿入(1度だけ) ----------
let styleInjected = false;
function ensureStyleInjected() {
  if (styleInjected) return;
  const styleEl = document.createElement('style');
  styleEl.id = 'mdp-paste-ui-style';
  styleEl.textContent = pasteUiCss;
  document.head.appendChild(styleEl);
  styleInjected = true;
}

// ---------- 保存中プレースホルダー ----------

class SavingPlaceholderWidget extends WidgetType {
  eq(other) {
    return other instanceof SavingPlaceholderWidget;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'mdp-saving-placeholder';
    span.textContent = '⏳ 画像を保存中…';
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const addSavingPlaceholderEffect = StateEffect.define(); // 値: { id, pos }
const removeSavingPlaceholderEffect = StateEffect.define(); // 値: id

let nextPlaceholderId = 1;

const savingPlaceholderField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(addSavingPlaceholderEffect)) {
        const { id, pos } = effect.value;
        const mark = Decoration.widget({ widget: new SavingPlaceholderWidget(), side: 1, id });
        deco = deco.update({ add: [mark.range(pos)] });
      } else if (effect.is(removeSavingPlaceholderEffect)) {
        const id = effect.value;
        deco = deco.update({ filter: (_from, _to, value) => value.spec.id !== id });
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * 保存中プレースホルダーの装飾を有効にする拡張。createEditor の extensions に渡す。
 */
export function savingPlaceholderExtension() {
  ensureStyleInjected();
  return savingPlaceholderField;
}

/**
 * pos の位置に保存中プレースホルダーを表示する。戻り値の id は takeSavingPlaceholder に渡す。
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} pos
 * @returns {number} id
 */
export function addSavingPlaceholder(view, pos) {
  const id = nextPlaceholderId++;
  view.dispatch({ effects: addSavingPlaceholderEffect.of({ id, pos }) });
  return id;
}

/**
 * id のプレースホルダーの現在位置(編集に追従済み)を返し、表示を消す。
 * 既に無ければ何もせず null を返す。
 * @param {import('@codemirror/view').EditorView} view
 * @param {number} id
 * @returns {number|null}
 */
export function takeSavingPlaceholder(view, id) {
  const field = view.state.field(savingPlaceholderField, false);
  let pos = null;
  if (field) {
    field.between(0, view.state.doc.length, (from, _to, value) => {
      if (value.spec.id === id) pos = from;
    });
  }
  if (pos != null) {
    view.dispatch({ effects: removeSavingPlaceholderEffect.of(id) });
  }
  return pos;
}

// ---------- 貼り付け方法の選択メニュー ----------

// 同時に開けるのは1つ。新しく開いたら前のメニューは null で閉じる。
let closeCurrentMenu = null;

/**
 * カーソル位置の近くに貼り付け方法の選択メニューを出す。
 * @param {{
 *   view: import('@codemirror/view').EditorView,
 *   pos: number,
 *   choices: { id: string, label: string }[],
 * }} opts
 * @returns {Promise<string|null>} 選んだ choice.id(取り消しなら null)
 */
export function showPasteChoiceMenu({ view, pos, choices }) {
  ensureStyleInjected();
  if (closeCurrentMenu) closeCurrentMenu();

  return new Promise((resolve) => {
    const menu = document.createElement('div');
    menu.className = 'mdp-paste-menu';

    const heading = document.createElement('div');
    heading.className = 'mdp-paste-menu-heading';
    heading.textContent = '貼り付け方法';
    menu.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'mdp-paste-menu-list';
    menu.appendChild(list);

    const items = choices.map((choice, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mdp-paste-menu-item';

      const label = document.createElement('span');
      label.className = 'mdp-paste-menu-label';
      label.textContent = choice.label;

      const key = document.createElement('span');
      key.className = 'mdp-paste-menu-key';
      key.textContent = index === 0 ? 'Enter / 1' : String(index + 1);

      btn.appendChild(label);
      btn.appendChild(key);
      btn.addEventListener('click', () => finish(choice.id));
      list.appendChild(btn);
      return btn;
    });

    const footer = document.createElement('div');
    footer.className = 'mdp-paste-menu-footer';
    footer.textContent = 'Esc で取り消し';
    menu.appendChild(footer);

    document.body.appendChild(menu);

    // 位置決め: pos の下(+4px)・左揃え。画面からはみ出すなら上に出す/左右を収める。
    const coords = view.coordsAtPos(pos) || { left: 0, top: 0, bottom: 0 };
    const rect = menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(coords.left, window.innerWidth - rect.width - 4));
    let top = coords.bottom + 4;
    if (top + rect.height > window.innerHeight - 4) {
      top = coords.top - rect.height - 4;
    }
    top = Math.max(4, top);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    let focusIndex = 0;
    function focusItem(index) {
      focusIndex = (index + items.length) % items.length;
      items[focusIndex].focus();
    }
    focusItem(0);

    function cleanup() {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      view.scrollDOM.removeEventListener('scroll', onScroll);
      menu.remove();
      closeCurrentMenu = null;
    }

    function finish(id) {
      cleanup();
      resolve(id);
      view.focus();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusItem(focusIndex + 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusItem(focusIndex - 1);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        finish(choices[focusIndex].id);
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
        e.preventDefault();
        finish(choices[n - 1].id);
      }
    }

    function onMouseDown(e) {
      if (!menu.contains(e.target)) finish(null);
    }

    function onScroll() {
      finish(null);
    }

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    view.scrollDOM.addEventListener('scroll', onScroll);

    closeCurrentMenu = () => finish(null);
  });
}
