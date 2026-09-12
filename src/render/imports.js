// src/render/imports.js
//
// `@import "x.md"` の展開。DOM にも FSA にも依存しない純粋な ES モジュール。
// パスはすべて src/fs/paths.js の規約(ワークスペースのルートからの相対パス、
// '/' 区切り)に従う。
//
// 対応する行の形式:
//   @import "path.md"            (行頭。後ろに {...} の属性があってもよい)
//   <!-- @import "path.md" -->
// `"[TOC]"` はここでは対象外(toc.js が扱う)。コードブロック(``` / ~~~)の
// 中は対象外。

import { dirname, extname, joinPath, relativePath, isExternalUrl } from '../fs/paths.js';

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

const TOC_IMPORT_RE = /^\s*(?:@import\s+"\[TOC\]"\s*(?:\{[^}]*\})?|<!--\s*@import\s+"\[TOC\]"\s*(?:\{[^}]*\})?\s*-->)\s*$/i;
const IMPORT_RE = /^\s*@import\s+"([^"]+)"\s*;?\s*(?:\{[^}]*\})?\s*$/;
const IMPORT_COMMENT_RE = /^\s*<!--\s*@import\s+"([^"]+)"\s*-->\s*$/;

function splitLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorDiv(rawPath, reason) {
  return `<div class="mdp-import-error">@import "${escapeHtmlAttr(rawPath)}": ${reason}</div>`;
}

// url の末尾の ?query / #fragment を切り離す(パス部分だけ書き換えるため)。
function splitUrlSuffix(u) {
  const m = u.match(/^([^?#]*)([?#].*)?$/);
  return [m[1], m[2] || ''];
}

// 1 つの URL トークン(`<...>` で囲まれている場合はそれも含む)を、
// fromDir 基準から toDir 基準の相対パスに書き換える。外部 URL・'/' 始まり・
// ルート外を指すものはそのまま返す。
function rewriteUrlToken(token, fromDir, toDir) {
  const angled = token.startsWith('<') && token.endsWith('>') && token.length >= 2;
  const raw = angled ? token.slice(1, -1) : token;
  const [pathPart, suffix] = splitUrlSuffix(raw);
  if (!pathPart || isExternalUrl(pathPart) || pathPart.startsWith('/')) return token;
  const abs = joinPath(fromDir, pathPart);
  if (abs === null) return token;
  const rewritten = relativePath(toDir, abs) + suffix;
  return angled ? `<${rewritten}>` : rewritten;
}

// 取り込んだ md 本文中の相対 URL を、fromDir(取り込んだファイルのフォルダ)基準
// から toDir(最上位の md のフォルダ)基準に書き換える。コードブロックの中は
// 対象外。対象: `](url)` / `](<url>)`、`[id]: url` の参照定義、
// `src="..."` / `href="..."`。
function rewriteRelativeUrls(text, fromDir, toDir) {
  if (fromDir === toDir) return text;
  const lines = splitLines(text);
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  const out = lines.map((line) => {
    const fm = line.match(FENCE_RE);
    if (!inFence && fm) {
      inFence = true;
      fenceChar = fm[1][0];
      fenceLen = fm[1].length;
      return line;
    }
    if (inFence) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) inFence = false;
      return line;
    }

    let result = line.replace(/(\]\()\s*(<[^>]*>|[^\s)]+)/g, (whole, pre, url) =>
      pre + rewriteUrlToken(url, fromDir, toDir),
    );

    const refMatch = result.match(/^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)/);
    if (refMatch) {
      result = refMatch[1] + rewriteUrlToken(refMatch[2], fromDir, toDir) + result.slice(refMatch[0].length);
    }

    result = result.replace(/\b(src|href)=(["'])([^"']*)\2/g, (whole, attr, q, url) => {
      return `${attr}=${q}${rewriteUrlToken(url, fromDir, toDir)}${q}`;
    });

    return result;
  });

  return out.join('\n');
}

/**
 * `@import "x.md"` を再帰的に展開する。
 *
 * @param {string} text 展開対象のテキスト(最上位の md のソース)
 * @param {{
 *   path: string,
 *   readText: (relPath: string) => Promise<string|null>,
 *   maxDepth?: number,
 * }} opts
 *   path: text のルート相対パス。readText: ルート相対パスを渡すと本文
 *   (見つからなければ null)を返す非同期関数。maxDepth: @import の入れ子の
 *   最大深さ(既定 10。最上位を深さ 0 として、これを超えるとエラー)。
 * @returns {Promise<{text: string, lineMap: number[], deps: string[], errors: {line: number, path: string, reason: string}[]}>}
 */
export async function expandImports(text, { path, readText, maxDepth = 10 }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const topDir = dirname(path);
  const deps = new Set();
  const errors = [];

  async function expand(content, filePath, depth, forcedLine, ancestors) {
    const dir = dirname(filePath);
    const lines = splitLines(content);
    const outLines = [];
    const outMap = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;

    const pushPlain = (line, mapped) => {
      outLines.push(line);
      outMap.push(mapped);
    };

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const mapped = forcedLine ?? li;
      const fm = line.match(FENCE_RE);

      if (!inFence && fm) {
        inFence = true;
        fenceChar = fm[1][0];
        fenceLen = fm[1].length;
        pushPlain(line, mapped);
        continue;
      }
      if (inFence) {
        if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) inFence = false;
        pushPlain(line, mapped);
        continue;
      }

      if (TOC_IMPORT_RE.test(line)) {
        pushPlain(line, mapped);
        continue;
      }

      const m = line.match(IMPORT_RE) || line.match(IMPORT_COMMENT_RE);
      if (!m) {
        pushPlain(line, mapped);
        continue;
      }

      const rawPath = m[1].trim();
      const resolved = joinPath(dir, rawPath);
      let reason = null;
      if (resolved === null) {
        reason = 'ワークスペースの外を指しています';
      } else {
        const ext = extname(resolved);
        if (ext !== '.md' && ext !== '.markdown') {
          reason = '.md / .markdown 以外は対象外です';
        } else if (ancestors.has(resolved)) {
          reason = '循環参照です';
        } else if (depth + 1 > maxDepth) {
          reason = `@import の深さの上限(${maxDepth})を超えました`;
        }
      }

      if (reason) {
        errors.push({ line: mapped, path: rawPath, reason });
        pushPlain(errorDiv(rawPath, reason), mapped);
        pushPlain('', mapped);
        continue;
      }

      const fileContent = await readText(resolved);
      if (fileContent == null) {
        const notFoundReason = '見つかりません';
        errors.push({ line: mapped, path: rawPath, reason: notFoundReason });
        pushPlain(errorDiv(rawPath, notFoundReason), mapped);
        pushPlain('', mapped);
        continue;
      }

      deps.add(resolved);
      const rewritten = rewriteRelativeUrls(fileContent, dirname(resolved), topDir);
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(resolved);
      const child = await expand(rewritten, resolved, depth + 1, mapped, nextAncestors);
      for (let k = 0; k < child.lines.length; k++) {
        outLines.push(child.lines[k]);
        outMap.push(child.map[k]);
      }
    }

    return { lines: outLines, map: outMap };
  }

  const result = await expand(text, path, 0, null, new Set([path]));

  return {
    text: result.lines.join(eol),
    lineMap: result.map,
    deps: [...deps],
    errors,
  };
}
