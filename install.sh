#!/usr/bin/env bash
# リポジトリ内の CLAUDE.md と skills/* を ~/.claude 配下へシンボリックリンクする。
# 既存の実ファイル/ディレクトリがある場合は上書きせずスキップする。
set -euo pipefail
shopt -s nullglob

# シンボリックリンク経由で呼ばれても実体のパスを得るため -P で解決する
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

link() {
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    ln -sfn "$src" "$dst"
  elif [ -e "$dst" ]; then
    echo "skip (実体が存在): $dst" >&2
    return
  else
    ln -s "$src" "$dst"
  fi
  echo "link: $dst -> $src"
}

mkdir -p "$CLAUDE_DIR/skills"
link "$REPO/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
for d in "$REPO"/skills/*/; do
  name="$(basename "$d")"
  link "${d%/}" "$CLAUDE_DIR/skills/$name"
done
