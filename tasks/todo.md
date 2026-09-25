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
- [x] カギ線矢印(ツール L)。枠の辺の中点に接続(離した位置に一番近い辺)、中央の線のハンドル
  - ドラッグ中は離したときと同じ接続で描く。つないでいない他の枠は避けない(Excel と同じ。重なるときは中央のハンドルでずらす)
  - 矢印・カギ線とも、両端を同じ枠にはつながない
- [x] テスト(単体・E2E)、README、dist。npm test すべて成功(単体 228 / アプリ E2E 73 / 注釈 E2E 41)
- [x] ユーザーの目視確認(2026-09-15: 問題なし)後に dev へマージ

## 追加要望(2026-09-15): 貼り付けの改善と表の整形
方針の詳細: tasks/plan-2026-09-15-paste.md(feature/paste)
- [x] デモページ(案 A の選択メニュー・保存中の表示・表での貼り付け・表の整形・クリップボードの中身の表示)— dev/paste-demo/
- [x] ユーザーがデモを実機で確認 → 案 A(毎回メニュー)、表の整形はボタン + Alt+Shift+F(自動整形なし)
  - Excel の画像: 実機で確認済み(空の string:image/svg+xml が先、file:image/png が後)
- [x] md への画像の貼り付け: 保存中の表示、保存中の貼り付けを受け付けない、ファイル切り替え時は挿入しない — src/paste.js
  (純粋なロジックは src/paste-save.js に分離。paste.js が CSS を import するようになり node --test で読めないため)
- [x] 画像とテキストの両方がある貼り付けの選択(案 A)と、表(Markdown)での貼り付け — src/paste.js、src/paste-ui.js
- [x] 表の整形(ツールバーの「表を整形」、Alt+Shift+F) — src/md-table.js、src/app.js
- [x] 注釈エディタ: Excel の画像の Ctrl+V(kind === 'file' の項目から選ぶ)、ツールチップ。E2E(修正前は失敗を確認)
- [x] テスト(単体 230・E2E 79・注釈 E2E 28 すべて成功)、README、dist
- [x] dev(elbow 入り)を取り込んで npm test すべて成功(単体 246 / アプリ E2E 80 / 注釈 E2E 42)
- [x] ユーザーの目視確認(2026-09-15: 問題なし)後に dev へマージ

## 追加要望(2026-09-15): HTML 出力のサイドバー目次(Qiita 風)
方針の詳細: tasks/plan-2026-09-15-sidetoc.md(feature/sidetoc)
- [x] `renderSideTocHtml`(h2〜h6 の入れ子リスト。`[TOC]` と入れ子の組み立てを共通化) — src/render/toc.js
- [x] sidetoc.css(右側に固定・今の見出しの強調は CSS の scroll-target-group / :target-current・狭い画面と印刷では非表示)
- [x] 出力に目次を組み込む(通常・1ファイルとも。JS なし。ignore は除外・連番は複製) — src/export.js、src/app.js
- [x] 設定「HTML 出力にサイドバーの目次を付ける」(既定オン)
- [x] テスト(単体・E2E)、README、dist。npm test すべて成功(単体 250 / アプリ E2E 86 / 注釈 E2E 42)
- [x] 変更(ユーザー要望): 目次を左側へ。「«」で幅 36px の帯に畳めるように(CSS のみ・隠しチェックボックス)。
  幅 1280px 以上は開いた状態・未満は畳んだ状態で始まる。720px 未満と印刷では出さない
  - 隠しチェックボックスは position: fixed(absolute だとスクロール後に «/帯を押すとページ先頭へ飛ぶ。E2E で修正前の失敗を確認)
  - npm test すべて成功(単体 250 / アプリ E2E 90 / 注釈 E2E 42)
- [x] ユーザーの目視確認(2026-09-16: 問題なし)後に dev へマージ

## 追加要望(2026-09-16): 入力中にプレビューがちらつく
- [x] 原因の特定(計測): 位置同期ではなく、再描画のたびに画像の src が外れて高さ 0 になり、
  文書の高さが一時的に縮んで本文が上下に動いていた(入力中のスクロールイベントは 0 件)
- [x] 修正: 読み込み済みの画像は、ファイルの確認を待たずキャッシュ済みの blob URL を同期で入れる — src/ui/preview.js
- [x] テスト(E2E 1件追加: 入力中に画像が消えず本文も動かない。修正前は 35/187 フレームで画像が消えて失敗することを確認)、dist
  - npm test すべて成功(単体 250 / アプリ E2E 91 / 注釈 E2E 42)
- [x] ユーザーの目視確認(2026-09-16: 問題なし)後に dev へマージ

## 将来やりたいこと(バックログ)
- [ ] プロジェクト(ワークスペース)ごとの favicon 設定と、favicon を作る機能
  - ねらい: 複数のプロジェクトをタブで開いたときに見分けやすくする
  - 案: 2〜3 文字と背景色(単色 / グラデーション)を選ぶと SVG を生成し、ワークスペースの設定に保存。開いたときにタブの favicon を差し替える
  - 16px でつぶれないか確認するため、作成画面に 16px の拡大表示とタブの見本(ライト / ダーク)を出す
  - HTML 出力に付けるかは実装時に決める(今は付けない方針)

## 追加要望(2026-09-22): UI/UX の刷新と md の D&D
方向: 「道具らしく引き締める」(グレー基調・彩度を抑えた紺のアクセント 1 色・線画 SVG アイコン・情報密度高め)

### 見た目の検討(静的デモ)
- [x] `dist/ui-demo.html`(手書きの静的 1 枚。build.mjs の出力ではない)を作成
      通常 / 未保存 / ドラッグ中 / 単体プレビュー の 4 状態を右下…左下の「デモ表示」で切替
- [x] ユーザーの目視確認と、変更点の取捨選択(2026-09-22 承認)

### デモで提案している変更点
- [x] 絵文字アイコン(☰ ⚙ ⟳ ＋ ✕)を線画 SVG に置き換える(端末ごとに字形が変わるのをやめる)
- [x] favicon の青→紫グラデーションをやめ、紺 1 色にする
- [x] アクセント色をプレビューの見出しと同じ紺 `#1f4e79` に統一する(GitHub 青 `#0969da` を廃止)
- [x] ツールバーを整理: ワークスペース名はサイドバーの見出しへ移し、上部バーは
      「今開いているファイル(パンくず + 未保存の点)」+「そのファイルへの操作」だけにする
- [x] 表示モードを文字 3 ボタンから、押された面が白く浮くアイコンの切替に変える
- [x] 常時青い「保存」をやめ、未保存のときだけ紺で満たす(Ctrl+S を併記)
- [x] 未保存の表し方を amber 1 色に統一(ファイル名の点・ツリーの点・ステータスバー・
      エディタの行番号の左の目印 = どの行を直したかが分かる)
- [x] ツリーの選択状態を「色 + 太字 + 背景」の三重表示から「左の紺の線 + 薄い面」に変える
- [x] chrome(ツールバー・サイドバー・ステータスバー)を薄いグレー、作業面を白にして枠線を減らす
- [x] ステータスバーの機械の文字列(パス・行数・文字コード)を等幅にする

### プレビューの目次(2026-09-22 追加要望)
- [x] デモに「プレビューのみ」状態を追加(`dist/ui-demo.html`)
- [x] 「プレビューのみ」に切り替えたときだけ、本文の左にサイドバー目次を出す
      (`src/theme/sidetoc.css` と `src/export.js` の `buildExportBody` / `collectSideTocItems` を
       iframe 側でも使い回す。今は export.js 専用で、sidetoc.css の冒頭に
       「アプリ内のプレビュー(iframe)には出さない」と書いてあるので、そのコメントも直す)
- [x] 開く / 帯 / 出さない のしきい値は iframe 自身の幅で判定する。HTML 出力の 1280px / 720px は
      アプリ内では広すぎる(1440px の画面でもプレビュー幅は約 1200px)ため、アプリ内は
      **1160px 以上=開く / 720〜1159px=帯 / 720px 未満=出さない**(帯は 36px しか使わないので、
      「出さない」の下限は HTML 出力と同じ 720px に揃えた)
- [x] スクロール同期の確認: `src/scroll-sync.js` は `data-line` 要素の offsetTop を使うので、
      本文を `.mdp-layout`(grid)で包むと offsetParent が変わる可能性がある。ズレないことを E2E で確かめる
- [x] 「今読んでいる見出し」の強調は `:target-current`(Chrome 140+)。非対応でも表示と移動は動く

### md の D&D(単体プレビュー)
- [x] md 1 つを落としたらワークスペース無しで即表示、フォルダを落としたらワークスペースとして開く
- [x] 単体表示のときは「同じフォルダの画像と @import は表示できない」ことを帯で伝える
      (`src/ui/preview.js` の `resolveImages` は root が無いと即 return する = 画像は出ない)
- [x] `doRender()` の `if (!state.root ...) return;`(src/app.js:262)を単体モードでも描画できるようにする
- [x] `DataTransferItem.getAsFileSystemHandle()` でハンドルを取り、書き戻し(Ctrl+S)も可能にする

### 単体プレビューの作り(実装後のメモ)
- `src/fs/single-file.js` が「その md 1 つだけが入ったフォルダ」を装う。これを `state.root` に入れるので、
  `openFile` / `doSave` / 競合検出 / `watch.js` は分岐なしでそのまま動く(単体表示用の経路を別に作っていない)
- 書き込みの許可は、ドロップ時ではなく**最初に保存しようとしたとき**に求める(`doSave()` の先頭。
  Chrome はユーザー操作の直後でないと許可を出さないため、他の await より前に呼ぶこと)
- 覆い(`#dropOverlay`)には `pointer-events: none` が必須。外すとエディタへの画像ドロップを奪ってしまう
- ドロップの振り分けは `openDroppedHandles(handles)`(`window.__mdpreview` 経由で E2E から呼べる)。
  本物の DragEvent は `dataTransfer.items` を組み立てられないため、ここが試験の継ぎ目

## 残り
- [ ] Windows 実機での確認(`MarkdownPreview\dist\mdpreview.html`)

## README にスクリーンショットを追加(2026-09-23)
- [x] `dev/readme-screenshots.mjs`(Playwright + fake-fs でサンプルワークスペースを開いて撮影 → `docs/images/`)
- [x] 撮影: メイン画面 / 起動画面 / アラート / 蛍光ペン / 注釈エディタ / 貼り付けメニュー / HTML 出力のサイドバー目次 / 単体プレビュー / 設定
- [x] README の該当節に画像を挿入、開発者向けに撮り直し手順を追記
- [x] 画像を目視確認

## 設定画面を案B(見本つき)に作り替える(2026-09-25)
見た目の仕様: `dist/settings-demo.html` の「案B 見本つき」(承認済み)
- [x] 見本 iframe の部品 `src/ui/settings-sample.js`(本物の描画経路 + プレビューと同じ CSS、アラート 9 種類)
- [x] `src/index.html` / `src/app.css` を案B の構造・見た目へ
- [x] `src/ui/settings-panel.js`: 深さのラジオ、親オフで子を無効化、戻すボタンの出し分け、見本の更新、× / Esc
- [x] `src/app.js`: 配線と style.css の中身を見本へ渡す
- [x] E2E の更新と追加(見本の連番・アラート文言・無効化・戻すボタン)
- [x] README の設定の表と `docs/images/settings.png` を更新
- [x] 実機確認で指摘: 設定を変えるたびに背景のプレビューが描き直されてちらつく → 「保存」で 1 回だけ反映する形に変更
      (フッタは キャンセル / 保存。キャンセル・× ・Esc は変更を捨てる。背景クリックは未保存の変更が無いときだけ閉じる)
- [x] 実機確認で指摘: 見本が h4 までで h5・h6 の変化が見えない → 見本を h2〜h6 の 1 段ずつ下がる形に
- [x] 「標準 CSS をこのパスへ書き出す」は誤り(書き出し先は常に standard.css)→ 文言を直す
- [x] 実機確認(`MarkdownPreview\dist\mdpreview.html`)再

## 単体表示の「フォルダを開く」とドロップの受け口の改善(2026-09-25)
- [x] 「フォルダを開く」: showDirectoryPicker の startIn に開いている md のハンドルを渡し、その md のフォルダから選べるようにする
- [x] フォルダを開いた後、その md が選んだフォルダの中にあれば開き直す(`dirHandle.resolve(fileHandle)`)
- [x] プレビュー(iframe)の上でも md / フォルダのドロップを受け付ける
- [x] エディタの上: 画像は従来どおり貼り付け、md / フォルダは「開く」として扱う(CodeMirror が中身を文字として挿入しないように)
- [x] E2E
- [x] 実機確認(`MarkdownPreview\dist\mdpreview.html`)
