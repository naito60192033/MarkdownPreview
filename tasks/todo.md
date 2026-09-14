# Markdown エディタ兼プレビュー(単独 HTML 版) TODO

計画の詳細: `~/.claude/plans/abundant-percolating-dahl.md`(2026-09-11 承認)

## フェーズ 0: 準備と技術検証
- [x] git init(main / dev)、.gitignore、package.json
- [x] build.mjs(esbuild → dist/mdpreview.html へのインライン化、`</script>` のエスケープ)
- [x] dev/(task-kanri の fake-fs / harness / setup-container を移植、バイナリ対応)
- [x] 技術検証(file://): iframe srcdoc の更新 / インライン mermaid の描画 / fake-fs での読み書き / IndexedDB へのハンドル保存
  - 結果: 4 点とも成功。dist は 5.14 MiB(mermaid + KaTeX を含む)。mermaid の動的 import は esbuild が静的に解決する
  - `</script` は esbuild の inline-script でエスケープする。`<!--` と `<script` が同時に現れた場合はビルドを止める

## フェーズ 1: ワークスペース
- [x] フォルダの選択と再許可(最近使ったルートを複数保持) — src/fs/recent-roots.js、src/ui/start.js
- [x] ファイルツリー(遅延読み込み、.md とフォルダのみ)、最後に開いたファイル、`#file=` — src/ui/tree.js、src/app.js
- [x] 開く・保存(Ctrl+S、未保存の印、競合チェック、withRetry) — src/app.js、src/ui/conflict-modal.js
- [x] 変更検知(フォーカス時と表示中の 2 秒ポーリング、書き込み中は停止、通知バー) — src/watch.js、src/ui/notify-bar.js

## フェーズ 2: エディタ + プレビュー
- [x] CodeMirror 6、markdown-it、highlight.js、mermaid — src/editor.js、src/render/markdown.js、src/ui/preview.js
- [x] iframe srcdoc プレビュー(MPE と同じ構造 `crossnote markdown-preview`) — src/ui/preview.js
- [x] base.css + style.css の即時反映 — src/theme/base.css、src/ui/preview.js
- [x] 画像の blob URL 化、スクロール同期(data-line) — src/ui/preview.js、src/scroll-sync.js

## フェーズ 3: MPE 互換
- [x] 見出し id(heading-id-generator の移植 + uslug)、`{#id .class}`、`{width=}` — モジュール完成(src/render/slug.js)
- [x] @import "x.md"(2 形式、入れ子、循環検出、相対パスの書き換え、行番号の対応表) — src/render/imports.js
- [x] TOC: `[TOC]` とソース書き込み型(code_chunk_output) — src/render/toc.js
- [x] アラート `> [!NOTE]` 等 — src/render/alerts.js、src/theme/alerts.css
- [x] アプリへの組み込み(pipeline に expandImports とプラグインを登録、保存時の updateTocBlocks、@import 先の変更監視、E2E)

## フェーズ 4: 画像の貼り付けとドロップ
- [x] images/<md名>-YYYYMMDD-HHmmss.png に保存して参照を挿入 — src/paste.js(空白を含むパスは <...> 形式)

## フェーズ 5: 注釈エディタ
- [x] 赤枠 / 矢印(接続と追従)/ 吹き出し / 切り抜き / 倍率 / 元に戻す・やり直し — src/annotator/
- [x] PNG iTXt への保存と再編集、PNG 以外の画像の扱い — 元画像は独自チャンク mdOR、アプリ側は src/ui/image-edit.js

## フェーズ 6: HTML 出力
- [x] 通常出力(CSS インライン、mermaid SVG、画像は相対パス) — src/export.js
- [x] 1 ファイル出力(画像を base64 で埋め込み)

## 追加要望(2026-09-14): アラートの拡張
- [x] 種類「リンク」(`> [!LINK]`)と設定のタイトル
- [x] 種類 memo / check / question の追加(計 9 種類)、`:::memo` などの省略形
- [x] タイトルを空欄にしたらアイコンのみ(本文の左に配置)。空欄と未設定を区別して保存
- [x] README に 9 種類の使いどころと書き方を明記
- [x] GitHub と同じアイコン(Octicons 19.36.0: info / light-bulb / report / alert / stop / link / pencil / check-circle / question)
- [x] Qiita 方式(`:::note info|warn|alert`)も GitHub 方式と同じ HTML で表示(資料に混在しているため)
- [x] 角丸の枠で囲むデザイン、社内資料向けの落ち着いた配色(文字のコントラスト比 5.6:1 以上)
- [x] テスト・README・スクリーンショットでの配色確認(枠内の余白は既定テーマより強い詳細度で指定)

## フェーズ 7: README と最終確認
- [x] README(導入と使い方)
- [ ] 全テスト、Windows 実機での確認依頼

## 追加要望(2026-09-14): favicon
- [x] アプリの favicon を「md」の文字 + 青→紫のグラデーションにする(SVG の data URI を src/index.html に埋め込む)
- HTML 出力には favicon を付けない(出力はいろいろなプロジェクトの資料として配布されるため)

## 追加要望(2026-09-14): 貼り付け画像の保存先を MPE と同じにする
- [x] 貼り付け・ドロップした画像を `images/<md名>/image-<連番>.<拡張子>` に保存(連番は既存の最大値 + 1)— src/paste.js
- [x] base64 で埋め込むのは HTML の1ファイル出力のときだけ(従来どおり src/export.js)。README・テストを更新
- [x] draw.io の通常のコピー(text/plain に URL エンコードした mxGraphModel)は貼り付けず「Copy as Image」を案内
- [x] ドロップした `xxx.drawio.png` は `image-<連番>.drawio.png` として保存(draw.io で開き直せるように)

## 将来やりたいこと(バックログ)
- [ ] プロジェクト(ワークスペース)ごとの favicon 設定と、favicon を作る機能
  - ねらい: 複数のプロジェクトをタブで開いたときに見分けやすくする
  - 案: 2〜3 文字と背景色(単色 / グラデーション)を選ぶと SVG を生成し、ワークスペースの設定に保存。開いたときにタブの favicon を差し替える
  - 16px でつぶれないか確認するため、作成画面に 16px の拡大表示とタブの見本(ライト / ダーク)を出す
  - HTML 出力に付けるかは実装時に決める(今は付けない方針)
