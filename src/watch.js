// src/watch.js
//
// 開いている md・style.css(・@import 先)の外部変更を検知する。
// タイミングは「ウィンドウがフォーカスを得たとき」と「タブが表示中(visible)の間の
// 一定間隔のポーリング」の2つ(仕様どおり)。自分がファイルへ書き込んでいる間は
// isWriting() が true を返すようにして検知を止める(SMB での競合を増やさないため)。
//
// ポーリング1回あたりの負荷を抑えるため、まず getFileHandle().getFile() で
// lastModified だけを確認し、変化があったときだけ本文を読む。
//
// 監視対象は watch()/unwatch() で動的に増減できる(現在開いている md の切り替えや、
// @import 先ファイルの登録・解除に対応するため)。
//
// ---- 保存との競合(レビュー指摘) ----
// checkOne() は isWriting() を最初に1回見るだけなので、保存が始まる前に読み込みを
// 始めた確認処理が、保存が完了した後に(await の後で)結果を返すと、保存直後の
// 内容を古い内容で上書きしてしまう恐れがある。これを防ぐため、呼び出し側
// (src/app.js)が保存の開始時・終了時に増やす「書き込み世代番号」を
// getWriteGeneration() で受け取り、checkOne は自分が開始した時点の世代を覚えておく。
// 各 await の直後に、書き込み中(isWriting())か世代が変わっていないかを確認し、
// 変わっていれば(=保存とすれ違った)その回の結果を丸ごと捨てて onChange を呼ばない。

import { getFileHandleByPath } from './fs/workspace.js';

/**
 * @param {{ getRoot: () => any, getSettings: () => { pollEnabled: boolean, pollIntervalMs: number },
 *           isWriting: () => boolean, getWriteGeneration?: () => number }} opts
 */
export function createWatcher({ getRoot, getSettings, isWriting, getWriteGeneration = () => 0 }) {
  const entries = new Map(); // path -> { lastModified, onChange }
  let timer = null;
  let running = false;
  let checking = false;

  async function checkOne(path, entry) {
    if (isWriting()) return;
    const root = getRoot();
    if (!root) return;
    const genAtStart = getWriteGeneration();
    const stale = () => isWriting() || getWriteGeneration() !== genAtStart;

    let file = null;
    try {
      const fh = await getFileHandleByPath(root, path, { create: false });
      file = await fh.getFile();
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        if (stale()) return;
        if (entry.lastModified !== null) {
          const prev = entry.lastModified;
          entry.lastModified = null;
          entry.onChange({ path, text: null, lastModified: null, previousLastModified: prev, missing: true });
        }
      }
      return;
    }
    if (stale()) return;
    if (file.lastModified === entry.lastModified) return;
    const prev = entry.lastModified;
    let text = null;
    try {
      text = await file.text();
    } catch {
      return;
    }
    if (stale()) return;
    entry.lastModified = file.lastModified;
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
