// src/md-table.js
//
// Markdown の GFM 表(パイプテーブル)まわりの純粋関数(DOM・CodeMirror に非依存)。
// 「Excel のセルのコピー(タブ区切りテキスト)を Markdown の表に変換する」
// 「文書中の表の列幅を東アジアの文字幅を考慮して揃え直す」の2つを提供する。
//
// - displayWidth: 東アジアの全角文字を2、結合文字・ゼロ幅文字を0として数える表示幅。
// - parseTsv / isTsvTable / tsvToMarkdownTable: Excel の text/plain(タブ区切り)を扱う。
// - formatMarkdownTables: 文書中の GFM の表をすべて整形し直す(冪等)。

// ---------- displayWidth ----------

// 表示幅2(全角)とみなすコードポイント範囲。CJK 統合漢字・ひらがな・カタカナ・
// ハングル・全角記号・絵文字など。
const WIDE_RANGES = [
  [0x1100, 0x115f], // ハングル字母
  [0x2e80, 0xa4cf], // CJK部首補助〜彝(い)字母(この中にCJK記号・ひらがな・カタカナ・CJK統合漢字を含む)
  [0x3000, 0x303e], // CJK の記号・句読点(上の範囲と重複するが明示しておく)
  [0xac00, 0xd7a3], // ハングル音節
  [0xf900, 0xfaff], // CJK互換漢字
  [0xfe30, 0xfe4f], // CJK互換形
  [0xff01, 0xff60], // 全角英数・記号
  [0xffe0, 0xffe6], // 全角記号(全角通貨記号等)
  [0x1f300, 0x1f64f], // 絵文字(その他の記号と絵文字・顔文字)
  [0x1f900, 0x1f9ff], // 絵文字(補助記号と絵文字)
  [0x20000, 0x3fffd], // CJK統合漢字拡張B以降
];

// 表示幅0とみなすコードポイント範囲。結合文字・ゼロ幅文字。
const ZERO_RANGES = [
  [0x0300, 0x036f], // 結合文字(ダイアクリティカルマーク)
  [0x200b, 0x200f], // ゼロ幅スペース等
  [0xfe00, 0xfe0f], // 異体字セレクタ(ゼロ幅)
];

function inRanges(cp, ranges) {
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return true;
  }
  return false;
}

/**
 * 1文字(コードポイント)の表示幅(0/1/2)。
 * @param {number} cp
 * @returns {number}
 */
function codePointWidth(cp) {
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1; // 半角カナ(U+FF61–FF9F)を含むその他は1
}

/**
 * 文字列の表示幅(コードポイント単位。サロゲートペアも1文字として数える)。
 * @param {string} str
 * @returns {number}
 */
export function displayWidth(str) {
  let width = 0;
  for (const ch of str) {
    width += codePointWidth(ch.codePointAt(0));
  }
  return width;
}

// ---------- TSV(Excel の text/plain) ----------

/**
 * Excel の text/plain(タブ区切り)を行×列の配列に変換する。
 * CRLF は LF に統一し、末尾の改行を1つだけ除く。
 * `"` で始まるセルは引用セルとして扱い、`""` は `"` 1文字に、引用内のタブ・改行は
 * セルの一部として取り込む。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseTsv(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const src = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/**
 * 貼り付けようとしたテキストが(末尾の改行を除いて)タブを含むかどうか
 * = Excel から複数セルをコピーした表とみなせるか。
 * @param {string} text
 * @returns {boolean}
 */
export function isTsvTable(text) {
  if (typeof text !== 'string' || text === '') return false;
  const normalized = text.replace(/\r\n/g, '\n');
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.includes('\t');
}

// ---------- 表の整形(共通のレンダリング) ----------

// セルを列幅まで空白で詰める(右寄せは左に、中央は両側に、それ以外(左寄せ相当)は右に)。
function padCell(text, width, align) {
  const gap = Math.max(0, width - displayWidth(text));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

// 区切り行の1セル分(配置の `:` を含めて列幅ちょうど)。
function separatorCell(width, align) {
  if (align === 'left') return ':' + '-'.repeat(Math.max(1, width - 1));
  if (align === 'right') return '-'.repeat(Math.max(1, width - 1)) + ':';
  if (align === 'center') return ':' + '-'.repeat(Math.max(1, width - 2)) + ':';
  return '-'.repeat(width);
}

/**
 * 行×列のセル(全行同じ列数に揃え済み)と配置指定から、GFM の表のテキスト
 * (行配列。末尾の改行なし)を組み立てる。
 * @param {string[][]} rows 1行目は見出し行
 * @param {(null|'left'|'right'|'center')[]} aligns
 * @param {string} indent 各行の先頭に付ける空白(0〜3個)
 * @returns {string[]} 行の配列(見出し行・区切り行・本文行)
 */
function renderTableLines(rows, aligns, indent = '') {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const widths = [];
  for (let c = 0; c < columnCount; c++) {
    let w = 3;
    for (const row of rows) {
      w = Math.max(w, displayWidth(row[c] || ''));
    }
    widths.push(w);
  }

  const renderRow = (row) =>
    indent + '| ' + widths.map((w, c) => padCell(row[c] || '', w, aligns[c])).join(' | ') + ' |';
  const renderSeparator = () =>
    indent + '| ' + widths.map((w, c) => separatorCell(w, aligns[c])).join(' | ') + ' |';

  const lines = [renderRow(rows[0] || [])];
  lines.push(renderSeparator());
  for (const row of rows.slice(1)) lines.push(renderRow(row));
  return lines;
}

/**
 * Excel の text/plain(タブ区切り)を GFM の表(整形済み、末尾の改行なし)に変換する。
 * 1行目を見出し行にする。列数は全行の最大、足りないセルは空。セル内の改行は `<br>`、
 * `|` は `\|` にエスケープし、前後の空白は trim する。
 * @param {string} text
 * @returns {string}
 */
export function tsvToMarkdownTable(text) {
  const formatCell = (raw) => raw.trim().replace(/\n/g, '<br>').replace(/\|/g, '\\|');
  const rows = parseTsv(text).map((row) => row.map(formatCell));
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const padded = rows.map((row) => {
    const copy = row.slice();
    while (copy.length < columnCount) copy.push('');
    return copy;
  });
  const aligns = new Array(columnCount).fill(null);
  return renderTableLines(padded, aligns).join('\n');
}

/**
 * 表などのブロック(block、末尾の改行なし)を text の from〜to に置き換えて挿入するときの
 * 挿入文字列を返す。前後の段落とつながって 1 つのブロックにならないよう、
 * - カーソルの前に同じ行の文字があれば空行を挟む。行頭で、前の行が空行でなければ改行を 1 つ足す
 * - カーソルの後に同じ行の文字があれば空行を挟む。行末で、次の行が空行でなければ空行になるよう改行を足す
 * @param {string} text 挿入前の文書全体
 * @param {number} from
 * @param {number} to
 * @param {string} block
 * @returns {string}
 */
export function wrapBlockForInsert(text, from, to, block) {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  let lineEnd = text.indexOf('\n', to);
  if (lineEnd < 0) lineEnd = text.length;
  const before = text.slice(lineStart, from);
  const after = text.slice(to, lineEnd);

  let prefix = '';
  if (before.trim() !== '') {
    prefix = '\n\n';
  } else if (lineStart > 0) {
    const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLine = text.slice(prevStart, lineStart - 1);
    prefix = prevLine.trim() === '' ? '' : '\n';
  }

  let suffix;
  if (after.trim() !== '') {
    suffix = '\n\n';
  } else if (lineEnd === text.length) {
    suffix = '\n';
  } else {
    let nextEnd = text.indexOf('\n', lineEnd + 1);
    if (nextEnd < 0) nextEnd = text.length;
    const nextLine = text.slice(lineEnd + 1, nextEnd);
    suffix = nextLine.trim() === '' ? '' : '\n';
  }
  return prefix + block + suffix;
}

// ---------- 文書中の表の整形(formatMarkdownTables) ----------

const SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const QUOTE_LINE_RE = /^\s{0,3}>/;
// 4 個以上の空白かタブで始まる行はインデントされたコードブロック(表ではない)
const INDENTED_CODE_RE = /^( {4,}|\t)/;

// 行の前後の空白を除き、先頭・末尾の `|` を1つずつ外して、直前のバックスラッシュが
// 奇数個でない `|` で分割する。各セルは trim する。
function splitTableRowCells(rawLine) {
  let s = rawLine.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);

  const cells = [];
  let current = '';
  let backslashRun = 0;
  for (const ch of s) {
    if (ch === '\\') {
      current += ch;
      backslashRun++;
      continue;
    }
    if (ch === '|' && backslashRun % 2 === 0) {
      cells.push(current);
      current = '';
      backslashRun = 0;
      continue;
    }
    current += ch;
    backslashRun = 0;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

// 区切り行の1セル(`:--` `--:` `:-:` `---`)から配置を読み取る。
function parseAlign(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

// テキストを行ごとに { text, start, end }(start/end は元テキストでのオフセット。
// end は改行文字を含まない)に分割する。
function splitLinesWithOffsets(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ text: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return lines;
}

// 見出し行・区切り行・本文行(lines のスライス)から整形後のテキスト(行配列を
// '\n' で結合したもの。末尾改行なし)を組み立てる。
function formatTableBlock(blockLines) {
  const [headerLine, separatorLine, ...bodyLines] = blockLines;
  const indentMatch = /^ {0,3}/.exec(headerLine.text);
  const indent = indentMatch ? indentMatch[0] : '';

  const headerCells = splitTableRowCells(headerLine.text);
  const separatorCells = splitTableRowCells(separatorLine.text);
  const bodyCellsList = bodyLines.map((l) => splitTableRowCells(l.text));

  const columnCount = [headerCells, separatorCells, ...bodyCellsList].reduce(
    (max, cells) => Math.max(max, cells.length),
    0
  );

  const pad = (cells) => {
    const copy = cells.slice();
    while (copy.length < columnCount) copy.push('');
    return copy;
  };

  const rows = [pad(headerCells), ...bodyCellsList.map(pad)];
  const aligns = new Array(columnCount).fill(null);
  for (let c = 0; c < Math.min(columnCount, separatorCells.length); c++) {
    aligns[c] = parseAlign(separatorCells[c]);
  }

  return renderTableLines(rows, aligns, indent).join('\n');
}

/**
 * 元テキストの changes(昇順・重なりなし)を適用した結果のテキストを返す。
 * @param {string} text
 * @param {{ from: number, to: number, insert: string }[]} changes
 * @returns {string}
 */
function applyChanges(text, changes) {
  let result = '';
  let last = 0;
  for (const c of changes) {
    result += text.slice(last, c.from) + c.insert;
    last = c.to;
  }
  result += text.slice(last);
  return result;
}

/**
 * 文書中の GFM の表をすべて整形する(列幅を東アジアの文字幅を考慮して揃え直す)。
 * フェンスコードブロック(``` / ~~~)の中、行頭が `>` の行(引用)は対象外。
 * @param {string} text
 * @returns {{ text: string, changes: { from: number, to: number, insert: string }[], count: number }}
 */
export function formatMarkdownTables(text) {
  const lines = splitLinesWithOffsets(text);
  const changes = [];
  let fence = null; // { char, len }
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (fence) {
      const m = FENCE_CLOSE_RE.exec(line.text);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
      i++;
      continue;
    }

    const fenceOpen = FENCE_OPEN_RE.exec(line.text);
    if (fenceOpen) {
      fence = { char: fenceOpen[1][0], len: fenceOpen[1].length };
      i++;
      continue;
    }

    if (QUOTE_LINE_RE.test(line.text)) {
      i++;
      continue;
    }

    const next = lines[i + 1];
    // GFM と同じく、見出し行と区切り行のセル数が一致するときだけ表とみなす
    // (`a | b` の次の行が `---` なら表ではなく見出し(setext)なので触らない)。
    // 区切り行に `|` が無いもの(`---` だけ)も対象外にする(安全側)。
    const isHeaderCandidate =
      line.text.includes('|') && line.text.trim() !== '' && !INDENTED_CODE_RE.test(line.text);
    if (
      isHeaderCandidate &&
      next &&
      next.text.includes('|') &&
      SEPARATOR_RE.test(next.text) &&
      splitTableRowCells(line.text).length === splitTableRowCells(next.text).length
    ) {
      let j = i + 2;
      const bodyLines = [];
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.text.trim() === '' || !bl.text.includes('|') || QUOTE_LINE_RE.test(bl.text)) break;
        bodyLines.push(bl);
        j++;
      }
      const blockLines = [line, next, ...bodyLines];
      const from = blockLines[0].start;
      const to = blockLines[blockLines.length - 1].end;
      const insert = formatTableBlock(blockLines);
      if (insert !== text.slice(from, to)) {
        changes.push({ from, to, insert });
      }
      i = j;
      continue;
    }

    i++;
  }

  return { text: applyChanges(text, changes), changes, count: changes.length };
}
