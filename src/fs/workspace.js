// src/fs/workspace.js
//
// File System Access API (FSA) まわりの共通ヘルパー。task-kanri
// (`index.html` の 1672 行付近の IndexedDB ヘルパー、1900〜2010 行の
// ensurePermission / withRetry / isTransientFsError / refreshDirState /
// writeData)を踏襲しつつ、mdpreview 用に汎用化したもの。DOM に依存しないので
// node:test からも呼び出しやすい(ただし実際の FSA API 呼び出しはブラウザ専用)。
//
// フォルダの選択・再許可・最近使ったルートの一覧は src/fs/recent-roots.js に
// 分けている(このファイルはハンドル単位の低レベル操作が担当)。
//
// file:// のページは同一オリジン(null)として IndexedDB / localStorage を
// 共有するため、task-kanri と衝突しないよう DB 名・ストア名には
// `mdpreview` の接頭辞を付けている。

import { dirname, basename, extname, joinPath } from './paths.js';

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

// 新規作成・名前の変更で、同名(大文字小文字を区別しない)のファイル/フォルダが
// 既にあったことを表すエラー。
export class AlreadyExistsError extends Error {
  constructor(message = '同じ名前のファイル/フォルダが既にあります') {
    super(message);
    this.name = 'AlreadyExistsError';
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

// ---------- パス指定のヘルパー(ルート相対パスでの読み書き) ----------
// パスは常に src/fs/paths.js の規約(ルートからの相対パス、'/' 区切り、ルート自身は '')
// に従う。

/**
 * root から見て dirPath(ルート相対のフォルダパス)のディレクトリハンドルを返す。
 * dirPath === '' はルート自身。`create: true` なら途中のフォルダも作成する。
 */
export async function getDirHandle(root, dirPath, { create = false } = {}) {
  let dir = root;
  const segs = dirPath ? dirPath.split('/').filter(Boolean) : [];
  for (const seg of segs) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

/** root から見て path(ルート相対のファイルパス)のファイルハンドルを返す。 */
export async function getFileHandleByPath(root, path, { create = false } = {}) {
  const dir = await getDirHandle(root, dirname(path), { create });
  return dir.getFileHandle(basename(path), { create });
}

/**
 * テキストファイルを読む。存在しなければ null を返す。
 * 戻り値: { text, lastModified }
 */
export async function readTextByPath(root, path) {
  let fh;
  try {
    fh = await getFileHandleByPath(root, path, { create: false });
  } catch (e) {
    if (e && e.name === 'NotFoundError') return null;
    throw e;
  }
  const file = await fh.getFile();
  const text = await file.text();
  return { text, lastModified: file.lastModified };
}

/**
 * バイナリファイル(画像等)を File(Blob 相当。lastModified を含む)として読む。
 * 存在しなければ null を返す。
 * 戻り値: { blob, lastModified }
 */
export async function readBlobByPath(root, path) {
  let fh;
  try {
    fh = await getFileHandleByPath(root, path, { create: false });
  } catch (e) {
    if (e && e.name === 'NotFoundError') return null;
    throw e;
  }
  const file = await fh.getFile();
  return { blob: file, lastModified: file.lastModified };
}

/**
 * root から見て path にデータを書き込む。親フォルダは無ければ作成する。
 * refreshDirState・withRetry・競合チェック(ConflictError)は writeFileWithRetry /
 * writeFile 側の既存の手順にそのまま乗る。
 */
export async function writeByPath(root, path, data, opts = {}) {
  const dir = await getDirHandle(root, dirname(path), { create: true });
  return writeFileWithRetry(dir, basename(path), data, opts);
}

// ---------- ファイル操作一式(新規作成・名前の変更・削除) ----------
// フォルダ内を大文字小文字を区別せずに探す。task-kanri/mdpreview は Windows の
// Chrome から使われる前提のため、この判定はアプリ側で行う(このフェイク環境含め
// Linux 上のファイルシステムは大文字小文字を区別するため、OS 任せにはできない)。
//
// 戻り値: 実際にディレクトリに存在する名前(大文字小文字はそのまま)。無ければ null。
export async function findEntryName(dirHandle, name) {
  const lower = String(name ?? '').toLowerCase();
  for await (const entry of dirHandle.values()) {
    if (entry.name.toLowerCase() === lower) return entry.name;
  }
  return null;
}

// 大文字小文字を区別せずにフォルダを辿りながら、無ければ作成する
// (getDirHandle() は create:true でも大文字小文字の違いを同一視しないため、
// 新規作成専用にこちらを使う)。
// 戻り値: { dir, path } — path は実在するフォルダ名(大文字小文字)で組み直したルート相対パス。
// 入力が `Docs/x` で実在が `docs` なら `docs` を返す(ツリーの行・開いている md のパスと
// 一致させるため)。
async function resolveDirCaseInsensitive(root, dirPath) {
  let dir = root;
  const actual = [];
  const segs = dirPath ? dirPath.split('/').filter(Boolean) : [];
  for (const seg of segs) {
    const existingName = await findEntryName(dir, seg);
    const name = existingName != null ? existingName : seg;
    dir = await withRetry(() => dir.getDirectoryHandle(name, { create: existingName == null }));
    actual.push(name);
  }
  return { dir, path: actual.join('/') };
}

/**
 * 0 バイトの md 等を新規作成する。途中のフォルダも無ければ作成する。同名があれば AlreadyExistsError。
 * 戻り値: 実際に作成したルート相対パス(途中のフォルダは実在の大文字小文字に合わせる)。
 */
export async function createFileByPath(root, path) {
  const { dir, path: dirPath } = await resolveDirCaseInsensitive(root, dirname(path));
  const name = basename(path);
  const existing = await findEntryName(dir, name);
  if (existing != null) throw new AlreadyExistsError();
  await withRetry(() => dir.getFileHandle(name, { create: true }));
  return joinPath(dirPath, name);
}

/**
 * フォルダを新規作成する。途中のフォルダも無ければ作成する。同名があれば AlreadyExistsError。
 * 戻り値: 実際に作成したルート相対パス。
 */
export async function createDirByPath(root, path) {
  const { dir, path: dirPath } = await resolveDirCaseInsensitive(root, dirname(path));
  const name = basename(path);
  const existing = await findEntryName(dir, name);
  if (existing != null) throw new AlreadyExistsError();
  await withRetry(() => dir.getDirectoryHandle(name, { create: true }));
  return joinPath(dirPath, name);
}

/** フォルダ配下の件数(md・その他のファイル・フォルダ)を再帰的に数える(削除確認の表示用)。 */
export async function countEntries(dirHandle) {
  let md = 0;
  let otherFiles = 0;
  let dirs = 0;
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'directory') {
      dirs++;
      const sub = await countEntries(entry);
      md += sub.md;
      otherFiles += sub.otherFiles;
      dirs += sub.dirs;
    } else {
      const ext = extname(entry.name);
      if (ext === '.md' || ext === '.markdown') md++;
      else otherFiles++;
    }
  }
  return { md, otherFiles, dirs };
}

/** ファイル/フォルダを完全に削除する(ごみ箱には入らない)。フォルダは中身ごと削除する。 */
export async function deleteEntry(root, path) {
  const dir = await getDirHandle(root, dirname(path), { create: false });
  await withRetry(() => dir.removeEntry(basename(path), { recursive: true }));
}

// 一時名(大文字小文字だけの変更を安全に行うための経由地)。
function tempRenameName(name) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${name}.renaming-${rand}`;
}

// 一時名への退避後に失敗したときのエラー。データは一時名の側に残っているので、
// ユーザーが自分で戻せるよう名前を必ず知らせる。
function tempLeftError(tempName, cause) {
  return new Error(
    `名前の変更が途中で止まりました。内容は「${tempName}」に残っています(エクスプローラで元の名前に戻してください): ${(cause && cause.message) || cause}`
  );
}

// oldName のファイル/フォルダのハンドルを、種別を判定しつつ取得する
// (renameEntry() は種別をパスだけからは判断できないため、まずファイルとして試し、
// TypeMismatchError ならフォルダとして取得し直す)。
async function getEntryHandleAnyKind(parentDir, name) {
  try {
    return { kind: 'file', handle: await parentDir.getFileHandle(name, { create: false }) };
  } catch (e) {
    if (e && e.name === 'TypeMismatchError') {
      return { kind: 'directory', handle: await parentDir.getDirectoryHandle(name, { create: false }) };
    }
    throw e;
  }
}

// コピー→照合→(必要なら)削除、で1つのファイルを複製する。コピー先の書き込みや
// サイズ照合に失敗したら、作りかけのコピー先を消してから投げ直す(元はまだ触っていない)。
// 自分で新しく作るファイルへの書き込み。writeFile() と違い refreshDirState()(フォルダの
// 全件列挙)を毎回は呼ばない。フォルダのコピーでファイルごとに呼ぶと、SMB 上で
// 「件数 × 件数」回の列挙になり非常に遅くなるため。一時的なエラーは withRetry で吸収する。
async function writeNewFile(dirHandle, fileName, data) {
  return withRetry(async () => {
    const fh = await dirHandle.getFileHandle(fileName, { create: true });
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
  });
}

async function copyFileVerified(parentDir, srcName, destName) {
  const srcFh = await parentDir.getFileHandle(srcName, { create: false });
  const srcFile = await srcFh.getFile();
  try {
    await writeNewFile(parentDir, destName, srcFile);
    const destFh = await parentDir.getFileHandle(destName, { create: false });
    const destFile = await destFh.getFile();
    if (destFile.size !== srcFile.size) {
      throw new Error(`コピー後のサイズが一致しません(${srcFile.size} → ${destFile.size})`);
    }
  } catch (e) {
    try {
      await parentDir.removeEntry(destName);
    } catch {
      /* noop */
    }
    throw e;
  }
}

async function renameFileByCopy(parentDir, oldName, newName, { caseOnlyChange }) {
  if (caseOnlyChange) {
    // Windows では oldName と newName が同じファイルを指すため、両方が同時に
    // 存在する状態を作らない(一時名を経由する)。
    const tempName = tempRenameName(oldName);
    await copyFileVerified(parentDir, oldName, tempName);
    await withRetry(() => parentDir.removeEntry(oldName));
    try {
      await copyFileVerified(parentDir, tempName, newName);
    } catch (e) {
      // newName へのコピーに失敗。データは tempName にまだ残っている(元は失っていない)。
      // 一時名は .md で終わらずツリーに出ないため、名前をエラー文で知らせる。
      throw tempLeftError(tempName, e);
    }
    await withRetry(() => parentDir.removeEntry(tempName));
    return 'copy';
  }
  await copyFileVerified(parentDir, oldName, newName);
  await withRetry(() => parentDir.removeEntry(oldName));
  return 'copy';
}

async function renameFile(parentDir, oldName, newName, { caseOnlyChange }) {
  const fh = await parentDir.getFileHandle(oldName, { create: false });
  if (typeof fh.move === 'function') {
    try {
      if (caseOnlyChange) {
        const tempName = tempRenameName(oldName);
        try {
          await withRetry(() => fh.move(tempName));
        } catch {
          // 最初の一時名への move ができなかった: oldName のまま残っているはずなので、
          // そのままコピー方式へフォールバックする。
          return renameFileByCopy(parentDir, oldName, newName, { caseOnlyChange });
        }
        try {
          await withRetry(() => fh.move(newName));
          return 'move';
        } catch (e) {
          // 一時名への移動はできたが最終名への移動が失敗: 一時名から元の名前へ戻す。
          try {
            await withRetry(() => fh.move(oldName));
          } catch {
            throw new Error(
              `名前の変更が中断しました。「${tempName}」という一時ファイルが残っている可能性があります: ${(e && e.message) || e}`
            );
          }
          return renameFileByCopy(parentDir, oldName, newName, { caseOnlyChange });
        }
      }
      await withRetry(() => fh.move(newName));
      return 'move';
    } catch (e) {
      // 元が残っていて、移動先が無いことを確かめてからコピー方式へ(確かめられなければ
      // 中途半端な状態の恐れがあるため、そのままエラーで止める)。
      const oldStillThere = (await findEntryName(parentDir, oldName)) === oldName;
      const newNotThere = (await findEntryName(parentDir, newName)) == null;
      if (!oldStillThere || !newNotThere) throw e;
    }
  }
  return renameFileByCopy(parentDir, oldName, newName, { caseOnlyChange });
}

// フォルダ配下(md 以外・ドット始まりも含む)を再帰的にコピーする。
async function copyDirTreeInner(srcDir, destDir, onProgress, progress) {
  for await (const entry of srcDir.values()) {
    if (entry.kind === 'directory') {
      const childDest = await withRetry(() => destDir.getDirectoryHandle(entry.name, { create: true }));
      await copyDirTreeInner(entry, childDest, onProgress, progress);
    } else {
      const file = await entry.getFile();
      await writeNewFile(destDir, entry.name, file);
      const destFh = await destDir.getFileHandle(entry.name, { create: false });
      const destFile = await destFh.getFile();
      if (destFile.size !== file.size) {
        throw new Error(`コピー後のサイズが一致しません: ${entry.name}(${file.size} → ${destFile.size})`);
      }
      if (progress) {
        progress.current++;
        if (onProgress) onProgress({ current: progress.current, total: progress.total });
      }
    }
  }
}

// フォルダを丸ごとコピーし、件数が一致するか確認する。途中で失敗したら作りかけの
// コピー先を消してから投げ直す(元はまだ触っていない)。
async function copyDirTree(parentDir, srcName, destName, onProgress) {
  const srcDir = await parentDir.getDirectoryHandle(srcName, { create: false });
  const destDir = await withRetry(() => parentDir.getDirectoryHandle(destName, { create: true }));
  const srcCountBefore = await countEntries(srcDir);
  const progress = { current: 0, total: srcCountBefore.md + srcCountBefore.otherFiles };
  try {
    await copyDirTreeInner(srcDir, destDir, onProgress, progress);
    const destCount = await countEntries(destDir);
    if (
      srcCountBefore.md !== destCount.md ||
      srcCountBefore.otherFiles !== destCount.otherFiles ||
      srcCountBefore.dirs !== destCount.dirs
    ) {
      throw new Error('コピー後の件数が一致しません');
    }
  } catch (e) {
    try {
      await parentDir.removeEntry(destName, { recursive: true });
    } catch {
      /* noop */
    }
    throw e;
  }
}

async function renameDir(parentDir, oldName, newName, { caseOnlyChange, onProgress }) {
  if (caseOnlyChange) {
    const tempName = tempRenameName(oldName);
    await copyDirTree(parentDir, oldName, tempName, onProgress);
    await withRetry(() => parentDir.removeEntry(oldName, { recursive: true }));
    // newName へのコピーに失敗しても、データは tempName にまだ残っている(元は失っていない)。
    try {
      await copyDirTree(parentDir, tempName, newName, onProgress);
    } catch (e) {
      throw tempLeftError(tempName, e);
    }
    await withRetry(() => parentDir.removeEntry(tempName, { recursive: true }));
    return 'copy';
  }
  await copyDirTree(parentDir, oldName, newName, onProgress);
  await withRetry(() => parentDir.removeEntry(oldName, { recursive: true }));
  return 'copy';
}

/**
 * ファイル/フォルダの名前を変更する(同じフォルダ内。別フォルダへの移動はしない)。
 *
 * - ファイル: FileSystemFileHandle.move() があれば試す。失敗したら、元が残っていて
 *   移動先が無いことを確かめてからコピー方式(読む→書く→サイズ照合→元を削除)で行う。
 * - フォルダ: move() が無い(Chrome 未対応)ため常にコピー方式(中身を再帰的にコピー→
 *   件数照合→元を削除)。
 * - 大文字小文字だけの変更(例: a.md → A.md)は、Windows では同じファイルを指すため
 *   一時名を経由する2段階で行う(move・コピーとも)。
 *
 * @param {*} root
 * @param {string} path ルート相対パス(変更前)
 * @param {string} newName 新しい名前(パス区切りを含まない)
 * @param {{ onProgress?: (p: { current: number, total: number }) => void }} [opts]
 * @returns {Promise<{ path: string, method: 'move' | 'copy' | 'noop' }>}
 */
export async function renameEntry(root, path, newName, { onProgress } = {}) {
  const dirPath = dirname(path);
  const oldName = basename(path);
  const newPath = joinPath(dirPath, newName);
  if (newName === oldName) return { path: newPath, method: 'noop' };

  const parentDir = await getDirHandle(root, dirPath, { create: false });

  // 同名チェック(大文字小文字を区別しない)。existingName === oldName のときは
  // 「自分自身」が見つかっただけ(= 大文字小文字だけの変更)なので許可する。
  const existingName = await findEntryName(parentDir, newName);
  if (existingName != null && existingName !== oldName) {
    throw new AlreadyExistsError();
  }
  const caseOnlyChange = existingName === oldName;

  const { kind } = await getEntryHandleAnyKind(parentDir, oldName);
  const method =
    kind === 'file'
      ? await renameFile(parentDir, oldName, newName, { caseOnlyChange })
      : await renameDir(parentDir, oldName, newName, { caseOnlyChange, onProgress });

  return { path: newPath, method };
}
