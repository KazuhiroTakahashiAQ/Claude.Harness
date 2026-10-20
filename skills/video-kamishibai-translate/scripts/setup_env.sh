#!/usr/bin/env bash
# faster-whisper 用の、このスキル専用の Python 仮想環境を作る (whisper.cpp を使う場合や、字幕ファイルを使う場合は不要)。
# 同梱の Python スクリプト (サマリー生成・字幕処理など) は標準ライブラリだけで動くので、仮想環境は要らない。
#
# 使い方: setup_env.sh [--dry-run] [--allow-pip]
#   --dry-run    何も作らず、これから行うことだけを表示する
#   --allow-pip  uv が無いときに、python3 -m venv + pip で作る (既定では uv の導入を案内して終わる)
#
# 環境変数:
#   VKT_VENV                 仮想環境の場所 (既定: ~/.cache/video-kamishibai-translate/venv)
#   VKT_PYTHON               uv が使う Python のバージョン (既定 3.12)
#   VKT_EXCLUDE_NEWER_DAYS   uv で導入するとき、公開から N 日以内のパッケージを避ける (既定 7、0 で無効)
#
# 注意: 仮想環境の作成とパッケージの取得にはネットワークとディスク (数百MB) を使う。
#       ユーザーの承認を取ってから実行すること。プロジェクトのディレクトリは変更しない。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

dry=0
allow_pip=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --allow-pip) allow_pip=1 ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "不明な引数: $a" >&2; exit 2 ;;
  esac
done

venv=$(venv_dir)
pyver=${VKT_PYTHON:-3.12}
cutoff=$(exclude_newer_cutoff || true)

if [ -n "$(venv_has_faster_whisper)" ]; then
  echo "既に作成済みです: $venv (faster-whisper を import できます)"
  exit 0
fi

echo "== 作成する仮想環境 =="
echo "  場所        : $venv"
echo "  パッケージ  : faster-whisper"
if [ -n "$cutoff" ]; then echo "  日付の制限  : $cutoff より後に公開されたパッケージは使わない (uv 使用時)"; fi

if command -v uv >/dev/null 2>&1; then
  method=uv
elif [ "$allow_pip" -eq 1 ] && command -v python3 >/dev/null 2>&1 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  method=pip
else
  method=none
fi
echo "  方法        : $method"

if [ "$method" = none ]; then
  echo
  echo "uv が見つかりません。uv を導入してから、もう一度実行してください (導入はユーザーの承認を取ること):" >&2
  echo "  macOS  : brew install uv   または  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  Linux  : curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "  Windows: winget install astral-sh.uv   または  powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\"" >&2
  echo "uv を使わず python3 (3.9 以上) の venv + pip で作る場合は、--allow-pip を付けて実行してください。" >&2
  exit 1
fi

if [ "$dry" -eq 1 ]; then
  echo "(--dry-run のため、何も作りません)"
  exit 0
fi

mkdir -p "$(dirname "$venv")"
if [ "$method" = uv ]; then
  uv venv --python "$pyver" "$venv"
  vpy=$(venv_python)
  if [ -n "$cutoff" ]; then
    uv pip install --python "$vpy" --exclude-newer "$cutoff" faster-whisper
  else
    uv pip install --python "$vpy" faster-whisper
  fi
else
  python3 -m venv "$venv"
  vpy=$(venv_python)
  "$vpy" -m pip install --upgrade pip faster-whisper
fi

if "$vpy" -c "import faster_whisper" >/dev/null 2>&1; then
  echo "完了: $venv (faster-whisper を import できました)"
  echo "prepare.sh は、この環境があれば自動で使います。"
else
  echo "faster-whisper を import できませんでした。ログを確認してください: $venv" >&2
  exit 1
fi
