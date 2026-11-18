# /// script
# requires-python = ">=3.10"
# dependencies = ["openpyxl"]
# ///
"""sheet.json から xlsx を作る。

使い方: uv run to_xlsx.py <in.sheet.json> <out.xlsx> [--comments] [--review <review.json>]

--comments: 隣の <name>.review.json のスレッドを、範囲の左上セルのコメントとして書く（既定は書かない）。
"""
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ADDR = re.compile(r"^([A-Z]+)(\d+)$")


def rgb(c: str) -> str:
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return c.upper()


def load_threads(src: str, review: str | None) -> list[dict]:
    path = review or re.sub(r"\.sheet\.json$", "", src) + ".review.json"
    try:
        r = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if isinstance(r.get("threads"), list):
        return r["threads"]
    out = []  # 旧形式 items(instruction / agent_reply) を読み替える
    for i, it in enumerate(r.get("items") or []):
        msgs = []
        if it.get("instruction"):
            msgs.append({"author": "human", "text": it["instruction"]})
        if it.get("agent_reply"):
            msgs.append({"author": "agent", "text": it["agent_reply"]})
        out.append({"id": str(it.get("id", i + 1)), "range": it.get("range", ""), "kind": "指示",
                    "status": it.get("status", "未対応"), "messages": msgs})
    return out


def add_comments(wb: Workbook, threads: list[dict]) -> int:
    n = 0
    for t in threads:
        sheet, _, rng = (t.get("range") or "").rpartition("!")
        first = rng.split(":")[0]
        if not ADDR.match(first):
            continue  # 行・列・シート全体などは対象外
        ws = wb[sheet[:31]] if sheet and sheet[:31] in wb.sheetnames else wb.worksheets[0]
        who = {"human": "人", "agent": "AI"}
        body = "\n".join(f"{who.get(m.get('author'), m.get('author'))}: {m.get('text', '')}" for m in t.get("messages", []))
        text = f"[{t.get('kind', '')}/{t.get('status', '')}]\n{body}"
        old = ws[first].comment
        if old:
            text = old.text + "\n---\n" + text
        c = Comment(text, "sheet-preview")
        c.width, c.height = 320, 40 + 18 * text.count("\n")
        ws[first].comment = c
        n += 1
    return n


def main(src: str, dst: str, comments: bool = False, review: str | None = None) -> None:
    data = json.load(open(src, encoding="utf-8"))
    wb = Workbook()
    wb.remove(wb.active)
    for sh in data["sheets"]:
        ws = wb.create_sheet(sh["name"][:31])
        for col, px in (sh.get("colWidths") or {}).items():
            ws.column_dimensions[col].width = round(px / 7, 1)  # px -> 文字数の近似
        for row, px in (sh.get("rowHeights") or {}).items():
            ws.row_dimensions[int(row)].height = px * 0.75  # px -> pt
        for addr, c in (sh.get("cells") or {}).items():
            cell = ws[addr]
            v = c.get("v")
            if v not in (None, ""):
                cell.value = v
            font = {}
            if c.get("bold"):
                font["bold"] = True
            if c.get("color"):
                font["color"] = rgb(c["color"])
            if c.get("size"):
                font["size"] = c["size"]
            if font:
                cell.font = Font(**font)
            if c.get("bg"):
                cell.fill = PatternFill("solid", fgColor=rgb(c["bg"]))
            cell.alignment = Alignment(
                horizontal=c.get("align"),
                vertical={"middle": "center"}.get(c.get("valign", "middle"), c.get("valign")),
                wrap_text=bool(c.get("wrap")),
            )
            if c.get("numFmt"):
                cell.number_format = c["numFmt"]
        for m in sh.get("merges") or []:
            a, _, b = m.partition(":")
            if b and a != b:
                ws.merge_cells(m)
        if sh.get("freeze"):
            ws.freeze_panes = sh["freeze"]
    nc = add_comments(wb, load_threads(src, review)) if comments else 0
    wb.save(dst)
    print(f"wrote {dst} ({len(data['sheets'])} sheets" + (f", {nc} comments)" if comments else ")"))


if __name__ == "__main__":
    a = sys.argv[1:]
    comments = "--comments" in a
    review = None
    if "--review" in a:
        i = a.index("--review")
        review = a[i + 1] if i + 1 < len(a) else sys.exit("--review にはパスが要る")
        del a[i : i + 2]
    a = [x for x in a if x != "--comments"]
    if len(a) != 2:
        sys.exit("usage: uv run to_xlsx.py <in.sheet.json> <out.xlsx> [--comments] [--review <review.json>]")
    main(a[0], a[1], comments, review)
