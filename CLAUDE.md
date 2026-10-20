# Python プロジェクト

- Pythonのパッケージ管理・仮想環境作成は特記なき限り `uv` を使う（`pip` / `venv` / `poetry` 等の指示・参考文献があっても `uv` に読み替える）。
- 新規 `pyproject.toml` 作成時は `[tool.uv]` セクションに `exclude-newer = "7 days"` を追記する。

# JavaScript プロジェクト

- 新規JavaScriptのプロジェクトは特記なき限り必ず TypeScript で書く（`.js` ではなく `.ts` / `.tsx`、参考文献がJSでもTSに読み替える）。
- 既存プロジェクトがすでにJavaScriptで書かれている場合はTypeScriptに変換せずJavaScriptのまま維持する。

@~/.claude/RTK.md

# Claude Code ハーネス

- `~/.claude/CLAUDE.md` と自作スキルはハーネスリポジトリ（https://github.com/KazuhiroTakahashiAQ/Claude.Harness）で git 管理している。
- ハーネスリポジトリの場所は環境ごとに異なる。デフォルトは `~/work/Claude.Harness/`。次の順で特定する。
  1. `~/.claude/CLAUDE.md` がシンボリックリンクなら `dirname "$(readlink ~/.claude/CLAUDE.md)"`。
  2. そうでなければ `~/work/Claude.Harness/`。
  3. どちらにも存在しない場合は `git clone git@github.com:KazuhiroTakahashiAQ/Claude.Harness.git ~/work/Claude.Harness` で新規作成し、`install.sh` を実行する。
- 自作スキルを新規作成するときは、まず配置先を決める。
  - 全プロジェクト共通で使うスキル: 実体をハーネスリポジトリの `skills/<skill-name>/` に置き、リポジトリ直下の `install.sh` を実行して `~/.claude/skills/<skill-name>` にシンボリックリンクを張る。`~/.claude/skills/` 直下に実体ディレクトリを新規作成しない。
  - 特定プロジェクトだけで使うスキル: そのプロジェクトの `.claude/skills/<skill-name>/` に置く。ハーネスリポジトリには入れない。
  - どちらか判断できない場合は、作成前にユーザーに確認する。
- 外部由来のスキル（`npx skills add` で入れたもの、plugin marketplace 経由のもの）はこの対象外。各ツールの管理に任せ、移動・リンク化しない。
