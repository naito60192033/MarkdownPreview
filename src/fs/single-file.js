// src/fs/single-file.js
//
// ドロップされた md 1 つを「その md だけが入ったワークスペース」に見せるための
// 最小限のディレクトリハンドル(偽物)。
//
// ---- なぜハンドルを装うのか ----
// app.js・fs/workspace.js・watch.js は、どれも「root(ディレクトリハンドル)と
// ルート相対パス」の組で動いている(読み込み・保存・競合検出・外部変更の検知の
// すべて)。単体表示のためにワークスペース無しの経路を別に作ると、これらを
// 二重に実装することになり、片方だけ直す事故が起きる。入口を 1 つに保つため、
// ここで「その 1 ファイルだけを持つフォルダ」を装う。呼び出し側から見ると
// 普通の root なので、openFile / doSave / watcher はそのまま動く。
//
// ---- この偽ハンドルでできないこと(意図的) ----
// - 別のファイルを開く・作る(画像の保存、HTML 出力、新規作成)
//   → NotFoundError か、下の WRITE_DENIED_MESSAGE を持つ Error を投げる。
//     呼び出し側はこれを掴んでステータスバーに出す
// - 相対パスの画像・@import の解決 → NotFoundError になり、
//   readTextByPath / readBlobByPath は null を返す(壊れた画像として出るだけで例外にはならない)
// 画面側は「この md だけを開いている」ことと、上記ができないことを帯で伝えること。
//
// ---- 書き込みの許可 ----
// ドロップで得たハンドルは読み取りだけ許可されていることがある。許可の要求は
// ユーザー操作の直後でないと Chrome に拒否されるため、ドロップ時ではなく
// 「最初に保存しようとしたとき(Ctrl+S / 保存ボタン)」に ensureWritePermission() を
// 呼ぶ。ドロップしただけで許可ダイアログを出さないための設計。

export const WRITE_DENIED_MESSAGE =
  '単体表示では、この md ファイル以外は読み書きできません。フォルダを開いてください';

function notFound(name) {
  // fs/workspace.js は e.name === 'NotFoundError' を見て「無い」と判断する
  // (readTextByPath / readBlobByPath が null を返す条件)。同じ名前で投げる。
  return new DOMException(`${name} は見つかりません`, 'NotFoundError');
}

/**
 * 1 つの FileSystemFileHandle を、それだけが入ったフォルダとして見せる。
 * @param {FileSystemFileHandle} fileHandle ドロップされた md のハンドル
 * @returns {object} root として使えるオブジェクト(FileSystemDirectoryHandle 相当の最小実装)
 */
export function createSingleFileRoot(fileHandle) {
  const fileName = fileHandle.name;

  return {
    kind: 'directory',
    // ツリーには出さないが、ワークスペース名の表示に使われる可能性があるため入れておく
    name: fileName,
    // 呼び出し側が単体表示だと判定するための印(app.js が画面の出し分けに使う)
    isSingleFile: true,
    fileName,

    async getFileHandle(name, { create = false } = {}) {
      if (name === fileName) return fileHandle;
      if (create) throw new Error(WRITE_DENIED_MESSAGE);
      throw notFound(name);
    },

    async getDirectoryHandle(name, { create = false } = {}) {
      if (create) throw new Error(WRITE_DENIED_MESSAGE);
      throw notFound(name);
    },

    async removeEntry() {
      throw new Error(WRITE_DENIED_MESSAGE);
    },

    async *values() {
      yield fileHandle;
    },

    async queryPermission() {
      return 'granted';
    },

    async requestPermission() {
      return 'granted';
    },

    /**
     * 保存の直前に呼ぶ。読み取りだけ許可されている場合に、書き込みの許可を求める。
     * ユーザー操作(Ctrl+S・保存ボタン)のハンドラから、他の await より先に呼ぶこと。
     * @returns {Promise<boolean>} 書き込んでよければ true
     */
    async ensureWritePermission() {
      if (typeof fileHandle.queryPermission !== 'function') return true;
      const opts = { mode: 'readwrite' };
      if ((await fileHandle.queryPermission(opts)) === 'granted') return true;
      if (typeof fileHandle.requestPermission !== 'function') return false;
      return (await fileHandle.requestPermission(opts)) === 'granted';
    },
  };
}
