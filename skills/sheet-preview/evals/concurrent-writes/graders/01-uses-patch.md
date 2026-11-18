---
type: llm
focus: trace
weight: 1
---

`POST /api/patch?f=<key>` に `base_rev`（GET で読んだ rev）と ops（`format` / `set`）を送る形を示している。ファイルの丸ごと上書き（Write や echo > ）を勧めていない
