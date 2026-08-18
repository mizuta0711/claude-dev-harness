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

  // ---- H28: 引用符でくくった形（複数語を渡すときの常套形）----
  // `scanCommands` は引用符の内側を切らないため `"pm` というトークンになる。
  // 剥がさないと `shell[0] === "pm"` に一致せず、**無反応で通っていた**。
  ['adb shell "pm uninstall com.example.myapp"', APP],
  ["adb shell 'pm uninstall com.example.myapp'", APP],
  ['adb shell "cmd package uninstall com.example.myapp"', APP],
  ['adb -s emulator-5554 shell "pm uninstall --user 0 com.example.myapp"', APP],

  // ---- H28: applicationIdSuffix 付き（判定は isOurApp が行う）----
  ["adb uninstall com.example.myapp.debug", "com.example.myapp.debug"],
];

// **`pm clear` はアプリを残すがデータは全部消える。** このフックの目的そのものなのに
// 見ていなかった（H28）。アンインストールと違い**実行者が実害に気づきにくい**。
const CLEAR_HITS = [
  ["adb shell pm clear com.example.myapp", APP],
  ["adb shell cmd package clear com.example.myapp", APP],
  ['adb shell "pm clear com.example.myapp"', APP],
  ["adb -d shell pm clear com.example.myapp", APP],
];

const GRADLE_HITS = [
  ["./gradlew uninstallDebug", "uninstallDebug"],
  ["gradlew.bat uninstallRelease", "uninstallRelease"],
  [".\\gradlew.bat uninstallAll", "uninstallAll"],
  ["./gradlew --offline uninstallDebug", "uninstallDebug"],

  // ---- H28: モジュール修飾形 ----
  // **マルチモジュールの標準形で、Android Studio の Gradle パネルが出す形。**
  // 前方一致（`/^uninstall/`）で書いていたため、これらは **deny も警告も出ずに素通り**していた。
  ["./gradlew :app:uninstallDebug", ":app:uninstallDebug"],
  ["./gradlew app:uninstallDebug", "app:uninstallDebug"],
  [".\\gradlew.bat :app:uninstallRelease", ":app:uninstallRelease"],
  ["gradle :feature:auth:uninstallDebug", ":feature:auth:uninstallDebug"],
  ["./gradlew --offline :app:uninstallAll", ":app:uninstallAll"],
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
  // モジュール修飾を剥がしても **install 系を uninstall と読み違えない**こと
  "./gradlew :app:installDebug",
  "./gradlew :app:assembleDebug",
  "adb shell pm path com.example.myapp",
  "adb shell pm list packages -3",
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

test("pm clear を検出する（アプリは残るがデータは全部消える）", () => {
  for (const [cmd, pkg] of CLEAR_HITS) {
    const found = guard.uninstallIntents(cmd);
    assert.equal(found.length, 1, `検出できていない: ${cmd}`);
    assert.equal(found[0].kind, "adb", cmd);
    assert.equal(found[0].action, "clear", cmd);
    assert.equal(found[0].pkg, pkg, cmd);
    // `pm clear` に `-k` は無い。データは必ず消える
    assert.equal(found[0].keepData, false, cmd);
  }
});

test("isOurApp: applicationIdSuffix 付きのビルドも自分のアプリとして扱う", () => {
  const APP_ID = "com.example.myapp";
  // 完全一致だけで判定していた頃は、debug ビルドに対して
  // 「このプロジェクトのアプリではありません」と**誤った断定**を返していた
  assert.equal(guard.isOurApp(APP_ID, APP_ID), true);
  assert.equal(guard.isOurApp(`${APP_ID}.debug`, APP_ID), true);
  assert.equal(guard.isOurApp(`${APP_ID}.staging.debug`, APP_ID), true);

  // 別アプリは巻き込まない
  assert.equal(guard.isOurApp("com.example.other", APP_ID), false);
  assert.equal(guard.isOurApp("com.example.myappx", APP_ID), false, "接頭辞が一致するだけの別アプリ");

  // 判定材料が無いときは false（fail-open。止めない）
  assert.equal(guard.isOurApp(APP_ID, ""), false);
  assert.equal(guard.isOurApp("", APP_ID), false);
});

test("executableName: パス・拡張子を吸収する", () => {
  assert.equal(guard.executableName("/usr/bin/adb"), "adb");
  assert.equal(guard.executableName("C:\\Android\\platform-tools\\adb.exe"), "adb");
  assert.equal(guard.executableName(".\\gradlew.bat"), "gradlew");
  assert.equal(guard.executableName("./gradlew"), "gradlew");
});
