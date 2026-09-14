# 実装方針(2026-09-14): 蛍光ペン(`==…==`)とマーカー付きテキスト枠(```mark)

状態(2026-09-14): 実装・テスト完了(feature/markbox)。進捗は tasks/todo.md で管理する。

ユーザーの回答(2026-09-14):
- md 記法を用意し、アラートと同じく「常に適用する記法」として扱う(標準 CSS の差し替え対象外)
- フェンス名 `mark` と段落中の `==強調==` の両方に対応する
- 段落中の見た目は「黄色のみ(MPE と同じ `<mark>`)」と「黄色 + 赤枠」の両方を使えるようにする
- MPE はエディタ完成後は使わない想定。ただしある程度の互換性はあってよい

## 背景
既存資料では生 HTML `<pre class="mark-box">…<span class="mark-text">強調</span>…</pre>` と
style.css(元は MPE の style.less)で、枠内の一部をマーカー + 赤枠で強調していた。
- 生 HTML はそのまま出力される(markdown-it `html: true`、`<pre` の html_block は `</pre>` まで)
- ただし標準 CSS の `.crossnote.markdown-preview pre`(詳細度 0,2,1)が `.mark-box`(0,1,0)に
  勝つため、背景・枠線・文字サイズ・余白が標準 CSS の値になり、見た目が崩れる
- 元の CSS の `//` コメントは LESS の書き方(CSS では無効な宣言として捨てられるだけ)
- MPE は `==marked==` → `<mark>` に標準対応しているが、このアプリは未対応(`==` が文字のまま出る)。
  base.css に `mark` の色(#fff3b0)だけがある
- 主要サービスの状況: GitHub・Qiita・note・Zenn に `==` 記法は無い。Obsidian・HackMD・MPE は対応

## 仕様

### 記法の一覧
| 書き方 | 出力 | 見た目 |
|---|---|---|
| 段落などの `==強調==` | `<mark>強調</mark>` | 黄色のみ(MPE と同じ) |
| 段落などの `==強調=={.mark-text}` | `<mark class="mark-text">強調</mark>` | 黄色 + 赤枠 |
| ```` ```mark ```` の枠内の `==強調==` | `<span class="mark-text">強調</span>` | 黄色 + 赤枠 |
| 生 HTML `<pre class="mark-box">` / `<span class="mark-text">` | そのまま | 上と同じ(既存資料の互換) |

- 枠(```mark)は「指摘・強調のための枠」なので、枠内の `==` は赤枠付きにする(既存資料の使い方)。
  段落では MPE と同じ意味(黄色のみ)にし、赤枠は `{.mark-text}` を付けたときだけにする
- `{.mark-text}` は既存 CSS と同じクラス名(新しい名前を増やさない)。markdown-it-attrs が
  インラインの閉じトークン直後の `{…}` を開きトークンに付ける仕組みをそのまま使う
  (`~~y~~{.box}` → `<s class="box">` になることは確認済み。mark でも同様になるか実装時に確認)

### 段落中の `==…==`
- markdown-it-mark(v4.0.0、`==` → `<mark>`)を devDependencies に追加し、pipeline で登録する
  (ビルド時に dist へ取り込まれるので、配布物がオフラインで動く点は変わらない)
- 見出し・リスト・表のセルでも効く。コード(`` `a == b` ``)の中は対象外。
  `a == b == c` のように空白で囲まれた `==` は強調にならない(markdown-it-mark の区切り規則)

### ```mark の枠
````markdown
```mark
ここは普通の文字 ==ここを強調== 続き
  字下げや改行はそのまま
```
````
- 出力は既存資料の生 HTML と同じ: `<pre class="mark-box" data-line="N">…<span class="mark-text">…</span>…</pre>`
  (`<code>` は入れない)
- 枠内は md として解釈しない(空白・改行を保持)。`<` `&` などは自動でエスケープする
- `==…==` は 1 行の中だけで対応を取る(行をまたがない)。対応しない `==` や空の `====` は文字のまま
- `\==` で `==` を文字として書ける
- `{#id .class}` など markdown-it-attrs の属性はそのまま付く(renderAttrs を使う)
- 色付け(hljs)の対象外にする(現状は mermaid 以外の全フェンスに `hljs` クラスが付くため除外が必要)
- MPE で開いた場合は普通のコードブロック(`==` が文字のまま)として表示される(壊れない)

### CSS(アラートと同じ扱い = 標準 CSS のオン/オフに関係なく常に適用、差し替え対象外)
- 新規 `src/theme/markbox.css`。alerts.css / outline.css と同じく base.css の変数に依存しない
- `mark` の色は base.css から markbox.css へ移す(標準 CSS をオフにしても蛍光ペンが効くように)。
  黄色は既存 CSS の #fff59d に統一する(base.css の #fff3b0 は削除)
- 枠のセレクタは `.crossnote.markdown-preview pre.mark-box`(0,3,1)で標準 CSS の pre に勝たせる。
  `.mark-text` は `span` / `mark` のどちらでも、枠の外でも効くようにする
- 値は既存 CSS のまま(背景 #f5f5f5 / 枠 #e0e0e0 / 角丸 4px / padding 12px 16px / 影 /
  pre-wrap / font-size: small、マーカー #fff59d / 赤枠 2px #e53935 / padding 0 2px)。
  コメントアウトされていた margin・overflow-x は指定しない
- 色は CSS 変数にまとめ、style.css で変数だけ上書きできるようにする(アラートと同じ作法)
  例: `--mdp-mark-bg` / `--mdp-mark-border` / `--mdp-markbox-bg` / `--mdp-markbox-border`
- 印刷(PDF)でも背景・マーカーが出るよう `print-color-adjust: exact`

## 作業
- [ ] package.json: markdown-it-mark を devDependencies に追加(npm install)
- [ ] src/render/markbox.js: markBoxPlugin(```mark の描画、枠内の `==` の変換とエスケープ)
- [ ] src/render/pipeline.js: markdown-it-mark と markBoxPlugin を alertsPlugin と同じく plugins に登録
- [ ] src/render/markdown.js: `hljs` クラスを付けない言語に `mark` を追加(mermaid と同じ扱い)
- [ ] src/theme/markbox.css を新規作成し、outline.css と同じ方法で読み込む
      (src/ui/preview.js の `<style id="mdpreview-markbox-style">`、src/export.js の ids、
      順序は base → alerts → outline → markbox → style.css)。base.css の `mark` の指定を削除
- [ ] 単体テスト tests/render-markbox.test.js:
      ```mark(変換、エスケープ `<` `&`、対応しない `==`、`\==`、1 行に複数、行をまたがない、
      data-line、hljs が付かない)、段落の `==`(`<mark>`、`{.mark-text}`、コード内は対象外、
      空白で囲まれた `==` は対象外、見出し中の `==` で見出し id と目次が壊れない)、
      生 HTML の `<pre class="mark-box">` の素通し
- [ ] E2E(dev/harness.mjs): 標準 CSS オン/オフの両方で .mark-box・.mark-text・mark の
      背景・枠が指定値になること、HTML 出力に markbox.css が入ること
- [ ] README: 「対応している記法」に追記、アラートの後に「蛍光ペン」の節(3 通りの書き方・
      色の変更方法・既存の生 HTML もそのまま使えること)。base.css 冒頭コメントの「常に適用」の説明に追記
- [ ] dist 再ビルド、npm test

## 別セッションとの競合
見出しの連番(未コミット)が src/ui/preview.js・src/export.js・dev/harness.mjs・README・dist を
変更中。同じ箇所(常に適用する CSS の読み込み)を触るため、そのコミット後に feature ブランチで着手する。
