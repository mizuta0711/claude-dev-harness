import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = require(
  path.join(ROOT, "plugins", "harness-nextjs", "hooks", "scripts", "pre-migrate-backup.js")
);

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
