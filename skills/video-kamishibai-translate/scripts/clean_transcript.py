"""書き起こしから、無音区間に出る定型の幻覚行 (「ご視聴ありがとうございました」「Thank you.」など) を除く。

使い方: python -I clean_transcript.py <transcript.txt> <silence.log> <offset_sec> <removed.txt>
  transcript.txt  srt_abs.py の出力 (動画内の絶対時刻 m:ss.ss / h:mm:ss.ss 付きの行)。除いた結果で上書きする
  silence.log     ffmpeg の silencedetect の出力 (silence_start / silence_end)。時刻は seg.wav の先頭が 0 秒
  offset_sec      seg.wav の先頭が動画の何秒にあたるか (prepare.sh の ss)。無音区間を絶対時刻にそろえる
  removed.txt     除いた行の保存先 (確認用)

除く条件は、行全体が定型フレーズに一致し、かつ開始時刻が無音区間の中にあること。
  - 幻覚に特有のフレーズ (「ご視聴ありがとうございました」「チャンネル登録」など): 無音区間なら除く
  - 一般的な語 (「ありがとうございました」「Thank you.」など。実際にも発言される): 長い無音 (LONG_SILENCE 秒以上) の中だけ除く
    (短い無音に入っただけの実際の挨拶を消さないため)
無音区間の外にある同じ言葉は残す。除いた行は removed.txt に残るので確認できる。
標準ライブラリのみ。
"""
import re
import sys
from pathlib import Path

# 音声認識モデルが、無音や BGM に対して出しやすい定型句 (行全体が一致したときだけ対象)
# 幻覚に特有: 実際の会話には出にくいので、無音区間にあれば除く
SPECIFIC = re.compile(r"(?:" + "|".join([
    r"ご視聴(いただき)?(ありがとうございました|ありがとうございます)。?",
    r"チャンネル登録.*",
    r"字幕[:：].*",
    r"thanks for watching\.?",
    r"thank you for watching\.?",
    r"please subscribe\.?",
]) + r")", re.IGNORECASE)
# 一般的な語: 実際にも発言されるので、長い無音の中にあるときだけ除く
GENERIC = re.compile(r"(?:" + "|".join([
    r"ありがとうございました。?",
    r"おやすみなさい。?",
    r"thank you\.?",
    r"thanks\.?",
    r"bye\.?",
    r"you",
]) + r")", re.IGNORECASE)
LONG_SILENCE = 10.0  # 一般的な語を除くのに必要な無音の長さ (秒)
TOLERANCE = 0.5  # 無音区間の境界の誤差 (秒)


def to_sec(token: str) -> float:
    sec = 0.0
    for part in token.split(":"):
        sec = sec * 60 + float(part)
    return sec


def read_silences(path: Path, offset: float) -> "list[tuple[float, float]]":
    spans = []
    start = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.search(r"silence_start:\s*(-?[\d.]+)", line)
        if m:
            start = float(m.group(1)) + offset
            continue
        m = re.search(r"silence_end:\s*([\d.]+)", line)
        if m and start is not None:
            spans.append((start, float(m.group(1)) + offset))
            start = None
    if start is not None:
        spans.append((start, float("inf")))  # 末尾まで無音
    return spans


def main() -> None:
    transcript, silence_log, offset, removed_path = Path(sys.argv[1]), Path(sys.argv[2]), float(sys.argv[3]), Path(sys.argv[4])
    spans = read_silences(silence_log, offset) if silence_log.exists() else []
    kept, removed = [], []
    for line in transcript.read_text(encoding="utf-8").splitlines():
        token, _, body = line.partition(" ")
        text = body.strip().lstrip("-").strip()
        try:
            t = to_sec(token)
        except ValueError:
            kept.append(line)
            continue
        near = [(lo, hi) for lo, hi in spans if lo - TOLERANCE <= t <= hi + TOLERANCE]
        long_silence = any(hi - lo >= LONG_SILENCE for lo, hi in near)
        if (near and SPECIFIC.fullmatch(text)) or (long_silence and GENERIC.fullmatch(text)):
            removed.append(line)
        else:
            kept.append(line)
    transcript.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    removed_path.write_text("\n".join(removed) + ("\n" if removed else ""), encoding="utf-8")
    print(f"  幻覚と判断して除いた行: {len(removed)} 行 (確認用: {removed_path})")


main()
