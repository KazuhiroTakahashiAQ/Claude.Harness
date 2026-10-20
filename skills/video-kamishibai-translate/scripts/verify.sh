#!/usr/bin/env bash
# 生成した紙芝居HTMLをヘッドレスの Chrome 系ブラウザ (Chrome / Chromium / Edge) で検証する。
#
# 使い方: verify.sh <kamishibai.html> <tmpdir> [screenshot.png [カード番号]]
#   tmpdir は新しい空ディレクトリ (検証用ページを置く)。
# 出力: 1行の結果。summaryFirst / qOnLoad / qCards / popOpens / cards / brokenImg / emptyJa / ocrCards / hlCards /
#   first / last / errors / mobile を表示する。次を満たせば合格。
#   summaryFirst=true (最初のページが1分サマリー)、errors=[]、brokenImg=0、emptyJa=0、overflow=false、
#   用語集を付けた場合は (qOnLoad>0 または qCards>0) かつ popOpens=true (「？」が初期状態から出て、押すと開く)。
#   qOnLoad はサマリー内、qCards は「？」を含むカードの数。
# 終了コード: 0=検証を実行 / 3=ブラウザが無く検証できない (この場合は目視で代替する)
# 環境変数: CHROME  ブラウザの実行ファイル (未指定なら自動で探す)
#
# 注意:
#  - ヘッドレス Chrome は最小ウィンドウ幅の都合で、--window-size を小さくしても実レイアウトは狭くならない。
#    そのためモバイル幅は iframe(390px) に入れて測る (--allow-file-access-from-files で親から中身を読む)。
#  - 紙芝居側の cards は const 宣言で window のプロパティにならないため、親からは eval で読む。
set -euo pipefail

if [ "$#" -lt 2 ]; then
  sed -n '2,17p' "$0"
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

html=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
tmp=$2
shot=${3:-}
card=${4:-1}

chrome=$(find_chrome || true)
if [ -z "$chrome" ]; then
  echo "Chrome 系ブラウザが見つからないため、自動検証はできません。出力HTMLをブラウザで開いて目視で確認してください。" >&2
  echo "(CHROME にブラウザの実行ファイルを指定すれば検証できます)" >&2
  exit 3
fi

mkdir -p "$tmp"
html_url=$(to_file_url "$html")
cat >"$tmp/probe.html" <<'EOF'
<!doctype html><meta charset="utf-8"><body>
<iframe id="a" src="__HTML__" style="width:1200px;height:900px"></iframe>
<iframe id="b" src="__HTML__#2" style="width:390px;height:900px"></iframe>
<pre id="r">pending</pre>
<script>
const a = document.getElementById('a'), b = document.getElementById('b');
let loaded = 0;
function finish() {
  if (++loaded < 2) return;
  setTimeout(() => {
    let out;
    try {
      const w = a.contentWindow, errs = [];
      const N = w.eval('cards.length');
      const d0 = a.contentDocument;
      const summaryFirst = !d0.getElementById('summary').hidden;
      const qOnLoad = d0.querySelectorAll('#summary .q').length;
      let popOpens = 'n/a';
      if (qOnLoad > 0) { d0.querySelector('#summary .q').click(); popOpens = !d0.getElementById('pop').hidden; w.go(-1); }
      let broken = 0, emptyJa = 0, ocr = 0, hl = 0, qCards = 0, first = '', last = '';
      for (let i = 0; i < N; i++) {
        try { w.go(i); } catch (e) { errs.push('go(' + i + '): ' + e.message); }
        const d = a.contentDocument, img = d.getElementById('img');
        if (d.querySelector('#text .q')) {
          qCards++;
          if (popOpens === 'n/a') { d.querySelector('#text .q').click(); popOpens = !d.getElementById('pop').hidden; }
        }
        if (!d.getElementById('pic').hidden && (!img.complete || img.naturalWidth < 100)) broken++;
        if (!d.querySelector('#text .ja').textContent.trim()) emptyJa++;
        if (d.querySelector('#text .ocr li')) ocr++;
        if (!d.getElementById('hl').hidden) hl++;
        if (i === 0) first = d.querySelector('#text .chip').textContent;
        if (i === N - 1) last = d.querySelector('#text .chip').textContent;
      }
      const e = b.contentDocument.documentElement;
      out = 'summaryFirst=' + summaryFirst + ' qOnLoad=' + qOnLoad + ' qCards=' + qCards + ' popOpens=' + popOpens +
        ' cards=' + N + ' brokenImg=' + broken + ' emptyJa=' + emptyJa + ' ocrCards=' + ocr + ' hlCards=' + hl +
        ' first=' + first + ' last=' + last + ' errors=' + JSON.stringify(errs) +
        ' mobile(390px): scrollW=' + e.scrollWidth + ' clientW=' + e.clientWidth + ' overflow=' + (e.scrollWidth > e.clientWidth);
    } catch (e) {
      out = 'probe error: ' + e.message;
    }
    document.getElementById('r').textContent = out;
  }, 800);
}
a.addEventListener('load', finish);
b.addEventListener('load', finish);
</script>
EOF
sed -i.bak "s|__HTML__|$html_url|g" "$tmp/probe.html" && rm -f "$tmp/probe.html.bak"
probe_url=$(to_file_url "$tmp/probe.html")

"$chrome" --headless=new --disable-gpu --allow-file-access-from-files --virtual-time-budget=20000 \
  --window-size=1300,1000 --dump-dom "$probe_url" 2>/dev/null \
  | grep -o '<pre id="r">[^<]*' | sed 's/<pre id="r">//'

if [ -n "$shot" ]; then
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=5000 \
    --window-size=1440,1000 --screenshot="$shot" "$html_url#$card" >/dev/null 2>&1
  echo "screenshot: $shot (card $card)"
fi
