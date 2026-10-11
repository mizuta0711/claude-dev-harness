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
 * | config の JSON が壊れている | **全集合で止める**（H51）。`environment` も読めないので環境の既定が
 *   引けず、以前は `git-destructive` だけになっていた（nextjs の prisma・android の端末操作の確認が
 *   黙って消えた）。**取りこぼすより余分に確認する方を採る**（壊れている間だけの異常時なので、
 *   確認が増える代償は小さい）。`permissions.ask` 時代は config が壊れても確認が出ていたので、
 *   ここで素通りにすると黙って守りが消える |
 * | schemaVersion が無い・新しい | config は読めているので**環境の既定で止める**（下記） |
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
const prisma = require("./prisma-invocation");

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

/**
 * **`--` 以降はパス指定**なのでオプションとして読まない。
 *
 * `git clean -fd -- -n` の `-n` は「`-n` という名前のファイルを消す」指定であり、
 * dry-run ではない。**読み違えると、本当に消える形を通す**（査読の低・実測）。
 */
const optionsOf = (argv) => {
  const i = argv.indexOf("--");
  return i < 0 ? argv : argv.slice(0, i);
};

/**
 * 短いオプションの**束**（`-fdn` / `-bf`）に指定の文字が入っているか。
 *
 * **大文字小文字は区別する**（`git checkout -b` は新規作成だが `-B` は既存ブランチを動かす）。
 * **束を見ないと `git switch -fd` が素通りする**（査読の中・実測）。
 */
const hasShortFlag = (opts, ch) =>
  opts.some((t) => /^-[A-Za-z]+$/.test(t) && t.slice(1).includes(ch));

/**
 * 長いオプション。**git は一意なら省略形を受け付ける**ので前方一致で見る
 * （`git switch --disc` が `--discard-changes` として通る。査読の低・実測）。
 * `--opt=value` の形も名前だけで見る。
 */
const hasLongOpt = (opts, ...names) =>
  opts.some((t) => {
    if (!t.startsWith("--") || t.length < 4) return false;
    const name = t.split("=")[0];
    return names.some((n) => n.startsWith(name));
  });

/** `-f` / `--force` が付いているか（束も省略形も見る） */
const isForced = (opts) => hasShortFlag(opts, "f") || hasLongOpt(opts, "--force");

/**
 * `git` の呼び出しが、履歴や作業ツリーを**実際に**書き換え得る形か（H80 / H81）。
 *
 * ## 綴りの集合（H80）
 *
 * `git restore` / `git switch` は**新しい綴り**で、旧来の `git checkout` と同じことをする。
 * `permissionsベースライン.md` 自身が `git restore .` を「事故の形として最も起きやすい」と
 * 書いているのに、**新しい綴りだけが確認を抜けていた**（2026-10-11 実測）。
 *
 * **`switch` だけは「壊す形」に限る。** `switch` には**パス指定の形が無い**ので、
 * `git switch main` はブランチを移るだけで作業ツリーを捨てない。
 * 一方 `checkout` は `git checkout .` と `git checkout <branch>` を
 * **参照を解決しないと見分けられない**ため、素の形も確認にかけたままにする。
 *
 * ## 何も壊さない形は鳴らさない（H81）
 *
 * 鳴りすぎる安全弁は外される（R3）。しかも**同じリポジトリの中で判断が割れていた** ——
 * `pre-commit-scope` の案内文が「何が消えるかは `git clean -n` で確認できます」と勧め、
 * `pre-push-backlog-check` は `--dry-run` を「何も送らないので害が無い」として除外しているのに、
 * この集合は両方を止めていた。`git checkout -b` は**ハーネス自身のフロー**
 * （デフォルトブランチならまずブランチを切る）で毎回通る。
 *
 * ## 「壊さない形」は `-f` が付いたら壊す形に戻る
 *
 * **ここを見落とすと、除外がそのまま穴になる**（査読の中・実測）——
 * `git checkout -f -b x` は**新しいブランチを切る前に作業ツリーを捨てる**。
 * 除外は**常に `isForced` と組にして判定する**こと。
 *
 * @param {{sub: string, argv: string[]} | null} g `scope.parseGit` の結果
 */
function isDestructiveGit(g) {
  if (!g) return false;
  const opts = optionsOf(g.argv || []);
  switch (g.sub) {
    case "reset":
      // `--soft` / `--mixed` は作業ツリーを失わないが、**どれも参照を動かす**。
      // 履歴を書き換え得る操作なので一律で確認にかける（H81 の「壊さない形」には入れない）
      return true;
    case "restore":
      // **`--staged` だけならインデックスを戻すだけ**で作業ツリーに触れない（査読の中・実測）。
      // `--worktree` / `-W` が併記されていれば書き戻すので対象に戻す
      return !(
        (hasLongOpt(opts, "--staged") || hasShortFlag(opts, "S")) &&
        !(hasLongOpt(opts, "--worktree") || hasShortFlag(opts, "W"))
      );
    case "clean":
      // `-n` / `--dry-run` は何も消さない
      return !(hasLongOpt(opts, "--dry-run") || hasShortFlag(opts, "n"));
    case "push":
      // `--dry-run` / `-n` は何も送らない
      return !(hasLongOpt(opts, "--dry-run") || hasShortFlag(opts, "n"));
    case "checkout":
      // ブランチを作るだけの形（`-b` / `--orphan`）は何も壊さない。**ただし `-f` が付けば捨てる**。
      // `-B` は既存ブランチを動かすので対象のまま
      return !((hasShortFlag(opts, "b") || hasLongOpt(opts, "--orphan")) && !isForced(opts));
    case "switch":
      // 作業ツリーを捨てる形・既存ブランチを動かす形だけ
      return (
        isForced(opts) ||
        hasShortFlag(opts, "C") ||
        hasLongOpt(opts, "--discard-changes", "--force-create")
      );
    default:
      return false;
  }
}

const GUARD_SETS = {
  "git-destructive": {
    reason: "履歴や作業ツリーを書き換え得る git 操作です",
    // グローバルオプション（`-c k=v` / `-C dir` / `--no-pager`）が挟まる形も parseGit が吸収する。
    // **`opts` を渡し忘れない。** PowerShell の `git -C "D:\my proj\" push` を取りこぼす（H47）
    test: (seg, opts) => isDestructiveGit(scope.parseGit(seg, opts)),
  },
  "prisma-schema-change": {
    reason: "DB のスキーマやデータを変える prisma 操作です",
    // **起動形の判定は `prisma-invocation.js` に1箇所だけ置く**（H79）。
    // 以前はここと harness-nextjs の `pre-migrate-backup` が別々に判定していたため、
    // **確認は出るのにバックアップが走らない起動形が6つ**あった
    // （`npx.cmd` / `npx -y` / `pnpm exec` / `node_modules/.bin/` / `yarn dlx` / `db push`）。
    // `status` / `diff` は読み取りだけなので止めない（pre-migrate-backup と同じ線引き）。
    test: (seg) => prisma.changesSchema(seg.text),
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
  // JSON が壊れていると `lib.loadConfig` は config:null を返す。`environment` が読めず
  // 環境の既定を引けないので、**全集合で止める**（H51）。config 不在は main が先に素通りさせる
  if (!config) return Object.keys(GUARD_SETS);
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

  // 全集合で止めているときは、その理由を言う（でなければ wpf で prisma の確認が出た理由が分からない）
  const brokenNote = config
    ? ""
    : `
⚠️ ${lib.toPosix(lib.CONFIG_RELATIVE_PATH)} の JSON が壊れているため、環境の既定が引けません。` +
      `取りこぼしを避けるため「全集合」で確認しています。config を直すと元の集合に戻ります。`;

  lib.emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason:
        `${found.reason}: \`${found.hit}\`\n` +
        `（harness の askGuards「${found.name}」。信頼済み環境 = ~/.claude/.harness-trusted-env がある環境では確認なしで通ります）` +
        brokenNote,
    },
  });
}

if (require.main === module) main();

module.exports = {
  GUARD_SETS,
  DEFAULT_SETS,
  ENV_DEFAULT_SETS,
  isTrustedEnv,
  enabledSets,
  findGuardHit,
  isDestructiveGit,
};
