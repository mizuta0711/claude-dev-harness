/**
 * PreToolUse フック: prisma migrate 実行前の DB バックアップ
 *
 * コマンド判定は本スクリプト内で stdin の JSON (tool_input.command) を読んで行う
 * （Phase 2 指示書 §0-8 の standalone 規約。hooks.json 側の matcher は `Bash|PowerShell` のみ）。
 *
 * 移植元では settings.json の `if: "Bash(*prisma migrate*)"` を粗いフィルタに使っていたが、
 * 公式ドキュメントも「引数を制約する Bash パターンは fragile」と警告しているとおり、
 * コミットメッセージ本文に `prisma migrate` と書いただけで `git commit` がマッチし、
 * バックアップが誤発火してコミットがブロックされた実績がある。
 * よって判定はすべてスクリプト側に置く。
 *
 * 先頭一致（`npx prisma migrate` のみ）に絞れば誤発火は消えるが、
 * `DATABASE_URL="..." npx prisma migrate deploy` のような環境変数付きの正規手順を
 * 取りこぼしてバックアップが迂回されるため、分割 + 環境変数剥がし + 先頭一致で判定する。
 *
 * - 実際に prisma migrate を「実行する」コマンド時のみ `tools/export-to-sql.ts` を実行
 * - それ以外のコマンドは即 exit 0 でスキップ
 * - backup 失敗時は continue:false で migrate をブロックし、人間の判断を挟む。
 *   core の pre-commit-check が permissionDecision:"deny"（Claude が自力で直して再試行できる）を
 *   使うのに対し、こちらを強い停止にしているのは意図的 —
 *   バックアップなしで破壊的な DB 操作へ進ませないため。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const lib = require("./plugin-lib.js");

/** バックアップツールの場所（テンプレート層が配置する位置） */
const EXPORT_TOOL = "tools/export-to-sql.ts";

/**
 * DB を変更しない `prisma migrate` のサブコマンド。
 *
 * これらでバックアップを走らせても、守るものが無いのに時間（実測 約1.2秒）と
 * ディスクを消費するだけになる。`resolve` は `_prisma_migrations` を書き換えるため**含めない**。
 */
const READ_ONLY_MIGRATE_SUBCOMMANDS = new Set(["status", "diff"]);

const payload = lib.readPayload();
if (!payload) process.exit(0);

const command = payload?.tool_input?.command || "";

/**
 * コマンド文字列に `prisma migrate` が「含まれる」かではなく、
 * 実際にそれを「実行しようとしている」かを判定する。
 *
 * 1. ヒアドキュメント本文を除去する（コミットメッセージ等に書かれた
 *    `npx prisma migrate deploy` で誤発火しないようにするため）
 * 2. `&&` `||` `;` `|` 改行 でコマンドを分割する
 * 3. 各セグメントの先頭にある環境変数代入（`DATABASE_URL="..."` 等）を剥がす
 * 4. 残りが prisma migrate の起動そのものであるかを先頭一致で判定する
 */
function runsPrismaMigrate(raw) {
  // 1. ヒアドキュメント本文の除去
  let text = raw;
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let m;
  while ((m = heredoc.exec(raw)) !== null) {
    const delim = m[2];
    const bodyStart = raw.indexOf("\n", m.index);
    if (bodyStart === -1) continue;
    const end = raw.search(new RegExp("^[ \\t]*" + delim + "[ \\t]*$", "m"));
    if (end > bodyStart) {
      text = text.replace(raw.slice(bodyStart, end), "\n");
    }
  }

  // 2. コマンドの分割
  const segments = text.split(/&&|\|\||;|\||\n/);

  for (const segment of segments) {
    // 3. 先頭の環境変数代入を剥がす
    const stripped = segment
      .trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");

    // 4. prisma migrate の起動そのものか
    const m = stripped.match(
      /^(?:(?:npx|pnpm|yarn|bunx|bun)\s+)?prisma\s+migrate\b(.*)$/
    );
    if (!m) continue;

    // 5. **DB を変更しない呼び出しは対象外**にする（C1 2周目の還元 #16）。
    //    `prisma migrate\b` の前方一致だけだと `migrate status` や `--help` でも
    //    バックアップが走り、実 migrate ゼロ回で同一内容の .bak が 7 個溜まった（実測）。
    //    ヘッダの「実際に実行するときのみ」という設計意図に実装を合わせる。
    const rest = m[1].trim();
    if (/^(?:-h\b|--help\b)/.test(rest)) continue; // ヘルプ表示
    const sub = rest.split(/\s+/)[0] || "";
    if (READ_ONLY_MIGRATE_SUBCOMMANDS.has(sub)) continue;

    return true;
  }
  return false;
}

/**
 * バックアップ対象テーブルが設定済みかを調べる。
 *
 * `tools/export-to-sql.ts` の `ORDERED_TABLES` はテンプレート出荷時 TODO（空配列）である。
 * 空のまま migrate すると **中身が空のダンプができ、「バックアップ済み」と誤認する**。
 * 移植元はこれを黙って通していた（01調査 §8 の既知問題）。ここで検出して止める。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function backupTargetsConfigured(root) {
  const file = path.join(root, EXPORT_TOOL);
  let src;
  try {
    src = fs.readFileSync(file, "utf-8");
  } catch {
    // ツール自体が無いプロジェクト構成もありうる。実行時に失敗するのでここでは判定しない
    return { ok: true };
  }
  const m = src.match(/ORDERED_TABLES\s*(?::[^=]*)?=\s*\[([\s\S]*?)\]/);
  if (!m) return { ok: true }; // 形が変わっている場合は判定を諦める（fail-open）
  // コメントを除いた実質的な要素があるか
  const body = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .trim();
  if (!body) {
    return {
      ok: false,
      reason:
        `${EXPORT_TOOL} の ORDERED_TABLES が空（テンプレート出荷時の TODO）のままです。` +
        `このまま実行すると中身が空のダンプができ、バックアップ済みと誤認します。`,
    };
  }
  return { ok: true };
}

/**
 * 「まだ一度も migrate していない」状態かを判定する。
 *
 * `prisma/migrations/` に適用済みマイグレーションが1つも無いなら、
 * **保護すべきスキーマもデータもまだ存在しない**。
 * この状態でバックアップを要求すると、新規プロジェクトの初回 migrate が
 * 必ずブロックされる（`ORDERED_TABLES` は当然まだ空なので）。
 *
 * constitution §7 の fail-open 原則どおり、**失うものが無い場面では素通しする**。
 * 逆に migrations が1つでもあれば、テーブルが存在しうるので従来どおり止める。
 *
 * C1 の還元 #10。
 */
function isFirstMigration(root) {
  const dir = path.join(root, "prisma", "migrations");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // migrations ディレクトリ自体が無い ＝ 一度も migrate していない
    return true;
  }
  // Prisma は各マイグレーションをディレクトリとして作る（migration_lock.toml はファイル）
  return !entries.some((e) => e.isDirectory());
}

if (!runsPrismaMigrate(command)) {
  process.exit(0);
}

const root = lib.projectDir();

if (isFirstMigration(root)) {
  lib.emit({
    systemMessage:
      "初回マイグレーションのため DB バックアップをスキップしました" +
      "（prisma/migrations/ に適用済みマイグレーションが無く、保護すべき既存データが存在しないため）。\n" +
      `2回目以降は ${EXPORT_TOOL} の ORDERED_TABLES / DB_TABLE_MAP が必要になります。` +
      "スキーマが固まった時点で記入してください（.claude/rules/prisma.md の「3点同期」）。",
  });
  process.exit(0);
}

const configured = backupTargetsConfigured(root);
if (!configured.ok) {
  lib.emit({
    continue: false,
    stopReason:
      `DB バックアップを実行できません: ${configured.reason}\n` +
      `対処: ${EXPORT_TOOL} の ORDERED_TABLES / DB_TABLE_MAP を実テーブルに合わせて記入してください` +
      `（.claude/rules/prisma.md の「3点同期」）。\n` +
      `まだテーブルが1つも無い初回マイグレーションでバックアップ不要と判断できる場合は、` +
      `ユーザー自身が migrate を実行してください。`,
  });
  process.exit(0);
}

// stdio は必ず pipe にする。hook の stdout に子プロセスの出力が混ざると、
// Claude Code が JSON をパースできず continue:false が無効化される
// （公式仕様: stdout は JSON オブジェクトのみでなければならない）。
try {
  execSync(`npx tsx ${EXPORT_TOOL}`, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  lib.emit({ systemMessage: "DB backup completed before migrate." });
} catch (e) {
  const excerpt = ((e.stdout || "") + "\n" + (e.stderr || ""))
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 10)
    .join("\n");
  lib.emit({
    continue: false,
    stopReason:
      "DB backup failed. Fix before running migrate: " +
      e.message +
      (excerpt ? "\n" + excerpt : ""),
  });
}
