import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// プラグインは互いのファイルを参照できない（`${CLAUDE_PLUGIN_ROOT}` はプラグインごとに異なる）。
// そのため**意図的な複製**がある。複製そのものは避けられないが、
// **片方だけ直る**ことは避けられる ＝ 機械で検出する。
//
// 同じ狙いの検査が tests/is-git-commit.test.mjs（core と unity の判定式）にもある。
// あちらは「振る舞いの一致」、ここは「ファイル内容の一致」を見る。

const GROUPS = [
  {
    label: "product-advisor（体験系スロット）",
    files: [
      "plugins/harness-nextjs/agents/product-advisor.md",
      "plugins/harness-wpf/agents/product-advisor.md",
      "plugins/harness-android/agents/product-advisor.md",
    ],
  },
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8").replace(/\r\n/g, "\n");

for (const { label, files } of GROUPS) {
  test(`複製が乖離していない: ${label}`, () => {
    const [first, ...rest] = files;
    const expected = read(first);
    for (const f of rest) {
      assert.equal(read(f), expected, `${f} が ${first} と異なる（片方だけ直っている）`);
    }
  });
}
