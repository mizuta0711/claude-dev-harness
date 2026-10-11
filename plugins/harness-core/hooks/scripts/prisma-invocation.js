/**
 * prisma の起動形の判定（H79）
 *
 * ## なぜ 1 ファイルを 2 箇所に置くのか
 *
 * `prisma` を止めるかどうかは**2つのフックが別々に判定していた**。
 *
 * | フック | プラグイン | 役目 |
 * |---|---|---|
 * | `guarded-command-ask`（`prisma-schema-change`） | harness-core | **確認にかける** |
 * | `pre-migrate-backup` | harness-nextjs | **実行前に DB をバックアップする** |
 *
 * `docs/reference/permissionsベースライン.md` 5-4 は、prisma を deny せず
 * 「**ask ＋ バックアップ**」の二段構えで守ると決めている。ところが判定が別々だったため、
 * **確認は出るのにバックアップが走らない起動形**が6つあった（2026-10-11 実測）——
 * `npx.cmd` / `npx -y` / `pnpm exec` / `node_modules/.bin/` / `yarn dlx` / `db push`。
 * **利用者は確認ダイアログを見て承認するので、守られていると思う。**
 *
 * **プラグインをまたいで require はできない**（`${CLAUDE_PLUGIN_ROOT}` はプラグインごとに違う。
 * `plugin-lib.js` が core の `harness-lib.js` を複製しているのと同じ事情）。
 * そこで**このファイル自体を両プラグインへ同内容で置き**、
 * `tests/prisma-invocation.test.mjs` が**2つの複製の一致**と
 * **ask ⇒ backup の対**を同じコマンド表で検査する。**片方だけ直したら落ちる。**
 *
 * ## 広さは意図的に非対称
 *
 * - **ask（`changesSchema`）は狭い。** 名指しした操作だけを止める。鳴りすぎる安全弁は外される（R3）
 * - **backup（`requiresBackup`）は広い。** 読み取りだけと分かっているもの以外は走らせる。
 *   見逃しは DB の破壊に直結するので、「拾えなければ余計に走る」側へ倒す
 *
 * **ask ⊆ backup を保つこと。** 確認が出たのにバックアップが走らない形は、H79 の再発である。
 */

/** 先頭の環境変数代入（`DATABASE_URL="..." npx ...`）を剥がす */
const ENV_ASSIGN_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/**
 * prisma の起動形。**ここが H79 の本体**なので、増やすときはこの1箇所だけを触る。
 *
 * - `npx` / `bunx` / `pnpx` ＋ **オプション**（`npx -y` / `npx --no-install`）
 * - `npm|pnpm|yarn|bun` の `exec` / `dlx` / `x` / `run`（`npm exec -- prisma` / `bun x` /
 *   `npm run prisma -- …`）。**間にオプションが挟まる形も拾う**（`pnpm --filter web exec prisma`）
 * - **版の指定**（`npx prisma@5.0.0` / `prisma@latest`。実務で最も起きやすい形）
 * - `pnpm|yarn|bun prisma`（パッケージマネージャが直接引く形）
 * - **パス指定の直接起動**（`node_modules/.bin/prisma` / `.\node_modules\.bin\prisma.cmd`）
 * - Windows の拡張子（`.cmd` / `.exe`）
 *
 * **ラッパーと導入部は `stripWrappers` が先に剥がす**（`sudo npx prisma …` / `(npx prisma …)` /
 * PowerShell の `& npx prisma …`）。`git-scope` が git について同じことをしている（H70）。
 */
const PRISMA_LAUNCH =
  /^(?:(?:npx|bunx|pnpx)(?:\.cmd|\.exe)?\s+(?:-\S+\s+)*|(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:\S+\s+)*?(?:exec|dlx|x|run)\s+(?:--\s+)?|(?:pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+)?(?:\S*[\\/])?prisma(?:@\S+)?(?:\.cmd|\.exe)?(?:\s+([\s\S]*))?$/;

/**
 * コマンドの前に付く導入部（`(` / `&` / `!` / 空白）。
 *
 * PowerShell の呼び出し演算子（`& npx prisma …`）やサブシェル（`(npx prisma …)`）が付くと、
 * **先頭一致が外れて素通りする**（査読の中1。**確認は出るのにバックアップが走らない** H79 と同型で、
 * ask 側は `scanCommands` が導入部を吸収するのに backup 側は吸収しなかった）。
 */
const COMMAND_INTRODUCER = /^[\s(&!]+/;

/**
 * 実行を包むコマンド。**`git-scope` が git について同じことをしている**（H70）。
 * `sudo` の付け忘れ・付け足しは実際に起こるので、拾わないと事故の形で素通りする。
 */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "time",
  "timeout",
  "nice",
  "setsid",
  "cross-env",
  "dotenv",
]);

/** ラッパーが取るオプション・環境変数代入・待ち時間・`--` を剥がす */
const WRAPPER_ARGS =
  /^(?:(?:-{1,2}\S+(?:\s+(?![-\s])\S+)?|[A-Za-z_][A-Za-z0-9_]*=\S*|\d+(?:\.\d+)?[smhd]?)\s+)*(?:--\s+)?/;

/** 入れ子のラッパーを追う上限（`sudo env FOO=1 npx …`） */
const MAX_WRAPPER_DEPTH = 4;

/** 導入部・ラッパー・先頭の環境変数代入を剥がして、**実際に動くコマンド**を返す */
function stripWrappers(text) {
  let t = String(text || "").replace(COMMAND_INTRODUCER, "").trim().replace(ENV_ASSIGN_PREFIX, "");
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth++) {
    const m = /^(\S+)\s+([\s\S]*)$/.exec(t);
    if (!m) break;
    const name = m[1].split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "");
    if (!WRAPPERS.has(name)) break;
    t = m[2].replace(WRAPPER_ARGS, "").replace(ENV_ASSIGN_PREFIX, "");
  }
  return t;
}

/**
 * prisma が**次のトークンを値として取る**オプション。
 *
 * **これを知らないと、値をサブコマンドと取り違える。** 逆に「`-` で始まる次のトークンを
 * 無条件に飛ばす」ようにすると、`prisma --verbose migrate deploy` の `migrate` を飛ばして
 * **真偽値フラグひとつで判定が外れる**（査読の中3・実測）。
 */
const PRISMA_VALUE_OPTS = new Set([
  "--schema",
  "--config",
  "--url",
  "--name",
  "--applied",
  "--rolled-back",
  "--file",
  "--from-url",
  "--to-url",
  "--from-schema-datamodel",
  "--to-schema-datamodel",
  "--from-schema-datasource",
  "--to-schema-datasource",
  "--from-migrations",
  "--to-migrations",
]);

/** `migrate` のうち、**スキーマやデータを変える**サブコマンド（ask の対象） */
const SCHEMA_MIGRATE_SUBCOMMANDS = new Set(["dev", "deploy", "reset", "resolve"]);

/**
 * `migrate` のうち、**読み取りだけ**のサブコマンド（backup の除外）。
 *
 * `resolve` は `_prisma_migrations` を書き換えるため**含めない**。
 */
const READ_ONLY_MIGRATE_SUBCOMMANDS = new Set(["status", "diff"]);

/**
 * prisma に渡された引数列を返す。
 *
 * @param {string} text コマンド断片（引用符の中身は呼び出し側が潰しておく）
 * @returns {string[] | null} prisma の起動でなければ null
 */
function prismaArgs(text) {
  const m = PRISMA_LAUNCH.exec(stripWrappers(text));
  if (!m) return null;
  return (m[1] || "").trim().split(/\s+/).filter(Boolean);
}

/**
 * 操作（`migrate dev` / `db push`）を取り出す。
 *
 * **値を取るオプションの値をサブコマンドと取り違えない**（`prisma --schema ./x migrate dev`）。
 * `--help` / `-h` は何も実行しないので null を返す。
 *
 * @returns {{group: string, sub: string} | null}
 */
function prismaOp(text) {
  const args = prismaArgs(text);
  if (!args) return null;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      // ヘルプは何も実行しない。**値の位置にある `-h` は値として飛ばす**（`--name -h`。査読の低5）
      if (arg === "-h" || arg === "--help") return null;
      if (PRISMA_VALUE_OPTS.has(arg)) i++;
      continue;
    }
    // **リダイレクトや区切りが付いたまま比較しない**（`migrate dev>out.txt` の `dev`。査読の低4）
    if (words.length < 2) words.push((/^[A-Za-z][\w:-]*/.exec(arg) || [""])[0]);
  }
  return { group: words[0] || "", sub: words[1] || "" };
}

/**
 * **確認にかける**か（ask。狭い側）。
 *
 * `migrate status` / `diff` は読み取りだけなので止めない。
 */
function changesSchema(text) {
  const op = prismaOp(text);
  if (!op) return false;
  if (op.group === "migrate") return SCHEMA_MIGRATE_SUBCOMMANDS.has(op.sub);
  return op.group === "db" && op.sub === "push";
}

/**
 * **バックアップを走らせる**か（backup。広い側）。
 *
 * `migrate` は**読み取りだけと分かっているもの以外すべて**。
 * サブコマンドが無い形（`prisma migrate`）も含める —— 取りこぼすより余分に走らせる。
 */
function requiresBackup(text) {
  const op = prismaOp(text);
  if (!op) return false;
  if (op.group === "migrate") return !READ_ONLY_MIGRATE_SUBCOMMANDS.has(op.sub);
  return op.group === "db" && op.sub === "push";
}

module.exports = {
  PRISMA_LAUNCH,
  WRAPPERS,
  PRISMA_VALUE_OPTS,
  stripWrappers,
  SCHEMA_MIGRATE_SUBCOMMANDS,
  READ_ONLY_MIGRATE_SUBCOMMANDS,
  prismaArgs,
  prismaOp,
  changesSchema,
  requiresBackup,
};
