# /// script
# requires-python = ">=3.10"
# dependencies = ["openpyxl"]
# ///
"""sheet.json から xlsx を作る。

使い方: uv run to_xlsx.py <in.sheet.json> <out.xlsx>
"""
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ADDR = re.compile(r"^([A-Z]+)(\d+)$")


def rgb(c: str) -> str:
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return c.upper()


def main(src: str, dst: str) -> None:
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
    wb.save(dst)
    print(f"wrote {dst} ({len(data['sheets'])} sheets)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: uv run to_xlsx.py <in.sheet.json> <out.xlsx>")
    main(sys.argv[1], sys.argv[2])
