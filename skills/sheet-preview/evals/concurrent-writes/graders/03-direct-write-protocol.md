---
type: llm
focus: trace
weight: 1
---

API を使えない場合は `<file>.lock` の排他作成 → ロック後に読み直し → tmp に書いて rename → rev を +1、の手順だと示している（ロックなしの直接書き込みを勧めない）
