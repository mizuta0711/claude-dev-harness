import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CORE_COPY = "plugins/harness-core/hooks/scripts/prisma-invocation.js";
const NEXTJS_COPY = "plugins/harness-nextjs/hooks/scripts/prisma-invocation.js";

const inv = require(path.join(ROOT, CORE_COPY));
const ask = require(path.join(ROOT, "plugins/harness-core/hooks/scripts/guarded-command-ask.js"));
const backup = require(path.join(ROOT, "plugins/harness-nextjs/hooks/scripts/pre-migrate-backup.js"));

/**
 * prisma の起動形は、**確認を出す側とバックアップを走らせる側の対**で守る（H79）
 *
 * ## なぜ要るのか
 *
 * `docs/reference/permissionsベースライン.md` 5-4 は、prisma を deny せず
 * 「**ask ＋ バックアップ**」の二段構えで守ると決めている。ところが判定が
 * harness-core（`guarded-command-ask`）と harness-nextjs（`pre-migrate-backup`）に
 * **別々の正規表現として置かれていた**ため、**確認は出るのにバックアップが走らない起動形**が
 * 6つあった（2026-10-11 実測）—— `npx.cmd` / `npx -y` / `pnpm exec` /
 * `node_modules/.bin/` / `yarn dlx` / `db push`。
 *
 * **利用者は確認ダイアログを見て承認するので、守られていると思う。**
 * 片方だけを単体テストしても気づけない。**ask と backup を同じ表で対に当てる**のがこの検査である。
 */

/** 両方が反応しなければならない形（ask ⊆ backup なので、ここは両方 true） */
const GUARDED = [
  "npx prisma migrate dev --name init",
  "npx prisma migrate deploy",
  "npx prisma migrate reset --force",
  "npx prisma migrate resolve --applied 20260101",
  "npx prisma db push",
  "prisma migrate dev",
  "pnpm prisma migrate reset",
  "yarn prisma migrate resolve --applied 0_init",
  'DATABASE_URL="postgres://x" npx prisma migrate deploy',
  "echo start && npx prisma migrate dev --name init",
  // 以下が H79 で露出した6形
  "npx.cmd prisma migrate dev",
  "npx -y prisma migrate deploy",
  "npx --no-install prisma migrate dev",
  "pnpm exec prisma migrate deploy",
  "npm exec -- prisma db push",
  "node_modules/.bin/prisma migrate dev",
  "./node_modules/.bin/prisma migrate deploy",
  String.raw`.\node_modules\.bin\prisma.cmd db push`,
  "yarn dlx prisma db push",
  "bun x prisma migrate deploy",
  // 値つきオプションの値をサブコマンドと取り違えない
  "npx prisma --schema ./db/schema.prisma migrate deploy",
  // --- 以下は査読（2026-10-12）が出した形。いずれも実測で素通りを確認してから直した ---
  // 中1: ask 側は導入部を吸収するのに backup 側は吸収せず、**確認は出るのにバックアップが走らなかった**
  "(npx prisma migrate deploy)",
  "& npx prisma migrate deploy",
  "`npx prisma migrate deploy`",
  // 中2: 版の指定（実務で最も起きやすい形）
  "npx prisma@5.0.0 migrate deploy",
  "npx prisma@latest migrate dev",
  "pnpm dlx prisma@latest db push",
  // 中2: モノレポでパッケージマネージャにオプションが挟まる形
  "pnpm --filter web exec prisma migrate deploy",
  "pnpm -C app exec prisma migrate deploy",
  // 中2: ラッパー経由（`git-scope` が git について同じことをしている・H70）
  "sudo npx prisma migrate deploy",
  "env FOO=1 npx prisma migrate deploy",
  "cross-env NODE_ENV=production npx prisma migrate deploy",
  "dotenv -e .env -- npx prisma migrate deploy",
  // 中2: スクリプト経由
  "npm run prisma -- migrate deploy",
  "bun run prisma db push",
  // 中3: 値を取らないフラグが先頭にある形（「次のトークンを無条件に飛ばす」と壊れる）
  "npx prisma --verbose migrate deploy",
  // 低4: リダイレクトが付いたままサブコマンドと比較しない
  "npx prisma migrate dev>out.txt",
  // 低5: 値の位置にある `-h` はヘルプではない
  "npx prisma migrate dev --name -h",
];

/** どちらも反応してはいけない形（読み取りだけ・無関係・文字列の中） */
const UNGUARDED = [
  "npx prisma migrate status",
  "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma",
  "npx prisma migrate --help",
  "npx prisma migrate dev -h",
  "npx prisma generate",
  "npx prisma studio",
  "npx prisma db pull",
  "npm run build",
  'git commit -m "npx prisma migrate deploy を実行した"',
  "grep -n \"a|prisma migrate deploy|b\" notes.md",
  // 低4 の逆向き: リダイレクトが付いても読み取りだけの除外は効く
  "npx prisma migrate status>out.txt",
  // 名前が似ているだけのもの
  "node_modules/.bin/prisma-client generate",
  "./myprisma migrate deploy",
  "npm install --save-dev prisma",
];

const asks = (cmd) => ask.findGuardHit(cmd, ["prisma-schema-change"])?.name === "prisma-schema-change";
const backs = (cmd) => backup.runsPrismaMigrate(cmd);

for (const cmd of GUARDED) {
  test(`ask と backup の両方が反応する: ${cmd}`, () => {
    assert.equal(asks(cmd), true, "確認が出ない");
    assert.equal(backs(cmd), true, "バックアップが走らない（H79 の形）");
  });
}

for (const cmd of UNGUARDED) {
  test(`どちらも反応しない: ${cmd}`, () => {
    assert.equal(asks(cmd), false, "確認が鳴りすぎる（R3）");
    assert.equal(backs(cmd), false, "バックアップが無駄に走る");
  });
}

/**
 * **ask ⊆ backup** を保つ。
 *
 * backup は「拾えなければ余計に走る」側へ倒す設計なので ask より広くてよいが、
 * **逆は H79 の再発**である（確認が出たのにバックアップが走らない）。
 */
test("ask で止める操作は、必ず backup も走らせる", () => {
  const ops = [
    ...[...inv.SCHEMA_MIGRATE_SUBCOMMANDS].map((sub) => `npx prisma migrate ${sub}`),
    ...[...inv.READ_ONLY_MIGRATE_SUBCOMMANDS].map((sub) => `npx prisma migrate ${sub}`),
    "npx prisma db push",
    "npx prisma db pull",
    "npx prisma migrate",
  ];
  for (const cmd of ops) {
    if (inv.changesSchema(cmd)) assert.equal(inv.requiresBackup(cmd), true, cmd);
  }
  // 広い側であることも確かめる（サブコマンドの無い形は backup だけが拾う）
  assert.equal(inv.changesSchema("npx prisma migrate"), false);
  assert.equal(inv.requiresBackup("npx prisma migrate"), true);
});

/**
 * **複製は2箇所にある。片方だけ直したら落ちる。**
 *
 * プラグインをまたいだ `require` はできない（`${CLAUDE_PLUGIN_ROOT}` がプラグインごとに違う）。
 * `plugin-lib.js` が core の `harness-lib.js` を複製しているのと同じ事情で、
 * **ファイルごと同内容で置く**しかない。`is-git-commit.test.mjs` / `git-scope.test.mjs` と同じ形。
 */
test("prisma-invocation.js の2つの複製は同内容である", () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8").replace(/\r\n/g, "\n");
  assert.equal(
    read(CORE_COPY),
    read(NEXTJS_COPY),
    `${CORE_COPY} と ${NEXTJS_COPY} が食い違っている（起動形の判定は1箇所で直して両方へ反映する）`
  );
});
