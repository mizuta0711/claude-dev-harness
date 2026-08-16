/**
 * PreToolUse フック: アプリのアンインストール（＝ローカルデータの全消去）を止める
 *
 * ## なぜ必要か
 *
 * Android のアンインストールは **DataStore / SharedPreferences / Room を丸ごと消す**。
 * アカウント設定・お気に入り・下書きなど、**再設定に時間がかかるものが全部消える**。
 * 開発中の入れ直しは上書きインストール（`adb install -r` / `./gradlew installDebug`）で
 * 足りるため、アンインストールは「必要なときだけ意図して行う操作」である。
 *
 * ## 何を見るか
 *
 * | コマンド | 扱い |
 * |---------|------|
 * | `adb uninstall <このアプリ>` | **deny** |
 * | `adb shell pm uninstall <このアプリ>` / `adb shell cmd package uninstall <このアプリ>` | **deny** |
 * | `./gradlew uninstallDebug` / `uninstallAll` 等 | **deny**（対象は必ずこのプロジェクトのアプリ） |
 * | `adb uninstall -k <このアプリ>` | **警告のみ**（`-k` はデータとキャッシュを残す） |
 * | 別パッケージの `adb uninstall` | **警告のみ**（このプロジェクトの資産ではない） |
 * | `envOptions.applicationId` が無い | **警告のみ**（判定できないので止めない = fail-open） |
 *
 * ## 判定は「コマンド位置」に限る（R3 の教訓）
 *
 * 素の正規表現だと、**「アンインストールしないこと」と説明する文やコミットメッセージに
 * `adb uninstall` と書いただけでブロックする**。鳴りすぎる安全弁は外される。
 * `plugin-lib.scanCommands()` が引用符・ヒアドキュメント・コメントを解釈して
 * コマンドの先頭だけを拾う。
 */
const lib = require("./plugin-lib.js");

/** 先頭の環境変数代入（`FOO=bar adb ...`）を落とす */
const stripEnvAssignments = (text) =>
  text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");

/** 実行ファイル名を取り出す（パス付き・拡張子付きを吸収する） */
function executableName(token) {
  const base = String(token || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
  return base.replace(/\.(exe|bat|cmd|sh)$/, "");
}

/** adb のグローバルオプション（サブコマンドより前に来るもの）。値を取るものは2トークン消費する */
const ADB_OPTS_WITH_VALUE = new Set(["-s", "-p", "-H", "-P", "-L", "-t"]);

/**
 * コマンド文字列から「アンインストールの意図」を抽出する。**純関数**（テスト対象）。
 *
 * @param {string} command
 * @returns {{kind:"adb"|"gradle", pkg:string, task:string, keepData:boolean, text:string}[]}
 */
function uninstallIntents(command) {
  const found = [];

  for (const seg of lib.scanCommands(command)) {
    const text = stripEnvAssignments(seg.text);
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const exe = executableName(tokens[0]);

    // ---- Gradle のアンインストールタスク ----
    if (exe === "gradlew" || exe === "gradle") {
      const task = tokens.slice(1).find((t) => /^uninstall/i.test(t));
      if (task) found.push({ kind: "gradle", pkg: "", task, keepData: false, text });
      continue;
    }

    if (exe !== "adb") continue;

    // ---- adb ----
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      i += ADB_OPTS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
    }
    const rest = tokens.slice(i);
    if (rest.length === 0) continue;

    let args = null;
    if (rest[0] === "uninstall") {
      args = rest.slice(1);
    } else if (rest[0] === "shell") {
      // `adb shell pm uninstall ...` / `adb shell cmd package uninstall ...`
      const shell = rest.slice(1);
      if (shell[0] === "pm" && shell[1] === "uninstall") args = shell.slice(2);
      else if (shell[0] === "cmd" && shell[1] === "package" && shell[2] === "uninstall")
        args = shell.slice(3);
    }
    if (!args) continue;

    // `-k` はデータとキャッシュを残す。`--user 0` のように値を取るオプションもある
    let keepData = false;
    const operands = [];
    for (let j = 0; j < args.length; j++) {
      const a = args[j];
      if (a === "-k") {
        keepData = true;
      } else if (a === "--user") {
        j++; // 値を飛ばす
      } else if (!a.startsWith("-")) {
        operands.push(a);
      }
    }
    found.push({
      kind: "adb",
      pkg: operands.length ? operands[operands.length - 1] : "",
      task: "",
      keepData,
      text,
    });
  }

  return found;
}

/** deny する理由の本文（コマンドの形に応じて言い分けない — 実害は同じ） */
function denyReason(target) {
  return [
    `${target} はアプリのローカルデータを全て消します`,
    "（DataStore / SharedPreferences / Room。設定・下書き・キャッシュが初期化されます）。",
    "",
    "更新するだけなら**上書きインストール**で足ります:",
    "  ./gradlew installDebug        （または adb install -r <apk>）",
    "",
    "本当にアンインストールが必要な場合（署名の変更・マイグレーション不能なスキーマ変更）は、",
    "**ユーザーに確認を取ってから**実行してください。データを残したいだけなら `adb uninstall -k` もあります。",
  ].join("\n");
}

function main() {
  const payload = lib.readPayload();
  if (!payload) process.exit(0);

  const command = payload?.tool_input?.command || "";
  const intents = uninstallIntents(command);
  if (intents.length === 0) process.exit(0);

  const { status, config } = lib.loadConfig();
  const applicationId =
    status === "ok" && typeof config?.envOptions?.applicationId === "string"
      ? config.envOptions.applicationId.trim()
      : "";

  // Gradle の uninstall タスクは対象が必ずこのプロジェクトのアプリなので、config を見ずに止める
  const gradle = intents.find((i) => i.kind === "gradle");
  if (gradle) {
    lib.deny(`${gradle.task} を止めました（アプリのデータが消えます）`, denyReason(gradle.task));
    process.exit(0);
  }

  const ours = intents.find(
    (i) => i.kind === "adb" && !i.keepData && applicationId && i.pkg === applicationId
  );
  if (ours) {
    lib.deny(
      `adb uninstall ${ours.pkg} を止めました（アプリのデータが消えます）`,
      denyReason(`adb uninstall ${ours.pkg}`)
    );
    process.exit(0);
  }

  // 止めないが、見たことは伝える（黙って通さない = H16 の教訓）
  const notes = intents.map((i) => {
    if (i.keepData) return `${i.pkg || "(パッケージ不明)"}: -k 付きのためデータは残ります`;
    if (!applicationId)
      return `${i.pkg || "(パッケージ不明)"}: envOptions.applicationId が未設定のため、このアプリかどうか判定できません`;
    if (!i.pkg) return "パッケージ名を特定できませんでした（変数展開など）";
    return `${i.pkg}: このプロジェクトのアプリ（${applicationId}）ではありません`;
  });
  lib.notify(
    "PreToolUse",
    ["[android-guard] ⚠️ アンインストール操作を検知しました（止めていません）", ...notes].join("\n")
  );
}

if (require.main === module) main();

module.exports = { uninstallIntents, executableName };
