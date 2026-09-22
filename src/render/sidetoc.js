// src/render/sidetoc.js
//
// サイドバー目次(Qiita 風)の組み立て。HTML 出力(src/export.js)とアプリ内の
// プレビュー(src/ui/preview.js)の両方から使う共通処理。DOM 操作はあるが、
// 呼び出し側が渡す Document(iframe の contentDocument でも export 用の隠し
// document でもよい)に対して動くだけで、どちらの用途にも依存しない。
//
// - SIDE_TOC_SELECTOR: 目次の対象にする見出しのセレクタ(h2〜h6)
// - buildSideTocLabelHtml(headingEl): 見出し要素から目次ラベルの HTML を作る
// - collectSideTocItems(rootEl, ignoredIds): rootEl 配下の見出しから項目一覧を作る
// - buildSideTocNav(doc, items): toggle(チェックボックス)と nav(見出し+ul+帯)の
//   2 要素を組み立てる(`.mdp-layout` で包む処理は呼び出し側の責務)

import { renderSideTocHtml } from './toc.js';

export const SIDE_TOC_SELECTOR = 'h2, h3, h4, h5, h6';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 見出し要素のクローンから、サイドバー目次のラベル用 HTML を組み立てる。
// - 脚注参照(sup.footnote-ref)は目次には不要なので取り除く
// - 連番の span(.mdp-heading-number。src/render/outline.js が見出しの先頭の
//   子として挿入したもの)があれば、そのまま同じ class で先頭に出す
// - 残りのテキスト(textContent を trim)はエスケープして続ける
export function buildSideTocLabelHtml(headingEl) {
  const work = headingEl.cloneNode(true);
  for (const el of work.querySelectorAll('sup.footnote-ref')) el.remove();

  let numberHtml = '';
  const first = work.firstElementChild;
  if (first && first.classList.contains('mdp-heading-number')) {
    numberHtml = `<span class="mdp-heading-number">${escapeHtml(first.textContent)}</span>`;
    first.remove();
  }
  return numberHtml + escapeHtml(work.textContent.trim());
}

// rootEl 配下の h2〜h6 を文書順に走査し、renderSideTocHtml に渡す項目一覧を作る。
// id が空、または ignoredIds に含まれる見出し(`{ignore=true}`)は除外する。
export function collectSideTocItems(rootEl, ignoredIds) {
  const items = [];
  for (const headingEl of rootEl.querySelectorAll(SIDE_TOC_SELECTOR)) {
    const id = headingEl.id;
    if (!id || (ignoredIds && ignoredIds.has(id))) continue;
    items.push({
      level: Number(headingEl.tagName.slice(1)),
      id,
      labelHtml: buildSideTocLabelHtml(headingEl),
    });
  }
  return items;
}

/**
 * 折りたたみ用の隠しチェックボックス(toggle)と、見出し+ul+畳んだときの帯を
 * まとめた `<nav class="mdp-sidetoc">`(nav)を組み立てる。items は 1 件以上ある
 * 前提(呼び出し側で件数を確認してから呼ぶ)。
 * @param {Document} doc
 * @param {{level: number, id: string, labelHtml: string}[]} items
 * @returns {{ toggle: HTMLInputElement, nav: HTMLElement }}
 */
export function buildSideTocNav(doc, items) {
  // 開閉の状態を持つだけの隠しチェックボックス(JavaScript 不使用で開閉するため)。
  const toggle = doc.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'mdp-sidetoc-toggle';
  toggle.className = 'mdp-sidetoc-toggle';
  toggle.setAttribute('aria-label', '目次の開閉');

  const nav = doc.createElement('nav');
  nav.className = 'mdp-sidetoc';
  nav.setAttribute('aria-label', '目次');

  const head = doc.createElement('div');
  head.className = 'mdp-sidetoc-head';
  const title = doc.createElement('span');
  title.className = 'mdp-sidetoc-title';
  title.textContent = '目次';
  const closeLabel = doc.createElement('label');
  closeLabel.setAttribute('for', 'mdp-sidetoc-toggle');
  closeLabel.className = 'mdp-sidetoc-close';
  closeLabel.title = '目次を畳む';
  closeLabel.textContent = '«';
  head.appendChild(title);
  head.appendChild(closeLabel);
  nav.appendChild(head);

  nav.insertAdjacentHTML('beforeend', renderSideTocHtml(items));

  // 畳んだときだけ見える帯。押すと開く。
  const stripLabel = doc.createElement('label');
  stripLabel.setAttribute('for', 'mdp-sidetoc-toggle');
  stripLabel.className = 'mdp-sidetoc-strip';
  stripLabel.title = '目次を開く';
  stripLabel.innerHTML = '<span>»</span><span class="mdp-sidetoc-strip-text">目次</span>';
  nav.appendChild(stripLabel);

  return { toggle, nav };
}
