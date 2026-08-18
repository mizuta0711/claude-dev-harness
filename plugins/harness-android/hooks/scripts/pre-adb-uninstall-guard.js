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
 * | `adb shell pm clear <このアプリ>` / `adb shell cmd package clear <このアプリ>` | **deny**（アプリは残るが**データは全部消える**） |
 * | `./gradlew uninstallDebug` / `:app:uninstallDebug` / `uninstallAll` 等 | **deny**（対象は必ずこのプロジェクトのアプリ） |
 * | `adb uninstall -k <このアプリ>` | **警告のみ**（`-k` はデータとキャッシュを残す） |
 * | 別パッケージの `adb uninstall` | **警告のみ**（このプロジェクトの資産ではない） |
 * | `envOptions.applicationId` が無い | **警告のみ**（判定できないので止めない = fail-open） |
 *
 * ## 取りこぼしやすい書き方（H28・2026-08-19 の遡及査読で実測）
 *
 * **4件とも「テストが84件通っている状態」で素通りしていた。** テストのケースが
 * 実装が想定した形しか持っていなかったため、実装の穴がそのままテストの穴になっていた。
 *
 * | 書き方 | 直したこと |
 * |--------|-----------|
 * | `./gradlew :app:uninstallDebug` | タスク名は**最後の `:` 以降**で判定する（マルチモジュールの標準形。Android Studio の Gradle パネルが出す形でもある） |
 * | `adb shell "pm uninstall <pkg>"` | トークンから**引用符を剥がす**（複数語を渡すときの常套形） |
 * | `adb shell pm clear <pkg>` | このフックの目的は「**ローカルデータの全消去を止める**」であり、`pm clear` はまさにそれ。アプリが残るぶん**実行者が実害に気づきにくい** |
 * | `adb uninstall <pkg>.debug` | `applicationIdSuffix` は applicationId の**末尾に足される**ので、`<applicationId>.` で始まるものは自分のアプリとして扱う |
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

/**
 * トークンから引用符を剥がす。
 *
 * `scanCommands` は**引用符の内側を切らない**（`echo "adb uninstall x"` を拾わないため。R3）が、
 * その結果 `adb shell "pm uninstall x"` は `"pm` / `uninstall` / `x"` に割れる。
 * ここはすでに「コマンドである」と判定された断片の中なので、剥がしてよい。
 */
const unquote = (t) => String(t || "").replace(/^["']+/, "").replace(/["']+$/, "");

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
    const tokens = text.split(/\s+/).map(unquote).filter(Boolean);
    if (tokens.length === 0) continue;

    const exe = executableName(tokens[0]);

    // ---- Gradle のアンインストールタスク ----
    if (exe === "gradlew" || exe === "gradle") {
      // `:app:uninstallDebug` / `app:uninstallDebug` のようなモジュール修飾を剥がしてから見る。
      // **前方一致で書くと `:app:` 形を丸ごと見逃す**（H28）。
      const task = tokens
        .slice(1)
        .find((t) => !t.startsWith("-") && /^uninstall/i.test(t.split(":").pop()));
      if (task) found.push({ kind: "gradle", action: "uninstall", pkg: "", task, keepData: false, text });
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
    let action = "uninstall";
    if (rest[0] === "uninstall") {
      args = rest.slice(1);
    } else if (rest[0] === "shell") {
      // `adb shell pm uninstall ...` / `adb shell cmd package uninstall ...`
      // `pm clear` はアプリを残すが**データは全部消える**。このフックの目的そのもの（H28）
      const shell = rest.slice(1);
      const verb = shell[0] === "pm" ? shell[1] : shell[0] === "cmd" && shell[1] === "package" ? shell[2] : null;
      const skip = shell[0] === "pm" ? 2 : 3;
      if (verb === "uninstall" || verb === "clear") {
        action = verb;
        args = shell.slice(skip);
      }
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
      action,
      pkg: operands.length ? operands[operands.length - 1] : "",
      task: "",
      // `pm clear` に `-k` は無い。データは必ず消える
      keepData: action === "clear" ? false : keepData,
      text,
    });
  }

  return found;
}

/**
 * そのパッケージがこのプロジェクトのアプリか。
 *
 * **完全一致では足りない**（H28）。`applicationIdSuffix = ".debug"` は applicationId の
 * **末尾に足される**ので、端末に入るのは `<applicationId>.debug` になる。
 * 開発中に消したくなるのはまさにその debug ビルドで、完全一致だと素通りする。
 * 完全一致だけで判定していた頃は「**このプロジェクトのアプリではありません**」という
 * **積極的に誤った断定**を返していた。
 */
const isOurApp = (pkg, applicationId) =>
  !!applicationId && !!pkg && (pkg === applicationId || pkg.startsWith(`${applicationId}.`));

/** `pm clear` の理由本文（アプリは残るのでアンインストールとは案内が違う） */
function clearReason(target) {
  return [
    `${target} はアプリのローカルデータを全て消します`,
    "（DataStore / SharedPreferences / Room。**アプリ自体は残るので気づきにくい**）。",
    "",
    "アンインストールと実害は同じです。設定・下書き・キャッシュが初期化されます。",
    "",
    "本当に初期状態から試したい場合は、**ユーザーに確認を取ってから**実行してください。",
  ].join("\n");
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
    (i) => i.kind === "adb" && !i.keepData && isOurApp(i.pkg, applicationId)
  );
  if (ours) {
    const label = ours.action === "clear" ? `adb shell pm clear ${ours.pkg}` : `adb uninstall ${ours.pkg}`;
    lib.deny(
      `${label} を止めました（アプリのデータが消えます）`,
      ours.action === "clear" ? clearReason(label) : denyReason(label)
    );
    process.exit(0);
  }

  // 止めないが、見たことは伝える（黙って通さない = H16 の教訓）
  const notes = intents.map((i) => {
    if (i.keepData) return `${i.pkg || "(パッケージ不明)"}: -k 付きのためデータは残ります`;
    if (!applicationId)
      return `${i.pkg || "(パッケージ不明)"}: envOptions.applicationId が未設定のため、このアプリかどうか判定できません`;
    if (!i.pkg) return "パッケージ名を特定できませんでした（変数展開など）";
    return `${i.pkg}: このプロジェクトのアプリ（${applicationId}）でも、その派生（${applicationId}.*）でもありません`;
  });
  lib.notify(
    "PreToolUse",
    ["[android-guard] ⚠️ アンインストール操作を検知しました（止めていません）", ...notes].join("\n")
  );
}

if (require.main === module) main();

module.exports = { uninstallIntents, executableName, isOurApp };
