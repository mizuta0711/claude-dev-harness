#!/usr/bin/env node
/**
 * このプロジェクトに導入されているハーネスプラグインと、その版・スコープを出力する。
 *
 * `claude plugin update` は **導入時と同じスコープ**を指定しないと
 * 「not installed at scope user」で失敗する（実測）。
 * このスクリプトが「何を・どのスコープで」更新すべきかを確定させる。
 *
 * 使い方:
 *   node <このファイル>            # 人間向けの表
 *   node <このファイル> --json     # JSON（スキルが読む用）
 *
 * 出力（--json）:
 *   {
 *     "projectPath": "...",
 *     "targets": [{ "plugin": "harness-core@dev-harness", "scope": "project", "version": "0.6.1" }],
 *     "userScopeDuplicates": [...],   // user と project の両方に登録がある（要整理）
 *     "warnings": [...]
 *   }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INSTALLED = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const asJson = process.argv.includes("--json");

/** Windows のドライブレター・区切り文字・末尾スラッシュを吸収して比較可能な形にする */
function normalize(p) {
  if (!p) return "";
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

const result = {
  projectPath: process.cwd(),
  targets: [],
  userScopeDuplicates: [],
  warnings: [],
};

if (!fs.existsSync(INSTALLED)) {
  result.warnings.push(`導入情報が見つかりません: ${INSTALLED}`);
  emit();
}

let data;
try {
  data = JSON.parse(fs.readFileSync(INSTALLED, "utf-8"));
} catch (e) {
  result.warnings.push(`導入情報を読めません（${e.message}）: ${INSTALLED}`);
  emit();
}

const here = normalize(result.projectPath);
const byName = new Map(); // plugin 名 -> スコープの集合

for (const [name, entries] of Object.entries(data.plugins ?? {})) {
  for (const e of entries ?? []) {
    const scope = e.scope ?? "user";
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(scope);

    if (scope === "user") continue; // user スコープは下でまとめて扱う
    if (normalize(e.projectPath) !== here) continue;

    result.targets.push({ plugin: name, scope, version: e.version ?? "(不明)" });
  }
}

// project スコープで見つかったものが user にも居るなら、更新のたびに二重に当てることになる
for (const t of result.targets) {
  if (byName.get(t.plugin)?.has("user")) {
    result.userScopeDuplicates.push(t.plugin);
  }
}

// project スコープに1つも無いが user には居る場合（= このプロジェクトは user 経由で使っている）
if (result.targets.length === 0) {
  for (const [name, scopes] of byName) {
    if (scopes.has("user")) {
      const e = (data.plugins[name] ?? []).find((x) => (x.scope ?? "user") === "user");
      result.targets.push({ plugin: name, scope: "user", version: e?.version ?? "(不明)" });
    }
  }
  if (result.targets.length > 0) {
    result.warnings.push(
      "project スコープの登録が見つかりませんでした。user スコープを対象にします。" +
        "（推奨は project スコープ。導入し直す場合は --scope project を付けること）"
    );
  }
}

if (result.targets.length === 0) {
  result.warnings.push("このプロジェクトに導入されたハーネスプラグインが見つかりません。");
}

emit();

function emit() {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(0);
  }
  console.log(`プロジェクト: ${result.projectPath}`);
  if (result.targets.length === 0) {
    console.log("  （対象なし）");
  } else {
    console.log("  プラグイン                      スコープ   版");
    for (const t of result.targets) {
      console.log(`  ${t.plugin.padEnd(32)}${t.scope.padEnd(11)}${t.version}`);
    }
  }
  for (const d of result.userScopeDuplicates) {
    console.log(`  ⚠ ${d} は user スコープにも登録があります（更新のたびに両方へ当てる必要が出る）`);
  }
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  process.exit(0);
}
