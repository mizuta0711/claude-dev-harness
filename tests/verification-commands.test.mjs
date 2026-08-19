import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `verification.skill` が使うコマンドが、同じテンプレートの permissions に載っているか
 *
 * ## なぜ要るのか（H31）
 *
 * テンプレートが `verification.skill` を宣言していても、**そのスキルが実際に叩くコマンドが
 * allow / ask のどこにも無い**ことがある。実測（android）では、`capture-screenshots` が使う
 * 11コマンドのうち **allow にあったのは3つだけ**だった。
 *
 * 症状は「動作確認のたびに確認プロンプトが出る」で、**壊れてはいないので気づきにくい**。
 * しかも適用先のプロジェクトが `settings.local.json` に広い allow を持っていると、
 * **それが覆い隠す**。実測では、そのローカル設定を正しく外した瞬間に露出した。
 *
 * 移行指示書 §10-2 の機械チェックは「`verification` の**前提 MCP** が `.mcp.json` に居るか」は
 * 見るが、**必要コマンドが allow にあるか**は見ていなかった（H11 で MCP 側だけを足したため）。
 *
 * ## 判定
 *
 * SKILL.md のコードブロックから**コマンド行**を拾い、テンプレートの allow / ask の
 * どれかが覆っているかを見る。`Bash(x:*)` は前方一致、`Bash(x)` は完全一致。
 *
 * **鳴りすぎないこと**が要件（R3）。拾うのは「テンプレートが permissions で言及している
 * 実行ファイル」で始まる行だけにする。**そのテンプレートが関心を持っていないコマンドは見ない。**
 */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const listDirs = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p)
    ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
};

/** `Bash(adb pull:*)` → `{tool:"Bash", pattern:"adb pull", prefix:true}` */
function parseRule(rule) {
  const m = /^(Bash|PowerShell)\((.*)\)$/.exec(rule);
  if (!m) return null;
  const body = m[2];
  return body.endsWith(":*")
    ? { tool: m[1], pattern: body.slice(0, -2), prefix: true }
    : { tool: m[1], pattern: body, prefix: false };
}

/** SKILL.md のコードブロックから、`exes` のいずれかで始まる行を拾う */
function commandLines(md, exes) {
  const out = new Set();
  let inFence = false;
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    // 行内コメント（`# 起動`）とリダイレクトから先は判定に使わない
    const line = raw.trim().split(/\s+#\s/)[0].split(/[>|]/)[0].trim();
    if (!line) continue;
    if (exes.some((e) => line === e || line.startsWith(`${e} `))) out.add(line);
  }
  return [...out];
}

const ENVS = listDirs("templates").filter((e) =>
  exists(`templates/${e}/.claude/harness.config.json`)
);

test("verification.skill が使うコマンドは、そのテンプレートの allow / ask に載っている", () => {
  const problems = [];
  let checked = 0;

  for (const env of ENVS) {
    const cfg = JSON.parse(read(`templates/${env}/.claude/harness.config.json`));
    const skill = cfg?.verification?.skill;
    if (!skill) continue;

    // スキルの実体を全プラグインから探す
    const skillFile = listDirs("plugins")
      .map((p) => `plugins/${p}/skills/${skill}/SKILL.md`)
      .find(exists);
    assert.ok(
      skillFile,
      `templates/${env} が verification.skill: ${skill} を宣言しているが、実体が見つからない`
    );

    const settings = JSON.parse(read(`templates/${env}/.claude/settings.json`));
    const perms = settings?.permissions ?? {};
    const rules = [...(perms.allow ?? []), ...(perms.ask ?? [])].map(parseRule).filter(Boolean);

    // このテンプレートが permissions で言及している実行ファイルだけを対象にする
    const exes = [...new Set(rules.map((r) => r.pattern.split(/\s+/)[0]))].filter((e) =>
      /^[a-z][a-z0-9.-]*$/.test(e)
    );
    if (!exes.length) continue;

    for (const line of commandLines(read(skillFile), exes)) {
      checked++;
      const covered = rules.some((r) =>
        r.prefix ? line === r.pattern || line.startsWith(`${r.pattern} `) : line === r.pattern
      );
      if (!covered) problems.push(`${env} / ${skill}: ${line}`);
    }
  }

  assert.ok(checked > 0, "1件も検査していない。抽出の条件が壊れている可能性がある");
  assert.deepEqual(
    problems,
    [],
    "verification.skill が使うのに allow / ask に無いコマンド:\n  " +
      problems.join("\n  ") +
      "\n\n毎回確認プロンプトが出る。壊れてはいないので気づきにくい（H31）"
  );
});
