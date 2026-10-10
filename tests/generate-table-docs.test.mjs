import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(
  ROOT,
  "templates",
  "nextjs",
  "tools",
  "scripts",
  "lib",
  "parse-prisma-schema.ts"
);

/**
 * `schema.prisma` → `テーブル定義書.md` の解析（AC3 / AC9 / AC10 と、その査読）
 *
 * ## なぜ `.ts` を直接 import できるのか
 *
 * **Node は 22.18 以降、型注釈の除去が無フラグで有効**なので、`tsx` を入れずに読める。
 * 対象（`lib/parse-prisma-schema.ts`）は `interface` と型注釈だけで、
 * **消去できない構文（`enum` / `namespace` / パラメータプロパティ）を持たない**。
 * 読めなければ**その場で落として理由を言う** —— 黙って skip すると回帰を見逃す。
 *
 * ## なぜ純粋部が分かれているのか
 *
 * 呼び出し側（`generate-table-docs.ts`）は**モジュール先頭でパスを解決し、末尾で `main()`**
 * を呼ぶ形だった。import した瞬間に `テーブル定義書.md` を書きに行くので、検査できなかった。
 */

let lib;
try {
  lib = await import(pathToFileURL(LIB).href);
} catch (e) {
  assert.fail(
    `${LIB} を読めなかった: ${e.message}\n` +
      `Node 22.18 以降（型注釈の除去が既定）で実行すること。` +
      `消去できない TypeScript 構文が入っていないかも確認する。`
  );
}
const { parseSchema, generateMarkdown, cell } = lib;

const NL = String.fromCharCode(10);
const schema = (...lines) => lines.join(NL) + NL;
const render = (text) => generateMarkdown(...Object.values(parseSchema(text)), "2026-10-11");
const parse = (text) => parseSchema(text);

test("列の `///` は複数行を連結する（AC3。上書きすると前の行が消える）", () => {
  const { models } = parse(
    schema(
      "model User {",
      "  /// 表示名。",
      "  /// 全角 20 文字まで",
      "  name String",
      "}"
    )
  );
  const f = models[0].fields.find((x) => x.name === "name");
  assert.equal(f.comment, "表示名。 全角 20 文字まで");
});

test("`model` 直上の `///` を説明として拾う（AC9。常に空だった）", () => {
  const { models } = parse(
    schema("/// 利用者。", "/// 退会しても履歴は残す。", "model User {", "  id String @id", "}")
  );
  assert.equal(models[0].description, "利用者。 退会しても履歴は残す。");
  const md = render(
    schema("/// 利用者。", "model User {", "  id String @id", "}")
  );
  assert.match(md, /\| 1 \| User \| User \| 利用者。 \|/, "テーブル一覧の説明列に出ていない");
});

test("`///` と `model` の間に素の `//` が挟まっても消えない（査読③）", () => {
  const { models } = parse(
    schema("/// 利用者。", "// ===== ユーザー関連 =====", "model User {", "  id String @id", "}")
  );
  assert.equal(models[0].description, "利用者。");
});

test("`///` の紐づけ先を失う形では、次の model へ漏らさない", () => {
  const { models } = parse(
    schema(
      "/// enum の説明",
      "enum Role {",
      "  ADMIN",
      "}",
      "model User {",
      "  id String @id",
      "}"
    )
  );
  assert.equal(models[0].description, null, "enum 直前の `///` が model へ漏れている");

  const two = parse(
    schema(
      "model A {",
      "  id String @id",
      "  /// 取り残された説明",
      "}",
      "model B {",
      "  id String @id",
      "}"
    )
  );
  assert.equal(two.models[1].description, null, "ブロック末尾の `///` が次の model へ漏れている");
});

test("説明の `|` は1つの `\\|` に逃がす（二重にすると列が割れる・査読⑤）", () => {
  assert.equal(cell("a | b"), "a \\| b");
  assert.equal(cell("a \\| b"), "a \\| b", "自分で書いた `\\|` を二重にしている");
  const md = render(
    schema("model User {", "  /// 自分で \\| と書いた説明", "  name String", "}")
  );
  assert.ok(!md.includes("\\\\|"), "二重エスケープが出力に残っている");
});

test("説明が無いモデルの行は、旧い出力と同じ形にする（無意味な差分を出さない・査読④）", () => {
  const md = render(schema("model User {", "  id String @id", "}"));
  assert.match(md, /\| 1 \| User \| User \| \|/, "空の説明セルの形が変わっている");
});

test("ER 図は生成しない（AC10。`prisma.md` の記述の裏付け）", () => {
  const md = render(
    schema("model User {", "  id String @id", "}", "model Post {", "  id String @id", "}")
  );
  assert.ok(!md.includes("erDiagram"), "ER 図を生成している（文書の記述と食い違う）");
  assert.match(md, /# テーブル定義書/);
});
