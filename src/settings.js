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
};

/** 保存済みの設定を既定値とマージして返す。壊れていれば既定値。 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 設定を保存する(既定値とマージしてから保存する)。戻り値は保存後の設定。 */
export function saveSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* noop (私的ブラウジング等で保存できない場合は無視) */
  }
  return merged;
}
