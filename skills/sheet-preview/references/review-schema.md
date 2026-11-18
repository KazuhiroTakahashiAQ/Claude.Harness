# review.json スキーマ

人とエージェントのやり取り。ファイル名は `<名前>.review.json`（sheet.json と同じフォルダ）。review.json は sheet.json ごとに 1 つ。単位は**スレッド**。

```json
{
  "sheet": "confirm.sheet.json",
  "rev": 7,
  "threads": [
    {
      "id": "t1",
      "range": "明細!C5",
      "kind": "確認",
      "status": "確認待ち",
      "messages": [
        { "author": "agent", "name": "claude", "text": "単価は税抜でよいか", "at": "2026-11-18T05:00:00.000Z" },
        { "author": "human", "text": "税込で", "at": "2026-11-18T05:10:00.000Z" }
      ]
    }
  ]
}
```

| キー | 型 | 内容 |
|---|---|---|
| `sheet` | string | 対応する sheet.json のファイル名（サーバが入れる） |
| `rev` | integer | 書き込みのたびに +1。直接書くエージェントも +1 する |
| `threads[].id` | string | 追加時に採番（`add` の応答で返る） |
| `threads[].range` | string | 対象。`明細!B2:D5, F3`（複数はカンマ区切り。シート名は直前の指定を引き継ぐ。スペース等を含む名前は `'月次 売上'!A1`）/ 行 `明細!5:5`・複数行 `明細!2:4`（`明細!2:4, 7:7`）/ 列 `明細!C:C`・複数列 `明細!B:D`（`明細!B:B, D:D`）/ 行と列・セル範囲の混在 `明細!B:B, 2:2, F3:G4` / シート全体 `明細!*` / ファイル全体 `*` |
| `threads[].kind` | `指示` \| `確認` \| `メモ` | 指示 = 人から AI への修正依頼。確認 = AI から人への質問。メモ = 記録のみ |
| `threads[].status` | `未対応` \| `対応済` \| `質問` \| `確認待ち` \| `解決` | 下の状態遷移 |
| `threads[].messages[]` | `{author, name?, text, at}` | `author` は `human` か `agent`。`name` は書き手の表示名（任意）。`at` は ISO 8601 |
| `threads[].deleted` | boolean（任意） | 行・列の削除で `range` の対象がすべて消えたとき `true`。`range` は消える直前の位置のまま |

## 状態遷移
- 指示: 人が追加 = `未対応` → AI が直して返信 = `対応済`（曖昧なら `質問`）→ 人が返信すると `未対応` に戻る → 人が `解決`。
- 確認: AI が追加 = `確認待ち` → 人が返信すると `未対応`（AI の番）→ AI が反映して `対応済` → 人が `解決`。
- 人は「解決」「開き直し」を手で押せる。`解決` はもう扱わない。

## API
`POST /api/review/patch?f=<key>` に `{"ops":[...]}`。項目単位でマージされ、常に通る。

| op | 形 |
|---|---|
| `add` | `{op:"add", range, text, kind?, author?, name?, status?}`。`author` 既定 `agent`。`kind` 既定は agent=`確認` / human=`指示`。`status` 既定は 指示=`未対応` / それ以外=`確認待ち` |
| `reply` | `{op:"reply", id, text, author?, name?, status?}`。人の返信は status 指定が無ければ `未対応` に戻す。AI の返信は status 指定が無ければ据え置き（`対応済` などは明示する） |
| `status` | `{op:"status", id, status}` |
| `setRange` | `{op:"setRange", id, range, deleted?}` |
| `delete` | `{op:"delete", id}`（通常は使わない。履歴として残す） |

応答: `{ok, rev, changed, results:[{ok, id}], review:{sheet, rev, threads}}`。`results` は ops と同じ順。未知の id は `{ok:false, error:"unknown id"}`。

`POST /api/review`（`{threads, base_rev?}`）は全体の置き換え（互換用。画面の保存はこちらでなく ops を使う）。rev が古ければ 409。

## 互換
- 旧形式 `{"items":[{id, range, instruction, status, agent_reply, deleted?}]}` は読み込み時にスレッドへ変換される（`instruction` → human の最初のメッセージ、`agent_reply` → agent のメッセージ。`kind` は `指示`）。保存すると新形式になる。
- サーバは保存時に status / kind / author の値と range・text の型を検証し、違えば 400。
- 範囲は画面での行・列の挿入・削除・並べ替えに追従して書き換わる。複数範囲は範囲ごとに追従し（列の範囲は行の操作の影響を受けず、行の範囲は列の操作の影響を受けない）、一部だけ消えたら残りだけになり、全部消えたら `deleted: true`。サーバの API（行・列の挿入・削除）でも同じ。
- コメントの本文（`messages[].text`）も、文末の「。」のたびに `\n` で改行する（`node scripts/serve.ts --lint <name>.sheet.json` で確認）。読むときは現在の sheet.json の位置を指しているとみなしてよい。
- 「指示をコピー」で出る JSON は同じ形。

## 直接書くとき
`<name>.review.json.lock` を排他作成 → 読み直す → 変更 → `.tmp` に書いて `rename` → `rev` を +1 → lock を消す。API を使えるならそちらを使う（SKILL.md「往復」）。
