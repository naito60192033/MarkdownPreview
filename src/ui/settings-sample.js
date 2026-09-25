// src/ui/settings-sample.js
//
// 設定パネル(案B)の右側に出す「見本」(iframe)。手書きの HTML ではなく、
// プレビュー本体(src/ui/preview.js)と同じ描画経路 — renderDocument()
// (src/render/pipeline.js)→ applyOutline()(src/render/outline.js)— を
// 使うことで、設定の結果と見本がずれないようにする。CSS も preview.js と
// 同じ並び(base → alerts → outline → markbox → style.css)で当て、最後に
// 見本パネル用の縮小表示(12〜13px 程度)の上書きを重ねる。
//
// createSettingsSample({ iframe }) は { init(), render(settings), setUserCss(text),
// flashAlert(kind) } を返す。init() は preview.js と同様、呼び出し側が生成直後に
// 一度だけ呼ぶ(iframe に srcdoc を設定する)。render() は非同期(renderDocument が
// 非同期のため)だが、preview.js の renderSeq と同じ考え方で連番ガードを持ち、
// 短い間隔で呼ばれても古い結果で DOM を上書きしない。

import baseCss from '../theme/base.css';
import alertsCss from '../theme/alerts.css';
import outlineCss from '../theme/outline.css';
import markboxCss from '../theme/markbox.css';
import { renderDocument } from '../render/pipeline.js';
import { applyOutline } from '../render/outline.js';

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution', 'link', 'memo', 'check', 'question'];

// h2〜h6 の見出し(「どの見出しまで付けるか」のどれを選んでも境目が見えるように
// 1 段ずつ下がる)と、アラート 9 種類(各 1 行本文)を含む見本用の固定文章。
// 開いている md の内容とは無関係(設定を変えても編集中の文書は動かない)。
export const SAMPLE_MD = [
  '## 概要',
  '',
  '〇〇受付管理システムの基本設計書です。',
  '',
  '### 対象範囲',
  '',
  '受付登録・一覧・履歴検索を扱います。',
  '',
  '### 対象外',
  '',
  '会計・請求処理は扱いません。',
  '',
  '## 画面構成',
  '',
  '### 受付一覧',
  '',
  '#### 検索条件',
  '',
  '##### 日付の指定',
  '',
  '###### 期間の上限',
  '',
  '最大 1 年まで指定できます。',
  '',
  '### 受付詳細',
  '',
  '受付 1 件の内容を表示します。',
  '',
  '> [!NOTE]',
  '> 用語は「用語集」を参照してください。',
  '',
  '> [!TIP]',
  '> 検索条件は複数指定すると絞り込まれます。',
  '',
  '> [!IMPORTANT]',
  '> 個人情報を含む項目は表示権限に注意してください。',
  '',
  '> [!WARNING]',
  '> 仕様確定前の暫定版です。',
  '',
  '> [!CAUTION]',
  '> 削除すると元に戻せません。',
  '',
  '> [!LINK]',
  '> 関連資料は詳細設計書を参照してください。',
  '',
  '> [!MEMO]',
  '> 次回レビューで確定させます。',
  '',
  '> [!CHECK]',
  '> 入力チェックはクライアント側でも行います。',
  '',
  '> [!QUESTION]',
  '> 検索結果の上限件数は未確定です。',
  '',
].join('\n');

// 900×600 のダイアログの中の 360px 幅の見本パネルに実寸(既定 16px)のまま
// 表示すると大きすぎるため、見本の中だけ 12〜13px 程度に縮める。標準 CSS が
// オフのとき・利用者の style.css には影響しない(見本パネル専用の上書き)。
const SAMPLE_SCALE_CSS = `
.crossnote.markdown-preview {
  font-size: 12.5px;
  max-width: none;
  padding: 10px 14px 20px;
}
.crossnote.markdown-preview h2 { font-size: 15px; }
.crossnote.markdown-preview h3 { font-size: 13.5px; }
.crossnote.markdown-preview h4 { font-size: 12.5px; }
.markdown-alert { margin: 8px 0; font-size: 12px; }
.markdown-preview .markdown-alert > .markdown-alert-title { margin: 0 0 4px; }
.settings-sample-flash { animation: settings-sample-flash 0.6s ease-out; }
@keyframes settings-sample-flash {
  from { background-color: #fff3c4; }
  to { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .settings-sample-flash { animation: none; }
}
`;

const SKELETON_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<style id="mdpreview-sample-base-style"></style>' +
  '<style id="mdpreview-sample-alerts-style"></style>' +
  '<style id="mdpreview-sample-outline-style"></style>' +
  '<style id="mdpreview-sample-markbox-style"></style>' +
  '<style id="mdpreview-sample-user-style"></style>' +
  '<style id="mdpreview-sample-scale-style"></style>' +
  '</head><body>' +
  '<div class="crossnote markdown-preview" id="mdpreview-root"></div>' +
  '</body></html>';

/**
 * @param {{ iframe: HTMLIFrameElement }} opts
 */
export function createSettingsSample({ iframe }) {
  let ready = false;
  let readyPromise = null;
  let docRef = null;
  let wrapperEl = null;
  let renderSeq = 0;
  let useStandardCss = true;
  // load 前に setUserCss() が呼ばれても取りこぼさないよう、値を保持して load 時にも反映する
  let userCss = '';

  function init() {
    iframe.setAttribute('sandbox', 'allow-same-origin');
    readyPromise = new Promise((resolve) => {
      iframe.addEventListener(
        'load',
        () => {
          docRef = iframe.contentDocument;
          wrapperEl = docRef.getElementById('mdpreview-root');
          const baseStyleEl = docRef.getElementById('mdpreview-sample-base-style');
          if (baseStyleEl) baseStyleEl.textContent = useStandardCss ? baseCss : '';
          const alertsStyleEl = docRef.getElementById('mdpreview-sample-alerts-style');
          if (alertsStyleEl) alertsStyleEl.textContent = alertsCss;
          const outlineStyleEl = docRef.getElementById('mdpreview-sample-outline-style');
          if (outlineStyleEl) outlineStyleEl.textContent = outlineCss;
          const markboxStyleEl = docRef.getElementById('mdpreview-sample-markbox-style');
          if (markboxStyleEl) markboxStyleEl.textContent = markboxCss;
          const scaleStyleEl = docRef.getElementById('mdpreview-sample-scale-style');
          if (scaleStyleEl) scaleStyleEl.textContent = SAMPLE_SCALE_CSS;
          const userStyleEl = docRef.getElementById('mdpreview-sample-user-style');
          if (userStyleEl) userStyleEl.textContent = userCss;
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

  /**
   * 見本を再描画する。numbers/depth/indent(見出し)、alertTitles(アラートの
   * タイトル)、useStandardCss(標準 CSS のオン/オフ)を反映する。
   * @param {{ headingNumbers?: boolean, headingNumberDepth?: number,
   *           headingIndent?: boolean, alertTitles?: Record<string,string>,
   *           useStandardCss?: boolean }} settings
   */
  async function render(settings) {
    await whenReady();
    const mySeq = ++renderSeq;
    useStandardCss = settings.useStandardCss !== false;
    const { html } = await renderDocument(SAMPLE_MD, { alertTitles: settings.alertTitles });
    if (mySeq !== renderSeq) return; // 追い越された古い描画は反映しない
    wrapperEl.innerHTML = html;
    applyOutline(wrapperEl, {
      numbers: !!settings.headingNumbers,
      depth: settings.headingNumberDepth || 6,
      indent: !!settings.headingIndent,
    });
    const baseStyleEl = docRef.getElementById('mdpreview-sample-base-style');
    if (baseStyleEl) baseStyleEl.textContent = useStandardCss ? baseCss : '';
  }

  /** ワークスペースの style.css の中身をそのまま反映する(即時反映)。 */
  function setUserCss(text) {
    userCss = text || '';
    if (!docRef) return;
    const el = docRef.getElementById('mdpreview-sample-user-style');
    if (el) el.textContent = text || '';
  }

  /**
   * 指定の種類のアラートの位置へスクロールし、一瞬だけ背景色を付ける
   * (prefers-reduced-motion のときは色付けはしない。CSS 側の
   * @media (prefers-reduced-motion: reduce) で animation を無効化する)。
   * @param {string} kind note/tip/important/warning/caution/link/memo/check/question
   */
  function flashAlert(kind) {
    if (!wrapperEl) return;
    const el = wrapperEl.querySelector('.markdown-alert-' + kind);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.remove('settings-sample-flash');
    void el.offsetWidth; // reflow を挟んでアニメーションを再始動させる
    el.classList.add('settings-sample-flash');
  }

  return { init, render, setUserCss, flashAlert };
}
