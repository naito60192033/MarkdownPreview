// src/annotator/pngmeta.js
//
// PNG チャンクを扱う純粋な関数群。DOM に一切依存しないので node:test から
// そのまま検証できる(ブラウザ・Node のどちらでも同じように動く)。
//
// annotator.js はこのモジュールを使って、注釈データ(JSON)を iTXt チャンクに、
// 元画像のバイト列を独自チャンク mdOR に埋め込み、IEND の直前に挿入する。
// 既に同名のチャンクがあれば置き換える(重複させない)。

// ---------- PNG シグネチャ ----------
export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** bytes の先頭が PNG シグネチャと一致するかどうか */
export function isPngBytes(bytes) {
  if (!bytes || bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

// ---------- CRC32(PNG 仕様 Appendix のアルゴリズムをそのまま実装) ----------
let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** PNG チャンクの CRC32 を計算する(type+data のバイト列に対して行う) */
export function crc32(bytes) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- チャンクの列挙・構築 ----------

/**
 * PNG バイト列を先頭から走査し、チャンクの配列を返す。
 * 各要素: { type: string(4文字), data: Uint8Array, crc: number }
 * IEND に到達したらそこで走査を終える(以降にゴミが付いていても無視する)。
 */
export function parseChunks(bytes) {
  if (!isPngBytes(bytes)) {
    throw new Error('PNG シグネチャが不正です');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    let type = '';
    for (let i = 0; i < typeBytes.length; i++) type += String.fromCharCode(typeBytes[i]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`チャンク ${type} のデータ長が不正です(ファイルが壊れている可能性があります)`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const crc = view.getUint32(dataEnd, false);
    chunks.push({ type, data, crc });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** type(4文字)と data(Uint8Array)から、length+type+data+crc の1チャンク分のバイト列を作る */
export function buildChunk(type, data) {
  if (type.length !== 4) throw new Error('チャンク種別は4文字である必要があります: ' + type);
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const len = data.length;
  const out = new Uint8Array(4 + 4 + len + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, len, false);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + len);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + len, crc32(crcInput), false);
  return out;
}

/** { type, data } の配列(シグネチャは含めない)から PNG 全体のバイト列を組み立てる */
export function serializeChunks(chunks) {
  const built = chunks.map((c) => buildChunk(c.type, c.data));
  let total = PNG_SIGNATURE.length;
  for (const b of built) total += b.length;
  const out = new Uint8Array(total);
  out.set(PNG_SIGNATURE, 0);
  let offset = PNG_SIGNATURE.length;
  for (const b of built) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

/** 指定した type の最初のチャンクを返す(無ければ null) */
export function findChunk(chunks, type) {
  return chunks.find((c) => c.type === type) || null;
}

/**
 * pngBytes 内のチャンクのうち shouldRemove(chunk) が true のものを取り除き、
 * newChunk({type, data})を IEND の直前に挿入して、新しい PNG バイト列を返す。
 * (「既にあれば置き換え、無ければ挿入」を1つの操作にまとめたもの)
 */
export function replaceOrInsertChunk(pngBytes, newChunk, shouldRemove) {
  const chunks = parseChunks(pngBytes);
  const kept = chunks.filter((c) => !shouldRemove(c));
  const iendIndex = kept.findIndex((c) => c.type === 'IEND');
  const insertAt = iendIndex === -1 ? kept.length : iendIndex;
  const result = [...kept.slice(0, insertAt), { type: newChunk.type, data: newChunk.data }, ...kept.slice(insertAt)];
  return serializeChunks(result);
}

// ---------- iTXt(国際化テキスト)チャンク ----------

function latin1Encode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function latin1Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function concatBytes(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * iTXt チャンクの本文(データ部)を組み立てる。圧縮は使わない(compression flag = 0)。
 * keyword は Latin-1(実質 ASCII)、text は UTF-8 として符号化する。
 */
export function encodeITxt({ keyword, text, languageTag = '', translatedKeyword = '' }) {
  const enc = new TextEncoder();
  const keywordBytes = latin1Encode(keyword);
  const langBytes = latin1Encode(languageTag);
  const translatedBytes = enc.encode(translatedKeyword);
  const textBytes = enc.encode(text);
  const NUL = new Uint8Array([0]);
  return concatBytes([
    keywordBytes,
    NUL,
    new Uint8Array([0]), // compression flag = 0(非圧縮)
    new Uint8Array([0]), // compression method = 0
    langBytes,
    NUL,
    translatedBytes,
    NUL,
    textBytes,
  ]);
}

/** encodeITxt() の逆。iTXt チャンクのデータ部を { keyword, text, ... } に戻す */
export function decodeITxt(data) {
  let i = 0;
  const readUntilNull = () => {
    const start = i;
    while (i < data.length && data[i] !== 0) i++;
    const slice = data.subarray(start, i);
    i++; // NUL を読み飛ばす
    return slice;
  };
  const keywordBytes = readUntilNull();
  const compressionFlag = data[i++];
  const compressionMethod = data[i++];
  const languageTagBytes = readUntilNull();
  const translatedKeywordBytes = readUntilNull();
  const textBytes = data.subarray(i);
  if (compressionFlag !== 0) {
    throw new Error('圧縮された iTXt チャンクには対応していません');
  }
  const dec = new TextDecoder('utf-8');
  return {
    keyword: latin1Decode(keywordBytes),
    compressionFlag,
    compressionMethod,
    languageTag: latin1Decode(languageTagBytes),
    translatedKeyword: dec.decode(translatedKeywordBytes),
    text: dec.decode(textBytes),
  };
}

// ---------- アプリ固有: 注釈データの埋め込み・取り出し ----------

// キーワード・チャンク種別は計画書の指定どおり(呼び出し側と合わせる)
export const ANNOTATION_KEYWORD = 'mdpreview.annotation';
export const ORIGINAL_IMAGE_CHUNK_TYPE = 'mdOR';

/**
 * 注釈データ(JSON。UTF-8 で iTXt に格納)と元画像のバイト列(mdOR に生のまま格納)を
 * PNG に埋め込む。同じキーワード/チャンク種別が既にあれば置き換える(重複させない)。
 */
export function setAnnotationData(pngBytes, { json, originalBytes }) {
  const jsonText = JSON.stringify(json);
  const itxtData = encodeITxt({ keyword: ANNOTATION_KEYWORD, text: jsonText });
  let out = replaceOrInsertChunk(pngBytes, { type: 'iTXt', data: itxtData }, (c) => {
    if (c.type !== 'iTXt') return false;
    try {
      return decodeITxt(c.data).keyword === ANNOTATION_KEYWORD;
    } catch {
      return false;
    }
  });
  out = replaceOrInsertChunk(out, { type: ORIGINAL_IMAGE_CHUNK_TYPE, data: originalBytes }, (c) => c.type === ORIGINAL_IMAGE_CHUNK_TYPE);
  return out;
}

/**
 * setAnnotationData() で埋め込んだデータを取り出す。
 * 両方(または片方)が無ければ null を返す(呼び出し側で「新規画像として扱う」判断に使う)。
 * 戻り値: { json: object|null, originalBytes: Uint8Array|null }
 */
export function getAnnotationData(pngBytes) {
  let chunks;
  try {
    chunks = parseChunks(pngBytes);
  } catch {
    return { json: null, originalBytes: null };
  }
  let json = null;
  let originalBytes = null;
  for (const c of chunks) {
    if (c.type === 'iTXt') {
      try {
        const decoded = decodeITxt(c.data);
        if (decoded.keyword === ANNOTATION_KEYWORD) {
          json = JSON.parse(decoded.text);
        }
      } catch {
        // 壊れた/対象外の iTXt は無視する
      }
    } else if (c.type === ORIGINAL_IMAGE_CHUNK_TYPE) {
      originalBytes = c.data.slice();
    }
  }
  return { json, originalBytes };
}
