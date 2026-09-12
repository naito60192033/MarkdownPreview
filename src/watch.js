// src/watch.js
//
// 開いている md・style.css(・後で追加する @import 先)の外部変更を検知する。
// タイミングは「ウィンドウがフォーカスを得たとき」と「タブが表示中(visible)の間の
// 一定間隔のポーリング」の2つ(仕様どおり)。自分がファイルへ書き込んでいる間は
// isWriting() が true を返すようにして検知を止める(SMB での競合を増やさないため)。
//
// ポーリング1回あたりの負荷を抑えるため、まず getFileHandle().getFile() で
// lastModified だけを確認し、変化があったときだけ本文を読む。
//
// 監視対象は watch()/unwatch() で動的に増減できる(現在開いている md の切り替えや、
// 後続フェーズでの @import 先ファイルの登録・解除に対応するため)。

import { getFileHandleByPath } from './fs/workspace.js';

/**
 * @param {{ getRoot: () => any, getSettings: () => { pollEnabled: boolean, pollIntervalMs: number },
 *           isWriting: () => boolean }} opts
 */
export function createWatcher({ getRoot, getSettings, isWriting }) {
  const entries = new Map(); // path -> { lastModified, onChange }
  let timer = null;
  let running = false;
  let checking = false;

  async function checkOne(path, entry) {
    if (isWriting()) return;
    const root = getRoot();
    if (!root) return;
    let file = null;
    try {
      const fh = await getFileHandleByPath(root, path, { create: false });
      file = await fh.getFile();
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        if (entry.lastModified !== null) {
          const prev = entry.lastModified;
          entry.lastModified = null;
          entry.onChange({ path, text: null, lastModified: null, previousLastModified: prev, missing: true });
        }
      }
      return;
    }
    if (file.lastModified === entry.lastModified) return;
    const prev = entry.lastModified;
    entry.lastModified = file.lastModified;
    let text = null;
    try {
      text = await file.text();
    } catch {
      return;
    }
    entry.onChange({ path, text, lastModified: file.lastModified, previousLastModified: prev, missing: false });
  }

  async function checkAll() {
    if (checking) return;
    checking = true;
    try {
      for (const [path, entry] of entries) {
        await checkOne(path, entry);
      }
    } finally {
      checking = false;
    }
  }

  function scheduleNext() {
    clearTimeout(timer);
    if (!running) return;
    const settings = getSettings();
    if (!settings.pollEnabled) return;
    const intervalMs = Math.max(500, settings.pollIntervalMs || 2000);
    timer = setTimeout(async () => {
      if (document.visibilityState === 'visible') {
        await checkAll();
      }
      scheduleNext();
    }, intervalMs);
  }

  function onFocus() {
    checkAll();
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') checkAll();
  }

  function start() {
    if (running) return;
    running = true;
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleNext();
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  /** 設定(間隔・オンオフ)が変わった直後に呼ぶと、次回のポーリングに反映される。 */
  function reschedule() {
    scheduleNext();
  }

  function watch(path, onChange, initialLastModified = null) {
    entries.set(path, { lastModified: initialLastModified, onChange });
  }
  function unwatch(path) {
    entries.delete(path);
  }
  function setLastModified(path, lastModified) {
    const e = entries.get(path);
    if (e) e.lastModified = lastModified;
  }

  return { start, stop, reschedule, watch, unwatch, setLastModified, checkAll };
}
