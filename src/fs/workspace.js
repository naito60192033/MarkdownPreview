// src/fs/workspace.js
//
// File System Access API (FSA) まわりの共通ヘルパー。task-kanri
// (`index.html` の 1672 行付近の IndexedDB ヘルパー、1900〜2010 行の
// ensurePermission / withRetry / isTransientFsError / refreshDirState /
// writeData、2183〜2282 行の pickFolder / tryRestoreFolder)を踏襲しつつ、
// mdpreview 用に汎用化したもの。DOM に依存しないので node:test からも
// 呼び出しやすい(ただし実際の FSA API 呼び出しはブラウザ専用)。
//
// file:// のページは同一オリジン(null)として IndexedDB / localStorage を
// 共有するため、task-kanri と衝突しないよう DB 名・ストア名には
// `mdpreview` の接頭辞を付けている。

// ---------- IndexedDB: ハンドルの永続化 ----------
export const IDB_NAME = 'mdpreview-handles';
export const IDB_STORE = 'handles';
export const IDB_VERSION = 1;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, IDB_VERSION);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(IDB_STORE)) {
        r.result.createObjectStore(IDB_STORE);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- 権限 ----------
export async function ensurePermission(handle, opts = { mode: 'readwrite' }) {
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// ---------- 一時的なエラーの判定と再試行 ----------
// SMB 共有上では、他プロセスがファイルに触れた直後の createWritable().close() が
// "state had changed" (InvalidStateError) で失敗することがある。再試行で吸収する。
export function isTransientFsError(e) {
  const msg = String(e?.message || '');
  if (msg.includes('state had changed') || msg.includes('state cached')) return true;
  if (e?.name === 'InvalidStateError') return true;
  if (e?.name === 'NoModificationAllowedError') return true;
  return false;
}

// 指数バックオフ(上限1s)+ジッター。既定の8回で合計待ち時間は約5秒。
export async function withRetry(fn, { retries = 8 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries - 1 || !isTransientFsError(e)) throw e;
      const base = Math.min(1000, 120 * Math.pow(1.5, i));
      const delay = base + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ディレクトリハンドルが持つ Chrome 側のキャッシュされた状態を最新化する。
// これを呼ばずに createWritable().close() すると、他クライアントが触れていた
// 場合に "state had changed" で失敗することがある。
export async function refreshDirState(dirHandle) {
  try {
    // values() を列挙させることで Chrome にディレクトリを再 stat させる。
    // eslint-disable-next-line no-unused-vars
    for await (const _ of dirHandle.values()) {
      /* noop */
    }
  } catch {
    /* noop */
  }
}

// ---------- 読み書き ----------
/**
 * dirHandle 配下のファイルを読み、File 相当のオブジェクトを返す。
 * 見つからない場合は null を返す(呼び出し側で新規作成などを判断する)。
 */
export async function readFile(dirHandle, fileName) {
  try {
    const fh = await dirHandle.getFileHandle(fileName, { create: false });
    return await fh.getFile();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return null;
    throw e;
  }
}

// 他の人がディスク上のファイルを先に更新していた(保存時の競合)ことを表すエラー。
// 一時的なエラーではないので withRetry では再試行しない。呼び出し側で
// 「上書き / 破棄して再読込 / キャンセル」を確認する UI につなげる。
export class ConflictError extends Error {
  constructor(message = 'ファイルが他で更新されています') {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * ファイルを書き込む。task-kanri の writeData() と同じ手順
 * (refreshDirState → getFileHandle → [競合チェック] → createWritable → write → close)
 * を踏む。
 *
 * opts.expectedLastModified を渡すと、書き込み直前にディスク上の lastModified を
 * 読み直して比較し、読み込み時から変わっていれば ConflictError を投げる。
 *
 * data には文字列・Blob・ArrayBuffer・TypedArray のいずれも渡せる
 * (FileSystemWritableFileStream.write() がそのまま受け付ける)。
 *
 * 戻り値: 書き込み後のファイルの lastModified(次回の競合チェックの基準にする)。
 */
export async function writeFile(dirHandle, fileName, data, opts = {}) {
  await refreshDirState(dirHandle);
  const fh = await dirHandle.getFileHandle(fileName, { create: true });

  if (opts.expectedLastModified != null) {
    let current = null;
    try {
      current = await fh.getFile();
    } catch {
      /* 新規作成直後などで読めない場合は競合チェックをスキップする */
    }
    if (current && current.lastModified !== opts.expectedLastModified) {
      throw new ConflictError();
    }
  }

  const w = await fh.createWritable();
  try {
    await w.write(data);
    await w.close();
  } catch (e) {
    try {
      await w.abort();
    } catch {
      /* noop */
    }
    throw e;
  }
  return (await fh.getFile()).lastModified;
}

// withRetry でくるんだ書き込み。一時的なエラーはここで吸収する。
export async function writeFileWithRetry(dirHandle, fileName, data, opts = {}) {
  return withRetry(() => writeFile(dirHandle, fileName, data, opts));
}

// ---------- フォルダの選択・再許可 ----------
/**
 * フォルダを選ぶ。`forcePicker` が false の場合、まず IndexedDB に保存済みの
 * ハンドルへの再許可を試み、成功すればピッカーを出さずに返す
 * (task-kanri の pickFolder() と同じ流れ)。
 */
export async function pickFolder({ idbKey = 'rootDirHandle', forcePicker = false } = {}) {
  if (!('showDirectoryPicker' in window)) {
    const e = new Error('このブラウザは File System Access API に対応していません。Chrome で開いてください。');
    e.name = 'NotSupportedError';
    throw e;
  }

  if (!forcePicker) {
    let saved = null;
    try {
      saved = await idbGet(idbKey);
    } catch {
      /* noop */
    }
    if (saved) {
      try {
        if (await ensurePermission(saved)) return saved;
      } catch {
        // ハンドルが無効(フォルダが移動/削除された等)。ピッカーにフォールバックする。
      }
    }
  }

  // id を付けると、Chrome が前回開いた場所をピッカーの初期位置として記憶する。
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mdpreview-root' });
  if (!(await ensurePermission(handle))) {
    throw new Error('書き込み許可が得られませんでした');
  }
  await idbSet(idbKey, handle);
  return handle;
}

/**
 * 前回のフォルダへの再許可を試みる。ユーザ操作(クリック等)のハンドラ内で
 * 呼ぶこと(requestPermission() はユーザジェスチャを要求するため)。
 * 戻り値:
 *   - { ok: true, handle } … 許可済みで即座に使える
 *   - { ok: false, needsPermission: true, handle } … 再許可が必要
 *   - { ok: false, needsPermission: false } … 保存済みのハンドルが無い
 */
export async function tryRestoreFolder({ idbKey = 'rootDirHandle' } = {}) {
  let handle = null;
  try {
    handle = await idbGet(idbKey);
  } catch {
    /* noop */
  }
  if (!handle) return { ok: false, needsPermission: false };

  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
      return { ok: true, handle };
    }
  } catch {
    return { ok: false, needsPermission: false };
  }
  return { ok: false, needsPermission: true, handle };
}
