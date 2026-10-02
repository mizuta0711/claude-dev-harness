#!/usr/bin/env node
/**
 * PreToolUse フック: 危険な操作を、信頼済み環境でなければ確認にかける（H46）
 *
 * ## なぜ `permissions.ask` ではなくフックなのか
 *
 * `permissions.ask` は**マシン別に無効化できない**。ルール種別の優先順位 deny > ask > allow は
 * 層をまたいで絶対で、上位層の `allow` でも、フックが返す `permissionDecision:"allow"` でも
 * 打ち消せない（2026-10-02・Claude Code 2.1.270 で実測）。
 *
 * 一方、**フックが返す `permissionDecision:"ask"` は bypassPermissions / auto を貫通して止まる**
 * （同日実測。`permissionDecisionReason` の文面が画面に出る）。
 * よって「止めるか否か」の判断をフック側に置き、マシンごとに出し分ける:
 *
 * | 環境 | 挙動 |
 * |------|------|
 * | 信頼済み環境（下記のマーカーがある） | **素通り**（bypass なら無確認で実行される） |
 * | それ以外 | **`ask` を返す**（bypass でも確認が出る） |
 *
 * 信頼済み環境の例: 権限を絞った専用ユーザーで動かす VPS。サブエージェントの中で確認に
 * 止まると自動化が丸ごと止まり、かつ事故の影響範囲が小さい。
 *
 * ## 信頼済み環境マーカー
 *
 * - `~/.claude/.harness-trusted-env` が**ある**（中身は問わない。置いた理由を書いておくとよい）
 * - または環境変数 `HARNESS_TRUSTED_ENV=1`
 *
 * **ホームしか見ない。** リポジトリ内に同名ファイルがあっても効かないので、
 * マーカーをコミットして全マシンが無確認になる事故は起きない。
 *
 * ## 何を止めるか
 *
 * `harness.config.json` の `askGuards.sets` で、下の `GUARD_SETS` から選ぶ。
 * **判定パターンは config に書かせない**（`permissionsベースライン.md` §3）。
 *
 * | 状況 | 挙動 |
 * |------|------|
 * | config が無い | **素通り**（harness-core は user スコープでも入るので、
 *   ハーネス未導入のリポジトリで止め始めないため） |
 * | config が壊れている・schemaVersion が新しい | **環境の既定で止める**（下記）。`permissions.ask` 時代は
 *   config が壊れても確認が出ていたので、ここで素通りにすると黙って守りが消える |
 * | config はあるが `askGuards` が無い | **環境の既定**: `git-destructive` ＋ `environment` に応じた集合。
 *   `harness-update` は settings.json の ask 削除を自動で当てる一方、config への `askGuards` 追加は
 *   提案どまりなので、追加を見送っても nextjs / android の確認が消えないようにする |
 *
 * ## 判定はコマンド位置に限る（R3）
 *
 * `git-scope.scanCommands()` で、引用符・コメント・ヒアドキュメントの外にある
 * **コマンドの先頭**だけを見る。`git commit -m "git push は禁止"` では止めない。
 *
 * deny（force push / `rm -r*` / `.env` 等）はこのフックより手前で効くので、影響しない。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./harness-lib");
const scope = require("./git-scope");

const MARKER_RELATIVE_PATH = path.join(".claude", ".harness-trusted-env");
const DEFAULT_SETS = ["git-destructive"];
/** `askGuards` が無いときに `environment` から足す集合（テンプレートの既定と同じ） */
const ENV_DEFAULT_SETS = {
  nextjs: ["prisma-schema-change"],
  android: ["android-device"],
};

/** 先頭の環境変数代入（`DATABASE_URL="..." npx ...`）を剥がす */
const stripEnvPrefix = (text) =>
  text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");

/** gradle に渡されたタスクのうち、ここに挙げたもの（`:app:installDebug` は最後の `:` 以降で見る） */
const GRADLE_DEVICE_TASKS = new Set(["installDebug", "uninstallDebug", "uninstallAll"]);

const GUARD_SETS = {
  "git-destructive": {
    reason: "履歴や作業ツリーを書き換え得る git 操作です",
    // グローバルオプション（`-c k=v` / `-C dir` / `--no-pager`）が挟まる形も parseGit が吸収する。
    // **`opts` を渡し忘れない。** PowerShell の `git -C "D:\my proj\" push` を取りこぼす（H47）
    test: (seg, opts) => {
      const g = scope.parseGit(seg, opts);
      return !!g && ["push", "reset", "checkout", "clean"].includes(g.sub);
    },
  },
  "prisma-schema-change": {
    reason: "DB のスキーマやデータを変える prisma 操作です",
    // `status` / `diff` は読み取りだけなので止めない（pre-migrate-backup と同じ線引き）
    test: (seg) =>
      // `npx.cmd`（Windows）や `node_modules/.bin/prisma` のようなパス指定の起動も拾う
      /^(?:(?:npx|bunx|pnpx)(?:\.cmd)?\s+(?:-\S+\s+)*|(?:pnpm|yarn|bun)(?:\.cmd)?\s+(?:exec\s+|dlx\s+)?|npm(?:\.cmd)?\s+exec\s+(?:--\s+)?)?(?:\S*[\\/])?prisma(?:\.cmd|\.exe)?\s+(?:migrate\s+(?:dev|deploy|reset|resolve)|db\s+push)\b/.test(
        stripEnvPrefix(seg.text)
      ),
  },
  "android-device": {
    reason: "実機・エミュレータのアプリを入れ替える操作です",
    test: (seg) => {
      const t = stripEnvPrefix(seg.text);
      const gradle = /^(?:\.[\\/])?gradlew(?:\.bat)?\s+([\s\S]*)$/i.exec(t);
      if (gradle) {
        return gradle[1]
          .split(/\s+/)
          .some((tok) => GRADLE_DEVICE_TASKS.has(tok.split(":").pop()));
      }
      // adb のグローバルオプション（`-s <serial>` 等）が挟まる形も拾う
      return /^adb(?:\.exe)?(?:\s+(?:-[stHPL]\s+\S+|-[ade]))*\s+(?:install|uninstall)\b/i.test(t);
    },
  },
};

/**
 * 信頼済み環境か。
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
function isTrustedEnv(env = process.env, home = os.homedir()) {
  if (env.HARNESS_TRUSTED_ENV === "1") return true;
  try {
    return fs.existsSync(path.join(home, MARKER_RELATIVE_PATH));
  } catch {
    return false;
  }
}

/** config から有効な集合名を決める（`askGuards` が無ければ環境の既定） */
function enabledSets(config) {
  const sets = config?.askGuards?.sets;
  if (Array.isArray(sets)) return sets;
  return [...DEFAULT_SETS, ...(ENV_DEFAULT_SETS[config?.environment] || [])];
}

/**
 * 最初に一致したガードを返す。
 * @param {{shell?: "bash"|"powershell"}} [opts] シェルの方言（H47 ②）
 * @returns {{name: string, reason: string, hit: string} | null}
 */
function findGuardHit(command, sets, opts) {
  const segments = scope.scanCommands(command, opts);
  for (const name of sets) {
    const guard = GUARD_SETS[name];
    if (!guard) continue;
    const seg = segments.find((s) => guard.test(s, opts));
    if (seg) return { name, reason: guard.reason, hit: seg.text };
  }
  return null;
}

function main() {
  const payload = lib.readPayload();
  if (!payload) lib.passThrough();

  const command = lib.toolCommand(payload);
  if (!command) lib.passThrough();
  if (isTrustedEnv()) lib.passThrough();

  const { status, config } = lib.loadConfig();
  if (status === "missing") lib.passThrough();

  const found = findGuardHit(command, enabledSets(config), { shell: lib.toolShell(payload) });
  if (!found) lib.passThrough();

  lib.emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        `${found.reason}: \`${found.hit}\`\n` +
        `（harness の askGuards「${found.name}」。信頼済み環境 = ~/.claude/.harness-trusted-env がある環境では確認なしで通ります）`,
    },
  });
}

if (require.main === module) main();

module.exports = { GUARD_SETS, DEFAULT_SETS, ENV_DEFAULT_SETS, isTrustedEnv, enabledSets, findGuardHit };
