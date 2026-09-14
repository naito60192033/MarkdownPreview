# 実装方針(2026-09-14): ファイル操作(新規 md・新規フォルダ・名前の変更・削除)

状態(2026-09-14): 実装・テスト・Windows 実機での確認完了。dev へマージ済み。進捗は tasks/todo.md で管理する。

## Context
MarkdownPreview(`/workspaces/cc-projects/MarkdownPreview`、単独 HTML の md エディタ)には、ツリーでファイルを
開く・保存する機能しかなく、md を新しく作る手段が無い(エクスプローラで作ってからアプリを開き直す必要がある)。
ユーザーの回答(2026-09-14):
- 操作の入口は **サイドバー上部のボタン** と **ツリーの右クリックメニュー** の両方
- 範囲は **ファイル操作一式**(新規 md・新規フォルダ・名前の変更・削除)
- 新規 md の初期内容は **空(0 バイト)**

## 仕様

### 入口
- サイドバー上部に `＋ md` `＋ フォルダ` `⟳`(ツリーの再読込)のボタン。作成先の初期値は
  「今開いている md のフォルダ」(開いていなければルート)
- 右クリックメニュー(`src/ui/context-menu.js`、画面外にはみ出さない位置補正・外側クリック / Esc / スクロールで閉じる)
  - md の行: 名前の変更 / 削除
  - フォルダの行: 新規 md / 新規フォルダ / 名前の変更 / 削除
  - ツリーの余白(= ルート): 新規 md / 新規フォルダ
- キーボード: ツリーの行にフォーカスがあるとき F2 = 名前の変更、Delete = 削除

### 名前の入力(新規モーダル `#nameModal` + `src/ui/name-modal.js`、conflict-modal と同じ作り)
- 新規作成: 入力欄は **ルート相対パス**。初期値は作成先フォルダ + `/`(例 `docs/`)、カーソルは末尾。
  `sub/memo` のようにフォルダ付きで打てば途中のフォルダも作る
- 名前の変更: 入力欄は **名前だけ**(`/` 不可 = 別フォルダへの移動はしない)。拡張子の手前までを選択した状態で開く
- md は拡張子が `.md` / `.markdown` でなければ `.md` を付ける(ツリーから消えないように)
- 入力エラーはモーダル内に赤字で出し、閉じない。Enter = 決定、Esc / 背景クリック = キャンセル
- 検証(純関数 `src/fs/names.js`、単体テスト対象):
  - 空、`\ : * ? " < > |`・制御文字、`.` `..`、末尾の `.` / 空白、Windows の予約名(CON・PRN・AUX・NUL・COM1〜9・LPT1〜9。拡張子付きも)
  - `.` 始まり(ツリーに出ないため)
  - 同名(ファイル・フォルダとも、**大文字小文字を区別しない** = Windows と同じ)が既にあれば不可。
    ただし名前の変更での大文字小文字だけの変更(`a.md` → `A.md`)は許可(実装は下記)

### 削除
- 確認は `window.confirm`(既存の confirmDiscardIfDirty と同じ)。**ごみ箱に入らず完全に削除される** ことを明記
- フォルダは中身ごと削除(`removeEntry(name, { recursive: true })`)。ツリーには md しか出ないため、確認文に
  中身の件数(「md 3 件・その他のファイル 12 件・フォルダ 2 件」)を出す
- 開いている md(またはそれを含むフォルダ)を消したら、エディタを閉じる(未保存があれば確認文で「未保存の変更も失われます」)

### 開いている md への影響(src/app.js に集約)
- 新規 md: 作成 → ツリーを更新してその行を表示 → `openFile()`(未保存があれば従来どおり破棄確認。キャンセルなら作成だけ行い
  「作成しました(開いていません)」)
- 名前の変更で開いている md のパスが変わる(本体・親フォルダ): 編集中の内容と未保存状態は **そのまま** 引き継ぎ、
  `state.currentPath`・watcher(旧パスを unwatch・新パスを watch)・`#file=`・最後に開いたファイル・タイトル・ツリーの強調を更新。
  新しいファイルの lastModified を読み直して `state.lastModified` に入れる(次の保存で競合モーダルが誤って出ないように)
- 削除: `closeCurrentFile()` を新設(unwatch・エディタを空に・プレビューを空に・`#file=` と最後のファイルを消す)
- 他の md からのリンク・`@import`・画像フォルダ `images/<md名>/` は **書き換えない**(README に明記)。
  画像の参照パスは変わらないので、md の名前を変えても既存の画像は表示される

### ツリー(src/ui/tree.js)
- 開いているフォルダのパス集合 `openPaths` を持ち、`refresh()` は開いていたフォルダを開いたまま再描画する
- `reveal(path)`: 祖先フォルダを開いて再描画し、行を scrollIntoView
- `onContextMenu({ kind: 'file' | 'dir' | 'root', path, x, y })`・`onKeyAction({ action: 'rename' | 'delete', kind, path })` を呼ぶ
- 名前の変更・削除したフォルダ配下の `openPaths` を付け替え / 削除

### FSA の操作(src/fs/workspace.js に追加、DOM 非依存、一時的エラーは withRetry)
- `findEntryName(dir, name)`(大文字小文字を区別せずに実在の名前を返す)
- `createFileByPath(root, path)`(`getFileHandle({ create: true })` で 0 バイト作成)・`createDirByPath(root, path)`。
  同名があれば `AlreadyExistsError`
- `renameEntry(root, path, newName, { onProgress })`。調査結果(2026-09-14): フォルダの `move()` は Chrome に無い
  (`FileSystemDirectoryHandle.prototype.move` 未定義)。ファイルの `move()` はピッカー由来(OPFS 外)では
  「フラグの裏」と公式ドキュメントにあり、実機で動くかは不確定。そのため
  (2026-09-14: ユーザーの Windows の Chrome ではファイルの move() が使われることを確認。フォールバックは残す):
  - **ファイル**: `fh.move(newName)` があれば試す。失敗したら「元が残っていて、移動先が無い」ことを確かめてから
    コピー方式(読む → 新しい名前で書く → サイズを照合 → 元を削除)で行う
  - **フォルダ**: 常にコピー方式(中身を md 以外・ドット始まりも含めて再帰コピー → 件数とサイズを照合 → 元を
    `removeEntry(recursive)`)。途中で失敗したら元は消さず、作りかけのコピーを消してエラー表示。進捗をステータスバーに出す
    (「コピー中 12/40」)。中のファイルの更新日時は新しくなる(README に明記)
  - **大文字小文字だけの変更**: Windows では `A.md` と `a.md` が同じファイルのため、コピー方式だと元を消す段で
    データを失う。一時名(`<名前>.renaming-<乱数>`)を経由する 2 段階にする(move・コピーとも)
- `deleteEntry(root, path)`(`removeEntry(name, { recursive: true })`)・`countEntries(dirHandle)`

### テスト基盤(dev/fake-fs.mjs)
- **ファイル**ハンドルにだけ `move(newName)` を追加(実機と同じくフォルダには無い。Node 側 `fs.rename`、ハンドルの name / パスも更新)。
  `window.__fakeFs.setFileMoveSupported(false)` で `NotSupportedError` を投げ、コピー方式の経路もテストできるようにする
- `removeEntry(name, { recursive })`: フォルダ対応(recursive なしで中身があれば `InvalidModificationError`)

## 作業(ブランチ `feature/fileops`、dev から作成)
- [ ] tasks/plan-2026-09-14-fileops.md(本方針)と tasks/todo.md に節を追加
- [ ] src/fs/names.js + tests/names.test.js(検証・`.md` の付与)
- [ ] src/fs/workspace.js に作成・名前の変更・削除・件数
- [ ] src/ui/tree.js(refresh / reveal / openPaths / contextmenu / F2・Delete)
- [ ] src/ui/context-menu.js、src/ui/name-modal.js、src/index.html(サイドバー上部のボタン・#nameModal)、src/app.css
- [ ] src/app.js(操作の配線、開いている md の付け替え・closeCurrentFile、E2E 用フック)
- [ ] dev/fake-fs.mjs(move・recursive 削除)
- [ ] E2E(dev/harness.mjs に新セクション)
- [ ] README「ファイルとフォルダの操作」(削除は完全削除、リンクは書き換えない)、dist 再ビルド

## 検証
- `npm test`(build → 単体 → E2E → 注釈 E2E)がすべて通ること。追加する E2E:
  1. `＋ md`: 開いている md のフォルダに 0 バイトの md ができ、開かれ、ツリーに出る。`sub2/x` で途中のフォルダも作る
  2. 同名(大文字小文字違いを含む)・禁止文字はモーダル内エラーで閉じず、既存ファイルは変わらない
  3. フォルダの右クリック → 新規フォルダ / 新規 md がそのフォルダの中にできる
  4. 未保存のまま開いている md の名前を変える → ディスク上で名前が変わり、内容と未保存の印は残り、保存すると
     新しいパスに書かれ競合モーダルが出ない。`#file=` も新しいパス。大文字小文字だけの変更もできる。
     move あり / move なし(コピー方式)の両方で確認
  5. 開いている md を含むフォルダの名前を変える → `currentPath` が付け替わり、md 以外(画像・ドット始まり)も
     バイト一致でコピーされ、元のフォルダは消える
  6. 削除: confirm で OK → ディスクから消え、開いていた md なら閉じる。キャンセル → 何も変わらない。
     md 以外を含むフォルダの確認文に件数が出る
  7. `⟳`: 外部で追加した md が出て、開いていたフォルダは開いたまま
  8. 各テストでコンソールエラー 0 件
- Windows 実機(Chrome、ローカルと共有フォルダ)での確認をユーザーに依頼(特に名前の変更と削除。
  ファイルの move が実機で使われたかコピー方式になったかを、ステータスバーの完了文言の違いで見分けられるようにする)

## 実装の分担
設計はここで確定。実装の手作業(コード・テスト・README・dist)は `implementer`(Sonnet)に本方針を渡して委譲し、
差分のレビュー・`npm test` の結果確認・コミットはメインで行う
