#!/usr/bin/env bash
# 各スクリプトから `source` して使う共通関数。環境 (OS、導入済みツール) の違いをここで吸収する。
# 直接実行はしない。

# 実行環境: darwin / linux / windows (Git Bash, MSYS, Cygwin) / unknown
detect_os() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    MINGW* | MSYS* | CYGWIN*) echo windows ;;
    *) echo unknown ;;
  esac
}

# 指定コマンドが Python 3.8 以上として動くか (macOS の python3 は、未導入だと導入ダイアログが出るだけのことがある)
py_ok() {
  "$@" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1
}

# 同梱の Python スクリプト (標準ライブラリだけで動く) を実行するコマンド。
# uv があれば uv、無ければ動作確認できた python3 / python を使う。
# uv には --no-project を付ける: 付けないと、実行したディレクトリが uv のプロジェクト (pyproject.toml) のとき、
# そのプロジェクトに .venv と uv.lock を作り、依存関係を導入してしまう。
find_python() {
  if command -v uv >/dev/null 2>&1; then
    echo "uv run --no-project python"
  elif command -v python3 >/dev/null 2>&1 && py_ok python3; then
    echo "python3"
  elif command -v python >/dev/null 2>&1 && py_ok python; then
    echo "python"
  fi
}

# このスキル専用の仮想環境 (faster-whisper など、標準ライブラリ以外が必要なときだけ使う)
venv_dir() {
  echo "${VKT_VENV:-${XDG_CACHE_HOME:-$HOME/.cache}/video-kamishibai-translate/venv}"
}

# 専用の仮想環境の Python (あれば)。macOS / Linux は bin/python、Windows は Scripts/python.exe
venv_python() {
  local d p
  d=$(venv_dir)
  for p in "$d/bin/python" "$d/Scripts/python.exe"; do
    if [ -x "$p" ]; then
      echo "$p"
      return
    fi
  done
}

# faster-whisper を import できる Python (専用の仮想環境にあれば、そのパス)
venv_has_faster_whisper() {
  local p
  p=$(venv_python)
  if [ -n "$p" ] && "$p" -c "import faster_whisper" >/dev/null 2>&1; then
    echo "$p"
  fi
}

# uv で導入するとき、公開から日の浅いパッケージを避けるための日付 (既定7日前。VKT_EXCLUDE_NEWER_DAYS=0 で無効)
# 出力は RFC3339 の日付。GNU / BSD どちらの date でも求める
exclude_newer_cutoff() {
  local days=${VKT_EXCLUDE_NEWER_DAYS:-7}
  [ "$days" -gt 0 ] 2>/dev/null || return 0
  date -u -d "$days days ago" +%Y-%m-%dT00:00:00Z 2>/dev/null \
    || date -u -v-"${days}"d +%Y-%m-%dT00:00:00Z 2>/dev/null \
    || true
}

# whisper.cpp 用の ggml モデルを探す。大きく多言語のモデルを優先し、英語専用 (.en) と VAD 用は避ける。
find_model() {
  if [ -n "${WHISPER_MODEL:-}" ] && [ -f "$WHISPER_MODEL" ]; then
    echo "$WHISPER_MODEL"
    return
  fi
  local d f score
  for d in "$HOME/.cache" "$HOME/.local/share" "$HOME/whisper.cpp/models" "$HOME/models" \
    "/usr/local/share/whisper.cpp" "/opt/homebrew/share" "/usr/share/whisper.cpp"; do
    [ -d "$d" ] || continue
    find "$d" -maxdepth 7 -name 'ggml-*.bin' 2>/dev/null
  done | while IFS= read -r f; do
    case "$f" in *silero* | *vad* | *for-tests*) continue ;; esac
    score=0
    case "$f" in
      *large-v3-turbo*) score=6 ;;
      *large-v3*) score=5 ;;
      *large*) score=4 ;;
      *medium*) score=3 ;;
      *small*) score=2 ;;
      *base*) score=1 ;;
    esac
    case "$f" in *.en.bin | *.en-*.bin) score=$((score - 10)) ;; esac
    echo "$score $f"
  done | sort -rn | head -1 | cut -d' ' -f2-
}

# whisper.cpp の CLI 名 (版によって whisper-cli / whisper-cpp / main)
find_whisper_cli() {
  local c
  for c in whisper-cli whisper-cpp; do
    if command -v "$c" >/dev/null 2>&1; then
      command -v "$c"
      return
    fi
  done
}

# ヘッドレスで動かせる Chrome 系ブラウザ (Chrome / Chromium / Edge)
find_chrome() {
  if [ -n "${CHROME:-}" ] && [ -x "$CHROME" ]; then
    echo "$CHROME"
    return
  fi
  local c
  for c in google-chrome google-chrome-stable chromium chromium-browser chrome microsoft-edge msedge; do
    if command -v "$c" >/dev/null 2>&1; then
      command -v "$c"
      return
    fi
  done
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"; do
    if [ -x "$c" ]; then
      echo "$c"
      return
    fi
  done
}

# 既定のアプリでファイルを開くコマンド
find_opener() {
  local c
  for c in open xdg-open wslview; do
    if command -v "$c" >/dev/null 2>&1; then
      echo "$c"
      return
    fi
  done
  if command -v cmd.exe >/dev/null 2>&1; then echo "cmd.exe /c start"; fi
}

# ファイルのハッシュ (内容が同じフレームの判定用)
find_hasher() {
  if command -v md5sum >/dev/null 2>&1; then
    echo "md5sum"
  elif command -v md5 >/dev/null 2>&1; then
    echo "md5 -r"
  elif command -v shasum >/dev/null 2>&1; then
    echo "shasum"
  fi
}

# ローカルファイルを file:// URL にする (Windows の Git Bash ではパスを変換する)
to_file_url() {
  if command -v cygpath >/dev/null 2>&1; then
    echo "file:///$(cygpath -m "$1")"
  else
    echo "file://$1"
  fi
}
