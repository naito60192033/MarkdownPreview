// src/fs/paths.js
//
// ワークスペース(ユーザが選んだルートフォルダ)内のパス操作。DOM にも FSA にも依存しない。
// パスは常に「ルートからの相対パス」を '/' 区切りで表す(例: 'docs/a.md')。ルート自身は ''。
// FSA ではルートの外に出られないため、'..' でルートを超えるパスは null を返して呼び出し側に
// エラー表示させる。

/** '\' を '/' にそろえ、'.' と '..' を解決する。ルートを超えたら null。 */
export function normalizePath(p) {
  const out = [];
  for (const seg of String(p ?? '').replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** 拡張子を '.md' のように小文字で返す。無ければ ''。 */
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

/** baseDir(ルート相対のフォルダ)から見た rel を解決する。ルートを超えたら null。 */
export function joinPath(baseDir, rel) {
  return normalizePath(baseDir ? `${baseDir}/${rel}` : rel);
}

/** fromDir(ルート相対のフォルダ)から toPath への相対パス。例: ('a/b', 'a/img/x.png') → '../img/x.png' */
export function relativePath(fromDir, toPath) {
  const from = fromDir ? fromDir.split('/') : [];
  const to = toPath ? toPath.split('/') : [];
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  return [...up, ...to.slice(i)].join('/') || '.';
}

/** http: / data: / mailto: などのスキーム付き、'//' 始まり、'#' 始まりは外部参照(書き換え・読み込みの対象外)。 */
export function isExternalUrl(url) {
  return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(String(url ?? '').trim());
}

/** md のリンク先(`![](ここ)`)として書く表記。空白や括弧を含む場合は CommonMark の `<...>` 形式で囲む。 */
export function toMarkdownLinkDest(ref) {
  return /[\s()]/.test(ref) ? `<${ref}>` : ref;
}

/** md 内の URL を FSA で使えるパスにする: '?' と '#' 以降を落とし、%xx をデコードする(失敗時は元のまま)。 */
export function urlToPath(url) {
  const s = String(url ?? '').trim().replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
