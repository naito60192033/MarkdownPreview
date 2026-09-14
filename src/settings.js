// src/settings.js
//
// 表示・監視まわりの小さな設定を localStorage(キー: `mdpreview.settings`)に
// 保存する。既定値とマージして返すので、将来キーを増やしても古い保存内容と
// 問題なくやり取りできる。

const STORAGE_KEY = 'mdpreview.settings';

export const DEFAULT_SETTINGS = {
  // 変更検知ポーリングの有効/間隔(ms)
  pollEnabled: true,
  pollIntervalMs: 2000,
  // プレビューに当てる CSS のパス(ルート相対)
  cssPath: 'style.css',
  // アラート(> [!NOTE] 等)のタイトル表記(src/render/alerts.js の既定値と同じ)
  alertTitles: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
    link: 'Link',
    memo: 'Memo',
    check: 'Check',
    question: 'Question',
  },
};

/** 保存済みの設定を既定値とマージして返す。壊れていれば既定値。 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed = JSON.parse(raw);
    return mergeSettings(parsed);
  } catch {
    return cloneDefaults();
  }
}

/** 設定を保存する(既定値とマージしてから保存する)。戻り値は保存後の設定。 */
export function saveSettings(settings) {
  const merged = mergeSettings(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* noop (私的ブラウジング等で保存できない場合は無視) */
  }
  return merged;
}

function cloneDefaults() {
  return { ...DEFAULT_SETTINGS, alertTitles: { ...DEFAULT_SETTINGS.alertTitles } };
}

// alertTitles はネストしたオブジェクトなので、浅いマージだと古い保存内容に
// 一部の種別しか無い場合に他の種別が消えてしまう。既定値 → 保存済みの alertTitles
// → 渡された alertTitles の順に重ねてマージする。
function mergeSettings(next) {
  return {
    ...DEFAULT_SETTINGS,
    ...next,
    alertTitles: { ...DEFAULT_SETTINGS.alertTitles, ...(next && next.alertTitles) },
  };
}
