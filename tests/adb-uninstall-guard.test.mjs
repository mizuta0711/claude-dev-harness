import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const guard = require(
  path.join(ROOT, "plugins", "harness-android", "hooks", "scripts", "pre-adb-uninstall-guard.js")
);

const APP = "com.example.myapp";

// **見逃し（データが消える）は不可。誤検知（正常な操作が止まる）も不可**——
// 説明文やコミットメッセージに `adb uninstall` と書くのは日常であり、
// そこで鳴る安全弁は外される（R3 の教訓）。両方をここで固定する。

const ADB_HITS = [
  ["adb uninstall com.example.myapp", APP],
  ["adb -s emulator-5554 uninstall com.example.myapp", APP],
  ["adb -d uninstall com.example.myapp", APP],
  ["adb shell pm uninstall com.example.myapp", APP],
  ["adb shell pm uninstall --user 0 com.example.myapp", APP],
  ["adb shell cmd package uninstall com.example.myapp", APP],
  ["cd app && adb uninstall com.example.myapp", APP],
  ["adb uninstall com.example.other", "com.example.other"],
  ["/c/Users/x/Sdk/platform-tools/adb.exe uninstall com.example.myapp", APP],
];

const GRADLE_HITS = [
  ["./gradlew uninstallDebug", "uninstallDebug"],
  ["gradlew.bat uninstallRelease", "uninstallRelease"],
  [".\\gradlew.bat uninstallAll", "uninstallAll"],
  ["./gradlew --offline uninstallDebug", "uninstallDebug"],
];

// **止めてはいけないもの。** 引用符・ヒアドキュメント・コメントの中は「データ」であって命令ではない
const MISSES = [
  'echo "adb uninstall com.example.myapp"',
  "git commit -m 'docs: adb uninstall は使わない方針を追記'",
  "# adb uninstall com.example.myapp",
  "adb install -r app/build/outputs/apk/debug/app-debug.apk",
  "./gradlew installDebug",
  "adb shell pm list packages",
  "adb devices",
  "grep -rn uninstall docs/",
  "git commit -m \"$(cat <<'EOF'\nfix: adb uninstall を止めるフックを追加\nEOF\n)\"",
];

test("adb のアンインストールを検出し、パッケージ名を取り出せる", () => {
  for (const [cmd, pkg] of ADB_HITS) {
    const found = guard.uninstallIntents(cmd);
    assert.equal(found.length, 1, `検出できていない: ${cmd}`);
    assert.equal(found[0].kind, "adb", cmd);
    assert.equal(found[0].pkg, pkg, cmd);
    assert.equal(found[0].keepData, false, cmd);
  }
});

test("Gradle の uninstall タスクを検出する", () => {
  for (const [cmd, task] of GRADLE_HITS) {
    const found = guard.uninstallIntents(cmd);
    assert.equal(found.length, 1, `検出できていない: ${cmd}`);
    assert.equal(found[0].kind, "gradle", cmd);
    assert.equal(found[0].task, task, cmd);
  }
});

test("-k はデータを残すので keepData になる", () => {
  const found = guard.uninstallIntents("adb uninstall -k com.example.myapp");
  assert.equal(found.length, 1);
  assert.equal(found[0].keepData, true);
  assert.equal(found[0].pkg, APP);
});

test("引用符・コメント・ヒアドキュメントの中では反応しない", () => {
  for (const cmd of MISSES) {
    assert.deepEqual(guard.uninstallIntents(cmd), [], `誤検知: ${cmd}`);
  }
});

test("1つのコマンド列に複数あればすべて拾う", () => {
  const found = guard.uninstallIntents(
    "adb uninstall com.example.a; adb -s emu uninstall com.example.b"
  );
  assert.deepEqual(
    found.map((f) => f.pkg),
    ["com.example.a", "com.example.b"]
  );
});

test("executableName: パス・拡張子を吸収する", () => {
  assert.equal(guard.executableName("/usr/bin/adb"), "adb");
  assert.equal(guard.executableName("C:\\Android\\platform-tools\\adb.exe"), "adb");
  assert.equal(guard.executableName(".\\gradlew.bat"), "gradlew");
  assert.equal(guard.executableName("./gradlew"), "gradlew");
});
