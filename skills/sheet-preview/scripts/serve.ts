// sheet-preview サーバ。依存なし。Node 22.6+（型除去が有効な版）で `node serve.ts ...` と実行する。
//
//   node serve.ts <name>.sheet.json [--port 8765] [--review <name>.review.json]
//   node serve.ts <name>.sheet.json --render out.html     # サーバなしの静的 HTML を書いて終了
//
// - GET  /            HTML（sheet.json / review.json を埋め込み済み）
// - GET  /api/sheet   sheet.json（読み込みのたびにファイルから読む。描き直し = ブラウザの再読み込み）
// - GET  /api/review  review.json（無ければ空の雛形）
// - POST /api/review  review.json を保存（localhost からのみ）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "assets", "template.html");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sheetPath = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!sheetPath) {
  console.error("usage: node serve.ts <name>.sheet.json [--port 8765] [--review x.review.json] [--render out.html]");
  process.exit(2);
}
const sheetFile = path.resolve(sheetPath);
const reviewFile = path.resolve(flag("--review") ?? sheetFile.replace(/\.sheet\.json$/, "") + ".review.json");
const port = Number(flag("--port") ?? 8765);

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf-8"));
const emptyReview = () => ({ sheet: path.basename(sheetFile), items: [] as unknown[] });
const readReview = (): unknown => (fs.existsSync(reviewFile) ? readJson(reviewFile) : emptyReview());

// <script> 内に安全に埋め込むため < を逃がす
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").split(String.fromCharCode(0x2028)).join(" ").split(String.fromCharCode(0x2029)).join(" ");

function renderHtml(serverMode: boolean): string {
  const tpl = fs.readFileSync(templatePath, "utf-8");
  const boot = { sheet: readJson(sheetFile), review: readReview(), server: serverMode, key: path.basename(sheetFile) };
  return tpl.replace("/*__BOOT__*/null", embed(boot));
}

function validateReview(r: any): string | null {
  if (!r || typeof r !== "object" || !Array.isArray(r.items)) return "items 配列がありません";
  for (const it of r.items) {
    if (typeof it.range !== "string" || typeof it.instruction !== "string") return "range と instruction は文字列が必要です";
    if (!["未対応", "対応済", "質問"].includes(it.status)) return `status が不正です: ${it.status}`;
  }
  return null;
}

const renderOut = flag("--render");
if (renderOut) {
  fs.writeFileSync(path.resolve(renderOut), renderHtml(false));
  console.log(`wrote ${renderOut}`);
  process.exit(0);
}

const send = (res: http.ServerResponse, code: number, type: string, body: string) => {
  res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    // DNS rebinding 対策: Host が localhost 系以外は拒否
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(res, 403, "text/plain", "forbidden");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html", renderHtml(true));
    if (req.method === "GET" && url.pathname === "/api/sheet") return send(res, 200, "application/json", JSON.stringify(readJson(sheetFile)));
    if (req.method === "GET" && url.pathname === "/api/review") return send(res, 200, "application/json", JSON.stringify(readReview()));
    if (req.method === "POST" && url.pathname === "/api/review") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 5_000_000) req.destroy();
      });
      req.on("end", () => {
        try {
          let r = JSON.parse(body);
          const err = validateReview(r);
          if (err) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: err }));
          r = { sheet: path.basename(sheetFile), items: r.items };
          const tmp = reviewFile + ".tmp";
          fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n");
          fs.renameSync(tmp, reviewFile);
          send(res, 200, "application/json", JSON.stringify({ ok: true, path: reviewFile, count: r.items.length }));
        } catch (e) {
          send(res, 400, "application/json", JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    send(res, 404, "text/plain", "not found");
  } catch (e) {
    send(res, 500, "text/plain", String(e));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`sheet-preview: http://localhost:${port}/`);
  console.log(`  sheet : ${sheetFile}`);
  console.log(`  review: ${reviewFile}`);
});
