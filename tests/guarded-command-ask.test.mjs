import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = require(path.join(ROOT, "plugins", "harness-core", "hooks", "scripts", "guarded-command-ask.js"));

const ALL = Object.keys(guard.GUARD_SETS);
const hit = (cmd, sets = ALL) => guard.findGuardHit(cmd, sets)?.name ?? null;

// 現行の permissions.ask（templates の付録・2026-10-02）が止めていたものは、すべて止める。
// 加えて、ask ルールが取りこぼしていた形（グローバルオプション・環境変数・複合コマンド）も止める。
const ASK = [
  ["git push", "git-destructive"],
  ["git push origin main", "git-destructive"],
  ["git reset --hard HEAD~1", "git-destructive"],
  ["git checkout -b feature/x", "git-destructive"],
  ["git clean -n", "git-destructive"],
  ["git -c core.pager=cat push", "git-destructive"],
  ["git -C ../other push", "git-destructive"],
  ["git --no-pager reset HEAD", "git-destructive"],
  ["cd /d/work && git push", "git-destructive"],
  ["git status; git push", "git-destructive"],
  ["npx prisma migrate dev --name init", "prisma-schema-change"],
  ["npx prisma migrate deploy", "prisma-schema-change"],
  ["npx prisma migrate reset --force", "prisma-schema-change"],
  ["npx prisma migrate resolve --applied 20260101", "prisma-schema-change"],
  ["npx prisma db push", "prisma-schema-change"],
  ["prisma migrate dev", "prisma-schema-change"],
  ['DATABASE_URL="file:./x.db" npx prisma migrate deploy', "prisma-schema-change"],
  ["cd app && pnpm exec prisma migrate deploy", "prisma-schema-change"],
  ["npm exec -- prisma db push", "prisma-schema-change"],
  // 査読 M1: Windows の `npx.cmd` と、パス指定の直接起動
  ["npx.cmd prisma migrate dev", "prisma-schema-change"],
  ["node_modules/.bin/prisma migrate dev", "prisma-schema-change"],
  ["./node_modules/.bin/prisma migrate deploy", "prisma-schema-change"],
  [".\\node_modules\\.bin\\prisma.cmd db push", "prisma-schema-change"],
  ["./gradlew installDebug", "android-device"],
  ["./gradlew uninstallDebug", "android-device"],
  ["./gradlew uninstallAll", "android-device"],
  ["./gradlew :app:installDebug", "android-device"],
  ["./gradlew clean installDebug", "android-device"],
  [".\\gradlew.bat installDebug", "android-device"],
  ["& .\\gradlew.bat uninstallDebug", "android-device"],
  ["adb install -r app-debug.apk", "android-device"],
  ["adb uninstall com.example.app", "android-device"],
  ["adb -s emulator-5554 install app.apk", "android-device"],
];

// 止めない。とくに「語が文字列に含まれるだけ」のもの（鳴りすぎる安全弁は外される・R3）
const PASS = [
  "git status",
  "git log --oneline -5",
  "git diff HEAD",
  "git commit -m 'git push は禁止'",
  'git commit -m "npx prisma migrate deploy を実行"',
  "echo git reset --hard",
  "grep -n \"a\\|prisma migrate deploy\\|b\" notes.md",
  "npx prisma migrate status",
  "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma",
  "npx prisma generate",
  "./gradlew assembleDebug",
  "./gradlew testDebugUnitTest",
  "adb devices",
  "adb shell pm list packages",
  "adb logcat -d",
  "gitk",
];

for (const [cmd, set] of ASK) {
  test(`止める: ${cmd}`, () => assert.equal(hit(cmd), set));
}
for (const cmd of PASS) {
  test(`止めない: ${cmd}`, () => assert.equal(hit(cmd), null));
}

test("ヒアドキュメントの本文は見ない", () => {
  const cmd = "git commit -F - <<'EOF'\ngit push --force\nEOF";
  assert.equal(hit(cmd), null);
});

test("有効にしていない集合では止めない", () => {
  assert.equal(hit("npx prisma migrate deploy", ["git-destructive"]), null);
  assert.equal(hit("adb install a.apk", ["git-destructive", "prisma-schema-change"]), null);
});

test("未知の集合名は無視する（typo で全体が壊れない）", () => {
  assert.equal(hit("git push", ["no-such-set", "git-destructive"]), "git-destructive");
});

// 査読 H1 / H2: askGuards が無い・config が読めないときに、環境の確認が黙って消えないこと
test("askGuards が無ければ git-destructive ＋ environment の既定を有効にする", () => {
  assert.deepEqual(guard.enabledSets({ schemaVersion: 1 }), ["git-destructive"]);
  assert.deepEqual(guard.enabledSets(null), ["git-destructive"]);
  assert.deepEqual(guard.enabledSets({ environment: "wpf" }), ["git-destructive"]);
  assert.deepEqual(guard.enabledSets({ environment: "nextjs" }), ["git-destructive", "prisma-schema-change"]);
  assert.deepEqual(guard.enabledSets({ environment: "android" }), ["git-destructive", "android-device"]);
  assert.deepEqual(guard.enabledSets({ askGuards: { sets: [] } }), []);
  assert.deepEqual(guard.enabledSets({ askGuards: { sets: ["android-device"] } }), ["android-device"]);
});

test("信頼済み環境: 環境変数", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ask-guard-"));
  try {
    assert.equal(guard.isTrustedEnv({}, home), false);
    assert.equal(guard.isTrustedEnv({ HARNESS_TRUSTED_ENV: "1" }, home), true);
    assert.equal(guard.isTrustedEnv({ HARNESS_TRUSTED_ENV: "0" }, home), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("信頼済み環境: ホームのマーカーファイル", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ask-guard-"));
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    assert.equal(guard.isTrustedEnv({}, home), false);
    fs.writeFileSync(path.join(home, ".claude", ".harness-trusted-env"), "VPS dev user\n");
    assert.equal(guard.isTrustedEnv({}, home), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// テンプレートの既定と、askGuards が無いときの環境の既定は一致させる（追従を見送っても同じ守りになる）
test("templates の askGuards.sets は、askGuards が無いときの既定と一致する", () => {
  const dir = path.join(ROOT, "templates");
  for (const env of fs.readdirSync(dir)) {
    const file = path.join(dir, env, ".claude", "harness.config.json");
    if (!fs.existsSync(file)) continue;
    const config = JSON.parse(fs.readFileSync(file, "utf-8"));
    const { askGuards, ...rest } = config;
    assert.deepEqual(guard.enabledSets(rest), askGuards.sets, env);
  }
});

// テンプレートの config が名指しする集合は、実装に存在しなければならない
test("templates の askGuards.sets は実装に存在する集合だけを使う", () => {
  const dir = path.join(ROOT, "templates");
  for (const env of fs.readdirSync(dir)) {
    const file = path.join(dir, env, ".claude", "harness.config.json");
    if (!fs.existsSync(file)) continue;
    const sets = JSON.parse(fs.readFileSync(file, "utf-8")).askGuards?.sets ?? [];
    for (const s of sets) assert.ok(ALL.includes(s), `${env}: 未知の集合 ${s}`);
  }
});

// ask をフックへ移したので、テンプレートの settings.json に ask が戻ってきたら気づけるようにする
test("templates の settings.json は permissions.ask を持たない（H46）", () => {
  const dir = path.join(ROOT, "templates");
  for (const env of fs.readdirSync(dir)) {
    const file = path.join(dir, env, ".claude", "settings.json");
    if (!fs.existsSync(file)) continue;
    const ask = JSON.parse(fs.readFileSync(file, "utf-8")).permissions?.ask;
    assert.ok(!ask || ask.length === 0, `${env}: permissions.ask が残っている（askGuards へ移す）`);
  }
});
