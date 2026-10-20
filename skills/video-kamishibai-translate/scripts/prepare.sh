#!/usr/bin/env bash
# 動画の指定区間を「書き起こし + 候補フレーム」に分解する下準備スクリプト。
# macOS / Linux / Windows (Git Bash・WSL) で動く。動画は外部に送らず、すべてローカルで処理する。
#
# 使い方: prepare.sh <video> <start_sec> <end_sec> <workdir> [step_sec]
#   start_sec / end_sec は整数の秒。workdir は新しい空ディレクトリを渡す (既存ファイルは消さない)。
#   step_sec は候補フレームの間隔。省略時は区間の長さで自動 (15分まで4秒、1時間まで10秒、それ以上は20秒)。
#
# 環境変数:
#   SUBTITLE_FILE  既存の字幕 (SRT / VTT)。動画内の絶対時刻のもの。指定すると音声の書き起こしを省く
#                  (動画に字幕トラックがあれば: ffmpeg -i <video> -map 0:s:0 subs.srt で取り出せる)
#   ASR            書き起こしの手段: auto (既定) / whisper-cpp / faster-whisper
#   WHISPER_LANG   音声の言語コード (en / ja / zh など)。既定は auto (自動判定)。
#                  英語専用モデル (*.en.bin) のときだけ既定が en になる。SUBTITLE_FILE 使用時は言語を指定する
#   WHISPER_MODEL  whisper.cpp の ggml モデルのパス (未指定なら探す)
#   FW_MODEL       faster-whisper のモデル名 (既定 large-v3-turbo。初回にダウンロードする)
#   WHISPER_PROMPT 固有名詞や専門用語を並べた文字列。聞き間違いを減らす (人名・社名・製品名・略語など)
#
# 出力 (workdir 内):
#   lang.txt            判定した (または指定した) 音声の言語コード。en なら翻訳、ja なら日本語のまま整形、
#                       それ以外は日本語へ翻訳する。判定が怪しければ WHISPER_LANG を指定してやり直す
#   seg.wav / seg.srt   切り出し音声と書き起こし (SRT は切り出し開始が 0 秒。字幕ファイル使用時は作らない)
#   transcript.txt      動画内の絶対時刻付き書き起こし
#   scene_changes.txt   画面が大きく変わった絶対秒
#   cand/t_<秒>.jpg     step 秒ごとの候補フレーム (幅1280、ファイル名は動画内の絶対秒)
#   cand_changes.txt    直前フレームから内容が変わった秒だけの一覧 (重複除去済み)
set -euo pipefail

if [ "$#" -lt 4 ]; then
  sed -n '2,31p' "$0"
  exit 2
fi

video=$1
start=$2
end=$3
work=$4
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
runpy="$here/run_py.sh"
pad=6

case "$start$end" in
  *[!0-9]*) echo "start_sec / end_sec は整数の秒で指定してください (例: 24:36 → 1476)" >&2; exit 2 ;;
esac
[ "$end" -gt "$start" ] || { echo "end_sec は start_sec より大きくしてください" >&2; exit 2; }
[ -f "$video" ] || { echo "動画が見つかりません: $video" >&2; exit 2; }

dur=$((end - start))
if [ -n "${5:-}" ]; then
  step=$5
elif [ "$dur" -gt 3600 ]; then
  step=20
elif [ "$dur" -gt 900 ]; then
  step=10
else
  step=4
fi

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg がありません。check_env.sh で導入方法を確認してください" >&2; exit 1; }

mkdir -p "$work/cand"
ss=$(( start > pad ? start - pad : 0 ))
lang=${WHISPER_LANG:-auto}
detected=$lang

if [ -n "${SUBTITLE_FILE:-}" ]; then
  # ---- 既存の字幕を使う (音声の書き起こしは省く)
  [ -f "$SUBTITLE_FILE" ] || { echo "字幕ファイルが見つかりません: $SUBTITLE_FILE" >&2; exit 2; }
  echo "[1/3] 既存の字幕を使用: $SUBTITLE_FILE"
  "$runpy" "$here/srt_abs.py" "$SUBTITLE_FILE" 0 "$ss" $((end + pad)) >"$work/transcript.txt"
  if [ "$lang" = auto ]; then detected=unknown; fi
  asr=subtitle
else
  # ---- 音声を切り出して書き起こす
  echo "[1/4] 音声切り出し ${ss}s〜$((end + pad))s"
  ffmpeg -hide_banner -loglevel error -y -ss "$ss" -to $((end + pad)) -i "$video" \
    -vn -ac 1 -ar 16000 "$work/seg.wav"

  cli=$(find_whisper_cli)
  model=$(find_model)
  asr=${ASR:-auto}
  if [ "$asr" = auto ]; then
    if [ -n "$cli" ] && [ -n "$model" ]; then
      asr=whisper-cpp
    elif [ -n "$(venv_has_faster_whisper)" ] || command -v uv >/dev/null 2>&1; then
      asr=faster-whisper
    else
      py=$(find_python || true)
      if [ -n "$py" ] && $py -c "import faster_whisper" >/dev/null 2>&1; then asr=faster-whisper; fi
    fi
  fi

  case "$asr" in
    whisper-cpp)
      [ -n "$cli" ] && [ -n "$model" ] || { echo "whisper.cpp または ggml モデルがありません。check_env.sh を実行してください" >&2; exit 1; }
      case "$model" in
        *.en.bin | *.en-*.bin) if [ "$lang" = auto ]; then lang=en; fi ;;
      esac
      echo "[2/4] 書き起こし (whisper.cpp, model: $model, language: $lang)"
      # -mc 0 (文脈なし) と -ml/-sow で、後半のタイムスタンプが粗くなるのを防ぐ
      args=(-m "$model" -l "$lang" -mc 0 -ml 110 -sow -osrt -of "$work/seg" -f "$work/seg.wav")
      if [ -n "${WHISPER_PROMPT:-}" ]; then args+=(--prompt "$WHISPER_PROMPT"); fi
      "$cli" "${args[@]}" >"$work/whisper.log" 2>&1
      ;;
    faster-whisper)
      fw_model=${FW_MODEL:-large-v3-turbo}
      echo "[2/4] 書き起こし (faster-whisper, model: $fw_model, language: $lang) ※初回はモデルをダウンロードします"
      fw_script="$here/transcribe_faster_whisper.py"
      fw_args=("$work/seg.wav" "$work/seg.srt" "$lang" "$fw_model" "${WHISPER_PROMPT:-}")
      vpy=$(venv_has_faster_whisper)
      if [ -n "$vpy" ]; then
        # setup_env.sh で作った専用の仮想環境 (最優先。2回目以降もダウンロード不要)
        "$vpy" -I "$fw_script" "${fw_args[@]}" >"$work/whisper.log" 2>&1
      elif command -v uv >/dev/null 2>&1; then
        # 仮想環境が無ければ uv の一時環境で動かす。--no-project で、カレントのプロジェクトを触らない
        uv_args=(run --no-project --with faster-whisper)
        cutoff=$(exclude_newer_cutoff || true)
        if [ -n "$cutoff" ]; then uv_args+=(--exclude-newer "$cutoff"); fi
        uv "${uv_args[@]}" python -I "$fw_script" "${fw_args[@]}" >"$work/whisper.log" 2>&1
      else
        py=$(find_python || true)
        if [ -n "$py" ] && $py -c "import faster_whisper" >/dev/null 2>&1; then
          $py -I "$fw_script" "${fw_args[@]}" >"$work/whisper.log" 2>&1
        else
          echo "faster-whisper を使える Python がありません。$here/setup_env.sh で専用の仮想環境を作ってください" >&2
          exit 1
        fi
      fi
      ;;
    *)
      echo "書き起こしの手段がありません。check_env.sh を実行して導入方法を確認するか、" >&2
      echo "字幕ファイルを用意して SUBTITLE_FILE=<字幕.srt> で渡してください。" >&2
      exit 1
      ;;
  esac

  if [ "$lang" = auto ]; then
    detected=$(grep -o 'auto-detected language: [a-z]*' "$work/whisper.log" | head -1 | awk '{print $3}' || true)
    detected=${detected:-unknown}
  else
    detected=$lang
  fi
  "$runpy" "$here/srt_abs.py" "$work/seg.srt" "$ss" >"$work/transcript.txt"
fi
echo "$detected" >"$work/lang.txt"

echo "[3/4] 画面切替の検出"
ffmpeg -hide_banner -ss "$start" -to "$end" -i "$video" -an \
  -vf "select='gt(scene,0.03)',showinfo" -f null - 2>&1 \
  | { grep -o 'pts_time:[0-9.]*' || true; } | sed 's/pts_time://' \
  | awk -v s="$start" '{printf "%.1f\n", $1 + s}' >"$work/scene_changes.txt"

# fps フィルタの連番は実時間とずれることがあるため、秒を明示して1枚ずつ正確にシークして切り出す。
# format=yuvj420p は必須: 元動画が1280px幅だと scale が何もせず、色範囲の変換が入らず JPEG 書き出しが失敗する。
echo "[4/4] 候補フレーム抽出 (${step}秒ごと)"
seq "$start" "$step" "$end" | xargs -P 8 -I{} \
  ffmpeg -hide_banner -loglevel error -y -ss {} -i "$video" -frames:v 1 \
    -vf "scale=1280:-1,format=yuvj420p" -q:v 4 "$work/cand/t_{}.jpg"

hasher=$(find_hasher || true)
if [ -n "$hasher" ]; then
  # 直前と同一のフレームは捨て、内容が変わった秒だけを並べる
  $hasher "$work"/cand/t_*.jpg | awk '{split($2, a, "_"); sub(".jpg", "", a[2]); print $1, a[2]}' \
    | sort -k2 -n | awk '$1 != prev {print $2; prev = $1}' >"$work/cand_changes.txt"
else
  ls "$work/cand" | sed 's/^t_//; s/\.jpg$//' | sort -n >"$work/cand_changes.txt"
fi

total=$(ls "$work/cand" | wc -l | tr -d ' ')
changed=$(wc -l <"$work/cand_changes.txt" | tr -d ' ')
echo "完了: $work"
echo "  書き起こし   : $asr / 音声の言語: $detected ($work/lang.txt)"
echo "  transcript   : $work/transcript.txt ($(wc -l <"$work/transcript.txt" | tr -d ' ')行)"
echo "  画面切替     : $work/scene_changes.txt ($(wc -l <"$work/scene_changes.txt" | tr -d ' ')件)"
echo "  候補フレーム : $work/cand (${total}枚、内容が変わるのは ${changed}枚)"
if [ "$total" -gt 4 ] && [ "$changed" -ge $((total * 9 / 10)) ]; then
  echo "  注意: ほぼ毎フレーム内容が変わる映像です (カメラ映像・動画の発表者映像など)。cand_changes は目安になりません。"
  echo "        scene_changes と transcript の話題の切れ目からフレームを選んでください。"
fi
if [ "$detected" = unknown ]; then
  echo "  注意: 言語を判定できませんでした。ユーザーに確認するか、WHISPER_LANG を指定してやり直してください。"
fi
