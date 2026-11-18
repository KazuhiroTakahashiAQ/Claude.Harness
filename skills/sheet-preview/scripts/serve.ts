// sheet-preview サーバ（ハブ）。依存なし。Node 22.6+（型除去が有効な版）で `node serve.ts ...` と実行する。
//
//   node serve.ts <name>.sheet.json [...] [--task <タスク名>] [--port N]
//   node serve.ts a.sheet.json b.sheet.json [dir ...]     # 複数ファイル。dir は直下の *.sheet.json を列挙して登録
//   node serve.ts                                         # ファイル指定なし（一覧だけ開く）
//   node serve.ts --stop                                  # 常駐しているハブを止める
//   node serve.ts <...> --render out.html                 # サーバなしの静的 HTML を書いて終了（全ファイルを 1 枚に埋め込み）
//
// ハブ方式: 固定ポート（既定 8765。--port で変更）の常駐サーバ 1 つが、登録された全 sheet.json を開く。
// - ハブが未起動なら、このプロセスがハブになる（フォアグラウンド。バックグラウンドで走らせる）。
// - ハブが起動済み（/api/ping が sheet-preview と答える）なら、新しいサーバは立てず、ファイルを登録して URL を出して終了する。
// - ポートを別プロセスが使っているときはエラーで終わる（--port で別ポートを指定）。
// 起動時・登録時の出力 1 行目:  sheet-preview: http://localhost:8765/?f=<絶対パス>
//
// 状態は ~/.sheet-preview/（環境変数 SHEET_PREVIEW_HOME で変更）: hub.json（pid・port）, registry.json（登録ファイル）,
// trash/<日時>/（整理されたファイル）, cleanup.log（整理の履歴）。
// 整理: 一覧（GET /）を開くたび、登録済みで sheet.json と review.json の更新が両方とも N 日（既定 7）より古いファイルを
// trash/ へ移す（削除ではない）。開いているタブがあるファイルは対象外。trash/ の N 日超は完全に削除する。
// --no-cleanup で整理を止める。--retention-days N で日数を変える。
//
// ファイルは key（= sheet.json の絶対パス）で区別する。API は ?f=<key> でファイルを指定する（ファイル名だけでも、登録内で一意なら通る）。
// 読み取り
// - GET  /              HTML。?f=<key> を（複数可）付けるとそのファイルをタブで開く。付けなければ一覧のみ
// - GET  /api/ping      {app:"sheet-preview", pid, port, started_at, home}
// - GET  /api/list      一覧（登録ファイルごとの作成・更新・確認待ち件数・状態）と整理・ごみ箱の状況
// - GET  /api/files     [{key, task, title, sheet, review, ver, rev}]（?f= で絞り込み可）
// - GET  /api/file      ?f=key  {key, task, title, sheet, review, ver, rev}
// - GET  /api/sheet     ?f=key  sheet.json（ヘッダ x-version に版）
// - GET  /api/review    ?f=key  review.json（スレッド形式に正規化。無ければ空。ヘッダ x-version に版）
// - GET  /api/version   ?f=key（複数可。省略で全件）{files: {key: {sheet, review, rev: {sheet, review}}}}
// 書き込み（localhost のみ。POST は JSON 必須）
// - POST /api/patch         ?f=key  {base_rev?, ops:[...]}  シートの操作リスト。サーバが直列化し、競合しない操作はマージする
// - POST /api/review/patch  ?f=key  {ops:[...]}             スレッドの追加・返信・状態変更。項目単位でマージ（常に通る）
// - POST /api/sheet         ?f=key  {sheet, base_rev?, base?}  シート全体の保存（画面の「保存」）。rev / 版が違えば 409
// - POST /api/review        ?f=key  {threads, base_rev?, base?}  review 全体の置き換え（互換用）
// - POST /api/register      {paths:[...], task?, review?}  登録（ファイルまたはフォルダ。無いファイルはエラー）
// - POST /api/open          {path}  登録。無い *.sheet.json は新規作成（画面の「開く」）
// - POST /api/registry/remove {path}  登録から外す（ファイルは消さない）
// - POST /api/trash/restore {id}   ごみ箱から元の場所へ戻して再登録
// - POST /api/heartbeat     {client, open:[...], dirty:[...]}  画面が開いているタブを知らせる（整理の保護に使う）
// 書き込みのたびに rev（整数）を +1 する。書くファイルは <file>.lock を取り、tmp + rename で置き換える（エージェントの直接書き込みと共存）。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(here, "..", "assets", "template.html");

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--port", "--review", "--render", "--task", "--retention-days"]);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const expand = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);
const inputs = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));

const DEFAULT_PORT = 8765;
const portArg = flag("--port");
let port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("--port は 1〜65535 の整数");
  process.exit(2);
}
const retentionDays = Number(flag("--retention-days") ?? process.env.SHEET_PREVIEW_RETENTION_DAYS ?? 7);
if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
  console.error("--retention-days は 0 より大きい数");
  process.exit(2);
}
const cleanupEnabled = !has("--no-cleanup");
const taskArg = flag("--task");
const reviewOverride = flag("--review");
const renderOut = flag("--render");
const home = path.resolve(expand(process.env.SHEET_PREVIEW_HOME || "~/.sheet-preview"));
const hubFile = path.join(home, "hub.json");
const registryFile = path.join(home, "registry.json");
const trashBase = path.join(home, "trash");
const logFile = path.join(home, "cleanup.log");

type Entry = { key: string; sheetFile: string; reviewFile: string; task?: string };
type Reg = { path: string; task?: string; title?: string; review?: string; registered_at: string };
const entries: Entry[] = [];
const watchDirs: string[] = [];
const SUFFIX = ".sheet.json";

// 静的 HTML（--render）では埋め込むキーを短く（絶対パスを HTML に残さない）。ハブでは絶対パスが key
function addSheetFile(file: string, opt: { task?: string; review?: string } = {}): { entry: Entry; added: boolean } {
  const sheetFile = path.resolve(expand(file));
  const hit = entries.find((e) => e.sheetFile === sheetFile);
  if (hit) {
    if (opt.task) hit.task = opt.task;
    if (opt.review) hit.reviewFile = path.resolve(expand(opt.review));
    return { entry: hit, added: false };
  }
  let key = sheetFile;
  if (renderOut) {
    key = path.basename(sheetFile);
    if (entries.some((e) => e.key === key)) key = path.basename(path.dirname(sheetFile)) + "/" + key;
    while (entries.some((e) => e.key === key)) key += "'";
  }
  const reviewFile = opt.review ? path.resolve(expand(opt.review)) : sheetFile.replace(/\.sheet\.json$/, "") + ".review.json";
  const entry: Entry = { key, sheetFile, reviewFile };
  if (opt.task) entry.task = opt.task;
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
// ファイル名だけでも、登録内で一意なら引ける（旧 API の互換）
const entryOf = (key: string | null): Entry | undefined => {
  if (!key) return entries[0];
  const hit = entries.find((e) => e.key === key);
  if (hit) return hit;
  const same = entries.filter((e) => path.basename(e.sheetFile) === key);
  return same.length === 1 ? same[0] : undefined;
};


class HttpErr extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, msg: string, extra: Record<string, unknown> = {}) { super(msg); this.status = status; this.extra = extra; }
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, "utf-8"));
const versionOf = (file: string): string => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}-${st.size}`;
  } catch {
    return "none";
  }
};
const revOf = (o: any): number => (o && Number.isInteger(o.rev) && o.rev >= 0 ? o.rev : 0);

// ---------- ファイル書き込み（ロック + tmp/rename） ----------
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// <file>.lock を排他作成して fn を実行する。エージェントが直接書くときも同じ規約（SKILL.md）。10 秒以上古い lock は残骸として消す
function withLock<T>(file: string, fn: () => T): T {
  const lock = file + ".lock";
  const t0 = Date.now();
  let fd = -1;
  for (;;) {
    try { fd = fs.openSync(lock, "wx"); break; } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock); } catch { /* 競合は次の周回で */ }
      if (Date.now() - t0 > 3000) throw new HttpErr(423, "ファイルが他の書き手にロックされています: " + path.basename(lock));
      sleepMs(25);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* 既に無い */ }
  }
}
function writeAtomic(file: string, obj: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- 変更履歴（競合判定用。メモリのみ。再起動・外部書き込みで途切れたら保守的に 409） ----------
type Change = { rev: number; keys: string[] };
const metas = new Map<string, { log: Change[]; lastVer: string }>();
function metaOf(file: string, justWrote = false) {
  let m = metas.get(file);
  if (!m) { m = { log: [], lastVer: "" }; metas.set(file, m); }
  // サーバ以外が書いた（版が最後に自分が書いた時と違う）なら履歴は信用できない。書いた直後（record）は判定しない
  if (!justWrote && m.lastVer && m.lastVer !== versionOf(file)) { m.log = []; m.lastVer = ""; }
  return m;
}
function record(file: string, rev: number, keys: string[]) {
  const m = metaOf(file, true);
  m.log.push({ rev, keys });
  if (m.log.length > 1000) m.log.splice(0, m.log.length - 1000);
  m.lastVer = versionOf(file);
}
const SEP = "\t";
const keySheet = (k: string) => k.split(SEP)[1];
function clash(a: string, b: string): boolean {
  if (a === "*" || b === "*" || a === b) return true;
  if (a.startsWith("s" + SEP)) return keySheet(b) === keySheet(a);
  if (b.startsWith("s" + SEP)) return keySheet(a) === keySheet(b);
  return false;
}
function findConflicts(file: string, baseRev: number, curRev: number, keys: string[]): { unknown: boolean; keys: string[] } {
  if (baseRev > curRev) return { unknown: true, keys: [] };
  const m = metaOf(file);
  const have = new Map(m.log.map((c) => [c.rev, c.keys]));
  const hit = new Set<string>();
  for (let r = baseRev + 1; r <= curRev; r++) {
    const ks = have.get(r);
    if (!ks) return { unknown: true, keys: [] };
    for (const k of keys) for (const x of ks) if (clash(k, x)) hit.add(k === "*" ? x : k);
  }
  return { unknown: false, keys: [...hit] };
}

// ---------- A1 / 範囲 ----------
const colName = (n: number): string => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const colNum = (s: string): number => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
type Rect = { c1: number; r1: number; c2: number; r2: number };
function parseAddr(a: string): { c: number; r: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a.trim());
  return m ? { c: colNum(m[1]), r: Number(m[2]) } : null;
}
function parseRect(t: string): Rect | null {
  const [a, b] = t.trim().split(":");
  const p = parseAddr(a);
  const q = b === undefined ? p : parseAddr(b);
  if (!p || !q) return null;
  return { c1: Math.min(p.c, q.c), r1: Math.min(p.r, q.r), c2: Math.max(p.c, q.c), r2: Math.max(p.r, q.r) };
}
const rectText = (r: Rect): string => (r.c1 === r.c2 && r.r1 === r.r2 ? `${colName(r.c1)}${r.r1}` : `${colName(r.c1)}${r.r1}:${colName(r.c2)}${r.r2}`);
const bareName = (n: string) => /^[\w぀-ヿ㐀-鿿]+$/.test(n);
const quoteSheet = (n: string) => (bareName(n) ? n : `'${n.replace(/'/g, "''")}'`);

type Part = { sheet: string; rect: Rect | null; star: boolean; raw: string };
// 範囲文字列 "明細!B2:D5, F3, 集計!*" を分解。シート名は直前の指定を引き継ぐ。解釈できない部分は rect=null / star=false で raw を残す
function splitRanges(text: string, defSheet: string): Part[] {
  const parts: string[] = [];
  let cur = "", q = false;
  for (const ch of text) {
    if (ch === "'") q = !q;
    if (ch === "," && !q) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const out: Part[] = [];
  let sheet = defSheet;
  for (const raw0 of parts) {
    const raw = raw0.trim();
    if (!raw) continue;
    let body = raw;
    const m = /^(?:'((?:[^']|'')*)'|([^!']+))!(.*)$/.exec(raw);
    if (m) { sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2].trim(); body = m[3].trim(); }
    if (body === "*") out.push({ sheet, rect: null, star: true, raw });
    else out.push({ sheet, rect: parseRect(body), star: false, raw });
  }
  return out;
}
function joinRanges(parts: Part[], defSheet: string): string {
  let prev = defSheet;
  let first = true;
  return parts.map((p) => {
    const body = p.star ? "*" : p.rect ? rectText(p.rect) : p.raw;
    const pre = first || p.sheet !== prev ? quoteSheet(p.sheet) + "!" : "";
    first = false;
    prev = p.sheet;
    return pre + body;
  }).join(", ");
}

// ---------- review（スレッド） ----------
const STATUSES = ["未対応", "対応済", "質問", "確認待ち", "解決"];
const KINDS = ["指示", "確認", "メモ"];
const AUTHORS = ["human", "agent"];
const nowIso = () => new Date().toISOString();
function normMessage(m: any): any {
  const o: any = { author: AUTHORS.includes(m?.author) ? m.author : "agent", text: String(m?.text ?? ""), at: typeof m?.at === "string" ? m.at : "" };
  if (typeof m?.name === "string" && m.name) o.name = m.name;
  return o;
}
function normThread(t: any): any {
  const o: any = {
    id: String(t?.id ?? ""),
    range: typeof t?.range === "string" ? t.range : "",
    kind: KINDS.includes(t?.kind) ? t.kind : "指示",
    status: STATUSES.includes(t?.status) ? t.status : "未対応",
    messages: Array.isArray(t?.messages) ? t.messages.map(normMessage) : [],
  };
  if (t?.deleted) o.deleted = true;
  return o;
}
// 旧形式 {items:[{id, range, instruction, status, agent_reply, deleted}]} を、人の発言 + エージェントの返答のスレッドへ
function fromLegacy(it: any): any {
  const messages: any[] = [];
  if (typeof it?.instruction === "string" && it.instruction) messages.push({ author: "human", text: it.instruction, at: "" });
  if (typeof it?.agent_reply === "string" && it.agent_reply) messages.push({ author: "agent", text: it.agent_reply, at: "" });
  return normThread({ id: it?.id, range: it?.range, kind: "指示", status: it?.status, messages, deleted: it?.deleted });
}
function normalizeReview(raw: any, e: Entry): any {
  let threads: any[] = [];
  if (Array.isArray(raw?.threads)) threads = raw.threads.map(normThread);
  else if (Array.isArray(raw?.items)) threads = raw.items.map(fromLegacy);
  return { sheet: path.basename(e.sheetFile), rev: revOf(raw), threads };
}
const readReview = (e: Entry): any => normalizeReview(fs.existsSync(e.reviewFile) ? readJson(e.reviewFile) : null, e);

function validateThreads(threads: any): string | null {
  if (!Array.isArray(threads)) return "threads 配列がありません";
  for (const t of threads) {
    if (!t || typeof t.range !== "string") return "range は文字列が必要です";
    if (!KINDS.includes(t.kind)) return `kind が不正です: ${t.kind}`;
    if (!STATUSES.includes(t.status)) return `status が不正です: ${t.status}`;
    if (!Array.isArray(t.messages)) return "messages 配列が必要です";
    for (const m of t.messages) if (!m || !AUTHORS.includes(m.author) || typeof m.text !== "string") return "messages[] は {author: human|agent, text} が必要です";
  }
  return null;
}
const nextThreadId = (threads: any[]): string => {
  let n = 0;
  for (const t of threads) { const m = /^r(\d+)$/.exec(t.id); if (m) n = Math.max(n, Number(m[1])); }
  return "r" + (n + 1);
};

type Eff =
  | { type: "axis"; sheet: string; axis: "row" | "col"; kind: "ins" | "del"; at: number; count: number }
  | { type: "rename"; from: string; to: string }
  | { type: "deleteSheet"; name: string };

function mapSpan(kind: "ins" | "del", at: number, count: number, lo: number, hi: number): [number, number] | null {
  if (kind === "ins") return [lo >= at ? lo + count : lo, hi >= at ? hi + count : hi];
  const end = at + count - 1;
  const lo2 = lo < at ? lo : lo > end ? lo - count : at;
  const hi2 = hi < at ? hi : hi > end ? hi - count : at - 1;
  return hi2 < lo2 ? null : [lo2, hi2];
}
// シート側の変更に合わせて review の range を付け替える。範囲が全部消えたら deleted を立てる（range は元のまま）
function remapThreads(threads: any[], effs: Eff[], defSheet: () => string): boolean {
  let changed = false;
  for (const t of threads) {
    if (t.range === "*" ) continue;
    for (const ef of effs) {
      const def = defSheet();
      const parts = splitRanges(t.range, def);
      let touched = false;
      let next: Part[] = parts;
      if (ef.type === "rename") {
        next = parts.map((p) => { if (p.sheet === ef.from) { touched = true; return { ...p, sheet: ef.to }; } return p; });
      } else if (ef.type === "deleteSheet") {
        next = parts.filter((p) => { if (p.sheet === ef.name) { touched = true; return false; } return true; });
        if (touched && !next.length) { if (!t.deleted) { t.deleted = true; changed = true; } continue; }
      } else {
        const keep: Part[] = [];
        for (const p of parts) {
          if (p.sheet !== ef.sheet || !p.rect) { keep.push(p); continue; }
          const rr = p.rect;
          const sp = ef.axis === "row" ? mapSpan(ef.kind, ef.at, ef.count, rr.r1, rr.r2) : mapSpan(ef.kind, ef.at, ef.count, rr.c1, rr.c2);
          touched = true;
          if (!sp) continue;
          keep.push({ ...p, rect: ef.axis === "row" ? { ...rr, r1: sp[0], r2: sp[1] } : { ...rr, c1: sp[0], c2: sp[1] } });
        }
        next = keep;
        if (touched && !next.length) { if (!t.deleted) { t.deleted = true; changed = true; } continue; }
      }
      if (touched) {
        const nr = joinRanges(next, def);
        if (nr !== t.range) { t.range = nr; changed = true; }
      }
    }
  }
  return changed;
}

// ---------- スレッド操作 ----------
function applyThreadOps(threads: any[], ops: any[]): { results: any[]; changed: boolean } {
  const results: any[] = [];
  let changed = false;
  ops.forEach((op, i) => {
    const bad = (msg: string): never => { throw new HttpErr(400, `ops[${i}]: ${msg}`); };
    if (!op || typeof op !== "object") bad("オブジェクトが必要");
    const find = (): any => {
      const t = threads.find((x) => x.id === op.id);
      return t;
    };
    const author = op.author === undefined ? "agent" : op.author;
    if (!AUTHORS.includes(author)) bad("author は human か agent");
    if (op.status !== undefined && !STATUSES.includes(op.status)) bad(`status が不正: ${op.status}`);
    if (op.op === "add") {
      if (typeof op.range !== "string" || !op.range.trim()) bad("range（文字列）が必要。例 明細!B2:D5 / 明細!* / *");
      if (typeof op.text !== "string" || !op.text.trim()) bad("text が必要");
      const kind = op.kind ?? (author === "human" ? "指示" : "確認");
      if (!KINDS.includes(kind)) bad(`kind が不正: ${kind}`);
      const status = op.status ?? (kind === "指示" ? "未対応" : "確認待ち");
      const msg: any = { author, text: op.text, at: nowIso() };
      if (typeof op.name === "string" && op.name) msg.name = op.name;
      const t = { id: nextThreadId(threads), range: op.range.trim(), kind, status, messages: [msg] };
      threads.push(t);
      changed = true;
      results.push({ ok: true, id: t.id });
    } else if (op.op === "reply") {
      const t = find();
      if (!t) { results.push({ ok: false, id: op.id, error: "unknown id" }); return; }
      if (typeof op.text !== "string" || !op.text.trim()) bad("text が必要");
      const msg: any = { author, text: op.text, at: nowIso() };
      if (typeof op.name === "string" && op.name) msg.name = op.name;
      t.messages.push(msg);
      // 人の返信は「エージェントの番」に戻す。エージェントの返信は status 指定が無ければ据え置き
      if (op.status) t.status = op.status;
      else if (author === "human") t.status = "未対応";
      changed = true;
      results.push({ ok: true, id: t.id, status: t.status });
    } else if (op.op === "status") {
      const t = find();
      if (!t) { results.push({ ok: false, id: op.id, error: "unknown id" }); return; }
      if (!op.status) bad("status が必要");
      if (t.status !== op.status) { t.status = op.status; changed = true; }
      results.push({ ok: true, id: t.id, status: t.status });
    } else if (op.op === "setRange") {
      const t = find();
      if (!t) { results.push({ ok: false, id: op.id, error: "unknown id" }); return; }
      if (typeof op.range !== "string") bad("range が必要");
      if (t.range !== op.range) { t.range = op.range; changed = true; }
      if (op.deleted !== undefined && !!op.deleted !== !!t.deleted) { if (op.deleted) t.deleted = true; else delete t.deleted; changed = true; }
      results.push({ ok: true, id: t.id });
    } else if (op.op === "delete") {
      const k = threads.findIndex((x) => x.id === op.id);
      if (k < 0) { results.push({ ok: false, id: op.id, error: "unknown id" }); return; }
      threads.splice(k, 1);
      changed = true;
      results.push({ ok: true, id: op.id });
    } else bad(`op が不明: ${op.op}（add / reply / status / setRange / delete）`);
  });
  return { results, changed };
}

function reviewPatch(e: Entry, j: any): any {
  if (!j || !Array.isArray(j.ops)) throw new HttpErr(400, "ops 配列が必要");
  return withLock(e.reviewFile, () => {
    const cur = readReview(e);
    const { results, changed } = applyThreadOps(cur.threads, j.ops);
    if (changed) { cur.rev += 1; writeAtomic(e.reviewFile, cur); }
    return { ok: true, rev: cur.rev, changed, results, review: cur, version: versionOf(e.reviewFile) };
  });
}

// ---------- シート操作 ----------
const CELL_PROPS = ["v", "bg", "color", "bold", "size", "align", "valign", "wrap", "numFmt"];
const sheetByName = (s: any, name: any, i: number): any => {
  const n = name ?? s.sheets[0].name;
  const sh = s.sheets.find((x: any) => x.name === n);
  if (!sh) throw new HttpErr(400, `ops[${i}]: シートが無い: ${n}`);
  return sh;
};
function cellKeys(sheetName: string, r: Rect): string[] {
  const n = (r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1);
  if (n > 2000) return ["s" + SEP + sheetName];
  const out: string[] = [];
  for (let rr = r.r1; rr <= r.r2; rr++) for (let cc = r.c1; cc <= r.c2; cc++) out.push(["c", sheetName, colName(cc) + rr].join(SEP));
  return out;
}
function setCellProps(sh: any, addr: string, op: any) {
  sh.cells = sh.cells ?? {};
  const c = sh.cells[addr] ?? {};
  for (const p of CELL_PROPS) {
    if (!(p in op)) continue;
    const v = op[p];
    if (v === null || v === undefined || (p === "v" && v === "") || (p !== "v" && v === false && p !== "bold" && p !== "wrap")) delete c[p];
    else if ((p === "bold" || p === "wrap") && v === false) delete c[p];
    else c[p] = v;
  }
  if (Object.keys(c).length) sh.cells[addr] = c; else delete sh.cells[addr];
}
function applyAxisToSheet(sh: any, axis: "row" | "col", kind: "ins" | "del", at: number, count: number) {
  const idx = (x: number): number | null => { const r = mapSpan(kind, at, count, x, x); return r ? r[0] : null; };
  const cells: any = {};
  for (const [k, v] of Object.entries<any>(sh.cells ?? {})) {
    const a = parseAddr(k);
    if (!a) { cells[k] = v; continue; }
    const n = idx(axis === "row" ? a.r : a.c);
    if (n === null) continue;
    cells[axis === "row" ? colName(a.c) + n : colName(n) + a.r] = v;
  }
  sh.cells = cells;
  const merges: string[] = [];
  for (const m of sh.merges ?? []) {
    const r = parseRect(m);
    if (!r) continue;
    const sp = axis === "row" ? mapSpan(kind, at, count, r.r1, r.r2) : mapSpan(kind, at, count, r.c1, r.c2);
    if (!sp) continue;
    const nr = axis === "row" ? { ...r, r1: sp[0], r2: sp[1] } : { ...r, c1: sp[0], c2: sp[1] };
    if (nr.r1 === nr.r2 && nr.c1 === nr.c2) continue;
    merges.push(rectText(nr));
  }
  if (sh.merges) sh.merges = merges;
  const dim = axis === "row" ? "rowHeights" : "colWidths";
  if (sh[dim]) {
    const nd: any = {};
    for (const [k, v] of Object.entries<any>(sh[dim])) {
      const x = axis === "row" ? Number(k) : colNum(k);
      const n = idx(x);
      if (n !== null) nd[axis === "row" ? String(n) : colName(n)] = v;
    }
    sh[dim] = nd;
  }
  if (sh.freeze) {
    const a = parseAddr(sh.freeze);
    if (a) {
      let f = axis === "row" ? a.r : a.c; // f 行目（列）より前が固定
      if (kind === "ins") { if (at < f) f += count; } else { const lo = at, hi = Math.min(at + count - 1, f - 1); if (hi >= lo) f -= hi - lo + 1; }
      const row = axis === "row" ? f : a.r, col = axis === "col" ? f : a.c;
      sh.freeze = row === 1 && col === 1 ? undefined : colName(col) + row;
      if (!sh.freeze) delete sh.freeze;
    }
  }
  const total = axis === "row" ? "rows" : "cols";
  if (Number.isInteger(sh[total])) sh[total] = Math.max(1, kind === "ins" ? sh[total] + count : sh[total] - count);
}
function sheetNameOk(n: any): boolean { return typeof n === "string" && n.length > 0 && n.length <= 31 && !/[\[\]:*?/\\]/.test(n); }
function axisIndex(v: any, axis: "row" | "col", i: number): number {
  const n = axis === "col" && typeof v === "string" ? colNum(v) : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpErr(400, `ops[${i}]: at は 1 以上の${axis === "col" ? "列（A または 1）" : "行番号"}`);
  return n;
}

function applyOps(s: any, ops: any[], keys: string[], effs: Eff[]) {
  ops.forEach((op, i) => {
    const bad = (msg: string): never => { throw new HttpErr(400, `ops[${i}]: ${msg}`); };
    if (!op || typeof op !== "object") bad("オブジェクトが必要");
    switch (op.op) {
      case "set": {
        // {op:"set", sheet?, cell:"B2", v?, bg?, color?, bold?, size?, align?, valign?, wrap?, numFmt?}。null でその属性を消す
        const sh = sheetByName(s, op.sheet, i);
        const a = parseAddr(String(op.cell ?? ""));
        if (!a) bad("cell は A1 形式");
        const addr = colName(a!.c) + a!.r;
        setCellProps(sh, addr, op);
        keys.push(["c", sh.name, addr].join(SEP));
        break;
      }
      case "format": {
        // {op:"format", sheet?, range:"B2:D5", bg?, color?, bold?, ...}。範囲の全セルに同じ属性（v も可）
        const sh = sheetByName(s, op.sheet, i);
        const r = parseRect(String(op.range ?? ""));
        if (!r) bad("range は A1:B2 形式");
        if ((r!.c2 - r!.c1 + 1) * (r!.r2 - r!.r1 + 1) > 20000) bad("範囲が大きすぎる（2 万セルまで）");
        for (let rr = r!.r1; rr <= r!.r2; rr++) for (let cc = r!.c1; cc <= r!.c2; cc++) setCellProps(sh, colName(cc) + rr, op);
        keys.push(...cellKeys(sh.name, r!));
        break;
      }
      case "merge": case "unmerge": {
        const sh = sheetByName(s, op.sheet, i);
        const r = parseRect(String(op.range ?? ""));
        if (!r) bad("range は A1:B2 形式");
        const hit = (m: string) => { const q = parseRect(m); return !!q && q.c1 <= r!.c2 && q.c2 >= r!.c1 && q.r1 <= r!.r2 && q.r2 >= r!.r1; };
        sh.merges = (sh.merges ?? []).filter((m: string) => !hit(m));
        if (op.op === "merge" && !(r!.c1 === r!.c2 && r!.r1 === r!.r2)) {
          sh.merges.push(rectText(r!));
          for (let rr = r!.r1; rr <= r!.r2; rr++) for (let cc = r!.c1; cc <= r!.c2; cc++) if (rr !== r!.r1 || cc !== r!.c1) if (sh.cells) delete sh.cells[colName(cc) + rr];
        }
        if (!sh.merges.length) delete sh.merges;
        keys.push(["m", sh.name].join(SEP), ...cellKeys(sh.name, r!));
        break;
      }
      case "freeze": {
        const sh = sheetByName(s, op.sheet, i);
        if (op.at === null || op.at === undefined || op.at === "") delete sh.freeze;
        else if (parseAddr(String(op.at))) sh.freeze = String(op.at).toUpperCase();
        else bad("at は A1 形式か null");
        keys.push(["f", sh.name].join(SEP));
        break;
      }
      case "colWidth": case "rowHeight": {
        const sh = sheetByName(s, op.sheet, i);
        const col = op.op === "colWidth";
        const k = col ? String(op.col ?? "").toUpperCase() : String(op.row ?? "");
        if (col ? !/^[A-Z]{1,3}$/.test(k) : !/^\d+$/.test(k)) bad(col ? "col は列記号" : "row は行番号");
        const dim = col ? "colWidths" : "rowHeights";
        sh[dim] = sh[dim] ?? {};
        if (op.px === null || op.px === undefined) delete sh[dim][k];
        else if (typeof op.px === "number" && op.px > 0) sh[dim][k] = op.px;
        else bad("px は正の数か null");
        keys.push([col ? "cw" : "rh", sh.name, k].join(SEP));
        break;
      }
      case "insertRows": case "deleteRows": case "insertCols": case "deleteCols": {
        const sh = sheetByName(s, op.sheet, i);
        const axis = op.op.endsWith("Rows") ? "row" : "col";
        const kind = op.op.startsWith("insert") ? "ins" : "del";
        const at = axisIndex(op.at, axis, i);
        const count = op.count === undefined ? 1 : Number(op.count);
        if (!Number.isInteger(count) || count < 1 || count > 1000) bad("count は 1〜1000");
        applyAxisToSheet(sh, axis, kind, at, count);
        effs.push({ type: "axis", sheet: sh.name, axis, kind, at, count });
        keys.push(["s", sh.name].join(SEP));
        break;
      }
      case "addSheet": {
        if (!sheetNameOk(op.name)) bad("name は 31 文字以内で [ ] : * ? / \\ を含めない");
        if (s.sheets.some((x: any) => x.name === op.name)) bad("シート名が重複: " + op.name);
        const sh: any = { name: op.name, rows: 20, cols: 8, cells: {} };
        const at = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, s.sheets.length)) : s.sheets.length;
        s.sheets.splice(at, 0, sh);
        keys.push(["s", op.name].join(SEP));
        break;
      }
      case "renameSheet": {
        const sh = sheetByName(s, op.from, i);
        if (!sheetNameOk(op.to)) bad("to は 31 文字以内で [ ] : * ? / \\ を含めない");
        if (s.sheets.some((x: any) => x.name === op.to)) bad("シート名が重複: " + op.to);
        const old = sh.name;
        sh.name = op.to;
        effs.push({ type: "rename", from: old, to: op.to });
        keys.push(["s", old].join(SEP), ["s", op.to].join(SEP));
        break;
      }
      case "deleteSheet": {
        const sh = sheetByName(s, op.name, i);
        if (s.sheets.length < 2) bad("最後の 1 枚は消せない");
        s.sheets.splice(s.sheets.indexOf(sh), 1);
        effs.push({ type: "deleteSheet", name: sh.name });
        keys.push(["s", sh.name].join(SEP));
        break;
      }
      case "moveSheet": {
        const sh = sheetByName(s, op.name, i);
        const from = s.sheets.indexOf(sh);
        s.sheets.splice(from, 1);
        s.sheets.splice(Math.max(0, Math.min(Number(op.index) || 0, s.sheets.length)), 0, sh);
        keys.push("*");
        break;
      }
      case "meta": {
        // {op:"meta", task?, title?, mode?}。タブ名のタスク名・表示名など
        s.meta = s.meta ?? {};
        for (const k of ["task", "title"]) if (k in op) { if (op[k]) s.meta[k] = String(op[k]); else delete s.meta[k]; }
        if ("mode" in op) { if (op.mode === "schema" || op.mode === "data") s.mode = op.mode; else bad("mode は schema か data"); }
        keys.push(["meta"].join(SEP));
        break;
      }
      default: bad(`op が不明: ${op.op}`);
    }
  });
}

function sheetPatch(e: Entry, j: any): { status: number; body: any } {
  if (!j || !Array.isArray(j.ops) || !j.ops.length) throw new HttpErr(400, "ops 配列（1 件以上）が必要");
  if (j.base_rev !== undefined && !(Number.isInteger(j.base_rev) && j.base_rev >= 0)) throw new HttpErr(400, "base_rev は 0 以上の整数");
  return withLock(e.sheetFile, () => {
    const cur = readJson(e.sheetFile);
    const curRev = revOf(cur);
    const next = structuredClone(cur);
    const keys: string[] = [];
    const effs: Eff[] = [];
    applyOps(next, j.ops, keys, effs);
    const err = validateSheet(next);
    if (err) throw new HttpErr(400, err);
    if (j.base_rev !== undefined && j.base_rev !== curRev) {
      const c = findConflicts(e.sheetFile, j.base_rev, curRev, keys);
      if (c.unknown) return { status: 409, body: { ok: false, conflict: true, rev: curRev, conflicts: [], error: "rev が古く、間の変更を追えない。GET /api/sheet で読み直して rev を取り直す" } };
      if (c.keys.length) {
        return { status: 409, body: { ok: false, conflict: true, rev: curRev, conflicts: c.keys.map((k) => k.split(SEP).slice(0, 3).join(" ")), error: "同じセル・構造が rev " + j.base_rev + " 以降に別の書き手に変更されている。読み直して再実行" } };
      }
    }
    next.rev = curRev + 1;
    writeAtomic(e.sheetFile, next);
    record(e.sheetFile, next.rev, keys);
    let reviewRev: number | undefined;
    if (effs.length) {
      reviewRev = withLock(e.reviewFile, () => {
        const rv = readReview(e);
        if (remapThreads(rv.threads, effs, () => next.sheets[0].name)) { rv.rev += 1; writeAtomic(e.reviewFile, rv); }
        return rv.rev;
      });
    }
    return { status: 200, body: { ok: true, rev: next.rev, merged: j.base_rev !== undefined && j.base_rev !== curRev, applied: j.ops.length, reviewRev } };
  });
}

// ---------- 全体保存（画面） ----------
function saveSheet(e: Entry, j: any): { status: number; body: any } {
  const err = validateSheet(j?.sheet);
  if (err) throw new HttpErr(400, err);
  return withLock(e.sheetFile, () => {
    const cur = fs.existsSync(e.sheetFile) ? readJson(e.sheetFile) : null;
    const curRev = revOf(cur);
    const curVer = versionOf(e.sheetFile);
    const staleRev = j.base_rev !== undefined && j.base_rev !== curRev;
    const staleVer = typeof j.base === "string" && j.base !== curVer;
    if (staleRev || staleVer) return { status: 409, body: { ok: false, conflict: true, version: curVer, rev: curRev, error: "ファイルが読み込み後に更新されています" } };
    const out = { ...j.sheet, rev: curRev + 1 };
    writeAtomic(e.sheetFile, out);
    record(e.sheetFile, out.rev, ["*"]);
    return { status: 200, body: { ok: true, path: e.sheetFile, count: out.sheets.length, version: versionOf(e.sheetFile), rev: out.rev } };
  });
}
function saveReview(e: Entry, j: any): { status: number; body: any } {
  const threads = Array.isArray(j?.threads) ? j.threads : Array.isArray(j?.items) ? j.items.map(fromLegacy) : null;
  const err = validateThreads(threads);
  if (err) throw new HttpErr(400, err);
  return withLock(e.reviewFile, () => {
    const cur = readReview(e);
    const curVer = versionOf(e.reviewFile);
    const staleRev = j.base_rev !== undefined && j.base_rev !== cur.rev;
    const staleVer = typeof j.base === "string" && j.base !== curVer;
    if (staleRev || staleVer) return { status: 409, body: { ok: false, conflict: true, version: curVer, rev: cur.rev, error: "ファイルが読み込み後に更新されています" } };
    const out = { sheet: path.basename(e.sheetFile), rev: cur.rev + 1, threads: threads.map(normThread) };
    writeAtomic(e.reviewFile, out);
    return { status: 200, body: { ok: true, path: e.reviewFile, count: out.threads.length, version: versionOf(e.reviewFile), rev: out.rev } };
  });
}


// ---------- 状態・HTML ----------
const taskOf = (e: Entry, sheet: any): string => e.task || sheet?.meta?.task || path.basename(path.dirname(e.sheetFile));
function fileState(e: Entry) {
  const sheet = readJson(e.sheetFile);
  const review = readReview(e);
  return {
    key: e.key, path: e.sheetFile, task: taskOf(e, sheet), title: sheet?.meta?.title || sheet?.title || path.basename(e.sheetFile),
    sheet, review,
    ver: { sheet: versionOf(e.sheetFile), review: versionOf(e.reviewFile) },
    rev: { sheet: revOf(sheet), review: review.rev },
  };
}
const safeStates = (list: Entry[] = entries) => list.flatMap((e) => { try { return [fileState(e)]; } catch (err) { console.error(`skip ${e.sheetFile}: ${err}`); return []; } });

// <script> 内に安全に埋め込むため < を逃がす
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").split(String.fromCharCode(0x2028)).join(" ").split(String.fromCharCode(0x2029)).join(" ");

function renderHtml(serverMode: boolean, list: Entry[] = entries): string {
  const tpl = fs.readFileSync(templatePath, "utf-8");
  const boot = { server: serverMode, hub: serverMode, task: taskArg ?? null, retentionDays, home: serverMode ? home : null, cleanup: serverMode ? lastCleanup : null, files: safeStates(list) };
  return tpl.replace("/*__BOOT__*/null", () => embed(boot));
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

// ---------- 登録（registry.json） ----------
let registry: Reg[] = [];
function loadRegistry() {
  try {
    const j = readJson(registryFile);
    registry = Array.isArray(j?.files) ? j.files.filter((x: any) => x && typeof x.path === "string" && x.path.endsWith(SUFFIX)) : [];
  } catch { registry = []; }
}
function saveRegistry() {
  fs.mkdirSync(home, { recursive: true });
  writeAtomic(registryFile, { version: 1, files: registry });
}
const defaultReviewOf = (sheetFile: string) => sheetFile.replace(/\.sheet\.json$/, "") + ".review.json";
function upsertReg(e: Entry) {
  let title = "";
  try { const s = readJson(e.sheetFile); title = s?.meta?.title || s?.title || ""; } catch { /* 読めなければ空 */ }
  let r = registry.find((x) => x.path === e.sheetFile);
  if (!r) { r = { path: e.sheetFile, registered_at: nowIso() }; registry.push(r); }
  if (e.task) r.task = e.task;
  if (title) r.title = title;
  if (e.reviewFile !== defaultReviewOf(e.sheetFile)) r.review = e.reviewFile; else delete r.review;
  saveRegistry();
}
const rescan = () => { for (const e of scanDirs()) upsertReg(e); };

const newSheet = (abs: string) => ({ title: path.basename(abs, SUFFIX), mode: "schema", rev: 0, sheets: [{ name: "シート1", rows: 20, cols: 8, cells: {} }] });
// ファイル / フォルダを登録する。create=true なら無い *.sheet.json を新規作成する（画面の「開く」）
function register(paths: string[], opt: { task?: string; review?: string; create?: boolean }): { keys: string[]; created: string[] } {
  const keys: string[] = [];
  const created: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(expand(String(p).trim()));
    if (!p || !String(p).trim()) throw new HttpErr(400, "パスが空です");
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      if (!watchDirs.includes(abs)) watchDirs.push(abs);
      scanDirs();
      const hit = entries.filter((e) => path.dirname(e.sheetFile) === abs);
      if (!hit.length) throw new HttpErr(400, "*.sheet.json がありません: " + abs);
      for (const e of hit) { if (opt.task) e.task = opt.task; upsertReg(e); keys.push(e.key); }
      continue;
    }
    if (!abs.endsWith(SUFFIX)) throw new HttpErr(400, "ファイル名は <名前>.sheet.json にしてください: " + abs);
    if (!fs.existsSync(abs)) {
      if (!opt.create) throw new HttpErr(400, "見つかりません: " + abs);
      if (!fs.existsSync(path.dirname(abs))) throw new HttpErr(400, "フォルダがありません: " + path.dirname(abs));
      fs.writeFileSync(abs, JSON.stringify(newSheet(abs), null, 2) + "\n");
      created.push(abs);
    }
    try { readJson(abs); } catch (err) { throw new HttpErr(400, "JSON を読めません: " + abs + " " + err); }
    const r = addSheetFile(abs, { task: opt.task, review: paths.length === 1 ? opt.review : undefined });
    upsertReg(r.entry);
    keys.push(r.entry.key);
  }
  return { keys, created };
}

// ---------- 整理（7 日使われていないファイルをごみ箱へ） ----------
const DAY = 86_400_000;
const LIVE_MS = 30_000;
const STAMP_RE = /^\d{8}-\d{6}(-\d+)?$/;
type CleanupResult = { at: string; moved: { path: string; task: string; id: string }[]; purged: number; skipped: string[] };
let lastCleanup: CleanupResult | null = null;
const clients = new Map<string, { t: number; open: string[]; dirty: string[] }>();
const logLine = (s: string) => { try { fs.mkdirSync(home, { recursive: true }); fs.appendFileSync(logFile, `${nowIso()} ${s}\n`); } catch { /* ログ失敗は無視 */ } };
function moveFile(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); } catch (err: any) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}
const p2 = (n: number) => String(n).padStart(2, "0");
function stampNow(): string {
  const d = new Date();
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}
// 開いているタブ（生きている画面からの heartbeat）と、?f= で今開こうとしているファイルは整理しない
function protectedSet(extra: string[]): Set<string> {
  const s = new Set<string>(extra);
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.t > LIVE_MS) { clients.delete(id); continue; }
    for (const p of c.open) s.add(p);
    for (const p of c.dirty) s.add(p);
  }
  return s;
}
type TrashItem = { n: number; path: string; task: string; title: string; sheet_file: string; review: string | null; review_file: string | null };
type Manifest = { at: string; items: TrashItem[] };
const readManifest = (stamp: string): Manifest | null => { try { return readJson(path.join(trashBase, stamp, "manifest.json")); } catch { return null; } };
function trashDirs(): string[] { try { return fs.readdirSync(trashBase).filter((n) => STAMP_RE.test(n)).sort(); } catch { return []; } }

function trashEntry(e: Entry, stamp: string): string {
  const dir = path.join(trashBase, stamp);
  fs.mkdirSync(dir, { recursive: true });
  const m: Manifest = readManifest(stamp) ?? { at: nowIso(), items: [] };
  const n = m.items.reduce((a, x) => Math.max(a, x.n), 0) + 1;
  const sub = path.join(dir, String(n));
  let sheetTask = "";
  let title = "";
  try { const s = readJson(e.sheetFile); sheetTask = taskOf(e, s); title = s?.meta?.title || s?.title || ""; } catch { sheetTask = e.task ?? ""; }
  const item: TrashItem = { n, path: e.sheetFile, task: sheetTask, title, sheet_file: path.basename(e.sheetFile), review: null, review_file: null };
  // review は「<名前>.review.json」の形のものだけ動かす（--review で変な名前を指していても、関係ないファイルには触れない）
  if (e.reviewFile.endsWith(".review.json") && e.reviewFile !== e.sheetFile && fs.existsSync(e.reviewFile)) {
    item.review = e.reviewFile;
    item.review_file = path.basename(e.reviewFile);
    moveFile(e.reviewFile, path.join(sub, item.review_file));
  }
  moveFile(e.sheetFile, path.join(sub, item.sheet_file));
  m.items.push(item);
  writeAtomic(path.join(dir, "manifest.json"), m);
  return `${stamp}/${n}`;
}

function runCleanup(extraProtected: string[]): CleanupResult | null {
  if (!cleanupEnabled) return null;
  const now = Date.now();
  const cutoff = now - retentionDays * DAY;
  const prot = protectedSet(extraProtected);
  const res: CleanupResult = { at: nowIso(), moved: [], purged: 0, skipped: [] };
  const stamp = stampNow();
  for (const e of [...entries]) {
    // 対象は registry に載っている *.sheet.json だけ
    if (!e.sheetFile.endsWith(SUFFIX) || !registry.some((r) => r.path === e.sheetFile)) continue;
    let sm = 0;
    try { sm = fs.statSync(e.sheetFile).mtimeMs; } catch { continue; } // 見つからないものは一覧に残す（自動では消さない）
    let rm = 0;
    try { rm = fs.statSync(e.reviewFile).mtimeMs; } catch { /* review 無し */ }
    const newest = Math.max(sm, rm);
    if (newest >= cutoff) continue;
    if (prot.has(e.sheetFile)) { res.skipped.push(e.sheetFile); logLine(`skip(open) ${e.sheetFile}`); continue; }
    try {
      const id = trashEntry(e, stamp);
      res.moved.push({ path: e.sheetFile, task: e.task ?? "", id });
      logLine(`trash ${e.sheetFile} (updated ${new Date(newest).toISOString()}) -> trash/${id}`);
      entries.splice(entries.indexOf(e), 1);
      registry = registry.filter((r) => r.path !== e.sheetFile);
      saveRegistry();
    } catch (err) {
      logLine(`error trash ${e.sheetFile}: ${err}`);
    }
  }
  // ごみ箱に入って retentionDays を超えたものは完全に削除
  for (const name of trashDirs()) {
    const m = readManifest(name);
    let at = m ? Date.parse(m.at) : NaN;
    if (!Number.isFinite(at)) { try { at = fs.statSync(path.join(trashBase, name)).mtimeMs; } catch { continue; } }
    if (at >= cutoff) continue;
    const target = path.resolve(trashBase, name);
    if (!target.startsWith(trashBase + path.sep)) continue;
    try { fs.rmSync(target, { recursive: true, force: true }); res.purged += 1; logLine(`purge trash/${name}`); } catch (err) { logLine(`error purge ${name}: ${err}`); }
  }
  lastCleanup = res;
  return res;
}

function trashList() {
  const out: { id: string; at: string; path: string; task: string; title: string }[] = [];
  for (const name of trashDirs()) {
    const m = readManifest(name);
    if (!m) continue;
    for (const it of m.items) out.push({ id: `${name}/${it.n}`, at: m.at, path: it.path, task: it.task, title: it.title });
  }
  return out.reverse();
}
function restoreTrash(id: string): { status: number; body: any } {
  const [stamp, ns] = String(id).split("/");
  const n = Number(ns);
  if (!STAMP_RE.test(stamp ?? "") || !Number.isInteger(n)) throw new HttpErr(400, "id が不正（<日時>/<番号>）");
  const m = readManifest(stamp);
  const it = m?.items.find((x) => x.n === n);
  if (!m || !it) throw new HttpErr(404, "ごみ箱に見つかりません: " + id);
  if (fs.existsSync(it.path)) throw new HttpErr(409, "元の場所に同名のファイルがあります: " + it.path);
  if (it.review && fs.existsSync(it.review)) throw new HttpErr(409, "元の場所に同名のファイルがあります: " + it.review);
  const sub = path.join(trashBase, stamp, String(n));
  moveFile(path.join(sub, it.sheet_file), it.path);
  if (it.review && it.review_file) moveFile(path.join(sub, it.review_file), it.review);
  m.items = m.items.filter((x) => x.n !== n);
  if (m.items.length) writeAtomic(path.join(trashBase, stamp, "manifest.json"), m);
  else fs.rmSync(path.join(trashBase, stamp), { recursive: true, force: true });
  try { fs.rmSync(sub, { recursive: true, force: true }); } catch { /* 残骸は無視 */ }
  // 戻した直後に再び整理されないよう、更新時刻を現在にする（もう一度 N 日の猶予）
  const nowD = new Date();
  for (const f of [it.path, it.review]) { if (f) { try { fs.utimesSync(f, nowD, nowD); } catch { /* 無ければ無視 */ } } }
  const r = register([it.path], { task: it.task || undefined, review: it.review && it.review !== defaultReviewOf(it.path) ? it.review : undefined });
  logLine(`restore trash/${id} -> ${it.path}`);
  return { status: 200, body: { ok: true, path: it.path, key: r.keys[0] } };
}

// ---------- 一覧 ----------
function listData() {
  rescan();
  const now = Date.now();
  const files = entries.map((e) => {
    const reg = registry.find((r) => r.path === e.sheetFile);
    const row: any = {
      key: e.key, path: e.sheetFile, name: path.basename(e.sheetFile), task: e.task || reg?.task || path.basename(path.dirname(e.sheetFile)),
      title: reg?.title || "", created: null, updated: null, unanswered: 0, state: "ok", registered_at: reg?.registered_at ?? null, expires_at: null,
    };
    let st: fs.Stats;
    try { st = fs.statSync(e.sheetFile); } catch { row.state = "missing"; return row; }
    let newest = st.mtimeMs;
    try { const rs = fs.statSync(e.reviewFile); newest = Math.max(newest, rs.mtimeMs); } catch { /* review 無し */ }
    row.updated = new Date(newest).toISOString();
    row.created = new Date(st.birthtimeMs || st.mtimeMs).toISOString();
    try {
      const s = readJson(e.sheetFile);
      row.task = e.task || s?.meta?.task || row.task;
      row.title = s?.meta?.title || s?.title || row.title;
      if (typeof s?.meta?.created === "string" && !Number.isNaN(Date.parse(s.meta.created))) row.created = new Date(s.meta.created).toISOString();
    } catch { row.state = "error"; }
    try { row.unanswered = readReview(e).threads.filter((t: any) => !t.deleted && t.status === "確認待ち").length; } catch { /* 読めなければ 0 */ }
    if (cleanupEnabled) row.expires_at = new Date(newest + retentionDays * DAY).toISOString();
    return row;
  });
  files.sort((a, b) => String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
  return { now: new Date(now).toISOString(), home, retentionDays, cleanupEnabled, cleanup: lastCleanup, trash: { dir: trashBase, items: trashList() }, files };
}

// ---------- HTTP ----------
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
// body を JSON として読み、fn の {status, body} を返す。HttpErr はそのステータスで返す
function jsonHandler(req: http.IncomingMessage, res: http.ServerResponse, fn: (j: any) => { status: number; body: any }) {
  readBody(req, (body) => {
    try {
      let j: any;
      try { j = JSON.parse(body); } catch (err) { throw new HttpErr(400, "JSON を読めません: " + err); }
      const r = fn(j);
      sendJson(res, r.status, r.body);
    } catch (err) {
      if (err instanceof HttpErr) sendJson(res, err.status, { ok: false, error: err.message, ...err.extra });
      else sendJson(res, 500, { ok: false, error: String(err) });
    }
  });
}

const startedAt = nowIso();
const NO_FILE_API = new Set(["/api/ping", "/api/version", "/api/files", "/api/list", "/api/register", "/api/open", "/api/registry/remove", "/api/trash/restore", "/api/heartbeat"]);

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
    const p = url.pathname;
    if (req.method === "GET" && p === "/api/ping") return sendJson(res, 200, { ok: true, app: "sheet-preview", version: 2, pid: process.pid, port, started_at: startedAt, home });
    const e = entryOf(url.searchParams.get("f"));
    if (req.method === "GET" && p === "/") {
      rescan();
      const want = url.searchParams.getAll("f").map((k) => entryOf(k)).filter((x): x is Entry => !!x);
      const wantPaths = want.map((x) => x.sheetFile);
      runCleanup(wantPaths); // 一覧を開いたときに整理する。今開こうとしているファイルは対象外
      return send(res, 200, "text/html", renderHtml(true, want.filter((x) => entries.includes(x))));
    }
    if (req.method === "GET" && p === "/api/list") return sendJson(res, 200, listData());
    if (req.method === "GET" && p === "/api/files") {
      rescan();
      const want = url.searchParams.getAll("f").map((k) => entryOf(k)).filter((x): x is Entry => !!x);
      return sendJson(res, 200, safeStates(url.searchParams.has("f") ? want : entries));
    }
    if (p.startsWith("/api/") && !NO_FILE_API.has(p) && !e) return sendJson(res, 404, { ok: false, error: "unknown file" });
    if (req.method === "GET" && p === "/api/file") return sendJson(res, 200, fileState(e!));
    if (req.method === "GET" && p === "/api/sheet") {
      res.setHeader("x-version", versionOf(e!.sheetFile));
      return sendJson(res, 200, readJson(e!.sheetFile));
    }
    if (req.method === "GET" && p === "/api/review") {
      res.setHeader("x-version", versionOf(e!.reviewFile));
      return sendJson(res, 200, readReview(e!));
    }
    if (req.method === "GET" && p === "/api/version") {
      const files: Record<string, any> = {};
      const asked = url.searchParams.getAll("f").map((k) => entryOf(k)).filter((x): x is Entry => !!x);
      for (const x of url.searchParams.has("f") ? asked : entries) {
        if (!fs.existsSync(x.sheetFile)) continue;
        let sr = 0, rr = 0;
        try { sr = revOf(readJson(x.sheetFile)); } catch { /* 書き込み途中などは 0 */ }
        try { rr = readReview(x).rev; } catch { /* 同上 */ }
        files[x.key] = { sheet: versionOf(x.sheetFile), review: versionOf(x.reviewFile), rev: { sheet: sr, review: rr } };
      }
      return sendJson(res, 200, { files });
    }
    if (req.method === "POST" && p === "/api/patch") return jsonHandler(req, res, (j) => sheetPatch(e!, j));
    if (req.method === "POST" && p === "/api/review/patch") return jsonHandler(req, res, (j) => ({ status: 200, body: reviewPatch(e!, j) }));
    if (req.method === "POST" && p === "/api/review") return jsonHandler(req, res, (j) => saveReview(e!, j));
    if (req.method === "POST" && p === "/api/sheet") return jsonHandler(req, res, (j) => saveSheet(e!, j));
    if (req.method === "POST" && (p === "/api/register" || p === "/api/open")) {
      return jsonHandler(req, res, (j) => {
        const paths: string[] = Array.isArray(j?.paths) ? j.paths.map(String) : j?.path !== undefined ? [String(j.path)] : [];
        if (!paths.length) throw new HttpErr(400, "paths（または path）が必要");
        const r = register(paths, { task: typeof j.task === "string" && j.task ? j.task : undefined, review: typeof j.review === "string" && j.review ? j.review : undefined, create: p === "/api/open" });
        return { status: 200, body: { ok: true, keys: r.keys, created: r.created.length > 0, createdPaths: r.created } };
      });
    }
    if (req.method === "POST" && p === "/api/registry/remove") {
      return jsonHandler(req, res, (j) => {
        const target = path.resolve(expand(String(j?.path ?? "")));
        const k = registry.findIndex((r) => r.path === target);
        if (k < 0) throw new HttpErr(404, "登録にありません: " + target);
        registry.splice(k, 1);
        const ei = entries.findIndex((x) => x.sheetFile === target);
        if (ei >= 0) entries.splice(ei, 1);
        saveRegistry();
        logLine(`unregister ${target}`);
        return { status: 200, body: { ok: true } };
      });
    }
    if (req.method === "POST" && p === "/api/trash/restore") return jsonHandler(req, res, (j) => restoreTrash(String(j?.id ?? "")));
    if (req.method === "POST" && p === "/api/heartbeat") {
      return jsonHandler(req, res, (j) => {
        const strs = (a: any): string[] => (Array.isArray(a) ? a.map(String).map((s) => (entryOf(s)?.sheetFile ?? s)) : []);
        if (typeof j?.client === "string" && j.client) clients.set(j.client, { t: Date.now(), open: strs(j.open), dirty: strs(j.dirty) });
        return { status: 200, body: { ok: true } };
      });
    }
    send(res, 404, "text/plain", "not found");
  } catch (err) {
    send(res, 500, "text/plain", String(err));
  }
});

// ---------- 起動（ハブ / クライアント / 停止 / 静的 HTML） ----------
const hubUrl = (p: number, keys: string[]) => `http://localhost:${p}/` + (keys.length ? "?" + keys.map((k) => "f=" + encodeURIComponent(k)).join("&") : "");
async function pingHub(p: number): Promise<any | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    return j?.app === "sheet-preview" ? j : null;
  } catch { return null; }
}
async function postJson(p: number, route: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://127.0.0.1:${p}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
// ハブが動いているとき: 新しいサーバは立てず、登録して URL を出して終わる
async function asClient(info: any) {
  const abs = inputs.map((i) => path.resolve(expand(i)));
  if (has("--no-cleanup") || flag("--retention-days")) console.error("注意: --no-cleanup / --retention-days は常駐ハブの起動時だけ有効（このハブには効かない）");
  if (!abs.length) {
    console.log(`sheet-preview: ${hubUrl(port, [])}`);
    console.log(`  ハブ起動済み（pid ${info.pid}）`);
    return;
  }
  const r = await postJson(port, "/api/register", { paths: abs, task: taskArg, review: reviewOverride && inputs.length === 1 ? path.resolve(reviewOverride) : undefined });
  if (r.status !== 200 || !r.json.ok) {
    console.error(`登録に失敗: ${r.json.error ?? r.status}`);
    process.exit(1);
  }
  console.log(`sheet-preview: ${hubUrl(port, r.json.keys)}`);
  console.log(`  ハブ起動済み（pid ${info.pid}）。新しいサーバは立てず登録だけした`);
  for (const k of r.json.keys) console.log(`  [${path.basename(k)}] ${k}`);
}

// --port 省略時は hub.json が指すポートのハブを優先する
async function resolveHubPort() {
  if (portArg !== undefined) return;
  try {
    const h = JSON.parse(fs.readFileSync(hubFile, "utf-8"));
    if (Number.isInteger(h?.port) && h.port !== port && (await pingHub(h.port))) port = h.port;
  } catch { /* hub.json 無し */ }
}
async function stopHub() {
  await resolveHubPort();
  const info = await pingHub(port);
  if (!info) {
    try { fs.unlinkSync(hubFile); } catch { /* 無い */ }
    console.log("ハブは起動していない");
    return;
  }
  process.kill(info.pid, "SIGTERM");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await pingHub(port))) { console.log(`ハブを止めた（pid ${info.pid}, port ${port}）`); return; }
  }
  console.error("止まらなかった。kill " + info.pid);
  process.exit(1);
}

function startHub() {
  fs.mkdirSync(home, { recursive: true });
  loadRegistry();
  for (const r of registry) addSheetFile(r.path, { task: r.task, review: r.review });
  const onListening = () => {
    try {
      fs.writeFileSync(hubFile, JSON.stringify({ pid: process.pid, port, started_at: startedAt, home }, null, 2) + "\n");
      const keys = inputs.length ? register(inputs, { task: taskArg, review: reviewOverride && inputs.length === 1 ? reviewOverride : undefined }).keys : [];
      console.log(`sheet-preview: ${hubUrl(port, keys)}`);
      console.log(`  ハブ起動（pid ${process.pid}, port ${port}, 登録 ${entries.length} 件, 状態 ${home}）`);
      console.log(`  整理: ${cleanupEnabled ? `${retentionDays} 日更新のないファイルを一覧を開いたときにごみ箱へ` : "停止中（--no-cleanup）"}`);
      for (const k of keys) console.log(`  [${path.basename(k)}] ${k}`);
    } catch (err) {
      console.error(err instanceof HttpErr ? err.message : String(err));
      server.close();
      try { fs.unlinkSync(hubFile); } catch { /* 無い */ }
      process.exit(2);
    }
  };
  server.on("error", async (err: any) => {
    if (err.code !== "EADDRINUSE") { console.error(String(err)); process.exit(1); }
    // 同時に 2 つ起動した場合: 先に取った側がハブ。こちらはクライアントになる
    for (let i = 0; i < 4; i++) {
      const info = await pingHub(port);
      if (info) { await asClient(info); process.exit(0); }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.error(`ポート ${port} は別のプロセスが使っている（sheet-preview ではない）。--port で別のポートを指定する`);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", onListening);
  const bye = () => {
    try { if (JSON.parse(fs.readFileSync(hubFile, "utf-8")).pid === process.pid) fs.unlinkSync(hubFile); } catch { /* 無い */ }
    process.exit(0);
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

if (renderOut) {
  if (!inputs.length) { console.error("--render にはファイルかフォルダが要る"); process.exit(2); }
  for (const inp of inputs) {
    const abs = path.resolve(expand(inp));
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { watchDirs.push(abs); continue; }
    addSheetFile(abs, { task: taskArg, review: reviewOverride && inputs.length === 1 ? reviewOverride : undefined });
  }
  scanDirs();
  if (!entries.length) { console.error("*.sheet.json が見つかりません"); process.exit(2); }
  fs.writeFileSync(path.resolve(renderOut), renderHtml(false));
  console.log(`wrote ${renderOut}（${entries.length} ファイル）`);
  process.exit(0);
}
if (has("--stop")) {
  await stopHub();
  process.exit(0);
}
await resolveHubPort();
{
  const info = await pingHub(port);
  if (info) await asClient(info);
  else startHub();
}
