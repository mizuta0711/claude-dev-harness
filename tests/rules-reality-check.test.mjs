import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rc = await import(pathToFileURL(path.join(ROOT, "tools", "rules-reality-check.mjs")).href);

// `.claude/rules/` が実物と食い違っていないかを機械で見る（H27）。
//
// 移行指示書 §10-2 は「機械では検出できない」としていたが、**2つは検出できる**。
//   A. paths が1件も一致しない（規約が一度もロードされない。**静かに失敗する**）
//   B. 名指しした API が、ソースにも依存の宣言にも無い
//
// **実測で H27 の元の指摘を再現した** —— SimplePhone に当てると
// `hiltViewModel` と `collectAsStateWithLifecycle` が出る（H27 が査読で見つけた2件）。

function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-reality-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body ?? "", "utf-8");
  }
  return dir;
}

const rule = (globs, body) =>
  ["---", "paths:", ...globs.map((g) => `  - "${g}"`), "---", "", body, ""].join("\n");

// ---- glob ----

test("波括弧を展開する（テンプレートが配っている書き方）", () => {
  // **対応しないと `src/**` + `/*.{ts,tsx}` が1件も一致せず、
  // 「この規約は一度もロードされない」と誤報告する**（実測: engineer-potal で出た）。
  const re = rc.globToRegExp("src/**/*.{ts,tsx}");
  assert.ok(re.test("src/app/page.tsx"));
  assert.ok(re.test("src/lib/a.ts"));
  assert.ok(!re.test("src/a.css"));
});

test("`**` はディレクトリをまたぎ、`*` はまたがない", () => {
  assert.ok(rc.globToRegExp("app/src/main/**/ui/**").test("app/src/main/java/x/ui/Screen.kt"));
  assert.ok(!rc.globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(!rc.globToRegExp("src/**").test("other/a.ts"));
});

// ---- frontmatter ----

test("paths を読む", () => {
  const md = rule(["src/**", "app/**"], "本文");
  assert.deepEqual(rc.parsePaths(md), ["src/**", "app/**"]);
});

test("frontmatter が無ければ空", () => {
  assert.deepEqual(rc.parsePaths("# 見出しだけ"), []);
});

// ---- 識別子の拾い方（保守的であること） ----

test("呼び出しの形と注釈だけを拾う", () => {
  const md = "`hiltViewModel()` を使う。`@HiltViewModel` を付ける。";
  assert.deepEqual(rc.extractIdentifiers(md), ["@HiltViewModel", "hiltViewModel"]);
});

test("パス・コマンド・汎用語は拾わない（誤検出の元）", () => {
  const md = [
    "`src/lib/a.ts` に置く",
    "`npm run build` を実行する",
    "`docs/backlog.md` が正",
    "`return` しない",
    "`map()` を使う",
    "`if (x)` と書く",
  ].join("\n");
  assert.deepEqual(rc.extractIdentifiers(md), []);
});

test("短すぎる語は拾わない", () => {
  assert.deepEqual(rc.extractIdentifiers("`in()` を使う"), []);
});

// ---- 検査 A: paths が1件も一致しない ----

test("paths が1件も一致しなければ報告する（静かに失敗するため）", () => {
  const dir = mkProject({
    ".claude/rules/api.md": rule(["src/lib/services/**"], "規約"),
    "src/features/user/services/userService.ts": "export const x = 1;",
  });
  const r = rc.check(dir);
  assert.equal(r.applicable, true);
  assert.equal(r.pathsFindings.length, 1);
  assert.equal(r.pathsFindings[0].rule, "api.md");
});

test("1件でも一致すれば報告しない", () => {
  const dir = mkProject({
    ".claude/rules/api.md": rule(["src/lib/services/**", "src/features/**"], "規約"),
    "src/features/user/services/userService.ts": "export const x = 1;",
  });
  assert.deepEqual(rc.check(dir).pathsFindings, []);
});

// ---- 検査 B: 名指しした API が無い ----

test("ソースにも依存にも無い識別子を報告する（H27 の元の指摘）", () => {
  const dir = mkProject({
    ".claude/rules/compose-ui.md": rule(["src/**"], "`hiltViewModel()` で取得する"),
    "src/Screen.kt": "fun Screen() {}",
    "build.gradle.kts": "dependencies { implementation(\"androidx.compose.ui:ui\") }",
  });
  const r = rc.check(dir);
  assert.equal(r.apiFindings.length, 1);
  assert.deepEqual(r.apiFindings[0].names, ["hiltViewModel"]);
});

test("ソースに有れば報告しない", () => {
  const dir = mkProject({
    ".claude/rules/compose-ui.md": rule(["src/**"], "`hiltViewModel()` で取得する"),
    "src/Screen.kt": "val vm = hiltViewModel<MyViewModel>()",
  });
  assert.deepEqual(rc.check(dir).apiFindings, []);
});

test("依存の宣言に有れば報告しない（まだ使っていないだけ）", () => {
  const dir = mkProject({
    ".claude/rules/compose-ui.md": rule(["src/**"], "`hiltViewModel()` で取得する"),
    "src/Screen.kt": "fun Screen() {}",
    "build.gradle.kts": "implementation(\"androidx.hilt:hilt-navigation-compose\")\n// hiltViewModel",
  });
  assert.deepEqual(rc.check(dir).apiFindings, []);
});

test("ドット付きは最後の区切りでも照合する", () => {
  // `Modifier.imePadding` は実装側では `Modifier` に続けて `.imePadding` と書かれ、
  // **その文字列のままでは出てこない**ことがある（実測で誤検出した）。
  const dir = mkProject({
    ".claude/rules/compose-ui.md": rule(["src/**"], "`Modifier.imePadding()` を使う"),
    "src/Screen.kt": "Modifier\n  .imePadding()",
  });
  assert.deepEqual(rc.check(dir).apiFindings, []);
});

// ---- 判定できない場合 ----

test("rules が無ければ検査しない", () => {
  const dir = mkProject({ "src/a.ts": "export const x = 1;" });
  const r = rc.check(dir);
  assert.equal(r.applicable, false);
  assert.match(r.reason, /rules/);
});

test("ソースが1つも無ければ検査しない（未初期化）", () => {
  // H45 と同じ扱い。未初期化のプロジェクトで「全部一致しない」と言っても直せない。
  const dir = mkProject({ ".claude/rules/api.md": rule(["src/**"], "規約") });
  const r = rc.check(dir);
  assert.equal(r.applicable, false);
  assert.match(r.reason, /未初期化/);
});

// ---- 配っているテンプレート自身（鳴りすぎを押さえる） ----

test("テンプレートの rules 自身は、生成直後に paths で鳴らない", () => {
  // 生成直後のプロジェクトは**ソースが無い**ので `applicable: false` になる。
  // ここで確かめるのは「**paths の書き方が壊れていない**」こと —— 波括弧や
  // `{{MODULE_NAME}}` の置換前の形で正規表現が落ちないか。
  for (const env of fs.readdirSync(path.join(ROOT, "templates"))) {
    const dir = path.join(ROOT, "templates", env, ".claude", "rules");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const globs = rc.parsePaths(fs.readFileSync(path.join(dir, f), "utf-8"));
      for (const g of globs) {
        assert.doesNotThrow(() => rc.globToRegExp(g), `${env}/${f}: ${g}`);
      }
    }
  }
});
