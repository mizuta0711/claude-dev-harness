import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");

/**
 * テンプレートが配るスクリプトが、**データを消す SQL を無確認で出さない**ことの検査（H93）
 *
 * ## なぜ文面検査なのか
 *
 * `export-to-sql.ts` は**モジュール先頭で `@prisma/client` を import する**ので、
 * `generate-table-docs.test.mjs` のような「純粋部を import して呼ぶ」形が取れない。
 * **そこで文面を見る。** 文面検査は振る舞いの保証ではないので、
 * **「この文字列が無いこと」までしか主張しない**（主張を広げると嘘になる）。
 *
 * ## なぜ要るのか —— 実害が出ている
 *
 * `pocket-drop` では、配られた `export-to-sql.ts` が復元用に
 * `TRUNCATE TABLE public."User" CASCADE` を出していた。PostgreSQL の `CASCADE` は
 * **その表を参照する外部キーを持つ表もまとめて TRUNCATE する**ので、
 * `Session.userId` / `Share.ownerId` 経由で **Share と Session が全削除**された。
 * さらに zip 不在時に**警告だけで終了コード 0** で終わっていたため、
 * **1世代も残っていないのに「バックアップ済み」と報告され、`pre-migrate-backup` も通った**。
 * 実際にこの状態で本番 DB の動作確認を行い、テスト前のバックアップが上書きされた。
 *
 * **欠陥の入り方が重要である** —— あれは「小さな変更」として入ったのではなく、
 * プロジェクト生成時に**ハーネスの足場として配られた**（`1a19fa0`・36ファイル）。
 * **利用者が何も変更していない所に最初から入っていたので、工程やレビューのゲートでは捕まらない。**
 * だから配布物そのものを機械で見る。
 *
 * 数えた範囲: `templates/` 配下の `*.ts` / `*.mjs` / `*.js`（`node_modules` を除く）。
 */

/** `templates/` 配下のスクリプトを再帰で集める。 */
function collectScripts(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectScripts(full));
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SCRIPTS = collectScripts(TEMPLATES);

test("配布物のスクリプトが1本以上見つかる（走査が空振りしていないこと）", () => {
  assert.ok(
    SCRIPTS.length > 0,
    `templates/ 配下にスクリプトが見つからない。走査の起点が誤っている可能性がある: ${TEMPLATES}`
  );
});

test("H93: 配布物が TRUNCATE を出さない", () => {
  const offenders = [];
  for (const file of SCRIPTS) {
    const src = fs.readFileSync(file, "utf8");
    // SQL を組み立てている箇所だけを問題にする。
    // 説明文（コメント）で「TRUNCATE を出さない」と書くのは許す必要があるため、
    // **`TRUNCATE` がテンプレートリテラルか文字列リテラルに現れる行**だけを見る。
    src.split("\n").forEach((line, i) => {
      if (!/TRUNCATE/i.test(line)) return;
      const inLiteral = /[`'"][^`'"]*TRUNCATE/i.test(line);
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      if (inLiteral && !isComment) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "配布物が TRUNCATE を含む SQL を出力している。復元で外部キー先の表まで空になる:\n" +
      offenders.join("\n")
  );
});

test("H93: export-to-sql.ts が UPSERT で復元する（行を消さない）", () => {
  const file = path.join(TEMPLATES, "nextjs", "tools", "export-to-sql.ts");
  assert.ok(fs.existsSync(file), `見つからない: ${path.relative(ROOT, file)}`);
  const src = fs.readFileSync(file, "utf8");

  assert.match(
    src,
    /ON CONFLICT \(\$\{conflictTarget\}\) DO UPDATE SET/,
    "`ON CONFLICT ... DO UPDATE SET` を出していない。復元が行を消す形へ戻っている可能性がある"
  );
  assert.match(
    src,
    /ON CONFLICT \(\$\{conflictTarget\}\) DO NOTHING/,
    "主キーだけのテーブル向けの `DO NOTHING` 分岐が無い。`DO UPDATE SET` を空で出すと構文エラーになる"
  );
  assert.match(
    src,
    /PRIMARY_KEYS\[modelName\] \?\? "id"/,
    "`PRIMARY_KEYS` の既定が `id` でない。主キーが `id` のモデルで記入が必須になる"
  );
});

test("H93: zip の失敗を握り潰さない（終了コードを立てる）", () => {
  const file = path.join(TEMPLATES, "nextjs", "tools", "export-to-sql.ts");
  const src = fs.readFileSync(file, "utf8");

  // `createZipBackup` の catch 節を切り出して見る。
  const idx = src.indexOf("async function createZipBackup");
  assert.ok(idx >= 0, "`createZipBackup` が見つからない");
  const body = src.slice(idx, src.indexOf("\n}", idx));
  const catchIdx = body.lastIndexOf("} catch");
  assert.ok(catchIdx >= 0, "`createZipBackup` に catch 節が無い");
  const catchBlock = body.slice(catchIdx);

  assert.ok(
    /throw |process\.exit\(/.test(catchBlock),
    "zip の失敗を catch して**握り潰している**。1世代も残っていないのに" +
      "「バックアップ済み」と報告され、`pre-migrate-backup` も通ってしまう:\n" +
      catchBlock
  );
  assert.ok(
    !/^\s*console\.warn\(.*\)\s*;?\s*$/m.test(catchBlock.replace(/\n\s*\/\/.*/g, "")),
    "catch 節が `console.warn` だけで終わっている（終了コードが立たない）"
  );
});
