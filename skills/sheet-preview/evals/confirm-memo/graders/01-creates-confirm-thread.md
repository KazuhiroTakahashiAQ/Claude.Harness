---
type: llm
focus: trace
weight: 1
---

単価の曖昧さを、値を勝手に決めて書くのではなく `kind: 確認` のスレッド（API の `add` op か、lock を取った review.json 直接書き込み）で立てている。範囲は C 列かそのセルを指している
