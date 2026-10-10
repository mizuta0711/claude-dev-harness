import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "harness-nextjs", "hooks", "scripts", "pre-migrate-backup.js");
const hook = require(HOOK);

// ---------------------------------------------------------------------------
// 「実行しようとしているか」の判定
//
// このフックは **DB を書き換える前に止める**ためのものなので、
// 見逃し（バックアップなしで migrate が進む）も誤発火（関係ないコマンドで
// ダンプが走る）もどちらも実害がある。両方向のケースを置く。
// ---------------------------------------------------------------------------

test("実行そのものを拾う", () => {
  for (const cmd of [
    "npx prisma migrate deploy",
    "prisma migrate dev",
    "pnpm prisma migrate reset",
    "yarn prisma migrate resolve --applied 0_init",
    'DATABASE_URL="postgres://x" npx prisma migrate deploy',
    "echo start && npx prisma migrate dev --name init",
  ]) {
    assert.equal(hook.runsPrismaMigrate(cmd), true, cmd);
  }
});

test("DB を変えない呼び出しは対象外", () => {
  for (const cmd of ["npx prisma migrate status", "npx prisma migrate diff", "npx prisma migrate --help"]) {
    assert.equal(hook.runsPrismaMigrate(cmd), false, cmd);
  }
});

// ---------------------------------------------------------------------------
// H40: 引用符の中の `|` でコマンドを区切っていた（2026-09-29 に再現）
//
// `grep -n "a|prisma migrate|b" x.md` を実行と判定し、バックアップが走って
// `tools/dump.sql` が0件のダンプで上書きされた。**データであって実行ではない。**
// ---------------------------------------------------------------------------
test("H40: 引用符の中にある文字列では発火しない", () => {
  for (const cmd of [
    String.raw`grep -n "ask\|prisma migrate\|dotnet run" x.md`,
    'grep -n "a|prisma migrate|b" x.md',
    `echo 'npx prisma migrate deploy'`,
    'git commit -m "npx prisma migrate deploy を実行した"',
    ["cat <<'EOF' > note.md", "npx prisma migrate deploy", "EOF"].join("\n"),
  ]) {
    assert.equal(hook.runsPrismaMigrate(cmd), false, cmd);
  }
});

test("H40: 引用符を潰しても区切りと環境変数代入の形は壊れない", () => {
  const src = 'DATABASE_URL="a|b" npx prisma migrate deploy';
  const blanked = hook.blankQuoted(src);
  assert.equal(blanked.length, src.length, "長さを保つ");
  assert.equal(blanked, 'DATABASE_URL="   " npx prisma migrate deploy');
  assert.equal(hook.runsPrismaMigrate(src), true, "正規の手順は取りこぼさない");
});

// ---------------------------------------------------------------------------
// 見逃しは DB の破壊に直結する。**読めなかったら潰さない側へ倒す**
// （H40 の修正が持ち込んだ回帰。2026-10-03 の査読 中1 / 中2）
// ---------------------------------------------------------------------------
test("引用符が閉じていなければ潰さない（バックアップを素通りさせない）", () => {
  // bash の規則では閉じない形。潰すと以後が全部消え、本物の migrate を見落とす
  for (const cmd of [
    ["# don't forget", "npx prisma migrate deploy"].join("\n"),
    String.raw`echo \" ; npx prisma migrate deploy`,
    String.raw`cd "D:\w\"; npx prisma migrate deploy`,
  ]) {
    assert.equal(hook.blankQuoted(cmd), null, `潰さない: ${cmd}`);
    assert.equal(hook.runsPrismaMigrate(cmd), true, cmd);
  }
  // PowerShell として読めば引用符は閉じている。潰したうえで正しく拾う
  const ps = String.raw`cd "D:\w\"; npx prisma migrate deploy`;
  assert.notEqual(hook.blankQuoted(ps, "powershell"), null);
  assert.equal(hook.runsPrismaMigrate(ps, "powershell"), true);
});

test("PowerShell では `\` はエスケープではない", () => {
  const cmd = String.raw`cd "D:\w"; npx prisma migrate deploy`;
  assert.equal(hook.runsPrismaMigrate(cmd, "powershell"), true);
  assert.notEqual(hook.blankQuoted(cmd, "powershell"), null, "引用符は閉じている");
});

// ---------------------------------------------------------------------------
// AC1: datasource provider を見ずに ORDERED_TABLES の空を検査していた
//
// `export-to-sql.ts` は provider が sqlite なら DB ファイルのコピーで済ませ、
// `ORDERED_TABLES` を**読まない**。それでも空を検査していたため、
// **バックアップが使わない一覧を書かないと2回目以降の migrate が止まっていた。**
// ---------------------------------------------------------------------------

/** schema.prisma と export-to-sql.ts を置いた一時プロジェクトを作る */
function mkProject({ provider, orderedTables } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-migrate-"));
  if (provider !== undefined) {
    fs.mkdirSync(path.join(dir, "prisma"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "prisma", "schema.prisma"),
      [
        'generator client {',
        '  provider = "prisma-client-js"',
        "}",
        "",
        "datasource db {",
        `  provider = "${provider}"`,
        '  url      = env("DATABASE_URL")',
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tools", "export-to-sql.ts"),
    `const ORDERED_TABLES: string[] = [${(orderedTables || []).map((t) => `"${t}"`).join(", ")}];\n`,
    "utf-8",
  );
  return dir;
}

test("AC1: datasource ブロックの provider を読む（generator の provider と混ぜない）", () => {
  const dir = mkProject({ provider: "sqlite" });
  try {
    assert.equal(hook.readDatasourceProvider(dir), "sqlite");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const pg = mkProject({ provider: "postgresql" });
  try {
    assert.equal(hook.readDatasourceProvider(pg), "postgresql");
  } finally {
    fs.rmSync(pg, { recursive: true, force: true });
  }
  // schema が無い構成では判定しない（「読めない ＝ 非対応」とは扱わない）
  const none = mkProject({});
  try {
    assert.equal(hook.readDatasourceProvider(none), null);
  } finally {
    fs.rmSync(none, { recursive: true, force: true });
  }
});

test("AC1: sqlite では ORDERED_TABLES が空でも止めない", () => {
  const dir = mkProject({ provider: "sqlite", orderedTables: [] });
  try {
    const r = hook.backupTargetsConfigured(dir, "sqlite");
    assert.equal(r.ok, true);
    assert.equal(r.skipped, "sqlite");
    // 一覧の命名が違っても「判定できない」警告を出さない（読まない一覧なので）
    assert.equal(r.unknown, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AC1: postgresql では従来どおり空を検出して止める", () => {
  const dir = mkProject({ provider: "postgresql", orderedTables: [] });
  try {
    const r = hook.backupTargetsConfigured(dir, "postgresql");
    assert.equal(r.ok, false);
    assert.match(r.reason, /ORDERED_TABLES/);
    // 記入済みなら通る
    const filled = mkProject({ provider: "postgresql", orderedTables: ["user"] });
    try {
      assert.deepEqual(hook.backupTargetsConfigured(filled, "postgresql"), { ok: true });
    } finally {
      fs.rmSync(filled, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("AC1: provider を省略すると従来どおり検査する（判定不能のときの既定）", () => {
  const dir = mkProject({ orderedTables: [] });
  try {
    assert.equal(hook.backupTargetsConfigured(dir).ok, false);
    assert.equal(hook.backupTargetsConfigured(dir, null).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// フック本体（main）を通す
//
// 判定関数の単体テストでは**配線**が守られない。查読の指摘どおり、
// `backupTargetsConfigured(root, provider)` の第2引数を落としても単体テストは全部通る。
// ここでは実際に stdin へ payload を流してフックを起動する。
//
// **`npx tsx` は走らせない。** 適用済みマイグレーションが1つでもあり、かつ検査を
// 通過した場合だけバックアップが実行されるので、テストはその手前で止まる形
// （初回 migrate / 検査でブロック）だけを見る。
// ---------------------------------------------------------------------------

/**
 * `npx` の偽物を置く。**本物を走らせない。**
 *
 * フックはバックアップを `npx tsx tools/export-to-sql.ts` で実行する。テストから本物を
 * 呼ぶと、ネットワークとキャッシュに結果が左右される（実測: 1回 約2秒かかり、
 * 中身の無いスタブが「成功」になった）。終了コードを指定できる偽物を PATH の先頭に置く。
 *
 * \returns PATH に足すディレクトリ
 */
function fakeNpx(dir, exitCode) {
  const bin = path.join(dir, ".fakebin");
  fs.mkdirSync(bin, { recursive: true });
  // bash 用（CI の ubuntu）
  const sh = path.join(bin, "npx");
  fs.writeFileSync(sh, `#!/bin/sh\necho "fake npx $\\" >&2\nexit ${exitCode}\n`, "utf-8");
  fs.chmodSync(sh, 0o755);
  // cmd 用（Windows の execSync は cmd.exe 経由）
  fs.writeFileSync(
    path.join(bin, "npx.cmd"),
    `@echo off\r\necho fake npx %* 1>&2\r\nexit /b ${exitCode}\r\n`,
    "utf-8",
  );
  return bin;
}

/** 一時プロジェクトでフックを起動し、返った JSON を読む（**出力が1つであることも検査する**） */
function runHook(dir, command = "npx prisma migrate dev", { npxExit } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  if (npxExit !== undefined) env.PATH = fakeNpx(dir, npxExit) + path.delimiter + env.PATH;
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      cwd: dir,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    }),
    encoding: "utf-8",
    cwd: dir,
    env,
  });
  // **stdout は JSON オブジェクト1つでなければならない**（公式仕様）。
  // 2つ並ぶと Claude Code がパースできず、continue:false が無効化される。
  // JSON.parse はここで落ちる —— それがこの検査である
  return out.trim() ? JSON.parse(out) : {};
}

/** 適用済みマイグレーションを1つ置く（初回スキップに入らないようにする） */
function addMigration(dir) {
  fs.mkdirSync(path.join(dir, "prisma", "migrations", "0_init"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prisma", "migrations", "0_init", "migration.sql"), "-- x\n", "utf-8");
}

test("main: migrate でないコマンドでは何もしない", () => {
  const dir = mkProject({ provider: "postgresql", orderedTables: [] });
  try {
    addMigration(dir);
    assert.deepEqual(runHook(dir, "npm run build"), {});
    assert.deepEqual(runHook(dir, "npx prisma migrate status"), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main: postgresql で一覧が空ならブロックする", () => {
  const dir = mkProject({ provider: "postgresql", orderedTables: [] });
  try {
    addMigration(dir);
    const out = runHook(dir);
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /ORDERED_TABLES/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main: sqlite で一覧が空でもブロックしない（AC1 の配線）", () => {
  const dir = mkProject({ provider: "sqlite", orderedTables: [] });
  try {
    addMigration(dir);
    const out = runHook(dir, "npx prisma migrate dev", { npxExit: 0 });
    // ブロックしない。**ここで continue:false が返るなら provider の配線が落ちている**
    assert.notEqual(out.continue, false);
    assert.match(JSON.stringify(out), /backup completed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main: バックアップが失敗したら止める", () => {
  const dir = mkProject({ provider: "sqlite", orderedTables: [] });
  try {
    addMigration(dir);
    const out = runHook(dir, "npx prisma migrate dev", { npxExit: 1 });
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /backup failed/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main: 非対応 provider では一覧の記入を案内しない（誤誘導を避ける）", () => {
  const dir = mkProject({ provider: "mysql", orderedTables: [] });
  try {
    addMigration(dir);
    const out = runHook(dir);
    assert.equal(out.continue, false);
    assert.match(out.stopReason, /mysql/);
    assert.doesNotMatch(out.stopReason, /3点同期/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("main: 初回 migrate はスキップし、案内文を provider 別に出す", () => {
  const pg = mkProject({ provider: "postgresql", orderedTables: [] });
  try {
    // migrations が無い ＝ 初回。検査せずスキップする
    const out = runHook(pg);
    assert.notEqual(out.continue, false);
    const text = JSON.stringify(out);
    assert.match(text, /ORDERED_TABLES/);
  } finally {
    fs.rmSync(pg, { recursive: true, force: true });
  }
  const lite = mkProject({ provider: "sqlite", orderedTables: [] });
  try {
    const out = runHook(lite);
    assert.notEqual(out.continue, false);
    const text = JSON.stringify(out);
    assert.match(text, /sqlite/);
    assert.match(text, /記入は不要/);
  } finally {
    fs.rmSync(lite, { recursive: true, force: true });
  }
});

test("main: 一覧の命名が違えば警告して通す（黙って通さない）", () => {
  const dir = mkProject({ provider: "postgresql" });
  try {
    addMigration(dir);
    fs.writeFileSync(
      path.join(dir, "tools", "export-to-sql.ts"),
      "const somethingElse: string[] = [];\n",
      "utf-8",
    );
    const out = runHook(dir, "npx prisma migrate dev", { npxExit: 0 });
    assert.notEqual(out.continue, false);
    assert.match(JSON.stringify(out), /判定できませんでした/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ⚠️ **このケースで stdout に JSON が2つ出ていた**（警告 → バックアップ結果）。
// Claude Code は「stdout は JSON オブジェクトのみ」でパースするため、
// **continue:false が無効化され、バックアップ失敗で止まらなくなっていた。**
// 上の runHook の JSON.parse がこれを検出する。
test("main: 警告とブロックが重なっても出力は1つ（止まることが消えない）", () => {
  const dir = mkProject({ provider: "postgresql" });
  try {
    addMigration(dir);
    fs.writeFileSync(
      path.join(dir, "tools", "export-to-sql.ts"),
      "const somethingElse: string[] = [];\n",
      "utf-8",
    );
    const out = runHook(dir, "npx prisma migrate dev", { npxExit: 1 });
    assert.equal(out.continue, false, "警告があってもブロックは効く");
    assert.match(out.stopReason, /backup failed/i);
    assert.match(out.systemMessage || "", /判定できませんでした/, "警告も同じ1つに入る");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
