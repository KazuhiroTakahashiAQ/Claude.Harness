---
name: sheet-preview
description: スプレッドシート / Excel を作る前に、中身（シート構成・列幅・結合・色・セル値）を HTML で目視確認し、セル範囲を選んで「ここをこう直して」と指示を書き、エージェントと往復して固めるための skill。固まったら xlsx に変換する。表の設計・帳票・管理表・一覧表・集計表のレイアウトを xlsx / Google Sheets 化する前に確認したいとき、「シートのプレビューが見たい」「Excel の雛形を作って」「この範囲をこう直したい」「スプレッドシートの構成を確認したい」「表のスキーマを先に決めたい」と言われたとき、既存の表を HTML で見ながらセル単位で修正指示を出したいときは、明示的に頼まれなくても使うこと。
---

# sheet-preview

スプレッドシートを作る前に、内容を HTML で見て、セル範囲単位で指示を出し、直して、また見る。この往復で固めてから xlsx にする。

正本は JSON で、HTML はそれを描くだけ。直すのは常に JSON（`sheet.json`）で、HTML を直接編集しない。こうすると、エージェントが差分を機械的に追え、xlsx 変換と見た目が食い違わない。

## ファイル

| ファイル | 役割 |
|---|---|
| `<名前>.sheet.json` | 正本。シート複数、列幅、行高、結合、色、セル値。スキーマは `references/sheet-schema.md` |
| `<名前>.review.json` | 人の指示。range / instruction / status / agent_reply。スキーマは `references/review-schema.md` |
| `scripts/serve.ts` | localhost で HTML を配信し、「保存」で review.json を書く（依存なし） |
| `scripts/to_xlsx.py` | sheet.json → xlsx（openpyxl、uv 経由） |
| `assets/template.html` | 描画用テンプレート（serve.ts が埋め込んで配信） |
| `examples/sample.sheet.json` | サンプル（2 シート、結合・色・幅あり） |

作業ファイルは、依頼された場所か、作業中のプロジェクトの適当なフォルダに置く。skill のフォルダには置かない。

## 2 つの用途

最初にどちらかを決め、sheet.json の `mode` に書く（HTML ヘッダーに表示される）。

- **スキーマ確認（`"schema"`）**: 列構成・見出し・結合・色・数式の置き場所など、枠組みを決める。セル値は空やダミーでよい。「備考欄はここ」「合計行は結合したい」のような指示が中心。
- **実データ確認（`"data"`）**: 実際の値を入れて、中身の誤り・抜け・並びを確認する。「この行の単価が違う」「C 列は千円単位に」のような指示が中心。

迷ったら、データがまだ無ければ schema、あれば data。

## 手順

### 1. sheet.json を作る
依頼内容（目的、必要な列、見せたい集計など）から `<名前>.sheet.json` を書く。まず `references/sheet-schema.md` を読む。`examples/sample.sheet.json` を雛形にするとよい。ヘッダー行は色を付け、列幅は内容に合わせる。見た目の確認が目的なので、シート数・行数は確認に足りる最小限にする。

### 2. 起動して人に見せる
```bash
node <skill>/scripts/serve.ts <名前>.sheet.json            # http://localhost:8765/
node <skill>/scripts/serve.ts <名前>.sheet.json --port 8800 # ポート変更
```
`node x.ts` 形式で動く（Node 22.6 以降。TypeScript の型は実行時に除去される）。バックグラウンドで起動し、URL を人に伝える。サーバを立てられない・使いたくない場合は静的 HTML を出す。

```bash
node <skill>/scripts/serve.ts <名前>.sheet.json --render <名前>.html
```

### 3. 人が指示を書く
人は HTML 上でセルをドラッグ、Shift クリックで拡張、Ctrl/Cmd クリックで追加選択し、指示を書いて「一覧に追加」する。列見出し・行見出しのクリックで列・行ごと選べる。範囲欄に直接 `明細!B2:D5, F3` と打ってもよい。

- **「保存」**: サーバが `<名前>.review.json` に書く。
- **サーバが無いとき**: ブラウザの localStorage に保持される。「指示をコピー」で JSON がクリップボードに入るので、人がチャットに貼る。貼られた JSON は `review.json` として保存して続ける。

### 4. 往復（エージェントの仕事）
指示を受け取ったら、この順で処理する。

1. `review.json` を読み、`status` が「未対応」の項目を拾う。
2. 各 `range` が指すセルを sheet.json で確認し、`instruction` どおりに sheet.json を直す。結合・色・幅など書式の指示も sheet.json 側で表現する。
3. 指示の意味が曖昧、または複数の解釈があるときは、勝手に決めず `status` を「質問」にして `agent_reply` に質問を書く。
4. 直せた項目は `status` を「対応済」にし、`agent_reply` に何をどう直したか 1〜2 文で書く。
5. 人にはブラウザの「再読み込み」を押してもらう（サーバは sheet.json / review.json を毎回ファイルから読むので、サーバの再起動は要らない。静的 HTML を使っている場合は `--render` で描き直す）。

review.json の項目は削除せず、履歴として残す。人が「質問」に答えたり、指示を書き足したりしたら、また 1 に戻る。人が「これでよい」と言うまで繰り返す。

エージェントが review.json を書き換えている間に人が「保存」を押すと、人側の内容で上書きされうる。返答を書き込んだら、すぐ人に再読み込みを促す。

### 5. xlsx にする
```bash
uv run <skill>/scripts/to_xlsx.py <名前>.sheet.json <名前>.xlsx
```
`uv` 経由で openpyxl が自動で入る（pip は使わない）。列幅は px から文字数、行高は px から pt に近似変換する。数式（`=` で始まる値）はそのまま xlsx の数式になる。

### Google Sheets への書き込みは承認制
xlsx を Google Drive / Sheets にアップロード・書き込みするのは外部書き込み。書く内容（宛先・対象ファイル）を提示し、人の明示的な承認を得てから実行する。承認なしにしない。ローカルの xlsx 出力は承認不要。

## 指示の書き方（人向けの補足）
範囲は A1 形式。シート名は `!` の前に付ける（`明細!B2:D5`）。複数範囲はカンマ区切りで、シート名は最初の 1 回でよい（`明細!B2:D5, F3`）。別シートを混ぜるときは `明細!B2:D5, 集計!A1` のように書く。スペースや記号を含むシート名は `'月次 売上'!A1` と引用符で囲む。
