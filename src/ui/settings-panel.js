// src/ui/settings-panel.js
//
// 設定パネル(案B: 左に設定フォーム・右に見本。dist/settings-demo.html の
// 案Bをそのまま移植)。ポーリングのオン/オフ・間隔、CSS のパス、標準 CSS の
// 使用可否、見出しの連番(深さはラジオ群)・字下げ、HTML 出力のサイドバー
// 目次の有無、アラートのタイトルを扱う。
// 値を変えても反映するのは右の見本だけで、「保存」を押したときに 1 回だけ保存して
// onChange を呼ぶ(背景のプレビューを変更のたびに描き直すとちらつくため)。
// 「キャンセル」・× ・Esc は変更を捨てて閉じる。背景のクリックは、未保存の変更が
// 無いときだけ閉じる(誤クリックで変更が消えないように)。未保存の変更があるときは
// フッタに「未保存の変更があります」を出す。
// 「標準 CSS を書き出す」ボタンはファイルを直接扱わず、クリック時に
// onExportStandardCss を呼ぶだけ(書き込みは呼び出し側 = app.js の責務)。
//
// 右側の見本(iframe)は src/ui/settings-sample.js が本物の描画経路で作る。
// アラートのタイトルは入力中(input イベント)に見本だけをその場で更新し
// (保存は従来どおり change イベントで行う)、変えた箇所の見本の位置へ
// 一瞬だけ背景色を付ける。それ以外の項目(見出し・標準 CSS)は change の
// たびに見本を再描画する。

import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../settings.js';
import { closeOnBackdropClick } from './backdrop-close.js';
import { createSettingsSample } from './settings-sample.js';

const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution', 'link', 'memo', 'check', 'question'];

export function createSettingsPanel({
  overlay,
  openBtn,
  saveBtn, // 「保存」: 入力中の値を保存して onChange を呼び、閉じる
  cancelBtn, // 「キャンセル」: 変更を捨てて閉じる
  closeXBtn, // ヘッダの × ボタン(省略可。キャンセルと同じ)
  dirtyNoteEl, // フッタの「未保存の変更があります」表示(省略可)
  pollEnabledInput,
  pollIntervalInput,
  pollIntervalRow, // 「確認する間隔」の行(pollEnabled がオフのとき is-off + disabled にする)
  cssPathInput,
  useStandardCssInput,
  exportStandardCssBtn, // 「標準 CSS をこのパスへ書き出す」ボタン(押されたら onExportStandardCss を呼ぶだけ)
  headingNumbersInput,
  headingNumberDepthInputs, // name="settingHeadingNumberDepth" のラジオ 5 つ(h2〜h6。NodeList/配列)
  headingDepthRow, // 「どの見出しまで付けるか」の行(headingNumbers がオフのとき is-off + disabled にする)
  headingIndentInput,
  sideTocInput, // 「左側に目次を付ける」(HTML 出力)のチェックボックス
  alertTitleInputs, // { note, tip, important, warning, caution, link, memo, check, question } の input 要素
  alertTitleResetButtons, // 同じキーの戻すボタン要素(省略可)
  sampleFrame, // 見本の iframe 要素(省略可。省略時は見本を出さない)
  onChange,
  onExportStandardCss, // 「標準 CSS をこのパスへ書き出す」ボタンのクリック時に呼ぶ(ファイルの書き込みは呼び出し側の責務)
}) {
  // 入力欄の placeholder に既定のタイトルを表示する(空欄にした場合との違いが
  // 分かるように)。設定値に関わらず固定なので、生成時に一度だけ設定する。
  if (alertTitleInputs) {
    for (const kind of ALERT_KINDS) {
      const input = alertTitleInputs[kind];
      if (input) input.placeholder = DEFAULT_SETTINGS.alertTitles[kind] || '';
    }
  }

  const sample = sampleFrame ? createSettingsSample({ iframe: sampleFrame }) : null;
  if (sample) sample.init();

  function currentDepth() {
    if (!headingNumberDepthInputs) return 6;
    const checked = Array.from(headingNumberDepthInputs).find((r) => r.checked);
    return checked ? Number(checked.value) || 6 : 6;
  }

  function currentAlertTitles() {
    const titles = {};
    if (alertTitleInputs) {
      for (const kind of ALERT_KINDS) {
        const input = alertTitleInputs[kind];
        if (input) titles[kind] = input.value;
      }
    }
    return titles;
  }

  // pollEnabled/headingNumbers がオフのとき、従属する行(確認する間隔・どの
  // 見出しまで付けるか)を is-off にして中の input を disabled にする。
  function updateDependentRows() {
    if (pollIntervalRow) {
      const on = !!(pollEnabledInput && pollEnabledInput.checked);
      pollIntervalRow.classList.toggle('is-off', !on);
      if (pollIntervalInput) pollIntervalInput.disabled = !on;
    }
    if (headingDepthRow) {
      const on = !!(headingNumbersInput && headingNumbersInput.checked);
      headingDepthRow.classList.toggle('is-off', !on);
      if (headingNumberDepthInputs) {
        for (const r of headingNumberDepthInputs) r.disabled = !on;
      }
    }
  }

  // アラートの戻すボタンは、既定値と違うときだけ見せる。
  function updateResetButtons() {
    if (!alertTitleResetButtons) return;
    for (const kind of ALERT_KINDS) {
      const btn = alertTitleResetButtons[kind];
      const input = alertTitleInputs && alertTitleInputs[kind];
      if (!btn || !input) continue;
      btn.classList.toggle('show', input.value !== (DEFAULT_SETTINGS.alertTitles[kind] || ''));
    }
  }

  function renderSample(settings) {
    if (!sample) return Promise.resolve();
    return sample.render({
      headingNumbers: settings.headingNumbers,
      headingNumberDepth: settings.headingNumberDepth,
      headingIndent: settings.headingIndent,
      alertTitles: settings.alertTitles,
      useStandardCss: settings.useStandardCss,
    });
  }

  function fillFromSettings(settings) {
    pollEnabledInput.checked = !!settings.pollEnabled;
    pollIntervalInput.value = String(Math.round((settings.pollIntervalMs || 2000) / 1000));
    cssPathInput.value = settings.cssPath || 'style.css';
    if (useStandardCssInput) useStandardCssInput.checked = settings.useStandardCss !== false;
    if (headingNumbersInput) headingNumbersInput.checked = !!settings.headingNumbers;
    if (headingNumberDepthInputs) {
      const depth = String(settings.headingNumberDepth || 6);
      for (const r of headingNumberDepthInputs) r.checked = r.value === depth;
    }
    if (headingIndentInput) headingIndentInput.checked = !!settings.headingIndent;
    if (sideTocInput) sideTocInput.checked = settings.sideToc !== false;
    if (alertTitleInputs) {
      for (const kind of ALERT_KINDS) {
        const input = alertTitleInputs[kind];
        // 「空欄(タイトルなし)」と「未設定(既定値のまま)」を区別するため、
        // ここでは既定値へのフォールバックをしない(空文字ならそのまま空欄にする)。
        if (input) input.value = (settings.alertTitles && settings.alertTitles[kind]) ?? '';
      }
    }
    baseline = JSON.stringify(collect());
    updateDependentRows();
    updateResetButtons();
    updateDirtyNote();
    renderSample(settings);
  }

  function open() {
    fillFromSettings(loadSettings());
    overlay.style.display = '';
  }
  function close() {
    overlay.style.display = 'none';
  }
  function isOpen() {
    return overlay.style.display !== 'none';
  }

  // 入力欄の今の値を、保存する設定の形にまとめる(まだ保存はしない)。
  function collect() {
    const intervalSec = Math.max(1, Number(pollIntervalInput.value) || 2);
    return {
      pollEnabled: pollEnabledInput.checked,
      pollIntervalMs: intervalSec * 1000,
      cssPath: (cssPathInput.value || 'style.css').trim() || 'style.css',
      useStandardCss: useStandardCssInput ? useStandardCssInput.checked : true,
      headingNumbers: headingNumbersInput ? headingNumbersInput.checked : false,
      headingNumberDepth: currentDepth(),
      headingIndent: headingIndentInput ? headingIndentInput.checked : false,
      sideToc: sideTocInput ? sideTocInput.checked : true,
      alertTitles: currentAlertTitles(),
    };
  }

  // 開いた時点の値(collect() の結果の JSON)。これと違えば「未保存の変更あり」。
  let baseline = '';
  function isDirty() {
    return JSON.stringify(collect()) !== baseline;
  }
  function updateDirtyNote() {
    if (!dirtyNoteEl) return;
    const dirty = isDirty();
    dirtyNoteEl.classList.toggle('is-dirty', dirty);
    dirtyNoteEl.textContent = dirty ? '未保存の変更があります' : '';
  }

  // 値が変わるたびに呼ぶ。見本とパネル内の表示だけを更新し、保存・プレビューへの
  // 反映はしない(背景のプレビューを何度も描き直すとちらつくため、「保存」で 1 回だけ行う)。
  function onEdit() {
    updateDependentRows();
    updateResetButtons();
    updateDirtyNote();
    return renderSample(collect());
  }

  function save() {
    const next = saveSettings(collect());
    close();
    if (typeof onChange === 'function') onChange(next);
  }

  openBtn.addEventListener('click', open);
  saveBtn.addEventListener('click', save);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (closeXBtn) closeXBtn.addEventListener('click', close);
  // 背景のクリックは、誤って押しても変更が消えないよう、未保存の変更が無いときだけ閉じる。
  closeOnBackdropClick(overlay, () => {
    if (!isDirty()) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });

  pollEnabledInput.addEventListener('change', onEdit);
  pollIntervalInput.addEventListener('change', onEdit);
  cssPathInput.addEventListener('change', onEdit);
  if (useStandardCssInput) useStandardCssInput.addEventListener('change', onEdit);
  if (headingNumbersInput) headingNumbersInput.addEventListener('change', onEdit);
  if (headingNumberDepthInputs) {
    for (const r of headingNumberDepthInputs) r.addEventListener('change', onEdit);
  }
  if (headingIndentInput) headingIndentInput.addEventListener('change', onEdit);
  if (sideTocInput) sideTocInput.addEventListener('change', onEdit);
  if (exportStandardCssBtn) {
    exportStandardCssBtn.addEventListener('click', () => {
      if (typeof onExportStandardCss === 'function') onExportStandardCss();
    });
  }
  if (alertTitleInputs) {
    for (const kind of ALERT_KINDS) {
      const input = alertTitleInputs[kind];
      if (!input) continue;
      // 入力中は保存せず見本だけをその場で更新し、変えた位置を一瞬だけ示す。
      input.addEventListener('input', () => {
        onEdit().then(() => {
          if (sample) sample.flashAlert(kind);
        });
      });
    }
  }
  if (alertTitleResetButtons) {
    for (const kind of ALERT_KINDS) {
      const btn = alertTitleResetButtons[kind];
      const input = alertTitleInputs && alertTitleInputs[kind];
      if (!btn || !input) continue;
      btn.addEventListener('click', () => {
        input.value = DEFAULT_SETTINGS.alertTitles[kind] || '';
        onEdit().then(() => {
          if (sample) sample.flashAlert(kind);
        });
      });
    }
  }

  return {
    open,
    close,
    // ワークスペースの style.css の中身を見本にも反映する(app.js が
    // preview.setUserCss() を呼ぶのと同じタイミングで呼んでもらう想定)。
    setUserCss: (text) => {
      if (sample) sample.setUserCss(text);
    },
  };
}
