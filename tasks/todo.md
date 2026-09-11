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
- [ ] フォルダの選択と再許可(最近使ったルートを複数保持)
- [ ] ファイルツリー(遅延読み込み、.md とフォルダのみ)、最後に開いたファイル、`#file=`
- [ ] 開く・保存(Ctrl+S、未保存の印、競合チェック、withRetry)
- [ ] 変更検知(フォーカス時と表示中の 2 秒ポーリング、書き込み中は停止、通知バー)

## フェーズ 2: エディタ + プレビュー
- [ ] CodeMirror 6、markdown-it、highlight.js、mermaid
- [ ] iframe srcdoc プレビュー(MPE と同じ構造 `crossnote markdown-preview`)
- [ ] base.css + style.css の即時反映
- [ ] 画像の blob URL 化、スクロール同期(data-line)

## フェーズ 3: MPE 互換
- [ ] 見出し id(heading-id-generator の移植 + uslug)、`{#id .class}`、`{width=}`
- [ ] @import "x.md"(2 形式、入れ子、循環検出、相対パスの書き換え、行番号の対応表)
- [ ] TOC: `[TOC]` とソース書き込み型(code_chunk_output)
- [ ] アラート `> [!NOTE]` 等

## フェーズ 4: 画像の貼り付けとドロップ
- [ ] images/<md名>-YYYYMMDD-HHmmss.png に保存して参照を挿入

## フェーズ 5: 注釈エディタ
- [ ] 赤枠 / 矢印(接続と追従)/ 吹き出し / 切り抜き / 倍率 / 元に戻す・やり直し
- [ ] PNG iTXt への保存と再編集、PNG 以外の画像の扱い

## フェーズ 6: HTML 出力
- [ ] 通常出力(CSS インライン、mermaid SVG、画像は相対パス)
- [ ] 1 ファイル出力(画像を base64 で埋め込み)

## フェーズ 7: README と最終確認
- [ ] README(導入と使い方)
- [ ] 全テスト、Windows 実機での確認依頼
