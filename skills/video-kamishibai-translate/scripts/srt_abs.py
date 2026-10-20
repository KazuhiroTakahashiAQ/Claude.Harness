"""字幕ファイル (SRT / VTT) を、動画内の絶対時刻 (m:ss.ss) 付きの行にして標準出力へ出す。

使い方: python -I srt_abs.py <字幕ファイル> <offset_sec> [min_abs_sec max_abs_sec]
  offset_sec   字幕の 0 秒が動画の何秒にあたるか (prepare.sh が音声を切り出した開始秒。外部の字幕なら 0)
  min/max      指定すると、その範囲 (絶対秒) に開始時刻がある行だけを出す
"""
import re
import sys
from pathlib import Path

TS = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def to_sec(m: "re.Match[str]") -> float:
    h, mi, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def main() -> None:
    path, offset = Path(sys.argv[1]), float(sys.argv[2])
    lo = float(sys.argv[3]) if len(sys.argv) > 4 else None
    hi = float(sys.argv[4]) if len(sys.argv) > 4 else None
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        idx = next((i for i, ln in enumerate(lines) if "-->" in ln), None)
        if idx is None:
            continue  # WEBVTT ヘッダーや NOTE など
        m = TS.search(lines[idx].split("-->")[0])
        if not m:
            continue
        start = to_sec(m) + offset
        if lo is not None and not (lo <= start <= hi):
            continue
        body = re.sub(r"<[^>]+>", "", " ".join(lines[idx + 1:])).strip()  # VTT の装飾タグを除く
        if body:
            print(f"{int(start // 60)}:{start % 60:05.2f} {body}")


main()
