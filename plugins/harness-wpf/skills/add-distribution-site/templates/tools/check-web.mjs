#!/usr/bin/env node
// 配布サイト（web/）と、アプリに同梱するマニュアル（Help/）の検査。依存パッケージなし（Node 標準だけ）。
//
//   node tools/check-web.mjs                      web/ を検査する
//   node tools/check-web.mjs --help-dir <path>    ビルド出力の Help/（manual/ と assets/ がある形）も検査する
//   node tools/check-web.mjs --strict-images      assets/img/site・screens の画像が無いことも指摘にする
//   node tools/check-web.mjs --dist <path>        最新版のインストーラー 2 つが <path> にあり、大きさと SHA-256 が
//                                                 downloads.json と合うかも見る（公開の前。publish-release.ps1 が呼ぶ）
//
// 検査:
//  (a) HTML の a href と、読み込み（src・link href・CSS の url()）を分けて、相対パスの先と #id の実在を見る
//  (b) manual/ と assets/ は外部の http(s) を読み込まない。a href の絶対 URL は ALLOWED_ABS だけ
//  (c) assets/js/main.js の目次に並ぶリンクも (a)(b) と同じに見る
//  (d) F1 の飛び先（HELP_TARGETS_FILE の "manual/...html(#id)" の文字列）と REQUIRED_PATHS のページ・節がある
//  (e) csproj の Version・downloads.json の latest・web/downloads/ のファイルが食い違わない
//  (f) --help-dir は (a)(b)(d) だけ
//  (g) 差し替え忘れの {{名前}} が無い。雛形の印（<!-- 雛形: -->）は警告（--dist のときは指摘）
// 結果は指摘の一覧と件数。指摘（エラー）があれば終了コード 1。警告だけなら 0。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ============================================================
// 設定（プロジェクトごとに変わる値はここだけ）
// ============================================================
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// インストーラーのファイル名の頭（add-installer と共有の決まり: <名前>-<版>-win-x64-setup.exe）
const APP_FILE_NAME = "{{APP_NAME}}";
// マニュアルの中で書いてよい絶対 URL（配布サイトのトップ 1 つだけ）
const ALLOWED_ABS = ["{{SITE_URL}}"];
// 版の元（<Version> を読む csproj。リポジトリからの相対）
const CSPROJ = "{{UI_CSPROJ}}";
// F1 の飛び先の表（"manual/...html" や "manual/...html#id" の文字列リテラルを拾う。リポジトリからの相対）
const HELP_TARGETS_FILE = "{{UI_PROJECT_DIR}}/Services/HelpTargets.cs";
// 飛び先の表とは別に、必ず要るページ（入口と、インストール完了画面が開く「はじめに」）
const REQUIRED_PATHS = ["manual/index.html", "manual/getting-started.html"];
// まだ撮っていない画像の置き場（無くても警告にとどめる。--strict-images で指摘にする）
const PENDING_IMAGE_DIRS = ["assets/img/site/", "assets/img/screens/"];
// ============================================================

// ---- 引数
const args = process.argv.slice(2);
let helpDir = null;
let strictImages = false;
let distDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help-dir") helpDir = path.resolve(args[++i] ?? "");
  else if (args[i] === "--strict-images") strictImages = true;
  else if (args[i] === "--dist") distDir = path.resolve(args[++i] ?? "");
  else if (args[i] === "-h" || args[i] === "--help") {
    console.log("使い方: node tools/check-web.mjs [--help-dir <path>] [--strict-images] [--dist <path>]");
    process.exit(0);
  } else {
    console.error(`不明な引数: ${args[i]}`);
    process.exit(2);
  }
}

const errors = [];
const warnings = [];
const rel = (p) => path.relative(REPO, p).split(path.sep).join("/");
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const addErr = (where, msg) => {
  const line = `${where}  ${msg}`;
  if (!errors.includes(line)) errors.push(line);
};
const addWarn = (where, msg) => {
  const line = `${where}  ${msg}`;
  if (!warnings.includes(line)) warnings.push(line);
};

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const t = fs.readFileSync(file, "utf8");
    const ids = new Set();
    for (const m of t.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
    idCache.set(file, ids);
  }
  return idCache.get(file);
}

const isExternal = (u) => /^(https?:)?\/\//i.test(u);
const isSkipped = (u) => /^(mailto:|tel:|javascript:|data:|blob:)/i.test(u);

// 1 つのリンク・読み込みを検査する。kind: "link"（a href）か "load"（src・link href・url()）
function checkRef(root, fromFile, text, idx, url, kind, ctx) {
  const where = `${rel(fromFile)}:${lineOf(text, idx)}`;
  if (url === "" || url === "#" || isSkipped(url)) return;

  if (isExternal(url)) {
    if (kind === "load") {
      addErr(where, `外部の読み込み: ${url}（CDN・Web フォント・外部画像は使わない）`);
    } else if (ctx.strictScope && !ALLOWED_ABS.includes(url)) {
      addErr(where, `許可していない絶対 URL: ${url}（許可: ${ALLOWED_ABS.join(", ")}）`);
    }
    return;
  }

  const [pathAndQuery, frag] = url.split("#");
  let pathPart;
  try {
    pathPart = decodeURIComponent(pathAndQuery.split("?")[0]);
  } catch {
    addErr(where, `URL の % の書き方が壊れています: ${url}`);
    return;
  }
  let target = pathPart === "" ? fromFile : path.resolve(path.dirname(fromFile), pathPart);
  if (pathPart.startsWith("/")) target = path.join(root, pathPart);
  if (pathPart.endsWith("/")) target = path.join(target, "index.html");

  const fromRoot = path.relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(".." + path.sep) || path.isAbsolute(fromRoot)) {
    addErr(where, `公開ルートの外を指しています: ${url}`);
    return;
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    const r = path.relative(root, target).split(path.sep).join("/");
    const pending = PENDING_IMAGE_DIRS.some((d) => r.startsWith(d));
    // --dist（公開の前）では、撮っていない画像も指摘にする（写真の無いページを公開しないため）
    if (pending && !strictImages && !distDir) addWarn(where, `画像が未配置（撮影前）: ${url}`);
    else if (pending) addErr(where, `画像が未配置（公開の前に撮る）: ${url}`);
    else addErr(where, `リンク切れ: ${url}`);
    return;
  }
  if (frag && path.extname(target).toLowerCase() === ".html" && !idsOf(target).has(frag)) {
    addErr(where, `#${frag} がありません: ${url}`);
  }
}

// ---- (a)(b)(g) HTML
function checkHtml(root, file) {
  const raw = fs.readFileSync(file, "utf8");
  for (const m of raw.matchAll(/<!--\s*雛形:/g)) {
    const where = `${rel(file)}:${lineOf(raw, m.index)}`;
    const msg = "雛形の印が残っています（例文か、まだ書いていない本文）";
    if (distDir) addErr(where, msg);
    else addWarn(where, msg);
  }
  const text = raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  const relToRoot = path.relative(root, file).split(path.sep).join("/");
  const ctx = { strictScope: relToRoot.startsWith("manual/") || relToRoot.startsWith("assets/") };
  for (const m of text.matchAll(/<(a|img|script|link|source|iframe|video|audio)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    const attrs = m[0];
    const get = (name) => {
      const mm = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
      return mm ? (mm[1] ?? mm[2]) : null;
    };
    const href = get("href");
    const src = get("src");
    if (tag === "a" && href !== null) checkRef(root, file, text, m.index, href, "link", ctx);
    if (tag === "link" && href !== null) checkRef(root, file, text, m.index, href, "load", ctx);
    if (src !== null) checkRef(root, file, text, m.index, src, "load", ctx);
  }
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    checkRef(root, file, text, m.index, m[1], "load", ctx);
  }
}

// ---- (a)(b) CSS
function checkCss(root, file) {
  const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const ctx = { strictScope: true };
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    if (m[1].startsWith("data:")) continue;
    checkRef(root, file, text, m.index, m[1], "load", ctx);
  }
  for (const m of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) {
    checkRef(root, file, text, m.index, m[1], "load", ctx);
  }
}

// ---- (b)(c) main.js（目次のリンク・外部読み込み）
function checkJs(root, file) {
  const text = fs.readFileSync(file, "utf8");
  const jsRel = path.relative(root, file).split(path.sep).join("/");
  // 目次: m + 'xxx.html'（m は manual/ までのプレフィックス）。manual/ からの相対として検査する
  const manualIndex = path.join(root, "manual", "index.html");
  if (fs.existsSync(manualIndex)) {
    for (const m of text.matchAll(/\bm\s*\+\s*'([^'"]+)["']/g)) {
      const where = `${jsRel}:${lineOf(text, m.index)}`;
      const url = m[1];
      const [p, frag] = url.split("#");
      const target = path.resolve(path.dirname(manualIndex), p);
      if (!fs.existsSync(target)) addErr(where, `目次のリンク切れ: ${url}`);
      else if (frag && !idsOf(target).has(frag)) addErr(where, `目次の #${frag} がありません: ${url}`);
    }
  }
  // 目次に直書きされた絶対 URL
  for (const m of text.matchAll(/href="(https?:\/\/[^"]+)"|href=\\?'(https?:\/\/[^'"\\]+)/g)) {
    const url = m[1] ?? m[2];
    if (!ALLOWED_ABS.includes(url)) addErr(`${jsRel}:${lineOf(text, m.index)}`, `許可していない絶対 URL: ${url}`);
  }
  // ほかの http(s):// 文字列（スクリプトによる外部読み込み）
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    if (ALLOWED_ABS.includes(m[0])) continue;
    if (/^https?:\/\/(www\.w3\.org)/.test(m[0])) continue; // XML の名前空間
    addErr(`${jsRel}:${lineOf(text, m.index)}`, `外部 URL: ${m[0]}`);
  }
}

// ---- (d) F1 の飛び先と、必ず要るページ
let helpTargetsCache = null;
function helpTargets() {
  if (helpTargetsCache) return helpTargetsCache;
  const file = path.join(REPO, HELP_TARGETS_FILE);
  if (!fs.existsSync(file)) {
    addWarn(HELP_TARGETS_FILE, "F1 の飛び先の表がありません（add-help-window の前なら正常）。飛び先の照合を飛ばします");
    helpTargetsCache = [];
    return helpTargetsCache;
  }
  const text = fs.readFileSync(file, "utf8");
  const found = new Set();
  for (const m of text.matchAll(/"(manual\/[^"#\s]+\.html(?:#[^"\s]+)?)"/g)) found.add(m[1]);
  if (found.size === 0) addWarn(HELP_TARGETS_FILE, '"manual/....html" の形の飛び先が 1 つも見つかりません');
  helpTargetsCache = [...found];
  return helpTargetsCache;
}

function checkRequired(root, label) {
  const targets = [...new Set([...REQUIRED_PATHS, ...helpTargets()])];
  for (const p of targets) {
    const [file, frag] = p.split("#");
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) {
      addErr(label, `必須のページがありません: ${p}`);
    } else if (frag && !idsOf(abs).has(frag)) {
      addErr(label, `必須の節がありません: ${p}`);
    }
  }
  return targets.length;
}

// ---- (g) 差し替え忘れの {{名前}}
function checkPlaceholders(root) {
  for (const f of walk(root, [".html", ".css", ".js", ".json", ".md", ".conf", ".svg"])) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/\{\{[A-Z0-9_]+\}\}/g)) {
      addErr(`${rel(f)}:${lineOf(text, m.index)}`, `差し替え忘れ: ${m[0]}`);
    }
  }
}

function checkTree(root, label) {
  const htmls = walk(root, [".html"]).filter((f) => !f.includes(`${path.sep}downloads${path.sep}`));
  for (const f of htmls) checkHtml(root, f);
  for (const f of walk(path.join(root, "assets"), [".css"])) checkCss(root, f);
  for (const f of walk(path.join(root, "assets"), [".js"])) checkJs(root, f);
  const n = checkRequired(root, label);
  return `HTML ${htmls.length} ページ・必須のパス ${n}`;
}

// ---- (e) 版
function checkVersion(webDir) {
  const csproj = path.join(REPO, CSPROJ);
  const jsonPath = path.join(webDir, "downloads.json");
  let csVersion = null;
  if (fs.existsSync(csproj)) {
    const m = fs.readFileSync(csproj, "utf8").match(/<Version>\s*([^<\s]+)\s*<\/Version>/);
    if (m) csVersion = m[1];
  } else {
    addWarn(CSPROJ, "csproj がありません（CSPROJ の設定を確かめる）");
  }
  if (fs.existsSync(csproj) && !csVersion) {
    addWarn(rel(csproj), "<Version> が未設定です（add-installer で足す）。版の照合は downloads.json の内部だけにします");
  }

  if (!fs.existsSync(jsonPath)) {
    addErr(rel(jsonPath), "downloads.json がありません");
    return;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(jsonPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    addErr(rel(jsonPath), `JSON を読めません: ${e.message}`);
    return;
  }
  const versions = data.versions ?? [];
  const latest = versions.find((v) => v.version === data.latest);
  if (!latest) {
    addErr(rel(jsonPath), `latest "${data.latest}" の行が versions にありません`);
    return;
  }
  if (csVersion && csVersion !== data.latest) {
    addErr(rel(jsonPath), `latest "${data.latest}" が csproj の Version "${csVersion}" と違います`);
  }
  const expect = {
    bundled: `${APP_FILE_NAME}-${latest.version}-win-x64-setup.exe`,
    noruntime: `${APP_FILE_NAME}-${latest.version}-win-x64-noruntime-setup.exe`,
  };
  for (const [kind, name] of Object.entries(expect)) {
    const f = (latest.files ?? []).find((x) => x.kind === kind);
    if (!f) addErr(rel(jsonPath), `最新版に kind "${kind}" の行がありません`);
    else if (f.name !== name) addErr(rel(jsonPath), `ファイル名 "${f.name}" が決まりの "${name}" と違います`);
  }

  if (distDir) checkLatestFiles(latest, distDir, "--dist のフォルダ");

  const dlDir = path.join(webDir, "downloads");
  const exes = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).filter((n) => n.toLowerCase().endsWith(".exe")) : [];
  if (exes.length === 0) return; // 開発機: csproj と downloads.json の 2 者だけ
  const listed = new Set(versions.flatMap((v) => (v.files ?? []).map((f) => f.name)));
  for (const n of exes) {
    if (!listed.has(n)) addErr(rel(path.join(dlDir, n)), "downloads.json に載っていないファイルです");
  }
  checkLatestFiles(latest, dlDir, "web/downloads/");
}

// 最新版のファイルが dir にあり、大きさと SHA-256 が downloads.json と合うか
function checkLatestFiles(latest, dir, label) {
  if (!fs.existsSync(dir)) {
    addErr(rel(dir), `${label}がありません`);
    return;
  }
  for (const f of latest.files ?? []) {
    const p = path.join(dir, f.name);
    if (!fs.existsSync(p)) {
      addErr(rel(p), `最新版のファイルが ${label} にありません`);
      continue;
    }
    if (!f.size || !f.sha256) addErr(rel(p), "downloads.json に大きさか SHA-256 がありません");
    if (f.size && fs.statSync(p).size !== f.size) addErr(rel(p), `大きさが downloads.json（${f.size}）と違います`);
    if (f.sha256) {
      const h = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      if (h.toLowerCase() !== f.sha256.toLowerCase()) addErr(rel(p), "SHA-256 が downloads.json と違います");
    }
  }
}

// ---- 実行
const webDir = path.join(REPO, "web");
const sections = [];
if (!fs.existsSync(webDir)) {
  console.error("web/ がありません");
  process.exit(2);
}
sections.push(`web/: ${checkTree(webDir, "web/")}`);
checkPlaceholders(webDir);
checkVersion(webDir);
if (helpDir) {
  if (!fs.existsSync(helpDir)) {
    addErr(helpDir, "--help-dir のフォルダがありません");
  } else {
    sections.push(`${helpDir}: ${checkTree(helpDir, helpDir)}`);
  }
}

console.log("check-web: " + sections.join(" / "));
for (const w of warnings) console.log(`[警告] ${w}`);
for (const e of errors) console.log(`[指摘] ${e}`);
console.log(`指摘 ${errors.length} 件 / 警告 ${warnings.length} 件`);
process.exit(errors.length ? 1 : 0);
