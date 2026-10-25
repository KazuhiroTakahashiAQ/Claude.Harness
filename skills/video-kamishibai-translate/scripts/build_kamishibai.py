"""scenes.py とフレーム画像から、単一HTMLの紙芝居を生成する。

使い方: run_py.sh build_kamishibai.py <scenes.pyのあるディレクトリ> <frames_dir> <out.html>
  (run_py.sh は uv / python3 のどちらでも動かす。直接 `python3 -I build_kamishibai.py ...` でもよい)

scenes.py に必要な名前 (references/scenes_template.py を参照):
  CARDS / SECTIONS / NOTES / SUMMARY (最初のページの1分サマリー。必須)
  任意: GLOSSARY (用語の？ポップアップ。省略・空なら「？」も用語集も出ない)、TITLE、SUBTITLE、
        SRC_LANG (動画の言語。既定 "en"。"ja" なら翻訳ではなく日本語の紙芝居として扱い、原文欄 (en) は出さない)、
        GROUP_MAX (1ページにまとめる発言数の上限。既定 8。1 ならまとめない)
カードの t0 / t1 は秒の数値のほか、"84:01" "1:24:01.5" のような文字列でも書ける。
カードの任意項目: speaker (話者)、frame=None (画像なしのカード)、en / ocr / hl / note
同じ画面 (frame) と同じ話題 (sec) で連続するカードは、1ページにまとめて表示する (画像は固定、発言を縦に並べる)。
SUMMARY の任意項目: blocks (決定事項・ToDo など、見出し付きの箇条書きを追加する)
frames_dir には f_<秒>.jpg を置く (CARDS の frame がその <秒>)。
標準ライブラリのみ。画像はbase64で1回だけ埋め込み、複数カードで共有する。
最初のページは1分サマリー。用語の「？」は GLOSSARY があれば常に表示される (オン/オフのスイッチはない)。
日本語の文章は、句点 (。) ごとに改行して表示する。
"""
import base64
import html as htmllib
import json
import re
import sys
from pathlib import Path

src_dir, frames_dir, out_path = (Path(a) for a in sys.argv[1:4])
sys.path.insert(0, str(src_dir))
import scenes  # noqa: E402

def parse_time(v):
    """秒の数値、または "m:ss" / "h:mm:ss" (小数可) の文字列を秒にする"""
    if isinstance(v, (int, float)):
        return float(v)
    sec = 0.0
    for part in str(v).strip().split(":"):
        sec = sec * 60 + float(part)
    return sec


GLOSSARY = getattr(scenes, "GLOSSARY", [])
GROUP_MAX = max(1, int(getattr(scenes, "GROUP_MAX", 8)))
SRC_LANG = getattr(scenes, "SRC_LANG", "en")
TITLE = getattr(scenes, "TITLE", "動画 紙芝居")
SUBTITLE = getattr(
    scenes, "SUBTITLE",
    ("動画の該当区間を、キャプチャ付きの紙芝居にまとめました。" if SRC_LANG == "ja"
     else "動画の該当区間を、キャプチャ付きで日本語に翻訳しました。")
    + "最初のページに1分サマリーがあります。"
    "← → キーまたはボタンで進み、画像クリックで拡大できます。"
    + ("用語の横の「？」を押すと、初心者向けに意味が表示されます。" if GLOSSARY else ""),
)

# 任意項目の既定値をそろえる (frame=None は画像なしのカード)
CARDS = []
for raw in scenes.CARDS:
    c = dict(speaker=None, en="", ocr=[], hl=None, note=None)
    c.update(raw)
    c["t0"], c["t1"] = parse_time(c["t0"]), parse_time(c["t1"])
    c["frame"] = None if c.get("frame") is None else str(c["frame"])
    c["ocr"] = [list(o) for o in c["ocr"]]
    CARDS.append(c)
SUMMARY = {"blocks": [], **scenes.SUMMARY}

images = {}
for c in CARDS:
    key = c["frame"]
    if key is not None and key not in images:
        path = frames_dir / f"f_{key}.jpg"
        if not path.exists():
            sys.exit(f"フレームがありません: {path} (CARDS の frame と frames_dir のファイル名を揃えてください)")
        images[key] = "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")

payload = {
    "sections": scenes.SECTIONS,
    "cards": CARDS,
    "notes": scenes.NOTES,
    "summary": SUMMARY,
    "glossary": GLOSSARY,
    "srcLang": SRC_LANG,
    "groupMax": GROUP_MAX,
    "ocrLabel": "画面内の外国語テキストの訳" if SRC_LANG == "ja" else "画面内テキストの訳",
}


def sentences_br(escaped):
    # 句点 (。) の直後に改行を入れる。文末の句点には入れない
    return re.sub(r"。(?=\S)", "。<br>", escaped)


def js(obj):
    # </script> で途切れないようにエスケープする
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


# 用語集の点検: 本文 (訳・画面内テキストの訳・サマリー) に一度も出てこない用語を知らせる
block_items = [it for b in SUMMARY["blocks"] for it in b["items"]]
corpus = SUMMARY["lead"] + "".join(p.get("t", "") for p in SUMMARY["points"]) + "".join(block_items)
for c in CARDS:
    corpus += c["ja"] + "".join(o[1] for o in c["ocr"])
unused = [g["term"] for g in GLOSSARY if not any(m in corpus for m in g["match"])]
# サマリーの文字数: lead + points の本文と、blocks (決定事項・ToDo など) を別に数える
summary_chars = len(SUMMARY["lead"]) + sum(len(p.get("h", "")) + len(p.get("t", "")) for p in SUMMARY["points"])
blocks_chars = sum(len(b["label"]) for b in SUMMARY["blocks"]) + sum(len(it) for it in block_items)


n_pages = 0
_prev = None
_run = 0
for c in CARDS:
    if _prev is not None and _prev["sec"] == c["sec"] and _prev["frame"] == c["frame"] and _run < GROUP_MAX:
        _run += 1
    else:
        n_pages += 1
        _run = 1
    _prev = c

html = r"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root {
  --bg: #f4f5f7; --panel: #ffffff; --text: #1d2330; --muted: #5d6677; --border: #d9dde5;
  --accent: #1f6feb; --accent-soft: #e5efff; --hl: #e8890c; --ocr-bg: #f1f3f7; --shadow: 0 2px 14px rgba(20,30,50,.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12151b; --panel: #1b2029; --text: #e7eaf0; --muted: #9aa4b5; --border: #2c3341;
    --accent: #6ea8ff; --accent-soft: #1f2d47; --hl: #ffb23f; --ocr-bg: #151a22; --shadow: 0 2px 18px rgba(0,0,0,.4);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { color-scheme: light dark; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.7 "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif;
}
.wrap { max-width: 1480px; margin: 0 auto; padding: 0 16px 40px; }
header { padding: 20px 0 12px; display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: flex-start; justify-content: space-between; }
header h1 { margin: 0; font-size: clamp(15px, 1.6vw, 19px); line-height: 1.35; }
header p { margin: 4px 0 0; color: var(--muted); font-size: 12px; max-width: 70ch; }
.q {
  display: inline-flex; align-items: center; justify-content: center; width: 1.2em; height: 1.2em; border-radius: 50%;
  border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent);
  font: 700 .72em/1 system-ui, sans-serif; font-style: normal;
}
.q { margin-left: .2em; padding: 0; cursor: help; vertical-align: .12em; }
.q:hover, .q[aria-expanded="true"] { background: var(--accent); color: var(--panel); }
.q:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.term { border-bottom: 1px dotted var(--accent); white-space: nowrap; }
.bar { display: flex; align-items: center; gap: 12px; margin: 8px 0 14px; }
.bar .count { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; min-width: 64px; text-align: right; }
.track { flex: 1; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.track > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
button.nav {
  appearance: none; border: 1px solid var(--border); background: var(--panel); color: var(--text);
  border-radius: 10px; padding: 5px 12px; font: inherit; font-size: 12.5px; cursor: pointer; min-height: 32px;
}
button.nav:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button.nav:disabled { opacity: .4; cursor: default; }
button.nav.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; padding: 7px 18px; }
button.nav.primary:hover:not(:disabled) { color: #fff; filter: brightness(1.1); }
button.nav:focus-visible, .thumb:focus-visible, .pic:focus-visible, .flow:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.summary { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 22px clamp(16px, 3vw, 34px) 26px; max-width: 920px; margin: 0 auto; }
.summary h2 { margin: 8px 0 8px; font-size: clamp(16px, 1.6vw, 19px); line-height: 1.4; }
.summary .lead { color: var(--muted); margin: 0 0 16px; font-size: 12.5px; }
.summary ol { list-style: none; counter-reset: p; padding: 0; margin: 0 0 22px; display: grid; gap: 12px; }
.summary ol > li { counter-increment: p; display: grid; grid-template-columns: 2em 1fr; column-gap: 12px; align-items: start; background: var(--ocr-bg); border-radius: 10px; padding: 12px 14px; }
.summary ol > li::before { content: counter(p); grid-row: 1 / span 2; width: 2em; height: 2em; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; }
.summary ol > li > b, .summary ol > li > span { grid-column: 2; }
.summary ol > li > b { font-size: 13.5px; line-height: 1.5; }
.summary ol > li > span { font-size: 13px; }
.summary h3 { font-size: 12px; margin: 4px 0 10px; color: var(--muted); font-weight: 600; }
.flowrow { display: grid; gap: 8px; margin-bottom: 22px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.flow { text-align: left; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 10px; padding: 10px 14px; cursor: pointer; font: inherit; display: grid; gap: 2px; }
.flow:hover { border-color: var(--accent); }
.flow .ft { color: var(--accent); font-variant-numeric: tabular-nums; font-size: 11px; }
.flow .fn { font-weight: 600; font-size: 12.5px; line-height: 1.5; }
.flow .fc { color: var(--muted); font-size: 10.5px; }
.stage { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(320px, 1fr); gap: 18px; align-items: start; }
.pic {
  position: relative; background: #000; border-radius: 12px; overflow: hidden; border: 1px solid var(--border);
  box-shadow: var(--shadow); cursor: zoom-in; padding: 0; display: block; width: 100%;
}
.pic img { display: block; width: 100%; height: auto; }
.hl {
  position: absolute; border: 3px dashed var(--hl); border-radius: 8px; pointer-events: none;
  box-shadow: 0 0 0 9999px rgba(0,0,0,.28);
}
.hint { position: absolute; right: 10px; bottom: 10px; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; padding: 2px 9px; border-radius: 999px; }
.text { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; box-shadow: var(--shadow); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.chip { font-size: 10.5px; padding: 2px 10px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-variant-numeric: tabular-nums; }
.chip.sec { background: var(--ocr-bg); color: var(--muted); }
.ja { margin: 0 0 12px; font-size: clamp(14px, 1.2vw, 16px); line-height: 1.85; font-weight: 500; }
.en { margin: 0 0 14px; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); font-size: 12px; line-height: 1.6; }
.note { margin: 0 0 12px; font-size: 11.5px; color: var(--muted); background: var(--ocr-bg); border-radius: 8px; padding: 8px 12px; }
details.ocr { border-top: 1px solid var(--border); padding-top: 10px; }
details.ocr summary { cursor: pointer; font-size: 12px; font-weight: 600; margin-bottom: 8px; }
.ocr .same { margin: 0; font-size: 11.5px; color: var(--muted); }
.ocr ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.ocr li { background: var(--ocr-bg); border-radius: 8px; padding: 8px 12px; }
.ocr .oen { display: block; font-size: 10.5px; color: var(--muted); line-height: 1.5; word-break: break-word; }
.ocr .oja { display: block; font-size: 12px; line-height: 1.65; margin-top: 2px; }
.strip { position: relative; display: flex; gap: 8px; overflow-x: auto; padding: 14px 2px 8px; scroll-snap-type: x proximity; }
.thumb { flex: 0 0 auto; width: 132px; border: 2px solid transparent; border-radius: 8px; background: none; padding: 0; cursor: pointer; scroll-snap-align: center; position: relative; opacity: .7; color: inherit; font: inherit; }
.thumb img { display: block; width: 100%; aspect-ratio: 16/10; object-fit: cover; border-radius: 6px; background: #000; }
.thumb b { position: absolute; left: 4px; top: 4px; font-size: 11px; background: rgba(0,0,0,.65); color: #fff; padding: 0 6px; border-radius: 999px; font-weight: 500; font-size: 10px; }
.sumthumb span { display: flex; align-items: center; justify-content: center; text-align: center; width: 100%; aspect-ratio: 16/10; border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-weight: 600; font-size: 11px; line-height: 1.4; }
.thumb[aria-current="true"] { border-color: var(--accent); opacity: 1; }
.thumb:hover { opacity: 1; }
footer { margin-top: 22px; display: grid; gap: 10px; }
footer details { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; }
footer summary { cursor: pointer; font-weight: 600; font-size: 12.5px; }
footer ul { margin: 10px 0 0; padding-left: 20px; color: var(--muted); font-size: 12px; }
footer dl { margin: 10px 0 0; display: grid; gap: 8px 16px; grid-template-columns: max-content 1fr; font-size: 12px; }
footer dt { font-weight: 600; }
footer dd { margin: 0; color: var(--muted); }
.pop { position: fixed; z-index: 20; background: var(--panel); color: var(--text); border: 1px solid var(--accent); border-radius: 12px; padding: 12px 14px 10px; box-shadow: 0 8px 30px rgba(0,0,0,.35); font-size: 12px; line-height: 1.65; }
.pop b { display: block; font-size: 13px; margin-bottom: 2px; padding-right: 22px; }
.pop p { margin: 0 0 6px; }
.pop small { color: var(--muted); font-size: 10.5px; }
.pop .px { position: absolute; right: 6px; top: 4px; border: 0; background: none; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 4px 8px; }
.lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.92); display: none; align-items: center; justify-content: center; z-index: 10; cursor: zoom-out; padding: 12px; }
.lightbox.on { display: flex; }
.lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; }
.stage.noimg { grid-template-columns: minmax(0, 780px); justify-content: center; }
.utt { padding: 2px 0 6px; }
.utt.multi { border-left: 3px solid var(--border); padding: 4px 0 2px 12px; margin: 0 0 12px; cursor: pointer; }
.utt.multi.on { border-left-color: var(--accent); }
.utt .ja { margin-bottom: 6px; }
.uhead { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 2px; }
.ut { font-size: 10.5px; color: var(--accent); font-variant-numeric: tabular-nums; }
@media (min-width: 961px) { .pic { position: sticky; top: 8px; } }
.chip.spk { background: transparent; border: 1px solid var(--accent); }
.blocks { display: grid; gap: 10px; margin: 0 0 22px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.blocks section { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
.blocks h3 { margin: 0 0 6px; }
.blocks ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7; }
@media (max-width: 960px) {
  .stage { grid-template-columns: 1fr; }
  .thumb { width: 104px; }
  footer dl { grid-template-columns: 1fr; gap: 2px; }
  footer dd { margin-bottom: 8px; }
}
@media (max-width: 520px) {
  .bar { flex-wrap: wrap; }
  .bar .track { order: 3; flex-basis: 100%; }
  .bar .count { order: 1; flex: 1; text-align: center; }
  #next { order: 2; }
  button.nav { padding: 8px 14px; }
}
@media (prefers-reduced-motion: reduce) { .track > i { transition: none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>__TITLE__</h1>
      <p>__SUBTITLE__</p>
    </div>
  </header>

  <div class="bar" role="group" aria-label="ページ送り">
    <button class="nav" id="prev" type="button">← 前へ</button>
    <div class="track" aria-hidden="true"><i id="prog"></i></div>
    <span class="count" id="count" aria-live="polite"></span>
    <button class="nav" id="next" type="button">次へ →</button>
  </div>

  <section class="summary" id="summary" hidden></section>

  <main class="stage" id="stage" hidden>
    <button class="pic" id="pic" type="button" aria-label="画像を拡大する">
      <img id="img" alt="">
      <span class="hl" id="hl" hidden></span>
      <span class="hint">クリックで拡大</span>
    </button>
    <article class="text" id="text"></article>
  </main>

  <div class="strip" id="strip" role="list" aria-label="ページ一覧"></div>

  <footer>
    <details id="glossbox">
      <summary>用語集 (初心者向けの補足)</summary>
      <dl id="gloss"></dl>
    </details>
    <details>
      <summary>制作メモ (翻訳・補正)</summary>
      <ul id="notes"></ul>
    </details>
  </footer>
</div>
<div class="pop" id="pop" role="dialog" aria-label="用語の意味" hidden>
  <button class="px" id="px" type="button" aria-label="閉じる">×</button>
  <b id="pt"></b>
  <p id="pd"></p>
  <small>初心者向けの補足です (動画の発言ではありません)</small>
</div>
<div class="lightbox" id="lb" role="dialog" aria-label="拡大表示"><img id="lbimg" alt=""></div>

<script>
const IMG = __IMG__;
const DATA = __DATA__;
const $ = (id) => document.getElementById(id);
const cards = DATA.cards, GL = DATA.glossary;
// 同じ画面 (frame) と同じ話題 (sec) で連続するカードを、1ページにまとめる (上限 DATA.groupMax 発言)
const pages = [];
cards.forEach((c) => {
  const p = pages[pages.length - 1];
  if (p && p.sec === c.sec && p.frame === c.frame && p.items.length < DATA.groupMax) { p.items.push(c); p.t1 = c.t1; }
  else pages.push({ sec: c.sec, frame: c.frame, t0: c.t0, t1: c.t1, items: [c] });
});
const N = pages.length;
let act = 0;                        // ページ内で、強調枠を表示している発言の添字
let cur = -1;                       // -1 は最初のページ (1分サマリー)

const mmss = (s) => {               // 1時間以上は h:mm:ss
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 日本語の文章は句点 (。) ごとに改行する (エスケープ済みHTMLに対して使う。文末の句点には入れない)
const brk = (h) => h.replace(/。([」』）)]*)(?=[\s\S])/g, "。$1<br>");
const hasOcr = cards.some((c) => c.ocr.length);

// --- 用語解説: 本文中の用語を見つけて「？」ボタンを付ける (同じ用語は、1つの文章ブロックで最初の1回だけ)
const termIndex = {};
const pats = [];
GL.forEach((g, i) => g.match.forEach((m) => { termIndex[m] = i; pats.push(m); }));
pats.sort((a, b) => b.length - a.length);
const termRe = pats.length ? new RegExp(pats.map(reEsc).join("|"), "g") : null;

function annotate(text, used) {
  if (!termRe) return esc(text);
  let out = "", last = 0, m;
  termRe.lastIndex = 0;
  while ((m = termRe.exec(text))) {
    const gi = termIndex[m[0]];
    out += esc(text.slice(last, m.index));
    if (used.has(gi)) {
      out += esc(m[0]);
    } else {
      used.add(gi);
      out += '<span class="term">' + esc(m[0]) + '<button class="q" type="button" data-g="' + gi +
        '" aria-label="「' + esc(GL[gi].term) + '」の意味を表示" aria-expanded="false">?</button></span>';
    }
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const pop = $("pop");
let popBtn = null;
function closePop() {
  pop.hidden = true;
  if (popBtn) popBtn.setAttribute("aria-expanded", "false");
  popBtn = null;
}
function openPop(btn) {
  if (popBtn) popBtn.setAttribute("aria-expanded", "false");
  const g = GL[Number(btn.dataset.g)];
  $("pt").textContent = g.term;
  $("pd").innerHTML = brk(esc(g.desc));
  pop.hidden = false;
  const w = Math.min(340, window.innerWidth - 24);
  pop.style.width = w + "px";
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + "px";
  const h = pop.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  pop.style.top = top + "px";
  popBtn = btn;
  btn.setAttribute("aria-expanded", "true");
}

// --- 最初のページ: 1分サマリー
function renderSummary() {
  const s = DATA.summary, used = new Set();
  const flow = DATA.sections.map((name, si) => {
    const idx = pages.findIndex((p) => p.sec === si);
    if (idx < 0) return "";
    const n = cards.filter((c) => c.sec === si).length;
    return '<button class="flow" type="button" data-go="' + idx + '"><span class="ft">' + mmss(pages[idx].t0) +
      '〜 · ' + (idx + 1) + '枚目から</span><span class="fn">' + esc(name) + '</span><span class="fc">' + n + "発言</span></button>";
  }).join("");
  $("summary").innerHTML =
    '<div class="chips"><span class="chip">1分サマリー</span><span class="chip sec">読了の目安: 約1分</span></div>' +
    "<h2>" + esc(s.title) + "</h2>" +
    '<p class="lead">' + brk(annotate(s.lead, used)) + "</p>" +
    "<ol>" + s.points.map((p) => "<li>" + (p.h ? "<b>" + esc(p.h) + "</b>" : "") + "<span>" + brk(annotate(p.t || "", used)) + "</span></li>").join("") + "</ol>" +
    (s.blocks.length ? '<div class="blocks">' + s.blocks.map((b) =>
      "<section><h3>" + esc(b.label) + "</h3><ul>" + b.items.map((it) => "<li>" + brk(annotate(it, used)) + "</li>").join("") + "</ul></section>").join("") + "</div>" : "") +
    "<h3>この区間の流れ (押すとその場面へ)</h3>" +
    '<div class="flowrow">' + flow + "</div>" +
    '<button class="nav primary" id="start" type="button">紙芝居を始める →</button>';
}

// --- 各ページ (同じ画面の発言をまとめたもの)
function renderPage() {
  const p = pages[cur];
  const used = new Set();                 // 「？」は、1ページで同じ用語につき最初の1回だけ
  const hasPic = p.frame !== null;
  $("pic").hidden = !hasPic;
  $("stage").classList.toggle("noimg", !hasPic);
  if (hasPic) {
    const img = $("img");
    img.src = IMG[p.frame];
    img.alt = "動画 " + mmss(p.t0) + " 付近のキャプチャ";
  }
  const lang = esc(DATA.srcLang);
  const multi = p.items.length > 1;
  const utts = p.items.map((c, k) =>
    '<div class="utt' + (multi ? " multi" : "") + '" data-k="' + k + '">' +
    (multi || c.speaker ? '<div class="uhead">' + (multi ? '<span class="ut">' + mmss(c.t0) + "</span>" : "") +
      (c.speaker ? '<span class="chip spk">' + esc(c.speaker) + "</span>" : "") + "</div>" : "") +
    '<p class="ja">' + brk(annotate(c.ja, used)) + "</p>" +
    (c.en ? '<p class="en" lang="' + lang + '">' + esc(c.en) + "</p>" : "") +
    (c.note ? '<p class="note">' + brk(esc(c.note)) + "</p>" : "") + "</div>").join("");
  const ocrItems = p.items.flatMap((c) => c.ocr);
  let ocr = "";
  if (ocrItems.length) {
    ocr = '<details class="ocr" open><summary>' + esc(DATA.ocrLabel) + '</summary><ul>' +
      ocrItems.map((o) => '<li><span class="oen" lang="' + lang + '">' + esc(o[0]) + '</span><span class="oja">' + brk(annotate(o[1], used)) + "</span></li>").join("") +
      "</ul></details>";
  } else if (hasOcr && hasPic && cur > 0 && pages[cur - 1].frame === p.frame) {
    ocr = '<details class="ocr"><summary>' + esc(DATA.ocrLabel) + '</summary><p class="same">画面は前のページと同じです。訳は前のページを参照してください。</p></details>';
  }
  $("text").innerHTML =
    '<div class="chips"><span class="chip">' + mmss(p.t0) + "〜" + mmss(p.t1) + "</span>" +
    '<span class="chip sec">' + esc(DATA.sections[p.sec]) + "</span>" +
    (multi ? '<span class="chip sec">' + p.items.length + "発言</span>" : "") + "</div>" + utts + ocr;
  // 強調枠は、枠を持つ最初の発言から始める。発言をクリックするとその発言の枠に切り替わる
  setAct(Math.max(0, p.items.findIndex((c) => c.hl)));
}

function setAct(k) {
  const p = pages[cur];
  act = k;
  document.querySelectorAll("#text .utt").forEach((u, i) => u.classList.toggle("on", i === k && p.items.length > 1));
  const c = p.items[k], hl = $("hl");
  if (p.frame !== null && c && c.hl) {
    hl.hidden = false;
    hl.style.left = c.hl[0] + "%"; hl.style.top = c.hl[1] + "%";
    hl.style.width = c.hl[2] + "%"; hl.style.height = c.hl[3] + "%";
  } else {
    hl.hidden = true;
  }
}

function render() {
  const sum = cur < 0;
  $("summary").hidden = !sum;
  $("stage").hidden = sum;
  if (sum) renderSummary(); else renderPage();
  $("count").textContent = sum ? "サマリー" : (cur + 1) + " / " + N;
  $("prog").style.width = ((cur + 1) / N * 100) + "%";
  $("prev").disabled = cur <= -1;
  $("next").disabled = cur === N - 1;
  document.querySelectorAll(".thumb").forEach((t, i) => {
    const on = i === cur + 1;
    t.setAttribute("aria-current", on ? "true" : "false");
    if (on) {
      const strip = $("strip");
      strip.scrollTo({ left: t.offsetLeft - (strip.clientWidth - t.clientWidth) / 2, behavior: "smooth" });
    }
  });
  try { history.replaceState(null, "", "#" + (cur + 1)); } catch (e) {}
}

function go(i) {
  closePop();
  cur = Math.max(-1, Math.min(N - 1, i));
  render();
}

function buildStrip() {
  const strip = $("strip");
  const s0 = document.createElement("button");
  s0.type = "button"; s0.className = "thumb sumthumb"; s0.setAttribute("role", "listitem");
  s0.setAttribute("aria-label", "1分サマリー");
  s0.innerHTML = "<span>1分<br>サマリー</span>";
  s0.addEventListener("click", () => go(-1));
  strip.appendChild(s0);
  pages.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "thumb"; b.setAttribute("role", "listitem");
    b.setAttribute("aria-label", (i + 1) + "枚目 " + mmss(c.t0));
    if (c.frame !== null) {
      b.innerHTML = '<img alt=""><b>' + (i + 1) + " · " + mmss(c.t0) + "</b>";
      b.firstChild.src = IMG[c.frame];
    } else {
      b.className += " sumthumb";
      b.innerHTML = "<span>" + (i + 1) + "<br>" + mmss(c.t0) + "</span>";
    }
    b.addEventListener("click", () => go(i));
    strip.appendChild(b);
  });
}

$("prev").addEventListener("click", () => go(cur - 1));
$("next").addEventListener("click", () => go(cur + 1));
$("pic").addEventListener("click", () => {
  if (cur < 0 || pages[cur].frame === null) return;
  $("lbimg").src = IMG[pages[cur].frame]; $("lb").classList.add("on");
});
$("lb").addEventListener("click", () => $("lb").classList.remove("on"));
$("px").addEventListener("click", closePop);
document.addEventListener("click", (e) => {
  const q = e.target.closest(".q");
  if (q) {
    if (popBtn === q && !pop.hidden) closePop(); else openPop(q);
    return;
  }
  const g = e.target.closest("[data-go]");
  if (g) { go(Number(g.dataset.go)); return; }
  if (e.target.closest("#start")) { go(0); return; }
  const u = e.target.closest(".utt");
  if (u && cur >= 0 && !e.target.closest(".q")) setAct(Number(u.dataset.k));
  if (!pop.contains(e.target)) closePop();
});
window.addEventListener("resize", closePop);
// ページ本体のスクロールでだけ閉じる (サムネイル帯の横スクロールでは閉じない)
window.addEventListener("scroll", (e) => {
  if (e.target === document || e.target === document.documentElement) closePop();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (!pop.hidden) closePop(); else $("lb").classList.remove("on"); }
  else if (e.target.closest && e.target.closest("input")) return;
  else if (e.key === "ArrowRight") go(cur + 1);
  else if (e.key === "ArrowLeft") go(cur - 1);
  else if (e.key === "Home") go(-1);
  else if (e.key === "End") go(N - 1);
});
let sx = null;
$("stage").addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
$("stage").addEventListener("touchend", (e) => {
  if (sx === null) return;
  const dx = e.changedTouches[0].clientX - sx; sx = null;
  if (Math.abs(dx) > 60) go(cur + (dx < 0 ? 1 : -1));
}, { passive: true });

DATA.notes.forEach((n) => { const li = document.createElement("li"); li.innerHTML = brk(esc(n)); $("notes").appendChild(li); });
if (!GL.length) $("glossbox").hidden = true;
GL.forEach((g) => {
  const dt = document.createElement("dt"), dd = document.createElement("dd");
  dt.textContent = g.term; dd.innerHTML = brk(esc(g.desc));
  $("gloss").appendChild(dt); $("gloss").appendChild(dd);
});
buildStrip();
const h = parseInt(location.hash.slice(1), 10);
go(Number.isFinite(h) ? h - 1 : -1);
</script>
</body>
</html>
"""

html = (html.replace("__TITLE__", htmllib.escape(TITLE))
        .replace("__SUBTITLE__", sentences_br(htmllib.escape(SUBTITLE)))
        .replace("__IMG__", js(images)).replace("__DATA__", js(payload)))
out_path.write_text(html, encoding="utf-8")
print(f"cards={len(CARDS)} pages={n_pages} images={len(images)} bytes={out_path.stat().st_size} "
      f"glossary={len(GLOSSARY)} summary_chars={summary_chars} blocks_chars={blocks_chars}")
# 約1分で読める目安: 本文 (lead + points) は 300〜700 字、blocks を含めた合計は 1000 字以内
if not 300 <= summary_chars <= 700:
    print(f"注意: サマリー本文 (lead + points。blocks は除く) が {summary_chars} 文字です。300〜700 文字に調整してください。")
if summary_chars + blocks_chars > 1000:
    print(f"注意: サマリーが blocks を含めて {summary_chars + blocks_chars} 文字です。1000 文字以内に調整してください。")
if unused:
    print("本文に出てこない用語:", ", ".join(unused))
