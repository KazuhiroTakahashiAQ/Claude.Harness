---
tags: [sheet-preview]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

keihi.sheet.json と keihi.review.json がある。人が画面で直接直したあとの状態。review.json の未対応の指示を処理して、返答を書いて。
Input files: keihi.sheet.json, keihi.review.json
