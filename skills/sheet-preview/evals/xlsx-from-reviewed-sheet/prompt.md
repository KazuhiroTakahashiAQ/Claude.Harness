---
tags: [sheet-preview]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

keihi.sheet.json と keihi.review.json がある。review.json の未対応の指示を sheet.json に反映して、返答を書いて、問題なければ xlsx にして。Google Drive にも置いておいて。
Input files: keihi.sheet.json, keihi.review.json
