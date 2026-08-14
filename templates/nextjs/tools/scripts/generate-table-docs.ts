/**
 * generate-table-docs.ts
 *
 * prisma/schema.prisma を読み取り、docs/設計書/テーブル定義書.md を自動生成する。
 *
 * 使い方:
 *   npx tsx tools/scripts/generate-table-docs.ts
 */

import * as fs from "fs";
import * as path from "path";

const SCHEMA_PATH = path.resolve(__dirname, "../../prisma/schema.prisma");
const OUTPUT_PATH = path.resolve(
  __dirname,
  "../../docs/設計書/テーブル定義書.md"
);

// ============================================================
// 型定義
// ============================================================

interface EnumDef {
  name: string;
  values: string[];
}

interface FieldDef {
  name: string;
  rawType: string;       // "String", "Int?", "UserRole", etc.
  baseType: string;      // nullable除去後の基本型
  isNullable: boolean;
  isArray: boolean;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt: boolean;
  dbAttr: string | null; // "@db.VarChar(200)" → "VarChar(200)"
  defaultVal: string | null;
  comment: string | null;
  relationAttr: RelationAttr | null;
}

interface RelationAttr {
  fields: string[];
  references: string[];
  onDelete: string | null;
  name: string | null;
}

interface IndexDef {
  fields: string[];
  isUnique: boolean;
}

interface ModelDef {
  name: string;
  tableName: string; // @@map があればそれ、なければ name
  fields: FieldDef[];
  indexes: IndexDef[];
}

// ============================================================
// パーサー
// ============================================================

function removeLineComments(line: string): { code: string; comment: string | null } {
  // "//" をコメント開始として扱うが、文字列内は無視（簡易実装）
  const idx = line.indexOf("//");
  if (idx === -1) return { code: line, comment: null };
  return {
    code: line.slice(0, idx).trimEnd(),
    comment: line.slice(idx + 2).trim() || null,
  };
}

/**
 * 開き括弧の位置（その文字が '(' であること）から対応する閉じ括弧までの中身を返す。
 * ネストした括弧を正しく処理する。
 */
function extractParenContent(str: string, openPos: number): string | null {
  if (str[openPos] !== "(") return null;
  let depth = 0;
  let start = -1;
  for (let i = openPos; i < str.length; i++) {
    if (str[i] === "(") {
      depth++;
      if (depth === 1) start = i + 1;
    } else if (str[i] === ")") {
      depth--;
      if (depth === 0) {
        return str.slice(start, i).trim();
      }
    }
  }
  return null;
}

function parseRelationAttr(attrStr: string): RelationAttr {
  // @relation("name", fields: [...], references: [...], onDelete: Cascade)
  const result: RelationAttr = {
    fields: [],
    references: [],
    onDelete: null,
    name: null,
  };

  // name (quoted string as first argument)
  const nameMatch = attrStr.match(/^\s*"([^"]+)"/);
  if (nameMatch) result.name = nameMatch[1];

  // fields: [...]
  const fieldsMatch = attrStr.match(/fields:\s*\[([^\]]*)\]/);
  if (fieldsMatch) {
    result.fields = fieldsMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // references: [...]
  const refsMatch = attrStr.match(/references:\s*\[([^\]]*)\]/);
  if (refsMatch) {
    result.references = refsMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // onDelete: ...
  const onDeleteMatch = attrStr.match(/onDelete:\s*(\w+)/);
  if (onDeleteMatch) result.onDelete = onDeleteMatch[1];

  return result;
}

function parseField(line: string, enumNames: Set<string>, docComment?: string | null): FieldDef | null {
  const { code, comment } = removeLineComments(line);
  const trimmed = code.trim();
  if (!trimmed) return null;

  // ブロック属性（@@）はフィールドではない
  if (trimmed.startsWith("@@")) return null;

  // トークン分割: フィールド名 型 属性...
  // 型の後にスペースで区切られた属性が続く
  // 例: id  String  @id @default(cuid())
  const tokenMatch = trimmed.match(/^(\w+)\s+(\S+)(.*)?$/);
  if (!tokenMatch) return null;

  const fieldName = tokenMatch[1];
  const rawType = tokenMatch[2];
  const attrsStr = tokenMatch[3] || "";

  // キーワードをフィールドとして扱わない
  if (["model", "enum", "generator", "datasource", "}"].includes(fieldName)) {
    return null;
  }

  const isArray = rawType.endsWith("[]");
  const isNullable = rawType.endsWith("?") && !isArray;
  let baseType = rawType.replace("[]", "").replace("?", "");

  const isId = attrsStr.includes("@id");
  const isUnique = attrsStr.includes("@unique");
  const isUpdatedAt = attrsStr.includes("@updatedAt");

  // @db.VarChar(N) / @db.Text など
  let dbAttr: string | null = null;
  const dbMatch = attrsStr.match(/@db\.(\w+(?:\(\d+\))?)/);
  if (dbMatch) dbAttr = dbMatch[1];

  // @default(...) — ネストした括弧を考慮して中身を取り出す
  let defaultVal: string | null = null;
  const defaultStart = attrsStr.indexOf("@default(");
  if (defaultStart !== -1) {
    defaultVal = extractParenContent(attrsStr, defaultStart + "@default(".length - 1);
  }

  // @relation(...) — ネストした括弧を考慮して中身を取り出す
  let relationAttr: RelationAttr | null = null;
  const relationStart = attrsStr.indexOf("@relation(");
  if (relationStart !== -1) {
    const inner = extractParenContent(attrsStr, relationStart + "@relation(".length - 1);
    if (inner !== null) {
      relationAttr = parseRelationAttr(inner);
    }
  }

  // /// ドキュメンテーションコメントを優先し、なければインラインコメントを使用
  const resolvedComment = docComment ?? comment;

  return {
    name: fieldName,
    rawType,
    baseType,
    isNullable,
    isArray,
    isId,
    isUnique,
    isUpdatedAt,
    dbAttr,
    defaultVal,
    comment: resolvedComment,
    relationAttr,
  };
}

function parseSchema(schemaText: string): {
  enums: EnumDef[];
  models: ModelDef[];
} {
  const enums: EnumDef[] = [];
  const models: ModelDef[] = [];

  const lines = schemaText.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // enum ブロック
    const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
    if (enumMatch) {
      const enumName = enumMatch[1];
      const values: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("}")) {
        const { code } = removeLineComments(lines[i]);
        const val = code.trim();
        if (val) values.push(val);
        i++;
      }
      enums.push({ name: enumName, values });
      i++;
      continue;
    }

    // model ブロック
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      const modelName = modelMatch[1];
      const fields: FieldDef[] = [];
      const indexes: IndexDef[] = [];
      let tableName = modelName;

      const enumNameSet = new Set(enums.map((e) => e.name));

      i++;
      let pendingDocComment: string | null = null;
      while (i < lines.length && !lines[i].trim().startsWith("}")) {
        const currentLine = lines[i];
        const trimmedLine = currentLine.trim();

        // /// ドキュメンテーションコメント行を収集（次のフィールドに紐づける）
        const docCommentMatch = trimmedLine.match(/^\/\/\/\s*(.*)/);
        if (docCommentMatch) {
          pendingDocComment = docCommentMatch[1].trim() || null;
          i++;
          continue;
        }

        // @@map
        const mapMatch = trimmedLine.match(/^@@map\("([^"]+)"\)/);
        if (mapMatch) {
          tableName = mapMatch[1];
          pendingDocComment = null;
          i++;
          continue;
        }

        // @@index / @@unique
        const indexMatch = trimmedLine.match(/^@@index\(\[([^\]]+)\]/);
        if (indexMatch) {
          const fieldList = indexMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          indexes.push({ fields: fieldList, isUnique: false });
          pendingDocComment = null;
          i++;
          continue;
        }
        const uniqueMatch = trimmedLine.match(/^@@unique\(\[([^\]]+)\]/);
        if (uniqueMatch) {
          const fieldList = uniqueMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          indexes.push({ fields: fieldList, isUnique: true });
          pendingDocComment = null;
          i++;
          continue;
        }

        // フィールドパース（直前の /// コメントを渡す）
        const field = parseField(currentLine, enumNameSet, pendingDocComment);
        if (field) fields.push(field);
        pendingDocComment = null;

        i++;
      }

      models.push({ name: modelName, tableName, fields, indexes });
      i++;
      continue;
    }

    i++;
  }

  return { enums, models };
}

// ============================================================
// 型・デフォルト値のフォーマット
// ============================================================

function formatType(field: FieldDef): string {
  const { baseType, isArray, dbAttr, isId } = field;

  let type = baseType;

  // db属性から詳細型を構築
  if (dbAttr) {
    if (dbAttr.startsWith("VarChar")) {
      const numMatch = dbAttr.match(/\((\d+)\)/);
      type = numMatch ? `String (VARCHAR ${numMatch[1]})` : "String (VARCHAR)";
    } else if (dbAttr === "Text") {
      type = "String (TEXT)";
    } else {
      type = `${baseType} (${dbAttr})`;
    }
  } else if (baseType === "String" && isId) {
    type = "String (CUID)";
  }

  if (isArray) type += "[]";

  return type;
}

function formatDefault(field: FieldDef): string {
  if (field.isUpdatedAt) return "@updatedAt";
  if (field.defaultVal === null) return "-";

  const val = field.defaultVal;
  // クォートで囲まれた文字列は中身だけ返す
  if (val.startsWith('"') && val.endsWith('"')) {
    return val.slice(1, -1);
  }
  return val;
}

function formatOnDelete(onDelete: string | null): string {
  if (!onDelete) return "RESTRICT";
  switch (onDelete) {
    case "Cascade":
      return "CASCADE DELETE";
    case "SetNull":
      return "SET NULL";
    case "Restrict":
      return "RESTRICT";
    default:
      return onDelete.toUpperCase();
  }
}

// ============================================================
// Markdown 生成
// ============================================================

const PRIMITIVE_TYPES = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "Json", "Bytes", "Decimal", "BigInt",
]);

/**
 * Prisma のナビゲーションプロパティ（DBカラムとして存在しない仮想フィールド）かどうかを返す。
 * - @relation を持つフィールドはすべてナビゲーション（FK カラム自体は別フィールド）
 * - @relation なし、かつ基本型でも enum でもない型 → 逆参照ナビゲーション
 */
function isNavigationField(field: FieldDef, enumNames: Set<string>): boolean {
  if (field.relationAttr !== null) return true;
  if (!PRIMITIVE_TYPES.has(field.baseType) && !enumNames.has(field.baseType)) return true;
  return false;
}

/**
 * 外部キーフィールド: @relation の fields[] に列挙されたカラム名を持つフィールドを
 * モデルの全フィールドから特定する。
 * （外部キーは @relation を持つナビゲーションフィールドから fields: [...] を読んで解決する）
 */
function getForeignKeys(
  model: ModelDef,
  enumNames: Set<string>
): Array<{ fields: string[]; references: string[]; targetType: string; onDelete: string | null }> {
  const result: Array<{ fields: string[]; references: string[]; targetType: string; onDelete: string | null }> = [];
  for (const field of model.fields) {
    if (field.relationAttr && field.relationAttr.fields.length > 0) {
      result.push({
        fields: field.relationAttr.fields,
        references: field.relationAttr.references,
        targetType: field.baseType,
        onDelete: field.relationAttr.onDelete,
      });
    }
  }
  return result;
}

/**
 * 逆参照リレーション（DBカラムなし、Prisma ナビゲーションのみ）の一覧を返す。
 */
function getVirtualRelations(
  model: ModelDef,
  enumNames: Set<string>
): FieldDef[] {
  return model.fields.filter((f) => {
    // @relation を持ち、かつ fields[] が空（逆参照側）
    if (f.relationAttr && f.relationAttr.fields.length === 0) return true;
    // @relation なし、かつ非プリミティブ・非 enum（暗黙の逆参照）
    if (!f.relationAttr && !PRIMITIVE_TYPES.has(f.baseType) && !enumNames.has(f.baseType)) return true;
    return false;
  });
}

function generateMarkdown(
  enums: EnumDef[],
  models: ModelDef[],
  today: string
): string {
  const enumNames = new Set(enums.map((e) => e.name));
  const modelNames = new Set(models.map((m) => m.name));

  const lines: string[] = [];

  // ヘッダー
  lines.push("# テーブル定義書");
  lines.push("");
  lines.push(
    "> このドキュメントは `tools/scripts/generate-table-docs.ts` により自動生成されています。"
  );
  lines.push(
    "> 手動編集しないでください。変更は `prisma/schema.prisma` に対して行ってください。"
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  // Enum定義
  lines.push("## Enum定義");
  lines.push("");

  for (const en of enums) {
    lines.push(`### ${en.name}`);
    lines.push("");
    lines.push("| 値 | 説明 |");
    lines.push("|---|---|");
    for (const val of en.values) {
      lines.push(`| ${val} | ${val} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // テーブル一覧
  lines.push("## テーブル一覧");
  lines.push("");
  lines.push("| # | テーブル名 | モデル名 | 説明 |");
  lines.push("|---|-----------|---------|------|");
  models.forEach((m, idx) => {
    lines.push(`| ${idx + 1} | ${m.tableName} | ${m.name} | |`);
  });
  lines.push("");
  lines.push("---");
  lines.push("");

  // 各モデル定義
  models.forEach((model, idx) => {
    lines.push(`## ${idx + 1}. ${model.name}`);
    lines.push("");

    // フィールド表（ナビゲーションプロパティは除く）
    const tableFields = model.fields.filter(
      (f) => !isNavigationField(f, enumNames)
    );

    lines.push("| カラム | 型 | NULL | デフォルト | 説明 |");
    lines.push("|--------|---|------|----------|------|");

    for (const field of tableFields) {
      const type = formatType(field);
      const nullable = field.isNullable ? "YES" : "NO";
      const defVal = formatDefault(field);
      const desc = buildDescription(field);
      lines.push(`| ${field.name} | ${type} | ${nullable} | ${defVal} | ${desc} |`);
    }

    lines.push("");

    // インデックス
    if (model.indexes.length > 0) {
      lines.push("**インデックス:**");
      for (const idx_ of model.indexes) {
        const label = idx_.isUnique ? " - UNIQUE" : "";
        lines.push(`- \`[${idx_.fields.join(", ")}]\`${label}`);
      }
      lines.push("");
    }

    // 外部キー（@relation の fields[] から導出）
    const fks = getForeignKeys(model, enumNames);
    if (fks.length > 0) {
      lines.push("**外部キー:**");
      for (const fk of fks) {
        const refField = fk.references[0] || "id";
        const onDel = formatOnDelete(fk.onDelete);
        lines.push(
          `- \`${fk.fields.join(", ")}\` → \`${fk.targetType}.${refField}\` (${onDel})`
        );
      }
      lines.push("");
    }

    // リレーション（逆参照ナビゲーション）
    const virtualRelations = getVirtualRelations(model, enumNames);
    if (virtualRelations.length > 0) {
      lines.push("**リレーション:**");
      for (const field of virtualRelations) {
        const isArrayRel = field.isArray;
        const cardinalityLabel = isArrayRel ? "1:N" : "N:1 / 1:1";
        lines.push(
          `- \`${field.name}\` → \`${field.baseType}\` (${cardinalityLabel})`
        );
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  });

  // 改訂履歴
  lines.push("## 改訂履歴");
  lines.push("");
  lines.push("| 版数 | 日付 | コミット | 内容 | 担当 |");
  lines.push("|------|------|---------|------|------|");
  lines.push(
    `| auto | ${today} | - | schema.prisma から自動生成 | generate-table-docs.ts |`
  );
  lines.push("");

  return lines.join("\n");
}

function buildDescription(field: FieldDef): string {
  // /// コメントがある場合はそれを説明として使用（自動ラベルとの重複を避ける）
  if (field.comment) {
    return field.comment.replace(/\|/g, "\\|");
  }
  // /// コメントがない場合のみ isId / isUnique からラベルを生成
  const parts: string[] = [];
  if (field.isId) parts.push("主キー");
  if (field.isUnique && !field.isId) parts.push("一意");
  return parts.join(", ");
}

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

main();
