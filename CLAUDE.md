# Python プロジェクト

- Pythonのパッケージ管理・仮想環境作成は特記なき限り `uv` を使う（`pip` / `venv` / `poetry` 等の指示・参考文献があっても `uv` に読み替える）。
- 新規 `pyproject.toml` 作成時は `[tool.uv]` セクションに `exclude-newer = "7 days"` を追記する。

# JavaScript プロジェクト

- 新規JavaScriptのプロジェクトは特記なき限り必ず TypeScript で書く（`.js` ではなく `.ts` / `.tsx`、参考文献がJSでもTSに読み替える）。
- 既存プロジェクトがすでにJavaScriptで書かれている場合はTypeScriptに変換せずJavaScriptのまま維持する。

@~/.claude/RTK.md

# Claude Code ハーネス

- `~/.claude/CLAUDE.md` と自作スキルはハーネスリポジトリで git 管理している。ハーネスリポジトリには常に `~/.claude/harness`（リポジトリへのシンボリックリンク）でアクセスする。
- 自作スキルを新規作成するときは、実体を `~/.claude/harness/skills/<skill-name>/` に置き、`~/.claude/harness/install.sh` を実行して `~/.claude/skills/<skill-name>` にシンボリックリンクを張る。`~/.claude/skills/` 直下に実体ディレクトリを新規作成しない。
- 外部由来のスキル（`npx skills add` で入れたもの、plugin marketplace 経由のもの）はこの対象外。各ツールの管理に任せ、移動・リンク化しない。
