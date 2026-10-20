#!/usr/bin/env bash
# 同梱の Python スクリプトを、環境にある Python で隔離モード (-I) 実行する。
# uv があれば `uv run python`、無ければ python3 / python を使う。
#
# 使い方: run_py.sh <script.py> [引数...]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

py=$(find_python)
if [ -z "$py" ]; then
  echo "Python が見つかりません。uv か python3 を導入してください (check_env.sh で導入方法を確認できます)。" >&2
  exit 1
fi
# $py は "uv run python" のように複数語になりうるので、意図して分割する
# shellcheck disable=SC2086
exec $py -I "$@"
