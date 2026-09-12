// src/fs/recent-roots.js
//
// 最近使ったワークスペース(ルートフォルダ)を複数 IndexedDB(workspace.js の
// idbGet/idbSet/idbDelete)に保持し、起動画面の一覧から選べる・切り替えられる
// ようにする。
//
// FileSystemDirectoryHandle(および dev/fake-fs.mjs のフェイクハンドル)は、
// 他のオブジェクトにネストして保存すると構造化複製に失敗する
// (フェイクはメソッドを持つ生オブジェクトのため、ネストした場所までは
// put()/add() の差し替えが追いかけられない)。そのため保存先を分ける:
//   - `root:<id>`     … ハンドルそのもの(値の直下に置く)
//   - `rootMeta:<id>` … { name, addedAt } という JSON 化できるメタ情報
//   - `rootOrder`     … 新しい順の id 配列
//
// 保存件数の上限は MAX_RECENT。超えた分は古い順に IndexedDB から削除する。

import { idbGet, idbSet, idbDelete, ensurePermission } from './workspace.js';

const ORDER_KEY = 'rootOrder';
const MAX_RECENT = 10;

function rootKey(id) {
  return 'root:' + id;
}
function metaKey(id) {
  return 'rootMeta:' + id;
}

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'root-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/** 最近使ったルートの一覧を新しい順で返す({ id, name, addedAt }[])。 */
export async function listRecentRoots() {
  const order = (await idbGet(ORDER_KEY)) || [];
  const out = [];
  for (const id of order) {
    const meta = await idbGet(metaKey(id));
    if (meta) out.push({ id, ...meta });
  }
  return out;
}

/** id からハンドルを取得する(登録が無ければ null)。 */
export async function getRecentRootHandle(id) {
  const handle = await idbGet(rootKey(id));
  return handle || null;
}

/**
 * ハンドルを最近使った一覧に登録/更新する。同じフォルダが既に登録されていれば
 * (isSameEntry で判定)そのエントリを使い回して先頭に移動する。
 * 戻り値: 登録された id。
 */
export async function rememberRoot(handle) {
  const order = (await idbGet(ORDER_KEY)) || [];
  let id = null;
  for (const existingId of order) {
    let existing = null;
    try {
      existing = await idbGet(rootKey(existingId));
    } catch {
      /* noop */
    }
    if (!existing) continue;
    try {
      if (await handle.isSameEntry(existing)) {
        id = existingId;
        break;
      }
    } catch {
      /* noop */
    }
  }
  if (!id) id = newId();

  await idbSet(rootKey(id), handle);
  await idbSet(metaKey(id), { name: handle.name, addedAt: Date.now() });

  const nextOrder = [id, ...order.filter((x) => x !== id)];
  const kept = nextOrder.slice(0, MAX_RECENT);
  const dropped = nextOrder.slice(MAX_RECENT);
  await idbSet(ORDER_KEY, kept);
  for (const dropId of dropped) {
    await idbDelete(rootKey(dropId));
    await idbDelete(metaKey(dropId));
  }
  return id;
}

/** 一覧から取り除く(フォルダ自体・権限には影響しない)。 */
export async function forgetRoot(id) {
  const order = ((await idbGet(ORDER_KEY)) || []).filter((x) => x !== id);
  await idbSet(ORDER_KEY, order);
  await idbDelete(rootKey(id));
  await idbDelete(metaKey(id));
}

/**
 * id のルートに再許可を試みる。requestPermission() はユーザジェスチャを
 * 要求するため、必ずクリック等のイベントハンドラの中で呼ぶこと。
 * 戻り値: 許可されればハンドル、登録が無い/拒否されたら null。
 */
export async function reconnectRoot(id) {
  const handle = await getRecentRootHandle(id);
  if (!handle) return null;
  if (!(await ensurePermission(handle))) return null;
  return handle;
}

/**
 * id のルートが(再許可を求めずに)そのまま使えるかを調べる。
 * 戻り値:
 *   - { ok: true, handle }                        … 許可済みで即座に使える
 *   - { ok: false, needsPermission: true, handle } … 再許可が必要
 *   - { ok: false, needsPermission: false }        … 登録が無い
 */
export async function checkRootPermission(id) {
  const handle = await getRecentRootHandle(id);
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
