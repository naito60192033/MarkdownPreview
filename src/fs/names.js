// src/fs/names.js
//
// ファイル名・フォルダ名の検証(DOM にも FSA にも依存しない純粋関数)。
// Windows の共有フォルダでも問題なく使える名前にすることが目的(このアプリは
// Windows の Chrome から使われる前提)。既存の同名チェック(大文字小文字を区別しない)は
// 実際のディレクトリの中身を見る必要があるため、ここには含めない
// (src/fs/workspace.js の findEntryName を呼び出し側が使う)。

// Windows で使えない文字(制御文字は別途 CONTROL_CHARS で判定する)。
// '/' はパス区切りとして扱われるため、名前1つの中にも許可しない(名前の変更の
// 入力欄はフォルダ移動を許さないため '/' 不可)。
const FORBIDDEN_CHARS = /[\\/:*?"<>|]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;

// Windows の予約デバイス名(拡張子が付いていても、先頭の「.」より前の部分が
// 一致すれば予約名として扱われる)。
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * ファイル名・フォルダ名1つ(パス区切りを含まない)を検証する。
 * @param {string} name
 * @returns {string | null} エラー文言、問題なければ null
 */
export function validateEntryName(name) {
  const n = String(name ?? '');
  if (n === '') return '名前を入力してください';
  if (n === '.' || n === '..') return '「.」「..」という名前は使えません';
  if (FORBIDDEN_CHARS.test(n)) return '次の文字は使えません: \\ / : * ? " < > |';
  if (CONTROL_CHARS.test(n)) return '制御文字は使えません';
  if (n.startsWith('.')) return '「.」で始まる名前は使えません(ツリーに表示されなくなります)';
  if (/[. ]$/.test(n)) return '末尾に「.」や空白は使えません';

  const dot = n.indexOf('.');
  const stem = dot === -1 ? n : n.slice(0, dot);
  if (RESERVED_NAMES.has(stem.toUpperCase())) {
    return `「${stem.toUpperCase()}」は Windows の予約名のため使えません`;
  }
  return null;
}

/**
 * 新規作成モーダルの入力欄(ルート相対パス。途中のフォルダを含んでよい)を検証する。
 * 各区切り('/')ごとに validateEntryName() を適用する。既存の同名チェックは
 * ディレクトリの読み取りが必要なため含まない(呼び出し側で行う)。
 * @param {string} path
 * @returns {string | null} エラー文言、問題なければ null
 */
export function validateCreatePath(path) {
  const raw = String(path ?? '');
  if (raw.startsWith('/')) return '先頭に「/」は使えません';
  const segs = raw.split('/');
  if (segs.length === 0 || segs[segs.length - 1] === '') return '名前を入力してください';
  for (const seg of segs) {
    if (seg === '') return '連続する「/」は使えません';
    const err = validateEntryName(seg);
    if (err) return err;
  }
  return null;
}

/**
 * md の拡張子(.md / .markdown)が付いていなければ .md を付ける
 * (ツリーは .md / .markdown しか表示しないため)。大文字小文字は区別しない。
 * @param {string} name
 * @returns {string}
 */
export function ensureMdExtension(name) {
  const n = String(name ?? '');
  const lower = n.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return n;
  return n + '.md';
}
