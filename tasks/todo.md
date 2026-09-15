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

## 追加要望(2026-09-14): 注釈エディタの改修・標準 CSS
方針の詳細: tasks/plan-2026-09-14-annotator-css.md
- [x] 吹き出しの文言を後から修正できない問題(dblclick が発火しない)を修正。Enter / F2 でも編集開始
- [x] 複数画像のキャンバス(無限キャンバス、画像ごとの切り抜き、出力範囲の自動決定、保存形式 v2 = mdIM)
- [x] 画像の選択・移動・拡大縮小・削除・重なり順(2 枚以上のとき)
- [x] 標準 CSS(社内資料向け)、設定「標準 CSS を使う」「標準 CSS を書き出す」
- [x] モーダル: 入力欄のドラッグ選択で外に出て離すと閉じる問題を修正

## 追加要望(2026-09-14): 見出しの連番と字下げ
- [x] 設定(既定オフ): h2 以降の連番(`1.` / `1-2.` / `1-2-3.`)、番号を付ける深さ(h2〜h6)、階層ごとの字下げ
- [x] `{.nonum}` の見出しとその配下は番号なし(番号も消費しない)
- [x] 目次(`[TOC]` と MPE 方式)の項目にも同じ番号を表示(md 本文は書き換えない)
- [x] 字下げは見出しも本文も階層ごとに下げる(h2 = 0 段・本文 1 段、h3 = 1 段・本文 2 段)。1 段の幅は `--mdp-indent-step`(既定 1.5em)
- [x] 描画後の DOM に適用(src/render/outline.js)。CSS は標準 CSS と別(src/theme/outline.css、常に適用)
- [x] テスト・README・スクリーンショットで確認(設定パネルは縦に長くなったのでパネル内スクロール)

## 追加要望(2026-09-14): 蛍光ペンとマーカー付きテキスト枠
方針の詳細: tasks/plan-2026-09-14-markbox.md(feature/markbox)
- [x] 段落などの `==強調==` → `<mark>`(黄色のみ、MPE 互換。markdown-it-mark)、`==強調=={.mark-text}` で黄色 + 赤枠
- [x] ```` ```mark ```` の枠(`pre.mark-box`、空白・改行を保持)。枠内の `==強調==` は黄色 + 赤枠(`span.mark-text`)
- [x] CSS は src/theme/markbox.css(アラートと同じく常に適用)。標準 CSS の pre に負けない詳細度。色は CSS 変数
- [x] テスト(単体・E2E)、README、dist
- [x] ユーザーの目視確認後に dev へマージ

## 不具合修正(2026-09-14): 編集画面の表示
- [x] エディタのみ表示で右側にプレビューの領域が残る → エディタ幅を inline の px 固定から CSS 変数(%)に変更し、エディタのみでは flex: 1
- [x] サイドバー表示中は幅変更の位置がサイドバー分ずれる → エディタ | 境界 | プレビューを #workArea で包み、比率の基準にする
- [x] 境界を右(プレビュー側)へ動かせない → ドラッグ中は iframe の pointer-events を切る
- [x] エディタのスクロール・入力でプレビューが最下部まで飛ぶ → src/scroll-sync.js の topOf で scrollTop が二重に加算されていたのを修正
- [x] E2E テストを追加して確認(上の 4 点。セクション 26。修正前のコードでは失敗することも確認)
- メモ: プレビュー → エディタ方向のスクロール連動は動いていない(リスナが documentElement に付いている)。今回は直さない(ユーザー判断)

## 追加要望(2026-09-14): ファイル操作(新規 md・新規フォルダ・名前の変更・削除)
方針の詳細: tasks/plan-2026-09-14-fileops.md(feature/fileops)
- [x] 入口: サイドバー上部のボタン(＋ md / ＋ フォルダ / ⟳)と、ツリーの右クリックメニュー。F2 / Delete
- [x] 名前の入力モーダル、名前の検証(Windows の禁止文字・予約名・大文字小文字を区別しない同名)、`.md` の付与
- [x] 新規 md(0 バイト)・新規フォルダ、名前の変更(ファイルは move → だめならコピー、フォルダはコピー)、削除(完全削除)
- [x] 開いている md の付け替え(名前の変更)・閉じる(削除)
- [x] テスト(単体・E2E セクション 27)、README、dist
- [x] Windows 実機での確認: 全パターン問題なし。ファイルの名前の変更は move() で行われる(「名前を変更しました」)

## 追加要望(2026-09-14): md 上の 1 回の改行をプレビューでも改行にする
方針の詳細: tasks/plan-2026-09-14-breaks.md(feature/breaks)
- [x] markdown-it を `breaks: true` に(常に有効。MPE の breakOnSingleNewLine の既定と同じ) — src/render/markdown.js
- [x] テスト(renderDocument で改行・アラート・attrs・```mark を確認)、README、dist。npm test すべて成功
- [x] 目視確認(ユーザー): プレビューと HTML 出力で 1 回の改行・アラート・リスト・画像 2 行

## 追加要望(2026-09-15): スクロール同期の最下部 / カギ線矢印 / 吹き出しの文字
方針の詳細: tasks/plan-2026-09-15-elbow.md(feature/elbow)
- [x] エディタを最下部までスクロールしたらプレビューも最下部にする(最後の 1 画面分で最下部へ寄せる) — src/scroll-sync.js
- [x] 吹き出しの文字の大きさ・色(ツールバーの「文字」グループ。選択中の吹き出し / 次の吹き出しの既定)
- [ ] カギ線矢印(ツール L)。枠の辺の中点に接続(離した位置に一番近い辺)、中央の線のハンドル
- [ ] テスト(単体・E2E)、README、dist
- [ ] ユーザーの目視確認後に dev へマージ

## 将来やりたいこと(バックログ)
- [ ] プロジェクト(ワークスペース)ごとの favicon 設定と、favicon を作る機能
  - ねらい: 複数のプロジェクトをタブで開いたときに見分けやすくする
  - 案: 2〜3 文字と背景色(単色 / グラデーション)を選ぶと SVG を生成し、ワークスペースの設定に保存。開いたときにタブの favicon を差し替える
  - 16px でつぶれないか確認するため、作成画面に 16px の拡大表示とタブの見本(ライト / ダーク)を出す
  - HTML 出力に付けるかは実装時に決める(今は付けない方針)
