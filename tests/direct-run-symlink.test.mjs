import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// H106: 「直接起動されたか」の判定が `import.meta.url`（実体のパス）と `process.argv[1]`（渡したパス）の
// 文字列比較だったため、**シンボリックリンクを経由したパスで起こすと、何もせず終了コード 0 で終わっていた**。
// macOS の一時フォルダ（`/var` → `/private/var`）がこれに当たり、`/harness-core:create-project` が
// 常に空振りしていた。**自前のリンクを作るので、どの OS でも同じ状況になる。**
//
// 期待は「実体のパスで起こしたときと同じ出力・同じ終了コードになる」こと。
const TOOLS = [
  "tools/create-project.mjs",
  "tools/rules-reality-check.mjs",
  "plugins/harness-core/skills/harness-update/scripts/harness-diff.mjs",
];

function makeLink() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "direct-run-")));
  const link = path.join(base, "h");
  try {
    // Windows ではジャンクションなら管理者権限なしで作れる
    fs.symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return null;
  }
  return link;
}

const run = (file) => spawnSync(process.execPath, [file, "--help"], { encoding: "utf-8" });

for (const rel of TOOLS) {
  test(`H106: リンク経由で起こしても ${path.basename(rel)} は実体と同じように動く`, (t) => {
    const link = makeLink();
    if (!link) return t.skip("この環境ではリンクを作れない");
    const direct = run(path.join(ROOT, rel));
    const viaLink = run(path.join(link, rel));
    // 前提: 実体で起こしたときは何か出る（出ないなら、このテストは何も守っていない）
    assert.notEqual((direct.stdout + direct.stderr).trim(), "");
    assert.equal(viaLink.status, direct.status);
    assert.equal(viaLink.stdout + viaLink.stderr, direct.stdout + direct.stderr);
  });
}
