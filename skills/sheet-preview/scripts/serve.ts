// sheet-preview サーバ。依存なし。Node 22.6+（型除去が有効な版）で `node serve.ts ...` と実行する。
//
//   node serve.ts <name>.sheet.json [--port 8765] [--review <name>.review.json]
//   node serve.ts <name>.sheet.json --render out.html     # サーバなしの静的 HTML を書いて終了
//
// - GET  /            HTML（sheet.json / review.json を埋め込み済み）
// - GET  /api/sheet   sheet.json（読み込みのたびにファイルから読む。ヘッダ x-version に版）
// - GET  /api/review  review.json（無ければ空の雛形。ヘッダ x-version に版）
// - GET  /api/version {sheet, review} の現在の版（mtime-size）。画面が定期的に見て、エージェントの更新を検知する
// - POST /api/sheet   sheet.json を保存。body: {sheet, base}。base は読み込み時の版
// - POST /api/review  review.json を保存。body: {items, base}
//   base とファイルの現在の版が違えば 409（読み込み後に別の書き手が更新した）。上書きしない。
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
const versionOf = (file: string): string => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return "none";
  }
};
const emptyReview = () => ({ sheet: path.basename(sheetFile), items: [] as unknown[] });
const readReview = (): unknown => (fs.existsSync(reviewFile) ? readJson(reviewFile) : emptyReview());

// <script> 内に安全に埋め込むため < を逃がす
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").split(String.fromCharCode(0x2028)).join(" ").split(String.fromCharCode(0x2029)).join(" ");

function renderHtml(serverMode: boolean): string {
  const tpl = fs.readFileSync(templatePath, "utf-8");
  const boot = {
    sheet: readJson(sheetFile),
    review: readReview(),
    server: serverMode,
    key: path.basename(sheetFile),
    ver: { sheet: versionOf(sheetFile), review: versionOf(reviewFile) },
  };
  return tpl.replace("/*__BOOT__*/null", () => embed(boot));
}

function validateReview(r: any): string | null {
  if (!r || typeof r !== "object" || !Array.isArray(r.items)) return "items 配列がありません";
  for (const it of r.items) {
    if (typeof it.range !== "string" || typeof it.instruction !== "string") return "range と instruction は文字列が必要です";
    if (!["未対応", "対応済", "質問"].includes(it.status)) return `status が不正です: ${it.status}`;
  }
  return null;
}

function validateSheet(s: any): string | null {
  if (!s || typeof s !== "object" || !Array.isArray(s.sheets) || s.sheets.length < 1) return "sheets 配列（1 枚以上）がありません";
  const names = new Set<string>();
  for (const sh of s.sheets) {
    if (!sh || typeof sh.name !== "string" || !sh.name) return "各シートに name が必要です";
    if (names.has(sh.name)) return `シート名が重複しています: ${sh.name}`;
    names.add(sh.name);
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

function handleSave(req: http.IncomingMessage, res: http.ServerResponse, isSheet: boolean) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 20_000_000) req.destroy();
  });
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      const file = isSheet ? sheetFile : reviewFile;
      const cur = versionOf(file);
      // 読み込み時の版と違えば、エージェント（または別の画面）が先に書いている。上書きしない
      if (typeof j.base === "string" && j.base !== cur) {
        return send(res, 409, "application/json", JSON.stringify({ ok: false, conflict: true, version: cur, error: "ファイルが読み込み後に更新されています" }));
      }
      let out: any;
      if (isSheet) {
        const err = validateSheet(j.sheet);
        if (err) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: err }));
        out = j.sheet;
      } else {
        const err = validateReview(j);
        if (err) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: err }));
        out = { sheet: path.basename(sheetFile), items: j.items };
      }
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
      fs.renameSync(tmp, file);
      const count = isSheet ? out.sheets.length : out.items.length;
      send(res, 200, "application/json", JSON.stringify({ ok: true, path: file, count, version: versionOf(file) }));
    } catch (e) {
      send(res, 400, "application/json", JSON.stringify({ ok: false, error: String(e) }));
    }
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    // DNS rebinding 対策: Host が localhost 系以外は拒否
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(res, 403, "text/plain", "forbidden");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html", renderHtml(true));
    if (req.method === "GET" && url.pathname === "/api/sheet") {
      res.setHeader("x-version", versionOf(sheetFile));
      return send(res, 200, "application/json", JSON.stringify(readJson(sheetFile)));
    }
    if (req.method === "GET" && url.pathname === "/api/review") {
      res.setHeader("x-version", versionOf(reviewFile));
      return send(res, 200, "application/json", JSON.stringify(readReview()));
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      return send(res, 200, "application/json", JSON.stringify({ sheet: versionOf(sheetFile), review: versionOf(reviewFile) }));
    }
    if (req.method === "POST" && url.pathname === "/api/review") return handleSave(req, res, false);
    if (req.method === "POST" && url.pathname === "/api/sheet") return handleSave(req, res, true);
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
