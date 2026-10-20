"""faster-whisper で音声を書き起こし、SRT を書き出す (whisper.cpp が無い環境用の代替)。

使い方: uv run --with faster-whisper python -I transcribe_faster_whisper.py <audio> <out.srt> [lang|auto] [model] [initial_prompt]
  lang    言語コード (en / ja / zh ...)。auto なら自動判定
  model   faster-whisper のモデル名 (既定 large-v3-turbo)。初回はモデルをダウンロードする (ネットワークが必要)
標準出力に "auto-detected language: <コード>" を出す (prepare.sh が言語の判定結果として読む)。
"""
import sys
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


def load_wav(path: str) -> "np.ndarray":
    # faster-whisper 内蔵のデコード (PyAV) は版の組み合わせで壊れることがあるため、
    # prepare.sh が作る 16kHz モノラル 16bit の WAV を自前で読んで配列として渡す
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("入力は 16kHz・モノラル・16bit の WAV にしてください (prepare.sh が作るもの)")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def fmt(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


audio, out = sys.argv[1], Path(sys.argv[2])
lang = sys.argv[3] if len(sys.argv) > 3 else "auto"
model_name = sys.argv[4] if len(sys.argv) > 4 else "large-v3-turbo"
prompt = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

model = WhisperModel(model_name, device="auto", compute_type="auto")
# condition_on_previous_text=False は whisper.cpp の -mc 0 と同じ (後半のタイムスタンプが粗くなるのを防ぐ)
segments, info = model.transcribe(
    load_wav(audio),
    language=None if lang == "auto" else lang,
    beam_size=5,
    condition_on_previous_text=False,
    initial_prompt=prompt,
)
print(f"auto-detected language: {info.language}")

lines = []
for i, seg in enumerate(segments, 1):
    text = seg.text.strip()
    if text:
        lines.append(f"{i}\n{fmt(seg.start)} --> {fmt(seg.end)}\n{text}\n")
out.write_text("\n".join(lines), encoding="utf-8")
