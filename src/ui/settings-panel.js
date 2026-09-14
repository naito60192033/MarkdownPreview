// src/ui/settings-panel.js
//
// 設定パネル(ポーリングのオン/オフ・間隔、CSS のパス、標準 CSS の使用可否、
// 見出しの連番・字下げ、アラートのタイトル)。開閉と、値が変わるたびに即座に保存し、呼び出し側に
// 反映してもらうための onChange コールバックを呼ぶだけの薄い UI。
// 「標準 CSS を書き出す」ボタンはファイルを直接扱わず、クリック時に
// onExportStandardCss を呼ぶだけ(書き込みは呼び出し側 = app.js の責務)。

import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../settings.js';
import { closeOnBackdropClick } from './backdrop-close.js';

const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution', 'link', 'memo', 'check', 'question'];

export function createSettingsPanel({
  overlay,
  openBtn,
  closeBtn,
  pollEnabledInput,
  pollIntervalInput,
  cssPathInput,
  useStandardCssInput,
  exportStandardCssBtn, // 「標準 CSS を書き出す」ボタン(押されたら onExportStandardCss を呼ぶだけ)
  headingNumbersInput,
  headingNumberDepthInput,
  headingIndentInput,
  alertTitleInputs, // { note, tip, important, warning, caution, link, memo, check, question } の input 要素
  alertTitleResetButtons, // 同じキーの「既定に戻す」ボタン要素(省略可)
  onChange,
  onExportStandardCss, // 「標準 CSS を書き出す」ボタンのクリック時に呼ぶ(ファイルの書き込みは呼び出し側の責務)
}) {
  // 入力欄の placeholder に既定のタイトルを表示する(空欄にした場合との違いが
  // 分かるように)。設定値に関わらず固定なので、生成時に一度だけ設定する。
  if (alertTitleInputs) {
    for (const kind of ALERT_KINDS) {
      const input = alertTitleInputs[kind];
      if (input) input.placeholder = DEFAULT_SETTINGS.alertTitles[kind] || '';
    }
  }

  function fillFromSettings(settings) {
    pollEnabledInput.checked = !!settings.pollEnabled;
    pollIntervalInput.value = String(Math.round((settings.pollIntervalMs || 2000) / 1000));
    cssPathInput.value = settings.cssPath || 'style.css';
    if (useStandardCssInput) useStandardCssInput.checked = settings.useStandardCss !== false;
    if (headingNumbersInput) headingNumbersInput.checked = !!settings.headingNumbers;
    if (headingNumberDepthInput) headingNumberDepthInput.value = String(settings.headingNumberDepth || 6);
    if (headingIndentInput) headingIndentInput.checked = !!settings.headingIndent;
    if (alertTitleInputs) {
      for (const kind of ALERT_KINDS) {
        const input = alertTitleInputs[kind];
        // 「空欄(タイトルなし)」と「未設定(既定値のまま)」を区別するため、
        // ここでは既定値へのフォールバックをしない(空文字ならそのまま空欄にする)。
        if (input) input.value = (settings.alertTitles && settings.alertTitles[kind]) ?? '';
      }
    }
  }

  function open() {
    fillFromSettings(loadSettings());
    overlay.style.display = '';
  }
  function close() {
    overlay.style.display = 'none';
  }

  function commit() {
    const intervalSec = Math.max(1, Number(pollIntervalInput.value) || 2);
    const alertTitles = {};
    if (alertTitleInputs) {
      for (const kind of ALERT_KINDS) {
        const input = alertTitleInputs[kind];
        if (input) alertTitles[kind] = input.value;
      }
    }
    const next = saveSettings({
      pollEnabled: pollEnabledInput.checked,
      pollIntervalMs: intervalSec * 1000,
      cssPath: (cssPathInput.value || 'style.css').trim() || 'style.css',
      useStandardCss: useStandardCssInput ? useStandardCssInput.checked : true,
      headingNumbers: headingNumbersInput ? headingNumbersInput.checked : false,
      headingNumberDepth: headingNumberDepthInput ? Number(headingNumberDepthInput.value) || 6 : 6,
      headingIndent: headingIndentInput ? headingIndentInput.checked : false,
      alertTitles,
    });
    if (typeof onChange === 'function') onChange(next);
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  closeOnBackdropClick(overlay, close);
  pollEnabledInput.addEventListener('change', commit);
  pollIntervalInput.addEventListener('change', commit);
  cssPathInput.addEventListener('change', commit);
  if (useStandardCssInput) useStandardCssInput.addEventListener('change', commit);
  if (headingNumbersInput) headingNumbersInput.addEventListener('change', commit);
  if (headingNumberDepthInput) headingNumberDepthInput.addEventListener('change', commit);
  if (headingIndentInput) headingIndentInput.addEventListener('change', commit);
  if (exportStandardCssBtn) {
    exportStandardCssBtn.addEventListener('click', () => {
      if (typeof onExportStandardCss === 'function') onExportStandardCss();
    });
  }
  if (alertTitleInputs) {
    for (const kind of ALERT_KINDS) {
      const input = alertTitleInputs[kind];
      if (input) input.addEventListener('change', commit);
    }
  }
  if (alertTitleResetButtons) {
    for (const kind of ALERT_KINDS) {
      const btn = alertTitleResetButtons[kind];
      const input = alertTitleInputs && alertTitleInputs[kind];
      if (!btn || !input) continue;
      btn.addEventListener('click', () => {
        input.value = DEFAULT_SETTINGS.alertTitles[kind] || '';
        commit();
      });
    }
  }

  return { open, close };
}
