import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * harness-nextjs の browser-test の契約（H109）
 *
 * report.md の書式は、browser-tester が書き、保存されなかったときはスキルが書くので 2 箇所にある。
 * 片方だけ直すと、同じレポートの節が呼ばれ方で変わる。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, "plugins/harness-nextjs", rel), "utf-8");
const skill = read("skills/browser-test/SKILL.md");
const tester = read("agents/browser-tester.md");
const checklist = read("skills/browser-test/checklist.md");
const metrics = read("skills/browser-test/ux-metrics.js");

const uxBlock = (text) => text.slice(text.indexOf("## 壊れていないか"), text.indexOf("## スクリーンショット一覧"));
const verdict = (text) => text.slice(text.indexOf("- **機能テスト**: ✅"), text.indexOf("- **判定**: ✅"));

test("report.md の UX の節と総合判定は、スキルと browser-tester で同じ", () => {
  assert.match(uxBlock(skill), /## 画面の使い方/);
  assert.equal(uxBlock(skill), uxBlock(tester));
  assert.equal(verdict(skill), verdict(tester));
  assert.doesNotMatch(skill + tester, /⭐/, "★の評価が残っている");
});

test("対象画面をたどるのに Grep を使えて、測定スクリプトを browser-tester へ渡す", () => {
  assert.match(skill.match(/^allowed-tools: .*$/m)[0], /\bGrep\b/);
  assert.equal(skill.match(/測定スクリプト: \{\$\{CLAUDE_SKILL_DIR\}\/ux-metrics\.js/g)?.length, 2);
});

test("ux-metrics.js は browser_evaluate に渡せる 1 つの関数式で、外のものに頼らない", () => {
  assert.match(metrics, /^\(options = \{\}\) => \{/);
  assert.doesNotMatch(metrics, /^\s*(import|export)\s/m);
  const fn = new Function(`return (${metrics.trim()})`)();
  assert.equal(typeof fn, "function");
});

test("チェックリストの数値の表は、スクリプトが返す項目を全部含む", () => {
  const returned = [...metrics.slice(metrics.lastIndexOf("return {")).matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]);
  assert.ok(returned.length >= 8, `返す項目が拾えていない: ${returned}`);
  for (const key of returned.filter((k) => k !== "viewport")) assert.ok(checklist.includes(`\`${key}\``), `checklist に ${key} が無い`);
});
