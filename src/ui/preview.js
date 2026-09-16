// src/ui/preview.js
//
// プレビュー(iframe srcdoc)の管理。iframe は最初に1度だけ作り、以降は
// 親から本文(<div class="crossnote markdown-preview"> の中身)だけを
// 差し替えることでスクロール位置を保つ。
//
// 担当範囲:
//   - base.css(標準 CSS。設定でオフにできる)→ alerts.css → outline.css →
//     markbox.css → style.css の順で <style> に反映(outline.css は見出しの
//     連番・字下げ、markbox.css は蛍光ペン・マーカー付きテキスト枠の見た目。
//     どちらも alerts.css と同じく標準 CSS のオン/オフに関係なく常に適用する)
//   - html を一旦(リソースを読み込まない)<template> に入れてから、外部 URL でない
//     img[src] を data-src に退避し、その後で本文に差し込む(HTML で直接書かれた
//     `<img src="images/a.png" width="300">` のような MPE 由来の記法にも同じ変換が
//     効くようにするため。markdown 由来の画像も HTML 出力にそのまま使えるよう、
//     markdown-it 側では src をそのまま出力している。src/render/markdown.js 参照)
//   - mermaid のプレースホルダを親ドキュメント側で mermaid.render() して SVG に差し替える
//     (同じソースは再描画しない。失敗時はその場にエラー表示する)
//   - data-src を FSA で読んで blob URL に置き換える(パス+lastModified でキャッシュ)
//   - プレビュー内のリンククリックの振り分け(#見出し / 相対 .md / 外部)
//
// iframe には sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" を
// 付け、md 内の <script> やインラインイベントハンドラ属性が実行されないようにする。
// allow-same-origin により、親スクリプトからは contentDocument への同一オリジンアクセス
// (addEventListener・DOM 書き換え・スクロール制御)が可能(iframe 自身の script 実行とは別の話)。
//
// ---- 描画の順序・画像キャッシュの解放(レビュー指摘) ----
// render() は @import の展開などで非同期になった呼び出し元(src/app.js の doRender)
// から呼ばれるため、古い描画の結果が新しい描画より後に届くことがある。呼び出し元側の
// ガードに加え、このモジュール内でも renderSeq を使い、resolveImages() の「使われて
// いない blob URL の解放」は最新の描画のときだけ行う(古い描画の解放処理が、新しい
// 描画が使っている blob URL を revoke してしまわないようにするため)。

import mermaid from 'mermaid';
import baseCss from '../theme/base.css';
import alertsCss from '../theme/alerts.css';
import outlineCss from '../theme/outline.css';
import markboxCss from '../theme/markbox.css';
import { dirname, joinPath, isExternalUrl, urlToPath, extname } from '../fs/paths.js';
import { getFileHandleByPath } from '../fs/workspace.js';
import { applyOutline } from '../render/outline.js';

mermaid.initialize({ startOnLoad: false });

const SKELETON_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<style id="mdpreview-base-style"></style>' +
  '<style id="mdpreview-alerts-style"></style>' +
  '<style id="mdpreview-outline-style"></style>' +
  '<style id="mdpreview-markbox-style"></style>' +
  '<style id="mdpreview-user-style"></style>' +
  '</head><body><div class="crossnote markdown-preview" id="mdpreview-root"></div></body></html>';

function isMdPath(p) {
  const ext = extname(p);
  return ext === '.md' || ext === '.markdown';
}

/**
 * @param {{ iframe: HTMLIFrameElement, onOpenMdLink?: (resolvedPath: string) => void }} opts
 */
export function createPreview({ iframe, onOpenMdLink }) {
  let ready = false;
  let readyPromise = null;
  let wrapperEl = null;
  let docRef = null;
  // setUseStandardCss() は iframe の load 前(init() 直後)にも呼ばれうるため、
  // 値は state として持っておき、load 時に最新の値を反映する。
  let useStandardCss = true;
  // 見出しの連番・字下げの設定(既定オフ)。render() のたびに本文へ適用する。
  let outlineOptions = { numbers: false, depth: 6, indent: false };

  let currentRoot = null;
  let currentMdDir = '';
  let currentLineMap = [];

  const mermaidCache = new Map(); // source -> { ok: true, svg } | { ok: false, message }
  const imageCache = new Map(); // resolvedPath -> { lastModified, blobUrl }
  let mermaidSeq = 0;
  let renderSeq = 0;

  function attachLinkHandler() {
    wrapperEl.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;

      if (href.startsWith('#')) {
        e.preventDefault();
        const id = decodeURIComponent(href.slice(1));
        const target = docRef.getElementById(id);
        if (target) target.scrollIntoView({ block: 'start' });
        return;
      }

      if (isExternalUrl(href)) {
        e.preventDefault();
        window.open(href, '_blank', 'noopener');
        return;
      }

      e.preventDefault();
      const rel = urlToPath(href);
      const resolved = joinPath(currentMdDir, rel);
      if (resolved != null && isMdPath(resolved) && typeof onOpenMdLink === 'function') {
        onOpenMdLink(resolved);
      }
    });
  }

  function init() {
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    readyPromise = new Promise((resolve) => {
      iframe.addEventListener(
        'load',
        () => {
          docRef = iframe.contentDocument;
          wrapperEl = docRef.getElementById('mdpreview-root');
          const baseStyleEl = docRef.getElementById('mdpreview-base-style');
          if (baseStyleEl) baseStyleEl.textContent = useStandardCss ? baseCss : '';
          const alertsStyleEl = docRef.getElementById('mdpreview-alerts-style');
          if (alertsStyleEl) alertsStyleEl.textContent = alertsCss;
          const outlineStyleEl = docRef.getElementById('mdpreview-outline-style');
          if (outlineStyleEl) outlineStyleEl.textContent = outlineCss;
          const markboxStyleEl = docRef.getElementById('mdpreview-markbox-style');
          if (markboxStyleEl) markboxStyleEl.textContent = markboxCss;
          attachLinkHandler();
          ready = true;
          resolve();
        },
        { once: true }
      );
    });
    iframe.srcdoc = SKELETON_HTML;
  }

  async function whenReady() {
    if (!ready) await readyPromise;
  }

  /** style.css の中身をそのまま反映する(即時反映。iframe の再読み込みはしない)。 */
  function setUserCss(text) {
    if (!docRef) return;
    const el = docRef.getElementById('mdpreview-user-style');
    if (el) el.textContent = text || '';
  }

  /**
   * 標準 CSS(base.css)を使うかどうかを切り替える。init() の直後、iframe の
   * load が終わる前に呼ばれることもあるため値は保持しておき、load 時にも
   * 最新の値を反映する(上の init() 内を参照)。
   */
  function setUseStandardCss(on) {
    useStandardCss = !!on;
    if (!docRef) return;
    const el = docRef.getElementById('mdpreview-base-style');
    if (el) el.textContent = useStandardCss ? baseCss : '';
  }

  /**
   * 見出しの連番・字下げの設定を保持する。次回以降の render() で本文に適用される
   * (呼び出し側は alertTitles の変更時と同様、変更後すぐに再描画する想定)。
   */
  function setOutlineOptions(opts) {
    outlineOptions = { numbers: !!(opts && opts.numbers), depth: (opts && opts.depth) || 6, indent: !!(opts && opts.indent) };
  }

  function applyMermaidResult(el, result) {
    if (result.ok) {
      el.classList.remove('mermaid-error');
      el.innerHTML = result.svg;
    } else {
      el.classList.add('mermaid-error');
      el.textContent = 'mermaid の描画に失敗しました: ' + result.message;
    }
  }

  async function renderMermaidBlocks(mySeq) {
    const blocks = Array.from(wrapperEl.querySelectorAll('.mermaid-block'));
    await Promise.all(
      blocks.map(async (el) => {
        const srcEl = el.querySelector('.mermaid-source');
        const source = srcEl ? srcEl.textContent : '';
        const cached = mermaidCache.get(source);
        if (cached) {
          applyMermaidResult(el, cached);
          return;
        }
        let result;
        try {
          const id = 'mdpreview-mermaid-' + mermaidSeq++;
          const { svg } = await mermaid.render(id, source);
          result = { ok: true, svg };
        } catch (err) {
          result = { ok: false, message: (err && err.message) || String(err) };
        }
        mermaidCache.set(source, result);
        // 描画中に別のレンダリングが走っていたら(ユーザが入力を続けた等)、
        // 古い結果で DOM を書き換えない。
        if (mySeq !== renderSeq) return;
        applyMermaidResult(el, result);
      })
    );
  }

  // <template> の中身は inert(画像等のリソースを読み込まない)なので、ここで
  // 外部 URL でない img[src] を data-src に退避してから本文へ差し込む。
  // markdown 由来の `![]()` も、md に直接書かれた `<img src=...>` も同じ扱いにする。
  function moveImageSrcToDataSrc(root) {
    for (const img of root.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (!src || isExternalUrl(src)) continue;
      img.removeAttribute('src');
      img.setAttribute('data-src', src);
    }
  }

  // 描画のたびに本文を丸ごと入れ直すため、画像の src が決まるまで(resolveImages の
  // ファイル確認を待つ間)画像の高さが 0 になり、その下の本文が上下に動いてちらつく。
  // 前回までに読んだ画像はキャッシュ済みの blob URL を同期で入れておく(同じ URL の
  // 画像は読み込み済みなので、差し込んだその場で元の大きさになる)。ファイルが
  // 変わっていれば、この後の resolveImages が新しい blob URL に差し替える。
  function applyCachedImageSrc() {
    for (const img of wrapperEl.querySelectorAll('img[data-src]')) {
      const raw = img.getAttribute('data-src');
      if (!raw) continue;
      const resolved = joinPath(currentMdDir, urlToPath(raw));
      const cached = resolved == null ? null : imageCache.get(resolved);
      if (cached) img.src = cached.blobUrl;
    }
  }

  async function resolveImages(mySeq) {
    if (!currentRoot) return;
    const imgs = Array.from(wrapperEl.querySelectorAll('img[data-src]'));
    const usedPaths = new Set();
    for (const img of imgs) {
      const raw = img.getAttribute('data-src');
      if (!raw) continue;
      const rel = urlToPath(raw);
      const resolved = joinPath(currentMdDir, rel);
      if (resolved == null) continue; // ルートの外を指している
      usedPaths.add(resolved);
      try {
        const fh = await getFileHandleByPath(currentRoot, resolved, { create: false });
        const file = await fh.getFile();
        const cached = imageCache.get(resolved);
        if (cached && cached.lastModified === file.lastModified) {
          if (img.getAttribute('src') !== cached.blobUrl) img.src = cached.blobUrl;
          continue;
        }
        const url = URL.createObjectURL(file);
        if (cached) URL.revokeObjectURL(cached.blobUrl);
        imageCache.set(resolved, { lastModified: file.lastModified, blobUrl: url });
        img.src = url;
      } catch {
        // 見つからない等はそのまま(壊れた画像アイコンとして表示される)
      }
    }
    // 古い描画の resolveImages がこの後に解決しても、新しい描画が使っている
    // blob URL を revoke しないよう、最新の描画のときだけ未使用分を解放する。
    if (mySeq !== renderSeq) return;
    for (const [key, val] of imageCache) {
      if (!usedPaths.has(key)) {
        URL.revokeObjectURL(val.blobUrl);
        imageCache.delete(key);
      }
    }
  }

  /**
   * @param {{ html: string, lineMap: number[], root: any, mdPath: string }} args
   */
  async function render({ html, lineMap, root, mdPath }) {
    await whenReady();
    currentRoot = root;
    currentMdDir = dirname(mdPath || '');
    currentLineMap = lineMap || [];
    const mySeq = ++renderSeq;

    const template = docRef.createElement('template');
    template.innerHTML = html;
    moveImageSrcToDataSrc(template.content);
    wrapperEl.innerHTML = '';
    wrapperEl.appendChild(template.content);
    applyCachedImageSrc();
    // innerHTML を丸ごと入れ直した直後の本文に対して適用する(オフのときの
    // 「外す」処理が要らないのはこのため。src/render/outline.js 参照)。
    applyOutline(wrapperEl, outlineOptions);

    await Promise.all([renderMermaidBlocks(mySeq), resolveImages(mySeq)]);
  }

  return {
    init,
    whenReady,
    setUserCss,
    setUseStandardCss,
    setOutlineOptions,
    render,
    getDocument: () => docRef,
    getWrapperElement: () => wrapperEl,
    getLineMap: () => currentLineMap,
    getScrollRoot: () => (docRef ? docRef.scrollingElement || docRef.documentElement : null),
    getScrollContext: () => (docRef ? { doc: docRef, scrollRoot: docRef.scrollingElement || docRef.documentElement } : null),
  };
}
