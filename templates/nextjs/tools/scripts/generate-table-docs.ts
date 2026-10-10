/**
 * generate-table-docs.ts
 *
 * prisma/schema.prisma を読み取り、docs/設計書/テーブル定義書.md を自動生成する。
 *
 * 使い方:
 *   npx tsx tools/scripts/generate-table-docs.ts
 *
 * **解析と本文作りは `./lib/parse-prisma-schema.ts` が持つ**（ここは I/O だけ）。
 * 分けてある理由はそちらの冒頭にある。
 */

import * as fs from "fs";
import * as path from "path";

import { parseSchema, generateMarkdown } from "./lib/parse-prisma-schema";

const SCHEMA_PATH = path.resolve(__dirname, "../../prisma/schema.prisma");
const OUTPUT_PATH = path.resolve(
  __dirname,
  "../../docs/設計書/テーブル定義書.md"
);

// ============================================================
// エントリポイント
// ============================================================

function main() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`Error: schema.prisma not found at ${SCHEMA_PATH}`);
    process.exit(1);
  }

  const schemaText = fs.readFileSync(SCHEMA_PATH, "utf-8");
  console.log(`Parsing ${SCHEMA_PATH}...`);

  const { enums, models } = parseSchema(schemaText);
  console.log(`  Found ${enums.length} enums, ${models.length} models.`);

  const today = new Date().toISOString().slice(0, 10);
  const markdown = generateMarkdown(enums, models, today);

  fs.writeFileSync(OUTPUT_PATH, markdown, "utf-8");
  console.log(`Output written to ${OUTPUT_PATH}`);
}

// **import しただけでは走らせない。** 囲っていないと、読み込んだ瞬間に
// `schema.prisma` を読んで `テーブル定義書.md` を書きに行く
if (require.main === module) main();
