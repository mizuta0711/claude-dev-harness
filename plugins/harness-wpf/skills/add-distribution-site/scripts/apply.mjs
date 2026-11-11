#!/usr/bin/env node
// add-distribution-site の雛形をプロジェクトへ写し、{{名前}} を値で置き換える。依存パッケージなし。
//
//   node apply.mjs --dest <プロジェクトのルート> --values <値の JSON ファイル> [--with-safety] [--dry-run]
//
// - 既にあるファイルは上書きしない（飛ばして一覧に出す）。web/ ごと既にあるなら何もせず止める
// - --with-safety: 任意のページ（消えるものと戻し方 = manual/safety.html）も置き、目次と入口に 1 行ずつ足す
// - 値の JSON は {"APP_NAME": "...", ...}。一覧に無い名前・空の値はエラーで止める
// - 置き換えた後に残った {{名前}} を一覧で出す（終了コード 1）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(SKILL_DIR, "templates");
const OPTIONAL = path.join(SKILL_DIR, "templates-optional");
const KEYS = [
  "APP_NAME", "TAGLINE", "PRICE_TERMS", "ACCENT_COLOR",
  "SITE_URL", "SITE_HOST", "SITE_SLUG",
  "UI_CSPROJ", "UI_PROJECT_DIR", "DOTNET_MAJOR", "VERSION", "TODAY",
  "GITHUB_REPO", "SERVER_REPO_DIR", "SERVER_USER",
];
const TEXT_EXT = new Set([".html", ".css", ".js", ".mjs", ".json", ".md", ".conf", ".svg"]);

const args = process.argv.slice(2);
let dest = null, valuesFile = null, withSafety = false, dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dest") dest = path.resolve(args[++i] ?? "");
  else if (args[i] === "--values") valuesFile = path.resolve(args[++i] ?? "");
  else if (args[i] === "--with-safety") withSafety = true;
  else if (args[i] === "--dry-run") dryRun = true;
  else { console.error(`不明な引数: ${args[i]}`); process.exit(2); }
}
if (!dest || !valuesFile) {
  console.error("使い方: node apply.mjs --dest <プロジェクトのルート> --values <値の JSON> [--with-safety] [--dry-run]");
  process.exit(2);
}

const values = JSON.parse(fs.readFileSync(valuesFile, "utf8").replace(/^﻿/, ""));
const problems = [];
for (const k of Object.keys(values)) if (!KEYS.includes(k)) problems.push(`知らない名前: ${k}`);
for (const k of KEYS) if (typeof values[k] !== "string" || values[k].trim() === "") problems.push(`値がありません: ${k}`);
if (values.SITE_URL && !/^https:\/\/[^/]+\/$/.test(values.SITE_URL)) problems.push(`SITE_URL は https:// で始まり / で終わるトップの URL にする: ${values.SITE_URL}`);
// add-installer と同じ規則（インストーラー名・インストール先のフォルダ名にも使うため）
if (values.APP_NAME && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(values.APP_NAME)) problems.push(`APP_NAME はファイル名に使う（インストーラー名）。英数字・- ・. だけにする（add-installer と同じ規則）: ${values.APP_NAME}`);
if (problems.length) { for (const p of problems) console.error(`[止めた] ${p}`); process.exit(2); }

if (fs.existsSync(path.join(dest, "web"))) {
  console.error("[止めた] web/ が既にあります。既存のサイトを上書きしないため、何もしません（差分を見て手で合わせる）");
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
// HTML へ入れる値は文字参照にする（キャッチコピーに " や & が入っても、属性と本文が壊れないように）
const escapeHtml = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fill = (t, html) => t.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in values ? (html ? escapeHtml(values[k]) : values[k]) : m));

const plan = walk(TEMPLATES).map((src) => ({ src, rel: path.relative(TEMPLATES, src) }));
if (withSafety) for (const src of walk(OPTIONAL)) plan.push({ src, rel: path.relative(OPTIONAL, src) });

const written = [], skipped = [], leftovers = [];
for (const { src, rel } of plan) {
  const to = path.join(dest, rel);
  if (fs.existsSync(to)) { skipped.push(rel); continue; }
  let buf = fs.readFileSync(src);
  if (TEXT_EXT.has(path.extname(src).toLowerCase())) {
    let t = fill(buf.toString("utf8"), path.extname(src).toLowerCase() === ".html");
    if (withSafety) t = addSafetyLinks(rel, t);
    for (const m of t.matchAll(/\{\{[A-Z0-9_]+\}\}/g)) leftovers.push(`${rel}  ${m[0]}`);
    buf = Buffer.from(t, "utf8");
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, buf);
  }
  written.push(rel);
}

// 任意のページを置くとき、目次（main.js）と入口（manual/index.html）に 1 行ずつ足す
function addSafetyLinks(rel, t) {
  const r = rel.split(path.sep).join("/");
  if (r === "web/assets/js/main.js") {
    const anchor = "      '<a href=\"' + m + 'install.html\">インストールと削除</a>' +\n";
    if (!t.includes(anchor)) throw new Error("main.js の目次に install.html の行が見つかりません");
    return t.replace(anchor, anchor + "      '<a href=\"' + m + 'safety.html\">消えるものと戻し方</a>' +\n");
  }
  if (r === "web/manual/index.html") {
    const anchor = "          <a href=\"faq.html\" class=\"feature-card\">";
    if (!t.includes(anchor)) throw new Error("manual/index.html に faq.html のカードが見つかりません");
    const card = "          <a href=\"safety.html\" class=\"feature-card\">\n" +
      "            <div class=\"feature-card-title\">消えるものと戻し方</div>\n" +
      "            <div class=\"feature-card-desc\">どの操作で何が・どこへ消えるか、元に戻せるか</div>\n" +
      "          </a>\n\n";
    return t.replace(anchor, card + anchor);
  }
  return t;
}

console.log(`${dryRun ? "[試し] " : ""}写した: ${written.length} ファイル`);
for (const r of written) console.log(`  + ${r.split(path.sep).join("/")}`);
if (skipped.length) {
  console.log(`既にあるので飛ばした: ${skipped.length} ファイル（中身を見て手で合わせる）`);
  for (const r of skipped) console.log(`  = ${r.split(path.sep).join("/")}`);
}
if (leftovers.length) {
  console.log(`置き換わっていない値: ${leftovers.length} 件`);
  for (const l of leftovers) console.log(`  ! ${l}`);
  process.exit(1);
}
