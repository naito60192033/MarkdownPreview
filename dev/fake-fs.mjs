// dev/fake-fs.mjs
//
// `window.showDirectoryPicker` のフェイク実装。ヘッドレス Chromium はネイティブの
// フォルダ選択ダイアログを操作できないため、File System Access API のハンドル群を
// プレーンな JS オブジェクトで再現し、実体は Node 側の実ディレクトリ(`opts.rootDir`)
// に置く。複数ページ(= 複数クライアント)が同じ `rootDir` を共有すれば、同時編集の
// 挙動を実ファイルシステム越しに検証できる。
//
// task-kanri の dev/fake-fs.mjs をベースに、mdpreview では画像(PNG)を扱うため
// バイナリ対応を追加している: Node ⇔ ページ間のファイル本文は常に base64 文字列で
// やり取りし、ページ側の `getFile()` は `text()` / `arrayBuffer()` の両方を持つ
// File 相当のオブジェクトを返す。`createWritable().write()` は Blob / ArrayBuffer /
// TypedArray / 文字列 / WriteParams(`{type:'write', data}`)のいずれも受け付ける。
//
// 実装方針:
//   - `context.exposeBinding('__fsCall', ...)` でページ→Node のファイル操作を
//     `node:fs/promises` にルーティングする。
//   - `context.addInitScript(...)` でアプリのスクリプトより先に
//     `window.showDirectoryPicker` を定義する。
//   - `FileSystemDirectoryHandle` は本来構造化複製可能だが、フェイクはただの
//     オブジェクトなので `IndexedDB.put()` に渡すと `DataCloneError` になる。
//     これを避けるため `IDBObjectStore.prototype.put/add` と
//     `IDBRequest.prototype.result` を差し替え、フェイクハンドルを
//     プレーンな記述子 `{ __fakeDirHandleMarker, relPath, name }` として保存し、
//     読み出し時にメソッド付きのハンドルへ復元する。
//   - 実際の Chrome は SMB 上で「他クライアントがファイルに触れた直後の
//     createWritable().close()」を "state had changed" (InvalidStateError) で
//     失敗させることがある。アプリはこれを `fh.getFile()`(mtime キャッシュの
//     更新)→ `createWritable()` → `close()` という手順で検知・対処する設計に
//     なっているため、フェイクも世代カウンタ(`fileGenerations`)で同じ挙動を
//     再現する: `getFile()` 時点で観測した世代と、実際に `close()` で書き込む
//     時点の最新世代がズレていれば InvalidStateError を投げる。これにより
//     同時編集テストが `withRetry`/`mutate` の再試行を正しく駆動できる。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ファイルパス(絶対パス)→世代番号。テストごとに rootDir が異なるためキーは
// 衝突しない。モジュールスコープで持ち、`write` 呼び出しを同期的に
// 検査・予約することで、await をまたぐ TOCTOU レースを避ける。
const fileGenerations = new Map();

// ファイルパス→直列化用の Promise チェーン。read と write を同じロックで
// 直列化して、(内容, 世代番号) の組が常に一貫して観測されるようにする。
// これが無いと、write が rename を終える前に世代番号だけ進むため、並行する
// 読み手が「新しい世代番号 + 古い内容」を観測してしまい、本来検出すべき
// 競合が検出されずに上書きが通ってしまう。実際の SMB では rename は
// アトミックで、読み手は必ず新旧どちらか一方の状態を見る。
const fileLocks = new Map();

function withFileLock(filePath, fn) {
  const prev = fileLocks.get(filePath) || Promise.resolve();
  const next = prev.then(fn, fn);
  // ロック解放のためだけのチェーン。fn の失敗で連鎖が止まらないようにする。
  fileLocks.set(filePath, next.then(() => {}, () => {}));
  return next;
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ rootDir: string, fault?: { rate?: number, ops?: string[] } }} opts
 */
export async function installFakeFs(context, opts) {
  const { rootDir } = opts;
  if (!rootDir) throw new Error('installFakeFs: opts.rootDir is required');

  const faultState = {
    rate: opts.fault?.rate ?? 0,
    ops: opts.fault?.ops ?? ['close'],
  };

  // op ごとの人工的な遅延(ms)。実行自体は呼び出された時点で即座に行い(その時点の
  // ディスク状態を捕まえる)、結果が呼び出し元に返るまでの時間だけを遅らせる
  // (実際の SMB 越しの遅い応答に近いモデル)。
  // 同時編集のレースは、ページ間のタイミングのゆらぎ次第で「片方が完全に終わって
  // から他方が始まる」ことがあり、そのままでは競合が起きたり起きなかったりする。
  // read を意図的に遅らせると、両ページが確実に「同じ古い内容」を読んだうえで
  // 書きに行くので、競合が決定的に再現する。
  // また、「読み込みは先に始まったが結果が届くのは後(その間に別の書き込みが
  // 完了する)」というレース(src/watch.js の確認処理と保存の競合)も、この
  // 「実行は即座・結果到着だけ遅延」という順序があるからこそ決定的に再現できる
  // (実行を遅らせてから読むと、結果は常にそのときの最新内容になってしまい、
  // 古い内容が「届く」状況を作れない)。
  const delayState = { ...(opts.delay || {}) };

  const rootName = path.basename(rootDir) || 'shared';

  // ---------- Node 側: ページからのファイル操作をルーティング ----------
  // 実行(handleFsCall)は即座に開始する。delay はその「結果を返すタイミング」
  // だけを遅らせる(呼び出しごとに delayState[op] をその時点の値で固定するので、
  // 実行中に setDelay() で値を変えても、既に発行済みの呼び出しには影響しない)。
  await context.exposeBinding('__fsCall', async (_source, op, args) => {
    const resultPromise = handleFsCall(rootDir, op, args || []);
    const d = delayState[op];
    if (d > 0) {
      const [result] = await Promise.all([resultPromise, new Promise((r) => setTimeout(r, d))]);
      return result;
    }
    return resultPromise;
  });

  await context.exposeBinding('__fsSetFault', async (_source, next) => {
    if (typeof next?.rate === 'number') faultState.rate = next.rate;
    if (Array.isArray(next?.ops)) faultState.ops = next.ops;
    return { rate: faultState.rate, ops: faultState.ops };
  });

  await context.exposeBinding('__fsSetDelay', async (_source, next) => {
    for (const k of Object.keys(next || {})) delayState[k] = next[k];
    return { ...delayState };
  });

  await context.exposeBinding('__fsShouldFault', async (_source, op) => {
    if (!faultState.ops.includes(op)) return false;
    return Math.random() < faultState.rate;
  });

  // ---------- ページ側: showDirectoryPicker と IDB 差し替え ----------
  await context.addInitScript(initPageFakeFs, { rootName });

  return {
    // Node 側からもフォールト率を直接いじれるようにしておく(テストの便宜)。
    setFault(next) {
      if (typeof next?.rate === 'number') faultState.rate = next.rate;
      if (Array.isArray(next?.ops)) faultState.ops = next.ops;
    },
    setDelay(next) {
      for (const k of Object.keys(next || {})) delayState[k] = next[k];
    },
  };
}

// ---------- Node 側の実ファイル操作 ----------
// ファイル本文は常に base64 文字列でページとやり取りする(テキスト/バイナリを
// 区別せず同じ経路で扱えるようにするため)。
async function handleFsCall(rootDir, op, args) {
  try {
    switch (op) {
      case 'list': {
        const [relDir] = args;
        const dirPath = resolveSafe(rootDir, relDir || '');
        const entries = await fs.readdir(dirPath);
        return { ok: true, entries };
      }
      case 'stat': {
        const [relPath] = args;
        const filePath = resolveSafe(rootDir, relPath);
        try {
          const st = await fs.stat(filePath);
          return { ok: true, isDirectory: st.isDirectory(), isFile: st.isFile() };
        } catch (e) {
          if (e.code === 'ENOENT') return { ok: false, code: 'NotFoundError' };
          throw e;
        }
      }
      case 'read': {
        const [relPath] = args;
        const filePath = resolveSafe(rootDir, relPath);
        return withFileLock(filePath, async () => {
          try {
            const [buf, st] = await Promise.all([
              fs.readFile(filePath),
              fs.stat(filePath),
            ]);
            const gen = fileGenerations.get(filePath) || 0;
            return { ok: true, dataB64: buf.toString('base64'), lastModified: st.mtimeMs, size: st.size, gen };
          } catch (e) {
            if (e.code === 'ENOENT') return { ok: false, code: 'NotFoundError' };
            throw e;
          }
        });
      }
      case 'write': {
        const [relPath, dataB64, expectedGen] = args;
        const filePath = resolveSafe(rootDir, relPath);
        return withFileLock(filePath, async () => {
          const curGen = fileGenerations.get(filePath) || 0;
          if (typeof expectedGen === 'number' && expectedGen !== curGen) {
            return { ok: false, code: 'InvalidStateError', message: 'The file or directory state had changed' };
          }
          const buf = Buffer.from(dataB64 || '', 'base64');
          const tmpPath = filePath + '.tmp-' + crypto.randomUUID();
          await fs.writeFile(tmpPath, buf);
          await fs.rename(tmpPath, filePath);
          // 内容を置き換えてから世代番号を進める。ロック内なので、この間に
          // 読み手が割り込むことはない。
          const nextGen = curGen + 1;
          fileGenerations.set(filePath, nextGen);
          return { ok: true, gen: nextGen };
        });
      }
      case 'remove': {
        const [relPath] = args;
        const filePath = resolveSafe(rootDir, relPath);
        try {
          await fs.unlink(filePath);
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        fileGenerations.delete(filePath);
        return { ok: true };
      }
      case 'mkdir': {
        const [relPath] = args;
        const dirPath = resolveSafe(rootDir, relPath);
        await fs.mkdir(dirPath, { recursive: true });
        return { ok: true };
      }
      default:
        return { ok: false, code: 'UnknownError', message: 'unknown op: ' + op };
    }
  } catch (e) {
    return { ok: false, code: 'UnknownError', message: String((e && e.message) || e) };
  }
}

function resolveSafe(rootDir, relPath) {
  const p = path.resolve(rootDir, relPath || '.');
  // rootDir の外に出るパスは拒否(フェイクの前提を壊す誤操作を早期に検出する)。
  if (p !== rootDir && !p.startsWith(rootDir + path.sep)) {
    throw new Error('path escapes rootDir: ' + relPath);
  }
  return p;
}

// ---------- ページに注入する初期化スクリプト ----------
// Playwright が `(${initPageFakeFs})(arg)` の形でシリアライズして評価するため、
// このスコープの外側の変数(Node 側クロージャ)を参照してはいけない。
function initPageFakeFs({ rootName }) {
  function makeError(name, message) {
    const e = new Error(message || name);
    e.name = name;
    return e;
  }

  function joinRel(base, name) {
    return base ? base + '/' + name : name;
  }

  async function maybeFault(op) {
    const should = await window.__fsShouldFault(op);
    if (should) {
      const e = new Error('The file or directory state had changed');
      e.name = 'InvalidStateError';
      throw e;
    }
  }

  // ---------- バイナリ⇔base64 変換ヘルパー ----------
  // Node とページの間はファイル本文を base64 文字列で受け渡す。テキストも
  // バイナリも同じ経路にすることで、write() が受け取れる型(Blob / ArrayBuffer /
  // TypedArray / 文字列)を統一的に扱える。
  async function toBytes(data) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    return new TextEncoder().encode(String(data));
  }

  function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function guessMimeType(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      md: 'text/markdown',
      markdown: 'text/markdown',
      txt: 'text/plain',
      html: 'text/html',
      htm: 'text/html',
      css: 'text/css',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    };
    return map[ext] || '';
  }

  function makeFileHandle(relPath, name) {
    // 直近の getFile() で観測した世代番号。createWritable().close() 時にこれを
    // Node へ渡し、書き込み直前の最新世代とズレていれば競合とみなす。
    // (`writeData` が createWritable() の直前に getFile() を呼ぶ前提に対応)
    let observedGen = null;
    return {
      kind: 'file',
      name,
      async getFile() {
        const res = await window.__fsCall('read', [relPath]);
        if (!res.ok) throw makeError(res.code || 'NotFoundError', 'not found: ' + relPath);
        observedGen = typeof res.gen === 'number' ? res.gen : null;
        const bytes = base64ToBytes(res.dataB64);
        const type = guessMimeType(name);
        // 本物の File(Blob のサブクラス)を返す。実際の FSA の getFile() も File を
        // 返すため、URL.createObjectURL() 等がそのまま使える(手組みのオブジェクトだと
        // "Overload resolution failed" で弾かれ、blob URL 化のテストができない)。
        return new File([bytes], name, { type, lastModified: res.lastModified });
      },
      async createWritable() {
        const chunks = [];
        const genAtOpen = observedGen;
        return {
          async write(input) {
            let data = input;
            // WriteParams 形式 { type: 'write', data, position }。
            if (
              data &&
              typeof data === 'object' &&
              !(typeof Blob !== 'undefined' && data instanceof Blob) &&
              !(data instanceof ArrayBuffer) &&
              !ArrayBuffer.isView(data) &&
              'data' in data
            ) {
              data = data.data;
            }
            chunks.push(await toBytes(data));
          },
          async close() {
            await maybeFault('close');
            const b64 = bytesToBase64(concatBytes(chunks));
            const res = await window.__fsCall('write', [relPath, b64, genAtOpen]);
            if (!res.ok) {
              throw makeError(
                res.code || 'UnknownError',
                res.message || (res.code === 'InvalidStateError' ? 'The file or directory state had changed' : 'write failed')
              );
            }
          },
          async abort() {
            // フェイクでは close() 前は何もディスクに反映していないので noop でよい。
          },
        };
      },
      async isSameEntry(other) {
        return !!other && other.kind === 'file' && other.name === name;
      },
    };
  }

  function makeDirHandle(relPath, name) {
    const self = {
      kind: 'directory',
      name,
      __isFakeDirHandle: true,
      __relPath: relPath,
      async queryPermission() {
        return 'granted';
      },
      async requestPermission() {
        return 'granted';
      },
      async getFileHandle(fileName, options) {
        const opts = options || {};
        await maybeFault('getFileHandle');
        const childRel = joinRel(relPath, fileName);
        const statRes = await window.__fsCall('stat', [childRel]);
        if (statRes.ok) {
          if (statRes.isDirectory) throw makeError('TypeMismatchError', fileName + ' is a directory');
          return makeFileHandle(childRel, fileName);
        }
        if (!opts.create) throw makeError('NotFoundError', 'not found: ' + fileName);
        const w = await window.__fsCall('write', [childRel, '']);
        if (!w.ok) throw makeError(w.code || 'UnknownError', w.message || 'failed to create');
        return makeFileHandle(childRel, fileName);
      },
      async getDirectoryHandle(dirName, options) {
        const opts = options || {};
        const childRel = joinRel(relPath, dirName);
        const statRes = await window.__fsCall('stat', [childRel]);
        if (!statRes.ok) {
          if (!opts.create) throw makeError('NotFoundError', 'not found: ' + dirName);
          await window.__fsCall('mkdir', [childRel]);
        } else if (!statRes.isDirectory) {
          throw makeError('TypeMismatchError', dirName + ' is a file');
        }
        return makeDirHandle(childRel, dirName);
      },
      async removeEntry(entryName) {
        const childRel = joinRel(relPath, entryName);
        const res = await window.__fsCall('remove', [childRel]);
        if (!res.ok) throw makeError(res.code || 'UnknownError', res.message || 'remove failed');
      },
      async isSameEntry(other) {
        return !!other && other.kind === 'directory' && other.__relPath === relPath;
      },
      keys() {
        return (async function* () {
          const res = await window.__fsCall('list', [relPath]);
          for (const name of res.entries || []) yield name;
        })();
      },
      values() {
        return (async function* () {
          const res = await window.__fsCall('list', [relPath]);
          for (const name of res.entries || []) {
            const childRel = joinRel(relPath, name);
            const st = await window.__fsCall('stat', [childRel]);
            if (st.ok && st.isDirectory) yield makeDirHandle(childRel, name);
            else yield makeFileHandle(childRel, name);
          }
        })();
      },
      entries() {
        return (async function* () {
          for await (const v of self.values()) yield [v.name, v];
        })();
      },
      [Symbol.asyncIterator]() {
        return self.entries();
      },
    };
    return self;
  }

  window.showDirectoryPicker = async function () {
    // ヘッドレスではネイティブダイアログを出せないので、常に rootDir 直下を返す。
    return makeDirHandle('', rootName);
  };

  window.__fakeFs = {
    async setFault(next) {
      return window.__fsSetFault(next);
    },
    async setDelay(next) {
      return window.__fsSetDelay(next);
    },
  };

  // ---------- IndexedDB: フェイクハンドルを構造化複製可能にする ----------
  const put = (obj, orig) =>
    function (...args) {
      if (args[0] && typeof args[0] === 'object' && args[0].__isFakeDirHandle) {
        args[0] = { __fakeDirHandleMarker: true, relPath: args[0].__relPath, name: args[0].name };
      }
      return orig.apply(this, args);
    };

  if (window.IDBObjectStore) {
    const origPut = window.IDBObjectStore.prototype.put;
    const origAdd = window.IDBObjectStore.prototype.add;
    window.IDBObjectStore.prototype.put = put(window.IDBObjectStore.prototype, origPut);
    window.IDBObjectStore.prototype.add = put(window.IDBObjectStore.prototype, origAdd);
  }

  if (window.IDBRequest) {
    const resultDesc = Object.getOwnPropertyDescriptor(window.IDBRequest.prototype, 'result');
    if (resultDesc && resultDesc.get) {
      Object.defineProperty(window.IDBRequest.prototype, 'result', {
        configurable: true,
        enumerable: resultDesc.enumerable,
        get() {
          const v = resultDesc.get.call(this);
          if (v && typeof v === 'object' && v.__fakeDirHandleMarker) {
            return makeDirHandle(v.relPath, v.name);
          }
          return v;
        },
      });
    }
  }
}
