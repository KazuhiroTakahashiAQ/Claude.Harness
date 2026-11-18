# sheet.json スキーマ

HTML 描画と xlsx 変換の正本。ファイル名は `<名前>.sheet.json`。UTF-8。

## トップレベル

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `title` | string | 推奨 | HTML ヘッダーに表示 |
| `mode` | `"schema"` \| `"data"` | 推奨 | スキーマ確認 / 実データ確認。表示ラベルのみに使う |
| `sheets` | Sheet[] | 必須 | 1 枚以上。順序がタブ順 |

## Sheet

| キー | 型 | 内容 |
|---|---|---|
| `name` | string | シート名（必須、31 文字以内、`[]:*?/\` は不可。xlsx の制約） |
| `colWidths` | `{ "A": 90, ... }` | 列幅（px）。未指定は `defaultColWidth`（既定 90） |
| `rowHeights` | `{ "1": 36, ... }` | 行高（px）。未指定は `defaultRowHeight`（既定 24） |
| `defaultColWidth` / `defaultRowHeight` | number | 既定値（HTML のみ。xlsx では未指定の列・行は既定のまま） |
| `rows` / `cols` | number | 最低限表示する行数 / 列数。未指定ならセル・結合の最大位置から決める（最小 10 行 6 列） |
| `merges` | string[] | 結合範囲。`["A1:F1", "A3:A4"]`。左上セルが値と書式を持つ |
| `freeze` | string | 固定する境目のセル。`"A3"` なら 1〜2 行目を固定（xlsx のみ反映） |
| `cells` | `{ "A1": Cell, ... }` | A1 形式をキーにしたセル。書かないセルは空・無書式 |

## Cell

| キー | 型 | 内容 |
|---|---|---|
| `v` | string \| number | 値。`=` で始まる文字列は xlsx で数式になる（HTML は式をそのまま表示） |
| `bg` | `#rrggbb` | 背景色 |
| `color` | `#rrggbb` | 文字色 |
| `bold` | boolean | 太字 |
| `size` | number | 文字サイズ（px / pt を区別せずそのまま） |
| `align` | `left` \| `center` \| `right` | 横位置 |
| `valign` | `top` \| `middle` \| `bottom` | 縦位置（xlsx は `middle`→`center` に読み替え） |
| `wrap` | boolean | 折り返し |
| `numFmt` | string | 数値書式。`"#,##0"` など Excel の書式文字列（HTML は `#,##0` のみ簡易反映） |

## 注意
- 結合セルの値・書式は左上セルに書く。結合に隠れるセルの内容は描画されない。
- 色は `#rgb` / `#rrggbb`。名前付き色は xlsx で使えない。
- スキーマ確認モードでは `v` を空にしてよい。入力欄は薄い色（例 `#fff9db`）にすると分かりやすい。
