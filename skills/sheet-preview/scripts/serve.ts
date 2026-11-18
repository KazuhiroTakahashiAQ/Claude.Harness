// sheet-preview サーバ。依存なし。Node 22.6+（型除去が有効な版）で `node serve.ts ...` と実行する。
//
//   node serve.ts <name>.sheet.json [--port 8765] [--review <name>.review.json]
//   node serve.ts a.sheet.json b.sheet.json [dir ...]     # 複数ファイル（ファイルタブ）。dir は直下の *.sheet.json を列挙
//   node serve.ts <...> --render out.html                  # サーバなしの静的 HTML を書いて終了（全ファイルを 1 枚に埋め込み）
//
// ファイルは key（ファイル名。重複時は親フォルダ名/ファイル名）で区別する。API は ?f=<key> でファイルを指定する（省略時は先頭ファイル）。
// - GET  /              HTML（全ファイルの sheet.json / review.json を埋め込み済み）
// - GET  /api/files     [{key, sheet, review, ver}]（全ファイルの現在の中身）
// - GET  /api/file      ?f=key  {key, sheet, review, ver}
// - GET  /api/sheet     ?f=key  sheet.json（読み込みのたびにファイルから読む。ヘッダ x-version に版）
// - GET  /api/review    ?f=key  review.json（無ければ空の雛形。ヘッダ x-version に版）
// - GET  /api/version   {files: {key: {sheet, review}}, sheet, review}。画面が定期的に見て、更新・新規ファイルを検知する
//                       （sheet / review は先頭ファイルの版。旧クライアント互換）
// - POST /api/sheet     ?f=key  sheet.json を保存。body: {sheet, base}。base は読み込み時の版
// - POST /api/review    ?f=key  review.json を保存。body: {items, base}
// - POST /api/open      {path} 別の *.sheet.json（またはフォルダ）をタブに追加。無いパスは新規作成
//   base とファイルの現在の版が違えば 409（読み込み後に別の書き手が更新した）。上書きしない。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "assets", "template.html");

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--port", "--review", "--render"]);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const inputs = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));
if (!inputs.length) {
  console.error("usage: node serve.ts <a.sheet.json|dir> [b.sheet.json ...] [--port 8765] [--review x.review.json（1 ファイルのときのみ）] [--render out.html]");
  process.exit(2);
}
const port = Number(flag("--port") ?? 8765);
const reviewOverride = flag("--review");

type Entry = { key: string; sheetFile: string; reviewFile: string };
const entries: Entry[] = [];
const watchDirs: string[] = [];
const SUFFIX = ".sheet.json";
const expand = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(1)) : p);

function addSheetFile(file: string): { entry: Entry; added: boolean } {
  const sheetFile = path.resolve(expand(file));
  const hit = entries.find((e) => e.sheetFile === sheetFile);
  if (hit) return { entry: hit, added: false };
  let key = path.basename(sheetFile);
  if (entries.some((e) => e.key === key)) key = path.basename(path.dirname(sheetFile)) + "/" + key;
  while (entries.some((e) => e.key === key)) key += "'";
  const reviewFile = reviewOverride && inputs.length === 1 ? path.resolve(reviewOverride) : sheetFile.replace(/\.sheet\.json$/, "") + ".review.json";
  const entry = { key, sheetFile, reviewFile };
  entries.push(entry);
  return { entry, added: true };
}
// ディレクトリ内の *.sheet.json を列挙（直下のみ）。新しく増えたものだけ追加する
function scanDirs(): Entry[] {
  const added: Entry[] = [];
  for (const d of watchDirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith(SUFFIX)).sort(); } catch { continue; }
    for (const n of names) { const r = addSheetFile(path.join(d, n)); if (r.added) added.push(r.entry); }
  }
  return added;
}
for (const inp of inputs) {
  const abs = path.resolve(expand(inp));
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { watchDirs.push(abs); continue; }
  addSheetFile(abs);
}
scanDirs();
if (!entries.length) {
  console.error("*.sheet.json が見つかりません");
  process.exit(2);
}
const entryOf = (key: string | null): Entry | undefined => (key ? entries.find((e) => e.key === key) : entries[0]);

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf-8"));
const versionOf = (file: string): string => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return "none";
  }
};
const emptyReview = (e: Entry) => ({ sheet: path.basename(e.sheetFile), items: [] as unknown[] });
const readReview = (e: Entry): unknown => (fs.existsSync(e.reviewFile) ? readJson(e.reviewFile) : emptyReview(e));
const fileState = (e: Entry) => ({ key: e.key, sheet: readJson(e.sheetFile), review: readReview(e), ver: { sheet: versionOf(e.sheetFile), review: versionOf(e.reviewFile) } });
const safeStates = () => entries.flatMap((e) => { try { return [fileState(e)]; } catch (err) { console.error(`skip ${e.sheetFile}: ${err}`); return []; } });

// <script> 内に安全に埋め込むため < を逃がす
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").split(String.fromCharCode(0x2028)).join(" ").split(String.fromCharCode(0x2029)).join(" ");

function renderHtml(serverMode: boolean): string {
  const tpl = fs.readFileSync(templatePath, "utf-8");
  return tpl.replace("/*__BOOT__*/null", () => embed({ server: serverMode, files: safeStates() }));
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
  console.log(`wrote ${renderOut}（${entries.length} ファイル）`);
  process.exit(0);
}

const send = (res: http.ServerResponse, code: number, type: string, body: string) => {
  res.writeHead(code, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};
const sendJson = (res: http.ServerResponse, code: number, v: unknown) => send(res, code, "application/json", JSON.stringify(v));

function readBody(req: http.IncomingMessage, cb: (body: string) => void) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 20_000_000) req.destroy();
  });
  req.on("end", () => cb(body));
}

function handleSave(req: http.IncomingMessage, res: http.ServerResponse, e: Entry, isSheet: boolean) {
  readBody(req, (body) => {
    try {
      const j = JSON.parse(body);
      const file = isSheet ? e.sheetFile : e.reviewFile;
      const cur = versionOf(file);
      // 読み込み時の版と違えば、エージェント（または別の画面）が先に書いている。上書きしない
      if (typeof j.base === "string" && j.base !== cur) {
        return sendJson(res, 409, { ok: false, conflict: true, version: cur, error: "ファイルが読み込み後に更新されています" });
      }
      let out: any;
      if (isSheet) {
        const err = validateSheet(j.sheet);
        if (err) return sendJson(res, 400, { ok: false, error: err });
        out = j.sheet;
      } else {
        const err = validateReview(j);
        if (err) return sendJson(res, 400, { ok: false, error: err });
        out = { sheet: path.basename(e.sheetFile), items: j.items };
      }
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
      fs.renameSync(tmp, file);
      const count = isSheet ? out.sheets.length : out.items.length;
      sendJson(res, 200, { ok: true, path: file, count, version: versionOf(file) });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
    }
  });
}

// 画面から別ファイルを追加。*.sheet.json のパス（無ければ新規作成）かフォルダ
function handleOpen(req: http.IncomingMessage, res: http.ServerResponse) {
  readBody(req, (body) => {
    try {
      const p = String(JSON.parse(body).path ?? "").trim();
      if (!p) return sendJson(res, 400, { ok: false, error: "パスが空です" });
      const abs = path.resolve(expand(p));
      const keys: string[] = [];
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
        if (!watchDirs.includes(abs)) watchDirs.push(abs);
        for (const e of scanDirs()) keys.push(e.key);
        if (!keys.length) return sendJson(res, 400, { ok: false, error: "新しい *.sheet.json がありません" });
      } else {
        if (!abs.endsWith(SUFFIX)) return sendJson(res, 400, { ok: false, error: "ファイル名は <名前>.sheet.json にしてください" });
        let created = false;
        if (!fs.existsSync(abs)) {
          if (!fs.existsSync(path.dirname(abs))) return sendJson(res, 400, { ok: false, error: "フォルダがありません: " + path.dirname(abs) });
          const title = path.basename(abs, SUFFIX);
          fs.writeFileSync(abs, JSON.stringify({ title, mode: "schema", sheets: [{ name: "シート1", rows: 20, cols: 8, cells: {} }] }, null, 2) + "\n");
          created = true;
        }
        const r = addSheetFile(abs);
        try { readJson(abs); } catch (err) { entries.splice(entries.indexOf(r.entry), 1); return sendJson(res, 400, { ok: false, error: "JSON を読めません: " + err }); }
        keys.push(r.entry.key);
        return sendJson(res, 200, { ok: true, keys, created });
      }
      sendJson(res, 200, { ok: true, keys, created: false });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err) });
    }
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    // DNS rebinding 対策: Host が localhost 系以外は拒否
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return send(res, 403, "text/plain", "forbidden");
    if (req.method === "POST") {
      // 他サイトからの CSRF 対策: JSON 必須（プリフライトが要る）かつ Origin があれば同一ホスト
      const origin = req.headers.origin;
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "text/plain", "json only");
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, "text/plain", "forbidden");
    }
    scanDirs();
    const e = entryOf(url.searchParams.get("f"));
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html", renderHtml(true));
    if (req.method === "GET" && url.pathname === "/api/files") return sendJson(res, 200, safeStates());
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/version" && url.pathname !== "/api/files" && url.pathname !== "/api/open" && !e) return sendJson(res, 404, { ok: false, error: "unknown file" });
    if (req.method === "GET" && url.pathname === "/api/file") return sendJson(res, 200, fileState(e!));
    if (req.method === "GET" && url.pathname === "/api/sheet") {
      res.setHeader("x-version", versionOf(e!.sheetFile));
      return sendJson(res, 200, readJson(e!.sheetFile));
    }
    if (req.method === "GET" && url.pathname === "/api/review") {
      res.setHeader("x-version", versionOf(e!.reviewFile));
      return sendJson(res, 200, readReview(e!));
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      const files: Record<string, { sheet: string; review: string }> = {};
      for (const x of entries) if (fs.existsSync(x.sheetFile)) files[x.key] = { sheet: versionOf(x.sheetFile), review: versionOf(x.reviewFile) };
      return sendJson(res, 200, { files, sheet: versionOf(entries[0].sheetFile), review: versionOf(entries[0].reviewFile) });
    }
    if (req.method === "POST" && url.pathname === "/api/review") return handleSave(req, res, e!, false);
    if (req.method === "POST" && url.pathname === "/api/sheet") return handleSave(req, res, e!, true);
    if (req.method === "POST" && url.pathname === "/api/open") return handleOpen(req, res);
    send(res, 404, "text/plain", "not found");
  } catch (err) {
    send(res, 500, "text/plain", String(err));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`sheet-preview: http://localhost:${port}/`);
  for (const e of entries) console.log(`  [${e.key}] sheet: ${e.sheetFile}  review: ${e.reviewFile}`);
  for (const d of watchDirs) console.log(`  watching dir: ${d}`);
});
