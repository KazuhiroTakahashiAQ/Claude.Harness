#!/usr/bin/env bash
# このスキルに必要なツールが揃っているか確認し、足りないものの導入方法を OS ごとに表示する。
# 情報表示のみ (何も導入せず、常に exit 0)。導入はユーザーの承認を取ってから行うこと。
#
# 使い方: check_env.sh
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

os=$(detect_os)
missing_required=0

ok() { printf '  [OK]   %s\n         %s\n' "$1" "$2"; }
ng() { printf '  [不足] %s\n         %s\n' "$1" "$2"; }
opt() { printf '  [任意] %s\n         %s\n' "$1" "$2"; }

hint() { # ツール名 -> OS別の導入方法
  case "$1:$os" in
    ffmpeg:darwin) echo "brew install ffmpeg" ;;
    ffmpeg:linux) echo "sudo apt install ffmpeg  (Fedora: sudo dnf install ffmpeg)" ;;
    ffmpeg:windows) echo "winget install Gyan.FFmpeg  (または choco install ffmpeg)。導入後にシェルを開き直す" ;;
    whisper:darwin) echo "brew install whisper-cpp  (ggml モデルは下記)" ;;
    whisper:linux) echo "whisper.cpp をビルド (https://github.com/ggml-org/whisper.cpp)、または faster-whisper (uv が必要)" ;;
    whisper:windows) echo "whisper.cpp のリリースを導入、または faster-whisper (uv が必要)" ;;
    python:darwin) echo "uv を導入する (brew install uv、または curl -LsSf https://astral.sh/uv/install.sh | sh)。python3 (3.8 以上) でもよい" ;;
    python:linux) echo "uv を導入する (curl -LsSf https://astral.sh/uv/install.sh | sh)。python3 (3.8 以上) でもよい" ;;
    python:windows) echo "uv を導入する (winget install astral-sh.uv)。python (3.8 以上) でもよい" ;;
    python:*) echo "uv (https://docs.astral.sh/uv/) か python3 (3.8 以上) を導入する" ;;
    chrome:*) echo "Google Chrome / Chromium / Edge のいずれか (HTML の自動検証用。無くても紙芝居は作れる)" ;;
    *) echo "" ;;
  esac
}

echo "環境: $os"
echo
echo "== 必須 =="
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  ok "ffmpeg / ffprobe" "$(ffmpeg -version 2>/dev/null | head -1 | cut -c1-60)"
else
  ng "ffmpeg / ffprobe" "$(hint ffmpeg)"
  missing_required=1
fi

py=$(find_python)
if [ -n "$py" ]; then
  # shellcheck disable=SC2086
  pyver=$($py -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || echo "不明 (uv が初回に Python を取得します)")
  ok "Python (同梱スクリプト用。仮想環境は不要)" "$py  [Python $pyver]"
else
  ng "Python" "$(hint python)"
  missing_required=1
fi

echo
echo "== 書き起こし (どれか1つ。外部の字幕ファイルを使うなら不要) =="
cli=$(find_whisper_cli)
model=$(find_model)
asr_ok=0
if [ -n "$cli" ] && [ -n "$model" ]; then
  ok "whisper.cpp" "$cli / モデル: $model"
  asr_ok=1
elif [ -n "$cli" ]; then
  ng "whisper.cpp のモデル" "$cli はあるが ggml モデルが見つからない。WHISPER_MODEL にパスを指定するか、下記を参照"
else
  ng "whisper.cpp" "$(hint whisper)"
fi
vfw=$(venv_has_faster_whisper)
if [ -n "$vfw" ]; then
  ok "faster-whisper (専用の仮想環境)" "$(venv_dir)"
  asr_ok=1
elif command -v uv >/dev/null 2>&1; then
  ok "faster-whisper (uv の一時環境)" "使える (初回にパッケージとモデルをダウンロード)。繰り返し使うなら setup_env.sh で専用の仮想環境を作ると安定"
  asr_ok=1
elif [ -n "$py" ] && $py -c "import faster_whisper" >/dev/null 2>&1; then
  ok "faster-whisper (導入済みの Python)" "$py"
  asr_ok=1
else
  opt "faster-whisper" "未導入。uv を導入して $here/setup_env.sh を実行すると、専用の仮想環境を作れる (承認を取ってから)"
fi
if [ "$asr_ok" -eq 0 ]; then
  missing_required=1
  echo "      -> 書き起こしの手段がありません。上のどれかを導入するか、字幕ファイル (SRT) を用意して SUBTITLE_FILE で渡してください。"
fi
if [ -n "$cli" ] && [ -z "$model" ]; then
  echo "      ggml モデルの取得例 (約870MB、ネットワークとディスクを使うのでユーザーの承認を取る):"
  echo "        mkdir -p ~/.cache/whisper.cpp && curl -L -o ~/.cache/whisper.cpp/ggml-large-v3-turbo-q8_0.bin \\"
  echo "          https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin"
fi

echo
echo "== 任意 =="
chrome=$(find_chrome)
if [ -n "$chrome" ]; then ok "Chrome 系ブラウザ" "$chrome"; else opt "Chrome 系ブラウザ" "$(hint chrome)"; fi
opener=$(find_opener)
if [ -n "$opener" ]; then ok "ファイルを開くコマンド" "$opener"; else opt "ファイルを開くコマンド" "無い場合は出力HTMLのパスをユーザーに伝える"; fi
hasher=$(find_hasher)
if [ -n "$hasher" ]; then ok "ハッシュコマンド" "$hasher"; else opt "ハッシュコマンド" "md5sum / md5 / shasum が無いと候補フレームの重複除去ができない"; fi

echo
if [ "$missing_required" -eq 0 ]; then
  echo "必須のツールは揃っています。"
else
  echo "不足があります。導入が必要なものは、ユーザーの承認を取ってから導入してください。"
fi
exit 0
