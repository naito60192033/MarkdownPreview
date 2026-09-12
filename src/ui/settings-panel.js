// src/ui/settings-panel.js
//
// 設定パネル(ポーリングのオン/オフ・間隔、CSS のパス、アラートのタイトル)。
// 開閉と、値が変わるたびに即座に保存し、呼び出し側に反映してもらうための
// onChange コールバックを呼ぶだけの薄い UI。

import { loadSettings, saveSettings } from '../settings.js';

const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'];

export function createSettingsPanel({
  overlay,
  openBtn,
  closeBtn,
  pollEnabledInput,
  pollIntervalInput,
  cssPathInput,
  alertTitleInputs, // { note, tip, important, warning, caution } の input 要素
  onChange,
}) {
  function fillFromSettings(settings) {
    pollEnabledInput.checked = !!settings.pollEnabled;
    pollIntervalInput.value = String(Math.round((settings.pollIntervalMs || 2000) / 1000));
    cssPathInput.value = settings.cssPath || 'style.css';
    if (alertTitleInputs) {
      for (const kind of ALERT_KINDS) {
        const input = alertTitleInputs[kind];
        if (input) input.value = (settings.alertTitles && settings.alertTitles[kind]) || '';
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
      alertTitles,
    });
    if (typeof onChange === 'function') onChange(next);
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  pollEnabledInput.addEventListener('change', commit);
  pollIntervalInput.addEventListener('change', commit);
  cssPathInput.addEventListener('change', commit);
  if (alertTitleInputs) {
    for (const kind of ALERT_KINDS) {
      const input = alertTitleInputs[kind];
      if (input) input.addEventListener('change', commit);
    }
  }

  return { open, close };
}
