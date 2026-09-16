# HTML 出力にサイドバーの目次(Qiita 風)を付ける

## Context
出力 HTML は長い資料だと目的の節へ移動しにくい。Qiita のように画面の横に目次を固定表示し、
クリックで移動でき、今読んでいる見出しが強調されるようにしたい。
- 対象は h2〜h6(ユーザーが TOC で指定している範囲)
- 調査結果: CSS の `scroll-target-group: auto` + `:target-current`(Chrome/Edge 140 以降)で、
  **JavaScript なしで**「今読んでいる見出しの強調」までできる。対応していないブラウザでは
  強調が出ないだけで、目次の表示とクリックでの移動は動く。
  → 「JS を含めない」方針を守れるので、**通常出力・1ファイル出力の両方に同じ目次を付ける**
  (1ファイル出力で目次を外す必要がなくなる)
- E2E の Chromium(playwright chromium-1234)も対応版なので、強調まで自動テストで確かめられる

## 方針(決めたこと)
- 設定に「HTML 出力にサイドバーの目次を付ける」(`sideToc`、**既定オン**)を追加。標準 CSS と同じくチェックでオン/オフ
- アプリ内のプレビューには出さない(HTML 出力だけ)。プレビューの横幅は狭く、スクロール同期にも影響するため
- 目次は画面の**右側**に固定(Qiita と同じ)。画面が狭いとき(幅 1000px 未満目安)と印刷・PDF 保存のときは目次を出さない
- 見出しの連番がオンなら目次にも同じ番号を付ける。`{ignore=true}` の見出しは目次に出さない(`[TOC]` と同じ規則)
- h2〜h6 が 1 つも無い文書では目次を付けない(レイアウトも今のまま)

## 実装
1. **`src/render/toc.js`**: 既存 `renderTocHtml` の入れ子リスト組み立て(`build`)を、ラベルの作り方を
   引数で受け取る共通関数に切り出し、DOM 非依存の `renderSideTocHtml(items)` を追加
   (`items = {level, id, labelHtml}[]` → `<ul>` の入れ子。`[TOC]` の出力は変えない)
2. **`src/theme/sidetoc.css`**(新規): 出力 HTML 専用。
   - `<div class="mdp-layout">` を grid(本文 | 目次 280px)にし中央寄せ。本文の最大幅は既存の `--mdp-content-width` を尊重
   - `.mdp-sidetoc`: `position: sticky; top: 0; max-height: 100vh; overflow-y: auto; scroll-target-group: auto;`
   - `.mdp-sidetoc a:target-current` を太字+アクセント色+左線で強調
   - 目次は `.crossnote.markdown-preview` の外にあり `--mdp-*` 変数が継承されないため、`.mdp-sidetoc` 自身に
     同じ既定色の変数(`--mdp-sidetoc-width` 等)を定義し style.css で上書きできるようにする
   - `@media (max-width: 999px)` と `@media print` で目次を非表示・レイアウトを通常に戻す
   - 標準 CSS をオフにしても常に適用(alerts.css / outline.css と同じ扱い)
3. **`src/export.js`**: `sideToc` が真なら
   - 引数で受け取る見出し一覧(ignore 付き)から h2〜h6・非 ignore を選び、ラベルはクローン内の同じ id の見出し要素から作る
     (連番 span `.mdp-heading-number` はそのまま複製、脚注参照 `sup.footnote-ref` は除く、残りはテキスト化してエスケープ)
   - `composeHtml` で `<div class="mdp-layout">本文<nav class="mdp-sidetoc" aria-label="目次">…</nav></div>` を組み、sidetoc.css を `<style>` に追加
   - モジュール docstring(出力構造の説明)を更新
4. **`src/app.js`**: `doExport` で既存の `collectHeadingsFor`(`src/render/pipeline.js`、保存時の TOC 更新と同じ呼び方)で
   見出し一覧を取り、`state.settings.sideToc` と一緒に export へ渡す。sidetoc.css を text ローダーで import
5. **設定**: `src/settings.js`(`sideToc: true`)、`src/index.html`(チェックボックスと説明文)、`src/ui/settings-panel.js`・`app.js` の配線
6. **README**「HTML 出力」節: 目次の説明(右側に出る・狭い画面/印刷では出ない・強調は Chrome/Edge 140 以降・設定で消せる・変数での調整)

## 検証
- 単体: `tests/render-toc.test.js` に `renderSideTocHtml` の入れ子・エスケープ・空配列のテスト
- E2E(`dev/harness.mjs`、既存の出力テストの形): h1〜h6+`{ignore=true}`+連番オンの md を出力して開き
  - 目次のリンクが h2〜h6 の文書順(ignore 除く)で、href が見出し id と一致・番号も一致・`script` 要素が 0
  - 幅 1400px でリンクをクリック/スクロールすると、その見出しのリンクが `a:target-current` になる(入れ子の h3 以下も)
  - 幅 800px では目次が非表示(`display: none`)
  - 1ファイル出力にも目次がある / 設定オフでは目次が無い / 見出しが無い文書では付かない
- `npm test` 全体が通ること
- 実機確認(教訓 L2・L3): いつもの `MarkdownPreview\dist\mdpreview.html` をビルドし、出力した HTML を Chrome で開いて
  「画面右側に目次が出る/クリックで移動する/スクロールすると今の見出しが太字・色付きになる/幅を狭めると消える」を見てもらう

## 進め方
- `tasks/todo.md` にチェックリストを追記し、`feature/sidetoc` ブランチで実装(実装作業は implementer に委譲、レビューはメイン)
- テスト通過後に commit、実機確認後に dev へマージ
