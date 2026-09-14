// src/ui/name-modal.js
//
// 新規作成・名前の変更で使う「名前を入力」モーダル(#nameModal)。src/ui/conflict-modal.js
// と同じ overlay + modal-footer の作り。
//
// open({ title, initialValue, selectionStart, selectionEnd, validate }) → Promise<string | null>
//   - validate(value) は呼び出し側が渡す検証関数(非同期可)。エラー文言 or null(問題なし)を返す
//   - Enter または OK ボタンで validate() を呼び、エラーがあればモーダル内に赤字で表示して
//     開いたまま(閉じない)。無ければモーダルを閉じて入力値のまま resolve する
//   - Esc・背景クリック・キャンセルボタンは resolve(null)(キャンセル)

import { closeOnBackdropClick } from './backdrop-close.js';

export function createNameModal({ overlay, titleEl, input, errorEl, okBtn, cancelBtn }) {
  let resolver = null;
  let validateFn = null;
  let submitting = false;

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.style.display = message ? '' : 'none';
  }

  function close(result) {
    overlay.style.display = 'none';
    showError('');
    const r = resolver;
    resolver = null;
    validateFn = null;
    if (r) r(result);
  }

  async function submit() {
    if (submitting || !validateFn) return;
    submitting = true;
    try {
      const value = input.value;
      const err = await validateFn(value);
      if (err) {
        showError(err);
        return;
      }
      close(value);
    } finally {
      submitting = false;
    }
  }

  function open({ title, initialValue = '', selectionStart = null, selectionEnd = null, validate }) {
    return new Promise((resolve) => {
      resolver = resolve;
      validateFn = validate;
      titleEl.textContent = title;
      input.value = initialValue;
      showError('');
      overlay.style.display = '';
      input.focus();
      const start = selectionStart != null ? selectionStart : initialValue.length;
      const end = selectionEnd != null ? selectionEnd : initialValue.length;
      try {
        input.setSelectionRange(start, end);
      } catch {
        /* noop */
      }
    });
  }

  okBtn.addEventListener('click', () => submit());
  cancelBtn.addEventListener('click', () => close(null));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(null);
    }
  });
  closeOnBackdropClick(overlay, () => close(null));

  return { open };
}
