// npx tsx tools/export-to-sql.ts
// データベースエクスポートツール (v1.0.0)
//
// 機能:
// - 全テーブルの TRUNCATE + INSERT 文を生成
// - 外部キー制約を考慮した順序でエクスポート
// - text[] 配列、JSON、日付、boolean に対応
// - zip 圧縮バックアップ（同日複数回対応）
//
// 使用方法:
// npx tsx tools/export-to-sql.ts
//
// 出力:
// tools/dump.sql                    - PostgreSQL 用 SQL ファイル
// tools/backup/dump_YYYYMMDD.zip   - 日付付きバックアップ
// tools/backup/dump_YYYYMMDD_2.zip - 同日2回目以降
import { PrismaClient } from "@prisma/client";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";

const prisma = new PrismaClient();
const execAsync = promisify(exec);

// ========================================
// テーブル定義
// ========================================
// prisma/schema.prisma と docs/設計書/テーブル定義書.md に同期すること。
// テーブル追加・削除時は以下の3箇所を全て更新:
//   1. prisma/schema.prisma（スキーマ）
//   2. docs/設計書/テーブル定義書.md（設計書）
//   3. このファイルの ORDERED_TABLES + DB_TABLE_MAP（バックアップツール）

/**
 * 外部キー制約を考慮したテーブルエクスポート順序
 * 依存関係の少ないものから順に並べる
 *
 * ⚠️ TODO（テンプレート出荷時は空。**プロジェクトごとに必ず記入すること**）
 *
 * ここが空のままだと **中身が空のダンプが生成され、「バックアップ済み」と誤認する**。
 * harness-nextjs の pre-migrate-backup hook はこの配列が空であることを検出して
 * `prisma migrate` をブロックする（空バックアップを黙って作らせないため）。
 * 記入するまで migrate は実行できない。
 */
const ORDERED_TABLES: string[] = [
  // "user",
  // "userProfile",
];

/**
 * Prisma モデル名 → PostgreSQL テーブル名のマッピング
 *
 * ⚠️ TODO（テンプレート出荷時は空。**ORDERED_TABLES と対で必ず記入すること**）
 *
 * ORDERED_TABLES に載っているのにここに無いモデルは出力されない
 * （＝そのテーブルだけ静かにバックアップから漏れる）。両方を同時に更新すること。
 */
const DB_TABLE_MAP: Record<string, string> = {
  // user: 'public."User"',
  // userProfile: 'public."UserProfile"',
};

// ========================================
// ユーティリティ
// ========================================

/**
 * SQL 値として整形（NULL、数値、文字列、日付、boolean、JSON、配列）
 */
function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;

  // text[] 配列 → ARRAY[...] 形式
  if (Array.isArray(value)) {
    if (value.length === 0) return "ARRAY[]::text[]";
    const elements = value.map(
      (v) => `'${v.toString().replace(/'/g, "''")}'`
    );
    return `ARRAY[${elements.join(", ")}]`;
  }

  // JSON オブジェクト
  if (typeof value === "object")
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;

  // 文字列
  return `'${value.toString().replace(/'/g, "''")}'`;
}

function getDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function ensureBackupDirectory(): void {
  const backupDir = "tools/backup";
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
    console.log("Created backup directory: tools/backup");
  }
}

function getUniqueBackupPath(basePath: string): string {
  if (!existsSync(basePath)) return basePath;
  const ext = path.extname(basePath);
  const base = basePath.slice(0, -ext.length);
  let counter = 2;
  let newPath = `${base}_${counter}${ext}`;
  while (existsSync(newPath)) {
    counter++;
    newPath = `${base}_${counter}${ext}`;
  }
  return newPath;
}

// ========================================
// エクスポート処理
// ========================================

async function exportTable(
  modelName: string
): Promise<{ sql: string; rowCount: number }> {
  try {
    const model = (
      prisma as unknown as Record<
        string,
        { findMany: () => Promise<unknown[]> }
      >
    )[modelName];
    if (!model?.findMany) {
      console.warn(`  Model ${modelName} not found, skipping...`);
      return { sql: "", rowCount: 0 };
    }

    const dbTable = DB_TABLE_MAP[modelName] ?? modelName;
    console.log(`  Fetching ${modelName}...`);
    const rows = (await model.findMany()) as Record<string, unknown>[];

    const sqlLines = [`-- Table: ${modelName} (${rows.length} rows)`];
    sqlLines.push(`TRUNCATE TABLE ${dbTable} CASCADE;`);

    if (rows.length === 0) {
      sqlLines.push("-- No data to insert");
      return { sql: sqlLines.join("\n"), rowCount: 0 };
    }

    const columns = Object.keys(rows[0]);
    const dbColumns = columns.map((col) => `"${col}"`);

    // 100 件単位でバルクインサート
    const BATCH_SIZE = 100;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const valueLines = batch.map((row) => {
        const values = columns.map((col) => sqlValue(row[col]));
        return `(${values.join(", ")})`;
      });
      sqlLines.push(
        `INSERT INTO ${dbTable} (${dbColumns.join(", ")}) VALUES\n${valueLines.join(",\n")};`
      );
    }

    return { sql: sqlLines.join("\n"), rowCount: rows.length };
  } catch (error) {
    console.error(`  Error exporting ${modelName}:`, error);
    return {
      sql: `-- ERROR: Failed to export ${modelName}: ${error}`,
      rowCount: 0,
    };
  }
}

async function createZipBackup(sqlFilePath: string): Promise<void> {
  const dateStr = getDateString();
  const basePath = path.join("tools", "backup", `dump_${dateStr}.zip`);
  const backupPath = getUniqueBackupPath(basePath);

  try {
    const isWindows = process.platform === "win32";
    const command = isWindows
      ? `powershell -Command "Compress-Archive -Path '${sqlFilePath}' -DestinationPath '${backupPath}' -Force"`
      : `zip -j '${backupPath}' '${sqlFilePath}'`;

    await execAsync(command);
    console.log(`  Backup created: ${backupPath}`);
    if (backupPath !== basePath) {
      console.log(`  Note: Multiple backups today (avoiding overwrite)`);
    }
  } catch (error) {
    console.warn("  Could not create zip backup:", error);
  }
}

// ========================================
// メイン処理
// ========================================

async function main() {
  if (ORDERED_TABLES.length === 0) {
    console.error(
      "Error: ORDERED_TABLES is empty. Configure your tables first."
    );
    console.log(
      "Edit tools/export-to-sql.ts and add your Prisma model names to ORDERED_TABLES and DB_TABLE_MAP."
    );
    process.exit(1);
  }

  console.log("Starting database export...\n");
  ensureBackupDirectory();

  const sqlChunks: string[] = [];

  // ヘッダー
  sqlChunks.push("-- Database Export (v1.0.0)");
  sqlChunks.push(`-- Generated at: ${new Date().toISOString()}`);
  sqlChunks.push(
    "-- Tables are ordered by foreign key dependencies (parents first)"
  );
  sqlChunks.push(
    `-- Tables: ${ORDERED_TABLES.length} (${ORDERED_TABLES.join(", ")})`
  );
  sqlChunks.push(
    "-- Compatible with: Next.js 16, Prisma 6, PostgreSQL"
  );
  sqlChunks.push("");

  let totalTables = 0;
  let totalRows = 0;

  for (const tableName of ORDERED_TABLES) {
    const result = await exportTable(tableName);
    if (result.sql) {
      sqlChunks.push(result.sql);
      totalTables++;
      totalRows += result.rowCount;
      console.log(
        result.rowCount > 0
          ? `  -> ${result.rowCount} rows`
          : `  -> No data`
      );
    }
  }

  // フッター
  sqlChunks.push("");
  sqlChunks.push(
    `-- Export completed: ${totalTables} tables, ${totalRows} rows`
  );
  sqlChunks.push(`-- Generated at: ${new Date().toISOString()}`);

  const fullSql = sqlChunks.join("\n\n");
  const outputPath = "tools/dump.sql";
  writeFileSync(outputPath, fullSql);

  console.log(`\nExport completed!`);
  console.log(`  File: ${outputPath}`);
  console.log(`  Tables: ${totalTables}, Rows: ${totalRows}`);
  console.log(`  Size: ${(fullSql.length / 1024).toFixed(2)} KB`);

  // zip バックアップ
  console.log("\nCreating zip backup...");
  await createZipBackup(outputPath);

  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error("Export failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
